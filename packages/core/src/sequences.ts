/**
 * Sequences (docs/sequences.md): the builder-facing step vocabulary, its
 * translation to and from workflow actions, the wait-step scheduling math,
 * inline SMS merge fields, and the validator every AI draft passes before a
 * human sees it. Zero I/O — the server persists, the worker executes.
 */

import { z } from 'zod';
import {
  AGENT_CAPABILITIES,
  exitRulesSchema,
  MAX_WAIT_MINUTES,
  type AgentCapability,
  type ExitRules,
  type WorkflowAction,
} from './workflows.js';

// ---------------------------------------------------------------------------
// Steps (what the builder edits)
// ---------------------------------------------------------------------------

export const MAX_SEQUENCE_STEPS = 20;
/** Per-message cap the AI builder must respect (two GSM-7 segments). */
export const AI_SMS_MAX_CHARS = 320;
/** Per-message cap for a human-written step (the send path's own limit). */
export const SMS_MAX_CHARS = 1600;

const smsStepSchema = z
  .object({
    type: z.literal('sms'),
    /** Inline body with merge fields; wins over template_id when both are set. */
    body: z.string().max(SMS_MAX_CHARS).optional(),
    /** A Phase 4 template to send verbatim (rendered by the send path). */
    template_id: z.string().uuid().optional(),
  })
  .strict();

const waitStepSchema = z
  .object({
    type: z.literal('wait'),
    days: z.number().int().min(0).max(90).optional(),
    hours: z.number().int().min(0).max(24 * 90).optional(),
    minutes: z.number().int().min(0).max(MAX_WAIT_MINUTES).optional(),
  })
  .strict();

const taskStepSchema = z
  .object({
    type: z.literal('task'),
    title: z.string().min(1).max(500),
    due_in_days: z.number().min(0).max(365),
  })
  .strict();

const statusStepSchema = z
  .object({
    type: z.literal('status'),
    status: z.string().min(1).max(100),
  })
  .strict();

/**
 * An AI agent step (docs/sequences.md §11): the model reads the lead's
 * history and decides, inside `allowed`, what to do right now. One text at
 * most per step; the engine executes, the model only plans.
 */
const agentStepSchema = z
  .object({
    type: z.literal('agent'),
    goal: z.string().min(10).max(1000),
    allowed: z.array(z.enum(AGENT_CAPABILITIES)).min(1).max(AGENT_CAPABILITIES.length),
  })
  .strict();

export const sequenceStepSchema = z.discriminatedUnion('type', [
  smsStepSchema,
  waitStepSchema,
  taskStepSchema,
  statusStepSchema,
  agentStepSchema,
]);

export type SequenceStep = z.infer<typeof sequenceStepSchema>;
export type SmsStep = Extract<SequenceStep, { type: 'sms' }>;
export type WaitStep = Extract<SequenceStep, { type: 'wait' }>;
export type AgentStep = Extract<SequenceStep, { type: 'agent' }>;

export const sequenceStepsSchema = z.array(sequenceStepSchema).min(1).max(MAX_SEQUENCE_STEPS);

// ---------------------------------------------------------------------------
// Merge fields (docs/sequences.md §4)
// ---------------------------------------------------------------------------

/** Single-brace fields an inline SMS body may carry; `{{name}}` is accepted too. */
export const MERGE_FIELDS = ['first_name', 'name', 'address', 'city', 'state', 'rep_name', 'company'] as const;
export type MergeField = (typeof MERGE_FIELDS)[number];

const MERGE_RE = /\{\{?\s*([a-zA-Z0-9_]+)\s*\}?\}/g;

function allowedList(): string {
  return MERGE_FIELDS.map((f) => `{${f}}`).join(' ');
}

export class MergeFieldError extends Error {
  constructor(public readonly field: string) {
    super(`unknown merge field {${field}} (allowed: ${allowedList()})`);
  }
}

