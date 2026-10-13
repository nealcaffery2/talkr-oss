/**
 * Outbound webhooks (docs/public-api.md §7): decoupled fan-out + delivery.
 *
 * Emission NEVER touches apply-events.ts. A `webhook-fanout` job tails the two
 * append-only sources (call_events for canonical telephony facts, audit_log
 * for dispositions) on a cursor with an overlap window; the unique
 * (subscription_id, event_id) constraint on webhook_deliveries makes fan-out
 * exactly-once per (subscription, event) no matter how often a range is
 * re-scanned. Delivery rides the existing job queue: 2xx = delivered,
 * anything else retries with the queue's backoff until dead-letter, and
 * sustained dead deliveries auto-disable the subscription (audited).
 */

import { createHmac } from 'node:crypto';
import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import { enqueueJob, schema, type DbLike } from '@talkr/db';
import { serializePublicCall } from '../public-api/service.js';
import { writeAudit } from '../services/audit.js';
import type { HandlerDeps, JobHandler } from './handlers.js';

/** Public webhook event types — strictly the real canonical vocabulary plus
 * `disposition.created` sourced from the audit trail (docs/public-api.md §7). */
export const PUBLIC_WEBHOOK_EVENT_TYPES = [
  'call.completed',
  'call.no_answer',
  'call.busy',
  'call.failed',
  'call.canceled',
  'recording.completed',
  'disposition.created',
  // Phase 7: emitted by the workflow engine's emit_webhook action (deliveries
  // are inserted directly by workflow-engine.ts; this sweep does not scan it).
  'workflow.executed',
] as const;

export type PublicWebhookEventType = (typeof PUBLIC_WEBHOOK_EVENT_TYPES)[number];

const CALL_EVENT_TYPES = [
  'call.completed',
  'call.no_answer',
  'call.busy',
  'call.failed',
  'call.canceled',
  'recording.completed',
];

/** Re-scan window: rows committed late by long transactions are never missed;
 * the delivery unique constraint makes the re-scan free of duplicates. */
const OVERLAP_MS = 5 * 60_000;
/** Per-source batch per sweep; sustained higher rates take extra sweeps. */
const BATCH_SIZE = 500;

export interface WebhookEnvelope {
  id: string;
  type: PublicWebhookEventType;
  occurredAt: string;
  data: Record<string, unknown>;
}

/** `t=<unix>,v1=<hex HMAC-SHA256 of "t.body">` (docs/public-api.md §7). */
export function signWebhookBody(secret: string, timestampSeconds: number, body: string): string {
  const mac = createHmac('sha256', secret).update(`${timestampSeconds}.${body}`).digest('hex');
  return `t=${timestampSeconds},v1=${mac}`;
}

// ---------------------------------------------------------------------------
// webhook-fanout: tail the append-only sources → webhook_deliveries + jobs
// ---------------------------------------------------------------------------

async function readCursor(db: DbLike, source: string, now: Date): Promise<Date> {
  const row = (
    await db
      .select()
      .from(schema.webhookFanoutCursors)
      .where(eq(schema.webhookFanoutCursors.source, source))
      .limit(1)
  )[0];
  if (row) return row.cursorAt;
  // First activation: look back one overlap window, no history dump.
  const initial = new Date(now.getTime() - OVERLAP_MS);
  await db
    .insert(schema.webhookFanoutCursors)
    .values({ source, cursorAt: initial })
    .onConflictDoNothing();
  return initial;
}

async function writeCursor(db: DbLike, source: string, cursorAt: Date): Promise<void> {
  await db
    .update(schema.webhookFanoutCursors)
    .set({ cursorAt, updatedAt: new Date() })
    .where(
      and(
        eq(schema.webhookFanoutCursors.source, source),
        sql`${schema.webhookFanoutCursors.cursorAt} < ${cursorAt}`,
      ),
    );
}

type Subscription = typeof schema.webhookSubscriptions.$inferSelect;

