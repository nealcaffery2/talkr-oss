/**
 * Transcription pipeline, vendor side (docs/transcription.md). No database:
 * both vendor calls take an injected fetch, so this pins the request shapes
 * we send and the speaker mapping we derive from what comes back.
 */

import { describe, expect, it } from 'vitest';
import {
  ANTHROPIC_VERSION,
  mapDualChannelSpeakers,
  mapMonoSpeakers,
  repTalkRatio,
  summarizeTranscript,
  transcribeAudio,
  type DeepgramUtterance,
} from '../src/services/transcription.js';

function utt(partial: Partial<DeepgramUtterance> & Pick<DeepgramUtterance, 'start' | 'end'>): DeepgramUtterance {
  return { confidence: 0.9, channel: 0, transcript: 'x', ...partial };
}

function fakeFetch(body: unknown, status = 200): { calls: Array<{ url: string; init: RequestInit }>; fetch: typeof fetch } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetch: impl };
}

describe('speaker mapping', () => {
  it('dual-channel: channel 0 is the rep, channel 1 the owner', () => {
    const segs = mapDualChannelSpeakers([
      utt({ start: 0.5, end: 1.2, channel: 1, transcript: 'Hello?' }),
      utt({ start: 1.4, end: 3.0, channel: 0, transcript: 'Hi, this is Sam with Your Company.' }),
    ]);
    expect(segs.map((s) => s.speaker)).toEqual(['contact', 'rep']);
  });

  it('mono: the first voice takes the given label, the second the other party, a third is unknown', () => {
    const segs = mapMonoSpeakers(
      [
        utt({ start: 2, end: 3, speaker: 1, transcript: 'second voice' }),
        utt({ start: 0, end: 1, speaker: 0, transcript: 'first voice' }),
        utt({ start: 4, end: 5, speaker: 2, transcript: 'third voice' }),
        utt({ start: 6, end: 7, speaker: 0, transcript: 'first again' }),
      ],
      'contact',
    );
    expect(segs.map((s) => [s.start, s.speaker])).toEqual([
      [0, 'contact'],
      [2, 'rep'],
      [4, 'unknown'],
      [6, 'contact'],
    ]);
  });

  it('reports no ratio when only one voice was ever identified', () => {
    // A mono conference mix Deepgram could not diarize: every utterance lands
    // on one label. 0% would be a confident lie, in the card and in the
    // coaching prompt, so the answer is "unknown".
    expect(
      repTalkRatio([
        { start: 0, end: 3, speaker: 'contact', text: '', confidence: 1 },
        { start: 3, end: 9, speaker: 'contact', text: '', confidence: 1 },
      ]),
    ).toBeNull();
    // Same when the only voice is the rep's.
    expect(
      repTalkRatio([{ start: 0, end: 4, speaker: 'rep', text: '', confidence: 1 }]),
    ).toBeNull();
  });

  it('still reports a real zero when both parties were identified', () => {
    // Two labels means the separation worked, so a rep who genuinely said
    // nothing in the labelled audio is a fact worth showing.
    expect(
      repTalkRatio([
        { start: 0, end: 4, speaker: 'contact', text: '', confidence: 1 },
        { start: 4, end: 4, speaker: 'rep', text: '', confidence: 1 },
      ]),
    ).toBe(0);
  });

  it('talk ratio is the rep share of labelled speaking time', () => {
    expect(
      repTalkRatio([
        { start: 0, end: 3, speaker: 'rep', text: '', confidence: 1 },
        { start: 3, end: 4, speaker: 'contact', text: '', confidence: 1 },
        { start: 4, end: 9, speaker: 'unknown', text: '', confidence: 1 },
      ]),
    ).toBe(0.75);
    expect(repTalkRatio([])).toBeNull();
  });
});

