/**
 * Canonical event application — the heart of the worker (docs/telephony-events.md).
 * Idempotent: the call_events dedupe token gates double-apply; the state
 * machine (packages/core) guarantees monotonic, out-of-order-safe transitions.
 */

import { and, eq, ne, sql } from 'drizzle-orm';
import {
  isCallEvent,
  isConferenceEvent,
  isRecordingEvent,
  isTerminal,
  reduceCallEvent,
  reduceParticipantEvent,
  type CanonicalCallEvent,
  type CanonicalConferenceEvent,
  type CanonicalEvent,
  type CanonicalRecordingEvent,
  type CallSnapshot,
  type EventSource,
  type ParticipantEventType,
  type ParticipantState,
} from '@talkr/core';
import {
  enqueueJob,
  publishBusEvent,
  schema,
  type DbHandle,
  type DbTx,
} from '@talkr/db';
import type { Logger } from '../logger.js';
import { userIdFromClientAddress } from './client-address.js';

export interface ApplyContext {
  webhookEventId?: string;
  source?: EventSource;
  logger: Logger;
  /** Delay before post-terminal provider reconciliation (0 in tests). */
  reconcileDelayMs?: number;
}

export interface ApplyResult {
  outcome: 'applied' | 'duplicate' | 'orphaned' | 'ignored';
  callId?: string;
}

export async function applyCanonicalEvent(
  dbh: DbHandle,
  event: CanonicalEvent,
  ctx: ApplyContext,
): Promise<ApplyResult> {
  if (isCallEvent(event)) return applyCallEvent(dbh, event, ctx);
  if (isRecordingEvent(event)) return applyRecordingEvent(dbh, event, ctx);
  if (isConferenceEvent(event)) return applyConferenceEvent(dbh, event, ctx);
  // Message events: stored raw at ingestion; processing lands in Phase 4.
  return { outcome: 'ignored' };
}

// ---------------------------------------------------------------------------
// Call events
// ---------------------------------------------------------------------------

