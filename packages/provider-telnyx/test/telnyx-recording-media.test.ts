/**
 * Recording media, the half of the Telnyx adapter that broke the whole
 * transcription pipeline in production (docs/transcription.md §2).
 *
 * The bug these pin: the media fetch was Twilio-shaped — `.mp3` appended to
 * the stored URL and an `Authorization` header on the request — while Telnyx
 * stores a pre-signed S3 link that already ends in `.mp3` and is signed for
 * `host` alone. S3 answered 400 to every transcript, every mirror and every
 * audio request for as long as that shape was shipped.
 */

import { describe, expect, it } from 'vitest';
import { TelnyxVoiceProvider } from '../src/index.js';

const ACCOUNT = 'acct-1';
const RECORDING_ID = '00000000-0000-4000-8000-0000000000ec';

/** A pre-signed link shaped like the ones the recording webhook carries. */
function presigned(opts: { signedAt: Date; expiresSeconds: number; ext?: string }): string {
  const stamp = opts.signedAt.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  return (
    `https://s3.amazonaws.com/telephony-recorder-prod/${ACCOUNT}/2026-09-21/call-179.${opts.ext ?? 'mp3'}` +
    `?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Date=${stamp}` +
    `&X-Amz-Expires=${opts.expiresSeconds}&X-Amz-SignedHeaders=host&X-Amz-Signature=abc123`
  );
}

interface Call {
  url: string;
  auth: string | undefined;
}

/** Records every request; `responder` decides what each URL answers. */
function transport(responder: (url: string) => Response): { calls: Call[]; fetch: typeof fetch } {
  const calls: Call[] = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url, auth: headers.authorization });
    return responder(url);
  }) as typeof fetch;
  return { calls, fetch: impl };
}

function provider(fetchImpl: typeof fetch): TelnyxVoiceProvider {
  return new TelnyxVoiceProvider(
    {
      apiKey: 'telnyx-test-key',
      publicKey: Buffer.alloc(32).toString('base64'),
      accountId: ACCOUNT,
      texmlApplicationId: 'texml-app',
      sipConnectionId: 'sip-conn',
    },
    { fetchImpl },
  );
}

const AUDIO = new Uint8Array([0xff, 0xfb, 0x90, 0x00]);
const audioResponse = () => new Response(AUDIO, { status: 200 });

describe('Telnyx recording media', () => {
  it('downloads a live pre-signed URL untouched: no suffix, no Authorization header', async () => {
    const url = presigned({ signedAt: new Date(), expiresSeconds: 600 });
    const t = transport(audioResponse);

    const media = await provider(t.fetch).fetchRecordingMedia({
      providerUrl: url,
      providerRecordingId: RECORDING_ID,
      format: 'mp3',
    });

    expect(t.calls).toHaveLength(1);
    // The two things that produced `media fetch failed: 400` in production.
    expect(t.calls[0]!.url).toBe(url);
    expect(t.calls[0]!.url).not.toContain('.mp3?X-Amz-Signature');
    expect(t.calls[0]!.auth).toBeUndefined();
    expect(media.contentType).toBe('audio/mpeg');
    expect(media.format).toBe('mp3');
    expect(media.bytes).toEqual(AUDIO);
  });

  it('mints a fresh link from the recording id when the stored one has expired', async () => {
    // Signed yesterday for ten minutes: reading it again is pointless.
    const stale = presigned({
      signedAt: new Date(Date.now() - 24 * 60 * 60_000),
      expiresSeconds: 600,
    });
    const fresh = presigned({ signedAt: new Date(), expiresSeconds: 600 });
    const t = transport((url) => {
      if (url.includes('/v2/recordings/')) {
        return new Response(JSON.stringify({ data: { download_urls: { mp3: fresh, wav: 'x.wav' } } }), {
          status: 200,
        });
      }
      return audioResponse();
    });

    const media = await provider(t.fetch).fetchRecordingMedia({
      providerUrl: stale,
      providerRecordingId: RECORDING_ID,
      format: 'mp3',
    });

    // The expired URL is never requested; the lookup carries the API key and
    // the fresh link, like any pre-signed link, carries none.
    expect(t.calls.map((c) => c.url)).toEqual([
      `https://api.telnyx.com/v2/recordings/${RECORDING_ID}`,
      fresh,
    ]);
    expect(t.calls[0]!.auth).toBe('Bearer telnyx-test-key');
    expect(t.calls[1]!.auth).toBeUndefined();
    expect(media.bytes).toEqual(AUDIO);
  });

  it('falls back to a fresh link when a live URL fails anyway', async () => {
    const url = presigned({ signedAt: new Date(), expiresSeconds: 600 });
    const fresh = presigned({ signedAt: new Date(), expiresSeconds: 900 });
    const t = transport((requested) => {
      if (requested === url) return new Response('expired', { status: 403 });
      if (requested.includes('/v2/recordings/')) {
        return new Response(JSON.stringify({ data: { download_urls: { mp3: fresh } } }), { status: 200 });
      }
      return audioResponse();
    });

    const media = await provider(t.fetch).fetchRecordingMedia({
      providerUrl: url,
      providerRecordingId: RECORDING_ID,
    });
    expect(t.calls).toHaveLength(3);
    expect(media.bytes).toEqual(AUDIO);
  });

  it('reads the TeXML recording resource when v2 has no download_urls', async () => {
    const mediaUrl = presigned({ signedAt: new Date(), expiresSeconds: 600, ext: 'wav' });
    const t = transport((url) => {
      if (url.includes('/v2/recordings/')) return new Response('not found', { status: 404 });
      if (url.includes('/texml/Accounts/')) {
        return new Response(JSON.stringify({ sid: RECORDING_ID, media_url: mediaUrl }), { status: 200 });
      }
      return audioResponse();
    });

    const media = await provider(t.fetch).fetchRecordingMedia({ providerRecordingId: RECORDING_ID });

    expect(t.calls[1]!.url).toBe(
      `https://api.telnyx.com/v2/texml/Accounts/${ACCOUNT}/Recordings/${RECORDING_ID}.json`,
    );
    // The container follows the media, not the request: this one is a wav.
    expect(media.format).toBe('wav');
    expect(media.contentType).toBe('audio/wav');
  });

  it('reports the carrier status rather than a bare failure when nothing serves', async () => {
    const t = transport(() => new Response('nope', { status: 404 }));
    await expect(
      provider(t.fetch).fetchRecordingMedia({ providerRecordingId: RECORDING_ID }),
    ).rejects.toThrow(/has no downloadable media/);
  });
});
