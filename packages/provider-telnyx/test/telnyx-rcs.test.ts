/**
 * RCS through Telnyx: v2 webhook flattening for RCS read receipts and inbound
 * agent messages, and the send / capability requests (payloads from
 * developers.telnyx.com "Receiving RCS webhooks" and the RCS API reference).
 */

import { describe, expect, it } from 'vitest';
import { flattenMessagingEvent, normalizeTelnyxWebhook, TelnyxVoiceProvider } from '../src/index.js';

const READ = {
  data: {
    event_type: 'message.read',
    id: '7bc4d2e1-3f89-4a12-b5c7-9e8d1a2f3b4c',
    occurred_at: '2024-12-09T21:35:22.000+00:00',
    payload: {
      body: { text: 'Hello there!' },
      direction: 'outbound',
      from: { agent_id: 'e4448a5c0670c2a9', agent_name: 'My RCS Agent' },
      id: 'ac012cbf-5e09-46af-a69a-7c0e2d90993c',
      to: [{ phone_number: '+13125550000', status: 'read' }],
      type: 'RCS',
    },
    record_type: 'event',
  },
};

const INBOUND = {
  data: {
    event_type: 'message.received',
    id: 'b301ed3f-1490-491f-995f-6e64e69674d4',
    occurred_at: '2024-12-09T20:16:07.588+00:00',
    payload: {
      body: { text: 'Hello from Telnyx!' },
      direction: 'inbound',
      from: { carrier: 'T-Mobile USA', line_type: 'long_code', phone_number: '+13125550000' },
      id: '84cca175-9755-4859-b67f-4730d7f58aa3',
      to: [{ agent_id: 'e4448a5c0670c2a9', agent_name: 'My RCS Agent' }],
      type: 'RCS',
    },
    record_type: 'event',
  },
};

describe('RCS webhooks', () => {
  it('message.read becomes status read, at the event time, on channel rcs', () => {
    const flat = flattenMessagingEvent('sms-status', READ)!;
    expect(flat).toMatchObject({ MessageSid: 'ac012cbf-5e09-46af-a69a-7c0e2d90993c', MessageStatus: 'read', MessageType: 'RCS' });
    const [e] = normalizeTelnyxWebhook('sms-status', flat);
    expect(e).toMatchObject({ type: 'message.status', data: { status: 'read', channel: 'rcs', to: '+13125550000' } });
    expect(e!.occurredAt.toISOString()).toBe('2024-12-09T21:35:22.000Z');
  });

  it('message.read with no recipient status still reads as read', () => {
    const body = structuredClone(READ);
    body.data.payload.to = [{ phone_number: '+13125550000' } as never];
    expect(flattenMessagingEvent('sms-status', body)!.MessageStatus).toBe('read');
  });

  it('a delivered RCS receipt is delivered on channel rcs; an SMS one is sms', () => {
    const delivered = structuredClone(READ);
    delivered.data.event_type = 'message.finalized';
    delivered.data.payload.to = [{ phone_number: '+13125550000', status: 'delivered' }];
    const [rcs] = normalizeTelnyxWebhook('sms-status', flattenMessagingEvent('sms-status', delivered)!);
    expect(rcs!.data).toMatchObject({ status: 'delivered', channel: 'rcs' });
    delivered.data.payload.type = 'SMS';
    const [sms] = normalizeTelnyxWebhook('sms-status', flattenMessagingEvent('sms-status', delivered)!);
    expect(sms!.data).toMatchObject({ channel: 'sms' });
  });

  it('an inbound RCS text keeps the sender, the agent, and no line', () => {
    const flat = flattenMessagingEvent('inbound-sms', INBOUND)!;
    expect(flat).toMatchObject({ From: '+13125550000', To: '', Body: 'Hello from Telnyx!', RcsAgentId: 'e4448a5c0670c2a9' });
    const [e] = normalizeTelnyxWebhook('inbound-sms', flat);
    expect(e).toMatchObject({
      type: 'message.received',
      data: { from: '+13125550000', body: 'Hello from Telnyx!', channel: 'rcs', rcsAgentId: 'e4448a5c0670c2a9' },
    });
    expect((e!.data as { to?: string }).to).toBeUndefined();
  });

  it('an inbound RCS file and a suggestion tap', () => {
    const file = structuredClone(INBOUND) as unknown as { data: { payload: { body: unknown } } };
    file.data.payload.body = {
      user_file: { payload: { file_uri: 'https://rcs-inbound.example/photo.jpg', mime_type: 'image/jpeg' } },
    };
    expect(flattenMessagingEvent('inbound-sms', file)).toMatchObject({ NumMedia: '1', MediaUrl0: 'https://rcs-inbound.example/photo.jpg' });
    const tap = structuredClone(INBOUND) as unknown as { data: { payload: { body: unknown } } };
    tap.data.payload.body = { suggestion_response: { postback_data: 'yes', text: 'Yes, call me' } };
    expect(flattenMessagingEvent('inbound-sms', tap)!.Body).toBe('Yes, call me');
  });

  it('a plain inbound SMS still needs our number', () => {
    const sms = structuredClone(INBOUND) as unknown as { data: { payload: Record<string, unknown> } };
    sms.data.payload.type = 'SMS';
    sms.data.payload.text = 'hi';
    expect(normalizeTelnyxWebhook('inbound-sms', flattenMessagingEvent('inbound-sms', sms)!)).toEqual([]);
  });
});

