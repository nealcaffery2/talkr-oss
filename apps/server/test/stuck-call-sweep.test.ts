/**
 * stuck-call-sweep (worker/stuck-call-sweep.ts): an outbound call no carrier
 * status ever ended is failed after ten minutes and journaled as call.failed;
 * a fresh call, a ringing one and an old finished one are left alone.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { enqueueJob, schema } from '@talkr/db';
import { createTestContext, type TestContext } from './helpers.js';
import { STUCK_CALL_SWEEP_JOB } from '../src/worker/stuck-call-sweep.js';

let ctx: TestContext;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000);

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

async function call(status: string, createdAt: Date, providerCallId: string | null) {
  return (
    await ctx.dbh.db
      .insert(schema.calls)
      .values({ orgId: ctx.seed.orgId, direction: 'outbound', status, fromNumber: '+15005550006', toNumber: '+16145550111', providerCallId, createdAt } as never)
      .returning()
  )[0]!;
}

describe('stuck-call-sweep', () => {
  it('fails calls the carrier never reported on and leaves the rest', async () => {
    const stuck = await call('initiated', minutesAgo(30), 'v3:stuck-initiated');
    const neverDialed = await call('queued', minutesAgo(45), null);
    const fresh = await call('initiated', minutesAgo(2), 'v3:fresh');
    const ringing = await call('ringing', minutesAgo(30), 'v3:ringing');
    const done = await call('completed', minutesAgo(30), 'v3:done');

    await enqueueJob(ctx.dbh.db, { jobType: STUCK_CALL_SWEEP_JOB, payload: {} });
    await ctx.runner.drain();

    const status = async (id: string) => (await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.id, id)))[0]!;
    for (const c of [stuck, neverDialed]) {
      const row = await status(c.id);
      expect(row.status).toBe('failed');
      expect(row.failureClass).toBe('platform_failure');
      expect(row.endedAt).not.toBeNull();
      const events = await ctx.dbh.db
        .select()
        .from(schema.callEvents)
        .where(and(eq(schema.callEvents.callId, c.id), eq(schema.callEvents.eventType, 'call.failed')));
      expect(events).toHaveLength(1);
    }
    expect((await status(fresh.id)).status).toBe('initiated');
    expect((await status(ringing.id)).status).toBe('ringing');
    expect((await status(done.id)).status).toBe('completed');

    // A second run finds nothing left and writes no second event.
    await enqueueJob(ctx.dbh.db, { jobType: STUCK_CALL_SWEEP_JOB, payload: {} });
    await ctx.runner.drain();
    const again = await ctx.dbh.db.select().from(schema.callEvents).where(eq(schema.callEvents.callId, stuck.id));
    expect(again.filter((e) => e.eventType === 'call.failed')).toHaveLength(1);
  });
});