/** Every distinct field name referenced by a body, in order of appearance. */
export function findMergeFields(body: string): string[] {
  const seen: string[] = [];
  for (const m of body.matchAll(MERGE_RE)) {
    const name = m[1]!;
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

export function unknownMergeFields(body: string): string[] {
  return findMergeFields(body).filter((f) => !(MERGE_FIELDS as readonly string[]).includes(f));
}

/**
 * Substitute merge fields. An unknown field throws — the same loud-failure
 * rule as renderTemplate — and a known field with no value renders as ''.
 */
export function renderMergeFields(
  body: string,
  vars: Partial<Record<MergeField, string | null | undefined>>,
): string {
  return body.replace(MERGE_RE, (_match, name: string) => {
    if (!(MERGE_FIELDS as readonly string[]).includes(name)) throw new MergeFieldError(name);
    return vars[name as MergeField] ?? '';
  });
}

// GSM-7 basic set + extension table; anything else forces UCS-2 (70/67 per segment).
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ' +
  'ÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿' +
  'abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '\f^{}\\[~]|€';

/** Carrier segment estimate for a body — the counter under the SMS textarea. */
export function smsSegments(body: string): { chars: number; segments: number; encoding: 'gsm7' | 'ucs2' } {
  const glyphs = [...body];
  if (glyphs.length === 0) return { chars: 0, segments: 0, encoding: 'gsm7' };
  const gsm = glyphs.every((c) => GSM7_BASIC.includes(c) || GSM7_EXT.includes(c));
  // Extension characters cost two septets on GSM-7.
  const chars = gsm ? glyphs.reduce((n, c) => n + (GSM7_EXT.includes(c) ? 2 : 1), 0) : glyphs.length;
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  return {
    chars,
    segments: chars <= single ? 1 : Math.ceil(chars / multi),
    encoding: gsm ? 'gsm7' : 'ucs2',
  };
}

// ---------------------------------------------------------------------------
// Wait math (docs/sequences.md §3) — pure, unit-tested
// ---------------------------------------------------------------------------

/** Total minutes a wait step pauses for (days + hours + minutes). */
export function waitMinutes(step: { days?: number; hours?: number; minutes?: number }): number {
  return (step.days ?? 0) * 1440 + (step.hours ?? 0) * 60 + (step.minutes ?? 0);
}

/** The inverse, for showing a stored wait as days / hours / minutes. */
export function splitWaitMinutes(total: number): { days: number; hours: number; minutes: number } {
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total - days * 1440) / 60);
  return { days, hours, minutes: total - days * 1440 - hours * 60 };
}

/** When a run parked at `now` on a wait of `minutes` is due to continue. */
export function resumeAtFor(now: Date, minutes: number): Date {
  return new Date(now.getTime() + minutes * 60_000);
}

export interface TimelineEntry {
  /** Position in the steps array. */
  index: number;
  step: Exclude<SequenceStep, WaitStep>;
  /** Minutes after enrollment this step fires (the waits before it, summed). */
  offset_minutes: number;
  /** Whole days after enrollment ("Day 0", "Day 2"). */
  day: number;
}

/** Non-wait steps with their offsets — the "Day 0: SMS, Day 2: SMS" preview. */
export function sequenceTimeline(steps: SequenceStep[]): TimelineEntry[] {
  const out: TimelineEntry[] = [];
  let offset = 0;
  steps.forEach((step, index) => {
    if (step.type === 'wait') {
      offset += waitMinutes(step);
      return;
    }
    out.push({ index, step, offset_minutes: offset, day: Math.floor(offset / 1440) });
  });
  return out;
}

/** Sum of every wait, in minutes — the sequence's span from first to last step. */
export function sequenceDurationMinutes(steps: SequenceStep[]): number {
  return steps.reduce((sum, s) => (s.type === 'wait' ? sum + waitMinutes(s) : sum), 0);
}

// ---------------------------------------------------------------------------
// Steps <-> workflow actions
// ---------------------------------------------------------------------------

/**
 * Cross-field rules the step schema cannot express. Returns a clear error or
 * null. Applied to human-built and AI-built step lists alike.
 */
