/**
 * Phase 2 vertical slice, end to end through the real HTTP + worker code:
 * click-to-call → TwiML dial → status callbacks → state machine →
 * recording → wrap-up disposition → Podio activity → reconciliation.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { enqueueJob, schema } from '@talkr/db';
import { authHeader, createTestContext, webhookPost, type TestContext } from './helpers.js';
import { dialComplete, recordingStatus, twimlOutbound, voiceStatus } from './fixtures/texml.js';

let ctx: TestContext;
let repAuth: Record<string, string>;

beforeAll(async () => {
  ctx = await createTestContext();
  repAuth = await authHeader(`auth-rep-test-org`);
});
afterAll(async () => {
  await ctx.close();
});

async function getCall(id: string) {
  const rows = await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.id, id));
  return rows[0]!;
}

describe('perfect single call (answered)', () => {
  let callId: string;
  const CLIENT_SID = 'CA_client_answered';
  const PSTN_SID = 'CA_pstn_answered';

  it('rep gets a browser token', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/voice/token',
      headers: repAuth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { token: string; provider: string; browser_leg: string };
    expect(body.token).toBeTruthy();
    // Telnyx: the server rings the browser, the browser never dials out itself.
    expect(body).toMatchObject({ provider: 'telnyx', browser_leg: 'server' });
  });

  it('click-to-call creates a queued call with caller id + lead linkage', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: repAuth,
      payload: { lead_id: ctx.seed.leadId },
    });
    expect(res.statusCode).toBe(201);
    const { call } = res.json() as { call: { id: string; status: string; from_number: string; to_number: string; lead_id: string } };
    callId = call.id;
    expect(call.status).toBe('queued');
    expect(call.from_number).toBe('+15005550006');
    expect(call.to_number).toBe('+15005550009');
    expect(call.lead_id).toBe(ctx.seed.leadId);

    const audit = await ctx.dbh.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'call.create'), eq(schema.auditLog.objectId, callId)));
    expect(audit).toHaveLength(1);
  });

  it('TwiML endpoint binds the client leg and puts it in the call room', async () => {
    const res = await webhookPost(
      ctx,
      '/twiml/outbound-dial',
      twimlOutbound({ clientCallSid: CLIENT_SID, talkrCallId: callId, identity: ctx.seed.repId }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/xml');
    // Conference mode: the browser joins a room rather than bridging straight
    // to the seller, which is what hold / add call / merge / transfer need.
    expect(res.body).toContain('<Conference');
    expect(res.body).toContain(`talkr-${callId}`);
    expect(res.body).toContain('record-from-start');
    expect(res.body).toContain('/webhooks/telnyx/conference-status');

    const call = await getCall(callId);
    expect(call.status).toBe('initiated');
    expect(call.providerCallId).toBe(CLIENT_SID);
    const legs = await ctx.dbh.db
      .select()
      .from(schema.callLegs)
      .where(eq(schema.callLegs.callId, callId));
    expect(legs.map((l) => l.legRole)).toEqual(['client']);

    // Both parties are in the room by the time this reply is written: the
    // seller is dialed inline, not a worker tick later, because a tick is up
    // to a minute of the rep listening to hold music (services/conference-dial.ts).
    const participants = await ctx.dbh.db
      .select()
      .from(schema.callParticipants)
      .where(eq(schema.callParticipants.callId, callId));
    expect(participants.map((p) => p.role).sort()).toEqual(['agent', 'customer']);
    expect(participants.find((p) => p.role === 'agent')!.providerParticipantId).toBe(CLIENT_SID);

    const added = ctx.conferenceOps.added;
    expect(added).toHaveLength(1);
    expect(added[0]!.to).toBe('+15005550009'); // server-decided destination
    expect(added[0]!.callerId).toBe('+15005550006');
    expect(added[0]!.statusCallbackUrl).toContain(`call=${callId}`);
    expect(added[0]!.statusCallbackUrl).toContain('leg=pstn');
    expect(added[0]!.endConferenceOnExit).toBe(true);

    // The fallback job is on the queue regardless, and finds its work done.
    await ctx.runner.drain();
    expect(ctx.conferenceOps.added).toHaveLength(1);
  });

  it('a retried dial job never rings the seller twice', async () => {
    const before = ctx.conferenceOps.added.length;
    await enqueueJob(ctx.dbh.db, {
      jobType: 'conference-dial-customer',
      payload: { callId },
      dedupeKey: `conference-dial:${callId}:retry`,
    });
    await ctx.runner.drain();
    expect(ctx.conferenceOps.added).toHaveLength(before);
  });

  it('status callbacks drive ringing → in_progress with speed-to-lead stamps', async () => {
    const path = `/webhooks/telnyx/voice-status?call=${callId}&leg=pstn`;
    await webhookPost(ctx, path, voiceStatus({ callSid: PSTN_SID, status: 'initiated', sequence: 0, parentCallSid: CLIENT_SID }));
    await webhookPost(ctx, path, voiceStatus({ callSid: PSTN_SID, status: 'ringing', sequence: 1, parentCallSid: CLIENT_SID }));
    await webhookPost(ctx, path, voiceStatus({ callSid: PSTN_SID, status: 'in-progress', sequence: 2, parentCallSid: CLIENT_SID }));
    await ctx.runner.drain();

    const call = await getCall(callId);
    expect(call.status).toBe('in_progress');
    expect(call.ringingAt).not.toBeNull();
    expect(call.answeredAt).not.toBeNull();

    const lead = (
      await ctx.dbh.db.select().from(schema.leads).where(eq(schema.leads.id, ctx.seed.leadId))
    )[0]!;
    expect(lead.firstAttemptAt).not.toBeNull();
    expect(lead.firstAnswerAt).not.toBeNull();

    const legs = await ctx.dbh.db
      .select()
      .from(schema.callLegs)
      .where(eq(schema.callLegs.callId, callId));
    expect(legs.map((l) => l.legRole).sort()).toEqual(['client', 'pstn']);
  });

  it('completion callbacks close the call with duration', async () => {
    // Register provider truth up front: the reconcile job (0ms delay in tests)
    // runs inside this drain. Provider claims 98s vs our 95s → mismatch, and
    // provides the billing price we don't get from webhooks.
    ctx.providerCalls.set(PSTN_SID, {
      providerCallId: PSTN_SID,
      status: 'completed',
      durationSeconds: 98,
      priceCents: 4,
      priceCurrency: 'USD',
      raw: {},
    });
    const path = `/webhooks/telnyx/voice-status?call=${callId}&leg=pstn`;
    await webhookPost(
      ctx,
      path,
      voiceStatus({ callSid: PSTN_SID, status: 'completed', sequence: 3, parentCallSid: CLIENT_SID, duration: 95 }),
    );
    await webhookPost(
      ctx,
      `/twiml/dial-complete?call=${callId}`,
      dialComplete({ parentCallSid: CLIENT_SID, dialCallSid: PSTN_SID, dialStatus: 'completed', dialDuration: 95 }),
    );
    await ctx.runner.drain();

    const call = await getCall(callId);
    expect(call.status).toBe('completed');
    expect(call.durationSeconds).toBe(95);
    expect(call.endedAt).not.toBeNull();
    expect(call.failureClass).toBe('none');
  });

  it('a late recording-completed webhook lands and is mirrored via job', async () => {
    const res = await webhookPost(
      ctx,
      `/webhooks/telnyx/recording-status?call=${callId}`,
      recordingStatus({ recordingSid: 'RE_answered', callSid: PSTN_SID, status: 'completed', duration: 95, channels: 2 }),
    );
    expect(res.statusCode).toBe(200);
    await ctx.runner.drain();

    const recs = await ctx.dbh.db
      .select()
      .from(schema.recordings)
      .where(eq(schema.recordings.callId, callId));
    expect(recs).toHaveLength(1);
    expect(recs[0]!.status).toBe('completed');
    expect(recs[0]!.durationSeconds).toBe(95);
    expect(recs[0]!.channels).toBe(2);
    expect(recs[0]!.providerUrl).toContain('RE_answered');
  });

  it('wrap-up disposition syncs exactly one Podio activity', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/disposition`,
      headers: repAuth,
      payload: { disposition: 'follow_up', note: 'Wants an offer next week', follow_up_at: '2026-09-01T15:00:00Z' },
    });
    expect(res.statusCode).toBe(200);
    await ctx.runner.drain();

    const call = await getCall(callId);
    expect(call.dispositionId).not.toBeNull();
    expect(call.crmSyncStatus).toBe('synced');
    expect(call.wrapupCompletedAt).not.toBeNull();

    expect(ctx.podio.comments).toHaveLength(1);
    const comment = ctx.podio.comments[0]!;
    expect(comment.itemId).toBe('podio-item-42');
    expect(comment.text).toContain('Outbound call — 1m 35s');
    expect(comment.text).toContain('Riley Rep');
    expect(comment.text).toContain('Follow Up');
    expect(comment.text).toContain(`[talkr:${call.correlationId}]`);

    // Re-dispositioning must not double-post (job dedupe + synced check).
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/disposition`,
      headers: repAuth,
      payload: { disposition: 'follow_up' },
    });
    await ctx.runner.drain();
    expect(ctx.podio.comments).toHaveLength(1);

    // Follow-up disposition marks a real conversation on the lead.
    const lead = (
      await ctx.dbh.db.select().from(schema.leads).where(eq(schema.leads.id, ctx.seed.leadId))
    )[0]!;
    expect(lead.firstConversationAt).not.toBeNull();
  });

  it('reconciliation compared provider truth and recorded mismatches', async () => {
    await ctx.runner.drain(); // reconcile-call job was enqueued at terminal

    const mismatches = await ctx.dbh.db
      .select()
      .from(schema.reconciliationMismatches)
      .where(eq(schema.reconciliationMismatches.objectId, callId));
    expect(mismatches.some((m) => m.field === 'duration_seconds')).toBe(true);

    // Billing-class fields backfill from provider truth.
    const call = await getCall(callId);
    expect(call.priceCents).toBe(4);
  });

  it('the full journey is reconstructable from call_events', async () => {
    const events = await ctx.dbh.db
      .select()
      .from(schema.callEvents)
      .where(eq(schema.callEvents.callId, callId))
      .orderBy(schema.callEvents.occurredAt, schema.callEvents.createdAt);
    const types = events.map((e) => e.eventType);
    expect(types).toContain('call.initiated');
    expect(types).toContain('call.ringing');
    expect(types).toContain('call.answered');
    expect(types).toContain('call.completed');
    expect(types).toContain('recording.completed');
    // Every webhook-sourced event links back to its raw delivery.
    for (const e of events.filter((e) => e.source === 'webhook')) {
      expect(e.webhookEventId).not.toBeNull();
    }
  });
});

describe('no-answer call', () => {
  it('classifies seller_no_answer distinctly from platform failure', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: repAuth,
      payload: { to_number: '+16145550199' },
    });
    const callId = (create.json() as { call: { id: string } }).call.id;

    await webhookPost(
      ctx,
      '/twiml/outbound-dial',
      twimlOutbound({ clientCallSid: 'CA_client_na', talkrCallId: callId, identity: ctx.seed.repId }),
    );
    const path = `/webhooks/telnyx/voice-status?call=${callId}&leg=pstn`;
    await webhookPost(ctx, path, voiceStatus({ callSid: 'CA_pstn_na', status: 'ringing', sequence: 0, parentCallSid: 'CA_client_na' }));
    await webhookPost(ctx, path, voiceStatus({ callSid: 'CA_pstn_na', status: 'no-answer', sequence: 1, parentCallSid: 'CA_client_na' }));
    // Parent hangs up after dial fails; must NOT flip the call to completed.
    await webhookPost(
      ctx,
      `/twiml/dial-complete?call=${callId}`,
      dialComplete({ parentCallSid: 'CA_client_na', dialCallSid: 'CA_pstn_na', dialStatus: 'no-answer' }),
    );
    await ctx.runner.drain();

    const call = (await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.id, callId)))[0]!;
    expect(call.status).toBe('no_answer');
    expect(call.failureClass).toBe('seller_no_answer');
  });
});

describe('suppression / DNC', () => {
  it('DNC disposition writes suppression and blocks the next call', async () => {
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: repAuth,
      payload: { to_number: '+16145550777' },
    });
    expect(create.statusCode).toBe(201);
    const callId = (create.json() as { call: { id: string } }).call.id;

    const dnc = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/disposition`,
      headers: repAuth,
      payload: { disposition: 'dnc' },
    });
    expect(dnc.statusCode).toBe(200);

    const suppression = await ctx.dbh.db
      .select()
      .from(schema.suppressionRecords)
      .where(eq(schema.suppressionRecords.phoneE164, '+16145550777'));
    expect(suppression).toHaveLength(1);
    expect(suppression[0]!.reason).toBe('dnc_disposition');

    const blocked = await ctx.app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: repAuth,
      payload: { to_number: '+16145550777' },
    });
    expect(blocked.statusCode).toBe(422);
    expect((blocked.json() as { error: string }).error).toBe('suppressed');
  });
});

describe('inbound safety net', () => {
  it('records inbound calls to platform numbers with zero data loss', async () => {
    const res = await webhookPost(ctx, '/twiml/inbound', {
      AccountSid: 'ACtest00000000000000000000000000',
      CallSid: 'CA_inbound_1',
      CallStatus: 'ringing',
      From: '+16145550101',
      To: '+15005550006',
      Direction: 'inbound',
      ApiVersion: '2010-04-01',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Say>');
    await ctx.runner.drain();

    const calls = await ctx.dbh.db
      .select()
      .from(schema.calls)
      .where(eq(schema.calls.providerCallId, 'CA_inbound_1'));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.direction).toBe('inbound');
    expect(calls[0]!.orgId).toBe(ctx.seed.orgId);
    expect(calls[0]!.fromNumber).toBe('+16145550101');
  });

  it('flags calls to unknown numbers as explicit orphans, never dropped silently', async () => {
    await webhookPost(ctx, '/twiml/inbound', {
      AccountSid: 'ACtest00000000000000000000000000',
      CallSid: 'CA_orphan_1',
      CallStatus: 'ringing',
      From: '+16145550102',
      To: '+19995550000', // no such platform number
      Direction: 'inbound',
      ApiVersion: '2010-04-01',
    });
    await ctx.runner.drain();

    const orphans = await ctx.dbh.db
      .select()
      .from(schema.reconciliationMismatches)
      .where(eq(schema.reconciliationMismatches.providerObjectId, 'CA_orphan_1'));
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.objectType).toBe('orphan_provider_call');
  });
});
