/**
 * Dialer worker jobs (docs/dialers.md §4–§5):
 *
 *   campaign-advance     enqueued (dedupe-keyed, exactly once per call) from
 *                        the disposition path — applies the disposition
 *                        outcome to the campaign_lead, then auto-advances
 *                        progressive sessions.
 *   dialer-watch         the Phase 10 cursor-tailing pattern: tails
 *                        call_events for session calls and applies interim
 *                        outcomes + counter recomputes WITHOUT touching
 *                        apply-events.ts. Self-perpetuating sweep.
 *   cancel-sibling-dials first-answer-wins: cancels the losing parallel legs
 *                        via provider.cancelCall (exactly one cancel request
 *                        per leg, gated by a journal insert).
 */

import { and, asc, eq, gt, inArray, sql } from 'drizzle-orm';
import {
  campaignOutcomeForDisposition,
  computeRetrySchedule,
  resolveCampaignSettings,
  type CampaignSettings,
} from '@talkr/core';
import { enqueueJob, schema, type DbLike } from '@talkr/db';
import type { JobHandler } from './handlers.js';
import {
  DialSessionError,
  loadSessionById,
  publishSessionEvent,
  recomputeSessionCounters,
  sessionNext,
  systemCtxForSession,
} from '../services/dial-sessions.js';

const CURSOR_SOURCE = 'dialer_call_events';
const OVERLAP_MS = 5 * 60_000;
const BATCH_SIZE = 500;
const TERMINAL_EVENT_TYPES = [
  'call.completed',
  'call.no_answer',
  'call.busy',
  'call.failed',
  'call.canceled',
];
const WATCHED_EVENT_TYPES = [...TERMINAL_EVENT_TYPES, 'call.answered'];

// ---------------------------------------------------------------------------
// campaign-advance
// ---------------------------------------------------------------------------

export const campaignAdvance: JobHandler = async (deps, job) => {
  const { dbh, logger } = deps;
  const { callId } = job.payload as { callId: string };
  const call = (
    await dbh.db.select().from(schema.calls).where(eq(schema.calls.id, callId)).limit(1)
  )[0];
  if (!call) throw new Error(`call ${callId} not found`);
  const raw = call.raw as Record<string, unknown>;
  const sessionId = raw.dialSessionId as string | undefined;
  const campaignLeadId = raw.campaignLeadId as string | undefined;
  if (!sessionId || !campaignLeadId) return; // not a session call — nothing to do

  const session = await loadSessionById(dbh.db, sessionId);
  if (!session) return;
  const campaign = (
    await dbh.db
      .select()
      .from(schema.campaigns)
      .where(eq(schema.campaigns.id, session.campaignId))
      .limit(1)
  )[0];
  if (!campaign) return;
  const settings = resolveCampaignSettings(campaign.settings as CampaignSettings);

  // 1. Disposition outcome → campaign_lead (all modes). Never downgrades a
  //    suppressed/removed lead.
  if (call.dispositionId) {
    const disposition = (
      await dbh.db
        .select()
        .from(schema.callDispositions)
        .where(eq(schema.callDispositions.id, call.dispositionId))
        .limit(1)
    )[0];
    const cl = (
      await dbh.db
        .select()
        .from(schema.campaignLeads)
        .where(eq(schema.campaignLeads.id, campaignLeadId))
        .limit(1)
    )[0];
    if (disposition && cl && cl.status !== 'suppressed' && cl.status !== 'removed') {
      const outcome = campaignOutcomeForDisposition({
        dispositionSlug: disposition.slug,
        addsSuppression: disposition.addsSuppression,
        treatAsConversation: disposition.treatAsConversation,
        attempts: cl.attempts,
        settings,
        now: new Date(),
      });
      await dbh.db
        .update(schema.campaignLeads)
        .set({
          status: outcome.status,
          nextAttemptAt: outcome.nextAttemptAt,
          lastOutcome: outcome.lastOutcome,
        })
        .where(eq(schema.campaignLeads.id, cl.id));
    }
  }

  // 2. Progressive auto-advance (docs/dialers.md §4): only progressive, only
  //    while session + campaign are still active. A retry of this job after
  //    the next call was already created no-ops on call_in_flight.
  if (session.mode !== 'progressive') return;
  if (session.state !== 'active' || campaign.status !== 'active') return;
  const ctx = await systemCtxForSession(dbh.db, session);
  if (!ctx) return;
  try {
    await sessionNext(deps, ctx, session.id, { systemInitiated: true });
  } catch (err) {
    if (err instanceof DialSessionError) {
      // in-flight call / paused mid-job / campaign paused: all fine no-ops.
      logger.info({ sessionId: session.id, code: err.code }, 'advance skipped');
      return;
    }
    throw err;
  }
};