export function validateSequenceSteps(steps: SequenceStep[]): string | null {
  if (!steps.some((s) => s.type !== 'wait')) return 'a sequence needs at least one step that does something';
  if (steps[steps.length - 1]!.type === 'wait') return 'a sequence cannot end with a wait';
  for (const [i, step] of steps.entries()) {
    const n = i + 1;
    if (step.type === 'sms') {
      const body = step.body?.trim() ?? '';
      if (!body && !step.template_id) return `step ${n}: SMS needs a body or a template`;
      const unknown = unknownMergeFields(body);
      if (unknown.length > 0) {
        return `step ${n}: unknown merge field ${unknown.map((f) => `{${f}}`).join(', ')} (allowed: ${allowedList()})`;
      }
    } else if (step.type === 'wait') {
      const minutes = waitMinutes(step);
      if (minutes < 1) return `step ${n}: a wait must be at least 1 minute`;
      if (minutes > MAX_WAIT_MINUTES) return `step ${n}: a wait may be at most 90 days`;
    } else if (step.type === 'agent') {
      if (!step.goal.trim()) return `step ${n}: the agent needs a goal`;
      if (new Set(step.allowed).size !== step.allowed.length) return `step ${n}: duplicate agent capability`;
    }
  }
  return null;
}

/** Builder steps → the engine's action list (docs/workflows.md §6). */
export function stepsToActions(steps: SequenceStep[]): WorkflowAction[] {
  return steps.map((step): WorkflowAction => {
    switch (step.type) {
      case 'sms': {
        const body = step.body?.trim();
        return body ? { type: 'send_sms', body } : { type: 'send_sms', template_id: step.template_id! };
      }
      case 'wait':
        return { type: 'wait', minutes: waitMinutes(step) };
      case 'task':
        return {
          type: 'create_task',
          title: step.title,
          assign_to: 'lead_owner',
          due_in_hours: step.due_in_days * 24,
        };
      case 'status':
        return { type: 'update_lead_status', status: step.status };
      case 'agent':
        return { type: 'ai_agent', goal: step.goal.trim(), allowed: [...new Set(step.allowed)] };
    }
  });
}

/**
 * Stored actions → builder steps. Only the four sequence action types map;
 * anything else (a row edited by hand) is dropped from the builder view.
 */
export function actionsToSteps(actions: unknown[]): SequenceStep[] {
  const steps: SequenceStep[] = [];
  for (const raw of actions) {
    const a = raw as { type?: string };
    switch (a.type) {
      case 'send_sms': {
        const s = raw as Extract<WorkflowAction, { type: 'send_sms' }>;
        steps.push({
          type: 'sms',
          ...(s.body != null ? { body: s.body } : {}),
          ...(s.template_id != null ? { template_id: s.template_id } : {}),
        });
        break;
      }
      case 'wait':
        steps.push({ type: 'wait', ...splitWaitMinutes((raw as { minutes: number }).minutes) });
        break;
      case 'create_task': {
        const t = raw as Extract<WorkflowAction, { type: 'create_task' }>;
        steps.push({ type: 'task', title: t.title, due_in_days: Math.round((t.due_in_hours / 24) * 100) / 100 });
        break;
      }
      case 'update_lead_status':
        steps.push({ type: 'status', status: (raw as { status: string }).status });
        break;
      case 'ai_agent': {
        const g = raw as Extract<WorkflowAction, { type: 'ai_agent' }>;
        steps.push({ type: 'agent', goal: g.goal, allowed: g.allowed });
        break;
      }
      default:
        break;
    }
  }
  return steps;
}

// ---------------------------------------------------------------------------
// AI agent step plan (docs/sequences.md §11)
// ---------------------------------------------------------------------------

/**
 * What the model answers for an agent step: a short reasoning line and at
 * most one of each capability. Flat and nullable, like the draft shape: one
 * object type is more reliable under structured outputs than a union.
 */
export const aiAgentPlanSchema = z.object({
  summary: z.string().max(600),
  sms_body: z.string().nullable(),
  task_title: z.string().nullable(),
  task_due_in_days: z.number().nullable(),
  lead_status: z.string().nullable(),
});

export type AiAgentPlanRaw = z.infer<typeof aiAgentPlanSchema>;

export const AI_AGENT_PLAN_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: 'One or two sentences: what you decided and why, for the run history.' },
    sms_body: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'The text to send now, at most 320 characters, or null to send nothing.',
    },
    task_title: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'A task for the rep (what to do, for whom), or null.',
    },
    task_due_in_days: {
      anyOf: [{ type: 'number' }, { type: 'null' }],
      description: 'Days until the task is due (0 = today). Null when there is no task.',
    },
    lead_status: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'The lead status to set (lower_snake_case), or null to leave it.',
    },
  },
  required: ['summary', 'sms_body', 'task_title', 'task_due_in_days', 'lead_status'],
  additionalProperties: false,
} as const;

