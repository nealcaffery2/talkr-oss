/**
 * AI agent step (docs/sequences.md §11): at this point of a sequence the
 * model reads the lead's history and decides, within the capabilities the
 * step allows, what to do right now. Same Messages-API-over-fetch shape as
 * sequence-ai.ts, one correction round, and the plan comes back through the
 * pure validator in @talkr/core. The engine executes the plan through the
 * same primitives every other action uses; nothing here sends anything.
 */

import {
  AGENT_CAPABILITIES,
  AI_AGENT_PLAN_JSON_SCHEMA,
  AI_SMS_MAX_CHARS,
  MERGE_FIELDS,
  validateAgentPlan,
  type AgentCapability,
  type AgentPlan,
} from '@talkr/core';
import type { Logger } from '../logger.js';
import { ANTHROPIC_URL, ANTHROPIC_VERSION, SequenceAiError } from './sequence-ai.js';

export interface AgentStepOptions {
  apiKey: string;
  model: string;
  goal: string;
  allowed: readonly AgentCapability[];
  /** renderLeadHistory output. */
  history: string;
  /** The sequence's name and where this step sits ("step 3 of 7"). */
  position: string;
  context: { companyName: string; repName: string };
  logger?: Logger;
  fetchImpl?: typeof fetch;
}

export interface AgentStepResult {
  plan: AgentPlan;
  warnings: string[];
  model: string;
  usage: { input_tokens: number; output_tokens: number; attempts: number };
}

const CAPABILITY_DOC: Record<AgentCapability, string> = {
  send_sms: `send one text (sms_body, at most ${AI_SMS_MAX_CHARS} characters, merge fields ${MERGE_FIELDS.map((f) => `{${f}}`).join(' ')})`,
  create_task: 'create one task for the rep (task_title, task_due_in_days)',
  update_lead_status: 'set the lead status (lead_status, lower_snake_case)',
};

const SYSTEM_PROMPT = `You are an acquisitions assistant inside a real-estate company's follow-up plan. A lead is at a specific step of a plan; you read what has happened with them so far and decide what to do right now, within the capabilities this step allows. You know the TCPA and CTIA messaging rules cold.

Rules, checked by a validator before anything runs:
- Use only the capabilities listed as allowed. Set every other field to null.
- Doing nothing is a valid answer: if the lead has already replied, booked, said no, or a person is clearly handling it, send nothing and say why in the summary.
- A text must be short, human, specific to this lead's situation, one ask, no pressure, no fake urgency, no price or offer promises, no invented prior conversation. Never repeat a message already sent. Never text someone who asked to stop.
- A task must say what the rep should do and for whom. Create one only when a person needs to act.
- Change the lead status only when the history clearly supports it (e.g. they said they sold the house, or asked never to be contacted).
- Write like a real person on the team, never like a marketing department.`;

interface AnthropicMessageResponse {
  model: string;
  stop_reason: string | null;
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens: number; output_tokens: number };
}

function supportsEffort(model: string): boolean {
  return !/haiku|sonnet-4-5/.test(model);
}

function brief(opts: AgentStepOptions): string {
  const allowed = AGENT_CAPABILITIES.filter((c) => opts.allowed.includes(c));
  return [
    `Company (renders as {company}): ${opts.context.companyName}`,
    `Rep acting here (renders as {rep_name}): ${opts.context.repName}`,
    `Plan position: ${opts.position}`,
    `Goal of this step: ${opts.goal.trim()}`,
    `Allowed now: ${allowed.map((c) => CAPABILITY_DOC[c]).join('; ')}`,
    '',
    'History:',
    opts.history,
    '',
    'Decide what to do now and return the plan.',
  ].join('\n');
}

export async function planAgentStep(opts: AgentStepOptions): Promise<AgentStepResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const messages: Array<{ role: 'user' | 'assistant'; content: string }> = [{ role: 'user', content: brief(opts) }];
  const usage = { input_tokens: 0, output_tokens: 0, attempts: 0 };
  let lastErrors: string[] = [];
  let model = opts.model;

  for (let attempt = 1; attempt <= 2; attempt++) {
    const res = await doFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'x-api-key': opts.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: opts.model,
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages,
        output_config: {
          ...(supportsEffort(opts.model) ? { effort: 'medium' } : {}),
          format: { type: 'json_schema', schema: AI_AGENT_PLAN_JSON_SCHEMA },
        },
      }),
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
    opts.logger?.info({ model, attempt, usage: msg.usage ?? null, stop_reason: msg.stop_reason }, 'ai agent step: model call');

    if (msg.stop_reason === 'refusal') throw new SequenceAiError('ai_refused', 'The model declined to act on this lead.');
    if (msg.stop_reason === 'max_tokens') throw new SequenceAiError('ai_upstream', 'The plan was cut off (max_tokens).');
    const text = msg.content.find((b) => b.type === 'text')?.text;
    if (!text) throw new SequenceAiError('ai_upstream', 'The model returned no text block.');

    let raw: unknown = null;
    try {
      raw = JSON.parse(text);
    } catch {
      lastErrors = ['the response was not valid JSON'];
    }
    const checked = raw === null ? ({ ok: false, errors: lastErrors } as const) : validateAgentPlan(raw, opts.allowed);
    if (checked.ok) return { plan: checked.plan, warnings: checked.warnings, model, usage };
    lastErrors = checked.errors;
    opts.logger?.info({ model, attempt, errors: lastErrors }, 'ai agent step: validation failed');
    messages.push({ role: 'assistant', content: text });
    messages.push({
      role: 'user',
      content: 'That plan failed validation:\n' + lastErrors.map((e) => `- ${e}`).join('\n') + '\n\nReturn a corrected plan.',
    });
  }
  throw new SequenceAiError('ai_invalid_draft', 'The model could not produce a plan that passes the checks.', lastErrors);
}