// ---------------------------------------------------------------------------
// dialer-watch — cursor-tailing sweep over call_events
// ---------------------------------------------------------------------------

async function readCursor(db: DbLike, now: Date): Promise<Date> {
  const row = (
    await db
      .select()
      .from(schema.webhookFanoutCursors)
      .where(eq(schema.webhookFanoutCursors.source, CURSOR_SOURCE))
      .limit(1)
  )[0];
  if (row) return row.cursorAt;
  const initial = new Date(now.getTime() - OVERLAP_MS);
  await db
    .insert(schema.webhookFanoutCursors)
    .values({ source: CURSOR_SOURCE, cursorAt: initial })
    .onConflictDoNothing();
  return initial;
}

async function writeCursor(db: DbLike, cursorAt: Date): Promise<void> {
  await db
    .update(schema.webhookFanoutCursors)
    .set({ cursorAt, updatedAt: new Date() })
    .where(
      and(
        eq(schema.webhookFanoutCursors.source, CURSOR_SOURCE),
        sql`${schema.webhookFanoutCursors.cursorAt} < ${cursorAt}`,
      ),
    );
}

export const dialerWatch: JobHandler = async (deps) => {
  const { dbh, config } = deps;
  const now = new Date();

  const cursor = await readCursor(dbh.db, now);
  const scanFrom = new Date(cursor.getTime() - OVERLAP_MS);
  const events = await dbh.db
    .select()
    .from(schema.callEvents)
    .where(
      and(
        gt(schema.callEvents.createdAt, scanFrom),
        inArray(schema.callEvents.eventType, WATCHED_EVENT_TYPES),
      ),
    )
    .orderBy(asc(schema.callEvents.createdAt))
    .limit(BATCH_SIZE);

  if (events.length > 0) {
    const callIds = [...new Set(events.map((e) => e.callId))];
    const calls = await dbh.db.select().from(schema.calls).where(inArray(schema.calls.id, callIds));
    const sessionCalls = calls.filter(
      (c) => typeof (c.raw as Record<string, unknown>).dialSessionId === 'string',
    );
    const callById = new Map(sessionCalls.map((c) => [c.id, c]));
    const touchedSessions = new Set<string>();

    for (const event of events) {
      const call = callById.get(event.callId);
      if (!call) continue;
      const raw = call.raw as Record<string, unknown>;
      touchedSessions.add(raw.dialSessionId as string);
      if (!TERMINAL_EVENT_TYPES.includes(event.eventType)) continue;
      await applyInterimOutcome(dbh.db, call);
    }

    for (const sessionId of touchedSessions) {
      // Idempotent by construction: counters recompute, guarded updates.
      await recomputeSessionCounters(dbh.db, sessionId);
      const session = await loadSessionById(dbh.db, sessionId);
      if (session && session.state !== 'ended') {
        await publishSessionEvent(dbh, session, { event: 'progress' });
      }
    }
    await writeCursor(dbh.db, events[events.length - 1]!.createdAt);
  }

  // Self-perpetuating sweep, one per interval bucket (webhook-fanout pattern).
  const intervalMs = config.DIALER_WATCH_INTERVAL_MS ?? 1_000;
  const nextRun = Date.now() + intervalMs;
  await enqueueJob(dbh.db, {
    jobType: 'dialer-watch',
    dedupeKey: `dialer-watch:${Math.floor(nextRun / intervalMs)}`,
    runAt: new Date(nextRun),
  });
};

/**
 * Interim campaign_lead outcome from a terminal call (docs/dialers.md §4):
 * a rep who skips wrap-up never leaves a lead stuck in_progress. Guarded on
 * status so the AMD/abandon/disposition paths (which already moved the lead)
 * are never clobbered, and re-scans are no-ops.
 */