export interface AgentPlan {
  summary: string;
  sms?: { body: string };
  task?: { title: string; due_in_days: number };
  status?: string;
}

export type AgentPlanValidation = { ok: true; plan: AgentPlan; warnings: string[] } | { ok: false; errors: string[] };

/**
 * Check a raw agent plan against the step's allowed capabilities and the
 * same message rules the draft validator enforces. A capability the step
 * did not allow is an error (the model was told), never silently dropped:
 * the correction round tells the model what to fix.
 */
export function validateAgentPlan(raw: unknown, allowed: readonly AgentCapability[]): AgentPlanValidation {
  const parsed = aiAgentPlanSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'plan'}: ${i.message}`) };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const p = parsed.data;
  const plan: AgentPlan = { summary: p.summary.trim().slice(0, 600) };
  const may = new Set(allowed);

  const sms = (p.sms_body ?? '').trim();
  if (sms) {
    if (!may.has('send_sms')) errors.push('sms_body: this step may not send a text');
    else {
      const len = [...sms].length;
      if (len > AI_SMS_MAX_CHARS) errors.push(`sms_body is ${len} characters; the limit is ${AI_SMS_MAX_CHARS}`);
      const unknown = unknownMergeFields(sms);
      if (unknown.length > 0) {
        errors.push(`sms_body uses unknown merge field ${unknown.map((f) => `{${f}}`).join(', ')}; allowed: ${allowedList()}`);
      }
      const pressure = sms.match(URGENCY_RE);
      if (pressure) warnings.push(`sms_body uses pressure language ("${pressure[0]}")`);
      if (errors.length === 0) plan.sms = { body: sms };
    }
  }
  const title = (p.task_title ?? '').trim();
  if (title) {
    if (!may.has('create_task')) errors.push('task_title: this step may not create a task');
    else {
      const due = p.task_due_in_days == null ? 1 : Math.max(0, Math.min(365, p.task_due_in_days));
      plan.task = { title: title.slice(0, 500), due_in_days: due };
    }
  }
  const status = (p.lead_status ?? '').trim();
  if (status) {
    if (!may.has('update_lead_status')) errors.push('lead_status: this step may not change the lead status');
    else plan.status = status.slice(0, 100);
  }
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, plan, warnings };
}

// ---------------------------------------------------------------------------
// Completion routing choice (docs/sequences.md §12)
// ---------------------------------------------------------------------------

export const aiRoutingChoiceSchema = z.object({
  sequence_id: z.string().nullable(),
  reason: z.string().max(600),
});

export const AI_ROUTING_CHOICE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    sequence_id: {
      anyOf: [{ type: 'string' }, { type: 'null' }],
      description: 'The id of the candidate sequence to enroll the lead in next, or null to leave the lead out of every plan.',
    },
    reason: { type: 'string', description: 'One or two sentences for the run history: why this plan, or why none.' },
  },
  required: ['sequence_id', 'reason'],
  additionalProperties: false,
} as const;

export type RoutingChoice = { sequence_id: string | null; reason: string };

/** A choice must name a candidate or null; anything else is a model error the caller can retry. */
export function validateRoutingChoice(raw: unknown, candidateIds: readonly string[]): { ok: true; choice: RoutingChoice } | { ok: false; errors: string[] } {
  const parsed = aiRoutingChoiceSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'choice'}: ${i.message}`) };
  }
  const id = parsed.data.sequence_id?.trim() || null;
  if (id && !candidateIds.includes(id)) {
    return { ok: false, errors: [`sequence_id ${id} is not one of the candidates`] };
  }
  return { ok: true, choice: { sequence_id: id, reason: parsed.data.reason.trim().slice(0, 600) } };
}

// ---------------------------------------------------------------------------
// AI builder draft (docs/sequences.md §7)
// ---------------------------------------------------------------------------

/**
 * The flat shape the model is asked for: one object type with nullable
 * per-kind fields. A single object schema is more reliable under structured
 * outputs than a discriminated union, and the validator below turns it into
 * typed steps.
 */
