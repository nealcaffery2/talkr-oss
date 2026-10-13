/**
 * Phase 3 inbound routing, end to end through real HTTP + worker + Postgres
 * (docs/inbound-routing.md §8): recognized-caller routing, presence, business
 * hours, ring-timeout → voicemail, voicemail recording, forward, and the
 * "which leg drives" rules.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { authHeader, createTestContext, webhookPost, type TestContext, repAddress } from './helpers.js';
import { recordingStatus, voiceStatus } from './fixtures/texml.js';

let ctx: TestContext;
let repAuth: Record<string, string>;
const PLATFORM_NUMBER = '+15005550006';
const SELLER = '+15005550009'; // seeded contact phone, linked to the seeded lead
const STRANGER = '+16145550001';

beforeAll(async () => {
  ctx = await createTestContext();
  repAuth = await authHeader('auth-rep-test-org');
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

async function setOrgSettings(settings: Record<string, unknown>) {
  await ctx.dbh.db
    .update(schema.organizations)
    .set({ settings })
    .where(eq(schema.organizations.id, ctx.seed.orgId));
}

function inboundParams(callSid: string, from = SELLER) {
  return {
    AccountSid: 'ACtest00000000000000000000000000',
    CallSid: callSid,
    CallStatus: 'ringing',
    From: from,
    To: PLATFORM_NUMBER,
    Direction: 'inbound',
    ApiVersion: '2010-04-01',
  };
}

async function getCallBySid(sid: string) {
  return (
    await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.providerCallId, sid))
  )[0]!;
}

beforeEach(async () => {
  await setOrgSettings({});
});

describe('recognized seller rings the lead owner', () => {
  it('routes to the assigned rep with full CRM linkage and journals the decision', async () => {
    await setPresence(ctx.seed.repId, 'available');
    const res = await webhookPost(ctx, '/twiml/inbound', inboundParams('CA_in_owner'));
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Sip');
    expect(res.body).toContain(await repAddress(ctx, ctx.seed.repId));
    expect(res.body).toMatch(/voice-status\?call=[0-9a-f-]{36}&amp;leg=client/); // the rep leg's callbacks carry our call id
    expect(res.body).toContain('answerOnBridge="true"');
    expect(res.body).toContain('record-from-answer-dual');

    const call = await getCallBySid('CA_in_owner');
    expect(call.direction).toBe('inbound');
    expect(call.contactId).toBe(ctx.seed.contactId);
    expect(call.leadId).toBe(ctx.seed.leadId);
    expect(call.userId).toBe(ctx.seed.repId);
    expect((call.raw as { routing: { reason: string } }).routing.reason).toBe('lead_owner');

    const events = await ctx.dbh.db
      .select()
      .from(schema.callEvents)
      .where(eq(schema.callEvents.callId, call.id));
    expect(events.some((e) => e.eventType === 'call.routing_decided')).toBe(true);
  });

  it('a Twilio retry of the inbound webhook stays idempotent', async () => {
    await setPresence(ctx.seed.repId, 'available');
    await webhookPost(ctx, '/twiml/inbound', inboundParams('CA_in_retry'));
    const second = await webhookPost(ctx, '/twiml/inbound', inboundParams('CA_in_retry'));
    expect(second.statusCode).toBe(200);
    expect(second.body).toContain('<Sip'); // retry still gets working TwiML

    const calls = await ctx.dbh.db
      .select()
      .from(schema.calls)
      .where(eq(schema.calls.providerCallId, 'CA_in_retry'));
    expect(calls).toHaveLength(1);
    const routingEvents = await ctx.dbh.db
      .select()
      .from(schema.callEvents)
      .where(eq(schema.callEvents.callId, calls[0]!.id));
    expect(routingEvents.filter((e) => e.eventType === 'call.routing_decided')).toHaveLength(1);
  });

  it('the answering browser can find the ringing call by the caller number', async () => {
    await setPresence(ctx.seed.repId, 'available');
    await webhookPost(ctx, '/twiml/inbound', inboundParams('CA_in_lookup'));
    const call = await getCallBySid('CA_in_lookup');
    // The Telnyx invite may present the number with or without +1.
    const found = await ctx.app.inject({ method: 'GET', url: `/v1/calls/ringing?from=${encodeURIComponent('1' + SELLER.slice(2))}`, headers: repAuth });
    expect(found.statusCode).toBe(200);
    expect(found.json().call.id).toBe(call.id);
    const none = await ctx.app.inject({ method: 'GET', url: '/v1/calls/ringing?from=%2B16145559999', headers: repAuth });
    expect(none.statusCode).toBe(404);
  });

  it('an unknown caller still rings the number assignee', async () => {
    await setPresence(ctx.seed.repId, 'available');
    const res = await webhookPost(ctx, '/twiml/inbound', inboundParams('CA_in_stranger', STRANGER));
    expect(res.body).toContain('<Sip');
    const call = await getCallBySid('CA_in_stranger');
    expect(call.contactId).toBeNull();
    expect((call.raw as { routing: { reason: string } }).routing.reason).toBe('number_assignee');
  });
});

describe('voicemail paths', () => {
  it('stale presence sends the caller to voicemail with the org greeting', async () => {
    await setOrgSettings({ voicemailGreeting: 'You reached Your Company after hours test greeting.' });
    await setPresence(ctx.seed.repId, 'available', new Date(Date.now() - 10 * 60_000)); // stale
    const res = await webhookPost(ctx, '/twiml/inbound', inboundParams('CA_in_vm'));
    expect(res.body).toContain('Your Company after hours test greeting');
    expect(res.body).toContain('<Record');
    expect(res.body).toContain('voicemail-complete');
    const call = await getCallBySid('CA_in_vm');
    expect((call.raw as { routing: { reason: string } }).routing.reason).toBe('no_agents');
    expect((call.raw as { voicemailOffered?: boolean }).voicemailOffered).toBe(true);
  });

  it('a configured closed schedule sends to voicemail even with reps available', async () => {
    await setOrgSettings({ timezone: 'America/New_York', businessHours: {} });
    await setPresence(ctx.seed.repId, 'available');
    const res = await webhookPost(ctx, '/twiml/inbound', inboundParams('CA_in_hours'));
    expect(res.body).toContain('<Record');
    const call = await getCallBySid('CA_in_hours');
    expect((call.raw as { routing: { reason: string } }).routing.reason).toBe('after_hours');
  });

  it('ring timeout falls to voicemail; the voicemail recording attaches to the call', async () => {
    await setPresence(ctx.seed.repId, 'available');
    await webhookPost(ctx, '/twiml/inbound', inboundParams('CA_in_timeout'));
    const call = await getCallBySid('CA_in_timeout');

    // <Dial> action fires with no-answer → caller hears voicemail.
    const dialDone = await webhookPost(ctx, `/twiml/inbound-dial-complete?call=${call.id}`, {
      AccountSid: 'ACtest00000000000000000000000000',
      CallSid: 'CA_in_timeout',
      CallStatus: 'in-progress',
      DialCallSid: 'CA_in_timeout_client',
      DialCallStatus: 'no-answer',
      Direction: 'inbound',
      ApiVersion: '2010-04-01',
    });
    expect(dialDone.body).toContain('<Record');

    // Caller records; Record's action confirms; recording arrives async.
    const vmDone = await webhookPost(ctx, `/twiml/voicemail-complete?call=${call.id}`, {
      AccountSid: 'ACtest00000000000000000000000000',
      CallSid: 'CA_in_timeout',
      RecordingSid: 'RE_vm_1',
      RecordingUrl: 'https://api.twilio.com/rec/RE_vm_1',
      RecordingDuration: '22',
      Digits: 'hangup',
    });
    expect(vmDone.body).toContain('Thank you');

    await webhookPost(
      ctx,
      `/webhooks/telnyx/recording-status?call=${call.id}`,
      { ...recordingStatus({ recordingSid: 'RE_vm_1', callSid: 'CA_in_timeout', status: 'completed', duration: 22, channels: 1 }), RecordingSource: 'RecordVerb' },
    );
    await ctx.runner.drain();

    const recs = await ctx.dbh.db
      .select()
      .from(schema.recordings)
      .where(eq(schema.recordings.callId, call.id));
    expect(recs).toHaveLength(1);
    expect(recs[0]!.status).toBe('completed');
    expect((recs[0]!.raw as { RecordingSource?: string }).RecordingSource).toBe('RecordVerb');

    const updated = await getCallBySid('CA_in_timeout');
    expect((updated.raw as { voicemailLeft?: boolean }).voicemailLeft).toBe(true);
  });
});

describe('which leg drives the inbound call', () => {
  it('a rep answering in the browser drives in_progress; the caller leg closes the call', async () => {
    await setPresence(ctx.seed.repId, 'available');
    await webhookPost(ctx, '/twiml/inbound', inboundParams('CA_in_answer'));
    const call = await getCallBySid('CA_in_answer');

    // Parent (caller) leg lifecycle callbacks resolve via provider_call_id.
    await webhookPost(ctx, '/webhooks/telnyx/voice-status', voiceStatus({
      callSid: 'CA_in_answer', status: 'ringing', sequence: 0, direction: 'inbound', from: SELLER, to: PLATFORM_NUMBER,
    }));
    // Client child leg answered — this is what "answered" means.
    await webhookPost(ctx, `/webhooks/telnyx/voice-status?call=${call.id}&leg=client`, voiceStatus({
      callSid: 'CA_in_answer_client', status: 'in-progress', sequence: 0, parentCallSid: 'CA_in_answer', direction: 'inbound',
    }));
    await ctx.runner.drain();

    let fresh = await getCallBySid('CA_in_answer');
    expect(fresh.status).toBe('in_progress');
    expect(fresh.answeredAt).not.toBeNull();

    // Caller hangs up: parent leg completed decides the terminal state.
    await webhookPost(ctx, '/webhooks/telnyx/voice-status', voiceStatus({
      callSid: 'CA_in_answer', status: 'completed', sequence: 1, duration: 63, direction: 'inbound', from: SELLER, to: PLATFORM_NUMBER,
    }));
    await ctx.runner.drain();
    fresh = await getCallBySid('CA_in_answer');
    expect(fresh.status).toBe('completed');
    expect(fresh.durationSeconds).toBe(63);
  });

  it("the caller leg's TwiML answer (voicemail) never counts as agent-answered", async () => {
    await setPresence(ctx.seed.repId, 'offline');
    await webhookPost(ctx, '/twiml/inbound', inboundParams('CA_in_vmleg'));
    const call = await getCallBySid('CA_in_vmleg');

    // Twilio marks the caller leg in-progress the moment <Say> executes.
    await webhookPost(ctx, '/webhooks/telnyx/voice-status', voiceStatus({
      callSid: 'CA_in_vmleg', status: 'in-progress', sequence: 0, direction: 'inbound', from: SELLER, to: PLATFORM_NUMBER,
    }));
    await ctx.runner.drain();
    let fresh = await getCallBySid('CA_in_vmleg');
    expect(fresh.status).not.toBe('in_progress'); // missed-call semantics hold
    expect(fresh.answeredAt).toBeNull();

    await webhookPost(ctx, '/webhooks/telnyx/voice-status', voiceStatus({
      callSid: 'CA_in_vmleg', status: 'completed', sequence: 1, duration: 30, direction: 'inbound', from: SELLER, to: PLATFORM_NUMBER,
    }));
    await ctx.runner.drain();
    fresh = await getCallBySid('CA_in_vmleg');
    expect(fresh.status).toBe('completed');
    expect(fresh.answeredAt).toBeNull(); // inbound ∧ never answered = missed
    expect(call.id).toBe(fresh.id);
  });
});

describe('presence API + forward + lookup', () => {
  it('the heartbeat endpoint flips routing behavior live', async () => {
    await ctx.dbh.db.execute(sql`DELETE FROM agent_presence`);
    const before = await webhookPost(ctx, '/twiml/inbound', inboundParams('CA_in_pres1', STRANGER));
    expect(before.body).toContain('<Record'); // nobody available → voicemail

    const hb = await ctx.app.inject({
      method: 'POST',
      url: '/v1/presence',
      headers: repAuth,
      payload: { status: 'available' },
    });
    expect(hb.statusCode).toBe(200);

    const after = await webhookPost(ctx, '/twiml/inbound', inboundParams('CA_in_pres2', STRANGER));
    expect(after.body).toContain('<Sip');
  });

  it('forwards to an external phone when configured and nobody is available', async () => {
    await ctx.dbh.db.execute(sql`DELETE FROM agent_presence`);
    await ctx.dbh.db
      .update(schema.phoneNumbers)
      .set({ forwardToE164: '+16145559999' })
      .where(eq(schema.phoneNumbers.id, ctx.seed.phoneNumberId));
    const res = await webhookPost(ctx, '/twiml/inbound', inboundParams('CA_in_fwd', STRANGER));
    expect(res.body).toContain('<Number');
    expect(res.body).toContain('+16145559999');
    await ctx.dbh.db
      .update(schema.phoneNumbers)
      .set({ forwardToE164: null })
      .where(eq(schema.phoneNumbers.id, ctx.seed.phoneNumberId));
  });

  it('phone lookup returns the caller context the incoming-call UI shows', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/lookup/phone?number=${encodeURIComponent(SELLER)}`,
      headers: repAuth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      contact: { display_name: string } | null;
      lead: { id: string } | null;
      property: { address_line1: string } | null;
    };
    expect(body.contact?.display_name).toBe('Sally Seller');
    expect(body.lead?.id).toBe(ctx.seed.leadId);
    expect(body.property?.address_line1).toBe('123 Maple St');
  });
});
