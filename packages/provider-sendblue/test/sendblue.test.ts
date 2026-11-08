/**
 * Sendblue adapter: status mapping, webhook normalization, the send and
 * lookup requests it makes, and webhook-secret checking. Payloads follow
 * docs.sendblue.com's documented examples.
 */

import { describe, expect, it } from 'vitest';
import {
  SendblueApiError,
  SendblueClient,
  mapSendblueStatus,
  normalizeSendblueWebhook,
  sendblueIdempotencyKey,
} from '../src/index.js';

function statusBody(over: Record<string, unknown> = {}) {
  return {
    accountEmail: 'ops@example.com',
    content: 'Hello world!',
    is_outbound: true,
    status: 'SENT',
    error_code: null,
    error_message: null,
    error_key: null,
    message_handle: '5a17319e-cbcf-443e-897e-d8b0c04b1b09',
    date_sent: '2025-12-12T15:35:35.410Z',
    date_updated: '2025-12-12T15:35:36.410Z',
    from_number: '+18645550355',
    number: '+19998887777',
    to_number: '+19998887777',
    was_downgraded: null,
    media_url: '',
    message_type: 'message',
    group_id: '',
    service: 'iMessage',
    ...over,
  };
}

function inboundBody(over: Record<string, unknown> = {}) {
  return {
    content: 'Hello!',
    is_outbound: false,
    status: 'RECEIVED',
    message_handle: '99DCC379-DD76-4712-BA65-11EFB33B8CD6',
    date_sent: '2025-12-12T15:41:20.932Z',
    date_updated: '2025-12-12T15:41:20.995Z',
    from_number: '+19998887777',
    number: '+19998887777',
    to_number: '+15125554639',
    media_url: '',
    group_id: '',
    sendblue_number: '+15125554639',
    service: 'iMessage',
    ...over,
  };
}

describe('status mapping', () => {
  it.each([
    ['REGISTERED', 'queued'],
    ['PENDING', 'queued'],
    ['QUEUED', 'queued'],
    ['ACCEPTED', 'sending'],
    ['SENT', 'sent'],
    ['DELIVERED', 'delivered'],
    ['READ', 'read'],
    ['DECLINED', 'failed'],
    ['ERROR', 'failed'],
    ['RECEIVED', 'received'],
    ['delivered', 'delivered'],
    ['SOMETHING_NEW', null],
  ])('%s → %s', (given, expected) => {
    expect(mapSendblueStatus(given)).toBe(expected);
  });
});

describe('status callbacks', () => {
  it('DELIVERED over iMessage', () => {
    const [e] = normalizeSendblueWebhook('sendblue-status', statusBody({ status: 'DELIVERED' }));
    expect(e).toMatchObject({
      type: 'message.status',
      provider: 'sendblue',
      providerObjectId: '5a17319e-cbcf-443e-897e-d8b0c04b1b09',
      data: { status: 'delivered', channel: 'imessage' },
    });
  });

  it('a downgraded send reports channel sms', () => {
    const [e] = normalizeSendblueWebhook('sendblue-status', statusBody({ service: 'SMS', was_downgraded: true }));
    expect(e!.data.channel).toBe('sms');
  });

  it('READ carries the read time', () => {
    const [e] = normalizeSendblueWebhook(
      'sendblue-status',
      statusBody({ status: 'READ', date_updated: '2025-12-12T16:00:00.000Z' }),
    );
    expect(e!.data.status).toBe('read');
    expect(e!.occurredAt.toISOString()).toBe('2025-12-12T16:00:00.000Z');
  });

  it('a date_read field is a read receipt whatever the status says', () => {
    const [e] = normalizeSendblueWebhook(
      'sendblue-status',
      statusBody({ status: 'DELIVERED', date_read: '2025-12-12T16:05:00.000Z' }),
    );
    expect(e!.data.status).toBe('read');
    expect(e!.occurredAt.toISOString()).toBe('2025-12-12T16:05:00.000Z');
  });

  it('ERROR keeps the numeric code; DECLINED keeps the rule key', () => {
    const [err] = normalizeSendblueWebhook('sendblue-status', statusBody({ status: 'ERROR', error_code: 10001 }));
    expect(err!.data).toMatchObject({ status: 'failed', errorCode: '10001' });
    const [dec] = normalizeSendblueWebhook(
      'sendblue-status',
      statusBody({ status: 'DECLINED', error_key: 'OPTED_OUT' }),
    );
    expect(dec!.data).toMatchObject({ status: 'failed', errorCode: 'OPTED_OUT' });
  });

  it('group messages and handle-less bodies are ignored', () => {
    expect(normalizeSendblueWebhook('sendblue-status', statusBody({ group_id: 'g1' }))).toEqual([]);
    expect(normalizeSendblueWebhook('sendblue-status', { status: 'SENT' })).toEqual([]);
  });
});