export const aiDraftStepSchema = z.object({
  type: z.enum(['sms', 'wait', 'task', 'status']),
  body: z.string().nullable(),
  days: z.number().nullable(),
  hours: z.number().nullable(),
  title: z.string().nullable(),
  due_in_days: z.number().nullable(),
  status: z.string().nullable(),
});

export const aiSequenceDraftSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000),
  steps: z.array(aiDraftStepSchema).min(1).max(40),
  exit_rules: exitRulesSchema,
});

export type AiSequenceDraftRaw = z.infer<typeof aiSequenceDraftSchema>;

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;
const nullableNumber = { anyOf: [{ type: 'number' }, { type: 'null' }] } as const;

/** Handed to structured outputs (`output_config.format`); must mirror aiSequenceDraftSchema. */
export const AI_SEQUENCE_DRAFT_JSON_SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short internal name for the sequence, e.g. "Post-call follow-up".' },
    description: { type: 'string', description: 'One or two sentences on who this is for and what it does.' },
    steps: {
      type: 'array',
      description:
        'Ordered steps. Waits separate the messages; never put two waits in a row; never end on a wait.',
      items: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['sms', 'wait', 'task', 'status'] },
          body: { ...nullableString, description: 'sms only: the message text, at most 320 characters. Null otherwise.' },
          days: { ...nullableNumber, description: 'wait only: whole days to wait. Null otherwise.' },
          hours: { ...nullableNumber, description: 'wait only: extra hours to wait (0-23). Null otherwise.' },
          title: { ...nullableString, description: 'task only: what the rep should do. Null otherwise.' },
          due_in_days: { ...nullableNumber, description: 'task only: days until the task is due. Null otherwise.' },
          status: { ...nullableString, description: 'status only: the lead status to set. Null otherwise.' },
        },
        required: ['type', 'body', 'days', 'hours', 'title', 'due_in_days', 'status'],
        additionalProperties: false,
      },
    },
    exit_rules: {
      type: 'object',
      properties: {
        stop_on_reply: { type: 'boolean', description: 'Stop texting once the lead replies (almost always true).' },
        stop_on_statuses: {
          type: 'array',
          items: { type: 'string' },
          description: 'Lead statuses that end the sequence, e.g. ["dead", "under_contract"]. Empty if none.',
        },
        stop_on_call_answered: { type: 'boolean', description: 'Stop once a call with the lead is answered.' },
      },
      required: ['stop_on_reply', 'stop_on_statuses', 'stop_on_call_answered'],
      additionalProperties: false,
    },
  },
  required: ['name', 'description', 'steps', 'exit_rules'],
  additionalProperties: false,
} as const;

export interface SequenceDraft {
  name: string;
  description: string;
  steps: SequenceStep[];
  exit_rules: ExitRules;
}

export interface DraftConstraints {
  /** How many SMS the caller asked for (2-8). */
  steps: number;
  /** The span the whole sequence must fit in, in days. */
  days: number;
  /** When known, a literal company name in the first SMS also counts as identifying the sender. */
  companyName?: string | null;
}

export type DraftValidation =
  | { ok: true; draft: SequenceDraft; warnings: string[] }
  | { ok: false; errors: string[] };

const OPT_OUT_RE = /\bstop\b/i;
const SENDER_RE = /\{\{?\s*(rep_name|company)\s*\}?\}/;
const URGENCY_RE =
  /\b(act now|last chance|final (notice|warning)|expires? (today|tonight|in \d+ hours?)|limited[- ]time|urgent(ly)?|immediately)\b/i;

/**
 * Turn a raw model draft into typed steps and check the rules the prompt
 * asked for: 2..N SMS of at most 320 characters, the first one identifying
 * the sender and carrying opt-out language, only known merge fields, and a
 * total span inside the requested window. Consecutive waits are merged and a
 * trailing wait dropped (reported as warnings, not errors). Pure.
 */
