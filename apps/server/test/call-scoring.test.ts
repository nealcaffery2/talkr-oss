/**
 * AI call scoring, vendor side (docs/coaching.md). No database: the model
 * call takes an injected fetch, so this pins the request shape we send, the
 * refusal and truncation handling, and the fact that the talk ratio is
 * measured and handed over rather than asked for.
 */

import { describe, expect, it } from 'vitest';
import { COACHING_CATEGORY_IDS, type CallScoreDraft } from '@talkr/core';
import { scoreCall, scoreCallHeader } from '../src/services/call-scoring.js';

function fakeFetch(body: unknown, status = 200): { calls: Array<{ url: string; init: RequestInit }>; fetch: typeof fetch } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const impl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  return { calls, fetch: impl };
}

function draft(): CallScoreDraft {
  const categories = Object.fromEntries(
    COACHING_CATEGORY_IDS.map((id) => [id, { score: 6, reason: `${id}: solid` }]),
  ) as CallScoreDraft['categories'];
  return {
    overall: 6,
    categories,
    strengths: ['Held the silence after the number.'],
    gaps: ['Never asked who else is on title.'],
    missed_opportunities: [{ moment: 'Asked about closing costs', quote: 'Who pays the fees?', instead: 'Answer, then ask for the date.' }],
    next_action: 'Call back Monday with a number.',
    seller: {
      bucket: 'motivated_priced_high',
      motivation_score: 7,
      price_alignment_score: 2,
      bucket_confidence: 0.7,
      bucket_rationale: 'Divorce, but wants retail.',
      recommended_play: 'navigate',
      motivation: 'divorce',
      timeline: '90 days',
      condition: 'needs a roof',
      price_expectation: 'around 240',
      emotions: ['tired'],
    },
  };
}

function reply(score: CallScoreDraft, model = 'claude-sonnet-5') {
  return {
    model,
    stop_reason: 'end_turn',
    content: [{ type: 'text', text: JSON.stringify(score) }],
    usage: { input_tokens: 2400, output_tokens: 900 },
  };
}

const context = {
  direction: 'outbound' as const,
  durationSeconds: 480,
  contactName: 'Marla Jensen',
  repName: 'Sam Ortiz',
  disposition: 'Callback',
  repTalkRatio: 0.62,
};

describe('scoreCallHeader', () => {
  it('gives the model the measured talk ratio rather than asking for it', () => {
    expect(scoreCallHeader(context)).toBe(
      'Call: outbound, with Marla Jensen, rep Sam Ortiz, 8 min, rep disposition "Callback", ' +
        'rep spoke 62% of the talking time (measured, not estimated)',
    );
  });

  it('drops what the call does not have', () => {
    expect(
      scoreCallHeader({ direction: 'inbound', durationSeconds: null, contactName: null, repName: null, disposition: null, repTalkRatio: null }),
    ).toBe('Call: inbound');
  });
});

describe('scoreCall', () => {
  it('posts a structured-output request against the house rubric and returns the validated score', async () => {
    const { calls, fetch } = fakeFetch(reply(draft()));
    const result = await scoreCall({
      apiKey: 'sk-test',
      model: 'claude-sonnet-5',
      transcriptText: '[0:01] Rep: Hi there.\n[0:04] Owner: Who is this?',
      context,
      fetchImpl: fetch,
    });

    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]!.init.headers).toEqual({
      'x-api-key': 'sk-test',
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    });

    const body = JSON.parse(String(calls[0]!.init.body)) as {
      model: string;
      max_tokens: number;
      system: string;
      messages: Array<{ role: string; content: string }>;
      output_config: { effort?: string; format: { type: string; schema: { required: string[] } } };
    };
    expect(body.model).toBe('claude-sonnet-5');
    expect(body.output_config.format.type).toBe('json_schema');
    expect(body.output_config.format.schema.required).toContain('categories');
    // Judgement, not extraction — more room to think than the notes summary's `low`.
    expect(body.output_config.effort).toBe('medium');
    // The rubric heritage is in the prompt, not invented per call.
    expect(body.system).toContain('Price x Motivation grid');
    expect(body.system).toContain('Average reps score 5 to 6');
    for (const id of COACHING_CATEGORY_IDS) expect(body.system).toContain(`- ${id}:`);
    expect(body.messages[0]!.content).toContain('rep spoke 62% of the talking time');
    expect(body.messages[0]!.content).toContain('[0:01] Rep: Hi there.');

    expect(result.overall).toBe(6);
    expect(result.seller.bucket).toBe('motivated_priced_high');
    expect(result.model).toBe('claude-sonnet-5');
    expect(result.usage).toEqual({ input_tokens: 2400, output_tokens: 900 });
  });

  it('omits effort for the models that reject it', async () => {
    const { calls, fetch } = fakeFetch(reply(draft(), 'claude-haiku-4-5'));
    await scoreCall({ apiKey: 'k', model: 'claude-haiku-4-5', transcriptText: 't', context, fetchImpl: fetch });
    const body = JSON.parse(String(calls[0]!.init.body)) as { output_config: { effort?: string } };
    expect(body.output_config.effort).toBeUndefined();
  });

  it('treats a refusal, a truncation and a vendor error as failures', async () => {
    const refused = fakeFetch({ model: 'm', stop_reason: 'refusal', content: [] });
    await expect(
      scoreCall({ apiKey: 'k', model: 'claude-sonnet-5', transcriptText: 't', context, fetchImpl: refused.fetch }),
    ).rejects.toThrow(/declined to score/);

    const cut = fakeFetch({ model: 'm', stop_reason: 'max_tokens', content: [{ type: 'text', text: '{' }] });
    await expect(
      scoreCall({ apiKey: 'k', model: 'claude-sonnet-5', transcriptText: 't', context, fetchImpl: cut.fetch }),
    ).rejects.toThrow(/max_tokens/);

    const bad = fakeFetch({ error: { message: 'nope' } }, 429);
    await expect(
      scoreCall({ apiKey: 'k', model: 'claude-sonnet-5', transcriptText: 't', context, fetchImpl: bad.fetch }),
    ).rejects.toThrow(/Anthropic 429/);
  });

  it('refuses a reply that does not match the rubric, naming the field', async () => {
    const wrong = draft() as unknown as { categories: Record<string, unknown> };
    delete wrong.categories.anchoring;
    const { fetch } = fakeFetch(reply(wrong as unknown as CallScoreDraft));
    await expect(
      scoreCall({ apiKey: 'k', model: 'claude-sonnet-5', transcriptText: 't', context, fetchImpl: fetch }),
    ).rejects.toThrow(/categories\.anchoring/);
  });

  it('refuses a reply that is not JSON at all', async () => {
    const { fetch } = fakeFetch({ model: 'm', stop_reason: 'end_turn', content: [{ type: 'text', text: 'sorry, no' }] });
    await expect(
      scoreCall({ apiKey: 'k', model: 'claude-sonnet-5', transcriptText: 't', context, fetchImpl: fetch }),
    ).rejects.toThrow(/not JSON/);
  });
});