describe('transcribeAudio', () => {
  it('sends nova-3 with multichannel for a two-channel recording and reads utterances back', async () => {
    const { calls, fetch } = fakeFetch({
      metadata: { duration: 12.4 },
      results: {
        channels: [{ detected_language: 'en' }],
        utterances: [
          { start: 1, end: 2, confidence: 0.8, channel: 1, transcript: 'Hello?' },
          { start: 2.5, end: 4, confidence: 0.95, channel: 0, transcript: 'Hi there.' },
        ],
      },
    });
    const result = await transcribeAudio({
      apiKey: 'dg-key',
      audio: new Uint8Array([1, 2, 3]),
      contentType: 'audio/mpeg',
      channels: 2,
      firstSpeaker: 'contact',
      fetchImpl: fetch,
    });

    const url = new URL(calls[0]!.url);
    expect(url.origin + url.pathname).toBe('https://api.deepgram.com/v1/listen');
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model: 'nova-3',
      smart_format: 'true',
      punctuate: 'true',
      utterances: 'true',
      language: 'en-US',
      multichannel: 'true',
    });
    expect(calls[0]!.init.headers).toEqual({ authorization: 'Token dg-key', 'content-type': 'audio/mpeg' });

    expect(result.model).toBe('nova-3-multichannel');
    expect(result.durationSeconds).toBe(12);
    expect(result.segments.map((s) => s.speaker)).toEqual(['contact', 'rep']);
    expect(result.fullText).toBe('[0:01] Owner: Hello?\n[0:02] Rep: Hi there.');
  });

  it('asks for diarization on mono and fails loudly on a vendor error', async () => {
    const ok = fakeFetch({ results: { utterances: [] } });
    await transcribeAudio({
      apiKey: 'k', audio: new Uint8Array(), contentType: 'audio/mpeg', channels: 1, firstSpeaker: 'rep', fetchImpl: ok.fetch,
    });
    expect(new URL(ok.calls[0]!.url).searchParams.get('diarize')).toBe('true');

    const bad = fakeFetch({ err_msg: 'nope' }, 401);
    await expect(
      transcribeAudio({
        apiKey: 'k', audio: new Uint8Array(), contentType: 'audio/mpeg', channels: 1, firstSpeaker: 'rep', fetchImpl: bad.fetch,
      }),
    ).rejects.toThrow(/Deepgram 401/);
  });
});

describe('summarizeTranscript', () => {
  const notes = {
    summary: 'Owner is curious but not in a hurry.',
    key_points: ['3/2 in Converse', 'wants around 185'],
    seller_motivation: 'relocating for work',
    timeline: 'after the holidays',
    asking_price: 'around 185',
    property_condition: 'roof is 15 years old',
    objections: ['thinks the offer will be low'],
    next_step: 'Sam calls back Monday with a number',
    sentiment: 'neutral',
  };

  it('posts a structured-output request and returns the validated notes', async () => {
    const { calls, fetch } = fakeFetch({
      model: 'claude-sonnet-5',
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: JSON.stringify(notes) }],
      usage: { input_tokens: 900, output_tokens: 120 },
    });
    const result = await summarizeTranscript({
      apiKey: 'sk-ant',
      model: 'claude-sonnet-5',
      transcriptText: '[0:00] Owner: Hello?',
      context: { direction: 'outbound', durationSeconds: 300, contactName: 'Pat Owner' },
      fetchImpl: fetch,
    });

    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]!.init.headers).toEqual({
      'x-api-key': 'sk-ant',
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    });
    const body = JSON.parse(calls[0]!.init.body as string) as {
      model: string;
      max_tokens: number;
      output_config: { effort?: string; format: { type: string; schema: { required: string[] } } };
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.output_config.effort).toBe('low');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema.required).toContain('next_step');
    expect(body.messages[0]!.content).toContain('Call: outbound, with Pat Owner, 5 min.');

    expect(result.model).toBe('claude-sonnet-5');
    expect(result.next_step).toBe(notes.next_step);
    expect(result.usage).toEqual({ input_tokens: 900, output_tokens: 120 });
  });

  it('omits effort for Haiku and treats a refusal or schema drift as a failure', async () => {
    const haiku = fakeFetch({ model: 'claude-haiku-4-5', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(notes) }] });
    await summarizeTranscript({
      apiKey: 'k', model: 'claude-haiku-4-5', transcriptText: 'x', context: { direction: 'inbound', durationSeconds: null, contactName: null }, fetchImpl: haiku.fetch,
    });
    const body = JSON.parse(haiku.calls[0]!.init.body as string) as { output_config: Record<string, unknown> };
    expect(body.output_config.effort).toBeUndefined();

    const refused = fakeFetch({ model: 'm', stop_reason: 'refusal', content: [] });
    await expect(
      summarizeTranscript({ apiKey: 'k', model: 'm', transcriptText: 'x', context: { direction: 'inbound', durationSeconds: null, contactName: null }, fetchImpl: refused.fetch }),
    ).rejects.toThrow(/declined/);

    const drift = fakeFetch({ model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify({ summary: 'only this' }) }] });
    await expect(
      summarizeTranscript({ apiKey: 'k', model: 'm', transcriptText: 'x', context: { direction: 'inbound', durationSeconds: null, contactName: null }, fetchImpl: drift.fetch }),
    ).rejects.toThrow(/did not match the schema/);
  });
});