/** Active subscriptions per org, matched in memory (few per org). */
async function loadSubscriptions(db: DbLike, orgIds: string[]): Promise<Map<string, Subscription[]>> {
  const map = new Map<string, Subscription[]>();
  if (orgIds.length === 0) return map;
  const rows = await db
    .select()
    .from(schema.webhookSubscriptions)
    .where(
      and(
        eq(schema.webhookSubscriptions.active, true),
        inArray(schema.webhookSubscriptions.orgId, orgIds),
      ),
    );
  for (const row of rows) {
    const list = map.get(row.orgId) ?? [];
    list.push(row);
    map.set(row.orgId, list);
  }
  return map;
}

function subscriptionMatches(sub: Subscription, type: string, eventCreatedAt: Date): boolean {
  const types = Array.isArray(sub.eventTypes) ? (sub.eventTypes as string[]) : [];
  if (!types.includes(type)) return false;
  // New subscriptions do not receive history.
  return sub.createdAt.getTime() <= eventCreatedAt.getTime();
}

interface FanoutCandidate {
  orgId: string;
  eventId: string;
  type: PublicWebhookEventType;
  occurredAt: Date;
  createdAt: Date;
  data: Record<string, unknown>;
}

/** Insert delivery + enqueue its job; no-op when the pair already exists. */
async function fanOutCandidate(
  tx: DbLike,
  candidate: FanoutCandidate,
  subs: Subscription[],
): Promise<void> {
  for (const sub of subs) {
    if (!subscriptionMatches(sub, candidate.type, candidate.createdAt)) continue;
    const envelope: WebhookEnvelope = {
      id: candidate.eventId,
      type: candidate.type,
      occurredAt: candidate.occurredAt.toISOString(),
      data: candidate.data,
    };
    const inserted = await tx
      .insert(schema.webhookDeliveries)
      .values({
        orgId: candidate.orgId,
        subscriptionId: sub.id,
        eventId: candidate.eventId,
        eventType: candidate.type,
        payload: envelope,
      })
      .onConflictDoNothing()
      .returning({ id: schema.webhookDeliveries.id });
    const deliveryId = inserted[0]?.id;
    if (!deliveryId) continue; // already fanned out — exactly-once guard
    await enqueueJob(tx, {
      jobType: 'webhook-deliver',
      payload: { deliveryId },
      dedupeKey: `webhook-deliver:${deliveryId}`,
    });
  }
}

async function collectCallEventCandidates(
  db: DbLike,
  scanFrom: Date,
): Promise<{ candidates: FanoutCandidate[]; maxCreatedAt: Date | null }> {
  const rows = await db
    .select()
    .from(schema.callEvents)
    .where(
      and(
        gt(schema.callEvents.createdAt, scanFrom),
        inArray(schema.callEvents.eventType, CALL_EVENT_TYPES),
      ),
    )
    .orderBy(asc(schema.callEvents.createdAt))
    .limit(BATCH_SIZE);
  if (rows.length === 0) return { candidates: [], maxCreatedAt: null };

  const callIds = [...new Set(rows.map((r) => r.callId))];
  const calls = await db.select().from(schema.calls).where(inArray(schema.calls.id, callIds));
  const callById = new Map(calls.map((c) => [c.id, c]));

  const recordingCallIds = rows
    .filter((r) => r.eventType === 'recording.completed')
    .map((r) => r.callId);
  const recordings = recordingCallIds.length
    ? await db
        .select()
        .from(schema.recordings)
        .where(inArray(schema.recordings.callId, [...new Set(recordingCallIds)]))
    : [];
  const recordingByCall = new Map(recordings.map((r) => [r.callId, r]));

  const candidates: FanoutCandidate[] = [];
  for (const row of rows) {
    const call = callById.get(row.callId);
    if (!call) continue;
    const type = row.eventType as PublicWebhookEventType;
    const data: Record<string, unknown> =
      type === 'recording.completed'
        ? {
            call_id: call.id,
            recording: (() => {
              const rec = recordingByCall.get(call.id);
              return rec
                ? {
                    id: rec.id,
                    status: rec.status,
                    duration_seconds: rec.durationSeconds,
                    channels: rec.channels,
                  }
                : null;
            })(),
          }
        : (serializePublicCall(call) as unknown as Record<string, unknown>);
    candidates.push({
      orgId: row.orgId,
      eventId: row.id,
      type,
      occurredAt: row.occurredAt,
      createdAt: row.createdAt,
      data,
    });
  }
  return { candidates, maxCreatedAt: rows[rows.length - 1]!.createdAt };
}

