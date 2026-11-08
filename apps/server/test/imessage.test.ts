/**
 * iMessage through Sendblue, end to end against real Postgres: channel choice
 * per line and recipient, cached lookups, SMS fallback, status callbacks up to
 * `read`, inbound iMessage filed under the Talkr line, and suppression still
 * in force (docs/messaging-channels.md).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { SendblueClient } from '@talkr/provider-sendblue';
import { authHeader, createTestContext, type TestContext } from './helpers.js';
import { sendblueCallbackToken } from '../src/services/channels.js';

const OUR_NUMBER = '+15005550006'; // seeded org number
const SB_LINE = '+15125554639'; // the Sendblue line the seeded number uses
const IPHONE = '+16145550101';
const ANDROID = '+16145550102';
const DOWNGRADED = '+16145550103';
const REFUSED = '+16145550104';
const WEBHOOK_SECRET = 'sb-webhook-secret-test';

/** What the fake Sendblue answers, and what it was asked. */
const sendblueCalls: Array<{ url: string; body: Record<string, unknown> | null }> = [];
const imessageUsers = new Set([IPHONE, DOWNGRADED, REFUSED]);
let handleSeq = 0;

const fakeSendblue = (async (url: string | URL | Request, init?: RequestInit) => {
  const u = new URL(String(url));
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null;
  sendblueCalls.push({ url: u.pathname + u.search, body });
  if (u.pathname === '/api/evaluate-service') {
    const n = u.searchParams.get('number')!;
    return new Response(JSON.stringify({ number: n, service: imessageUsers.has(n) ? 'iMessage' : 'SMS' }), { status: 200 });
  }
  if (u.pathname === '/api/send-message') {
    if (body?.number === REFUSED) {
      return new Response(JSON.stringify({ status: 'ERROR', error_code: 429, error_key: 'LINE_DAILY_LIMIT_REACHED' }), {
        status: 400,
      });
    }
    handleSeq += 1;
    return new Response(JSON.stringify({ message_handle: `sb-handle-${handleSeq}`, status: 'QUEUED' }), { status: 200 });
  }
  return new Response('unexpected sendblue call', { status: 599 });
}) as typeof fetch;

let ctx: TestContext;
let rep: Record<string, string>;
let admin: Record<string, string>;
let token: string;

beforeAll(async () => {
  const config = { SENDBLUE_API_KEY_ID: 'kid', SENDBLUE_API_SECRET: 'ksecret', SENDBLUE_WEBHOOK_SECRET: WEBHOOK_SECRET };
  ctx = await createTestContext({
    config,
    sendblue: new SendblueClient(
      { apiKeyId: 'kid', apiSecret: 'ksecret', webhookSecret: WEBHOOK_SECRET, apiBase: 'https://sendblue.test' },
      fakeSendblue,
    ),
  });
  token = sendblueCallbackToken(ctx.deps.config)!;
  rep = await authHeader('auth-rep-test-org');
  admin = await authHeader('auth-admin-test-org');
  await ctx.dbh.db
    .update(schema.organizations)
    .set({ settings: { timezone: 'UTC', smsSendWindowStart: '00:00', smsSendWindowEnd: '00:00' } })
    .where(eq(schema.organizations.id, ctx.seed.orgId));
});
afterAll(async () => {
  await ctx.close();
});

async function send(to: string, body = 'Still interested in selling?') {
  const res = await ctx.app.inject({ method: 'POST', url: '/v1/messages', headers: rep, payload: { to_number: to, body } });
  expect(res.statusCode).toBe(201);
  await ctx.runner.drain();
  const { message } = res.json() as { message: { id: string } };
  return (await ctx.dbh.db.select().from(schema.messages).where(eq(schema.messages.id, message.id)))[0]!;
}

async function messageById(id: string) {
  return (await ctx.dbh.db.select().from(schema.messages).where(eq(schema.messages.id, id)))[0]!;
}

function statusCallback(handle: string, over: Record<string, unknown>, opts: { token?: string | null } = {}) {
  const t = opts.token === undefined ? token : opts.token;
  return ctx.app.inject({
    method: 'POST',
    url: `/webhooks/sendblue/status${t ? `?token=${t}` : ''}`,
    headers: { 'content-type': 'application/json' },
    payload: JSON.stringify({
      message_handle: handle,
      is_outbound: true,
      status: 'SENT',
      from_number: SB_LINE,
      number: IPHONE,
      to_number: IPHONE,
      service: 'iMessage',
      was_downgraded: null,
      group_id: '',
      date_updated: new Date().toISOString(),
      ...over,
    }),
  });
}