function provider(fetchImpl: typeof fetch, rcsAgentId: string | null = 'agent-1') {
  return new TelnyxVoiceProvider(
    {
      apiKey: 'k',
      publicKey: 'p',
      accountId: 'a',
      texmlApplicationId: 't',
      sipConnectionId: 's',
      messagingProfileId: 'mp-1',
      ...(rcsAgentId ? { rcsAgentId } : {}),
    },
    { fetchImpl },
  );
}

describe('RCS REST', () => {
  it('sends through /v2/messages/rcs with an SMS fallback from our line', async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const p = provider((async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body)) });
      return new Response(JSON.stringify({ data: { id: 'rcs-msg-1' } }), { status: 200 });
    }) as typeof fetch);
    const r = await p.sendRcsMessage({
      to: '+13125550000',
      body: 'Still interested?',
      smsFallbackFrom: '+15005550006',
      statusCallbackUrl: 'https://talkr.test/webhooks/telnyx/sms-status',
    });
    expect(r.providerMessageId).toBe('rcs-msg-1');
    expect(calls[0]!.url).toBe('https://api.telnyx.com/v2/messages/rcs');
    expect(calls[0]!.body).toEqual({
      agent_id: 'agent-1',
      to: '+13125550000',
      messaging_profile_id: 'mp-1',
      type: 'RCS',
      agent_message: { content_message: { text: 'Still interested?' } },
      webhook_url: 'https://talkr.test/webhooks/telnyx/sms-status',
      sms_fallback: { from: '+15005550006', text: 'Still interested?' },
    });
  });

  it('capability: features → supported, empty → unsupported, 404 → unsupported, 5xx → unknown', async () => {
    const answers = [
      new Response(JSON.stringify({ data: { features: ['RICHCARD_STANDALONE'] } }), { status: 200 }),
      new Response(JSON.stringify({ data: { features: [] } }), { status: 200 }),
      new Response('{}', { status: 404 }),
      new Response('{}', { status: 503 }),
    ];
    const urls: string[] = [];
    const p = provider((async (url: string) => {
      urls.push(String(url));
      return answers.shift()!;
    }) as typeof fetch);
    expect(await p.checkRcsCapability('+13125550000')).toBe('supported');
    expect(await p.checkRcsCapability('+13125550000')).toBe('unsupported');
    expect(await p.checkRcsCapability('+13125550000')).toBe('unsupported');
    expect(await p.checkRcsCapability('+13125550000')).toBe('unknown');
    expect(urls[0]).toBe('https://api.telnyx.com/v2/messaging/rcs/capabilities/agent-1/%2B13125550000');
  });

  it('no agent configured: no RCS id, unsupported, and a send refuses', async () => {
    const p = provider((async () => new Response('{}')) as typeof fetch, null);
    expect(p.rcsAgentId).toBeNull();
    expect(await p.checkRcsCapability('+1')).toBe('unsupported');
    await expect(p.sendRcsMessage({ to: '+1', body: 'x' })).rejects.toThrow(/TELNYX_RCS_AGENT_ID/);
  });
});
