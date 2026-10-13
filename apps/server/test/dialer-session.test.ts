/**
 * Phase 5 session lifecycle: one active session per rep (DB-enforced),
 * pause stops advancement, end finalizes counters + releases stuck leads,
 * and predictive mode is designed-but-disabled (C8/C9).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { createTestContext, authHeader, type TestContext } from './helpers.js';
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
  setPresence,
  startSessionApi,
  type MadeLead,
} from './dialer-helpers.js';

let ctx: TestContext;
let admin: Record<string, string>;
let rep: Record<string, string>;
let repB: Record<string, string>;
let repBId: string;
let campaignId: string;
let sessionId: string;
let lead: MadeLead;

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await adminAuth();
  rep = await repAuth();
  const other = (
    await ctx.dbh.db
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
  repBId = other.id;
  repB = await authHeader('auth-repb-test-org');
  lead = await makeLead(ctx, { name: 'Lifecycle Lead' });
  campaignId = await createDialCampaign(ctx, admin, {
    name: 'Lifecycle Lap',
    mode: 'power',
    settings: { callingWindowStart: '00:00', callingWindowEnd: '23:59' },
  });
  await attachByIds(ctx, admin, campaignId, [lead.leadId]);
  await setPresence(ctx, ctx.seed.repId, 'available');
  await setPresence(ctx, repBId, 'available');
});
afterAll(async () => {
  await ctx.close();
});

describe('one active session per rep (C9)', () => {
  it('a second start for the same rep is refused by the database', async () => {
    const first = await startSessionApi(ctx, rep, campaignId);
    expect(first.statusCode).toBe(201);
    sessionId = first.session!.id;

    const second = await startSessionApi(ctx, rep, campaignId);
    expect(second.statusCode).toBe(409);

    // Another rep runs their own session concurrently just fine.
    const otherRep = await startSessionApi(ctx, repB, campaignId);
    expect(otherRep.statusCode).toBe(201);
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/dial-sessions/${otherRep.session!.id}/end`,
      headers: repB,
      payload: {},
    });
  });

  it("a rep cannot drive another rep's session", async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/dial-sessions/${sessionId}/next`,
      headers: repB,
      payload: {},
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('pause / resume / end', () => {
  it('pause blocks next; resume unblocks it', async () => {
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/dial-sessions/${sessionId}/pause`,
      headers: rep,
      payload: {},
    });
    const blocked = await nextApi(ctx, rep, sessionId);
    expect(blocked.statusCode).toBe(409);
    expect(blocked.error).toBe('session_not_active');

    await ctx.app.inject({
      method: 'POST',
      url: `/v1/dial-sessions/${sessionId}/resume`,
      headers: rep,
      payload: {},
    });
    const result = await nextApi(ctx, rep, sessionId);
    expect(result.statusCode).toBe(200);
    expect(result.idle).toBe(false); // dialed the lifecycle lead
  });

  it('end finalizes: counters stamped, queued call canceled, stuck lead released', async () => {
    // The just-dialed call is still queued (browser never connected).
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/dial-sessions/${sessionId}/end`,
      headers: rep,
      payload: {},
    });
    expect(res.statusCode).toBe(200);

    const session = await getSession(ctx, sessionId);
    expect(session.state).toBe('ended');
    expect(session.endedAt).not.toBeNull();
    expect(session.dialedCount).toBe(1);
    expect(session.connectedCount).toBe(0);

    const calls = await ctx.dbh.db
      .select()
      .from(schema.calls)
      .where(eq(schema.calls.toNumber, lead.phone));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.status).toBe('canceled'); // legal queued→canceled, journaled
    const events = await ctx.dbh.db
      .select()
      .from(schema.callEvents)
      .where(eq(schema.callEvents.callId, calls[0]!.id));
    expect(events.some((e) => e.eventType === 'call.canceled')).toBe(true);

    const cl = await campaignLeadRow(ctx, campaignId, lead.leadId);
    expect(cl.status).toBe('pending'); // released, workable by the next session

    // An ended session refuses everything but reading.
    const after = await nextApi(ctx, rep, sessionId);
    expect(after.statusCode).toBe(409);
    const rePause = await ctx.app.inject({
      method: 'POST',
      url: `/v1/dial-sessions/${sessionId}/pause`,
      headers: rep,
      payload: {},
    });
    expect(rePause.statusCode).toBe(409);

    // And the rep can start fresh.
    const fresh = await startSessionApi(ctx, rep, campaignId);
    expect(fresh.statusCode).toBe(201);
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/dial-sessions/${fresh.session!.id}/end`,
      headers: rep,
      payload: {},
    });
  });
});

describe('predictive is designed-but-disabled (C8)', () => {
  it('a predictive campaign can exist as a draft but never activate', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/v1/campaigns',
      headers: admin,
      payload: { name: 'Predictive Preview', mode: 'predictive' },
    });
    expect(created.statusCode).toBe(201);
    const predictiveId = (created.json() as { campaign: { id: string } }).campaign.id;

    const activate = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/campaigns/${predictiveId}`,
      headers: admin,
      payload: { status: 'active' },
    });
    expect(activate.statusCode).toBe(422);
    expect((activate.json() as { error: string }).error).toBe('predictive_disabled');

    // Even a force-activated row (bad migration, manual SQL) cannot host a
    // session while the flag is off.
    await ctx.dbh.db
      .update(schema.campaigns)
      .set({ status: 'active' })
      .where(eq(schema.campaigns.id, predictiveId));
    const start = await startSessionApi(ctx, rep, predictiveId);
    expect(start.statusCode).toBe(422);
  });
});
