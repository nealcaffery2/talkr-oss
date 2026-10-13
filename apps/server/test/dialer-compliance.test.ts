/**
 * Phase 5 compliance invariants (docs/dialers.md §7), each pinned here:
 *   C1 suppressed leads are never selected (marked + skipped)
 *   C2 suppression landing mid-session — including a real STOP — is caught,
 *      and the dial-time re-check catches the race between selection and dial
 *   C3 calling windows block selection; the session goes idle with a reason
 *   C5 per-day and total attempt caps hold across days
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { createTestContext, webhookPost, type TestContext } from './helpers.js';
import { dialComplete, twimlOutbound, voiceStatus } from './fixtures/texml.js';
import { inboundSms } from './fixtures/texml-sms.js';
import { sessionNext } from '../src/services/dial-sessions.js';
import type { AuthContext } from '../src/auth.js';
import {
  adminAuth,
  attachByIds,
  campaignLeadRow,
  createDialCampaign,
  getCall,
  makeLead,
  nextApi,
  repAuth,
  setPresence,
  startSessionApi,
  type MadeLead,
} from './dialer-helpers.js';

let ctx: TestContext;
let admin: Record<string, string>;
let rep: Record<string, string>;
let repCtx: AuthContext;
let campaignId: string;
let sessionId: string;

let clean: MadeLead;
let dnc: MadeLead;
let stopLead: MadeLead;
let raceVictim: MadeLead;
let raceClean: MadeLead;
let dayCap: MadeLead;

let sidSeq = 0;

async function callsTo(phone: string) {
  return ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.toNumber, phone));
}

/** Drive a session call to terminal through the real TwiML + webhook path. */
async function finishCall(callId: string, phone: string, status: 'completed' | 'no-answer') {
  sidSeq += 1;
  const client = `CA_comp_client_${sidSeq}`;
  const pstn = `CA_comp_pstn_${sidSeq}`;
  await webhookPost(
    ctx,
    '/twiml/outbound-dial',
    twimlOutbound({ clientCallSid: client, talkrCallId: callId, identity: ctx.seed.repId }),
  );
  const path = `/webhooks/telnyx/voice-status?call=${callId}&leg=pstn`;
  if (status === 'completed') {
    await webhookPost(ctx, path, voiceStatus({ callSid: pstn, status: 'in-progress', sequence: 0, parentCallSid: client, to: phone }));
    await webhookPost(ctx, path, voiceStatus({ callSid: pstn, status: 'completed', sequence: 1, duration: 20, parentCallSid: client, to: phone }));
  } else {
    await webhookPost(ctx, path, voiceStatus({ callSid: pstn, status: 'no-answer', sequence: 0, parentCallSid: client, to: phone }));
    await webhookPost(
      ctx,
      `/twiml/dial-complete?call=${callId}`,
      dialComplete({ parentCallSid: client, dialCallSid: pstn, dialStatus: 'no-answer' }),
    );
  }
  await ctx.runner.drain();
}

function hhmmInNY(offsetHours: number): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(Date.now() + offsetHours * 3_600_000));
  const h = parts.find((p) => p.type === 'hour')!.value;
  const m = parts.find((p) => p.type === 'minute')!.value;
  return `${h === '24' ? '00' : h}:${m}`;
}

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await adminAuth();
  rep = await repAuth();
  const repUser = (
    await ctx.dbh.db.select().from(schema.users).where(eq(schema.users.id, ctx.seed.repId))
  )[0]!;
  repCtx = {
    userId: repUser.id,
    orgId: repUser.orgId,
    role: repUser.role,
    email: repUser.email,
    displayName: repUser.displayName,
  };
  clean = await makeLead(ctx, { name: 'Cleo Clean' });
  dnc = await makeLead(ctx, { name: 'Donna DNC' });
  stopLead = await makeLead(ctx, { name: 'Stella Stop' });
  raceVictim = await makeLead(ctx, { name: 'Rae Race' });
  raceClean = await makeLead(ctx, { name: 'Rex Runner' });
  dayCap = await makeLead(ctx, { name: 'Daisy Daycap' });

  campaignId = await createDialCampaign(ctx, admin, {
    name: 'Compliance Gate',
    mode: 'power',
    settings: { callingWindowStart: '00:00', callingWindowEnd: '23:59', maxAttemptsPerDay: 1 },
  });
  await setPresence(ctx, ctx.seed.repId, 'available');
  const started = await startSessionApi(ctx, rep, campaignId);
  sessionId = started.session!.id;
});
afterAll(async () => {
  await ctx.close();
});

