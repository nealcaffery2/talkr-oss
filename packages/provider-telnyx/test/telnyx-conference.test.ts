/**
 * Conference REST addressing on Telnyx.
 *
 * Telnyx's TeXML REST lives at /v2/texml/Accounts/{id} with the Bearer key and
 * addresses a conference by its own id, never by the friendly name a <Conference>
 * noun gave it. The adapter resolves the name (or is told the id by a callback)
 * before touching participants; the wrong path and the name in the path were
 * exactly the two things a live account answered 404 to.
 */

import { describe, expect, it } from 'vitest';
import { TelnyxVoiceProvider, idempotencyKeyFor } from '../src/index.js';

const ACCOUNT = '00000000-0000-4000-8000-0000000000ac';
const TEXML = `https://api.telnyx.com/v2/texml/Accounts/${ACCOUNT}`;

function fakeTelnyx(conferences: Array<{ sid: string; friendly_name: string; status: string }>) {
  const calls: Array<{ url: string; method: string; auth: string | undefined; body: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const method = init?.method ?? 'GET';
    calls.push({ url, method, auth: headers.authorization, body: String(init?.body ?? '') });
    if (url.startsWith(`${TEXML}/Conferences?`)) {
      const name = new URL(url).searchParams.get('FriendlyName');
      return new Response(JSON.stringify({ conferences: conferences.filter((c) => c.friendly_name === name) }), { status: 200 });
    }
    if (/\/Conferences\/[^/?]+\/Participants$/.test(url)) {
      if (method === 'POST') return new Response(JSON.stringify({ call_sid: 'v3:seller-leg', status: 'connecting' }), { status: 200 });
      return new Response(JSON.stringify({ participants: [] }), { status: 200 });
    }
    if (/\/Conferences\/[^/?]+\/Participants\/[^/?]+$/.test(url)) return new Response('{}', { status: 200 });
    if (url === `${TEXML}/Calls/gone`) return new Response(JSON.stringify({ errors: [{ detail: 'not found' }] }), { status: 404 });
    if (/\/Calls\/[^/?]+$/.test(url) && method === 'POST') return new Response('{"status":"completed"}', { status: 200 });
    return new Response(JSON.stringify({ errors: [{ detail: 'unexpected' }] }), { status: 404 });
  }) as typeof fetch;
  const provider = new TelnyxVoiceProvider(
    {
      apiKey: 'KEY',
      publicKey: Buffer.alloc(32).toString('base64'),
      accountId: ACCOUNT,
      texmlApplicationId: 'app-1',
      sipConnectionId: 'conn-1',
    },
    { fetchImpl },
  );
  return { provider, calls };
}

const seller = (roomName: string) => ({
  roomName,
  callerId: '+13465550190',
  to: '+12105550192',
  statusCallbackUrl: 'https://talkr.test/webhooks/telnyx/voice-status?leg=pstn',
  endConferenceOnExit: true,
});

describe('Telnyx conference REST addressing', () => {
  it('resolves the room name to the conference id on the v2 TeXML surface, with the Bearer key', async () => {
    const { provider, calls } = fakeTelnyx([{ sid: 'conf-uuid-1', friendly_name: 'talkr-call-1', status: 'in-progress' }]);
    const added = await provider.addParticipant(seller('talkr-call-1'));
    expect(added.providerParticipantId).toBe('v3:seller-leg');
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      `GET ${TEXML}/Conferences?FriendlyName=talkr-call-1&PageSize=20`,
      `POST ${TEXML}/Conferences/conf-uuid-1/Participants`,
    ]);
    expect(calls.every((c) => c.auth === 'Bearer KEY')).toBe(true);
    expect(calls[1]!.body).toContain('To=%2B12105550192');
    expect(calls[1]!.body).toContain('From=%2B13465550190');

    // Known now: the next operation on the room needs no lookup.
    await provider.updateParticipant('talkr-call-1', 'v3:seller-leg', { hold: true });
    expect(calls).toHaveLength(3);
    expect(calls[2]).toMatchObject({ method: 'POST', url: `${TEXML}/Conferences/conf-uuid-1/Participants/v3%3Aseller-leg`, body: 'Hold=true' });
  });

  it('a callback that names the room seeds the id, so nothing is looked up', async () => {
    const { provider, calls } = fakeTelnyx([]);
    provider.rememberConferenceSid('talkr-call-2', 'conf-uuid-2');
    await provider.addParticipant(seller('talkr-call-2'));
    expect(calls.map((c) => c.url)).toEqual([`${TEXML}/Conferences/conf-uuid-2/Participants`]);
  });

  it('a room nobody has joined yet is a 404 to the dial and a no-op to the rest', async () => {
    const { provider, calls } = fakeTelnyx([]);
    await expect(provider.addParticipant(seller('talkr-call-3'))).rejects.toMatchObject({ status: 404 });
    expect(calls).toHaveLength(1);
    await expect(provider.updateParticipant('talkr-call-3', 'x', { hold: true })).resolves.toBeUndefined();
    await expect(provider.removeParticipant('talkr-call-3', 'x')).resolves.toBeUndefined();
    await expect(provider.listParticipants('talkr-call-3')).resolves.toEqual([]);
    // Only lookups went out; nothing was posted to a room that does not exist.
    expect(calls.every((c) => c.method === 'GET' && c.url.startsWith(`${TEXML}/Conferences?`))).toBe(true);
  });

  it('prefers the running room when a name recurs', async () => {
    const { provider, calls } = fakeTelnyx([
      { sid: 'conf-old', friendly_name: 'talkr-call-4', status: 'completed' },
      { sid: 'conf-live', friendly_name: 'talkr-call-4', status: 'in-progress' },
    ]);
    await provider.listParticipants('talkr-call-4');
    expect(calls[1]!.url).toBe(`${TEXML}/Conferences/conf-live/Participants`);
  });

  it('call control is on the same surface, and a call that is already gone counts as done', async () => {
    const { provider, calls } = fakeTelnyx([]);
    await provider.hangupCall('v3:leg-1');
    expect(calls[0]).toMatchObject({ method: 'POST', url: `${TEXML}/Calls/v3%3Aleg-1`, body: 'Status=completed', auth: 'Bearer KEY' });
    await expect(provider.hangupCall('gone')).resolves.toBeUndefined();
    await provider.cancelCall('v3:leg-2');
    expect(calls[2]!.body).toBe('Status=canceled');
  });

  it('names the call-control endpoint the way the server does', () => {
    expect(idempotencyKeyFor('twiml-outbound', { CallSid: 'v3:x' })).toBe('telnyx:twiml-outbound:v3:x');
  });
});
