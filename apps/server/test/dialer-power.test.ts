/**
 * Phase 5 power mode end to end: campaign CRUD + RBAC, lead attachment,
 * session start, `next` dialing through the existing click-to-call path with
 * campaign context, status callbacks → terminal → disposition → campaign_lead
 * outcome + stats, priority ordering, and in-flight rejection.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, like } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { createTestContext, webhookPost, type TestContext } from './helpers.js';
import { dialComplete, twimlOutbound, voiceStatus } from './fixtures/texml.js';
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
let leadA: MadeLead; // high priority — dialed first
let leadB: MadeLead;
let leadFiltered: MadeLead;
let firstCallId: string;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await adminAuth();
  rep = await repAuth();
  leadA = await makeLead(ctx, { name: 'Alice Priority' });
  leadB = await makeLead(ctx, { name: 'Bob Second' });
  leadFiltered = await makeLead(ctx, { name: 'Fiona Filter', source: 'power-filter' });
});
afterAll(async () => {
  await ctx.close();
});

describe('campaign CRUD + RBAC', () => {
  it('a rep cannot create campaigns; a manager/admin can', async () => {
    const denied = await ctx.app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: rep,
      payload: { name: 'Nope', mode: 'power' },
    });
    expect(denied.statusCode).toBe(403);

    campaignId = await createDialCampaign(ctx, admin, {
      name: 'Power Hour',
      mode: 'power',
      settings: { callingWindowStart: '00:00', callingWindowEnd: '23:59', maxAttemptsPerDay: 6 },
      activate: false,
    });
    const list = await ctx.app.inject({ method: 'GET', url: '/v1/campaigns', headers: rep });
    expect(list.statusCode).toBe(200);
    const found = (list.json() as { campaigns: Array<{ id: string; status: string }> }).campaigns
      .find((c) => c.id === campaignId);
    expect(found?.status).toBe('draft');
  });

  it('attaches leads by explicit ids and by filter; re-attach is a no-op', async () => {
    const byIds = await attachByIds(ctx, admin, campaignId, [leadA.leadId, leadB.leadId]);
    expect(byIds.attached).toBe(2);

    const byFilter = await ctx.app.inject({
      method: 'POST',
      url: `/v1/campaigns/${campaignId}/leads`,
      headers: admin,
      payload: { filter: { source: 'power-filter' } },
    });
    expect(byFilter.statusCode).toBe(200);
    expect((byFilter.json() as { attached: number }).attached).toBe(1);

    const again = await attachByIds(ctx, admin, campaignId, [leadA.leadId]);
    expect(again.attached).toBe(0); // already attached — untouched

    // Priority is honored by selection: bump Alice.
    await ctx.dbh.db
      .update(schema.campaignLeads)
      .set({ priority: 10 })
      .where(
        and(
          eq(schema.campaignLeads.campaignId, campaignId),
          eq(schema.campaignLeads.leadId, leadA.leadId),
        ),
      );
    // Park the filter lead so this file works two leads deterministically.
    await ctx.dbh.db
      .update(schema.campaignLeads)
      .set({ status: 'removed' })
      .where(
        and(
          eq(schema.campaignLeads.campaignId, campaignId),
          eq(schema.campaignLeads.leadId, leadFiltered.leadId),
        ),
      );
  });

  it('detach marks removed; re-attach revives to pending', async () => {
    const revive = await attachByIds(ctx, admin, campaignId, [leadFiltered.leadId]);
    expect(revive.revived).toBe(1);
    const detach = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/campaigns/${campaignId}/leads`,
      headers: admin,
      payload: { lead_ids: [leadFiltered.leadId] },
    });
    expect((detach.json() as { detached: number }).detached).toBe(1);
    const row = await campaignLeadRow(ctx, campaignId, leadFiltered.leadId);
    expect(row.status).toBe('removed');
  });
});

describe('session start', () => {
  it('refuses on a draft campaign and without fresh presence', async () => {
    await setPresence(ctx, ctx.seed.repId, 'offline');
    const draft = await startSessionApi(ctx, rep, campaignId);
    expect(draft.statusCode).toBe(422); // campaign_not_active

    await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/campaigns/${campaignId}`,
      headers: admin,
      payload: { status: 'active' },
    });
    const noPresence = await startSessionApi(ctx, rep, campaignId);
    expect(noPresence.statusCode).toBe(409); // presence_required
  });

  it('starts once the rep is available', async () => {
    await setPresence(ctx, ctx.seed.repId, 'available');
    const started = await startSessionApi(ctx, rep, campaignId);
    expect(started.statusCode).toBe(201);
    sessionId = started.session!.id;
    const active = await ctx.app.inject({
      method: 'GET',
      url: '/v1/dial-sessions/active',
      headers: rep,
    });
    expect((active.json() as { session: { id: string } }).session.id).toBe(sessionId);
  });
});

describe('next — the heart', () => {
  it('dials the highest-priority lead through the click-to-call path with campaign context', async () => {
    const result = await nextApi(ctx, rep, sessionId);
    expect(result.statusCode).toBe(200);
    expect(result.idle).toBe(false);
    expect(result.lines).toHaveLength(1);
    const line = result.lines![0]!;
    firstCallId = line.call.id;
    expect(line.call.to_number).toBe(leadA.phone);
    expect(line.card?.contact?.display_name).toBe('Alice Priority');
    expect(line.card?.property?.address_line1).toContain('Dialer Ave');

    const call = await getCall(ctx, firstCallId);
    const raw = call.raw as Record<string, unknown>;
    expect(raw.campaignId).toBe(campaignId);
    expect(raw.dialSessionId).toBe(sessionId);
    expect(raw.dialMode).toBe('power');
    expect(call.leadId).toBe(leadA.leadId);
    expect(call.status).toBe('queued'); // the browser leg dials next, like any click-to-call

    const cl = await campaignLeadRow(ctx, campaignId, leadA.leadId);
    expect(cl.status).toBe('in_progress');
    expect(cl.attempts).toBe(1);
    expect(cl.lastAttemptAt).not.toBeNull();
  });

  it('rejects next while a session call is in flight', async () => {
    const rejected = await nextApi(ctx, rep, sessionId);
    expect(rejected.statusCode).toBe(409);
    expect(rejected.error).toBe('call_in_flight');
  });

  it('the call completes through the normal webhook pipeline', async () => {
    await webhookPost(
      ctx,
      '/twiml/outbound-dial',
      twimlOutbound({ clientCallSid: 'CA_p5_client_1', talkrCallId: firstCallId, identity: ctx.seed.repId }),
    );
    const path = `/webhooks/telnyx/voice-status?call=${firstCallId}&leg=pstn`;
    await webhookPost(ctx, path, voiceStatus({ callSid: 'CA_p5_pstn_1', status: 'ringing', sequence: 0, parentCallSid: 'CA_p5_client_1', to: leadA.phone }));
    await webhookPost(ctx, path, voiceStatus({ callSid: 'CA_p5_pstn_1', status: 'in-progress', sequence: 1, parentCallSid: 'CA_p5_client_1', to: leadA.phone }));
    await webhookPost(ctx, path, voiceStatus({ callSid: 'CA_p5_pstn_1', status: 'completed', sequence: 2, duration: 65, parentCallSid: 'CA_p5_client_1', to: leadA.phone }));
    await webhookPost(
      ctx,
      `/twiml/dial-complete?call=${firstCallId}`,
      dialComplete({ parentCallSid: 'CA_p5_client_1', dialCallSid: 'CA_p5_pstn_1', dialStatus: 'completed', dialDuration: 65 }),
    );
    await ctx.runner.drain();
    const call = await getCall(ctx, firstCallId);
    expect(call.status).toBe('completed');
    expect(call.answeredAt).not.toBeNull();
  });

  it('disposition applies the campaign outcome (conversation → contacted); power never auto-dials', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${firstCallId}/disposition`,
      headers: rep,
      payload: { disposition: 'follow_up', note: 'wants a number Tuesday' },
    });
    expect(res.statusCode).toBe(200);
    await ctx.runner.drain(); // campaign-advance applies the outcome

    const cl = await campaignLeadRow(ctx, campaignId, leadA.leadId);
    expect(cl.status).toBe('contacted');
    expect(cl.lastOutcome).toBe('follow_up');

    // Power mode: no auto-advance — still exactly one session call.
    const sessionCalls = await ctx.dbh.db
      .select()
      .from(schema.calls)
      .where(like(schema.calls.toNumber, '+1614777%'));
    expect(sessionCalls.filter((c) => (c.raw as { dialSessionId?: string }).dialSessionId === sessionId)).toHaveLength(1);
  });

  it('the second next picks the next lead; skipped wrap-up still schedules a retry via the watcher', async () => {
    const result = await nextApi(ctx, rep, sessionId);
    expect(result.idle).toBe(false);
    const call = result.lines![0]!.call;
    expect(call.to_number).toBe(leadB.phone);

    await webhookPost(
      ctx,
      '/twiml/outbound-dial',
      twimlOutbound({ clientCallSid: 'CA_p5_client_2', talkrCallId: call.id, identity: ctx.seed.repId }),
    );
    const path = `/webhooks/telnyx/voice-status?call=${call.id}&leg=pstn`;
    await webhookPost(ctx, path, voiceStatus({ callSid: 'CA_p5_pstn_2', status: 'ringing', sequence: 0, parentCallSid: 'CA_p5_client_2', to: leadB.phone }));
    await webhookPost(ctx, path, voiceStatus({ callSid: 'CA_p5_pstn_2', status: 'no-answer', sequence: 1, parentCallSid: 'CA_p5_client_2', to: leadB.phone }));
    await ctx.runner.drain();
    expect((await getCall(ctx, call.id)).status).toBe('no_answer');

    // No disposition saved — the dialer-watch sweep applies the interim
    // outcome so the lead is never stuck in_progress.
    await runDialerWatch(ctx);
    const cl = await campaignLeadRow(ctx, campaignId, leadB.leadId);
    expect(cl.status).toBe('pending');
    expect(cl.nextAttemptAt).not.toBeNull();
    expect(cl.nextAttemptAt!.getTime()).toBeGreaterThan(Date.now());
    expect(cl.lastOutcome).toBe('no_answer');
  });

  it('session counters + campaign stats reflect the work', async () => {
    const session = await getSession(ctx, sessionId);
    expect(session.dialedCount).toBe(2);
    expect(session.connectedCount).toBe(1);
    expect(session.abandonedCount).toBe(0);

    const stats = await ctx.app.inject({
      method: 'GET',
      url: `/v1/campaigns/${campaignId}/stats`,
      headers: rep,
    });
    expect(stats.statusCode).toBe(200);
    const body = stats.json() as {
      lead_counts: Record<string, number>;
      calls: { total: number; connected: number; abandoned: number };
      abandonment: { rate: number; cap_percent: number };
    };
    expect(body.lead_counts.contacted).toBe(1);
    expect(body.lead_counts.pending).toBe(1);
    expect(body.calls.total).toBe(2);
    expect(body.calls.connected).toBe(1);
    expect(body.abandonment.rate).toBe(0);
    expect(body.abandonment.cap_percent).toBeLessThanOrEqual(3);
  });

  it('journey + audit: session calls carry campaign linkage end to end', async () => {
    const audit = await ctx.dbh.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'dial_session.start'));
    expect(audit.length).toBeGreaterThan(0);
    const events = await ctx.dbh.db
      .select()
      .from(schema.callEvents)
      .where(eq(schema.callEvents.callId, firstCallId));
    expect(events.some((e) => e.eventType === 'call.completed')).toBe(true);
  });
});
