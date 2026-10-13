/**
 * AI sequence builder (docs/sequences.md §7): one Messages-API call over the
 * global fetch — the same single-endpoint shape as transcription.ts, no SDK
 * in the serverless bundle — asking Claude for a TCPA-safe SMS follow-up
 * sequence as structured JSON, then running it through the pure validator in
 * @talkr/core. A draft that fails validation is sent back once with the
 * failures spelled out; a second failure is the caller's 502. The result is
 * a *draft*: it lands in the builder for a human to edit and save, it is
 * never persisted or sent from here.
 */

import {
  AI_SEQUENCE_DRAFT_JSON_SCHEMA,
  AI_SMS_MAX_CHARS,
  MERGE_FIELDS,
  validateSequenceDraft,
  type SequenceDraft,
} from '@talkr/core';
import type { Logger } from '../logger.js';

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

export type DraftTone = 'friendly' | 'direct' | 'professional';

export interface DraftRequest {
  goal: string;
  audience?: string | null;
  tone: DraftTone;
  channel: 'sms';
  /** How many SMS the sequence should contain (2-8). */
  steps: number;
  /** The span the whole sequence must fit in (1-60 days). */
  days: number;
}

export interface DraftContext {
  /** Renders as {company}; from the org row unless the caller overrides it. */
  companyName: string;
  /** The caller's display name — what {rep_name} renders as for them. */
  repName: string;
}

export type SequenceAiErrorCode = 'ai_refused' | 'ai_invalid_draft' | 'ai_upstream';

export class SequenceAiError extends Error {
  constructor(
    public readonly code: SequenceAiErrorCode,
    message: string,
    public readonly details: string[] = [],
  ) {
    super(message);
  }
}

export interface DraftUsage {
  input_tokens: number;
  output_tokens: number;
  attempts: number;
}

export interface DraftResult {
  draft: SequenceDraft;
  warnings: string[];
  /** The model id the API reports back — what actually ran. */
  model: string;
  usage: DraftUsage;
}

export interface DraftOptions {
  apiKey: string;
  model: string;
  request: DraftRequest;
  context: DraftContext;
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

const SYSTEM_PROMPT = `You write SMS follow-up sequences for a real-estate acquisitions company that buys houses directly from owners. You are an expert at short, human, compliant text follow-up for homeowner and motivated-seller leads, and you know the TCPA and CTIA messaging rules cold.

Hard rules — every one of them is checked by a validator before a person sees your draft:
- Every SMS is at most ${AI_SMS_MAX_CHARS} characters. Prefer under 160.
- The FIRST SMS says who is texting — use {rep_name} and {company} — and ends with opt-out language such as "Reply STOP to opt out."
- No misleading urgency, fake deadlines, countdowns, pressure or ALL CAPS. Never "final notice", "act now", "last chance", "expires today".
- Never promise or imply a price, an offer amount, financing, or a closing date. Never claim a relationship or prior conversation the goal does not say happened.
- Plain conversational language, one ask per message, no links unless the goal requires one, no emojis unless the tone is friendly (then at most one in the whole sequence).
- Merge fields, single braces, exactly these and no others: ${MERGE_FIELDS.map((f) => `{${f}}`).join(' ')}. Greet with {first_name}; mention {address} or {city} when it makes a message specific. Never invent a field.
- Step types: sms, wait, task, status. Separate messages with waits of whole days (plus optional hours). Never two waits in a row; never end on a wait. The total span must fit within the requested number of days — front-load the follow-ups (closer together early, farther apart later).
- Optionally add one task step for the rep mid-sequence (e.g. "Call {first_name} about {address}") and one status step at the very end (e.g. set the lead to "nurture") when it serves the goal.
- exit_rules: stop_on_reply true unless the goal says otherwise; stop_on_call_answered true when the goal involves calling; stop_on_statuses lists lead statuses that make further texts pointless (lower_snake_case, e.g. ["dead", "under_contract", "do_not_contact"]).
- Write like a real person on the team, in the requested tone, never like a marketing department.`;

interface AnthropicMessageResponse {
  model: string;
  stop_reason: string | null;
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens: number; output_tokens: number };
}

