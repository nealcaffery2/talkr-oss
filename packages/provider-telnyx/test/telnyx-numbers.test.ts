/**
 * Telnyx number inventory and the server-originated browser leg.
 *
 * Request shapes are the v2 ones Telnyx documents; the fake transport asserts
 * the exact URL, auth and body so a drift in the adapter shows up here rather
 * than as a 4xx in production.
 */

import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { supportsNumbers } from '@talkr/core';
import { TelnyxVoiceProvider } from '../src/index.js';

function publicKeyBase64() {
  const { publicKey } = generateKeyPairSync('ed25519');
  return publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
}

type Recorded = { url: string; method: string; body: string; auth: string };

function providerWith(handler: (url: string, init: RequestInit, n: number) => Response, messagingProfileId?: string) {
  const calls: Recorded[] = [];
  const provider = new TelnyxVoiceProvider(
    {
      apiKey: 'KEY',
      publicKey: publicKeyBase64(),
      accountId: 'acct',
      texmlApplicationId: 'app-1',
      sipConnectionId: 'conn-1',
      messagingProfileId,
    },
    {
      wait: async () => undefined,
      fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
        const headers = (init?.headers ?? {}) as Record<string, string>;
        calls.push({ url: String(url), method: init?.method ?? 'GET', body: String(init?.body ?? ''), auth: headers.authorization ?? '' });
        return handler(String(url), init ?? {}, calls.length);
      }) as typeof fetch,
    },
  );
  return { provider, calls };
}

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('Telnyx numbers', () => {
  it('is a NumberProvider, so the settings page can buy numbers on Telnyx', () => {
    expect(supportsNumbers(providerWith(() => json({})).provider)).toBe(true);
    expect(providerWith(() => json({})).provider.browserLeg).toBe('server');
  });

  it('searches local US voice+SMS numbers by area code and pattern on v2 with Bearer', async () => {
    const { provider, calls } = providerWith(() =>
      json({
        data: [
          {
            phone_number: '+12105550101',
            region_information: [
              { region_type: 'country_code', region_name: 'US' },
              { region_type: 'state', region_name: 'TX' },
              { region_type: 'rate_center', region_name: 'SAN ANTONIO' },
            ],
            features: [{ name: 'voice' }, { name: 'sms' }],
          },
        ],
      }),
    );
    const found = await provider.searchAvailableNumbers({ areaCode: '210', contains: '55*', limit: 5 });
    expect(found).toEqual([
      {
        phoneE164: '+12105550101',
        locality: 'SAN ANTONIO',
        region: 'TX',
        areaCode: '210',
        capabilities: { voice: true, sms: true, mms: false },
      },
    ]);
    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://api.telnyx.com/v2/available_phone_numbers');
    expect(url.searchParams.get('filter[country_code]')).toBe('US');
    expect(url.searchParams.get('filter[phone_number_type]')).toBe('local');
    expect(url.searchParams.get('filter[features]')).toBe('sms');
    expect(url.searchParams.get('filter[features][]')).toBeNull();
    expect(url.searchParams.get('filter[national_destination_code]')).toBe('210');
    // Telnyx's contains filter takes digits; Twilio's wildcard is dropped.
    expect(url.searchParams.get('filter[phone_number][contains]')).toBe('55');
    expect(url.searchParams.get('filter[limit]')).toBe('5');
    expect(calls[0]!.auth).toBe('Bearer KEY');
  });

  it('retries area-code search with best_effort when Telnyx has no exact inventory (400/10031)', async () => {
    const empty = {
      errors: [{ code: '10031', title: 'Invalid request filter', detail: 'No numbers found for the given filters. Please try again with best_effort=true.' }],
    };
    const { provider, calls } = providerWith((url) => {
      if (url.includes('best_effort')) {
        return json({
          data: [{
            phone_number: '+18305550191',
            region_information: [
              { region_type: 'state', region_name: 'TX' },
              { region_type: 'rate_center', region_name: 'PIPE CREEK' },
            ],
            features: [{ name: 'voice' }, { name: 'sms' }],
          }],
        });
      }
      return json(empty, 400);
    });
    const found = await provider.searchAvailableNumbers({ areaCode: '210', limit: 6 });
    expect(found).toEqual([{
      phoneE164: '+18305550191',
      locality: 'PIPE CREEK',
      region: 'TX',
      areaCode: '830',
      capabilities: { voice: true, sms: true, mms: false },
    }]);
    expect(calls).toHaveLength(2);
    expect(new URL(calls[0]!.url).searchParams.get('filter[best_effort]')).toBeNull();
    expect(new URL(calls[1]!.url).searchParams.get('filter[best_effort]')).toBe('true');
  });

  it('orders a number attached to the TeXML app and messaging profile, then resolves its id', async () => {
    const { provider, calls } = providerWith((url, _init, n) => {
      if (url.endsWith('/number_orders')) {
        return json({ data: { id: 'order-1', status: 'pending', phone_numbers: [{ phone_number: '+12105550101', status: 'pending' }] } });
      }
      // First poll: the order has not settled; second: the owned number exists.
      if (n === 2) return json({ data: [] });
      return json({
        data: [{ id: '1234567890123456789', phone_number: '+12105550101', status: 'active', features: [{ name: 'voice' }, { name: 'sms' }, { name: 'mms' }] }],
      });
    }, 'profile-1');
    const bought = await provider.purchaseNumber({
      phoneE164: '+12105550101',
      voiceUrl: 'https://talkr.test/twiml/inbound',
      statusCallbackUrl: 'https://talkr.test/webhooks/telnyx/voice-status',
      smsUrl: 'https://talkr.test/webhooks/telnyx/inbound-sms',
      friendlyName: 'SA line',
    });
    expect(bought).toEqual({
      providerNumberId: '1234567890123456789',
      phoneE164: '+12105550101',
      capabilities: { voice: true, sms: true, mms: true },
    });
    expect(calls[0]!.url).toBe('https://api.telnyx.com/v2/number_orders');
    expect(calls[0]!.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body)).toEqual({
      phone_numbers: [{ phone_number: '+12105550101' }],
      connection_id: 'app-1',
      messaging_profile_id: 'profile-1',
      customer_reference: 'SA line',
    });
    expect(calls).toHaveLength(3);
    expect(new URL(calls[1]!.url).searchParams.get('filter[phone_number]')).toBe('+12105550101');
  });

  it('falls back to the E.164 as the provider id when the order has not settled', async () => {
    const { provider } = providerWith((url) =>
      url.endsWith('/number_orders') ? json({ data: { id: 'order-2', status: 'pending' } }) : json({ data: [] }),
    );
    const bought = await provider.purchaseNumber({
      phoneE164: '+12105550102',
      voiceUrl: '',
      statusCallbackUrl: '',
      smsUrl: '',
    });
    expect(bought.providerNumberId).toBe('+12105550102');
    // No messaging profile configured: the number cannot text yet, and says so.
    expect(bought.capabilities).toEqual({ voice: true, sms: false, mms: false });
  });

  it('refuses a failed order instead of recording a number the org does not own', async () => {
    const { provider } = providerWith(() => json({ data: { id: 'order-3', status: 'failure' } }));
    await expect(
      provider.purchaseNumber({ phoneE164: '+12105550103', voiceUrl: '', statusCallbackUrl: '', smsUrl: '' }),
    ).rejects.toThrow(/failed/);
  });

  it('releases by id, treating 404 as already released', async () => {
    const { provider, calls } = providerWith(() => new Response(null, { status: 204 }));
    await provider.releaseNumber('1234567890123456789');
    expect(calls[0]).toMatchObject({ url: 'https://api.telnyx.com/v2/phone_numbers/1234567890123456789', method: 'DELETE', auth: 'Bearer KEY' });
    const gone = providerWith(() => new Response(null, { status: 404 }));
    await expect(gone.provider.releaseNumber('+12105550101')).resolves.toBeUndefined();
    expect(gone.calls[0]!.url).toBe('https://api.telnyx.com/v2/phone_numbers/%2B12105550101');
    const broken = providerWith(() => new Response('nope', { status: 500 }));
    await expect(broken.provider.releaseNumber('x')).rejects.toThrow(/500/);
  });
});

