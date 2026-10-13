/**
 * Phase 5 progressive mode: disposition wrap-up enqueues campaign-advance
 * exactly once (dedupe-keyed; duplicates are no-ops), and the advance places
 * the next call server-side through the same `next` internals.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { createTestContext, webhookPost, type TestContext } from './helpers.js';
import { twimlOutbound, voiceStatus } from './fixtures/texml.js';
import {
  adminAuth,
  attachByIds,
  campaignLeadRow,
  createDialCampaign,
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
let campaignId: string;
let sessionId: string;
let lead1: MadeLead;
let lead2: MadeLead;
let firstCallId: string;

async function sessionCallIds(): Promise<string[]> {
  const rows = await ctx.dbh.db.execute(sql`
    SELECT id FROM calls WHERE raw->>'dialSessionId' = ${sessionId} ORDER BY created_at ASC`);
  return (rows.rows as Array<{ id: string }>).map((r) => r.id);
}

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await adminAuth();
  rep = await repAuth();
  lead1 = await makeLead(ctx, { name: 'Paula Progressive' });
  lead2 = await makeLead(ctx, { name: 'Quinn Queueup' });
  campaignId = await createDialCampaign(ctx, admin, {
    name: 'Progressive Push',
    mode: 'progressive',
    settings: { callingWindowStart: '00:00', callingWindowEnd: '23:59' },
  });
  await attachByIds(ctx, admin, campaignId, [lead1.leadId, lead2.leadId]);
  // Deterministic order: lead1 first.
  await ctx.dbh.db
    .update(schema.campaignLeads)
    .set({ priority: 5 })
    .where(
      and(
        eq(schema.campaignLeads.campaignId, campaignId),
        eq(schema.campaignLeads.leadId, lead1.leadId),
      ),
    );
  await setPresence(ctx, ctx.seed.repId, 'available');
  const started = await startSessionApi(ctx, rep, campaignId);
  sessionId = started.session!.id;
});
afterAll(async () => {
  await ctx.close();
});

describe('progressive auto-advance', () => {
  it('the rep opens the session with an explicit first next', async () => {
    const result = await nextApi(ctx, rep, sessionId);
    expect(result.idle).toBe(false);
    firstCallId = result.lines![0]!.call.id;
    expect(result.lines![0]!.call.to_number).toBe(lead1.phone);
  });

  it('completing + dispositioning the call enqueues exactly one campaign-advance job', async () => {
    await webhookPost(
      ctx,
      '/twiml/outbound-dial',
      twimlOutbound({ clientCallSid: 'CA_prog_client_1', talkrCallId: firstCallId, identity: ctx.seed.repId }),
    );
    const path = `/webhooks/telnyx/voice-status?call=${firstCallId}&leg=pstn`;
    await webhookPost(ctx, path, voiceStatus({ callSid: 'CA_prog_pstn_1', status: 'in-progress', sequence: 0, parentCallSid: 'CA_prog_client_1', to: lead1.phone }));
    await webhookPost(ctx, path, voiceStatus({ callSid: 'CA_prog_pstn_1', status: 'completed', sequence: 1, duration: 40, parentCallSid: 'CA_prog_client_1', to: lead1.phone }));
    await ctx.runner.drain();

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${firstCallId}/disposition`,
      headers: rep,
      payload: { disposition: 'not_interested' },
    });
    expect(res.statusCode).toBe(200);

    const jobs = await ctx.dbh.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.dedupeKey, `campaign-advance:${firstCallId}`));
    expect(jobs).toHaveLength(1);

    // Re-saving the disposition is a duplicate: the dedupe key makes the
    // second enqueue a silent no-op — still exactly one job row.
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${firstCallId}/disposition`,
      headers: rep,
      payload: { disposition: 'not_interested' },
    });
    const jobsAfter = await ctx.dbh.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.dedupeKey, `campaign-advance:${firstCallId}`));
    expect(jobsAfter).toHaveLength(1);
  });

  it('the advance applies the disposition outcome and places the next call automatically', async () => {
    await ctx.runner.drain(); // runs campaign-advance

    const cl1 = await campaignLeadRow(ctx, campaignId, lead1.leadId);
    expect(cl1.status).toBe('contacted'); // not_interested treats as conversation
    expect(cl1.lastOutcome).toBe('not_interested');

    const callIds = await sessionCallIds();
    expect(callIds).toHaveLength(2); // the advance dialed lead2
    const advanced = (
      await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.id, callIds[1]!))
    )[0]!;
    expect(advanced.toNumber).toBe(lead2.phone);
    expect(advanced.status).toBe('queued'); // waiting for the browser leg
    const cl2 = await campaignLeadRow(ctx, campaignId, lead2.leadId);
    expect(cl2.status).toBe('in_progress');
  });

  it('a re-run of the advance while its call is in flight is a no-op', async () => {
    // Simulate an at-least-once retry of the same job payload.
    const { campaignAdvance } = await import('../src/worker/dialer-handlers.js');
    await campaignAdvance(
      { ...ctx.deps, podio: ctx.podio, fetchRecordingMedia: undefined },
      {
        id: 'retry',
        payload: { callId: firstCallId },
        attempts: 2,
        maxAttempts: 8,
      } as never,
    );
    const callIds = await sessionCallIds();
    expect(callIds).toHaveLength(2); // still two — no double dial
  });

  it('pausing the session stops auto-advancement', async () => {
    const pause = await ctx.app.inject({
      method: 'POST',
      url: `/v1/dial-sessions/${sessionId}/pause`,
      headers: rep,
      payload: {},
    });
    expect(pause.statusCode).toBe(200);

    const callIds = await sessionCallIds();
    const secondCallId = callIds[1]!;
    await webhookPost(
      ctx,
      '/twiml/outbound-dial',
      twimlOutbound({ clientCallSid: 'CA_prog_client_2', talkrCallId: secondCallId, identity: ctx.seed.repId }),
    );
    const path = `/webhooks/telnyx/voice-status?call=${secondCallId}&leg=pstn`;
    await webhookPost(ctx, path, voiceStatus({ callSid: 'CA_prog_pstn_2', status: 'no-answer', sequence: 0, parentCallSid: 'CA_prog_client_2', to: lead2.phone }));
    await ctx.runner.drain();
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${secondCallId}/disposition`,
      headers: rep,
      payload: { disposition: 'no_answer' },
    });
    await ctx.runner.drain(); // advance runs, sees paused session, skips

    expect(await sessionCallIds()).toHaveLength(2); // no third call
    const cl2 = await campaignLeadRow(ctx, campaignId, lead2.leadId);
    expect(cl2.status).toBe('pending'); // outcome still applied
    expect(cl2.nextAttemptAt).not.toBeNull();
  });
});