describe('inbound messages', () => {
  it('an iMessage reply becomes message.received to the Sendblue line', () => {
    const [e] = normalizeSendblueWebhook('sendblue-inbound', inboundBody());
    expect(e).toMatchObject({
      type: 'message.received',
      provider: 'sendblue',
      providerObjectId: '99DCC379-DD76-4712-BA65-11EFB33B8CD6',
      data: { from: '+19998887777', to: '+15125554639', body: 'Hello!', channel: 'imessage', numMedia: 0 },
    });
  });

  it('media arrives as one URL', () => {
    const [e] = normalizeSendblueWebhook('sendblue-inbound', inboundBody({ media_url: 'https://cdn.sendblue.co/a.jpg' }));
    expect(e!.data.mediaUrls).toEqual(['https://cdn.sendblue.co/a.jpg']);
  });

  it('an outbound event posted to the receive hook is treated as a status', () => {
    const [e] = normalizeSendblueWebhook('sendblue-inbound', statusBody({ status: 'DELIVERED' }));
    expect(e!.type).toBe('message.status');
  });
});

describe('idempotency keys', () => {
  it('one key per handle × status; inbound per handle', () => {
    expect(sendblueIdempotencyKey('sendblue-status', statusBody())).toBe(
      'sendblue:status:5a17319e-cbcf-443e-897e-d8b0c04b1b09:SENT',
    );
    expect(sendblueIdempotencyKey('sendblue-inbound', inboundBody())).toBe(
      'sendblue:inbound:99DCC379-DD76-4712-BA65-11EFB33B8CD6',
    );
    expect(sendblueIdempotencyKey('sendblue-status', {})).toBeNull();
  });
});

function fakeFetch(respond: (url: string, init: RequestInit) => Response) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond(String(url), init ?? {});
  }) as typeof fetch;
  return { impl, calls };
}

const CONFIG = { apiKeyId: 'key-id', apiSecret: 'key-secret', webhookSecret: 'whsec-sb' };

describe('client', () => {
  it('sends with both auth headers and the documented body', async () => {
    const { impl, calls } = fakeFetch(
      () => new Response(JSON.stringify({ message_handle: 'h-1', status: 'QUEUED' }), { status: 200 }),
    );
    const client = new SendblueClient(CONFIG, impl);
    const r = await client.sendMessage({
      from: '+15125554639',
      to: '+19998887777',
      body: 'hi',
      statusCallbackUrl: 'https://talkr.test/webhooks/sendblue/status?token=x',
    });
    expect(r).toEqual({ providerMessageId: 'h-1', status: 'queued' });
    expect(calls[0]!.url).toBe('https://api.sendblue.com/api/send-message');
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers['sb-api-key-id']).toBe('key-id');
    expect(headers['sb-api-secret-key']).toBe('key-secret');
    expect(JSON.parse(String(calls[0]!.init.body))).toEqual({
      number: '+19998887777',
      from_number: '+15125554639',
      content: 'hi',
      status_callback: 'https://talkr.test/webhooks/sendblue/status?token=x',
    });
  });

  it('a capacity decline (HTTP 400, status ERROR) throws with the status', async () => {
    const { impl } = fakeFetch(
      () =>
        new Response(JSON.stringify({ status: 'ERROR', error_code: 429, error_key: 'LINE_DAILY_LIMIT_REACHED' }), {
          status: 400,
        }),
    );
    const err = await new SendblueClient(CONFIG, impl)
      .sendMessage({ from: '+1', to: '+2', body: 'x' })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SendblueApiError);
    expect((err as SendblueApiError).status).toBe(400);
  });

  it('evaluate-service: iMessage, SMS, and an inconclusive 502', async () => {
    const answers: Response[] = [
      new Response(JSON.stringify({ number: '+1', service: 'iMessage' }), { status: 200 }),
      new Response(JSON.stringify({ number: '+1', service: 'SMS' }), { status: 200 }),
      new Response(JSON.stringify({ status: 'ERROR', code: 'EVALUATE_SERVICE_INDETERMINATE' }), { status: 502 }),
    ];
    const { impl, calls } = fakeFetch(() => answers.shift()!);
    const client = new SendblueClient(CONFIG, impl);
    expect(await client.evaluateService('+14155550100')).toBe('supported');
    expect(await client.evaluateService('+14155550100')).toBe('unsupported');
    expect(await client.evaluateService('+14155550100')).toBe('unknown');
    expect(calls[0]!.url).toBe('https://api.sendblue.com/api/evaluate-service?number=%2B14155550100');
  });

  it('webhook secret: exact match only', () => {
    const client = new SendblueClient(CONFIG);
    expect(client.verifyWebhookSecret({ 'sb-signing-secret': 'whsec-sb' })).toBe(true);
    expect(client.verifyWebhookSecret({ 'sb-signing-secret': 'whsec-sX' })).toBe(false);
    expect(client.verifyWebhookSecret({})).toBe(false);
    expect(new SendblueClient({ ...CONFIG, webhookSecret: undefined }).verifyWebhookSecret({ 'sb-signing-secret': '' })).toBe(false);
  });
});