interface ResolvedCall {
  call: typeof schema.calls.$inferSelect;
  leg: typeof schema.callLegs.$inferSelect | null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Webhook query params are attacker-influencable text; never let a malformed
 * id become a Postgres uuid-cast error that poisons the processing job. */
function asUuid(value: string | undefined): string | undefined {
  return value && UUID_RE.test(value) ? value : undefined;
}

async function resolveCall(
  tx: DbTx,
  event: CanonicalCallEvent,
): Promise<ResolvedCall | null> {
  // 1. Our own call id travels in statusCallback query params — strongest link.
  if (asUuid(event.data.talkrCallId)) {
    const call = (
      await tx.select().from(schema.calls).where(eq(schema.calls.id, event.data.talkrCallId!)).limit(1)
    )[0];
    if (call) {
      const leg = (
        await tx
          .select()
          .from(schema.callLegs)
          .where(eq(schema.callLegs.providerCallId, event.providerObjectId))
          .limit(1)
      )[0];
      return { call, leg: leg ?? null };
    }
  }
  // 2. Known leg for this provider call id.
  const leg = (
    await tx
      .select()
      .from(schema.callLegs)
      .where(eq(schema.callLegs.providerCallId, event.providerObjectId))
      .limit(1)
  )[0];
  if (leg) {
    const call = (
      await tx.select().from(schema.calls).where(eq(schema.calls.id, leg.callId)).limit(1)
    )[0];
    if (call) return { call, leg };
  }
  // 3. The provider id is the call's parent leg id.
  const byParent = (
    await tx
      .select()
      .from(schema.calls)
      .where(eq(schema.calls.providerCallId, event.providerObjectId))
      .limit(1)
  )[0];
  if (byParent) return { call: byParent, leg: null };
  // 4. The event names its parent (child-leg webhook without our query params).
  if (event.data.parentProviderCallId) {
    const call = (
      await tx
        .select()
        .from(schema.calls)
        .where(eq(schema.calls.providerCallId, event.data.parentProviderCallId))
        .limit(1)
    )[0];
    if (call) return { call, leg: null };
  }
  return null;
}

async function applyCallEvent(
  dbh: DbHandle,
  event: CanonicalCallEvent,
  ctx: ApplyContext,
): Promise<ApplyResult> {
  const source: EventSource = ctx.source ?? 'webhook';
  const result = await dbh.db.transaction(async (tx): Promise<ApplyResult & { bus?: object }> => {
    let resolved = await resolveCall(tx, event);

    // Unknown provider call: inbound calls are created so nothing is lost;
    // anything else is recorded as an explicit orphan (never silently dropped).
    if (!resolved) {
      if (event.data.direction === 'inbound' && event.data.to) {
        const number = (
          await tx
            .select()
            .from(schema.phoneNumbers)
            .where(eq(schema.phoneNumbers.phoneE164, event.data.to))
            .limit(1)
        )[0];
        if (number) {
          const inserted = await tx
            .insert(schema.calls)
            .values({
              orgId: number.orgId,
              direction: 'inbound',
              status: 'queued',
              phoneNumberId: number.id,
              fromNumber: event.data.from ?? 'unknown',
              toNumber: event.data.to,
              provider: event.provider,
              providerCallId: event.providerObjectId,
            })
            .onConflictDoNothing({ target: schema.calls.providerCallId })
            .returning();
          const call =
            inserted[0] ??
            (
              await tx
                .select()
                .from(schema.calls)
                .where(eq(schema.calls.providerCallId, event.providerObjectId))
                .limit(1)
            )[0];
          if (call) resolved = { call, leg: null };
        }
      }
      if (!resolved) {
        await tx
          .insert(schema.reconciliationMismatches)
          .values({
            objectType: 'orphan_provider_call',
            provider: event.provider,
            providerObjectId: event.providerObjectId,
            field: 'call',
            internalValue: null,
            providerValue: event.type,
          });
        return { outcome: 'orphaned' };
      }
    }

    const { call } = resolved;
    let leg = resolved.leg;

    // Ensure a leg row exists for this provider call resource.
    if (!leg) {
      const legRole =
        event.data.legRole ??
        (call.providerCallId === event.providerObjectId
          ? call.direction === 'outbound'
            ? 'client'
            : 'pstn'
          : 'other');
      const inserted = await tx
        .insert(schema.callLegs)
        .values({
          orgId: call.orgId,
          callId: call.id,
          legRole,
          provider: event.provider,
          providerCallId: event.providerObjectId,
          fromNumber: event.data.from,
          toNumber: event.data.to,
          startedAt: event.occurredAt,
        })
        .onConflictDoNothing({ target: schema.callLegs.providerCallId })
        .returning();
      leg =
        inserted[0] ??
        (
          await tx
            .select()
            .from(schema.callLegs)
            .where(eq(schema.callLegs.providerCallId, event.providerObjectId))
            .limit(1)
        )[0] ?? null;
    }

    // Idempotency gate: one canonical fact applies exactly once.
    const dedupeToken = `${event.providerObjectId}:${event.type}:${event.sequenceNumber ?? 'x'}`;
    const gate = await tx
      .insert(schema.callEvents)
      .values({
        orgId: call.orgId,
        callId: call.id,
        legId: leg?.id ?? null,
        eventType: event.type,
        occurredAt: event.occurredAt,
        source,
        webhookEventId: ctx.webhookEventId ?? null,
        sequenceNumber: event.sequenceNumber ?? null,
        dedupeToken,
        payload: event.raw,
      })
      .onConflictDoNothing()
      .returning({ id: schema.callEvents.id });
    if (gate.length === 0) return { outcome: 'duplicate', callId: call.id };

    // Leg-level bookkeeping.
    if (leg) {
      const legUpdate: Partial<typeof schema.callLegs.$inferInsert> = {
        status: event.type.replace('call.', ''),
      };
      if (event.type === 'call.answered' && !leg.answeredAt) legUpdate.answeredAt = event.occurredAt;
      if (isTerminalEvent(event)) {
        if (!leg.endedAt) legUpdate.endedAt = event.occurredAt;
        if (leg.durationSeconds == null && event.data.durationSeconds != null) {
          legUpdate.durationSeconds = event.data.durationSeconds;
        }
      }
      await tx.update(schema.callLegs).set(legUpdate).where(eq(schema.callLegs.id, leg.id));
    }

    // Which leg drives the logical call (docs/inbound-routing.md §5):
    // the PSTN leg is the truth leg; a client leg's `answered` means a rep
    // actually picked up; a client leg's terminal events never override a
    // live PSTN leg. On inbound, the caller leg goes "in-progress" the moment
    // any TwiML executes (voicemail included) — that is not an agent answer.
    const legRoleForRules = leg?.legRole ?? event.data.legRole ?? 'other';
    const isParentLeg = call.providerCallId === event.providerObjectId;
    let drives = true;
    if (call.direction === 'inbound' && isParentLeg && event.type === 'call.answered') {
      drives = false;
    } else if (legRoleForRules === 'client') {
      if (event.type === 'call.answered') {
        drives = true;
      } else if (event.type === 'call.initiated') {
        drives = call.direction === 'outbound';
      } else if (isTerminalEvent(event)) {
        // Terminal from a browser leg only decides the call when no PSTN leg
        // ever existed (canceled/failed before any dial happened).
        const pstnLeg = (
          await tx
            .select()
            .from(schema.callLegs)
            .where(and(eq(schema.callLegs.callId, call.id), eq(schema.callLegs.legRole, 'pstn')))
            .limit(1)
        )[0];
        drives = !pstnLeg;
      } else {
        drives = false;
      }
    }

    let statusChanged = false;
    if (drives) {
      const snapshot: CallSnapshot = {
        status: call.status,
        initiatedAt: call.initiatedAt,
        ringingAt: call.ringingAt,
        answeredAt: call.answeredAt,
        endedAt: call.endedAt,
        durationSeconds: call.durationSeconds,
        failureClass: call.failureClass,
      };
      const change = reduceCallEvent(snapshot, event, source);
      // A busy/no-answer that came from the browser leg (no PSTN ever dialed)
      // is our softphone rejecting or missing the ring-back — not the seller.
      // Mapping it to seller_busy made the dialer lie about why the call died.
      if (
        change.failureClass &&
        legRoleForRules === 'client' &&
        (change.status === 'busy' || change.status === 'no_answer')
      ) {
        change.failureClass = 'platform_failure';
      }
      let adoptedUserId: string | null = null;
      if (!change.noop) {
        const update: Partial<typeof schema.calls.$inferInsert> = {};
        // A client leg answering identifies the owning rep (multi-ring queues
        // and simultaneous rings don't know who'll pick up until they do).
        if (event.type === 'call.answered' && legRoleForRules === 'client' && event.data.to) {
          // Twilio's client address carries the user id; Telnyx's SIP address
          // carries a generated username that has to be looked back up.
          const answeredBy = await userIdFromClientAddress(dbh, event.data.to);
          if (answeredBy && asUuid(answeredBy) && call.userId !== answeredBy) {
            update.userId = answeredBy;
            adoptedUserId = answeredBy;
          }
        }
        if (change.status) {
          update.status = change.status;
          statusChanged = true;
        }
        if (change.initiatedAt) update.initiatedAt = change.initiatedAt;
        if (change.ringingAt) update.ringingAt = change.ringingAt;
        if (change.answeredAt) update.answeredAt = change.answeredAt;
        if (change.endedAt) update.endedAt = change.endedAt;
        if (change.durationSeconds != null) update.durationSeconds = change.durationSeconds;
        if (change.failureClass) update.failureClass = change.failureClass;
        if (change.failureDetail) update.failureDetail = change.failureDetail;
        await tx.update(schema.calls).set(update).where(eq(schema.calls.id, call.id));
      }

      // Speed-to-lead ladder: first-write-wins stamps (docs/telephony-events.md §5).
      if (call.leadId) {
        if (call.direction === 'outbound' && event.type === 'call.initiated') {
          await tx.execute(sql`
            UPDATE leads SET first_attempt_at = COALESCE(first_attempt_at, ${event.occurredAt})
            WHERE id = ${call.leadId}`);
        }
        if (event.type === 'call.answered') {
          await tx.execute(sql`
            UPDATE leads SET first_answer_at = COALESCE(first_answer_at, ${event.occurredAt})
            WHERE id = ${call.leadId}`);
        }
        if (event.type === 'call.completed' && (event.data.durationSeconds ?? 0) >= 30) {
          await tx.execute(sql`
            UPDATE leads SET first_conversation_at = COALESCE(first_conversation_at, ${event.occurredAt})
            WHERE id = ${call.leadId}`);
        }
      }

      if (isTerminalEvent(event) && change.status) {
        await enqueueJob(tx, {
          jobType: 'reconcile-call',
          payload: { callId: call.id },
          dedupeKey: `reconcile-call:${call.id}`,
          runAt: new Date(Date.now() + (ctx.reconcileDelayMs ?? 120_000)),
          correlationId: call.correlationId,
        });
        // Feed longest_idle queue fairness (docs/inbound-routing.md §9).
        const ownerUserId = adoptedUserId ?? call.userId;
        if (ownerUserId) {
          await tx.execute(sql`
            UPDATE agent_presence SET last_call_ended_at = ${event.occurredAt}
            WHERE user_id = ${ownerUserId}`);
        }
      }

      // At-least-once processing can apply `answered` after the terminal
      // event (job-claim ties). A late adoption on an already-terminal call
      // must still stamp the fairness clock the terminal pass had no owner for.
      if (adoptedUserId && isTerminal(snapshot.status)) {
        await tx.execute(sql`
          UPDATE agent_presence SET last_call_ended_at = ${snapshot.endedAt ?? event.occurredAt}
          WHERE user_id = ${adoptedUserId}`);
      }
    }

    return {
      outcome: 'applied',
      callId: call.id,
      bus: statusChanged || drives
        ? {
            type: 'call.updated',
            orgId: call.orgId,
            userId: call.userId ?? undefined,
            callId: call.id,
            status: undefined, // filled below from fresh read
          }
        : undefined,
    };
  });

  // Publish after commit so subscribers always see committed state.
  if (result.outcome === 'applied' && result.callId && (result as { bus?: object }).bus) {
    const fresh = (
      await dbh.db.select().from(schema.calls).where(eq(schema.calls.id, result.callId)).limit(1)
    )[0];
    if (fresh) {
      await publishBusEvent(dbh.pool, {
        type: 'call.updated',
        orgId: fresh.orgId,
        userId: fresh.userId ?? undefined,
        callId: fresh.id,
        status: fresh.status,
      }).catch((err) => ctx.logger.warn({ err }, 'bus publish failed'));
    }
  }
  return { outcome: result.outcome, callId: result.callId };
}

function isTerminalEvent(event: CanonicalCallEvent): boolean {
  return (
    event.type === 'call.completed' ||
    event.type === 'call.no_answer' ||
    event.type === 'call.busy' ||
    event.type === 'call.failed' ||
    event.type === 'call.canceled'
  );
}

// ---------------------------------------------------------------------------
// Conference events (docs/telephony-events.md §9)
// ---------------------------------------------------------------------------

const PARTICIPANT_EVENTS = new Set<string>([
  'conference.participant_joined',
  'conference.participant_left',
  'conference.participant_hold',
  'conference.participant_unhold',
]);

/**
 * Reconcile our participant rows against the room. The controls in
 * services/conference.ts write an optimistic state the moment the rep acts;
 * this is the authoritative correction, and it is also what catches changes we
 * never initiated — a teammate hanging up, a party the provider dropped.
 */
async function applyConferenceEvent(
  dbh: DbHandle,
  event: CanonicalConferenceEvent,
  ctx: ApplyContext,
): Promise<ApplyResult> {
  const callId = asUuid(event.data.talkrCallId);
  const result = await dbh.db.transaction(async (tx): Promise<ApplyResult> => {
    const call = callId
      ? (await tx.select().from(schema.calls).where(eq(schema.calls.id, callId)).limit(1))[0]
      : undefined;
    if (!call) {
      // A room we do not own (or a call already purged): record it rather than
      // dropping it, same as an orphan call event.
      await tx.insert(schema.reconciliationMismatches).values({
        objectType: 'orphan_conference',
        provider: event.provider,
        providerObjectId: event.providerObjectId,
        field: 'call',
        internalValue: null,
        providerValue: event.data.friendlyName ?? event.type,
      });
      return { outcome: 'orphaned' };
    }

    const participantId = event.data.providerParticipantId;
    const gate = await tx
      .insert(schema.callEvents)
      .values({
        orgId: call.orgId,
        callId: call.id,
        eventType: event.type,
        occurredAt: event.occurredAt,
        source: ctx.source ?? 'webhook',
        webhookEventId: ctx.webhookEventId ?? null,
        sequenceNumber: event.sequenceNumber ?? null,
        dedupeToken: `${event.providerObjectId}:${event.type}:${participantId ?? 'x'}:${event.sequenceNumber ?? 'x'}`,
        payload: event.raw,
      })
      .onConflictDoNothing()
      .returning({ id: schema.callEvents.id });
    if (gate.length === 0) return { outcome: 'duplicate', callId: call.id };

    // The room's SID only exists once it starts; stamp it so reconciliation
    // and support can address the conference directly.
    if (event.type === 'conference.started') {
      await tx
        .update(schema.callParticipants)
        .set({ providerConferenceId: event.data.providerConferenceId })
        .where(eq(schema.callParticipants.callId, call.id));
      return { outcome: 'applied', callId: call.id };
    }

    // Room gone: nobody is on the line any more, whatever we last believed.
    if (event.type === 'conference.ended') {
      await tx
        .update(schema.callParticipants)
        .set({ state: 'left', leftAt: event.occurredAt })
        .where(
          and(
            eq(schema.callParticipants.callId, call.id),
            ne(schema.callParticipants.state, 'left'),
          ),
        );
      return { outcome: 'applied', callId: call.id };
    }

    if (!participantId || !PARTICIPANT_EVENTS.has(event.type)) {
      return { outcome: 'ignored', callId: call.id };
    }

    const row = (
      await tx
        .select()
        .from(schema.callParticipants)
        .where(eq(schema.callParticipants.providerParticipantId, participantId))
        .limit(1)
    )[0];
    if (!row) {
      // A party joined the room without going through our controls — an
      // operator adding someone from the Twilio console, say. Record them so
      // the roster the rep sees matches the room they are actually in.
      await tx
        .insert(schema.callParticipants)
        .values({
          orgId: call.orgId,
          callId: call.id,
          roomName: event.data.friendlyName ?? `talkr-${call.id}`,
          providerConferenceId: event.data.providerConferenceId,
          providerParticipantId: participantId,
          role: 'external',
          state: event.type === 'conference.participant_joined' ? 'joined' : 'ringing',
          joinedAt: event.type === 'conference.participant_joined' ? event.occurredAt : null,
          raw: event.raw,
        })
        .onConflictDoNothing({ target: schema.callParticipants.providerParticipantId });
      return { outcome: 'applied', callId: call.id };
    }

    const change = reduceParticipantEvent(
      row.state as ParticipantState,
      event.type as ParticipantEventType,
      event.occurredAt,
    );
    if (change.noop && change.joinedAt == null) return { outcome: 'applied', callId: call.id };
    await tx
      .update(schema.callParticipants)
      .set({
        ...(change.state ? { state: change.state } : {}),
        ...(change.joinedAt && row.joinedAt == null ? { joinedAt: change.joinedAt } : {}),
        ...(change.leftAt && row.leftAt == null ? { leftAt: change.leftAt } : {}),
        ...(event.data.providerConferenceId
          ? { providerConferenceId: event.data.providerConferenceId }
          : {}),
      })
      .where(eq(schema.callParticipants.id, row.id));
    return { outcome: 'applied', callId: call.id };
  });

  // Roster changes are what the active-call UI renders; push after commit.
  if (result.outcome === 'applied' && result.callId) {
    const fresh = (
      await dbh.db.select().from(schema.calls).where(eq(schema.calls.id, result.callId)).limit(1)
    )[0];
    if (fresh) {
      await publishBusEvent(dbh.pool, {
        type: 'call.updated',
        orgId: fresh.orgId,
        userId: fresh.userId ?? undefined,
        callId: fresh.id,
        status: fresh.status,
      }).catch((err) => ctx.logger.warn({ err }, 'bus publish failed'));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Recording events
// ---------------------------------------------------------------------------

async function applyRecordingEvent(
  dbh: DbHandle,
  event: CanonicalRecordingEvent,
  ctx: ApplyContext,
): Promise<ApplyResult> {
  return dbh.db.transaction(async (tx): Promise<ApplyResult> => {
    // Resolve the call: our id hint, then leg, then parent provider id.
    let call: typeof schema.calls.$inferSelect | undefined;
    if (asUuid(event.data.talkrCallId)) {
      call = (
        await tx.select().from(schema.calls).where(eq(schema.calls.id, event.data.talkrCallId!)).limit(1)
      )[0];
    }
    if (!call) {
      const leg = (
        await tx
          .select()
          .from(schema.callLegs)
          .where(eq(schema.callLegs.providerCallId, event.data.providerCallId))
          .limit(1)
      )[0];
      if (leg) {
        call = (
          await tx.select().from(schema.calls).where(eq(schema.calls.id, leg.callId)).limit(1)
        )[0];
      }
    }
    if (!call) {
      call = (
        await tx
          .select()
          .from(schema.calls)
          .where(eq(schema.calls.providerCallId, event.data.providerCallId))
          .limit(1)
      )[0];
    }
    if (!call) {
      await tx.insert(schema.reconciliationMismatches).values({
        objectType: 'orphan_recording',
        provider: event.provider,
        providerObjectId: event.providerObjectId,
        field: 'recording',
        providerValue: event.type,
      });
      return { outcome: 'orphaned' };
    }

    const statusMap = {
      'recording.started': 'processing',
      'recording.completed': 'completed',
      'recording.failed': 'failed',
    } as const;

    const values: typeof schema.recordings.$inferInsert = {
      orgId: call.orgId,
      callId: call.id,
      provider: event.provider,
      providerRecordingId: event.providerObjectId,
      status: statusMap[event.type],
      durationSeconds: event.data.durationSeconds ?? null,
      channels: event.data.channels ?? null,
      providerUrl: event.data.providerUrl ?? null,
      errorCode: event.data.errorCode ?? null,
      startedAt: event.type === 'recording.started' ? event.occurredAt : null,
      completedAt: event.type === 'recording.completed' ? event.occurredAt : null,
      raw: event.raw,
    };
    const inserted = await tx
      .insert(schema.recordings)
      .values(values)
      .onConflictDoUpdate({
        target: schema.recordings.providerRecordingId,
        set: {
          status: values.status,
          durationSeconds: sql`COALESCE(${values.durationSeconds ?? null}, ${schema.recordings.durationSeconds})`,
          channels: sql`COALESCE(${values.channels ?? null}, ${schema.recordings.channels})`,
          providerUrl: sql`COALESCE(${values.providerUrl ?? null}, ${schema.recordings.providerUrl})`,
          errorCode: values.errorCode ?? null,
          completedAt: sql`COALESCE(${values.completedAt ?? null}, ${schema.recordings.completedAt})`,
        },
      })
      .returning({ id: schema.recordings.id });
    const recordingId = inserted[0]?.id;

    const dedupeToken = `${event.providerObjectId}:${event.type}:x`;
    const gate = await tx
      .insert(schema.callEvents)
      .values({
        orgId: call.orgId,
        callId: call.id,
        eventType: event.type,
        occurredAt: event.occurredAt,
        source: ctx.source ?? 'webhook',
        webhookEventId: ctx.webhookEventId ?? null,
        dedupeToken,
        payload: event.raw,
      })
      .onConflictDoNothing()
      .returning({ id: schema.callEvents.id });
    if (gate.length === 0) return { outcome: 'duplicate', callId: call.id };

    if (event.type === 'recording.completed' && recordingId) {
      await enqueueJob(tx, {
        jobType: 'mirror-recording',
        payload: { recordingId },
        dedupeKey: `mirror-recording:${recordingId}`,
        correlationId: call.correlationId,
      });
      // Transcript + AI notes (docs/transcription.md). Same transaction as
      // the status write, so a recording can never complete without a job.
      await enqueueJob(tx, {
        jobType: 'transcribe-recording',
        payload: { recordingId },
        dedupeKey: `transcribe:${recordingId}`,
        correlationId: call.correlationId,
      });
    }
    return { outcome: 'applied', callId: call.id };
  });
}