describe('Telnyx server-originated browser leg', () => {
  it('dials a SIP URI through the TeXML app and tolerates a sid-less response', async () => {
    const { provider, calls } = providerWith(() => json({ from: '+15125550134', to: 'sip:gencred1@sip.telnyx.com', status: 'queued' }));
    const created = await provider.createCall({
      from: '+15125550134',
      to: 'sip:gencred1@sip.telnyx.com',
      answerUrl: 'https://talkr.test/twiml/outbound-dial?talkr_call_id=call-1',
      statusCallbackUrl: 'https://talkr.test/webhooks/telnyx/voice-status?call=call-1&leg=client',
    });
    // No sid: the webhook binds the provider id. Not an error.
    expect(created).toEqual({ providerCallId: '' });
    expect(calls[0]!.url).toBe('https://api.telnyx.com/v2/texml/calls/app-1');
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      To: 'sip:gencred1@sip.telnyx.com',
      From: '+15125550134',
      Url: 'https://talkr.test/twiml/outbound-dial?talkr_call_id=call-1',
      UrlMethod: 'POST',
    });
  });

  it('reads a sid from either envelope when one is returned', async () => {
    const wrapped = providerWith(() => json({ data: { sid: 'v3:wrapped' } }));
    expect(
      await wrapped.provider.createCall({ from: '+1', to: '+2', answerUrl: 'https://t/a', statusCallbackUrl: 'https://t/s' }),
    ).toEqual({ providerCallId: 'v3:wrapped' });
  });
});

