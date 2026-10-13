/**
 * AI call scoring (docs/coaching.md): a second Claude pass over a finished
 * transcript that grades the rep against the house rubric and reads the
 * seller through the Price x Motivation grid.
 *
 * One POST over the global fetch, the same shape as the call-notes summary in
 * transcription.ts — same endpoint, same headers, same structured-output
 * mechanism, no SDK in the serverless bundle. The rubric, the JSON schema and
 * the validator are pure and live in @talkr/core; this module is the network
 * call and the prompt. The scoring job (worker/score-handlers.ts) owns the
 * database side.
 *
 * The rep talk ratio is never asked of the model: it is arithmetic over the
 * transcript segments, computed by repTalkRatio() and handed to the model as
 * a fact it may comment on.
 */

import {
  CALL_SCORE_JSON_SCHEMA,
  COACHING_CATEGORIES,
  validateCallScore,
  type CallScoreDraft,
} from '@talkr/core';
import { ANTHROPIC_URL, ANTHROPIC_VERSION, supportsEffort } from './transcription.js';

/** Enough room for ten reasons, three lists and the seller read-out. */
const MAX_TOKENS = 16_000;

const CATEGORY_BRIEF = COACHING_CATEGORIES.map((c) => `- ${c.id}: ${c.description}`).join('\n');

/**
 * Adapted from prompts/review_call.system.md — the house review prompt — so a
 * 6 here means what a 6 meant there. What changed: the categories are the ten
 * in @talkr/core (the seven house dimensions plus opener, qualifying and next
 * step, which the talk track has and the old prompt only implied), the reply
 * is constrained by a JSON schema rather than asked for as bare JSON, and the
 * inputs are what Talkr actually has (no Podio outcome, no prior extraction
 * pass).
 */
const SYSTEM_PROMPT = `You are a senior real-estate wholesaling sales coach reviewing a recorded acquisitions call for a company that buys houses directly from owners. You are given the transcript of a call between an acquisitions rep (labelled "Rep") and a property owner or their representative (labelled "Owner"). The speaker labels come from an automatic guess and can be swapped; use what is said to tell who is who.

Score the rep, read the seller, and write coaching a rep can act on tomorrow. Report only what was actually said. Never invent a price, a timeline or a motivation the owner did not state.

=== REP SCORING (be honest, not generous) ===

Categories, each 0-10:
${CATEGORY_BRIEF}

1. Average reps score 5 to 6. Top reps score 7 to 8. Mistakes and missed opportunities score 3 to 4. A 9 or 10 is rare and earned.
2. Score against the stage the call actually reached. A 30-second voicemail is not scored like a 12-minute negotiation. Where the call never reached a category — no close attempt on a discovery-only call, no anchoring on a wrong number — set that category's score to null and say so in its reason. Null is not a zero.
3. "overall" is your coach's gut: would you want this rep on your team based on this call? It is NOT a strict average of the categories.
4. For "anchoring", look for whether the rep set a price expectation early and showed the math behind the number.
5. For "objection_handling", look for education over argument, especially where motivation is real and the price is high.

=== SELLER READ-OUT: the Price x Motivation grid ===

Apply it strictly:

1. motivated_priced_right — real pain and a clear timeline, and their number aligns with what we would pay. Rare. Play: lock_it_up; do not talk yourself out of the deal.
2. motivated_priced_high — real pain, but the price is Zillow / retail / dreaming. THE MOST COMMON, and where the money is made by educating on repair costs, closing costs and the math behind the offer. Play: navigate.
3. unmotivated_priced_right — low motivation, reasonable price. Under 1% of calls, and it almost always means undisclosed motivation. Play: dig_deeper.
4. unmotivated_priced_high — low motivation and a high price (newer home, recently remodelled, just skipping agent fees). Play: walk_away; embrace no and move on. If they pull back when we say no, dig_deeper.
5. wrong_number — bad contact, deceased, the person who answered is not the owner. Play: drop or verify_owner.
6. unqualified — not the decision maker, cannot sell (unstoppable foreclosure, severe title issue, part owner without authority). Play: drop or verify_owner.
7. unknown — under roughly 60 seconds of substantive talk. Play: callback.

Rules: bucket the SELLER, not the call outcome. motivation_score and price_alignment_score are independent signals — score each on its own merits, then derive the bucket. If price never came up, set price_alignment_score to null. Lower bucket_confidence and explain when what they signalled and what they said disagree.

=== COACHING ===

- "strengths": 1-3 things the rep genuinely did well, each carrying a verbatim quote so they can find the moment in the recording.
- "gaps": 1-3 things to fix, each saying what the rep should have said instead — not just what went wrong.
- "missed_opportunities": doors the seller opened that the rep walked past. Subtle buying signals (asking how the process works, asking about closing, naming a number first), evasions worth chasing (the thing avoided is the thing being protected), pain mentioned once and never followed up.
- "next_action": one concrete next step for this deal — who does what, by when.

If the call reached voicemail or nobody engaged, say so in every reason, score only what can be scored, and leave the rest null or empty.`;