function inbound(over: Record<string, unknown>, secret: string | null = WEBHOOK_SECRET) {
  return ctx.app.inject({
    method: 'POST',
    url: '/webhooks/sendblue/inbound',
    headers: { 'content-type': 'application/json', ...(secret ? { 'sb-signing-secret': secret } : {}) },
    payload: JSON.stringify({
      is_outbound: false,
      status: 'RECEIVED',
      to_number: SB_LINE,
      sendblue_number: SB_LINE,
      service: 'iMessage',
      group_id: '',
      media_url: '',
      date_sent: new Date().toISOString(),
      ...over,
    }),
  });
}

describe('channel selection', () => {
  it('a line without iMessage switched on sends SMS and asks Sendblue nothing', async () => {
    const before = sendblueCalls.length;
    const row = await send(IPHONE);
    expect(row.channel).toBe('sms');
    expect(row.provider).toBe('telnyx');
    expect(ctx.sentMessages.at(-1)!.to).toBe(IPHONE);
    expect(sendblueCalls.length).toBe(before);
  });

  it('the line is switched on through PATCH /v1/numbers/:id', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/numbers/${ctx.seed.phoneNumberId}`,
      headers: admin,
      payload: { imessage_enabled: true, sendblue_from_number: SB_LINE },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { number: Record<string, unknown> }).number).toMatchObject({
      imessage_enabled: true,
      sendblue_from_number: SB_LINE,
      rcs_enabled: false,
    });
  });

  it('an iPhone recipient gets iMessage from the Sendblue line, with a tokened status callback', async () => {
    const smsBefore = ctx.sentMessages.length;
    const row = await send(IPHONE);
    expect(row).toMatchObject({ channel: 'imessage', provider: 'sendblue', status: 'sending' });
    expect(row.providerMessageSid).toMatch(/^sb-handle-/);
    expect(ctx.sentMessages.length).toBe(smsBefore);
    const sent = sendblueCalls.filter((c) => c.url === '/api/send-message').at(-1)!;
    expect(sent.body).toMatchObject({ number: IPHONE, from_number: SB_LINE, content: 'Still interested in selling?' });
    expect(String(sent.body!.status_callback)).toBe(`https://talkr.test/webhooks/sendblue/status?token=${token}`);
  });

  it('the capability answer is cached: the next send does not look up again', async () => {
    const lookups = () => sendblueCalls.filter((c) => c.url.startsWith('/api/evaluate-service')).length;
    const before = lookups();
    const row = await send(IPHONE, 'second one');
    expect(row.channel).toBe('imessage');
    expect(lookups()).toBe(before);
  });

  it('a recipient without iMessage gets SMS through Telnyx, and the negative is cached', async () => {
    const row = await send(ANDROID);
    expect(row).toMatchObject({ channel: 'sms', provider: 'telnyx' });
    const [cap] = await ctx.dbh.db
      .select()
      .from(schema.channelCapabilities)
      .where(and(eq(schema.channelCapabilities.phoneE164, ANDROID), eq(schema.channelCapabilities.channel, 'imessage')));
    expect(cap!.supported).toBe(false);
  });

  it('a send Sendblue refuses (4xx) goes out as SMS straight away', async () => {
    const row = await send(REFUSED);
    expect(row).toMatchObject({ channel: 'sms', provider: 'telnyx', status: 'sending' });
    expect(ctx.sentMessages.at(-1)!.to).toBe(REFUSED);
  });
});

