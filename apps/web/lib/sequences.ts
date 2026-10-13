/**
 * Client-side helpers for the sequence builder (docs/sequences.md). The web
 * app does not depend on @talkr/core, so the small pure bits the builder
 * needs for instant feedback — segment estimate, timeline days, wait math —
 * are mirrored here. The server re-validates everything on save.
 */

import type { AgentCapabilityDto, SequenceStepDto } from './api';

export const MERGE_FIELDS = ['first_name', 'name', 'address', 'city', 'state', 'rep_name', 'company'] as const;

/** Per-message cap the AI builder respects; humans get the send path's 1600. */
export const AI_SMS_MAX_CHARS = 320;
export const SMS_MAX_CHARS = 1600;

const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ' +
  'ÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿' +
  'abcdefghijklmnopqrstuvwxyzäöñüà';
const GSM7_EXT = '\f^{}\\[~]|€';

/** Carrier segment estimate — the counter under the SMS textarea. */
export function smsSegments(body: string): { chars: number; segments: number; encoding: 'gsm7' | 'ucs2' } {
  const glyphs = [...body];
  if (glyphs.length === 0) return { chars: 0, segments: 0, encoding: 'gsm7' };
  const gsm = glyphs.every((c) => GSM7_BASIC.includes(c) || GSM7_EXT.includes(c));
  const chars = gsm ? glyphs.reduce((n, c) => n + (GSM7_EXT.includes(c) ? 2 : 1), 0) : glyphs.length;
  const [single, multi] = gsm ? [160, 153] : [70, 67];
  return { chars, segments: chars <= single ? 1 : Math.ceil(chars / multi), encoding: gsm ? 'gsm7' : 'ucs2' };
}

export function waitMinutes(step: { days?: number; hours?: number; minutes?: number }): number {
  return (step.days ?? 0) * 1440 + (step.hours ?? 0) * 60 + (step.minutes ?? 0);
}

export interface TimelineRow {
  index: number;
  step: Exclude<SequenceStepDto, { type: 'wait' }>;
  offsetMinutes: number;
  day: number;
}

/** Non-wait steps with the day they fire on — "Day 0: SMS, Day 2: SMS". */
export function timeline(steps: SequenceStepDto[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let offset = 0;
  steps.forEach((step, index) => {
    if (step.type === 'wait') {
      offset += waitMinutes(step);
      return;
    }
    rows.push({ index, step, offsetMinutes: offset, day: Math.floor(offset / 1440) });
  });
  return rows;
}

export function durationMinutes(steps: SequenceStepDto[]): number {
  return steps.reduce((sum, s) => (s.type === 'wait' ? sum + waitMinutes(s) : sum), 0);
}

/** "2d 3h", "45m", "0m". */
export function formatMinutes(total: number): string {
  if (total <= 0) return '0m';
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  const parts: string[] = [];
  if (days) parts.push(`${days}d`);
  if (hours) parts.push(`${hours}h`);
  if (minutes && !days) parts.push(`${minutes}m`);
  return parts.join(' ') || '0m';
}

/** "in 2d 3h" / "3h ago" against a live clock. */
export function relativeTime(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return '—';
  const diff = new Date(iso).getTime() - now;
  const label = formatMinutes(Math.round(Math.abs(diff) / 60_000));
  return diff >= 0 ? `in ${label}` : `${label} ago`;
}

/** Unknown `{field}` names in a body, for the inline warning. */
export function unknownMergeFields(body: string): string[] {
  const out: string[] = [];
  for (const m of body.matchAll(/\{\{?\s*([a-zA-Z0-9_]+)\s*\}?\}/g)) {
    const name = m[1]!;
    if (!(MERGE_FIELDS as readonly string[]).includes(name) && !out.includes(name)) out.push(name);
  }
  return out;
}

/** One-line description of a step for lists and the timeline preview. */
export function describeStep(step: SequenceStepDto): string {
  switch (step.type) {
    case 'sms':
      return step.body?.trim() ? step.body.trim() : step.template_id ? 'Template message' : 'Empty message';
    case 'wait':
      return `Wait ${formatMinutes(waitMinutes(step))}`;
    case 'task':
      return `Task: ${step.title || '(untitled)'}`;
    case 'status':
      return `Set status → ${step.status || '(none)'}`;
    case 'agent':
      return `AI agent: ${step.goal.trim() || '(no goal yet)'}`;
  }
}

export const STEP_LABEL: Record<SequenceStepDto['type'], string> = {
  sms: 'SMS',
  wait: 'Wait',
  task: 'Task',
  status: 'Status',
  agent: 'AI agent',
};

/** What an agent step may be allowed to do, in the order the builder lists them. */
export const AGENT_CAPABILITIES: Array<{ key: AgentCapabilityDto; label: string; hint: string }> = [
  { key: 'send_sms', label: 'Send a text', hint: 'one message, written for this lead' },
  { key: 'create_task', label: 'Create a task', hint: 'for the lead’s rep, when a person needs to act' },
  { key: 'update_lead_status', label: 'Change the lead status', hint: 'only when the history clearly supports it' },
];

export const RUN_STATUS_COLOR: Record<string, string> = {
  pending: 'var(--muted-2)',
  running: 'var(--accent)',
  waiting: 'var(--amber)',
  succeeded: 'var(--green)',
  stopped: 'var(--muted)',
  failed: 'var(--red)',
  skipped: 'var(--muted-2)',
};

/** Where the "Draft with AI" modal parks a draft for the builder to pick up. */
export const DRAFT_STORAGE_KEY = 'talkr.sequenceDraft';

export const COMMON_STOP_STATUSES = ['dead', 'do_not_contact', 'under_contract', 'closed', 'not_interested'];