async function collectDispositionCandidates(
  db: DbLike,
  scanFrom: Date,
): Promise<{ candidates: FanoutCandidate[]; maxCreatedAt: Date | null }> {
  const rows = await db
    .select()
    .from(schema.auditLog)
    .where(
      and(gt(schema.auditLog.createdAt, scanFrom), eq(schema.auditLog.action, 'call.disposition')),
    )
    .orderBy(asc(schema.auditLog.createdAt))
    .limit(BATCH_SIZE);
  if (rows.length === 0) return { candidates: [], maxCreatedAt: null };

  const callIds = [...new Set(rows.map((r) => r.objectId).filter((v): v is string => !!v))];
  const calls = callIds.length
    ? await db.select().from(schema.calls).where(inArray(schema.calls.id, callIds))
    : [];
  const callById = new Map(calls.map((c) => [c.id, c]));

  const candidates: FanoutCandidate[] = [];
  for (const row of rows) {
    if (!row.orgId || !row.objectId) continue;
    const call = callById.get(row.objectId);
    const meta = (row.metadata ?? {}) as Record<string, unknown>;
    candidates.push({
      orgId: row.orgId,
      eventId: `audit:${row.id}`,
      type: 'disposition.created',
      occurredAt: row.createdAt,
      createdAt: row.createdAt,
      data: {
        call_id: row.objectId,
        disposition: (meta.disposition as string) ?? null,
        note: call?.dispositionNote ?? null,
        follow_up_at: call?.followUpAt ?? null,
        user_id: row.actorId,
      },
    });
  }
  return { candidates, maxCreatedAt: rows[rows.length - 1]!.createdAt };
}

export const webhookFanout: JobHandler = async (deps) => {
  const { dbh, config } = deps;
  const now = new Date();

  await dbh.db.transaction(async (tx) => {
    const sources = [
      { name: 'call_events', collect: collectCallEventCandidates },
      { name: 'audit_dispositions', collect: collectDispositionCandidates },
    ] as const;

    for (const source of sources) {
      const cursor = await readCursor(tx, source.name, now);
      const scanFrom = new Date(cursor.getTime() - OVERLAP_MS);
      const { candidates, maxCreatedAt } = await source.collect(tx, scanFrom);
      if (candidates.length > 0) {
        const orgIds = [...new Set(candidates.map((c) => c.orgId))];
        const subsByOrg = await loadSubscriptions(tx, orgIds);
        for (const candidate of candidates) {
          const subs = subsByOrg.get(candidate.orgId);
          if (subs?.length) await fanOutCandidate(tx, candidate, subs);
        }
      }
      if (maxCreatedAt) await writeCursor(tx, source.name, maxCreatedAt);
    }
  });

  // Self-perpetuating sweep (worker-main seeds the first one). Time-bucketed
  // dedupe key: at most one scheduled sweep per interval bucket.
  const intervalMs = config.WEBHOOK_FANOUT_INTERVAL_MS ?? 5_000;
  const nextRun = Date.now() + intervalMs;
  await enqueueJob(dbh.db, {
    jobType: 'webhook-fanout',
    dedupeKey: `webhook-fanout:${Math.floor(nextRun / intervalMs)}`,
    runAt: new Date(nextRun),
  });
};

// ---------------------------------------------------------------------------
// webhook-deliver: signed POST with queue-native retry/dead-letter
// ---------------------------------------------------------------------------

