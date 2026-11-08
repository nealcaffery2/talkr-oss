/**
 * sms-status-sweep: finishes a text whose delivery receipt never arrived.
 *
 * A text goes `queued` → `sending` when the carrier accepts it, and only the
 * carrier's status webhook moves it on. When those webhooks stop (seen on
 * 2026-11-02: every SMS receipt from 19:42 UTC on went missing while voice
 * callbacks kept arriving) the text is delivered but reads "sending" for good
 * in the inbox and in CLOZR, and the rep sends it again.
 *
 * Every five minutes this asks the carrier for any outbound text still
 * `sending` ten minutes after it was handed over and feeds the answer through
 * the same path the receipt takes (`applyMessageEvent`), so delivered,
 * failed, the carrier error code and the not-textable suppression all land
 * exactly as a webhook would have set them. A message the carrier no longer
 * knows is failed outright and written to reconciliation_mismatches.
 */

import { and, eq, gt, isNotNull, lt, sql } from 'drizzle-orm';
import { enqueueJob, schema, type DbLike } from '@talkr/db';
import { applyMessageEvent } from '../services/messages.js';
import type { JobHandler } from './handlers.js';

export const SMS_STATUS_SWEEP_JOB = 'sms-status-sweep';
/** A receipt follows the send within seconds; past this it is lost, not pending. */
export const STUCK_AFTER_MS = 10 * 60_000;
/** Older rows are history; bounds the scan. */
const LOOKBACK_MS = 24 * 60 * 60_000;
// ponytail: no per-message ask counter; a text the carrier still calls
// `sending` is asked again next sweep, and the carrier finalizes every
// message within its one-hour validity, so the lookback is the only bound.
const BATCH = 100;

export const smsStatusSweep: JobHandler = async (deps) => {
  const { dbh, provider, logger } = deps;
  if (!provider.fetchMessage) return;
  const now = Date.now();
  const stuck = await dbh.db
    .select()
    .from(schema.messages)
    .where(
      and(
        eq(schema.messages.direction, 'outbound'),
        eq(schema.messages.status, 'sending'),
        eq(schema.messages.provider, provider.name),
        isNotNull(schema.messages.providerMessageSid),
        lt(schema.messages.createdAt, new Date(now - STUCK_AFTER_MS)),
        gt(schema.messages.createdAt, new Date(now - LOOKBACK_MS)),
      ),
    )
    .orderBy(schema.messages.createdAt)
    .limit(BATCH);

  let finished = 0;
  for (const message of stuck) {
    const sid = message.providerMessageSid!;
    let event;
    try {
      event = await provider.fetchMessage(sid);
    } catch (err) {
      // A carrier read that fails is retried on the next sweep.
      logger.warn({ messageId: message.id, err: (err as Error).message }, 'sms status sweep: carrier read failed');
      continue;
    }
    if (!event) {
      const gone = await dbh.db.execute(sql`
        UPDATE messages SET status = 'failed', failure_class = 'platform_failure',
          error_code = 'provider_not_found', failed_at = now()
        WHERE id = ${message.id} AND status = 'sending'`);
      if (!gone.rowCount) continue; // a late receipt moved it on meanwhile
      await dbh.db.insert(schema.reconciliationMismatches).values({
        orgId: message.orgId,
        objectType: 'message',
        objectId: message.id,
        provider: provider.name,
        providerObjectId: sid,
        field: 'existence',
        internalValue: 'sending',
        providerValue: 'not_found',
      });
      logger.warn({ messageId: message.id, sid }, 'sms status sweep: carrier has no such message');
      finished++;
      continue;
    }
    const result = await applyMessageEvent(dbh, event, { logger });
    if (result.outcome === 'applied') finished++;
  }
  if (stuck.length) logger.info({ checked: stuck.length, finished }, 'sms status sweep');
};

/** Every five minutes, deduped per bucket so the worker loop and the serverless tick run it once. */
export async function scheduleSmsStatusSweep(db: DbLike, at: Date = new Date()): Promise<void> {
  const bucket = `${at.toISOString().slice(0, 13)}:${String(Math.floor(at.getUTCMinutes() / 5) * 5).padStart(2, '0')}`;
  await enqueueJob(db, {
    jobType: SMS_STATUS_SWEEP_JOB,
    payload: {},
    dedupeKey: `${SMS_STATUS_SWEEP_JOB}:${bucket}`,
  });
}