describe('C1 — a suppressed number is never selected', () => {
  it('selection marks the suppressed lead and dials the clean one', async () => {
    await attachByIds(ctx, admin, campaignId, [clean.leadId, dnc.leadId]);
    // Give the suppressed lead top priority — it would win, were it dialable.
    await ctx.dbh.db
      .update(schema.campaignLeads)
      .set({ priority: 10 })
      .where(
        and(eq(schema.campaignLeads.campaignId, campaignId), eq(schema.campaignLeads.leadId, dnc.leadId)),
      );
    await ctx.dbh.db.insert(schema.suppressionRecords).values({
      orgId: ctx.seed.orgId,
      phoneE164: dnc.phone,
      scope: 'org',
      channel: 'all',
      reason: 'dnc_disposition',
    });

    const result = await nextApi(ctx, rep, sessionId);
    expect(result.idle).toBe(false);
    expect(result.lines![0]!.call.to_number).toBe(clean.phone);

    expect(await callsTo(dnc.phone)).toHaveLength(0); // NEVER dialed
    const cl = await campaignLeadRow(ctx, campaignId, dnc.leadId);
    expect(cl.status).toBe('suppressed');
    expect(cl.lastOutcome).toBe('suppressed');

    await finishCall(result.lines![0]!.call.id, clean.phone, 'completed');
  });
});

describe('C2 — suppression landing mid-session', () => {
  it('a real STOP text arriving mid-session stops auto-dialing that lead', async () => {
    await attachByIds(ctx, admin, campaignId, [stopLead.leadId]);
    // The seller texts STOP to the org number through the real webhook path.
    const res = await webhookPost(
      ctx,
      '/webhooks/telnyx/inbound-sms',
      inboundSms({ sid: 'SM_p5_stop', from: stopLead.phone, to: '+15005550006', body: 'STOP' }),
    );
    expect(res.statusCode).toBe(200);
    await ctx.runner.drain();

    const result = await nextApi(ctx, rep, sessionId);
    expect(result.idle).toBe(true); // nothing else dialable right now

    expect(await callsTo(stopLead.phone)).toHaveLength(0); // NEVER dialed
    const cl = await campaignLeadRow(ctx, campaignId, stopLead.leadId);
    expect(cl.status).toBe('suppressed');
  });

  it('the dial-time re-check catches suppression that lands between selection and dial', async () => {
    await attachByIds(ctx, admin, campaignId, [raceVictim.leadId, raceClean.leadId]);
    await ctx.dbh.db
      .update(schema.campaignLeads)
      .set({ priority: 10 })
      .where(
        and(
          eq(schema.campaignLeads.campaignId, campaignId),
          eq(schema.campaignLeads.leadId, raceVictim.leadId),
        ),
      );

    // The race: selection saw a clean number; suppression lands before dial.
    let injected = false;
    const result = await sessionNext(ctx.deps, repCtx, sessionId, {
      _testBeforeDial: async () => {
        if (injected) return;
        injected = true;
        await ctx.dbh.db.insert(schema.suppressionRecords).values({
          orgId: ctx.seed.orgId,
          phoneE164: raceVictim.phone,
          scope: 'org',
          channel: 'all',
          reason: 'manual',
        });
      },
    });

    expect(result.idle).toBe(false);
    if (!result.idle) {
      expect(result.lines[0]!.call.toNumber).toBe(raceClean.phone); // moved on
    }
    expect(await callsTo(raceVictim.phone)).toHaveLength(0); // NEVER dialed
    const cl = await campaignLeadRow(ctx, campaignId, raceVictim.leadId);
    expect(cl.status).toBe('suppressed');

    const audit = await ctx.dbh.db
      .select()
      .from(schema.auditLog)
      .where(eq(schema.auditLog.action, 'campaign_lead.suppressed'));
    expect(
      audit.some((a) => (a.metadata as { stage?: string }).stage === 'dial_time'),
    ).toBe(true);

    if (!result.idle) await finishCall(result.lines[0]!.call.id, raceClean.phone, 'completed');
  });
});

