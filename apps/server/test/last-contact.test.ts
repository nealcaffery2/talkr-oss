/**
 * Last-contact routing end to end (docs/inbound-routing.md §10): a partner
 * posts the outreach Talkr cannot see (POST /v1/outreach, /v1/outreach/batch)
 * with the per-rep token CLOZR already mints, and a callback to a pool number
 * rings the rep who last reached out — calls and texts from Talkr's own
 * records count too — then falls through to the usual chain.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { SignJWT } from 'jose';
import { schema } from '@talkr/db';
import { authHeader, createTestContext, rungUsers, webhookPost, type TestContext } from './helpers.js';
import { provisionBrowserCredentials } from '../src/services/provision.js';

const PARTNER_SECRET = 'clozr-partner-secret-clozr-partner';
const ISSUER = 'https://clozr-project.supabase.co/auth/v1';
const POOL_NUMBER = '+15005550030';
const FLOW_NUMBER = '+15005550031';
const SELLER = '+15005550009'; // seeded contact; lead owned by the seeded rep
const DAY = 86_400_000;

let ctx: TestContext;
let rep: Record<string, string>;
let admin: Record<string, string>;
let danaId: string;
let pooledId: string;
let flowId: string;

/** What CLOZR's dispo-campaign-tick mints: HS256 with TALKR_PARTNER_JWT_SECRET, iss = its Supabase auth URL, sub = its user id. */
async function clozrToken(sub: string, email?: string) {
  const token = await new SignJWT({ sub, aud: 'authenticated', role: 'authenticated', ...(email ? { email } : {}) })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setIssuer(ISSUER)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(new TextEncoder().encode(PARTNER_SECRET));
  return { authorization: `Bearer ${token}` };
}

async function setPresence(userId: string, status: string) {
  await ctx.dbh.db
    .insert(schema.agentPresence)
    .values({ userId, orgId: ctx.seed.orgId, status, lastSeenAt: new Date() })
    .onConflictDoUpdate({ target: schema.agentPresence.userId, set: { status, lastSeenAt: new Date() } });
}

function inbound(sid: string, to = POOL_NUMBER, from = SELLER) {
  return { AccountSid: 'ACtest00000000000000000000000000', CallSid: sid, CallStatus: 'ringing', From: from, To: to, Direction: 'inbound', ApiVersion: '2010-04-01' };
}

async function callBySid(sid: string) {
  return (await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.providerCallId, sid)))[0]!;
}

async function endCall(sid: string) {
  await ctx.dbh.db.update(schema.calls).set({ endedAt: new Date(), status: 'completed' }).where(eq(schema.calls.providerCallId, sid));
}

beforeAll(async () => {
  ctx = await createTestContext({ config: { PARTNER_JWT_SECRET: PARTNER_SECRET, PARTNER_JWT_ISSUER: ISSUER } });
  rep = await authHeader('auth-rep-test-org');
  admin = await authHeader('auth-admin-test-org');
  const { db } = ctx.dbh;
  danaId = (
    await db.insert(schema.users).values({ orgId: ctx.seed.orgId, email: 'dana@test-org.test', displayName: 'Dana Rep', role: 'rep', authUserId: 'auth-dana' }).returning()
  )[0]!.id;
  await provisionBrowserCredentials(ctx.dbh, ctx.provider);
  pooledId = (
    await db.insert(schema.phoneNumbers).values({ orgId: ctx.seed.orgId, phoneE164: POOL_NUMBER, providerNumberId: 'PN_pool', capabilities: { voice: true, sms: true, mms: false } }).returning()
  )[0]!.id;
  flowId = (
    await db.insert(schema.phoneNumbers).values({ orgId: ctx.seed.orgId, phoneE164: FLOW_NUMBER, providerNumberId: 'PN_pool2', capabilities: { voice: true, sms: true, mms: false } }).returning()
  )[0]!.id;
  for (const id of [ctx.seed.repId, ctx.seed.adminId, danaId]) await setPresence(id, 'available');
});
afterAll(async () => ctx.close());

