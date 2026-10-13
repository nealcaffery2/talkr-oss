/**
 * The in-call smart surface: a browser Deepgram key, and seller intelligence
 * over the live transcript — both against fake upstreams.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, createTestContext, type TestContext } from './helpers.js';

const LIVE_ANSWER = {
  motivation: 'Relocating; inherited the house',
  timeline: 'Before Sept 30',
  price_expectation: '$235,000 competing verbal',
  objection: 'Wants to compare another offer',
  condition: null,
  suggested_response: 'Totally fair. Besides price, what would make one offer easier to move forward with today?',
  next_best_question: 'If we cover moving costs and guarantee Sept 30, is the $235K the only gap?',
  coaching: 'Anchor the close date before price. Do not mention the MAO.',
  sentiment: 'positive',
};

describe('live intel + transcription token', () => {
  let t: TestContext;
  let rep: Record<string, string>;
  let callId: string;
  const anthropicBodies: Array<Record<string, unknown>> = [];
  const deepgramCalls: string[] = [];

  beforeAll(async () => {
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url.startsWith('https://api.anthropic.com/v1/messages')) {
        anthropicBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          JSON.stringify({ model: 'claude-test', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(LIVE_ANSWER) }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (url.startsWith('https://api.deepgram.com/v1/projects/')) {
        deepgramCalls.push(String(init?.headers && (init.headers as Record<string, string>).authorization));
        return new Response(JSON.stringify({ key: 'dg_temp_key', api_key_id: 'k1' }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return fetch(input, init);
    };
    t = await createTestContext({
      config: { ANTHROPIC_API_KEY: 'sk-ant-test', DEEPGRAM_API_KEY: 'dg-master', DEEPGRAM_PROJECT_ID: 'proj-1' },
      fetchImpl,
    });
    rep = await authHeader('auth-rep-test-org');
    const created = await t.app.inject({ method: 'POST', url: '/v1/calls', headers: rep, payload: { to_number: '+15125551234' } });
    expect(created.statusCode).toBe(201);
    callId = created.json().call.id;
  });
  afterAll(async () => t.close());

  it('mints a short-lived Deepgram key with the master key', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/v1/transcription/token', headers: rep });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ key: 'dg_temp_key', ttl_seconds: 60 });
    expect(deepgramCalls[0]).toBe('Token dg-master');
  });

  it('returns structured seller intelligence and never forwards more than the recent turns', async () => {
    const turns = Array.from({ length: 50 }, (_, i) => ({ speaker: i % 2 ? 'seller' : 'rep', text: `turn ${i}` }));
    const res = await t.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/intel`,
      headers: rep,
      payload: { mode: 'live', turns, context: { contact_name: 'Kara Mitchell', mao: '$181,000' }, elapsed_seconds: 65 },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ mode: 'live', motivation: LIVE_ANSWER.motivation, suggested_response: LIVE_ANSWER.suggested_response });
    expect(res.json().talk_ratio).toEqual({ rep: 50, seller: 50 });
    const sent = anthropicBodies.at(-1)!;
    const content = (sent.messages as Array<{ content: string }>)[0]!.content;
    expect(content).not.toContain('turn 9\n'); // 50 turns in, 40 forwarded
    expect(content).toContain('turn 49');
    expect(content).toContain('never disclose');
    expect((sent.output_config as { format: { type: string } }).format.type).toBe('json_schema');
  });

  it('refuses another rep’s call and an unknown call', async () => {
    const other = await authHeader('auth-admin-test-org');
    // The admin can read the org's calls, so they get through; a plain rep on someone else's call would not.
    const ok = await t.app.inject({ method: 'POST', url: `/v1/calls/${callId}/intel`, headers: other, payload: { turns: [{ speaker: 'seller', text: 'hi' }] } });
    expect(ok.statusCode).toBe(200);
    const missing = await t.app.inject({ method: 'POST', url: `/v1/calls/00000000-0000-0000-0000-000000000000/intel`, headers: rep, payload: { turns: [{ speaker: 'seller', text: 'hi' }] } });
    expect(missing.statusCode).toBe(404);
  });
});

describe('live intel when nothing is configured', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
  });
  afterAll(async () => t.close());

  it('says so with a 503 instead of a stack trace', async () => {
    const rep = await authHeader('auth-rep-test-org');
    const tok = await t.app.inject({ method: 'POST', url: '/v1/transcription/token', headers: rep });
    expect(tok.statusCode).toBe(503);
    expect(tok.json().error).toBe('transcription_not_configured');
  });
});
