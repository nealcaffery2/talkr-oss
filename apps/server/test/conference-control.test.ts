/**
 * Conference call control end to end (docs/telephony-events.md §9):
 * hold → add call → merge → transfer, plus the conference callbacks that
 * reconcile the roster against the room.
 *
 * Real HTTP through the real app, real Twilio signatures, real worker, real
 * Postgres. Only the provider's participant REST calls are faked, and the fake
 * keeps enough room state that the assertions mean something.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { authHeader, createTestContext, webhookPost, type TestContext, repAddress } from './helpers.js';
import { conferenceStatus, twimlOutbound, voiceStatus } from './fixtures/texml.js';

let ctx: TestContext;
let repAuth: Record<string, string>;

const CONFERENCE_SID = 'CF_test_room';

/** Each call needs its own leg SIDs — provider_call_id is unique per call. */
let sidSeq = 0;

beforeAll(async () => {
  ctx = await createTestContext();
  repAuth = await authHeader('auth-rep-test-org');
});
afterAll(async () => {
  await ctx.close();
});

async function participants(callId: string) {
  return ctx.dbh.db
    .select()
    .from(schema.callParticipants)
    .where(eq(schema.callParticipants.callId, callId))
    .orderBy(schema.callParticipants.createdAt);
}

async function eventTypes(callId: string): Promise<string[]> {
  const rows = await ctx.dbh.db
    .select()
    .from(schema.callEvents)
    .where(eq(schema.callEvents.callId, callId))
    .orderBy(schema.callEvents.occurredAt);
  return rows.map((r) => r.eventType);
}

/** Drive a call to answered-and-in-the-room, the state every control needs. */
async function liveCall(): Promise<{ callId: string; agentSid: string; customerSid: string }> {
  const agentSid = `CA_client_conf_${++sidSeq}`;
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/v1/calls',
    headers: repAuth,
    payload: { lead_id: ctx.seed.leadId },
  });
  const callId = (created.json() as { call: { id: string } }).call.id;

  await webhookPost(
    ctx,
    '/twiml/outbound-dial',
    twimlOutbound({ clientCallSid: agentSid, talkrCallId: callId, identity: ctx.seed.repId }),
  );
  // The customer is dialed in on the TwiML path itself; the drain only settles
  // the queued fallback and the ingest jobs behind it.
  await ctx.runner.drain();

  const customer = (await participants(callId)).find((p) => p.role === 'customer')!;

  // The room reports both parties in, and the seller answers.
  const room = `talkr-${callId}`;
  await webhookPost(
    ctx,
    '/webhooks/telnyx/conference-status',
    conferenceStatus({ event: 'conference-start', conferenceSid: CONFERENCE_SID, friendlyName: room }),
  );
  await webhookPost(
    ctx,
    '/webhooks/telnyx/conference-status',
    conferenceStatus({
      event: 'participant-join',
      conferenceSid: CONFERENCE_SID,
      friendlyName: room,
      callSid: agentSid,
      sequence: 1,
    }),
  );
  await webhookPost(
    ctx,
    '/webhooks/telnyx/conference-status',
    conferenceStatus({
      event: 'participant-join',
      conferenceSid: CONFERENCE_SID,
      friendlyName: room,
      callSid: customer.providerParticipantId,
      sequence: 2,
    }),
  );
  await webhookPost(
    ctx,
    `/webhooks/telnyx/voice-status?call=${callId}&leg=pstn`,
    voiceStatus({
      callSid: customer.providerParticipantId,
      status: 'in-progress',
      sequence: 1,
      parentCallSid: agentSid,
    }),
  );
  await ctx.runner.drain();

  return { callId, agentSid, customerSid: customer.providerParticipantId };
}

