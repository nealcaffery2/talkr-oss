/**
 * recording-sweep: a call recording the carrier made but never told us about.
 *
 * Every answered call is recorded by its conference room
 * (services/browser-leg.ts, `record: true`), and the carrier posts
 * `recording-status` when the file is ready. When that webhook is lost the
 * `recordings` row is simply never written: no transcript, no AI notes, and
 * the rep's call shows no recording for good. Seen on 2026-10-29: a 17 minute
 * seller call with nothing behind it.
 *
 * Every five minutes this asks the carrier, by the room's own id, for the
 * recordings of any answered call that ended a few minutes ago with none on
 * file, and feeds each one through the same path the webhook takes
 * (`applyCanonicalEvent` → row, mirror job, transcript job). A call is asked
 * about at most three times; one the carrier has nothing for is written to
 * reconciliation_mismatches, so a recording that never existed is visible
 * instead of silently absent.
 */

import { sql } from 'drizzle-orm';
import type { CanonicalRecordingEvent } from '@talkr/core';
import { enqueueJob, schema, type DbLike } from '@talkr/db';
import { applyCanonicalEvent } from '../services/apply-events.js';
import type { JobHandler } from './handlers.js';

export const RECORDING_SWEEP_JOB = 'recording-sweep';
/** The carrier posts the recording within a minute of hangup; past this it is late, not pending. */
export const SETTLE_MS = 3 * 60_000;
/** Older calls are history, not something still being written; bounds the scan. */
const LOOKBACK_MS = 48 * 60 * 60_000;
/** Shorter than this is a hang-up on answer; the carrier keeps no file worth chasing. */
const MIN_TALK_SECONDS = 10;
/** How many times a call is asked about before it is written off. */
export const MAX_ASKS = 3;
const BATCH = 50;

type Row = {
  id: string;
  org_id: string;
  provider_call_id: string | null;
  asks: number;
  provider_conference_id: string;
};

export const recordingSweep: JobHandler = async (deps) => {
  const { dbh, provider, logger } = deps;
  if (!provider.listConferenceRecordings) return;
  const now = Date.now();
  const found = await dbh.db.execute(sql`
    SELECT c.id, c.org_id, c.provider_call_id,
      COALESCE((c.raw->'recordingSweep'->>'asks')::int, 0) AS asks,
      p.provider_conference_id
    FROM calls c
    JOIN LATERAL (
      SELECT cp.provider_conference_id FROM call_participants cp
      WHERE cp.call_id = c.id AND cp.provider_conference_id IS NOT NULL
      ORDER BY cp.created_at LIMIT 1
    ) p ON true
    WHERE c.answered_at IS NOT NULL
      AND c.ended_at IS NOT NULL
      AND c.ended_at < ${new Date(now - SETTLE_MS)}
      AND c.ended_at > ${new Date(now - LOOKBACK_MS)}
      AND COALESCE(c.duration_seconds, 0) >= ${MIN_TALK_SECONDS}
      AND COALESCE((c.raw->'recordingSweep'->>'asks')::int, 0) < ${MAX_ASKS}
      AND NOT COALESCE((c.raw->>'abandoned')::boolean, false)
      AND NOT EXISTS (SELECT 1 FROM recordings r WHERE r.call_id = c.id)
    ORDER BY c.ended_at ASC
    LIMIT ${BATCH}`);
  const rows = found.rows as Row[];

  let recovered = 0;
  for (const call of rows) {
    let listed;
    try {
      listed = await provider.listConferenceRecordings(call.provider_conference_id);
    } catch (err) {
      // A carrier read that fails is retried on the next sweep; it does not spend an ask.
      logger.warn({ callId: call.id, err: (err as Error).message }, 'recording sweep: carrier read failed');
      continue;
    }
    const completed = listed.filter((r) => r.status === 'completed' && r.providerRecordingId);
    for (const rec of completed) {
      const event: CanonicalRecordingEvent = {
        type: 'recording.completed',
        provider: provider.name,
        providerObjectId: rec.providerRecordingId,
        occurredAt: rec.endedAt ?? rec.startedAt ?? new Date(),
        data: {
          providerCallId: call.provider_call_id ?? call.provider_conference_id,
          talkrCallId: call.id,
          ...(rec.durationSeconds != null ? { durationSeconds: rec.durationSeconds } : {}),
          ...(rec.channels != null ? { channels: rec.channels } : {}),
          ...(rec.providerUrl ? { providerUrl: rec.providerUrl } : {}),
          source: 'recording-sweep',
        },
        raw: rec.raw,
      };
      const result = await applyCanonicalEvent(dbh, event, { source: 'reconciliation', logger });
      if (result.outcome === 'applied') recovered++;
    }
    const asks = call.asks + 1;
    await dbh.db.execute(sql`
      UPDATE calls SET raw = raw || jsonb_build_object('recordingSweep',
        jsonb_build_object('asks', ${asks}::int, 'at', ${new Date().toISOString()}::text, 'found', ${completed.length}::int))
      WHERE id = ${call.id}`);
    if (completed.length === 0 && asks >= MAX_ASKS) {
      await dbh.db.insert(schema.reconciliationMismatches).values({
        orgId: call.org_id,
        objectType: 'call',
        objectId: call.id,
        provider: provider.name,
        providerObjectId: call.provider_conference_id,
        field: 'recording',
        internalValue: 'none',
        providerValue: 'none',
      });
      logger.warn({ callId: call.id, conferenceId: call.provider_conference_id }, 'recording sweep: carrier has no recording for an answered call');
    }
  }
  if (rows.length) logger.info({ checked: rows.length, recovered }, 'recording sweep');
};

/** Every five minutes, deduped per bucket so the worker loop and the serverless tick run it once. */
export async function scheduleRecordingSweep(db: DbLike, at: Date = new Date()): Promise<void> {
  const bucket = `${at.toISOString().slice(0, 13)}:${String(Math.floor(at.getUTCMinutes() / 5) * 5).padStart(2, '0')}`;
  await enqueueJob(db, {
    jobType: RECORDING_SWEEP_JOB,
    payload: {},
    dedupeKey: `${RECORDING_SWEEP_JOB}:${bucket}`,
  });
}