/** `output_config.effort` exists on Sonnet 5, Sonnet 4.6, Opus 4.5+ and Fable; Haiku 4.5 and Sonnet 4.5 reject it. */
function supportsEffort(model: string): boolean {
  return !/haiku|sonnet-4-5/.test(model);
}

function brief(request: DraftRequest, context: DraftContext): string {
  const lines = [
    `Company (renders as {company}): ${context.companyName}`,
    `Rep who will send these (renders as {rep_name}): ${context.repName}`,
    `Goal: ${request.goal.trim()}`,
    request.audience?.trim() ? `Audience: ${request.audience.trim()}` : null,
    `Tone: ${request.tone}`,
    `Channel: SMS`,
    `Messages: exactly ${request.steps} SMS steps`,
    `Span: the whole sequence must complete within ${request.days} day${request.days === 1 ? '' : 's'} of enrollment`,
    '',
    'Return the sequence.',
  ];
  return lines.filter((l): l is string => l !== null).join('\n');
}

export async function draftSequenceWithAi(opts: DraftOptions): Promise<DraftResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [
    { role: 'user', content: brief(opts.request, opts.context) },
  ];
  const usage: DraftUsage = { input_tokens: 0, output_tokens: 0, attempts: 0 };
  let lastErrors: string[] = [];
  let model = opts.model;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const body = {
      model: opts.model,
      max_tokens: 8192,
      system: SYSTEM_PROMPT,
      messages,
      output_config: {
        // Drafting eight short texts is modest work; medium keeps the
        // adaptive-thinking spend small without going to the floor.
        ...(supportsEffort(opts.model) ? { effort: 'medium' } : {}),
        format: { type: 'json_schema', schema: AI_SEQUENCE_DRAFT_JSON_SCHEMA },
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
      throw new SequenceAiError('ai_upstream', `Anthropic ${res.status}: ${detail || res.statusText}`);
    }
    const msg = (await res.json()) as AnthropicMessageResponse;
    usage.attempts = attempt;
    usage.input_tokens += msg.usage?.input_tokens ?? 0;
    usage.output_tokens += msg.usage?.output_tokens ?? 0;
    model = msg.model ?? model;
    opts.logger?.info(
      { model, attempt, usage: msg.usage ?? null, stop_reason: msg.stop_reason },
      'ai sequence draft: model call',
    );

    if (msg.stop_reason === 'refusal') {
      throw new SequenceAiError('ai_refused', 'The model declined to draft this sequence.');
    }
    if (msg.stop_reason === 'max_tokens') {
      throw new SequenceAiError('ai_upstream', 'The draft was cut off (max_tokens).');
    }
    const text = msg.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new SequenceAiError('ai_upstream', 'The model returned no text block.');

    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      lastErrors = ['the response was not valid JSON'];
      raw = null;
    }
    const checked =
      raw === null
        ? ({ ok: false, errors: lastErrors } as const)
        : validateSequenceDraft(raw, {
            steps: opts.request.steps,
            days: opts.request.days,
            companyName: opts.context.companyName,
          });
    if (checked.ok) {
      return { draft: checked.draft, warnings: checked.warnings, model, usage };
    }
    lastErrors = checked.errors;
    opts.logger?.info({ model, attempt, errors: lastErrors }, 'ai sequence draft: validation failed');
    // One correction round: hand the failures back verbatim.
    messages.push({ role: 'assistant', content: text });
    messages.push({
      role: 'user',
      content:
        'That draft failed validation:\n' +
        lastErrors.map((e) => `- ${e}`).join('\n') +
        '\n\nReturn a corrected sequence that satisfies every rule.',
    });
  }

  throw new SequenceAiError(
    'ai_invalid_draft',
    'The model could not produce a sequence that passes the safety checks.',
    lastErrors,
  );
}