async function applyInterimOutcome(db: DbLike, call: typeof schema.calls.$inferSelect): Promise<void> {
  const raw = call.raw as Record<string, unknown>;
  const campaignLeadId = raw.campaignLeadId as string | undefined;
  const campaignId = raw.campaignId as string | undefined;
  if (!campaignLeadId || !campaignId) return;
  // Re-read the call: the event row may predate later stamps (amd/abandoned).
  const fresh = (
    await db.select().from(schema.calls).where(eq(schema.calls.id, call.id)).limit(1)
  )[0];
  if (!fresh) return;
  if (!isTerminalCallStatus(fresh.status)) return;
  const freshRaw = fresh.raw as Record<string, unknown>;
  const cl = (
    await db
      .select()
      .from(schema.campaignLeads)
      .where(eq(schema.campaignLeads.id, campaignLeadId))
      .limit(1)
  )[0];
  if (!cl || cl.status !== 'in_progress') return;
  const campaign = (
    await db.select().from(schema.campaigns).where(eq(schema.campaigns.id, campaignId)).limit(1)
  )[0];
  if (!campaign) return;
  const settings = resolveCampaignSettings(campaign.settings as CampaignSettings);

  const humanAnswered =
    fresh.answeredAt != null &&
    freshRaw.abandoned !== true &&
    (freshRaw.amdResult == null || freshRaw.amdResult === 'human');

  if (humanAnswered) {
    await db
      .update(schema.campaignLeads)
      .set({ status: 'contacted', nextAttemptAt: null, lastOutcome: fresh.status })
      .where(and(eq(schema.campaignLeads.id, cl.id), eq(schema.campaignLeads.status, 'in_progress')));
    return;
  }
  const retry = computeRetrySchedule(cl.attempts, settings, new Date());
  await db
    .update(schema.campaignLeads)
    .set({
      status: retry.status,
      nextAttemptAt: retry.nextAttemptAt,
      lastOutcome: retry.status === 'completed' ? 'max_attempts' : fresh.status,
    })
    .where(and(eq(schema.campaignLeads.id, cl.id), eq(schema.campaignLeads.status, 'in_progress')));
}

function isTerminalCallStatus(status: string): boolean {
  return ['completed', 'no_answer', 'busy', 'failed', 'canceled'].includes(status);
}

// ---------------------------------------------------------------------------
// cancel-sibling-dials — first answer wins, the rest are canceled
// ---------------------------------------------------------------------------

export const cancelSiblingDials: JobHandler = async (deps, job) => {
  const { dbh, provider, logger } = deps;
  const { dialBatchId, winnerCallId } = job.payload as {
    dialBatchId: string;
    winnerCallId: string;
  };
  const batch = await dbh.db.execute(sql`
    SELECT id FROM calls WHERE raw->>'dialBatchId' = ${dialBatchId}`);
  const ids = (batch.rows as Array<{ id: string }>).map((r) => r.id).filter((id) => id !== winnerCallId);
  if (ids.length === 0) return;
  const calls = await dbh.db.select().from(schema.calls).where(inArray(schema.calls.id, ids));

  for (const call of calls) {
    if (isTerminalCallStatus(call.status)) continue;
    if (!call.providerCallId) continue;
    // Journal insert is the exactly-once gate: only the run that wins the
    // insert issues the provider cancel; re-runs are no-ops.
    const gate = await dbh.db
      .insert(schema.callEvents)
      .values({
        orgId: call.orgId,
        callId: call.id,
        eventType: 'call.cancel_requested',
        occurredAt: new Date(),
        source: 'system',
        dedupeToken: `${call.providerCallId}:cancel-requested:x`,
        payload: { dialBatchId, winnerCallId },
      })
      .onConflictDoNothing()
      .returning({ id: schema.callEvents.id });
    if (gate.length === 0) continue;
    try {
      await provider.cancelCall(call.providerCallId);
      logger.info({ callId: call.id, providerCallId: call.providerCallId }, 'losing leg canceled');
    } catch (err) {
      logger.warn({ callId: call.id, err: (err as Error).message }, 'cancel failed');
      throw err; // retry — the provider's canceled webhook makes it terminal
    }
  }
};

/** Seed the self-perpetuating dialer-watch sweep (idempotent per bucket). */
export async function seedDialerWatch(db: DbLike, intervalMs: number): Promise<void> {
  await enqueueJob(db, {
    jobType: 'dialer-watch',
    dedupeKey: `dialer-watch:${Math.floor(Date.now() / intervalMs)}`,
  });
}
