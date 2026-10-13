/**
 * Call flows end to end through real HTTP + Postgres + worker: the flow saved
 * over the API, the TwiML each strategy emits, the /twiml/flow continuation,
 * the missed-call auto-text, the simulator, and importing a carrier number.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { authHeader, createTestContext, webhookPost, type TestContext, rungUsers } from './helpers.js';
import { provisionBrowserCredentials } from '../src/services/provision.js';

let ctx: TestContext;
let admin: Record<string, string>;
let bellaId: string;
let flowNumberId: string;
const FLOW_NUMBER = '+15005550020';
const SELLER = '+15005550009'; // seeded contact "Sally Seller"
const STRANGER = '+16145550077';

beforeAll(async () => {
  ctx = await createTestContext();
  admin = await authHeader('auth-admin-test-org');
  const { db } = ctx.dbh;
  bellaId = (
    await db.insert(schema.users).values({ orgId: ctx.seed.orgId, email: 'bella@test-org.test', displayName: 'Bella Rep', role: 'rep', authUserId: 'auth-bella' }).returning()
  )[0]!.id;
  // Reps added after the harness minted credentials need theirs to be rung.
  await provisionBrowserCredentials(ctx.dbh, ctx.provider);
  flowNumberId = (
    await db.insert(schema.phoneNumbers).values({ orgId: ctx.seed.orgId, phoneE164: FLOW_NUMBER, providerNumberId: 'PN_flow', capabilities: { voice: true, sms: true, mms: false } }).returning()
  )[0]!.id;
  for (const userId of [ctx.seed.repId, bellaId, ctx.seed.adminId]) {
    await db.insert(schema.agentPresence).values({ userId, orgId: ctx.seed.orgId, status: 'available', lastSeenAt: new Date() })
      .onConflictDoUpdate({ target: schema.agentPresence.userId, set: { status: 'available', lastSeenAt: new Date() } });
  }
  // Texts are allowed around the clock here; quiet hours have their own tests.
  await db.update(schema.organizations).set({ settings: { smsSendWindowStart: '00:00', smsSendWindowEnd: '00:00' } }).where(eq(schema.organizations.id, ctx.seed.orgId));
});
afterAll(async () => ctx.close());

async function saveFlow(flow: unknown) {
  return ctx.app.inject({ method: 'PUT', url: `/v1/numbers/${flowNumberId}/routing`, headers: admin, payload: { flow } });
}

function inbound(sid: string, from = STRANGER) {
  return { AccountSid: 'ACtest00000000000000000000000000', CallSid: sid, CallStatus: 'ringing', From: from, To: FLOW_NUMBER, Direction: 'inbound', ApiVersion: '2010-04-01' };
}

async function callBySid(sid: string) {
  return (await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.providerCallId, sid)))[0]!;
}

function flowPath(body: string): string {
  const m = /action="([^"]*\/twiml\/flow[^"]*)"/.exec(body);
  return m ? m[1]!.replace(/&amp;/g, '&').replace('https://talkr.test', '') : '';
}


describe('saving a flow', () => {
  it('refuses loops and people from another workspace, with every error', async () => {
    const res = await saveFlow({
      version: 2,
      start: 'a',
      nodes: {
        a: { type: 'ring', strategy: 'all', targets: [{ kind: 'user', user_id: '99999999-9999-4999-8999-999999999999' }], no_answer: 'b' },
        b: { type: 'menu', greeting: { tts: 'Press 1' }, options: { '1': 'a' }, no_input: null },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().errors.join('\n')).toContain('loop');
    const people = await saveFlow({ version: 2, start: 'a', nodes: { a: { type: 'ring', strategy: 'all', targets: [{ kind: 'user', user_id: '99999999-9999-4999-8999-999999999999' }], no_answer: null } } });
    expect(people.json().errors.join('\n')).toContain('is not on this team');
  });
});

describe('ring-all', () => {
  it('rings every chosen rep in one Dial and journals the path', async () => {
    expect((await saveFlow({ version: 2, start: 'all', nodes: { all: { type: 'ring', strategy: 'all', targets: [{ kind: 'everyone' }], timeout_seconds: 20, no_answer: null } } })).statusCode).toBe(200);
    const res = await webhookPost(ctx, '/twiml/inbound', inbound('CA_flow_all'));
    expect(res.statusCode).toBe(200);
    expect((await rungUsers(ctx, res.body)).sort()).toEqual([ctx.seed.adminId, ctx.seed.repId, bellaId].sort());
    expect(res.body).toContain('timeout="20"');
    expect(flowPath(res.body)).toContain('node=all');
    const call = await callBySid('CA_flow_all');
    const events = await ctx.dbh.db.select().from(schema.callEvents).where(eq(schema.callEvents.callId, call.id));
    expect(events.some((e) => e.eventType === 'call.flow_path')).toBe(true);
  });
});

describe('sequential with a personal-phone fallback', () => {
  it('rings Riley, then Bella, then Riley’s own phone, then voicemail', async () => {
    await ctx.dbh.db.update(schema.users).set({ personalPhoneE164: '+12105550199' }).where(eq(schema.users.id, ctx.seed.repId));
    await saveFlow({
      version: 2,
      start: 'seq',
      recording: false,
      nodes: {
        seq: { type: 'ring', strategy: 'sequential', targets: [{ kind: 'user', user_id: ctx.seed.repId }, { kind: 'user', user_id: bellaId }], timeout_seconds: 15, no_answer: 'cell' },
        cell: { type: 'forward', to: { kind: 'personal', user_id: ctx.seed.repId }, no_answer: 'vm' },
        vm: { type: 'voicemail', greeting: { tts: 'Riley will call you back.' } },
      },
    });
    const first = await webhookPost(ctx, '/twiml/inbound', inbound('CA_flow_seq'));
    expect(await rungUsers(ctx, first.body)).toEqual([ctx.seed.repId]);
    expect(first.body).not.toContain('record=');

    const second = await webhookPost(ctx, flowPath(first.body), { CallSid: 'CA_flow_seq', CallStatus: 'in-progress', DialCallStatus: 'no-answer' });
    expect(await rungUsers(ctx, second.body)).toEqual([bellaId]);

    const third = await webhookPost(ctx, flowPath(second.body), { CallSid: 'CA_flow_seq', CallStatus: 'in-progress', DialCallStatus: 'no-answer' });
    expect(third.body).toContain('+12105550199</Number>');

    const fourth = await webhookPost(ctx, flowPath(third.body), { CallSid: 'CA_flow_seq', CallStatus: 'in-progress', DialCallStatus: 'busy' });
    expect(fourth.body).toContain('Riley will call you back.');
    expect(fourth.body).toContain('<Record');
  });
});

describe('after hours', () => {
  it('goes to voicemail and texts the caller once per cooldown', async () => {
    await saveFlow({
      version: 2,
      start: 'hours',
      nodes: {
        hours: { type: 'hours', timezone: 'America/Chicago', schedule: {}, holidays: [], open: 'ring', closed: 'vm' },
        ring: { type: 'ring', strategy: 'all', targets: [{ kind: 'everyone' }], no_answer: null },
        vm: { type: 'voicemail' },
      },
      voicemail_greeting: { tts: 'Your Company is closed right now.' },
      missed_call_text: { enabled: true, body: 'Hi {first_name}, sorry we missed you. We will call back first thing.', cooldown_hours: 24 },
    });
    const res = await webhookPost(ctx, '/twiml/inbound', inbound('CA_flow_night', SELLER));
    expect(res.body).toContain('Your Company is closed right now.');
    expect(res.body).toContain('<Record');

    const drainNow = async () => {
      await ctx.dbh.db.execute(sql`UPDATE jobs SET run_at = now() WHERE job_type = 'missed-call-text'`);
      await ctx.runner.drain();
    };
    await drainNow();
    const texts = ctx.sentMessages.filter((m) => m.to === SELLER);
    expect(texts).toHaveLength(1);
    expect(texts[0]!.from).toBe(FLOW_NUMBER);
    expect(texts[0]!.body).toBe('Hi Sally, sorry we missed you. We will call back first thing.');

    // The same seller calling again inside the cooldown is not texted twice.
    await webhookPost(ctx, '/twiml/inbound', inbound('CA_flow_night2', SELLER));
    await drainNow();
    expect(ctx.sentMessages.filter((m) => m.to === SELLER)).toHaveLength(1);
    expect(((await callBySid('CA_flow_night2')).raw as { missedCallTextSkipped?: string }).missedCallTextSkipped).toBe('cooldown');
  });
});

describe('IVR menu', () => {
  it('press 2 rings Bella; silence twice hangs up', async () => {
    await saveFlow({
      version: 2,
      start: 'menu',
      announce: 'Calls are recorded.',
      nodes: {
        menu: { type: 'menu', greeting: { tts: 'Press 1 for sales, 2 for Bella.' }, options: { '1': 'sales', '2': 'bella' }, repeat: 1, no_input: 'bye' },
        sales: { type: 'ring', strategy: 'all', targets: [{ kind: 'everyone' }], no_answer: null },
        bella: { type: 'ring', strategy: 'sequential', targets: [{ kind: 'user', user_id: bellaId }], no_answer: null },
        bye: { type: 'hangup', message: 'Goodbye.' },
      },
    });
    const announced = await webhookPost(ctx, '/twiml/inbound', inbound('CA_flow_ivr'));
    expect(announced.body).toContain('Calls are recorded.');
    const redirect = /<Redirect[^>]*>([^<]+)<\/Redirect>/.exec(announced.body)![1]!.replace(/&amp;/g, '&').replace('https://talkr.test', '');

    const menu = await webhookPost(ctx, redirect, { CallSid: 'CA_flow_ivr', CallStatus: 'in-progress' });
    expect(menu.body).toContain('<Gather');
    expect(menu.body).toContain('Press 1 for sales');

    const pressed = await webhookPost(ctx, flowPath(menu.body), { CallSid: 'CA_flow_ivr', CallStatus: 'in-progress', Digits: '2' });
    expect(await rungUsers(ctx, pressed.body)).toEqual([bellaId]);

    const silent = await webhookPost(ctx, flowPath(menu.body), { CallSid: 'CA_flow_ivr', CallStatus: 'in-progress' });
    expect(silent.body).toContain('<Gather');
    const gone = await webhookPost(ctx, flowPath(silent.body), { CallSid: 'CA_flow_ivr', CallStatus: 'in-progress' });
    expect(gone.body).toContain('Goodbye.');
    expect(gone.body).toContain('<Hangup');
  });
});

describe('simulator', () => {
  it('walks a draft for a chosen time and caller without saving it', async () => {
    const draft = {
      version: 2,
      start: 'hours',
      nodes: {
        hours: { type: 'hours', timezone: 'America/Chicago', schedule: { mon: [['09:00', '17:00']] }, holidays: [], open: 'ring', closed: 'vm' },
        ring: { type: 'ring', strategy: 'sequential', targets: [{ kind: 'lead_owner' }, { kind: 'user', user_id: bellaId }], no_answer: 'vm' },
        vm: { type: 'voicemail' },
      },
    };
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/numbers/${flowNumberId}/routing/simulate`,
      headers: admin,
      payload: { flow: draft, at: '2026-09-14T15:00:00Z', from: SELLER, answered_by: bellaId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ valid: true, outcome: 'answered' });
    expect(res.json().path.map((p: { detail: string }) => p.detail)).toEqual(['Open', 'Rings one person (in order)', 'No answer', 'Rings one person (in order)', 'Answered']);

    const bad = await ctx.app.inject({ method: 'POST', url: `/v1/numbers/${flowNumberId}/routing/simulate`, headers: admin, payload: { flow: { version: 2, start: 'x', nodes: {} } } });
    expect(bad.json()).toMatchObject({ valid: false });
  });
});

describe('import from the carrier', () => {
  it('adopts a number the account owns, idempotently, and 404s one it does not', async () => {
    const deps = ctx.provider as unknown as { importNumber?: (e: string) => Promise<unknown> };
    // The fake carrier owns exactly one extra number.
    deps.importNumber = async (e164: string) =>
      e164 === '+13465550190' ? { providerNumberId: 'pn-346', phoneE164: e164, capabilities: { voice: true, sms: true, mms: false } } : null;

    const first = await ctx.app.inject({ method: 'POST', url: '/v1/numbers/import', headers: admin, payload: { phone_e164: '+13465550190', assigned_user_id: bellaId } });
    expect(first.statusCode).toBe(201);
    expect(first.json().number).toMatchObject({ phone_e164: '+13465550190', assigned_user_id: bellaId, status: 'active', area_code: '346' });
    const again = await ctx.app.inject({ method: 'POST', url: '/v1/numbers/import', headers: admin, payload: { phone_e164: '+13465550190' } });
    expect(again.statusCode).toBe(200);
    expect(again.json()).toMatchObject({ already_imported: true, number: { assigned_user_id: bellaId } });
    const missing = await ctx.app.inject({ method: 'POST', url: '/v1/numbers/import', headers: admin, payload: { phone_e164: '+13465550000' } });
    expect(missing.statusCode).toBe(404);
  });
});

describe('a rep’s own voicemail greeting', () => {
  it('is self-service on /v1/me, validated, and clearable', async () => {
    const rep = await authHeader('auth-rep-test-org');
    const greeting = { tts: 'You reached Riley. Leave a message.' };
    const saved = await ctx.app.inject({ method: 'PATCH', url: '/v1/me', headers: rep, payload: { voicemail_greeting: greeting } });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().voicemail_greeting).toEqual(greeting);
    expect((await ctx.app.inject({ method: 'GET', url: '/v1/me', headers: rep })).json().voicemail_greeting).toEqual(greeting);

    const empty = await ctx.app.inject({ method: 'PATCH', url: '/v1/me', headers: rep, payload: { voicemail_greeting: { tts: ' ' } } });
    expect(empty.statusCode).toBe(400);

    const cleared = await ctx.app.inject({ method: 'PATCH', url: '/v1/me', headers: rep, payload: { voicemail_greeting: null } });
    expect(cleared.json().voicemail_greeting).toBeNull();
  });
});