describe('C5 — attempt caps across days', () => {
  it('the per-day cap blocks a second same-day dial; yesterday’s dial does not count', async () => {
    await attachByIds(ctx, admin, campaignId, [dayCap.leadId]);
    const first = await nextApi(ctx, rep, sessionId);
    expect(first.idle).toBe(false);
    expect(first.lines![0]!.call.to_number).toBe(dayCap.phone);
    await finishCall(first.lines![0]!.call.id, dayCap.phone, 'no-answer');

    // Make the lead immediately eligible again — only the day cap should block.
    await ctx.dbh.db
      .update(schema.campaignLeads)
      .set({ status: 'pending', nextAttemptAt: null })
      .where(
        and(
          eq(schema.campaignLeads.campaignId, campaignId),
          eq(schema.campaignLeads.leadId, dayCap.leadId),
        ),
      );
    const blocked = await nextApi(ctx, rep, sessionId);
    expect(blocked.idle).toBe(true);
    expect(blocked.reason).toBe('waiting_retries');
    expect(await callsTo(dayCap.phone)).toHaveLength(1); // no second dial today

    // A new local day: the earlier dial rolls out of today's count.
    await ctx.dbh.db.execute(sql`
      UPDATE calls SET created_at = created_at - interval '25 hours'
      WHERE to_number = ${dayCap.phone}`);
    const nextDay = await nextApi(ctx, rep, sessionId);
    expect(nextDay.idle).toBe(false);
    expect(nextDay.lines![0]!.call.to_number).toBe(dayCap.phone);
    const cl = await campaignLeadRow(ctx, campaignId, dayCap.leadId);
    expect(cl.attempts).toBe(2);
    await finishCall(nextDay.lines![0]!.call.id, dayCap.phone, 'no-answer');
  });

  it('the total attempt cap makes a lead undialable for good', async () => {
    await ctx.dbh.db
      .update(schema.campaignLeads)
      .set({ status: 'pending', nextAttemptAt: null, attempts: 8 })
      .where(
        and(
          eq(schema.campaignLeads.campaignId, campaignId),
          eq(schema.campaignLeads.leadId, dayCap.leadId),
        ),
      );
    const before = (await callsTo(dayCap.phone)).length;
    const result = await nextApi(ctx, rep, sessionId);
    expect(result.idle).toBe(true);
    expect((await callsTo(dayCap.phone)).length).toBe(before); // never redialed
  });
});

describe('C3 — calling window blocks selection', () => {
  it('outside the window the session goes idle with an explicit reason; opening the window dials', async () => {
    // Separate campaign whose window is 2h–4h from now (org tz): now is outside.
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/dial-sessions/${sessionId}/end`,
      headers: rep,
      payload: {},
    });
    const windowLead = await makeLead(ctx, { name: 'Wanda Window' });
    const windowCampaign = await createDialCampaign(ctx, admin, {
      name: 'Window Watch',
      mode: 'power',
      settings: { callingWindowStart: hhmmInNY(2), callingWindowEnd: hhmmInNY(4) },
    });
    await attachByIds(ctx, admin, windowCampaign, [windowLead.leadId]);
    const started = await startSessionApi(ctx, rep, windowCampaign);
    expect(started.statusCode).toBe(201);
    const wSession = started.session!.id;

    const blocked = await nextApi(ctx, rep, wSession);
    expect(blocked.idle).toBe(true);
    expect(blocked.reason).toBe('outside_calling_window');
    expect(await callsTo(windowLead.phone)).toHaveLength(0); // no after-hours dial

    // The session stays active and usable — idle is a state, not an error.
    const detail = await ctx.app.inject({
      method: 'GET',
      url: `/v1/dial-sessions/${wSession}`,
      headers: rep,
    });
    expect((detail.json() as { session: { state: string } }).session.state).toBe('active');

    // The window opens (admin fixes the config): dialing resumes.
    await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/campaigns/${windowCampaign}`,
      headers: admin,
      payload: { settings: { callingWindowStart: hhmmInNY(-1), callingWindowEnd: hhmmInNY(2) } },
    });
    const open = await nextApi(ctx, rep, wSession);
    expect(open.idle).toBe(false);
    expect(open.lines![0]!.call.to_number).toBe(windowLead.phone);
  });
});