export const webhookDeliver: JobHandler = async (deps, job) => {
  const { dbh, config, logger } = deps;
  const { deliveryId } = job.payload as { deliveryId: string };

  const delivery = (
    await dbh.db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.id, deliveryId))
      .limit(1)
  )[0];
  if (!delivery) throw new Error(`webhook delivery ${deliveryId} not found`);
  if (delivery.state === 'delivered') return; // idempotent re-run

  const subscription = (
    await dbh.db
      .select()
      .from(schema.webhookSubscriptions)
      .where(eq(schema.webhookSubscriptions.id, delivery.subscriptionId))
      .limit(1)
  )[0];
  if (!subscription || !subscription.active) {
    // Disabled/deleted mid-flight: skip terminally, never dead-letter noise.
    await dbh.db
      .update(schema.webhookDeliveries)
      .set({
        state: 'failed',
        lastError: subscription ? 'subscription_disabled' : 'subscription_deleted',
        updatedAt: new Date(),
      })
      .where(eq(schema.webhookDeliveries.id, delivery.id));
    return;
  }

  const body = JSON.stringify(delivery.payload);
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = signWebhookBody(subscription.signingSecret, timestamp, body);

  let statusCode: number | null = null;
  let failure: string | null = null;
  try {
    const res = await fetch(subscription.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-talkr-event': delivery.eventType,
        'x-talkr-delivery': delivery.id,
        'x-talkr-signature': signature,
      },
      body,
      signal: AbortSignal.timeout(config.WEBHOOK_DELIVERY_TIMEOUT_MS ?? 10_000),
    });
    statusCode = res.status;
    // Drain the body so the socket is reusable; content is irrelevant.
    await res.arrayBuffer().catch(() => undefined);
    if (!res.ok) failure = `http ${res.status}`;
  } catch (err) {
    failure = (err as Error).message || 'request failed';
  }

  if (!failure) {
    await dbh.db
      .update(schema.webhookDeliveries)
      .set({
        state: 'delivered',
        deliveredAt: new Date(),
        attemptCount: job.attempts,
        lastStatusCode: statusCode,
        lastError: null,
        updatedAt: new Date(),
      })
      .where(eq(schema.webhookDeliveries.id, delivery.id));
    // A success resets the consecutive-failure streak.
    await dbh.db
      .update(schema.webhookSubscriptions)
      .set({ failureCount: 0 })
      .where(eq(schema.webhookSubscriptions.id, subscription.id));
    return;
  }

  // job.attempts was incremented at claim; the queue dead-letters when
  // attempts >= max_attempts, so this attempt being final is knowable here.
  const isFinalAttempt = job.attempts >= job.maxAttempts;
  await dbh.db
    .update(schema.webhookDeliveries)
    .set({
      state: isFinalAttempt ? 'dead' : 'failed',
      attemptCount: job.attempts,
      lastStatusCode: statusCode,
      lastError: failure,
      updatedAt: new Date(),
    })
    .where(eq(schema.webhookDeliveries.id, delivery.id));

  if (isFinalAttempt) {
    const threshold = config.WEBHOOK_AUTO_DISABLE_AFTER ?? 3;
    const updated = (
      await dbh.db
        .update(schema.webhookSubscriptions)
        .set({ failureCount: sql`${schema.webhookSubscriptions.failureCount} + 1` })
        .where(eq(schema.webhookSubscriptions.id, subscription.id))
        .returning()
    )[0]!;
    if (updated.active && updated.failureCount >= threshold) {
      await dbh.db
        .update(schema.webhookSubscriptions)
        .set({ active: false, disabledAt: new Date() })
        .where(eq(schema.webhookSubscriptions.id, subscription.id));
      await writeAudit(dbh.db, {
        orgId: subscription.orgId,
        actorType: 'system',
        action: 'webhook_subscription.auto_disabled',
        objectType: 'webhook_subscription',
        objectId: subscription.id,
        metadata: { failure_count: updated.failureCount, threshold, url: subscription.url },
      });
      logger.warn(
        { subscriptionId: subscription.id, failureCount: updated.failureCount },
        'webhook subscription auto-disabled after sustained failures',
      );
    }
  }

  throw new Error(`webhook delivery failed: ${failure}`);
};

/** Seed the self-perpetuating sweep (idempotent per interval bucket). */
export async function seedWebhookFanout(db: DbLike, intervalMs: number): Promise<void> {
  await enqueueJob(db, {
    jobType: 'webhook-fanout',
    dedupeKey: `webhook-fanout:${Math.floor(Date.now() / intervalMs)}`,
  });
}