export function validateSequenceDraft(raw: unknown, constraints: DraftConstraints): DraftValidation {
  const parsed = aiSequenceDraftSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'draft'}: ${i.message}`),
    };
  }
  const errors: string[] = [];
  const warnings: string[] = [];
  const steps: SequenceStep[] = [];

  for (const [i, s] of parsed.data.steps.entries()) {
    const n = i + 1;
    switch (s.type) {
      case 'sms': {
        const body = (s.body ?? '').trim();
        if (!body) {
          errors.push(`step ${n}: sms has no body`);
          break;
        }
        steps.push({ type: 'sms', body });
        break;
      }
      case 'wait': {
        const days = Math.max(0, Math.round(s.days ?? 0));
        const hours = Math.max(0, Math.round(s.hours ?? 0));
        const minutes = days * 1440 + hours * 60;
        if (minutes < 60) {
          errors.push(`step ${n}: wait must be at least 1 hour`);
          break;
        }
        const prev = steps[steps.length - 1];
        if (prev?.type === 'wait') {
          // Two waits in a row are one wait: merge instead of rejecting.
          const merged = splitWaitMinutes(waitMinutes(prev) + minutes);
          steps[steps.length - 1] = { type: 'wait', ...merged };
          warnings.push(`steps ${n - 1}-${n}: consecutive waits merged`);
          break;
        }
        steps.push({ type: 'wait', days, hours });
        break;
      }
      case 'task': {
        const title = (s.title ?? '').trim();
        if (!title) {
          errors.push(`step ${n}: task has no title`);
          break;
        }
        const due = s.due_in_days == null ? 1 : Math.max(0, Math.min(365, s.due_in_days));
        steps.push({ type: 'task', title: title.slice(0, 500), due_in_days: due });
        break;
      }
      case 'status': {
        const status = (s.status ?? '').trim();
        if (!status) {
          errors.push(`step ${n}: status step has no status`);
          break;
        }
        steps.push({ type: 'status', status: status.slice(0, 100) });
        break;
      }
    }
  }

  if (steps.length > 0 && steps[steps.length - 1]!.type === 'wait') {
    steps.pop();
    warnings.push('trailing wait dropped');
  }

  const smsSteps = steps.filter((s): s is SmsStep => s.type === 'sms');
  if (smsSteps.length < 2) errors.push(`draft has ${smsSteps.length} SMS; at least 2 are required`);
  if (smsSteps.length > constraints.steps) {
    errors.push(`draft has ${smsSteps.length} SMS; at most ${constraints.steps} were requested`);
  }
  smsSteps.forEach((s, k) => {
    const body = s.body ?? '';
    const len = [...body].length;
    if (len > AI_SMS_MAX_CHARS) errors.push(`SMS ${k + 1} is ${len} characters; the limit is ${AI_SMS_MAX_CHARS}`);
    const unknown = unknownMergeFields(body);
    if (unknown.length > 0) {
      errors.push(
        `SMS ${k + 1} uses unknown merge field ${unknown.map((f) => `{${f}}`).join(', ')}; allowed: ${allowedList()}`,
      );
    }
    const pressure = body.match(URGENCY_RE);
    if (pressure) warnings.push(`SMS ${k + 1} uses pressure language ("${pressure[0]}")`);
  });
  const first = smsSteps[0]?.body ?? '';
  if (first && !OPT_OUT_RE.test(first)) {
    errors.push('the first SMS must tell the recipient how to opt out (e.g. "Reply STOP to opt out")');
  }
  const company = constraints.companyName?.trim();
  const identifies =
    SENDER_RE.test(first) || (company ? first.toLowerCase().includes(company.toLowerCase()) : false);
  if (first && !identifies) errors.push('the first SMS must identify the sender ({rep_name} and/or {company})');

  if (steps.length > MAX_SEQUENCE_STEPS) errors.push(`draft has ${steps.length} steps; the limit is ${MAX_SEQUENCE_STEPS}`);
  const spanDays = sequenceDurationMinutes(steps) / 1440;
  if (spanDays > constraints.days) {
    errors.push(`draft spans ${Math.ceil(spanDays)} days; it must fit in ${constraints.days}`);
  }
  if (errors.length === 0) {
    const cross = validateSequenceSteps(steps);
    if (cross) errors.push(cross);
  }
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    warnings,
    draft: {
      name: parsed.data.name.trim(),
      description: parsed.data.description.trim(),
      steps,
      exit_rules: parsed.data.exit_rules,
    },
  };
}