describe('status callbacks', () => {
  it('a callback without the token is refused', async () => {
    const row = await send(IPHONE, 'token probe');
    const res = await statusCallback(row.providerMessageSid!, { status: 'DELIVERED' }, { token: 'nope' });
    expect(res.statusCode).toBe(403);
    await ctx.runner.drain();
    expect((await messageById(row.id)).status).toBe('sending');
  });

  it('SENT → DELIVERED → READ: delivered_at, then read_at and status read', async () => {
    const sub = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/webhook-subscriptions',
      headers: admin,
      payload: { url: 'https://clozr.test/hook', event_types: ['message.read'] },
    });
    expect(sub.statusCode).toBe(201);

    const row = await send(IPHONE, 'read me');
    const handle = row.providerMessageSid!;
    await statusCallback(handle, { status: 'SENT' });
    await statusCallback(handle, { status: 'DELIVERED' });
    await ctx.runner.drain();
    const delivered = await messageById(row.id);
    expect(delivered.status).toBe('delivered');
    expect(delivered.deliveredAt).not.toBeNull();

    const readAt = '2026-10-21T15:30:00.000Z';
    expect((await statusCallback(handle, { status: 'READ', date_updated: readAt })).statusCode).toBe(200);
    // A duplicate delivery of the same receipt is absorbed.
    await statusCallback(handle, { status: 'READ', date_updated: readAt });
    await ctx.runner.drain();
    const read = await messageById(row.id);
    expect(read.status).toBe('read');
    expect(read.readAt!.toISOString()).toBe(readAt);

    const thread = await ctx.app.inject({
      method: 'GET',
      url: `/v1/conversations/${row.conversationId}/messages`,
      headers: rep,
    });
    const wire = (thread.json() as { messages: Array<Record<string, unknown>> }).messages.find((m) => m.id === row.id)!;
    expect(wire).toMatchObject({ status: 'read', channel: 'imessage', provider: 'sendblue' });
    expect(new Date(String(wire.read_at)).toISOString()).toBe(readAt);

    const deliveries = await ctx.dbh.db
      .select()
      .from(schema.webhookDeliveries)
      .where(eq(schema.webhookDeliveries.eventType, 'message.read'));
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.eventId).toBe(`message.read:${row.id}`);
    expect(deliveries[0]!.payload).toMatchObject({
      type: 'message.read',
      occurredAt: readAt,
      data: { id: row.id, status: 'read', channel: 'imessage', read_at: readAt, conversation_id: row.conversationId },
    });
  });

  it('a downgraded send is recorded as SMS', async () => {
    const row = await send(DOWNGRADED, 'blue or green');
    expect(row.channel).toBe('imessage');
    await statusCallback(row.providerMessageSid!, { status: 'SENT', service: 'SMS', was_downgraded: true, number: DOWNGRADED });
    await ctx.runner.drain();
    const after = await messageById(row.id);
    expect(after).toMatchObject({ channel: 'sms', status: 'sent', provider: 'sendblue' });
  });

  it('an ERROR lands failed with the Sendblue code, classed platform-side', async () => {
    const row = await send(IPHONE, 'will fail');
    await statusCallback(row.providerMessageSid!, { status: 'ERROR', error_code: 4001 });
    await ctx.runner.drain();
    expect(await messageById(row.id)).toMatchObject({ status: 'failed', errorCode: '4001', failureClass: 'platform_failure' });
  });
});

describe('inbound iMessage', () => {
  it('needs the webhook secret', async () => {
    const res = await inbound({ message_handle: 'IN-0', from_number: IPHONE, number: IPHONE, content: 'x' }, 'wrong');
    expect(res.statusCode).toBe(403);
  });

  it('files under the Talkr line, in the same thread as the SMS history', async () => {
    const res = await inbound({ message_handle: 'IN-1', from_number: IPHONE, number: IPHONE, content: 'Yes, call me' });
    expect(res.statusCode).toBe(200);
    await ctx.runner.drain();
    const [msg] = await ctx.dbh.db.select().from(schema.messages).where(eq(schema.messages.providerMessageSid, 'IN-1'));
    expect(msg).toMatchObject({ direction: 'inbound', status: 'received', channel: 'imessage', provider: 'sendblue', body: 'Yes, call me' });
    const [conv] = await ctx.dbh.db.select().from(schema.conversations).where(eq(schema.conversations.id, msg!.conversationId));
    expect(conv).toMatchObject({ ourNumber: OUR_NUMBER, theirNumber: IPHONE });
    const threads = await ctx.dbh.db
      .select()
      .from(schema.conversations)
      .where(and(eq(schema.conversations.theirNumber, IPHONE), eq(schema.conversations.orgId, ctx.seed.orgId)));
    expect(threads).toHaveLength(1);
  });

  it('an iMessage to a Sendblue line no Talkr number uses is an orphan row', async () => {
    await inbound({ message_handle: 'IN-2', from_number: IPHONE, number: IPHONE, to_number: '+15550000000', content: 'hi' });
    await ctx.runner.drain();
    expect(await ctx.dbh.db.select().from(schema.messages).where(eq(schema.messages.providerMessageSid, 'IN-2'))).toHaveLength(0);
    const orphans = await ctx.dbh.db
      .select()
      .from(schema.reconciliationMismatches)
      .where(eq(schema.reconciliationMismatches.providerObjectId, 'IN-2'));
    expect(orphans).toHaveLength(1);
  });

  it('STOP over iMessage suppresses the number like an SMS STOP does', async () => {
    await inbound({ message_handle: 'IN-3', from_number: IPHONE, number: IPHONE, content: 'STOP' });
    await ctx.runner.drain();
    const supp = await ctx.dbh.db
      .select()
      .from(schema.suppressionRecords)
      .where(and(eq(schema.suppressionRecords.phoneE164, IPHONE), eq(schema.suppressionRecords.reason, 'stop')));
    expect(supp).toHaveLength(1);
    const res = await ctx.app.inject({ method: 'POST', url: '/v1/messages', headers: rep, payload: { to_number: IPHONE, body: 'one more?' } });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('suppressed');
  });
});

describe('Sendblue off', () => {
  it('the webhook routes answer 404', async () => {
    const saved = ctx.deps.sendblue;
    ctx.deps.sendblue = null;
    try {
      const res = await statusCallback('sb-handle-1', { status: 'DELIVERED' });
      expect(res.statusCode).toBe(404);
    } finally {
      ctx.deps.sendblue = saved;
    }
  });
});