export interface ScoreCallContext {
  direction: 'outbound' | 'inbound';
  durationSeconds: number | null;
  contactName: string | null;
  /** The rep on the call, so coaching reads as addressed to a person. */
  repName: string | null;
  /** The wrap-up the rep chose, as context — not as the answer. */
  disposition: string | null;
  /** Rep share of speaking time, 0-1. Given to the model, never asked of it. */
  repTalkRatio: number | null;
}

export interface ScoreCallOptions {
  apiKey: string;
  model: string;
  transcriptText: string;
  context: ScoreCallContext;
  fetchImpl?: typeof fetch;
}

export interface ScoreCallResult extends CallScoreDraft {
  /** The model id the API reports back — what actually ran. */
  model: string;
  usage: { input_tokens: number; output_tokens: number } | null;
}

interface AnthropicMessageResponse {
  model: string;
  stop_reason: string | null;
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens: number; output_tokens: number };
}

/** The one-line header above the transcript: what the coach would be told first. */
export function scoreCallHeader(context: ScoreCallContext): string {
  const parts = [
    `Call: ${context.direction}`,
    context.contactName ? `with ${context.contactName}` : null,
    context.repName ? `rep ${context.repName}` : null,
    context.durationSeconds != null ? `${Math.max(1, Math.round(context.durationSeconds / 60))} min` : null,
    context.disposition ? `rep disposition "${context.disposition}"` : null,
    context.repTalkRatio != null
      ? `rep spoke ${Math.round(context.repTalkRatio * 100)}% of the talking time (measured, not estimated)`
      : null,
  ].filter(Boolean);
  return parts.join(', ');
}

export async function scoreCall(opts: ScoreCallOptions): Promise<ScoreCallResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const body = {
    model: opts.model,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [
      { role: 'user', content: `${scoreCallHeader(opts.context)}.\n\nTranscript:\n${opts.transcriptText}` },
    ],
    output_config: {
      // Judgement, not extraction: this pass decides a grade and a bucket, so
      // it gets more room to think than the call-notes summary's `low`.
      // Haiku 4.5 and Sonnet 4.5 reject the field entirely.
      ...(supportsEffort(opts.model) ? { effort: 'medium' } : {}),
      format: { type: 'json_schema', schema: CALL_SCORE_JSON_SCHEMA },
    },
  };

  const res = await doFetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': opts.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Anthropic ${res.status}: ${detail || res.statusText}`);
  }
  const msg = (await res.json()) as AnthropicMessageResponse;
  if (msg.stop_reason === 'refusal') throw new Error('Anthropic declined to score this call');
  if (msg.stop_reason === 'max_tokens') throw new Error('Anthropic score was cut off (max_tokens)');
  const text = msg.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('Anthropic returned no text block');

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Anthropic score was not JSON');
  }
  const validated = validateCallScore(parsed);
  if (!validated.ok) {
    throw new Error(`Anthropic score did not match the schema: ${validated.errors.join('; ')}`);
  }
  return { ...validated.score, model: msg.model, usage: msg.usage ?? null };
}
