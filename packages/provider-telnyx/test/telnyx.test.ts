/**
 * Telnyx adapter tests.
 *
 * Signature verification is exercised against a real Ed25519 keypair generated
 * in-process, so the test proves the actual crypto path rather than a stub. The
 * two failure modes that have shipped as real bugs in other integrations —
 * a timestamp header with trailing junk, and out-of-window replays — get
 * explicit cases.
 */

import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  TelnyxVoiceProvider,
  flattenMessagingEvent,
  idempotencyKeyFor,
  normalizeTelnyxWebhook,
  publicKeyFromBase64,
  verifyTelnyxSignature,
} from '../src/index.js';

/** A keypair in the shape Telnyx publishes: base64 of the 32 raw public bytes. */
function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { privateKey, publicKeyBase64: raw.toString('base64') };
}

function signDelivery(privateKey: ReturnType<typeof keypair>['privateKey'], timestamp: string, body: string) {
  return sign(null, Buffer.from(`${timestamp}|${body}`, 'utf8'), privateKey).toString('base64');
}

const NOW_MS = Date.UTC(2026, 8, 4, 12, 0, 0);
const NOW_SECONDS = Math.floor(NOW_MS / 1000);

describe('Telnyx webhook signatures', () => {
  const { privateKey, publicKeyBase64 } = keypair();
  const key = publicKeyFromBase64(publicKeyBase64);
  const body = 'CallSid=v3%3Acall-1&CallStatus=completed';

  function verify(over: Partial<Parameters<typeof verifyTelnyxSignature>[0]> = {}) {
    const timestampHeader = String(NOW_SECONDS);
    return verifyTelnyxSignature({
      rawBody: body,
      timestampHeader,
      signatureHeader: signDelivery(privateKey, timestampHeader, body),
      publicKey: key,
      nowMs: NOW_MS,
      ...over,
    });
  }

  it('accepts a delivery signed over `{timestamp}|{body}`', () => {
    expect(verify()).toBe(true);
  });

  it('rejects a tampered body', () => {
    expect(verify({ rawBody: `${body}&Injected=1` })).toBe(false);
  });

  it('rejects a signature from a different key', () => {
    const other = keypair();
    const ts = String(NOW_SECONDS);
    expect(
      verifyTelnyxSignature({
        rawBody: body,
        timestampHeader: ts,
        signatureHeader: signDelivery(other.privateKey, ts, body),
        publicKey: key,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it('rejects replays outside the window, in both directions', () => {
    const stale = String(NOW_SECONDS - 301);
    const future = String(NOW_SECONDS + 301);
    expect(
      verifyTelnyxSignature({
        rawBody: body,
        timestampHeader: stale,
        signatureHeader: signDelivery(privateKey, stale, body),
        publicKey: key,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
    expect(
      verifyTelnyxSignature({
        rawBody: body,
        timestampHeader: future,
        signatureHeader: signDelivery(privateKey, future, body),
        publicKey: key,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it('rejects a validly signed timestamp with trailing junk', () => {
    // The signature covers the whole header, so this verifies cryptographically.
    // Parsing it with parseInt would yield an in-window number and let it pass —
    // the bug this case exists to keep out.
    const header = `${NOW_SECONDS}abc`;
    expect(
      verifyTelnyxSignature({
        rawBody: body,
        timestampHeader: header,
        signatureHeader: signDelivery(privateKey, header, body),
        publicKey: key,
        nowMs: NOW_MS,
      }),
    ).toBe(false);
  });

  it('rejects missing headers, bad base64 and wrong-length signatures', () => {
    expect(verify({ signatureHeader: undefined })).toBe(false);
    expect(verify({ timestampHeader: undefined })).toBe(false);
    expect(verify({ signatureHeader: 'not-base64!!' })).toBe(false);
    expect(verify({ signatureHeader: Buffer.alloc(32).toString('base64') })).toBe(false);
  });

  it('refuses a malformed public key at construction, not at first webhook', () => {
    expect(() => publicKeyFromBase64('c2hvcnQ=')).toThrow(/32 bytes/);
  });

  it('validates through the provider using the raw body, not reparsed params', () => {
    const provider = new TelnyxVoiceProvider({
      apiKey: 'KEY',
      publicKey: publicKeyBase64,
      accountId: 'acct',
      texmlApplicationId: 'app',
      sipConnectionId: 'conn',
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const ok = provider.validateWebhook({
      url: 'https://talkr.test/webhooks/telnyx/voice-status',
      method: 'POST',
      headers: {
        'telnyx-signature-ed25519': signDelivery(privateKey, ts, body),
        'telnyx-timestamp': ts,
      },
      params: { CallSid: 'v3:call-1', CallStatus: 'completed' },
      rawBody: body,
    });
    expect(ok).toBe(true);
  });
});

describe('Telnyx normalization', () => {
  it('maps TeXML call statuses to canonical events, stamped telnyx', () => {
    const events = normalizeTelnyxWebhook('voice-status', {
      CallSid: 'v3:call-1',
      CallStatus: 'in-progress',
      call: 'talkr-call-uuid',
      leg: 'pstn',
      From: '+15125550134',
      To: '+12165550143',
      SequenceNumber: '3',
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'call.answered',
      provider: 'telnyx',
      providerObjectId: 'v3:call-1',
      sequenceNumber: 3,
      data: { talkrCallId: 'talkr-call-uuid', legRole: 'pstn' },
    });
  });

  it('decodes the call id from a conference room name', () => {
    const [event] = normalizeTelnyxWebhook('conference-status', {
      ConferenceSid: 'conf-1',
      StatusCallbackEvent: 'participant-hold',
      FriendlyName: 'talkr-abc-123',
      CallSid: 'v3:part-1',
    });
    expect(event).toMatchObject({
      type: 'conference.participant_hold',
      provider: 'telnyx',
      data: { talkrCallId: 'abc-123', providerParticipantId: 'v3:part-1' },
    });
  });

  it('emits nothing for unknown statuses and for call-control endpoints', () => {
    expect(normalizeTelnyxWebhook('voice-status', { CallSid: 'x', CallStatus: 'weird' })).toEqual([]);
    expect(normalizeTelnyxWebhook('twiml-outbound', { CallSid: 'x' })).toEqual([]);
  });

  it('namespaces idempotency keys so they cannot collide with Twilio', () => {
    const key = idempotencyKeyFor('voice-status', {
      CallSid: 'v3:call-1',
      CallStatus: 'completed',
      SequenceNumber: '2',
    });
    expect(key).toBe('telnyx:voice-status:v3:call-1:completed:2');
    expect(key.startsWith('telnyx:')).toBe(true);
  });
});

describe('TeXML documents', () => {
  const provider = new TelnyxVoiceProvider({
    apiKey: 'KEY',
    publicKey: keypair().publicKeyBase64,
    accountId: 'acct',
    texmlApplicationId: 'app',
    sipConnectionId: 'conn',
  });

  it('dials a number with dual-channel recording and status callbacks', () => {
    const res = provider.buildOutboundDialResponse({
      callerId: '+15125550134',
      to: '+12165550143',
      // Multi-param callback URLs are what the server actually builds, and the
      // `&` between params has to survive as an entity inside an attribute.
      statusCallbackUrl: 'https://talkr.test/webhooks/telnyx/voice-status?call=abc&leg=pstn',
      dialActionUrl: 'https://talkr.test/texml/dial-complete?call=abc',
      record: true,
      recordingStatusCallbackUrl: 'https://talkr.test/webhooks/telnyx/recording?call=abc',
    });
    expect(res.contentType).toBe('text/xml');
    expect(res.body).toContain('<Response>');
    expect(res.body).toContain('record="record-from-answer-dual"');
    expect(res.body).toContain('<Number');
    expect(res.body).toContain('+12165550143');
    expect(res.body).toContain('voice-status?call=abc&amp;leg=pstn');
    // The bare separator would make the document invalid XML.
    expect(res.body).not.toContain('abc&leg');
  });

  it('puts a leg in a conference room with the participant callbacks hold needs', () => {
    const res = provider.buildConferenceResponse({
      roomName: 'talkr-abc-123',
      endConferenceOnExit: true,
      startConferenceOnEnter: true,
      statusCallbackUrl: 'https://talkr.test/webhooks/telnyx/conference-status',
      record: true,
    });
    expect(res.body).toContain('<Conference');
    expect(res.body).toContain('talkr-abc-123');
    expect(res.body).toContain('statusCallbackEvent="start end join leave hold"');
    expect(res.body).toContain('record="record-from-start"');
  });

  it('escapes text that would otherwise break the document', () => {
    const res = provider.buildVoicemailResponse({
      greeting: 'Sellers & buyers <welcome>',
      maxLengthSeconds: 120,
      actionUrl: 'https://talkr.test/texml/voicemail-complete',
      recordingStatusCallbackUrl: 'https://talkr.test/webhooks/telnyx/recording',
    });
    expect(res.body).toContain('Sellers &amp; buyers &lt;welcome&gt;');
    expect(res.body).not.toContain('<welcome>');
  });
});

describe('Telnyx REST', () => {
  function providerWith(handler: (url: string, init: RequestInit) => Response) {
    const calls: Array<{ url: string; method: string; body: string; auth: string }> = [];
    const provider = new TelnyxVoiceProvider(
      {
        apiKey: 'KEY',
        publicKey: keypair().publicKeyBase64,
        accountId: 'acct',
        texmlApplicationId: 'app',
        sipConnectionId: 'conn',
        messagingProfileId: 'profile-1',
      },
      {
        fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
          const headers = (init?.headers ?? {}) as Record<string, string>;
          calls.push({
            url: String(url),
            method: init?.method ?? 'GET',
            body: String(init?.body ?? ''),
            auth: headers.authorization ?? '',
          });
          return handler(String(url), init ?? {});
        }) as typeof fetch,
      },
    );
    return { provider, calls };
  }

  it('holds a participant on the TeXML REST surface, by conference id, with the Bearer key', async () => {
    const { provider, calls } = providerWith(() => new Response('{}', { status: 200 }));
    // The conference-status callback told us the room's id.
    provider.rememberConferenceSid('talkr-abc', 'conf-1');
    await provider.updateParticipant('talkr-abc', 'v3:part-1', { hold: true });
    expect(calls).toHaveLength(1);
    // The v2 host's TeXML path, the room by id (never by name), no .json suffix.
    expect(calls[0]!.url).toBe(
      'https://api.telnyx.com/v2/texml/Accounts/acct/Conferences/conf-1/Participants/v3%3Apart-1',
    );
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.body).toBe('Hold=true');
    expect(calls[0]!.auth).toBe('Bearer KEY');
  });

  it('creates outbound calls on the v2 surface against the TeXML app, with Bearer', async () => {
    const { provider, calls } = providerWith(
      () => new Response(JSON.stringify({ sid: 'v3:new-call' }), { status: 200 }),
    );
    const created = await provider.createCall({
      from: '+15125550134',
      to: '+12165550143',
      answerUrl: 'https://talkr.test/twiml/campaign-answer',
      statusCallbackUrl: 'https://talkr.test/webhooks/telnyx/voice-status',
    });
    expect(created).toEqual({ providerCallId: 'v3:new-call' });
    expect(calls[0]!.url).toBe('https://api.telnyx.com/v2/texml/calls/app');
    expect(calls[0]!.auth).toBe('Bearer KEY');
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      From: '+15125550134',
      To: '+12165550143',
      Url: 'https://talkr.test/twiml/campaign-answer',
    });
  });

  it('dials a whispering supervisor silently, coaching the rep, with no call status callback', async () => {
    const { provider, calls } = providerWith(
      () => new Response(JSON.stringify({ call_sid: 'v3:sup-1' }), { status: 200 }),
    );
    provider.rememberConferenceSid('talkr-abc', 'conf-1');
    await provider.addParticipant({
      roomName: 'talkr-abc',
      callerId: '+15125550134',
      to: 'sip:mgr@sip.telnyx.com',
      endConferenceOnExit: false,
      beep: false,
      muted: false,
      coaching: true,
      callSidToCoach: 'v3:agent-1',
    });
    const form = new URLSearchParams(calls[0]!.body);
    expect(form.get('Coaching')).toBe('true');
    expect(form.get('CallSidToCoach')).toBe('v3:agent-1');
    expect(form.get('Muted')).toBe('false');
    expect(form.get('Beep')).toBe('false');
    expect(form.get('EndConferenceOnExit')).toBe('false');
    expect(form.has('StatusCallback')).toBe(false);

    // whisper → listen turns coaching off explicitly.
    await provider.updateParticipant('talkr-abc', 'v3:sup-1', { muted: true, coaching: false });
    expect(calls[1]!.body).toBe('Muted=true&Coaching=false');
  });

  it('treats a participant who already left as the desired end state', async () => {
    const { provider } = providerWith(() => new Response('gone', { status: 404 }));
    await expect(provider.removeParticipant('talkr-abc', 'v3:gone')).resolves.toBeUndefined();
    await expect(
      provider.updateParticipant('talkr-abc', 'v3:gone', { hold: true }),
    ).resolves.toBeUndefined();
    await expect(provider.listParticipants('talkr-abc')).resolves.toEqual([]);
  });

  it('surfaces a real REST failure instead of swallowing it', async () => {
    const { provider } = providerWith(() => new Response('boom', { status: 500 }));
    await expect(provider.removeParticipant('talkr-abc', 'v3:part-1')).rejects.toThrow(/500/);
  });

  it('sends SMS as v2 JSON with the messaging profile', async () => {
    const { provider, calls } = providerWith(
      () => new Response(JSON.stringify({ data: { id: 'msg-1' } }), { status: 200 }),
    );
    const sent = await provider.sendMessage({
      from: '+15125550134',
      to: '+12165550143',
      body: 'Still open to a cash offer?',
      statusCallbackUrl: 'https://talkr.test/webhooks/telnyx/sms-status',
    });
    expect(sent).toEqual({ providerMessageId: 'msg-1' });
    expect(calls[0]!.url).toBe('https://api.telnyx.com/v2/messages');
    expect(JSON.parse(calls[0]!.body)).toMatchObject({
      from: '+15125550134',
      to: '+12165550143',
      text: 'Still open to a cash offer?',
      messaging_profile_id: 'profile-1',
      webhook_url: 'https://talkr.test/webhooks/telnyx/sms-status',
    });
  });

  it('creates one credential per identity and remints only the token', async () => {
    let tokenCalls = 0;
    const { provider, calls } = providerWith((url) => {
      if (url.endsWith('/token')) {
        tokenCalls += 1;
        return new Response(`jwt-${tokenCalls}`, { status: 200 });
      }
      // Telnyx generates the SIP username; it is not ours to choose.
      return new Response(
        JSON.stringify({ data: { id: 'cred-1', sip_username: 'gencred-abc123' } }),
        { status: 200 },
      );
    });
    const first = await provider.mintClientToken('user-uuid', 600);
    const second = await provider.mintClientToken('user-uuid', 600);
    expect(first).toEqual({ token: 'jwt-1', identity: 'user-uuid', ttlSeconds: 600 });
    expect(second.token).toBe('jwt-2');
    // One credential creation, two token mints.
    expect(calls.filter((c) => c.url.endsWith('/telephony_credentials'))).toHaveLength(1);
    expect(tokenCalls).toBe(2);
    // The generated username, not the platform id, is what the wire dials.
    expect(await provider.ensureCredential('user-uuid')).toEqual({
      credentialId: 'cred-1',
      sipUsername: 'gencred-abc123',
    });
  });

  it('addresses a browser over SIP, and refuses without a credential', () => {
    const { provider } = providerWith(() => new Response('{}', { status: 200 }));
    expect(
      provider.formatClientAddress({ userId: 'user-uuid', sipUsername: 'gencred-abc123' }),
    ).toBe('sip:gencred-abc123@sip.telnyx.com');
    // Dialing a rep who never enabled their softphone must fail loudly rather
    // than emit an address that rings nothing.
    expect(() => provider.formatClientAddress({ userId: 'user-uuid' })).toThrow(
      /has not|no Telnyx SIP credential/,
    );
  });

  it('rings browsers with the Sip noun, since TeXML has no Client noun', () => {
    const { provider } = providerWith(() => new Response('{}', { status: 200 }));
    const res = provider.buildClientDialResponse({
      callerId: '+15125550134',
      clientIdentities: [
        { userId: 'user-a', sipUsername: 'gencred-aaa' },
        { userId: 'user-b', sipUsername: 'gencred-bbb' },
      ],
      talkrCallId: 'call-1',
      timeoutSeconds: 20,
      dialActionUrl: 'https://talkr.test/texml/inbound-dial-complete',
      statusCallbackUrl: 'https://talkr.test/webhooks/telnyx/voice-status',
      record: true,
    });
    expect(res.body).toContain('<Sip');
    expect(res.body).not.toContain('<Client');
    expect(res.body).toContain('sip:gencred-aaa@sip.telnyx.com');
    expect(res.body).toContain('sip:gencred-bbb@sip.telnyx.com');
  });

  describe('unsigned 2010-04-01 SMS webhooks', () => {
    const SID = '4031a135-92a7-48b8-ac32-c3d11ec2a5d3';
    function record(over: Record<string, unknown> = {}) {
      return new Response(
        JSON.stringify({
          data: {
            id: SID,
            direction: 'inbound',
            messaging_profile_id: 'profile-1',
            text: 'carrier body',
            from: { phone_number: '+15125550101' },
            to: [{ phone_number: '+15125550102', status: 'webhook_delivered' }],
            ...over,
          },
        }),
        { status: 200 },
      );
    }
    const posted = { MessageSid: SID, From: '+19999999999', To: '+15125550102', Body: 'forged body' };

    it('confirms an inbound text from the carrier record and stores its numbers and body', async () => {
      const { provider, calls } = providerWith(() => record());
      const out = await provider.confirmMessageWebhook('inbound-sms', posted);
      expect(calls[0]!.url).toBe(`https://api.telnyx.com/v2/messages/${SID}`);
      expect(calls[0]!.auth).toBe('Bearer KEY');
      expect(out).toMatchObject({ MessageSid: SID, From: '+15125550101', To: '+15125550102', Body: 'carrier body' });
    });

    it('confirms a status callback for an outbound message', async () => {
      const { provider } = providerWith(() =>
        record({ direction: 'outbound', from: { phone_number: '+15125550103' }, to: [{ phone_number: '+15125550104' }] }),
      );
      const out = await provider.confirmMessageWebhook('sms-status', { MessageSid: SID, MessageStatus: 'delivered' });
      expect(out).toMatchObject({ MessageStatus: 'delivered', From: '+15125550103', To: '+15125550104' });
      expect(out!.Body).toBeUndefined();
    });

    it('rejects a message the carrier does not have, or that is not ours', async () => {
      expect(await providerWith(() => new Response('{}', { status: 404 })).provider.confirmMessageWebhook('inbound-sms', posted)).toBeNull();
      expect(await providerWith(() => record({ messaging_profile_id: 'other' })).provider.confirmMessageWebhook('inbound-sms', posted)).toBeNull();
      expect(await providerWith(() => record({ direction: 'outbound' })).provider.confirmMessageWebhook('inbound-sms', posted)).toBeNull();
      expect(await providerWith(() => record({ id: 'someone-else' })).provider.confirmMessageWebhook('inbound-sms', posted)).toBeNull();
      expect(await providerWith(() => { throw new Error('network'); }).provider.confirmMessageWebhook('inbound-sms', posted)).toBeNull();
    });

    it('never calls the carrier for a missing or malformed sid', async () => {
      const { provider, calls } = providerWith(() => record());
      expect(await provider.confirmMessageWebhook('inbound-sms', { ...posted, MessageSid: '' })).toBeNull();
      expect(await provider.confirmMessageWebhook('inbound-sms', { ...posted, MessageSid: '../phone_numbers' })).toBeNull();
      expect(calls).toHaveLength(0);
    });
  });
});

describe('flattenMessagingEvent (Messaging API v2 JSON)', () => {
  const finalized = {
    data: {
      event_type: 'message.finalized',
      occurred_at: '2026-10-14T19:12:45.407+00:00',
      record_type: 'event',
      payload: {
        id: '4031a13b-d4ce-46ff-a9b3-b53c931223ac',
        to: [{ status: 'delivered', phone_number: '+14045550100' }],
        from: { phone_number: '+18305550100' },
        parts: 1,
        errors: [],
        direction: 'outbound',
      },
    },
  };

  it('turns a delivery receipt into the TeXML-style status params', () => {
    const p = flattenMessagingEvent('sms-status', finalized)!;
    expect(p).toMatchObject({
      MessageSid: '4031a13b-d4ce-46ff-a9b3-b53c931223ac',
      MessageStatus: 'delivered',
      From: '+18305550100',
      To: '+14045550100',
      NumSegments: '1',
    });
    const [event] = normalizeTelnyxWebhook('sms-status', p);
    expect(event).toMatchObject({ type: 'message.status', providerObjectId: '4031a13b-d4ce-46ff-a9b3-b53c931223ac' });
    expect((event as { data: { status: string } }).data.status).toBe('delivered');
  });

  it('maps sending_failed and carries the error code', () => {
    const body = structuredClone(finalized);
    body.data.payload.to[0]!.status = 'sending_failed';
    (body.data.payload as { errors: unknown[] }).errors = [{ code: '40008', title: 'Unreachable' }];
    const p = flattenMessagingEvent('sms-status', body)!;
    expect(p.ErrorCode).toBe('40008');
    const [event] = normalizeTelnyxWebhook('sms-status', p);
    expect((event as { data: { status: string } }).data.status).toBe('failed');
  });

  it('turns message.received into inbound params with media', () => {
    const p = flattenMessagingEvent('inbound-sms', {
      data: {
        event_type: 'message.received',
        record_type: 'event',
        payload: {
          id: 'in-1',
          from: { phone_number: '+14045550101' },
          to: [{ phone_number: '+18305550100', status: 'webhook_delivered' }],
          text: 'Call me after 3',
          media: [{ url: 'https://media.example/a.jpg', content_type: 'image/jpeg' }],
          parts: 1,
        },
      },
    })!;
    expect(p).toMatchObject({ MessageSid: 'in-1', From: '+14045550101', To: '+18305550100', Body: 'Call me after 3', NumMedia: '1', MediaUrl0: 'https://media.example/a.jpg' });
    const [event] = normalizeTelnyxWebhook('inbound-sms', p);
    expect(event).toMatchObject({ type: 'message.received', providerObjectId: 'in-1' });
  });

  it('leaves form params and other endpoints alone', () => {
    expect(flattenMessagingEvent('sms-status', { MessageSid: 'x', MessageStatus: 'sent' })).toBeNull();
    expect(flattenMessagingEvent('voice-status', finalized)).toBeNull();
    expect(flattenMessagingEvent('sms-status', null)).toBeNull();
  });
});
