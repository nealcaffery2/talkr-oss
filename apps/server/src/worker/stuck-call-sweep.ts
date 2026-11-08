/**
 * stuck-call-sweep: ends outbound calls the carrier never reported on.
 *
 * A call stays `queued` or `initiated` when its browser leg never comes up
 * (another registration of the rep's login rejected it, or the socket was
 * dead): no status callback arrives, so nothing ever ends it. Seen on
 * 2026-10-21: one rep, 20 calls left at `initiated` for good. Every five
 * minutes this hangs up whatever the carrier may still hold for such a call
 * and fails it the way a refused REST dial is failed (services/dial-sessions):
 * the row goes to `failed / platform_failure` and a `call.failed` event lands
 * in call_events, which the webhook fan-out tails, so CLOZR sees it end too.
 *
 * Idempotent: the update only matches a call still queued or initiated, and
 * the event's dedupe token is per call.
 */

import { and, eq, gt, inArray, lt, sql } from 'drizzle-orm';
import { enqueueJob, schema, type DbLike } from '@talkr/db';
import type { JobHandler } from './handlers.js';

export const STUCK_CALL_SWEEP_JOB = 'stuck-call-sweep';
/** Far longer than any ring: a live call has rung or ended well inside this. */
export const STUCK_AFTER_MS = 10 * 60_000;
/** Older rows are history, not stuck calls; bounds the scan. */
const LOOKBACK_MS = 2 * 24 * 60 * 60_000;
const BATCH = 200;
const DETAIL = 'No carrier status within 10 minutes; ended by the stuck-call sweep.';

export const stuckCallSweep: JobHandler = async (deps) => {
  const { dbh, provider, logger } = deps;
  const now = Date.now();
  const stuck = await dbh.db
    .select()
    .from(schema.calls)
    .where(
      and(
        eq(schema.calls.direction, 'outbound'),
        inArray(schema.calls.status, ['queued', 'initiated']),
        lt(schema.calls.createdAt, new Date(now - STUCK_AFTER_MS)),
        gt(schema.calls.createdAt, new Date(now - LOOKBACK_MS)),
      ),
    )
    .limit(BATCH);

  let ended = 0;
  for (const call of stuck) {
    // A 404 is already handled as "gone"; anything else must not keep the row stuck.
    if (call.providerCallId) {
      await provider.hangupCall(call.providerCallId).catch((err: Error) =>
        logger.warn({ callId: call.id, err: err.message }, 'stuck call hangup failed'),
      );
    }
    const done = await dbh.db.execute(sql`
      UPDATE calls SET status = 'failed', failure_class = 'platform_failure',
        ended_at = now(), failure_detail = ${DETAIL}
      WHERE id = ${call.id} AND status IN ('queued', 'initiated')`);
    if (!done.rowCount) continue; // a late callback moved it on meanwhile
    ended++;
    await dbh.db
      .insert(schema.callEvents)
      .values({
        orgId: call.orgId,
        callId: call.id,
        eventType: 'call.failed',
        occurredAt: new Date(),
        source: 'system',
        dedupeToken: `${call.id}:stuck-call-sweep:x`,
        payload: { error: DETAIL },
      })
      .onConflictDoNothing();
  }
  if (ended) logger.info({ ended }, 'stuck calls ended');
};

/** Every five minutes, deduped per bucket so the worker loop and the serverless tick run it once. */
export async function scheduleStuckCallSweep(db: DbLike, at: Date = new Date()): Promise<void> {
  const bucket = `${at.toISOString().slice(0, 13)}:${String(Math.floor(at.getUTCMinutes() / 5) * 5).padStart(2, '0')}`;
  await enqueueJob(db, {
    jobType: STUCK_CALL_SWEEP_JOB,
    payload: {},
    dedupeKey: `${STUCK_CALL_SWEEP_JOB}:${bucket}`,
  });
}