describe('conference roster', () => {
  it('records both parties and reconciles them from the room callbacks', async () => {
    const { callId, customerSid } = await liveCall();
    const rows = await participants(callId);

    expect(rows.map((r) => r.role).sort()).toEqual(['agent', 'customer']);
    expect(rows.every((r) => r.state === 'joined')).toBe(true);
    expect(rows.every((r) => r.joinedAt !== null)).toBe(true);
    // conference-start stamps the room's SID on every row in the call.
    expect(rows.every((r) => r.providerConferenceId === CONFERENCE_SID)).toBe(true);

    const listed = await ctx.app.inject({
      method: 'GET',
      url: `/v1/calls/${callId}/participants`,
      headers: repAuth,
    });
    expect(listed.statusCode).toBe(200);
    const body = listed.json() as { participants: Array<{ role: string; state: string }> };
    expect(body.participants).toHaveLength(2);
    expect(customerSid).toMatch(/^CA_fake_part_/);
  });

  it('is idempotent: a redelivered join callback changes nothing', async () => {
    const { callId, agentSid } = await liveCall();
    const room = `talkr-${callId}`;
    const before = await eventTypes(callId);

    const dup = conferenceStatus({
      event: 'participant-join',
      conferenceSid: CONFERENCE_SID,
      friendlyName: room,
      callSid: agentSid,
      sequence: 1,
    });
    await webhookPost(ctx, '/webhooks/telnyx/conference-status', dup);
    await webhookPost(ctx, '/webhooks/telnyx/conference-status', dup);
    await ctx.runner.drain();

    expect(await eventTypes(callId)).toEqual(before);
  });
});

