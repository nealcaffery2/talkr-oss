/**
 * Phase 5 parallel mode: N REST dials, first answer wins the bridge, losing
 * legs are canceled via the provider and retry-scheduled, an answered call
 * with no rep is abandoned (journaled + counted), and the abandonment cap
 * drops the session to one line (journaled). Canceled legs never corrupt the
 * call state machine.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { createTestContext, webhookPost, type TestContext, rungUsers } from './helpers.js';
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

// Batch 1
let callA: { id: string; sid: string; lead: MadeLead };
let callB: { id: string; sid: string; lead: MadeLead };
// Batch 2
let callC: { id: string; sid: string; lead: MadeLead };
let callD: { id: string; sid: string; lead: MadeLead };

function answerParams(sid: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    AccountSid: 'ACtest00000000000000000000000000',
    CallSid: sid,
    CallStatus: 'in-progress',
    Direction: 'outbound-api',
    ApiVersion: '2010-04-01',
    ...extra,
  };
}

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await adminAuth();
  rep = await repAuth();
  for (let i = 0; i < 5; i++) leads.push(await makeLead(ctx, { name: `Parallel Seller ${i + 1}` }));
  campaignId = await createDialCampaign(ctx, admin, {
    name: 'Parallel Blitz',
    mode: 'parallel',
    settings: { parallelLines: 2, callingWindowStart: '00:00', callingWindowEnd: '23:59', maxAttemptsPerDay: 6 },
  });
  await attachByIds(ctx, admin, campaignId, leads.map((l) => l.leadId));
  await setPresence(ctx, ctx.seed.repId, 'available');
  const started = await startSessionApi(ctx, rep, campaignId);
  sessionId = started.session!.id;
});
afterAll(async () => {
  await ctx.close();
});

describe('parallel batch dialing', () => {
  it('next REST-dials two lines with a shared batch id and stamped SIDs', async () => {
    const result = await nextApi(ctx, rep, sessionId);
    expect(result.idle).toBe(false);
    expect(result.lines).toHaveLength(2);
    expect(result.batch_id).toBeTruthy();
    expect(ctx.providerDials).toHaveLength(2);
    expect(ctx.providerDials[0]!.answerUrl).toContain('/twiml/campaign-answer?call=');
    expect(ctx.providerDials[0]!.statusCallbackUrl).toContain('leg=pstn');
    expect(ctx.providerDials[0]!.machineDetection).toBeUndefined(); // AMD off

    const [lineA, lineB] = result.lines!;
    const a = await getCall(ctx, lineA!.call.id);
    const b = await getCall(ctx, lineB!.call.id);
    expect(a.providerCallId).toBe('CA_fake_dial_1');
    expect(b.providerCallId).toBe('CA_fake_dial_2');
    expect((a.raw as { dialBatchId?: string }).dialBatchId).toBe(result.batch_id);
    expect((b.raw as { dialBatchId?: string }).dialBatchId).toBe(result.batch_id);
    const leadOf = (toNumber: string) => leads.find((l) => l.phone === toNumber)!;
    callA = { id: a.id, sid: a.providerCallId!, lead: leadOf(a.toNumber) };
    callB = { id: b.id, sid: b.providerCallId!, lead: leadOf(b.toNumber) };

    // Both legs exist as pstn legs; both leads reserved.
    const legs = await ctx.dbh.db
      .select()
      .from(schema.callLegs)
      .where(eq(schema.callLegs.callId, a.id));
    expect(legs.map((l) => l.legRole)).toEqual(['pstn']);
    expect((await campaignLeadRow(ctx, campaignId, callA.lead.leadId)).status).toBe('in_progress');
    expect((await campaignLeadRow(ctx, campaignId, callB.lead.leadId)).status).toBe('in_progress');
  });

  it('first answer wins the bridge to the rep; siblings get canceled via the provider', async () => {
    const res = await webhookPost(
      ctx,
      `/twiml/campaign-answer?call=${callA.id}`,
      answerParams(callA.sid, { To: callA.lead.phone }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<Dial');
    expect(await rungUsers(ctx, res.body)).toEqual([ctx.seed.repId]);
    expect(res.body).toContain('record-from-answer-dual');

    expect((await getCall(ctx, callA.id)).raw).toMatchObject({ parallelWinner: true });

    await ctx.runner.drain(); // cancel-sibling-dials
    expect(ctx.canceledCalls).toContain(callB.sid);
    expect(ctx.canceledCalls).not.toContain(callA.sid);
    const events = await ctx.dbh.db
      .select()
      .from(schema.callEvents)
      .where(eq(schema.callEvents.callId, callB.id));
    expect(events.some((e) => e.eventType === 'call.cancel_requested')).toBe(true);
  });

  it("the losing leg ends canceled through the normal pipeline and can't be corrupted by late events", async () => {
    const path = `/webhooks/telnyx/voice-status?call=${callB.id}&leg=pstn`;
    await webhookPost(ctx, path, voiceStatus({ callSid: callB.sid, status: 'canceled', sequence: 1, to: callB.lead.phone }));
    await ctx.runner.drain();
    const b = await getCall(ctx, callB.id);
    expect(b.status).toBe('canceled'); // terminal per call-state.ts — unchanged semantics
    expect(b.failureClass).toBe('canceled');

    // A late ringing webhook never regresses the terminal state.
    await webhookPost(ctx, path, voiceStatus({ callSid: callB.sid, status: 'ringing', sequence: 0, to: callB.lead.phone }));
    await ctx.runner.drain();
    expect((await getCall(ctx, callB.id)).status).toBe('canceled');
  });

  it("the canceled leg's lead is retry-scheduled by the watcher", async () => {
    await runDialerWatch(ctx);
    const cl = await campaignLeadRow(ctx, campaignId, callB.lead.leadId);
    expect(cl.status).toBe('pending');
    expect(cl.lastOutcome).toBe('canceled');
    expect(cl.nextAttemptAt).not.toBeNull();
    expect(cl.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('the winner completes normally and counts as connected', async () => {
    const path = `/webhooks/telnyx/voice-status?call=${callA.id}&leg=pstn`;
    await webhookPost(ctx, path, voiceStatus({ callSid: callA.sid, status: 'in-progress', sequence: 1, to: callA.lead.phone }));
    await webhookPost(ctx, path, voiceStatus({ callSid: callA.sid, status: 'completed', sequence: 2, duration: 55, to: callA.lead.phone }));
    await ctx.runner.drain();
    expect((await getCall(ctx, callA.id)).status).toBe('completed');
    await runDialerWatch(ctx);
    const session = await getSession(ctx, sessionId);
    expect(session.dialedCount).toBe(2);
    expect(session.connectedCount).toBe(1);
    expect(session.abandonedCount).toBe(0);
    // Winner's lead: human conversation → contacted (interim outcome).
    expect((await campaignLeadRow(ctx, campaignId, callA.lead.leadId)).status).toBe('contacted');
  });
});

describe('abandonment (C4/C6)', () => {
  it('the second batch dials; both answer — the loser is ABANDONED, journaled and counted', async () => {
    const result = await nextApi(ctx, rep, sessionId);
    expect(result.idle).toBe(false);
    expect(result.lines).toHaveLength(2);
    const [lineC, lineD] = result.lines!;
    const c = await getCall(ctx, lineC!.call.id);
    const d = await getCall(ctx, lineD!.call.id);
    const leadOf = (toNumber: string) => leads.find((l) => l.phone === toNumber)!;
    callC = { id: c.id, sid: c.providerCallId!, lead: leadOf(c.toNumber) };
    callD = { id: d.id, sid: d.providerCallId!, lead: leadOf(d.toNumber) };

    // C answers first and wins the rep.
    const winner = await webhookPost(
      ctx,
      `/twiml/campaign-answer?call=${callC.id}`,
      answerParams(callC.sid, { To: callC.lead.phone }),
    );
    expect(winner.body).toContain('<Dial');
    await webhookPost(
      ctx,
      `/webhooks/telnyx/voice-status?call=${callC.id}&leg=pstn`,
      voiceStatus({ callSid: callC.sid, status: 'in-progress', sequence: 1, to: callC.lead.phone }),
    );
    await ctx.runner.drain();

    // D answers moments later: a human is on the line and no rep can bridge.
    const abandoned = await webhookPost(
      ctx,
      `/twiml/campaign-answer?call=${callD.id}`,
      answerParams(callD.sid, { To: callD.lead.phone }),
    );
    expect(abandoned.statusCode).toBe(200);
    expect(abandoned.body).not.toContain('<Dial');
    expect(abandoned.body).toContain('<Say>'); // identification message, never dead air
    expect(abandoned.body).toContain('Your Company');
    expect(abandoned.body).toContain('<Hangup/>');

    const dRow = await getCall(ctx, callD.id);
    expect((dRow.raw as { abandoned?: boolean }).abandoned).toBe(true);
    const events = await ctx.dbh.db
      .select()
      .from(schema.callEvents)
      .where(eq(schema.callEvents.callId, callD.id));
    expect(events.some((e) => e.eventType === 'call.abandoned')).toBe(true);

    const cl = await campaignLeadRow(ctx, campaignId, callD.lead.leadId);
    expect(cl.status).toBe('pending'); // retry-scheduled
    expect(cl.lastOutcome).toBe('abandoned');
    expect(cl.nextAttemptAt).not.toBeNull();

    const session = await getSession(ctx, sessionId);
    expect(session.abandonedCount).toBe(1);
  });

  it('the abandonment cap trips: the session drops to one line, journaled', async () => {
    const session = await getSession(ctx, sessionId);
    expect(session.currentLineLimit).toBe(1);

    const audit = await ctx.dbh.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'dial_session.lines_reduced'));
    expect(audit).toHaveLength(1);
    const meta = audit[0]!.metadata as { reason: string; abandoned: number; cap_percent: number };
    expect(meta.reason).toBe('abandonment_cap_breached');
    expect(meta.abandoned).toBe(1);
    expect(meta.cap_percent).toBeLessThanOrEqual(3);
  });

  it('subsequent batches dial a single line while reduced', async () => {
    // Close out batch 2 so the session has no in-flight calls.
    await webhookPost(
      ctx,
      `/webhooks/telnyx/voice-status?call=${callC.id}&leg=pstn`,
      voiceStatus({ callSid: callC.sid, status: 'completed', sequence: 2, duration: 30, to: callC.lead.phone }),
    );
    await webhookPost(
      ctx,
      `/webhooks/telnyx/voice-status?call=${callD.id}&leg=pstn`,
      voiceStatus({ callSid: callD.sid, status: 'completed', sequence: 2, duration: 5, to: callD.lead.phone }),
    );
    await ctx.runner.drain();

    const dialsBefore = ctx.providerDials.length;
    const result = await nextApi(ctx, rep, sessionId);
    expect(result.idle).toBe(false);
    expect(result.lines).toHaveLength(1); // reduced from 2 → 1
    expect(ctx.providerDials.length).toBe(dialsBefore + 1);
  });
});
