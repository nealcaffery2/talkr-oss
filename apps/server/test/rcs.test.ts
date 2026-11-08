/**
 * RCS through Telnyx, end to end against real Postgres: the RCS path only for
 * an RCS line and an RCS handset, the SMS fallback number on every RCS send,
 * the signed v2 `message.read` receipt landing as status read with read_at,
 * and inbound RCS filed under the line (docs/messaging-channels.md).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { authHeader, createTestContext, webhookPostJson, type TestContext } from './helpers.js';

const OUR_NUMBER = '+15005550006';
const PIXEL = '+16145550201';
const FLIP = '+16145550202';
const AGENT = 'agent-test-1';

const rcsSends: Array<{ to: string; body: string; smsFallbackFrom?: string; statusCallbackUrl?: string }> = [];
const capabilityAsks: string[] = [];

let ctx: TestContext;
let rep: Record<string, string>;
let admin: Record<string, string>;

beforeAll(async () => {
  ctx = await createTestContext({
    rcsAgentId: AGENT,
    telnyxOverrides: {
      checkRcsCapability: async (to) => {
        capabilityAsks.push(to);
        return to === PIXEL ? 'supported' : 'unsupported';
      },
      sendRcsMessage: async (params) => {
        rcsSends.push(params);
        return { providerMessageId: `rcs-${rcsSends.length}` };
      },
    },
  });
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

function rcsReceipt(id: string, eventType: 'message.finalized' | 'message.read', status: string, occurredAt: string) {
  return {
    data: {
      event_type: eventType,
      id: `evt-${id}-${status}`,
      occurred_at: occurredAt,
      payload: {
        body: { text: 'Still interested in selling?' },
        direction: 'outbound',
        from: { agent_id: AGENT, agent_name: 'Acme Homes' },
        id,
        to: [{ phone_number: PIXEL, status }],
        type: 'RCS',
      },
      record_type: 'event',
    },
  };
}

describe('RCS sends', () => {
  it('a line without RCS switched on sends SMS and checks nothing', async () => {
    const row = await send(PIXEL);
    expect(row.channel).toBe('sms');
    expect(capabilityAsks).toEqual([]);
  });

  it('an RCS line to an RCS handset sends RCS with our line as the SMS fallback', async () => {
    const patch = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/numbers/${ctx.seed.phoneNumberId}`,
      headers: admin,
      payload: { rcs_enabled: true },
    });
    expect(patch.statusCode).toBe(200);
    const smsBefore = ctx.sentMessages.length;
    const row = await send(PIXEL);
    expect(row).toMatchObject({ channel: 'rcs', provider: 'telnyx', status: 'sending', providerMessageSid: 'rcs-1' });
    expect(ctx.sentMessages.length).toBe(smsBefore);
    expect(rcsSends[0]).toMatchObject({
      to: PIXEL,
      body: 'Still interested in selling?',
      smsFallbackFrom: OUR_NUMBER,
      statusCallbackUrl: 'https://talkr.test/webhooks/telnyx/sms-status',
    });
  });

  it('a handset without RCS gets SMS', async () => {
    const row = await send(FLIP);
    expect(row.channel).toBe('sms');
    expect(ctx.sentMessages.at(-1)!.to).toBe(FLIP);
  });

  it('delivered then read: status read, read_at from the event time', async () => {
    const row = await send(PIXEL, 'read receipt probe');
    const sid = row.providerMessageSid!;
    await webhookPostJson(ctx, '/webhooks/telnyx/sms-status', rcsReceipt(sid, 'message.finalized', 'delivered', '2026-10-21T16:00:00.000+00:00'));
    await ctx.runner.drain();
    expect((await ctx.dbh.db.select().from(schema.messages).where(eq(schema.messages.id, row.id)))[0]!.status).toBe('delivered');

    const res = await webhookPostJson(ctx, '/webhooks/telnyx/sms-status', rcsReceipt(sid, 'message.read', 'read', '2026-10-21T16:05:00.000+00:00'));
    expect(res.statusCode).toBe(200);
    await ctx.runner.drain();
    const read = (await ctx.dbh.db.select().from(schema.messages).where(eq(schema.messages.id, row.id)))[0]!;
    expect(read.status).toBe('read');
    expect(read.readAt!.toISOString()).toBe('2026-10-21T16:05:00.000Z');
    expect(read.channel).toBe('rcs');
  });

  it('an RCS send that fell back to SMS is recorded as SMS', async () => {
    const row = await send(PIXEL, 'fallback probe');
    const receipt = rcsReceipt(row.providerMessageSid!, 'message.finalized', 'delivered', '2026-10-21T16:10:00.000+00:00');
    receipt.data.payload.type = 'SMS';
    await webhookPostJson(ctx, '/webhooks/telnyx/sms-status', receipt);
    await ctx.runner.drain();
    const after = (await ctx.dbh.db.select().from(schema.messages).where(eq(schema.messages.id, row.id)))[0]!;
    expect(after).toMatchObject({ channel: 'sms', status: 'delivered' });
  });
});

describe('inbound RCS', () => {
  it('files under the RCS line this person was texting with', async () => {
    const res = await webhookPostJson(ctx, '/webhooks/telnyx/inbound-sms', {
      data: {
        event_type: 'message.received',
        id: 'evt-in-rcs-1',
        occurred_at: '2026-10-21T16:20:00.000+00:00',
        payload: {
          body: { text: 'Call me after 5' },
          direction: 'inbound',
          from: { carrier: 'T-Mobile USA', line_type: 'long_code', phone_number: PIXEL },
          id: 'in-rcs-1',
          to: [{ agent_id: AGENT, agent_name: 'Acme Homes' }],
          type: 'RCS',
        },
        record_type: 'event',
      },
    });
    expect(res.statusCode).toBe(200);
    await ctx.runner.drain();
    const [msg] = await ctx.dbh.db.select().from(schema.messages).where(eq(schema.messages.providerMessageSid, 'in-rcs-1'));
    expect(msg).toMatchObject({ direction: 'inbound', channel: 'rcs', body: 'Call me after 5' });
    const [conv] = await ctx.dbh.db.select().from(schema.conversations).where(eq(schema.conversations.id, msg!.conversationId));
    expect(conv).toMatchObject({ ourNumber: OUR_NUMBER, theirNumber: PIXEL });
  });

  it('from someone with no RCS thread and no TELNYX_RCS_INBOUND_NUMBER: an orphan row', async () => {
    await webhookPostJson(ctx, '/webhooks/telnyx/inbound-sms', {
      data: {
        event_type: 'message.received',
        id: 'evt-in-rcs-2',
        payload: {
          body: { text: 'who is this' },
          direction: 'inbound',
          from: { phone_number: '+16145550299' },
          id: 'in-rcs-2',
          to: [{ agent_id: AGENT }],
          type: 'RCS',
        },
        record_type: 'event',
      },
    });
    await ctx.runner.drain();
    expect(await ctx.dbh.db.select().from(schema.messages).where(eq(schema.messages.providerMessageSid, 'in-rcs-2'))).toHaveLength(0);
    const orphans = await ctx.dbh.db
      .select()
      .from(schema.reconciliationMismatches)
      .where(eq(schema.reconciliationMismatches.providerObjectId, 'in-rcs-2'));
    expect(orphans).toHaveLength(1);
  });
});
