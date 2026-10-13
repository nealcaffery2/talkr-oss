/**
 * Phase 6 queue metrics, reconstructed from journaled events + call
 * timestamps (docs/reporting.md §2.4). Seeding drives the REAL queue flows
 * (TwiML inbound → hold loop → ring / overflow), adapted from the Phase 3
 * queues-ivr suite; the reports then read what the flows journaled. Call
 * timestamps are pinned afterwards so the wait math asserts exact numbers.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { authHeader, createTestContext, webhookPost, type TestContext, repAddress } from './helpers.js';
import { provisionBrowserCredentials } from '../src/services/provision.js';
import { voiceStatus } from './fixtures/texml.js';

let ctx: TestContext;
let managerAuth: Record<string, string>;
let repBId: string;
let queueId: string;
const QUEUE_NUMBER = '+15005550910';
const CALLER = '+16145550099';
const FROM = '2026-08-17';
const TO = '2026-08-23';

beforeAll(async () => {
  ctx = await createTestContext();
  const { db } = ctx.dbh;

  await db
    .update(schema.organizations)
    .set({ settings: { timezone: 'America/New_York' } })
    .where(eq(schema.organizations.id, ctx.seed.orgId));

  const manager = (
    await db
      .insert(schema.users)
      .values({
        orgId: ctx.seed.orgId,
        email: 'manager@test-org.test',
        displayName: 'Mandy Manager',
        role: 'manager',
        authUserId: 'auth-manager-test-org',
      })
      .returning()
  )[0]!;
  managerAuth = await authHeader(manager.authUserId!);

  const repB = (
    await db
      .insert(schema.users)
      .values({
        orgId: ctx.seed.orgId,
        email: 'repb@test-org.test',
        displayName: 'Bella Rep',
        role: 'rep',
        authUserId: 'auth-repb-test-org',
      })
      .returning()
  )[0]!;
  repBId = repB.id;
  // Reps added after the harness minted credentials need theirs to be rung.
  await provisionBrowserCredentials(ctx.dbh, ctx.provider);

  const queue = (
    await db
      .insert(schema.queues)
      .values({
        orgId: ctx.seed.orgId,
        name: 'Acquisitions',
        strategy: 'round_robin',
        maxWaitSeconds: 90,
        waitMessage: 'Please hold.',
      })
      .returning()
  )[0]!;
  queueId = queue.id;
  await db.insert(schema.queueMembers).values([
    { queueId, userId: ctx.seed.repId },
    { queueId, userId: repBId },
  ]);
  await db.insert(schema.phoneNumbers).values({
    orgId: ctx.seed.orgId,
    phoneE164: QUEUE_NUMBER,
    providerNumberId: 'PN_queue_rep',
    queueId,
  });
});
afterAll(async () => {
  await ctx.close();
});

async function setPresence(userId: string, status: string) {
  await ctx.dbh.db
    .insert(schema.agentPresence)
    .values({ userId, orgId: ctx.seed.orgId, status, lastSeenAt: new Date() })
    .onConflictDoUpdate({
      target: schema.agentPresence.userId,
      set: { status, lastSeenAt: new Date() },
    });
}

function inbound(callSid: string) {
  return {
    AccountSid: 'ACtest00000000000000000000000000',
    CallSid: callSid,
    CallStatus: 'ringing',
    From: CALLER,
    To: QUEUE_NUMBER,
    Direction: 'inbound',
    ApiVersion: '2010-04-01',
  };
}

async function callBySid(sid: string) {
  return (
    await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.providerCallId, sid))
  )[0]!;
}

/** Pin a driven call's clock so wait math is exact (read-side test only). */
async function pinTimestamps(
  sid: string,
  stamps: { initiatedAt: string; answeredAt?: string; endedAt?: string; status?: string },
) {
  await ctx.dbh.db
    .update(schema.calls)
    .set({
      initiatedAt: new Date(stamps.initiatedAt),
      answeredAt: stamps.answeredAt ? new Date(stamps.answeredAt) : undefined,
      endedAt: stamps.endedAt ? new Date(stamps.endedAt) : undefined,
      ...(stamps.status ? { status: stamps.status as 'completed' } : {}),
    })
    .where(eq(schema.calls.providerCallId, sid));
}

