/**
 * Phase 3 completion: queues (strategies, hold-wait loop, overflow) and IVR
 * digit menus, end to end through real HTTP + Postgres.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { createTestContext, webhookPost, type TestContext, rungUsers, repAddress } from './helpers.js';
import { provisionBrowserCredentials } from '../src/services/provision.js';
import { voiceStatus } from './fixtures/texml.js';

let ctx: TestContext;
let repBId: string;
let queueId: string;
const QUEUE_NUMBER = '+15005550010';
const IVR_NUMBER = '+15005550011';
const CALLER = '+16145550042'; // unknown caller — no lead-owner shortcut

beforeAll(async () => {
  ctx = await createTestContext();
  const { db } = ctx.dbh;

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
        waitMessage: 'Please hold for the next acquisitions specialist.',
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
    providerNumberId: 'PN_queue',
    queueId,
  });
  await db.insert(schema.phoneNumbers).values({
    orgId: ctx.seed.orgId,
    phoneE164: IVR_NUMBER,
    providerNumberId: 'PN_ivr',
    ivr: {
      greeting: 'Thanks for calling Your Company. Press 1 for acquisitions, 2 for your representative.',
      options: {
        '1': { type: 'queue', queueId },
        '2': { type: 'user', userId: ctx.seed.repId },
      },
    },
  });
});
afterAll(async () => {
  await ctx.close();
});

async function setPresence(userId: string, status: string, lastSeenAt = new Date()) {
  await ctx.dbh.db
    .insert(schema.agentPresence)
    .values({ userId, orgId: ctx.seed.orgId, status, lastSeenAt })
    .onConflictDoUpdate({
      target: schema.agentPresence.userId,
      set: { status, lastSeenAt },
    });
}

function inbound(callSid: string, to: string) {
  return {
    AccountSid: 'ACtest00000000000000000000000000',
    CallSid: callSid,
    CallStatus: 'ringing',
    From: CALLER,
    To: to,
    Direction: 'inbound',
    ApiVersion: '2010-04-01',
  };
}

async function clientIn(body: string): Promise<string | null> {
  return (await rungUsers(ctx, body))[0] ?? null;
}

describe('queue round-robin rotation', () => {
  it('rings one member, stamps fairness, and rotates on the next call', async () => {
    await setPresence(ctx.seed.repId, 'available');
    await setPresence(repBId, 'available');
    await ctx.dbh.db.execute(sql`UPDATE agent_presence SET last_rung_at = NULL, last_call_ended_at = NULL`);

    const first = await webhookPost(ctx, '/twiml/inbound', inbound('CA_q_rr1', QUEUE_NUMBER));
    expect(first.statusCode).toBe(200);
    const firstTarget = await clientIn(first.body);
    expect([ctx.seed.repId, repBId]).toContain(firstTarget);
    expect(first.body).toMatch(/voice-status\?call=[0-9a-f-]{36}&amp;leg=client/); // the rep leg's callbacks carry our call id
    expect(first.body).toContain('/twiml/queue-wait'); // ring outcome returns to the loop

    const rungRows = await ctx.dbh.db
      .select()
      .from(schema.agentPresence)
      .where(eq(schema.agentPresence.userId, firstTarget!));
    expect(rungRows[0]!.lastRungAt).not.toBeNull();

    const second = await webhookPost(ctx, '/twiml/inbound', inbound('CA_q_rr2', QUEUE_NUMBER));
    const secondTarget = await clientIn(second.body);
    expect(secondTarget).not.toBe(firstTarget); // rotation

    const call = (
      await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.providerCallId, 'CA_q_rr1'))
    )[0]!;
    expect((call.raw as { routing: { action: string } }).routing.action).toBe('queue');
    expect((call.raw as { queueId?: string }).queueId).toBe(queueId);
    const events = await ctx.dbh.db
      .select()
      .from(schema.callEvents)
      .where(eq(schema.callEvents.callId, call.id));
    expect(events.some((e) => e.eventType === 'call.queue_ring')).toBe(true);
  });
});

describe('queue hold-wait loop and overflow', () => {
  it('holds when nobody is available and rings when someone appears', async () => {
    await ctx.dbh.db.execute(sql`UPDATE agent_presence SET status = 'offline'`);
    const res = await webhookPost(ctx, '/twiml/inbound', inbound('CA_q_hold', QUEUE_NUMBER));
    expect(res.body).toContain('Please hold for the next acquisitions specialist.');
    expect(res.body).toContain('<Pause');
    expect(res.body).toMatch(/<Redirect[^>]*>[^<]*\/twiml\/queue-wait\?call=[^&]+&amp;started=\d+&amp;n=1/);

    const call = (
      await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.providerCallId, 'CA_q_hold'))
    )[0]!;
    const started = Math.floor(Date.now() / 1000);

    // Next cycle, still nobody: hold again with n bumped.
    const cycle1 = await webhookPost(
      ctx,
      `/twiml/queue-wait?call=${call.id}&started=${started}&n=1`,
      { AccountSid: 'ACtest00000000000000000000000000', CallSid: 'CA_q_hold', CallStatus: 'in-progress' },
    );
    expect(cycle1.body).toContain('&amp;n=2');
    expect(cycle1.body).toContain('Please hold');

    // A rep comes online: the next cycle rings them.
    await setPresence(repBId, 'available');
    const cycle2 = await webhookPost(
      ctx,
      `/twiml/queue-wait?call=${call.id}&started=${started}&n=2`,
      { AccountSid: 'ACtest00000000000000000000000000', CallSid: 'CA_q_hold', CallStatus: 'in-progress' },
    );
    expect(await clientIn(cycle2.body)).toBe(repBId);
    expect(cycle2.body).toContain('&amp;n=3'); // dial outcome returns to the loop
  });

  it('overflows to voicemail after max wait, journaled', async () => {
    await ctx.dbh.db.execute(sql`UPDATE agent_presence SET status = 'offline'`);
    const res = await webhookPost(ctx, '/twiml/inbound', inbound('CA_q_over', QUEUE_NUMBER));
    expect(res.body).toContain('Please hold');
    const call = (
      await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.providerCallId, 'CA_q_over'))
    )[0]!;

    const longAgo = Math.floor(Date.now() / 1000) - 600;
    const overflow = await webhookPost(
      ctx,
      `/twiml/queue-wait?call=${call.id}&started=${longAgo}&n=5`,
      { AccountSid: 'ACtest00000000000000000000000000', CallSid: 'CA_q_over', CallStatus: 'in-progress' },
    );
    expect(overflow.body).toContain('<Record');

    const events = await ctx.dbh.db
      .select()
      .from(schema.callEvents)
      .where(eq(schema.callEvents.callId, call.id));
    expect(events.some((e) => e.eventType === 'call.queue_overflow')).toBe(true);
    const fresh = (
      await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.id, call.id))
    )[0]!;
    expect((fresh.raw as { voicemailReason?: string }).voicemailReason).toBe('queue_overflow');
  });

  it('a queue member answering the ring becomes the call owner and feeds longest_idle', async () => {
    await setPresence(repBId, 'available');
    await webhookPost(ctx, '/twiml/inbound', inbound('CA_q_ans', QUEUE_NUMBER));
    const call = (
      await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.providerCallId, 'CA_q_ans'))
    )[0]!;
    expect(call.userId).toBeNull(); // multi-member queue: unknown until pickup

    await webhookPost(ctx, `/webhooks/telnyx/voice-status?call=${call.id}&leg=client`, voiceStatus({
      callSid: 'CA_q_ans_client', status: 'in-progress', sequence: 0,
      parentCallSid: 'CA_q_ans', direction: 'inbound', to: await repAddress(ctx, repBId),
    }));
    await webhookPost(ctx, '/webhooks/telnyx/voice-status', voiceStatus({
      callSid: 'CA_q_ans', status: 'completed', sequence: 1, duration: 40,
      direction: 'inbound', from: CALLER, to: QUEUE_NUMBER,
    }));
    await ctx.runner.drain();

    const fresh = (
      await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.id, call.id))
    )[0]!;
    expect(fresh.status).toBe('completed');
    expect(fresh.userId).toBe(repBId); // answering rep owns the call
    const presence = (
      await ctx.dbh.db
        .select()
        .from(schema.agentPresence)
        .where(eq(schema.agentPresence.userId, repBId))
    )[0]!;
    expect(presence.lastCallEndedAt).not.toBeNull();
  });
});

describe('IVR digit menu', () => {
  it('offers the menu with the configured greeting', async () => {
    const res = await webhookPost(ctx, '/twiml/inbound', inbound('CA_ivr_1', IVR_NUMBER));
    expect(res.body).toContain('<Gather');
    expect(res.body).toContain('Press 1 for acquisitions');
    expect(res.body).toContain('/twiml/ivr-select');

    const call = (
      await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.providerCallId, 'CA_ivr_1'))
    )[0]!;
    const events = await ctx.dbh.db
      .select()
      .from(schema.callEvents)
      .where(eq(schema.callEvents.callId, call.id));
    expect(events.some((e) => e.eventType === 'call.ivr_offered')).toBe(true);
  });

  it('digit 1 enters the queue; digit 2 rings the mapped rep', async () => {
    await setPresence(ctx.seed.repId, 'available');
    await setPresence(repBId, 'available');

    const call1 = (
      await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.providerCallId, 'CA_ivr_1'))
    )[0]!;
    const toQueue = await webhookPost(ctx, `/twiml/ivr-select?call=${call1.id}`, {
      AccountSid: 'ACtest00000000000000000000000000',
      CallSid: 'CA_ivr_1',
      CallStatus: 'in-progress',
      Digits: '1',
    });
    expect(toQueue.body).toContain('<Sip'); // queue had someone available
    expect(toQueue.body).toContain('/twiml/queue-wait');

    await webhookPost(ctx, '/twiml/inbound', inbound('CA_ivr_2', IVR_NUMBER));
    const call2 = (
      await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.providerCallId, 'CA_ivr_2'))
    )[0]!;
    const toUser = await webhookPost(ctx, `/twiml/ivr-select?call=${call2.id}`, {
      AccountSid: 'ACtest00000000000000000000000000',
      CallSid: 'CA_ivr_2',
      CallStatus: 'in-progress',
      Digits: '2',
    });
    expect(await clientIn(toUser.body)).toBe(ctx.seed.repId);

    const events = await ctx.dbh.db
      .select()
      .from(schema.callEvents)
      .where(eq(schema.callEvents.callId, call2.id));
    const selected = events.find((e) => e.eventType === 'call.ivr_selected');
    expect(selected).toBeTruthy();
    expect((selected!.payload as { digits: string }).digits).toBe('2');
  });

  it('unknown digits and gather timeouts fall to voicemail, never a dropped call', async () => {
    await webhookPost(ctx, '/twiml/inbound', inbound('CA_ivr_3', IVR_NUMBER));
    const call = (
      await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.providerCallId, 'CA_ivr_3'))
    )[0]!;
    const unknown = await webhookPost(ctx, `/twiml/ivr-select?call=${call.id}`, {
      AccountSid: 'ACtest00000000000000000000000000',
      CallSid: 'CA_ivr_3',
      CallStatus: 'in-progress',
      Digits: '9',
    });
    expect(unknown.body).toContain('<Record');

    await webhookPost(ctx, '/twiml/inbound', inbound('CA_ivr_4', IVR_NUMBER));
    const call4 = (
      await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.providerCallId, 'CA_ivr_4'))
    )[0]!;
    const timeout = await webhookPost(ctx, `/twiml/ivr-select?call=${call4.id}`, {
      AccountSid: 'ACtest00000000000000000000000000',
      CallSid: 'CA_ivr_4',
      CallStatus: 'in-progress',
      // no Digits — Gather timed out
    });
    expect(timeout.body).toContain('<Record');
    const fresh = (
      await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.id, call4.id))
    )[0]!;
    expect((fresh.raw as { voicemailReason?: string }).voicemailReason).toBe('ivr_timeout');
  });
});