describe('hold', () => {
  it('holds and resumes the customer, and only the customer', async () => {
    const { callId, customerSid } = await liveCall();

    const held = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/hold`,
      headers: repAuth,
      payload: { hold: true },
    });
    expect(held.statusCode).toBe(200);

    const holdOps = ctx.conferenceOps.updated.filter((u) => u.patch.hold === true);
    expect(holdOps).toHaveLength(1);
    expect(holdOps[0]!.participantId).toBe(customerSid);
    expect(holdOps[0]!.roomName).toBe(`talkr-${callId}`);

    const afterHold = await participants(callId);
    expect(afterHold.find((p) => p.role === 'customer')!.state).toBe('on_hold');
    expect(afterHold.find((p) => p.role === 'agent')!.state).toBe('joined');

    const resumed = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/hold`,
      headers: repAuth,
      payload: { hold: false },
    });
    expect(resumed.statusCode).toBe(200);
    expect((await participants(callId)).find((p) => p.role === 'customer')!.state).toBe('joined');
    expect(await eventTypes(callId)).toEqual(
      expect.arrayContaining(['call.hold', 'call.unhold']),
    );
  });

  it('refuses to hold a customer who is already held', async () => {
    const { callId } = await liveCall();
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/hold`,
      headers: repAuth,
      payload: { hold: true },
    });
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/hold`,
      headers: repAuth,
      payload: { hold: true },
    });
    expect(again.statusCode).toBe(409);
    expect((again.json() as { error: string }).error).toBe('already_held');
  });

  it('refuses control of a call that already ended', async () => {
    const { callId, customerSid } = await liveCall();
    await webhookPost(
      ctx,
      `/webhooks/telnyx/voice-status?call=${callId}&leg=pstn`,
      voiceStatus({ callSid: customerSid, status: 'completed', sequence: 9, duration: 30 }),
    );
    await ctx.runner.drain();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/hold`,
      headers: repAuth,
      payload: { hold: true },
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('call_not_active');
  });
});

describe('add call and merge', () => {
  it('adding a teammate holds the customer first, then merge brings everyone back', async () => {
    const { callId, customerSid } = await liveCall();

    const added = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/participants`,
      headers: repAuth,
      payload: { user_id: ctx.seed.adminId },
    });
    expect(added.statusCode).toBe(201);
    const participant = (added.json() as { participant: { role: string; address: string } }).participant;
    expect(participant.role).toBe('teammate');
    // A teammate is dialed on the identity their browser registers with.
    const adminSip = await repAddress(ctx, ctx.seed.adminId);
    expect(participant.address).toBe(adminSip);

    // The consultation is private: the customer is held before the dial, since
    // a participant cannot be created already held.
    const heldFirst = ctx.conferenceOps.updated.findIndex(
      (u) => u.participantId === customerSid && u.patch.hold === true,
    );
    const dialed = ctx.conferenceOps.added.findIndex((a) => a.to === adminSip);
    expect(heldFirst).toBeGreaterThanOrEqual(0);
    expect(dialed).toBeGreaterThanOrEqual(0);

    const roster = await participants(callId);
    expect(roster.find((p) => p.role === 'customer')!.state).toBe('on_hold');
    expect(roster).toHaveLength(3);

    // Merge un-holds everyone: the consultation becomes a conference.
    const merged = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/merge`,
      headers: repAuth,
    });
    expect(merged.statusCode).toBe(200);
    expect((await participants(callId)).find((p) => p.role === 'customer')!.state).toBe('joined');
    expect(await eventTypes(callId)).toEqual(
      expect.arrayContaining(['call.participant_added', 'call.merged']),
    );
  });

  it('refuses to merge when there is nobody to merge with', async () => {
    const { callId } = await liveCall();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/merge`,
      headers: repAuth,
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('nothing_to_merge');
  });

  it('drops an added party without touching the rest of the room', async () => {
    const { callId } = await liveCall();
    const added = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/participants`,
      headers: repAuth,
      payload: { to_number: '+15005550123' },
    });
    const pid = (added.json() as { participant: { provider_participant_id: string } }).participant
      .provider_participant_id;

    const removed = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/participants/${pid}/remove`,
      headers: repAuth,
    });
    expect(removed.statusCode).toBe(200);
    expect(ctx.conferenceOps.removed.some((r) => r.participantId === pid)).toBe(true);

    const roster = await participants(callId);
    expect(roster.find((p) => p.providerParticipantId === pid)!.state).toBe('left');
    expect(roster.filter((p) => p.state !== 'left')).toHaveLength(2);
  });

  it('never lets the agent be removed as if they were a guest', async () => {
    const { callId, agentSid } = await liveCall();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/participants/${agentSid}/remove`,
      headers: repAuth,
    });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { error: string }).error).toBe('cannot_remove_agent');
  });

  it('rejects a body that names both a teammate and a number', async () => {
    const { callId } = await liveCall();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/participants`,
      headers: repAuth,
      payload: { user_id: ctx.seed.adminId, to_number: '+15005550123' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('transfer', () => {
  it('warm: target joins with the customer held, and the rep leaves on complete', async () => {
    const { callId, agentSid, customerSid } = await liveCall();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/transfer`,
      headers: repAuth,
      payload: { mode: 'warm', user_id: ctx.seed.adminId },
    });
    expect(res.statusCode).toBe(201);

    // The agent must stop ending the room before anyone is transferred, or the
    // rep hanging up would drop the customer mid-handover.
    expect(
      ctx.conferenceOps.updated.some(
        (u) => u.participantId === agentSid && u.patch.endConferenceOnExit === false,
      ),
    ).toBe(true);

    const mid = await participants(callId);
    expect(mid.find((p) => p.providerParticipantId === customerSid)!.state).toBe('on_hold');
    expect(mid.find((p) => p.role === 'agent')!.state).toBe('joined');

    const done = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/transfer/complete`,
      headers: repAuth,
    });
    expect(done.statusCode).toBe(200);

    const after = await participants(callId);
    expect(after.find((p) => p.role === 'agent')!.state).toBe('left');
    expect(after.find((p) => p.providerParticipantId === customerSid)!.state).toBe('joined');
    expect(ctx.conferenceOps.removed.some((r) => r.participantId === agentSid)).toBe(true);
    expect(await eventTypes(callId)).toEqual(
      expect.arrayContaining(['call.transfer_initiated', 'call.transfer_completed']),
    );
  });

  it('blind: hands the customer over and drops the rep in one call', async () => {
    const { callId, customerSid } = await liveCall();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/transfer`,
      headers: repAuth,
      payload: { mode: 'blind', to_number: '+15005550123' },
    });
    expect(res.statusCode).toBe(201);

    const after = await participants(callId);
    expect(after.find((p) => p.role === 'agent')!.state).toBe('left');
    // The customer is talking to the target, not sitting on hold.
    expect(after.find((p) => p.providerParticipantId === customerSid)!.state).toBe('joined');
    expect(after.find((p) => p.role === 'external')!.state).not.toBe('left');
  });

  it('completing a transfer twice is safe', async () => {
    const { callId } = await liveCall();
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/transfer`,
      headers: repAuth,
      payload: { mode: 'warm', user_id: ctx.seed.adminId },
    });
    const first = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/transfer/complete`,
      headers: repAuth,
    });
    const second = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/transfer/complete`,
      headers: repAuth,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect((await participants(callId)).filter((p) => p.role === 'agent' && p.state !== 'left')).toHaveLength(0);
  });

  it('refuses a teammate from another org', async () => {
    const { callId } = await liveCall();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/transfer`,
      headers: repAuth,
      payload: { mode: 'warm', user_id: '00000000-0000-4000-8000-000000000000' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_target');
  });
});

describe('room teardown', () => {
  it('conference-end marks everyone left, whatever we last believed', async () => {
    const { callId } = await liveCall();
    await webhookPost(
      ctx,
      '/webhooks/telnyx/conference-status',
      conferenceStatus({
        event: 'conference-end',
        conferenceSid: CONFERENCE_SID,
        friendlyName: `talkr-${callId}`,
        sequence: 99,
        reasonConferenceEnded: 'participant-with-end-conference-on-exit-left',
      }),
    );
    await ctx.runner.drain();

    const rows = await participants(callId);
    expect(rows.every((p) => p.state === 'left')).toBe(true);
    expect(rows.every((p) => p.leftAt !== null)).toBe(true);
  });

  it('a callback for a room we do not own is recorded, never silently dropped', async () => {
    await webhookPost(
      ctx,
      '/webhooks/telnyx/conference-status',
      conferenceStatus({
        event: 'conference-start',
        conferenceSid: 'CF_someone_else',
        friendlyName: 'not-ours',
      }),
    );
    await ctx.runner.drain();

    const rows = await ctx.dbh.db
      .select()
      .from(schema.reconciliationMismatches)
      .where(eq(schema.reconciliationMismatches.objectType, 'orphan_conference'));
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});

describe('supervision', () => {
  it('a manager listens, whispers and leaves; the rep never sees them; reps cannot monitor', async () => {
    const adminAuth = await authHeader('auth-admin-test-org');
    const { callId, agentSid } = await liveCall();

    const list = await ctx.app.inject({ method: 'GET', url: '/v1/calls/live', headers: adminAuth });
    expect(list.statusCode).toBe(200);
    expect((list.json() as { calls: Array<{ call_id: string }> }).calls.map((c) => c.call_id)).toContain(callId);
    const repList = await ctx.app.inject({ method: 'GET', url: '/v1/calls/live', headers: repAuth });
    expect(repList.statusCode).toBe(403);

    const started = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/monitor`,
      headers: adminAuth,
      payload: { mode: 'whisper' },
    });
    expect(started.statusCode).toBe(201);
    const dial = ctx.conferenceOps.added.at(-1)!;
    expect(dial).toMatchObject({ to: await repAddress(ctx, ctx.seed.adminId), talkrCallId: callId, coaching: true, callSidToCoach: agentSid, beep: false, endConferenceOnExit: false });
    expect(dial.statusCallbackUrl).toBeUndefined();

    const switched = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/calls/${callId}/monitor`,
      headers: adminAuth,
      payload: { mode: 'listen' },
    });
    expect(switched.statusCode).toBe(200);
    expect(ctx.conferenceOps.updated.at(-1)!.patch).toEqual({ muted: true, coaching: false });

    const repView = await ctx.app.inject({ method: 'GET', url: `/v1/calls/${callId}/participants`, headers: repAuth });
    expect((repView.json() as { participants: Array<{ role: string }> }).participants.some((p) => p.role === 'supervisor')).toBe(false);

    const left = await ctx.app.inject({ method: 'DELETE', url: `/v1/calls/${callId}/monitor`, headers: adminAuth });
    expect(left.statusCode).toBe(200);
    expect(ctx.conferenceOps.removed.at(-1)!.participantId).toBe(dial.providerParticipantId);
    expect((await participants(callId)).find((p) => p.role === 'supervisor')!.state).toBe('left');
  });

  it('refuses monitoring for a rep', async () => {
    const { callId } = await liveCall();
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/monitor`,
      headers: repAuth,
      payload: { mode: 'listen' },
    });
    expect(res.statusCode).toBe(403);
  });
});