describe('POST /v1/outreach', () => {
  it('refuses a request without a token', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/v1/outreach', payload: { phone_e164: SELLER, channel: 'rvm', occurred_at: new Date().toISOString() } });
    expect(res.statusCode).toBe(401);
    const wrong = await ctx.app.inject({
      method: 'POST', url: '/v1/outreach/batch', payload: [],
      headers: { authorization: 'Bearer not-a-token' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it('accepts the partner token CLOZR mints, scoped to the rep, idempotent on ref', async () => {
    const dana = await clozrToken('clozr-dana', 'dana@test-org.test');
    const body = { phone_e164: '(500) 555-0009', channel: 'rvm', occurred_at: new Date(Date.now() - 2 * DAY).toISOString(), ref: 'rvm_drop:41' };
    const first = await ctx.app.inject({ method: 'POST', url: '/v1/outreach', headers: dana, payload: body });
    expect(first.statusCode).toBe(201);
    expect(first.json()).toMatchObject({ status: 'created', ref: 'rvm_drop:41' });
    const again = await ctx.app.inject({ method: 'POST', url: '/v1/outreach', headers: dana, payload: { ...body, occurred_at: new Date().toISOString() } });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({ id: first.json().id, status: 'duplicate', ref: 'rvm_drop:41' });

    const rows = await ctx.dbh.db.select().from(schema.outreachEvents).where(eq(schema.outreachEvents.ref, 'rvm_drop:41'));
    expect(rows).toHaveLength(1);
    // Normalized exactly like an inbound caller; owned by the token's rep and org.
    expect(rows[0]).toMatchObject({ phoneE164: SELLER, userId: danaId, orgId: ctx.seed.orgId, channel: 'rvm' });
  });

  it('maps a partner user id to the Talkr user; someone else’s touch needs a manager', async () => {
    const forDana = { phone_e164: '+12105550101', user_id: 'clozr-dana', channel: 'email', occurred_at: new Date().toISOString(), ref: 'email:1' };
    const asRep = await ctx.app.inject({ method: 'POST', url: '/v1/outreach', headers: rep, payload: forDana });
    expect(asRep.statusCode).toBe(403);
    expect(asRep.json().error).toBe('forbidden_user');
    const asAdmin = await ctx.app.inject({ method: 'POST', url: '/v1/outreach', headers: admin, payload: forDana });
    expect(asAdmin.statusCode).toBe(201);
    const row = (await ctx.dbh.db.select().from(schema.outreachEvents).where(eq(schema.outreachEvents.ref, 'email:1')))[0]!;
    expect(row.userId).toBe(danaId);
    expect(row.createdBy).toBe(ctx.seed.adminId);
    // A Talkr users.id works as is; a stranger does not.
    const byTalkrId = await ctx.app.inject({ method: 'POST', url: '/v1/outreach', headers: admin, payload: { ...forDana, user_id: danaId, ref: 'email:2' } });
    expect(byTalkrId.statusCode).toBe(201);
    const unknown = await ctx.app.inject({ method: 'POST', url: '/v1/outreach', headers: admin, payload: { ...forDana, user_id: 'clozr-nobody', ref: 'email:3' } });
    expect(unknown.statusCode).toBe(422);
    const badChannel = await ctx.app.inject({ method: 'POST', url: '/v1/outreach', headers: admin, payload: { ...forDana, channel: 'carrier-pigeon' } });
    expect(badChannel.statusCode).toBe(400);
  });

  it('batch: each item on its own, duplicates reported, capped at 500', async () => {
    const at = new Date(Date.now() - 20 * DAY).toISOString();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/outreach/batch',
      headers: admin,
      payload: {
        events: [
          { phone_e164: '+12105550201', channel: 'rvm', occurred_at: at, ref: 'blast:1' },
          { phone_e164: '+12105550202', channel: 'rvm', occurred_at: at, ref: 'blast:2' },
          { phone_e164: '+12105550202', channel: 'rvm', occurred_at: at, ref: 'blast:2' },
          { phone_e164: 'not a phone', channel: 'rvm', occurred_at: at, ref: 'blast:3' },
          { phone_e164: '+12105550204', channel: 'other', occurred_at: at },
          { phone_e164: '+12105550205', channel: 'rvm', occurred_at: at, ref: 'rvm_drop:41' },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ created: 3, duplicate: 2, rejected: 1 });
    expect(body.results.map((r: { status: string }) => r.status)).toEqual(['created', 'created', 'duplicate', 'rejected', 'created', 'duplicate']);
    expect(body.results[2].id).toBe(body.results[1].id);
    expect(body.results[3].error).toBe('invalid_phone');
    // Replaying the whole blast creates nothing.
    const replay = await ctx.app.inject({ method: 'POST', url: '/v1/outreach/batch', headers: admin, payload: [{ phone_e164: '+12105550201', channel: 'rvm', occurred_at: at, ref: 'blast:1' }] });
    expect(replay.json()).toMatchObject({ created: 0, duplicate: 1 });

    const tooMany = Array.from({ length: 501 }, (_, i) => ({ phone_e164: '+12105550299', channel: 'rvm', occurred_at: at, ref: `big:${i}` }));
    expect((await ctx.app.inject({ method: 'POST', url: '/v1/outreach/batch', headers: admin, payload: tooMany })).statusCode).toBe(400);
  });
});

describe('a callback to a pool number', () => {
  it('rings the lead owner while the number has last-contact routing off', async () => {
    const res = await webhookPost(ctx, '/twiml/inbound', inbound('CA_lc_off'));
    expect(await rungUsers(ctx, res.body)).toEqual([ctx.seed.repId]);
    expect((await callBySid('CA_lc_off')).raw).toMatchObject({ routing: { reason: 'lead_owner' } });
    await endCall('CA_lc_off');
  });

  it('an admin turns it on from the number settings', async () => {
    expect((await ctx.app.inject({ method: 'PATCH', url: `/v1/numbers/${pooledId}`, headers: rep, payload: { route_callbacks_to_last_contact: true } })).statusCode).toBe(403);
    const res = await ctx.app.inject({ method: 'PATCH', url: `/v1/numbers/${pooledId}`, headers: admin, payload: { route_callbacks_to_last_contact: true } });
    expect(res.statusCode).toBe(200);
    expect(res.json().number.route_callbacks_to_last_contact).toBe(true);
    const list = await ctx.app.inject({ method: 'GET', url: '/v1/numbers', headers: admin });
    expect(list.json().numbers.find((n: { id: string }) => n.id === pooledId).route_callbacks_to_last_contact).toBe(true);
  });

  it('rings the rep whose RVM reached them, and tells the answering browser why', async () => {
    const res = await webhookPost(ctx, '/twiml/inbound', inbound('CA_lc_rvm'));
    expect(await rungUsers(ctx, res.body)).toEqual([danaId]);
    const call = await callBySid('CA_lc_rvm');
    expect(call.userId).toBe(danaId);
    expect(call.raw).toMatchObject({ routedVia: 'last_contact', routing: { reason: 'last_contact' }, lastContact: { user_id: danaId, channel: 'rvm', ref: 'rvm_drop:41' } });

    const danaAuth = await authHeader('auth-dana');
    const ringing = await ctx.app.inject({ method: 'GET', url: `/v1/calls/ringing?from=${encodeURIComponent(SELLER)}`, headers: danaAuth });
    expect(ringing.statusCode).toBe(200);
    expect(ringing.json().call.routing).toMatchObject({ reason: 'last_contact', last_contact: { user_id: danaId, channel: 'rvm' } });
    expect(Date.parse(ringing.json().call.routing.last_contact.occurred_at)).toBeLessThan(Date.now() - DAY);
    await endCall('CA_lc_rvm');
  });

  it('a newer Talkr call or text by someone else wins', async () => {
    const { db } = ctx.dbh;
    await db.insert(schema.calls).values({
      orgId: ctx.seed.orgId, direction: 'outbound', status: 'completed', userId: ctx.seed.adminId,
      phoneNumberId: ctx.seed.phoneNumberId, fromNumber: '+15005550006', toNumber: SELLER, createdAt: new Date(Date.now() - DAY),
    });
    const res = await webhookPost(ctx, '/twiml/inbound', inbound('CA_lc_call'));
    expect(await rungUsers(ctx, res.body)).toEqual([ctx.seed.adminId]);
    expect((await callBySid('CA_lc_call')).raw).toMatchObject({ lastContact: { user_id: ctx.seed.adminId, channel: 'call' } });
    await endCall('CA_lc_call');

    const [conv] = await db.insert(schema.conversations).values({ orgId: ctx.seed.orgId, ourNumber: POOL_NUMBER, theirNumber: SELLER, phoneNumberId: pooledId }).returning();
    await db.insert(schema.messages).values({
      orgId: ctx.seed.orgId, conversationId: conv!.id, direction: 'outbound', status: 'delivered', body: 'Still thinking about selling?',
      createdBy: danaId, sentAt: new Date(Date.now() - 3_600_000), createdAt: new Date(Date.now() - 3_600_000),
    });
    const sms = await webhookPost(ctx, '/twiml/inbound', inbound('CA_lc_sms'));
    expect(await rungUsers(ctx, sms.body)).toEqual([danaId]);
    expect((await callBySid('CA_lc_sms')).raw).toMatchObject({ lastContact: { user_id: danaId, channel: 'sms' } });
    await endCall('CA_lc_sms');
  });

  it('skips a toucher who is offline, and falls through to the lead owner when none is in', async () => {
    await setPresence(danaId, 'offline');
    const next = await webhookPost(ctx, '/twiml/inbound', inbound('CA_lc_presence'));
    expect(await rungUsers(ctx, next.body)).toEqual([ctx.seed.adminId]);
    await endCall('CA_lc_presence');

    await setPresence(ctx.seed.adminId, 'offline');
    const owner = await webhookPost(ctx, '/twiml/inbound', inbound('CA_lc_fallthrough'));
    expect(await rungUsers(ctx, owner.body)).toEqual([ctx.seed.repId]);
    const call = await callBySid('CA_lc_fallthrough');
    expect(call.raw).toMatchObject({ routing: { reason: 'lead_owner' } });
    expect((call.raw as Record<string, unknown>).lastContact).toBeUndefined();
    await endCall('CA_lc_fallthrough');
    await setPresence(danaId, 'available');
    await setPresence(ctx.seed.adminId, 'available');
  });

  it('a caller nobody touched in the window rings the usual chain', async () => {
    // +12105550201 only has a blast RVM from 20 days ago; it is nobody's lead.
    const res = await webhookPost(ctx, '/twiml/inbound', inbound('CA_lc_stale', POOL_NUMBER, '+12105550201'));
    expect(await callBySid('CA_lc_stale')).toMatchObject({ raw: { routing: { action: 'voicemail', reason: 'no_agents' } } });
    expect(res.body).not.toContain('<Sip');
  });
});

describe('a call flow with a last_contact step', () => {
  it('rings the latest toucher, then moves on to the owner', async () => {
    const save = await ctx.app.inject({
      method: 'PUT',
      url: `/v1/numbers/${flowId}/routing`,
      headers: admin,
      payload: {
        flow: {
          version: 2,
          start: 'callback',
          nodes: {
            callback: { type: 'ring', strategy: 'sequential', targets: [{ kind: 'last_contact', within_days: 7 }, { kind: 'lead_owner' }], timeout_seconds: 20, no_answer: null },
          },
        },
      },
    });
    expect(save.statusCode).toBe(200);
    const res = await webhookPost(ctx, '/twiml/inbound', inbound('CA_lc_flow', FLOW_NUMBER));
    expect(await rungUsers(ctx, res.body)).toEqual([danaId]); // the text an hour ago
    const call = await callBySid('CA_lc_flow');
    expect(call.raw).toMatchObject({ routedVia: 'last_contact', lastContact: { user_id: danaId, channel: 'sms' } });
    const events = await ctx.dbh.db.select().from(schema.callEvents).where(eq(schema.callEvents.callId, call.id));
    const path = events.find((e) => e.eventType === 'call.flow_path')?.payload as { path: Array<{ detail: string }> };
    expect(path.path.some((p) => p.detail.includes('last reached out by text'))).toBe(true);

    const action = /action="([^"]*\/twiml\/flow[^"]*)"/.exec(res.body)![1]!.replace(/&amp;/g, '&').replace('https://talkr.test', '');
    const next = await webhookPost(ctx, action, { CallSid: 'CA_lc_flow', DialCallStatus: 'no-answer', CallStatus: 'in-progress' });
    expect(await rungUsers(ctx, next.body)).toEqual([ctx.seed.repId]);
    await endCall('CA_lc_flow');
  });

  it('the simulator resolves last_contact for a test caller', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: `/v1/numbers/${flowId}/routing/simulate`, headers: admin, payload: { from: SELLER } });
    expect(res.statusCode).toBe(200);
    expect(res.json().path[0].detail).toContain('last reached out');
  });
});
