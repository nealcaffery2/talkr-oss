/**
 * Phase 5 AMD (docs/dialers.md §8), all via fixture payloads with genuine
 * signed webhooks — live AMD accuracy is untested until real Twilio exists:
 *   machine + action=hangup         → <Hangup/>, journaled, retry-scheduled
 *   machine + action=voicemail_drop → <Say>org text</Say><Hangup/>, outcome
 *                                     voicemail_dropped, retry-scheduled
 *   human                           → normal bridge
 * Machine-answered calls are excluded from connected counts.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { createTestContext, webhookPost, type TestContext, repAddress } from './helpers.js';
import { voiceStatus } from './fixtures/texml.js';
import {
  adminAuth,
  attachByIds,
  campaignLeadRow,
  createDialCampaign,
  getCall,
  getSession,
  makeLead,
  nextApi,
  repAuth,
  runDialerWatch,
  setPresence,
  startSessionApi,
  type MadeLead,
} from './dialer-helpers.js';

let ctx: TestContext;
let admin: Record<string, string>;
let rep: Record<string, string>;
let campaignId: string;
let sessionId: string;
let leads: MadeLead[] = [];

const AMD_BASE = {
  callingWindowStart: '00:00',
  callingWindowEnd: '23:59',
  parallelLines: 1,
  amdEnabled: true,
  maxAttemptsPerDay: 6,
};
const DROP_TEXT = 'Hi, this is Your Company about your property. We will try you again. Goodbye.';

function answerParams(sid: string, answeredBy?: string): Record<string, string> {
  const p: Record<string, string> = {
    AccountSid: 'ACtest00000000000000000000000000',
    CallSid: sid,
    CallStatus: 'in-progress',
    Direction: 'outbound-api',
    ApiVersion: '2010-04-01',
  };
  if (answeredBy) p.AnsweredBy = answeredBy;
  return p;
}

async function finishRestCall(callId: string, sid: string, phone: string) {
  const path = `/webhooks/telnyx/voice-status?call=${callId}&leg=pstn`;
  await webhookPost(ctx, path, voiceStatus({ callSid: sid, status: 'in-progress', sequence: 1, to: phone }));
  await webhookPost(ctx, path, voiceStatus({ callSid: sid, status: 'completed', sequence: 2, duration: 12, to: phone }));
  await ctx.runner.drain();
}

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await adminAuth();
  rep = await repAuth();
  for (let i = 0; i < 3; i++) leads.push(await makeLead(ctx, { name: `AMD Seller ${i + 1}` }));
  campaignId = await createDialCampaign(ctx, admin, {
    name: 'AMD Drill',
    mode: 'parallel',
    settings: { ...AMD_BASE, amdAction: 'hangup' },
  });
  await attachByIds(ctx, admin, campaignId, leads.map((l) => l.leadId));
  await setPresence(ctx, ctx.seed.repId, 'available');
  const started = await startSessionApi(ctx, rep, campaignId);
  sessionId = started.session!.id;
});
afterAll(async () => {
  await ctx.close();
});

describe('AMD machine handling', () => {
  it('hangup action: machine_start hangs up, journals, and retry-schedules the lead', async () => {
    const result = await nextApi(ctx, rep, sessionId);
    expect(result.idle).toBe(false);
    const dial = ctx.providerDials.at(-1)!;
    expect(dial.machineDetection).toBe('enable'); // report-at-answer variant
    const call = await getCall(ctx, result.lines![0]!.call.id);
    const lead = leads.find((l) => l.phone === call.toNumber)!;

    const res = await webhookPost(
      ctx,
      `/twiml/campaign-answer?call=${call.id}`,
      answerParams(call.providerCallId!, 'machine_start'),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Hangup/>');
    expect(res.body).not.toContain('<Say>');
    expect(res.body).not.toContain('<Dial');

    const fresh = await getCall(ctx, call.id);
    expect((fresh.raw as { amdResult?: string }).amdResult).toBe('machine_start');
    const events = await ctx.dbh.db
      .select()
      .from(schema.callEvents)
      .where(eq(schema.callEvents.callId, call.id));
    const amd = events.find((e) => e.eventType === 'call.amd');
    expect(amd).toBeTruthy();
    expect(amd!.payload).toMatchObject({ answeredBy: 'machine_start', action: 'hangup' });

    const cl = await campaignLeadRow(ctx, campaignId, lead.leadId);
    expect(cl.status).toBe('pending');
    expect(cl.lastOutcome).toBe('machine_hangup');
    expect(cl.nextAttemptAt).not.toBeNull();
    expect(cl.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());

    // A duplicate delivery of the same answer webhook changes nothing.
    const scheduled = cl.nextAttemptAt!.getTime();
    await webhookPost(
      ctx,
      `/twiml/campaign-answer?call=${call.id}`,
      answerParams(call.providerCallId!, 'machine_start'),
    );
    const again = await campaignLeadRow(ctx, campaignId, lead.leadId);
    expect(again.nextAttemptAt!.getTime()).toBe(scheduled);

    // The call still ends through the normal pipeline; machine pickups are
    // excluded from connected counts.
    await finishRestCall(call.id, call.providerCallId!, call.toNumber);
    expect((await getCall(ctx, call.id)).status).toBe('completed');
    const session = await getSession(ctx, sessionId);
    expect(session.connectedCount).toBe(0);
  });

  it('voicemail_drop action: says the org-configured text, outcome voicemail_dropped', async () => {
    await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/campaigns/${campaignId}`,
      headers: admin,
      payload: { settings: { ...AMD_BASE, amdAction: 'voicemail_drop', amdVoicemailText: DROP_TEXT } },
    });
    const result = await nextApi(ctx, rep, sessionId);
    expect(result.idle).toBe(false);
    const dial = ctx.providerDials.at(-1)!;
    expect(dial.machineDetection).toBe('detect_message_end'); // drop lands after the greeting
    const call = await getCall(ctx, result.lines![0]!.call.id);
    const lead = leads.find((l) => l.phone === call.toNumber)!;

    const res = await webhookPost(
      ctx,
      `/twiml/campaign-answer?call=${call.id}`,
      answerParams(call.providerCallId!, 'machine_end_beep'),
    );
    expect(res.body).toContain(`<Say>${DROP_TEXT}</Say>`);
    expect(res.body).toContain('<Hangup/>');

    const cl = await campaignLeadRow(ctx, campaignId, lead.leadId);
    expect(cl.status).toBe('pending');
    expect(cl.lastOutcome).toBe('voicemail_dropped');
    expect(cl.nextAttemptAt).not.toBeNull();

    await finishRestCall(call.id, call.providerCallId!, call.toNumber);
  });

  it('a human answer proceeds to the normal bridge', async () => {
    const result = await nextApi(ctx, rep, sessionId);
    expect(result.idle).toBe(false);
    const call = await getCall(ctx, result.lines![0]!.call.id);

    const res = await webhookPost(
      ctx,
      `/twiml/campaign-answer?call=${call.id}`,
      answerParams(call.providerCallId!, 'human'),
    );
    expect(res.body).toContain('<Dial');
    expect(res.body).toContain(await repAddress(ctx, ctx.seed.repId));
    expect(res.body).not.toContain('<Say>');

    await finishRestCall(call.id, call.providerCallId!, call.toNumber);
    await runDialerWatch(ctx); // counters recompute rides the watcher
    const session = await getSession(ctx, sessionId);
    expect(session.connectedCount).toBe(1); // the human call counts
    expect(session.dialedCount).toBe(3); // machine pickups still dialed, never connected
  });
});
