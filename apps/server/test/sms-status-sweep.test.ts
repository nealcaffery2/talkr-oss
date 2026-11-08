/**
 * sms-status-sweep (worker/sms-status-sweep.ts): a text still `sending` ten
 * minutes on is finished from the carrier's own record, through the same
 * path a delivery receipt takes; a fresh one and one with no SID are left
 * alone; one the carrier no longer knows is failed and journaled.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { CanonicalMessageEvent } from '@talkr/core';
import { enqueueJob, schema } from '@talkr/db';
import { createTestContext, type TestContext } from './helpers.js';
import { SMS_STATUS_SWEEP_JOB } from '../src/worker/sms-status-sweep.js';

let ctx: TestContext;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);
/** One thread per message: conversations are unique per (org, ours, theirs). */
let nextDest = 6145550700;
const DEST = () => `+1${nextDest++}`;

/** What the carrier says about each SID; absent means a 404. */
const carrier = new Map<string, Pick<CanonicalMessageEvent['data'], 'status' | 'errorCode'>>();

beforeAll(async () => {
  ctx = await createTestContext({
    telnyxOverrides: {
      fetchMessage: async (sid) => {
        const truth = carrier.get(sid);
        if (!truth) return null;
        return {
          type: 'message.status',
          provider: 'telnyx',
          providerObjectId: sid,
          occurredAt: new Date(),
          data: { ...truth, numSegments: 1 },
          raw: { sid },
        };
      },
    },
  });
});
afterAll(async () => {
  await ctx.close();
});

async function sending(sid: string | null, createdAt: Date, to = DEST()) {
  const [convo] = await ctx.dbh.db
    .insert(schema.conversations)
    .values({ orgId: ctx.seed.orgId, ourNumber: '+15005550006', theirNumber: to } as never)
    .returning();
  return (
    await ctx.dbh.db
      .insert(schema.messages)
      .values({
        orgId: ctx.seed.orgId,
        conversationId: convo!.id,
        direction: 'outbound',
        status: 'sending',
        body: 'sweep probe',
        providerMessageSid: sid,
        createdAt,
      } as never)
      .returning()
  )[0]!;
}

describe('sms-status-sweep', () => {
  it('finishes stuck texts from the carrier record and leaves the rest', async () => {
    carrier.set('SM_sweep_delivered', { status: 'delivered' });
    carrier.set('SM_sweep_failed', { status: 'failed', errorCode: '40001' });
    carrier.set('SM_sweep_still', { status: 'sending' });
    carrier.set('SM_sweep_fresh', { status: 'delivered' });

    const delivered = await sending('SM_sweep_delivered', minutesAgo(30));
    const failed = await sending('SM_sweep_failed', minutesAgo(30), '+16145550778');
    const still = await sending('SM_sweep_still', minutesAgo(30));
    const gone = await sending('SM_sweep_gone', minutesAgo(30));
    const fresh = await sending('SM_sweep_fresh', minutesAgo(2));
    const noSid = await sending(null, minutesAgo(30));

    await enqueueJob(ctx.dbh.db, { jobType: SMS_STATUS_SWEEP_JOB, payload: {} });
    await ctx.runner.drain();

    const row = async (id: string) =>
      (await ctx.dbh.db.select().from(schema.messages).where(eq(schema.messages.id, id)))[0]!;

    const d = await row(delivered.id);
    expect(d.status).toBe('delivered');
    expect(d.deliveredAt).not.toBeNull();

    const f = await row(failed.id);
    expect(f.status).toBe('failed');
    expect(f.errorCode).toBe('40001');
    expect(f.failureClass).toBe('carrier_failure');
    // The receipt path's self-heal ran too: the number is suppressed for SMS.
    const suppressed = await ctx.dbh.db
      .select()
      .from(schema.suppressionRecords)
      .where(eq(schema.suppressionRecords.phoneE164, '+16145550778'));
    expect(suppressed).toHaveLength(1);

    const g = await row(gone.id);
    expect(g.status).toBe('failed');
    expect(g.failureClass).toBe('platform_failure');
    expect(g.errorCode).toBe('provider_not_found');
    const mismatches = await ctx.dbh.db
      .select()
      .from(schema.reconciliationMismatches)
      .where(eq(schema.reconciliationMismatches.objectId, gone.id));
    expect(mismatches).toHaveLength(1);

    expect((await row(still.id)).status).toBe('sending');
    expect((await row(fresh.id)).status).toBe('sending');
    expect((await row(noSid.id)).status).toBe('sending');

    // A second run moves nothing it already finished and journals nothing twice.
    await enqueueJob(ctx.dbh.db, { jobType: SMS_STATUS_SWEEP_JOB, payload: {} });
    await ctx.runner.drain();
    expect((await row(delivered.id)).status).toBe('delivered');
    const again = await ctx.dbh.db
      .select()
      .from(schema.reconciliationMismatches)
      .where(eq(schema.reconciliationMismatches.objectId, gone.id));
    expect(again).toHaveLength(1);
  });
});
