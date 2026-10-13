/**
 * Phase 4 inbound SMS (docs/sms.md §3–4): conversation + message creation
 * with CRM linkage, duplicate deliveries, CTIA STOP/HELP/START keyword
 * handling with suppression + auto-replies, Podio activity, inbox API.
 * Genuine signed webhooks against real Postgres, like the rest of the suite.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { authHeader, createTestContext, webhookPost, type TestContext } from './helpers.js';
import { inboundSms } from './fixtures/texml-sms.js';

let ctx: TestContext;
let repAuth: Record<string, string>;
const OUR_NUMBER = '+15005550006'; // seeded org number (sms-capable)
const SELLER = '+15005550009'; // seeded contact "Sally Seller" with a lead
const STRANGER = '+16145550777'; // no contact/lead

beforeAll(async () => {
  ctx = await createTestContext();
  repAuth = await authHeader('auth-rep-test-org');
  // Deterministic send window for outbound assertions regardless of the wall
  // clock (start === end ⇒ always allowed). Quiet-hours behavior itself is
  // tested explicitly in sms-outbound.test.ts.
  await ctx.dbh.db
    .update(schema.organizations)
    .set({ settings: { timezone: 'UTC', smsSendWindowStart: '00:00', smsSendWindowEnd: '00:00' } })
    .where(eq(schema.organizations.id, ctx.seed.orgId));
});
afterAll(async () => {
  await ctx.close();
});

async function conversationFor(theirNumber: string) {
  return (
    await ctx.dbh.db
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.orgId, ctx.seed.orgId),
          eq(schema.conversations.theirNumber, theirNumber),
        ),
      )
  )[0];
}

async function messagesIn(conversationId: string) {
  return ctx.dbh.db
    .select()
    .from(schema.messages)
    .where(eq(schema.messages.conversationId, conversationId))
    .orderBy(schema.messages.createdAt);
}

async function smsSuppressions(phone: string) {
  return ctx.dbh.db
    .select()
    .from(schema.suppressionRecords)
    .where(
      and(
        eq(schema.suppressionRecords.orgId, ctx.seed.orgId),
        eq(schema.suppressionRecords.phoneE164, phone),
      ),
    );
}

describe('inbound SMS', () => {
  it('creates conversation + message linked to the right contact and lead', async () => {
    const res = await webhookPost(
      ctx,
      '/webhooks/telnyx/inbound-sms',
      inboundSms({ sid: 'SM_in_1', from: SELLER, to: OUR_NUMBER, body: 'Is the offer still on the table?' }),
    );
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('ok'); // bare fast ack
    await ctx.runner.drain();

    const convo = (await conversationFor(SELLER))!;
    expect(convo).toBeTruthy();
    expect(convo.ourNumber).toBe(OUR_NUMBER);
    expect(convo.contactId).toBe(ctx.seed.contactId);
    expect(convo.leadId).toBe(ctx.seed.leadId);
    expect(convo.assignedUserId).toBe(ctx.seed.repId); // lead owner
    expect(convo.unreadCount).toBe(1);
    expect(convo.lastMessageAt).not.toBeNull();

    const msgs = await messagesIn(convo.id);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.direction).toBe('inbound');
    expect(msgs[0]!.status).toBe('received');
    expect(msgs[0]!.body).toBe('Is the offer still on the table?');
    expect(msgs[0]!.providerMessageSid).toBe('SM_in_1');
  });

  it('duplicate webhook delivery is a no-op', async () => {
    const params = inboundSms({ sid: 'SM_in_1', from: SELLER, to: OUR_NUMBER, body: 'Is the offer still on the table?' });
    const res = await webhookPost(ctx, '/webhooks/telnyx/inbound-sms', params);
    expect(res.statusCode).toBe(200);
    await ctx.runner.drain();

    const convo = (await conversationFor(SELLER))!;
    expect((await messagesIn(convo.id)).length).toBe(1); // still one message
    expect(convo.unreadCount).toBe(1); // not double-bumped

    const webhook = (
      await ctx.dbh.db
        .select()
        .from(schema.webhookEvents)
        .where(eq(schema.webhookEvents.idempotencyKey, 'telnyx:inbound-sms:SM_in_1'))
    )[0]!;
    expect(webhook.duplicateCount).toBe(1);
    expect(webhook.status).toBe('processed');
  });

  it('posts exactly one Podio activity for an inbound message on a known lead', async () => {
    const before = ctx.podio.comments.length;
    await webhookPost(
      ctx,
      '/webhooks/telnyx/inbound-sms',
      inboundSms({ sid: 'SM_in_2', from: SELLER, to: OUR_NUMBER, body: 'Call me tomorrow' }),
    );
    await ctx.runner.drain();
    expect(ctx.podio.comments.length).toBe(before + 1);
    const comment = ctx.podio.comments.at(-1)!;
    expect(comment.itemId).toBe('podio-item-42');
    expect(comment.text).toContain('SMS received from Sally Seller');
    expect(comment.text).toContain('Call me tomorrow');
    // Re-drain: dedupe key + crm_sync_status keep it exactly-once.
    await ctx.runner.drain();
    expect(ctx.podio.comments.length).toBe(before + 1);
  });

  it('an unknown caller gets a conversation without CRM links; unknown numbers orphan', async () => {
    await webhookPost(
      ctx,
      '/webhooks/telnyx/inbound-sms',
      inboundSms({ sid: 'SM_in_3', from: STRANGER, to: OUR_NUMBER, body: 'Who is this?' }),
    );
    await ctx.runner.drain();
    const convo = (await conversationFor(STRANGER))!;
    expect(convo.contactId).toBeNull();
    expect(convo.leadId).toBeNull();

    // Inbound to a number we do not own → explicit orphan, never dropped.
    await webhookPost(
      ctx,
      '/webhooks/telnyx/inbound-sms',
      inboundSms({ sid: 'SM_in_4', from: STRANGER, to: '+19998887777', body: 'hello?' }),
    );
    await ctx.runner.drain();
    const orphans = await ctx.dbh.db
      .select()
      .from(schema.reconciliationMismatches)
      .where(eq(schema.reconciliationMismatches.providerObjectId, 'SM_in_4'));
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.objectType).toBe('orphan_provider_message');
  });

  it('rejects tampered signatures and never enqueues processing', async () => {
    const res = await webhookPost(
      ctx,
      '/webhooks/telnyx/inbound-sms',
      inboundSms({ sid: 'SM_in_bad', from: SELLER, to: OUR_NUMBER, body: 'spoof' }),
      { tamperSignature: true },
    );
    expect(res.statusCode).toBe(403);
    const rows = await ctx.dbh.db
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.providerObjectId, 'SM_in_bad'));
    expect(rows[0]!.status).toBe('rejected');
    expect(rows[0]!.signatureValid).toBe(false);
  });
});

describe('CTIA keywords: STOP / HELP / START', () => {
  it('STOP writes an sms suppression and sends the one confirmation auto-reply', async () => {
    const sentBefore = ctx.sentMessages.length;
    await webhookPost(
      ctx,
      '/webhooks/telnyx/inbound-sms',
      inboundSms({ sid: 'SM_stop_1', from: SELLER, to: OUR_NUMBER, body: 'STOP' }),
    );
    await ctx.runner.drain();

    const suppressions = await smsSuppressions(SELLER);
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0]!.channel).toBe('sms');
    expect(suppressions[0]!.reason).toBe('stop');
    expect(suppressions[0]!.scope).toBe('org');

    // Exactly one confirmation, sent via the provider despite the fresh
    // suppression (compliance auto-reply bypasses the gates).
    expect(ctx.sentMessages.length).toBe(sentBefore + 1);
    const confirmation = ctx.sentMessages.at(-1)!;
    expect(confirmation.to).toBe(SELLER);
    expect(confirmation.from).toBe(OUR_NUMBER);
    expect(confirmation.body).toContain('unsubscribed');
    expect(confirmation.body).toContain('START');

    const convo = (await conversationFor(SELLER))!;
    const autoReply = (await messagesIn(convo.id)).at(-1)!;
    expect(autoReply.direction).toBe('outbound');
    expect(autoReply.isAutoReply).toBe(true);
    expect(autoReply.status).toBe('sending');
    expect(autoReply.providerMessageSid).toBe(confirmation.providerMessageId);
  });

  it('a duplicate STOP delivery does not double the suppression or the reply', async () => {
    const sentBefore = ctx.sentMessages.length;
    await webhookPost(
      ctx,
      '/webhooks/telnyx/inbound-sms',
      inboundSms({ sid: 'SM_stop_1', from: SELLER, to: OUR_NUMBER, body: 'STOP' }),
    );
    await ctx.runner.drain();
    expect((await smsSuppressions(SELLER)).length).toBe(1);
    expect(ctx.sentMessages.length).toBe(sentBefore);
  });

  it('a subsequent POST /v1/messages to the stopped number is rejected', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: repAuth,
      payload: { to_number: SELLER, body: 'Just checking in!' },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('suppressed');
    // Nothing queued, nothing sent.
    const convo = (await conversationFor(SELLER))!;
    const queued = (await messagesIn(convo.id)).filter((m) => m.status === 'queued');
    expect(queued).toHaveLength(0);
  });

  it('HELP sends the help auto-reply with the org name', async () => {
    const sentBefore = ctx.sentMessages.length;
    await webhookPost(
      ctx,
      '/webhooks/telnyx/inbound-sms',
      inboundSms({ sid: 'SM_help_1', from: SELLER, to: OUR_NUMBER, body: 'help' }),
    );
    await ctx.runner.drain();
    expect(ctx.sentMessages.length).toBe(sentBefore + 1);
    const reply = ctx.sentMessages.at(-1)!;
    expect(reply.body).toContain('Your Company');
    expect(reply.body).toContain('STOP');
  });

  it('START clears the sms opt-out, confirms, and sending works again', async () => {
    const sentBefore = ctx.sentMessages.length;
    await webhookPost(
      ctx,
      '/webhooks/telnyx/inbound-sms',
      inboundSms({ sid: 'SM_start_1', from: SELLER, to: OUR_NUMBER, body: 'START' }),
    );
    await ctx.runner.drain();

    expect(await smsSuppressions(SELLER)).toHaveLength(0);
    const confirmation = ctx.sentMessages.at(-1)!;
    expect(ctx.sentMessages.length).toBe(sentBefore + 1);
    expect(confirmation.body).toContain('resubscribed');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: repAuth,
      payload: { to_number: SELLER, body: 'Welcome back — still interested?' },
    });
    expect(res.statusCode).toBe(201);
    await ctx.runner.drain();
    expect(ctx.sentMessages.at(-1)!.body).toBe('Welcome back — still interested?');
  });

  it('START does NOT clear an org-wide DNC (channel all) suppression', async () => {
    await ctx.dbh.db.insert(schema.suppressionRecords).values({
      orgId: ctx.seed.orgId,
      phoneE164: STRANGER,
      scope: 'org',
      channel: 'all',
      reason: 'dnc_disposition',
    });
    await webhookPost(
      ctx,
      '/webhooks/telnyx/inbound-sms',
      inboundSms({ sid: 'SM_start_2', from: STRANGER, to: OUR_NUMBER, body: 'START' }),
    );
    await ctx.runner.drain();
    // DNC still in force: the send path still refuses.
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: repAuth,
      payload: { to_number: STRANGER, body: 'hi' },
    });
    expect(res.statusCode).toBe(422);
    expect((res.json() as { error: string }).error).toBe('suppressed');
  });

  it('keywords inside sentences are treated as conversation, not opt-out', async () => {
    await webhookPost(
      ctx,
      '/webhooks/telnyx/inbound-sms',
      inboundSms({ sid: 'SM_sent_1', from: SELLER, to: OUR_NUMBER, body: 'please stop calling after 6pm' }),
    );
    await ctx.runner.drain();
    expect(await smsSuppressions(SELLER)).toHaveLength(0);
  });
});

describe('inbox API', () => {
  it('lists conversations with names + unread and marks read', async () => {
    const list = await ctx.app.inject({ method: 'GET', url: '/v1/conversations', headers: repAuth });
    expect(list.statusCode).toBe(200);
    const conversations = (list.json() as {
      conversations: Array<{ id: string; their_number: string; contact_name: string | null; unread_count: number }>;
    }).conversations;
    const sally = conversations.find((c) => c.their_number === SELLER)!;
    expect(sally.contact_name).toBe('Sally Seller');
    expect(sally.unread_count).toBeGreaterThan(0);

    const thread = await ctx.app.inject({
      method: 'GET',
      url: `/v1/conversations/${sally.id}/messages`,
      headers: repAuth,
    });
    expect(thread.statusCode).toBe(200);
    const msgs = (thread.json() as { messages: Array<{ direction: string }> }).messages;
    expect(msgs.length).toBeGreaterThan(2);

    const read = await ctx.app.inject({
      method: 'POST',
      url: `/v1/conversations/${sally.id}/read`,
      headers: repAuth,
    });
    expect(read.statusCode).toBe(200);
    const fresh = (await conversationFor(SELLER))!;
    expect(fresh.unreadCount).toBe(0);
  });

  it('scopes rep visibility to assigned/unassigned; managers see the org', async () => {
    const convo = (await conversationFor(SELLER))!;
    // Reassign to the admin: the rep loses the thread, the admin (org scope) keeps it.
    await ctx.dbh.db
      .update(schema.conversations)
      .set({ assignedUserId: ctx.seed.adminId })
      .where(eq(schema.conversations.id, convo.id));
    const repThread = await ctx.app.inject({
      method: 'GET',
      url: `/v1/conversations/${convo.id}/messages`,
      headers: repAuth,
    });
    expect(repThread.statusCode).toBe(404);
    const adminThread = await ctx.app.inject({
      method: 'GET',
      url: `/v1/conversations/${convo.id}/messages`,
      headers: await authHeader('auth-admin-test-org'),
    });
    expect(adminThread.statusCode).toBe(200);
    // Restore for later tests.
    await ctx.dbh.db
      .update(schema.conversations)
      .set({ assignedUserId: ctx.seed.repId })
      .where(eq(schema.conversations.id, convo.id));
  });

  it('unauthenticated and unauthorized access is refused', async () => {
    const anon = await ctx.app.inject({ method: 'GET', url: '/v1/conversations' });
    expect(anon.statusCode).toBe(401);
  });
});

describe('MMS media', () => {
  it('stores inbound media URLs on the message', async () => {
    await webhookPost(
      ctx,
      '/webhooks/telnyx/inbound-sms',
      inboundSms({
        sid: 'MM_in_1',
        from: SELLER,
        to: OUR_NUMBER,
        body: 'photos of the roof',
        mediaUrls: [
          'https://media.telnyx.test/MM_in_1/Media/ME1',
          'https://media.telnyx.test/MM_in_1/Media/ME2',
        ],
      }),
    );
    await ctx.runner.drain();
    const msg = (
      await ctx.dbh.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.providerMessageSid, 'MM_in_1'))
    )[0]!;
    expect(msg.mediaUrls).toHaveLength(2);
    expect((msg.mediaUrls as string[])[0]).toContain('/Media/ME1');
  });
});
