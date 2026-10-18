/**
 * Telnyx Messaging API v2 webhooks (JSON, Ed25519-signed): the shape the
 * production messaging profile posts to sms-status and inbound-sms. Until the
 * server kept JSON's raw bytes and flattened these events, every one of them
 * was rejected: no delivery receipt landed (texts sat at "sending") and no
 * inbound text reached an inbox. Genuine signed webhooks against real Postgres.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { authHeader, createTestContext, webhookPostJson, type TestContext } from './helpers.js';
import { v2Finalized, v2Received } from './fixtures/telnyx-v2-sms.js';

let ctx: TestContext;
let repAuth: Record<string, string>;
const OUR_NUMBER = '+15005550006'; // seeded org number (sms-capable)
const SELLER = '+15005550009'; // seeded contact
const DEST = '+16145550891';

beforeAll(async () => {
  ctx = await createTestContext();
  repAuth = await authHeader('auth-rep-test-org');
  await ctx.dbh.db
    .update(schema.organizations)
    .set({ settings: { timezone: 'UTC', smsSendWindowStart: '00:00', smsSendWindowEnd: '00:00' } })
    .where(eq(schema.organizations.id, ctx.seed.orgId));
});
afterAll(async () => {
  await ctx.close();
});

async function sentSid(): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/messages',
    headers: repAuth,
    payload: { to_number: DEST, body: 'v2 receipt probe' },
  });
  await ctx.runner.drain();
  const { message } = res.json() as { message: { id: string } };
  const [row] = await ctx.dbh.db.select().from(schema.messages).where(eq(schema.messages.id, message.id));
  return row!.providerMessageSid!;
}

async function messageBySid(sid: string) {
  return (await ctx.dbh.db.select().from(schema.messages).where(eq(schema.messages.providerMessageSid, sid)))[0]!;
}

describe('Messaging API v2 delivery receipts', () => {
  it('message.sent then message.finalized move the text to sent, then delivered', async () => {
    const sid = await sentSid();
    expect((await messageBySid(sid)).status).toBe('sending');

    const sent = await webhookPostJson(
      ctx,
      '/webhooks/telnyx/sms-status',
      v2Finalized({ id: sid, from: OUR_NUMBER, to: DEST, status: 'sent', eventType: 'message.sent' }),
    );
    expect(sent.statusCode).toBe(200);
    await ctx.runner.drain();
    expect((await messageBySid(sid)).status).toBe('sent');

    await webhookPostJson(ctx, '/webhooks/telnyx/sms-status', v2Finalized({ id: sid, from: OUR_NUMBER, to: DEST, status: 'delivered' }));
    await ctx.runner.drain();
    const row = await messageBySid(sid);
    expect(row.status).toBe('delivered');
    expect(row.deliveredAt).not.toBeNull();
  });

  it('a failed delivery lands as failed with its error code', async () => {
    const sid = await sentSid();
    await webhookPostJson(
      ctx,
      '/webhooks/telnyx/sms-status',
      v2Finalized({ id: sid, from: OUR_NUMBER, to: DEST, status: 'delivery_failed', errorCode: '40300' }),
    );
    await ctx.runner.drain();
    expect((await messageBySid(sid)).status).toBe('failed');
  });

  it('is stored valid, keyed like the form shape, and a repeat is a duplicate', async () => {
    const sid = await sentSid();
    const body = v2Finalized({ id: sid, from: OUR_NUMBER, to: DEST, status: 'delivered' });
    await webhookPostJson(ctx, '/webhooks/telnyx/sms-status', body);
    await webhookPostJson(ctx, '/webhooks/telnyx/sms-status', body);
    await ctx.runner.drain();
    const rows = await ctx.dbh.db
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.idempotencyKey, `telnyx:sms-status:${sid}:delivered`));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.signatureValid).toBe(true);
    expect(rows[0]!.duplicateCount).toBe(1);
  });

  it('a bad signature is still rejected', async () => {
    const sid = await sentSid();
    const res = await webhookPostJson(
      ctx,
      '/webhooks/telnyx/sms-status',
      v2Finalized({ id: sid, from: OUR_NUMBER, to: DEST, status: 'delivered' }),
      { tamperSignature: true },
    );
    expect(res.statusCode).toBe(403);
    await ctx.runner.drain();
    expect((await messageBySid(sid)).status).toBe('sending');
  });
});

describe('Messaging API v2 inbound texts', () => {
  it('message.received creates the inbound message on the contact thread', async () => {
    const res = await webhookPostJson(
      ctx,
      '/webhooks/telnyx/inbound-sms',
      v2Received({ id: 'v2-in-1', from: SELLER, to: OUR_NUMBER, text: 'Yes, call me after 3.' }),
    );
    expect(res.statusCode).toBe(200);
    await ctx.runner.drain();

    const [convo] = await ctx.dbh.db
      .select()
      .from(schema.conversations)
      .where(and(eq(schema.conversations.orgId, ctx.seed.orgId), eq(schema.conversations.theirNumber, SELLER)));
    expect(convo).toBeTruthy();
    const msgs = await ctx.dbh.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.providerMessageSid, 'v2-in-1'));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.direction).toBe('inbound');
    expect(msgs[0]!.body).toBe('Yes, call me after 3.');
    expect(msgs[0]!.conversationId).toBe(convo!.id);
  });
});