describe('queue metrics from journaled events', () => {
  it('offered / answered-from-queue / overflow, with exact waits', async () => {
    // ── Call 1: answered from the queue ──────────────────────────────────
    await setPresence(ctx.seed.repId, 'available');
    await setPresence(repBId, 'available');
    await ctx.dbh.db.execute(sql`UPDATE agent_presence SET last_rung_at = NULL, last_call_ended_at = NULL`);

    const rung = await webhookPost(ctx, '/twiml/inbound', inbound('CA_qrep_answered'));
    expect(rung.statusCode).toBe(200);
    expect(rung.body).toContain('/twiml/queue-wait');

    const call1 = await callBySid('CA_qrep_answered');
    // The rung member answers in the browser; the caller leg later completes.
    await webhookPost(
      ctx,
      `/webhooks/telnyx/voice-status?call=${call1.id}&leg=client`,
      voiceStatus({
        callSid: 'CA_qrep_answered_client', status: 'in-progress', sequence: 0,
        parentCallSid: 'CA_qrep_answered', direction: 'inbound', to: await repAddress(ctx, repBId),
      }),
    );
    await webhookPost(
      ctx,
      '/webhooks/telnyx/voice-status',
      voiceStatus({
        callSid: 'CA_qrep_answered', status: 'completed', sequence: 1, duration: 100,
        direction: 'inbound', from: CALLER, to: QUEUE_NUMBER,
      }),
    );
    await ctx.runner.drain();
    const answered = await callBySid('CA_qrep_answered');
    expect(answered.status).toBe('completed');
    expect(answered.answeredAt).not.toBeNull();
    expect((answered.raw as { queueId?: string }).queueId).toBe(queueId);

    // Pin the clock: entered 15:00:00Z, answered 40s later, ended at +100s.
    await pinTimestamps('CA_qrep_answered', {
      initiatedAt: '2026-08-20T15:00:00Z',
      answeredAt: '2026-08-20T15:00:40Z',
      endedAt: '2026-08-20T15:01:40Z',
    });

    // ── Call 2: nobody available → hold → overflow after max wait ────────
    await ctx.dbh.db.execute(sql`UPDATE agent_presence SET status = 'offline'`);
    const hold = await webhookPost(ctx, '/twiml/inbound', inbound('CA_qrep_overflow'));
    expect(hold.body).toContain('Please hold.');
    const call2 = await callBySid('CA_qrep_overflow');

    const longAgo = Math.floor(Date.now() / 1000) - 600;
    const overflow = await webhookPost(
      ctx,
      `/twiml/queue-wait?call=${call2.id}&started=${longAgo}&n=3`,
      { AccountSid: 'ACtest00000000000000000000000000', CallSid: 'CA_qrep_overflow', CallStatus: 'in-progress' },
    );
    expect(overflow.body).toContain('<Record'); // overflowed to voicemail
    await ctx.runner.drain();
    await pinTimestamps('CA_qrep_overflow', {
      initiatedAt: '2026-08-21T15:00:00Z',
      endedAt: '2026-08-21T15:12:00Z',
      status: 'completed',
    });

    // ── Call 3: offered, still holding (non-terminal, unanswered) ────────
    const holding = await webhookPost(ctx, '/twiml/inbound', inbound('CA_qrep_holding'));
    expect(holding.body).toContain('Please hold.');
    await ctx.runner.drain();
    await pinTimestamps('CA_qrep_holding', { initiatedAt: '2026-08-22T15:00:00Z' });

    // ── The report ───────────────────────────────────────────────────────
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/reports/queues?from=${FROM}&to=${TO}`,
      headers: managerAuth,
    });
    expect(res.statusCode).toBe(200);
    const queues = (res.json() as {
      queues: Array<{
        queue_id: string; name: string; strategy: string;
        offered: number; answered: number; overflowed: number;
        avg_wait_to_answer_seconds: number | null;
        avg_wait_to_overflow_seconds: number | null;
      }>;
    }).queues;
    expect(queues).toHaveLength(1);
    const q = queues[0]!;
    expect(q.queue_id).toBe(queueId);
    expect(q.name).toBe('Acquisitions');
    expect(q.strategy).toBe('round_robin');
    expect(q.offered).toBe(3);
    expect(q.answered).toBe(1);
    expect(q.overflowed).toBe(1);
    expect(q.avg_wait_to_answer_seconds).toBeCloseTo(40, 5);
    // Overflow wait comes from the journaled elapsedSeconds the wait loop
    // computed against real wall-clock time — assert the ~600s window.
    expect(q.avg_wait_to_overflow_seconds).toBeGreaterThanOrEqual(598);
    expect(q.avg_wait_to_overflow_seconds).toBeLessThanOrEqual(615);

    // The overflow is journaled (fairness/reconstructability contract).
    const events = await ctx.dbh.db
      .select()
      .from(schema.callEvents)
      .where(eq(schema.callEvents.callId, call2.id));
    const overflowEvent = events.find((e) => e.eventType === 'call.queue_overflow');
    expect(overflowEvent).toBeTruthy();
    expect((overflowEvent!.payload as { queueId: string }).queueId).toBe(queueId);
  });

  it('a range that excludes the calls reports zeros, not stale numbers', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/reports/queues?from=2026-07-01&to=2026-07-07',
      headers: managerAuth,
    });
    const q = (res.json() as { queues: Array<{ offered: number; answered: number; overflowed: number; avg_wait_to_answer_seconds: number | null }> }).queues[0]!;
    expect(q.offered).toBe(0);
    expect(q.answered).toBe(0);
    expect(q.overflowed).toBe(0);
    expect(q.avg_wait_to_answer_seconds).toBeNull();
  });
});