describe('Telnyx number import and inbound call control', () => {
  it('imports an owned number: looks it up, attaches voice app and messaging profile', async () => {
    const { provider, calls } = providerWith((url, init) => {
      if (init.method === 'GET') return json({ data: [{ id: 'pn-9', phone_number: '+13465550190', features: [{ name: 'voice' }, { name: 'sms' }] }] });
      return json({ data: {} });
    }, 'mp-1');
    expect(await provider.importNumber('+13465550190')).toEqual({
      providerNumberId: 'pn-9',
      phoneE164: '+13465550190',
      capabilities: { voice: true, sms: true, mms: false },
    });
    expect(calls[0]!.url).toBe('https://api.telnyx.com/v2/phone_numbers?filter%5Bphone_number%5D=%2B13465550190');
    expect(calls[1]).toMatchObject({ url: 'https://api.telnyx.com/v2/phone_numbers/pn-9', method: 'PATCH', body: JSON.stringify({ connection_id: 'app-1' }) });
    expect(calls[2]).toMatchObject({ url: 'https://api.telnyx.com/v2/phone_numbers/pn-9/messaging', method: 'PATCH', body: JSON.stringify({ messaging_profile_id: 'mp-1' }) });
  });

  it('import answers null for a number the account does not own, without attaching anything', async () => {
    const { provider, calls } = providerWith(() => json({ data: [] }));
    expect(await provider.importNumber('+13465550190')).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('lists carrier numbers with whether they already point at our TeXML app', async () => {
    const { provider } = providerWith(() =>
      json({ data: [{ id: 'a', phone_number: '+1', connection_id: 'app-1' }, { id: 'b', phone_number: '+2', connection_id: null }], meta: { total_pages: 1 } }),
    );
    expect((await provider.listCarrierNumbers()).map((n) => n.attached)).toEqual([true, false]);
  });

  it('renders ring-all as one Dial with a Sip per rep, forward/menu/voicemail with greetings', () => {
    const { provider } = providerWith(() => json({}));
    const ring = provider.buildClientDialResponse({
      callerId: '+12105550100',
      clientIdentities: [{ userId: 'a', sipUsername: 'gencredA' }, { userId: 'b', sipUsername: 'gencredB' }],
      talkrCallId: 'c1',
      timeoutSeconds: 20,
      dialActionUrl: 'https://t/twiml/flow?call=c1&node=ring',
      statusCallbackUrl: 'https://t/s',
      record: false,
      whisperUrl: 'https://t/twiml/whisper?call=c1',
    }).body;
    expect(ring.match(/<Sip /g)).toHaveLength(2);
    expect(ring).toContain('action="https://t/twiml/flow?call=c1&amp;node=ring"');
    expect(ring).toContain('url="https://t/twiml/whisper?call=c1"');
    expect(ring).not.toContain('record=');

    const fwd = provider.buildForwardDialResponse({ callerId: '+1', to: '+12105550199', timeoutSeconds: 25, dialActionUrl: 'https://t/a', statusCallbackUrl: 'https://t/s', record: true }).body;
    expect(fwd).toContain('<Number');
    expect(fwd).toContain('+12105550199</Number>');

    const menu = provider.buildIvrGatherResponse({ greeting: '', greetingAudioUrl: 'https://t/media/x.mp3', actionUrl: 'https://t/a', timeoutSeconds: 6 }).body;
    expect(menu).toContain('<Gather input="dtmf" numDigits="1" timeout="6" action="https://t/a" method="POST"><Play>https://t/media/x.mp3</Play></Gather><Redirect');

    const vm = provider.buildVoicemailResponse({ greeting: 'Leave a message', maxLengthSeconds: 120, actionUrl: 'https://t/v', recordingStatusCallbackUrl: 'https://t/r' }).body;
    expect(vm).toContain('<Say>Leave a message</Say><Record');
    expect(provider.buildWhisperResponse('Call from the main line').body).not.toContain('Hangup');
  });
});
