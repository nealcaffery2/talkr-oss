/**
 * Per-number call flows (phone_numbers.ivr, version 2): business hours, ring
 * strategies, IVR menus, forwards, voicemail and hang-up, wired as a graph of
 * nodes. Pure — the TwiML/TeXML route feeds it facts and renders the
 * instruction it returns, and the simulator walks the same code, so "what the
 * test call showed" and "what the carrier did" cannot drift.
 *
 * A number whose `ivr` is null, or the older `{greeting, options}` menu, keeps
 * the routing chain in routing.ts. Only `{version: 2}` runs through here.
 */

import { z } from 'zod';
import {
  LAST_CONTACT_DEFAULT_DAYS,
  LAST_CONTACT_MAX_DAYS,
  isWithinBusinessHours,
  lastContactDto,
  pickLastContact,
  type LastContactDto,
  type LastTouch,
} from './routing.js';

export const CALL_FLOW_VERSION = 2;
/** Carriers cap parallel legs on one <Dial>; Twilio's is 10. */
export const FLOW_RING_ALL_CAP = 10;
/** number_flow hops before a call is sent to voicemail instead. */
export const FLOW_MAX_HOPS = 3;

const nodeId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/, 'node ids are 1-40 letters, digits, _ or -');
const next = nodeId.nullable();
const hhmm = z.string().regex(/^([01]\d|2[0-4]):[0-5]\d$/, 'times are HH:MM');
const e164 = z.string().regex(/^\+[1-9]\d{7,14}$/, 'phone numbers are E.164 (+12105550100)');

export const greetingSchema = z.union([
  z.object({ tts: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ audio_url: z.string().url().max(500) }).strict(),
]);
export type FlowGreeting = z.infer<typeof greetingSchema>;

const targetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('user'), user_id: z.string().uuid() }),
  z.object({ kind: z.literal('team'), team_id: z.string().uuid() }),
  /** Every active member of the org. */
  z.object({ kind: z.literal('everyone') }),
  /** The rep who owns the caller's lead, when the caller is known. */
  z.object({ kind: z.literal('lead_owner') }),
  /**
   * The rep who most recently reached out to the caller (call, text, or a
   * partner-posted RVM/email) within `within_days` (default 14). Resolves to
   * nobody — and the step moves on — exactly like an unknown lead_owner.
   */
  z.object({ kind: z.literal('last_contact'), within_days: z.number().int().min(1).max(LAST_CONTACT_MAX_DAYS).optional() }),
]);
export type FlowTarget = z.infer<typeof targetSchema>;

const label = z.string().max(60).optional();
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;

const nodeSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hours'),
    label,
    timezone: z.string().min(1).max(64),
    /** Day → [start, end) ranges. An absent or empty day is closed. */
    schedule: z.record(z.enum(DAYS), z.array(z.tuple([hhmm, hhmm])).max(6)),
    /** Closed all day, in the node's timezone. */
    holidays: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).max(60).default([]),
    open: next,
    closed: next,
  }),
  z.object({
    type: z.literal('ring'),
    label,
    strategy: z.enum(['all', 'sequential', 'round_robin']),
    targets: z.array(targetSchema).min(1).max(20),
    /** Per person for sequential/round_robin; for the whole group on `all`. */
    timeout_seconds: z.number().int().min(5).max(120).default(20),
    no_answer: next,
    /** Absent = busy is treated as no answer. */
    busy: next.optional(),
  }),
  z.object({
    type: z.literal('menu'),
    label,
    greeting: greetingSchema,
    options: z.record(z.string().regex(/^[0-9*#]$/), next).refine((o) => Object.keys(o).length > 0, 'a menu needs at least one option'),
    timeout_seconds: z.number().int().min(3).max(30).default(6),
    /** Extra times the menu is replayed after no input or an invalid key. */
    repeat: z.number().int().min(0).max(3).default(1),
    no_input: next,
  }),
  z.object({
    type: z.literal('forward'),
    label,
    to: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('e164'), e164 }),
      z.object({ kind: z.literal('personal'), user_id: z.string().uuid() }),
    ]),
    timeout_seconds: z.number().int().min(5).max(120).default(25),
    no_answer: next,
  }),
  z.object({ type: z.literal('number_flow'), label, phone_number_id: z.string().uuid() }),
  z.object({
    type: z.literal('voicemail'),
    label,
    greeting: greetingSchema.nullable().optional(),
    /** Whose voicemail: their personal greeting when the node has none. */
    user_id: z.string().uuid().nullable().optional(),
  }),
  z.object({ type: z.literal('hangup'), label, message: z.string().max(500).nullable().optional() }),
]);
export type FlowNode = z.infer<typeof nodeSchema>;

export const callFlowSchema = z.object({
  version: z.literal(CALL_FLOW_VERSION),
  start: nodeId,
  nodes: z.record(nodeId, nodeSchema).refine((n) => Object.keys(n).length <= 50, 'at most 50 steps'),
  recording: z.boolean().default(true),
  /** Said to the caller before anything else ("calls are recorded"). */
  announce: z.string().max(500).nullable().optional(),
  /** Said to the rep who answers, before the caller is connected. */
  whisper: z.string().max(300).nullable().optional(),
  /** The number's voicemail greeting when a voicemail step has none. */
  voicemail_greeting: greetingSchema.nullable().optional(),
  missed_call_text: z
    .object({
      enabled: z.boolean(),
      /** Merge fields ({first_name}, …) render exactly as on any other send. */
      body: z.string().trim().min(1).max(480),
      cooldown_hours: z.number().int().min(0).max(720).default(24),
    })
    .nullable()
    .optional(),
});
export type CallFlow = z.infer<typeof callFlowSchema>;

export function isCallFlow(ivr: unknown): ivr is CallFlow {
  return Boolean(ivr && typeof ivr === 'object' && (ivr as { version?: unknown }).version === CALL_FLOW_VERSION);
}

/** Every node id a node points at, with the edge name the UI shows. */
export function flowEdges(node: FlowNode): Array<[edge: string, target: string | null]> {
  switch (node.type) {
    case 'hours':
      return [['open', node.open], ['closed', node.closed]];
    case 'ring':
      return [['no_answer', node.no_answer], ...(node.busy !== undefined ? [['busy', node.busy] as [string, string | null]] : [])];
    case 'menu':
      return [...Object.entries(node.options).map(([d, t]) => [`press ${d}`, t] as [string, string | null]), ['no_input', node.no_input]];
    case 'forward':
      return [['no_answer', node.no_answer]];
    default:
      return [];
  }
}

export type FlowValidation = { ok: true; flow: CallFlow } | { ok: false; errors: string[] };

/**
 * Shape (zod), then graph: every pointer lands on a node, no cycles (a loop is
 * a caller who never leaves), nothing unreachable from `start`.
 */
export function validateCallFlow(input: unknown): FlowValidation {
  const parsed = callFlowSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, errors: parsed.error.issues.map((i) => `${i.path.join('.') || 'flow'}: ${i.message}`) };
  }
  const flow = parsed.data;
  const errors: string[] = [];
  if (!flow.nodes[flow.start]) errors.push(`start: no step "${flow.start}"`);
  for (const [id, node] of Object.entries(flow.nodes)) {
    for (const [edge, target] of flowEdges(node)) {
      if (target !== null && !flow.nodes[target]) errors.push(`nodes.${id}.${edge}: no step "${target}"`);
    }
  }
  if (errors.length > 0) return { ok: false, errors };

  const state = new Map<string, 'visiting' | 'done'>();
  const walk = (id: string, trail: string[]): void => {
    const s = state.get(id);
    if (s === 'done') return;
    if (s === 'visiting') {
      errors.push(`loop: ${[...trail.slice(trail.indexOf(id)), id].join(' → ')}`);
      return;
    }
    state.set(id, 'visiting');
    for (const [, target] of flowEdges(flow.nodes[id]!)) if (target) walk(target, [...trail, id]);
    state.set(id, 'done');
  };
  walk(flow.start, []);
  for (const id of Object.keys(flow.nodes)) {
    if (!state.has(id)) errors.push(`nodes.${id}: unreachable from start`);
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, flow };
}

/** Users, teams and numbers a flow names — the server checks they are the org's. */
export function flowReferences(flow: CallFlow): { userIds: string[]; teamIds: string[]; phoneNumberIds: string[] } {
  const users = new Set<string>();
  const teams = new Set<string>();
  const numbers = new Set<string>();
  for (const node of Object.values(flow.nodes)) {
    if (node.type === 'ring') {
      for (const t of node.targets) {
        if (t.kind === 'user') users.add(t.user_id);
        if (t.kind === 'team') teams.add(t.team_id);
      }
    } else if (node.type === 'forward' && node.to.kind === 'personal') users.add(node.to.user_id);
    else if (node.type === 'voicemail' && node.user_id) users.add(node.user_id);
    else if (node.type === 'number_flow') numbers.add(node.phone_number_id);
  }
  return { userIds: [...users], teamIds: [...teams], phoneNumberIds: [...numbers] };
}

// ---------------------------------------------------------------------------
// Executor
// ---------------------------------------------------------------------------

export interface FlowFacts {
  now: Date;
  /** Active org members. */
  everyone: string[];
  teams: Record<string, string[]>;
  leadOwnerUserId: string | null;
  /**
   * Outbound touches to the caller's number by active members (up to
   * LAST_CONTACT_MAX_DAYS old). Absent or empty: last_contact resolves to nobody.
   */
  lastTouches?: readonly LastTouch[];
  isAvailable(userId: string): boolean;
  /** Epoch ms of the last ring; -1 for never. Round-robin rings the oldest first. */
  lastRungAt(userId: string): number;
  personalPhone(userId: string): string | null;
  /** Users this call already rang on each ring step (sequential/round-robin). */
  tried: Record<string, string[]>;
}

export type FlowInstruction =
  | {
      kind: 'ring';
      node: string;
      userIds: string[];
      timeoutSeconds: number;
      /** A last_contact target put someone in this ring: the touch it matched. */
      lastContact?: LastContactDto;
    }
  | { kind: 'forward'; node: string; to: string; timeoutSeconds: number }
  | { kind: 'gather'; node: string; attempt: number; greeting: FlowGreeting; timeoutSeconds: number }
  | { kind: 'voicemail'; node: string | null; greeting: FlowGreeting | null; userId: string | null }
  | { kind: 'hangup'; node: string; message: string | null }
  | { kind: 'number_flow'; node: string; phoneNumberId: string }
  | { kind: 'done' };

export interface FlowPathEntry {
  node: string | null;
  type: string;
  detail: string;
}

export type FlowEvent =
  | { kind: 'dial'; status: string }
  | { kind: 'digits'; digits: string | null; attempt: number };

const ANSWERED = new Set(['answered', 'completed', 'in-progress']);

function isOpen(node: Extract<FlowNode, { type: 'hours' }>, now: Date): boolean {
  const localDate = new Intl.DateTimeFormat('en-CA', { timeZone: node.timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
  if (node.holidays.includes(localDate)) return false;
  return isWithinBusinessHours({ timezone: node.timezone, businessHours: node.schedule }, now);
}

/** True when any ring step names a last_contact target (the server loads touches only then). */
export function flowUsesLastContact(flow: CallFlow): boolean {
  return Object.values(flow.nodes).some((n) => n.type === 'ring' && n.targets.some((t) => t.kind === 'last_contact'));
}

function resolveTargets(targets: FlowTarget[], facts: FlowFacts): { userIds: string[]; touches: Map<string, LastTouch> } {
  const out: string[] = [];
  const touches = new Map<string, LastTouch>();
  for (const t of targets) {
    if (t.kind === 'user') out.push(t.user_id);
    else if (t.kind === 'team') out.push(...(facts.teams[t.team_id] ?? []));
    else if (t.kind === 'everyone') out.push(...facts.everyone);
    else if (t.kind === 'last_contact') {
      // Same availability rule as every other target: the most recent toucher
      // who is in. One person — not a list of everyone who ever called them.
      const touch = pickLastContact(facts.lastTouches ?? [], {
        now: facts.now,
        withinDays: t.within_days ?? LAST_CONTACT_DEFAULT_DAYS,
        isEligible: (id) => facts.isAvailable(id),
      });
      if (touch) {
        out.push(touch.userId);
        if (!touches.has(touch.userId)) touches.set(touch.userId, touch);
      }
    } else if (facts.leadOwnerUserId) out.push(facts.leadOwnerUserId);
  }
  return { userIds: [...new Set(out)], touches };
}

function touchLabel(t: LastTouch): string {
  const what = t.channel === 'call' ? 'call' : t.channel === 'sms' ? 'text' : t.channel === 'rvm' ? 'voicemail drop' : t.channel === 'email' ? 'email' : 'outreach';
  return `last reached out by ${what} on ${t.at.toISOString().slice(0, 10)}`;
}

/**
 * Walk from `id` until the flow needs the carrier (a ring, a menu, a forward)
 * or ends. `null` — a branch nobody configured — is voicemail, never a drop.
 */
export function enterFlowNode(flow: CallFlow, id: string | null, facts: FlowFacts, path: FlowPathEntry[] = []): FlowInstruction {
  for (let guard = 0; guard < 60; guard++) {
    if (id === null) {
      path.push({ node: null, type: 'voicemail', detail: 'Nothing configured here — voicemail' });
      return { kind: 'voicemail', node: null, greeting: null, userId: null };
    }
    const node = flow.nodes[id];
    if (!node) {
      path.push({ node: id, type: 'voicemail', detail: `Missing step "${id}" — voicemail` });
      return { kind: 'voicemail', node: null, greeting: null, userId: null };
    }
    switch (node.type) {
      case 'hours': {
        const open = isOpen(node, facts.now);
        path.push({ node: id, type: 'hours', detail: open ? 'Open' : 'Closed' });
        id = open ? node.open : node.closed;
        continue;
      }
      case 'ring': {
        const ring = ringStep(node, id, facts, path);
        if (ring) return ring;
        id = node.no_answer;
        continue;
      }
      case 'menu':
        path.push({ node: id, type: 'menu', detail: 'Plays the menu' });
        return { kind: 'gather', node: id, attempt: 0, greeting: node.greeting, timeoutSeconds: node.timeout_seconds };
      case 'forward': {
        const to = node.to.kind === 'e164' ? node.to.e164 : facts.personalPhone(node.to.user_id);
        if (!to) {
          path.push({ node: id, type: 'forward', detail: 'No personal phone on file — skipped' });
          id = node.no_answer;
          continue;
        }
        path.push({ node: id, type: 'forward', detail: `Forwards to ${to}` });
        return { kind: 'forward', node: id, to, timeoutSeconds: node.timeout_seconds };
      }
      case 'number_flow':
        path.push({ node: id, type: 'number_flow', detail: 'Hands the call to another number' });
        return { kind: 'number_flow', node: id, phoneNumberId: node.phone_number_id };
      case 'voicemail':
        path.push({ node: id, type: 'voicemail', detail: 'Voicemail' });
        return { kind: 'voicemail', node: id, greeting: node.greeting ?? null, userId: node.user_id ?? null };
      case 'hangup':
        path.push({ node: id, type: 'hangup', detail: 'Hangs up' });
        return { kind: 'hangup', node: id, message: node.message ?? null };
    }
  }
  path.push({ node: id, type: 'voicemail', detail: 'Too many steps — voicemail' });
  return { kind: 'voicemail', node: null, greeting: null, userId: null };
}

function ringStep(node: Extract<FlowNode, { type: 'ring' }>, id: string, facts: FlowFacts, path: FlowPathEntry[]): FlowInstruction | null {
  const resolved = resolveTargets(node.targets, facts);
  const available = resolved.userIds.filter((u) => facts.isAvailable(u));
  /** The touch behind a rung user, when a last_contact target put them there. */
  const via = (userIds: string[]): { lastContact?: LastContactDto; note: string } => {
    const touch = userIds.map((u) => resolved.touches.get(u)).find(Boolean);
    return touch ? { lastContact: lastContactDto(touch), note: ` — ${touchLabel(touch)}` } : { note: '' };
  };
  if (node.strategy === 'all') {
    if (available.length === 0) {
      path.push({ node: id, type: 'ring', detail: 'Nobody available to ring' });
      return null;
    }
    const userIds = available.slice(0, FLOW_RING_ALL_CAP);
    const v = via(userIds);
    path.push({ node: id, type: 'ring', detail: `Rings ${userIds.length} at once${v.note}` });
    return { kind: 'ring', node: id, userIds, timeoutSeconds: node.timeout_seconds, ...(v.lastContact ? { lastContact: v.lastContact } : {}) };
  }
  const tried = new Set(facts.tried[id] ?? []);
  const queue = available.filter((u) => !tried.has(u));
  // Stable sort: sequential keeps the configured order; round-robin starts
  // with whoever was rung longest ago.
  if (node.strategy === 'round_robin') queue.sort((a, b) => facts.lastRungAt(a) - facts.lastRungAt(b));
  const nextUser = queue[0];
  if (!nextUser) {
    path.push({ node: id, type: 'ring', detail: tried.size > 0 ? 'Nobody else to try' : 'Nobody available to ring' });
    return null;
  }
  const v = via([nextUser]);
  path.push({ node: id, type: 'ring', detail: `Rings one person (${node.strategy === 'round_robin' ? 'round-robin' : 'in order'})${v.note}` });
  return { kind: 'ring', node: id, userIds: [nextUser], timeoutSeconds: node.timeout_seconds, ...(v.lastContact ? { lastContact: v.lastContact } : {}) };
}

/** The carrier came back to a node: a dial finished or a key was pressed. */
export function resumeFlow(flow: CallFlow, id: string, event: FlowEvent, facts: FlowFacts, path: FlowPathEntry[] = []): FlowInstruction {
  const node = flow.nodes[id];
  if (!node) return enterFlowNode(flow, null, facts, path);
  if (event.kind === 'dial') {
    if (ANSWERED.has(event.status)) return { kind: 'done' };
    if (node.type === 'ring') {
      if (event.status === 'busy' && node.busy !== undefined) {
        path.push({ node: id, type: 'ring', detail: 'Busy' });
        return enterFlowNode(flow, node.busy, facts, path);
      }
      path.push({ node: id, type: 'ring', detail: 'No answer' });
      if (node.strategy !== 'all') {
        const again = ringStep(node, id, facts, path);
        if (again) return again;
      }
      return enterFlowNode(flow, node.no_answer, facts, path);
    }
    if (node.type === 'forward') {
      path.push({ node: id, type: 'forward', detail: 'No answer' });
      return enterFlowNode(flow, node.no_answer, facts, path);
    }
    return enterFlowNode(flow, null, facts, path);
  }
  if (node.type !== 'menu') return enterFlowNode(flow, null, facts, path);
  const digits = event.digits?.slice(0, 1) ?? null;
  if (digits && Object.prototype.hasOwnProperty.call(node.options, digits)) {
    path.push({ node: id, type: 'menu', detail: `Caller pressed ${digits}` });
    return enterFlowNode(flow, node.options[digits]!, facts, path);
  }
  path.push({ node: id, type: 'menu', detail: digits ? `Invalid key ${digits}` : 'No input' });
  if (event.attempt < node.repeat) {
    return { kind: 'gather', node: id, attempt: event.attempt + 1, greeting: node.greeting, timeoutSeconds: node.timeout_seconds };
  }
  return enterFlowNode(flow, node.no_input, facts, path);
}

// ---------------------------------------------------------------------------
// Simulator
// ---------------------------------------------------------------------------

export interface FlowSimulationScript {
  /** Keys the caller presses, one per menu, in order. Runs out = no input. */
  digits: string[];
  /** Who picks up: a user id, 'forward' (any forward is answered), or null. */
  answeredBy: string | null;
  /** Other numbers' flows, for number_flow steps. Null = that number has none. */
  flows: Record<string, CallFlow | null>;
}

export interface FlowSimulation {
  outcome: 'answered' | 'forwarded' | 'voicemail' | 'hangup' | 'default_routing';
  path: FlowPathEntry[];
  missedCallText: string | null;
}

export function simulateCallFlow(flow: CallFlow, facts: FlowFacts, script: FlowSimulationScript): FlowSimulation {
  const path: FlowPathEntry[] = [];
  const tried: Record<string, string[]> = {};
  const simFacts: FlowFacts = { ...facts, tried };
  const digits = [...script.digits];
  let current = flow;
  if (current.announce) path.push({ node: null, type: 'announce', detail: `Caller hears: “${current.announce}”` });
  let ins = enterFlowNode(current, current.start, simFacts, path);
  let hops = 0;
  for (let guard = 0; guard < 100; guard++) {
    switch (ins.kind) {
      case 'ring': {
        const who = script.answeredBy && ins.userIds.includes(script.answeredBy) ? script.answeredBy : null;
        if (who) {
          path.push({ node: ins.node, type: 'answered', detail: 'Answered' });
          return { outcome: 'answered', path, missedCallText: null };
        }
        (tried[ins.node] ??= []).push(...ins.userIds);
        ins = resumeFlow(current, ins.node, { kind: 'dial', status: 'no-answer' }, simFacts, path);
        continue;
      }
      case 'forward':
        if (script.answeredBy === 'forward') {
          path.push({ node: ins.node, type: 'answered', detail: 'Answered on the forwarded phone' });
          return { outcome: 'forwarded', path, missedCallText: null };
        }
        ins = resumeFlow(current, ins.node, { kind: 'dial', status: 'no-answer' }, simFacts, path);
        continue;
      case 'gather':
        ins = resumeFlow(current, ins.node, { kind: 'digits', digits: digits.shift() ?? null, attempt: ins.attempt }, simFacts, path);
        continue;
      case 'number_flow': {
        const other = script.flows[ins.phoneNumberId];
        if (!other || hops >= FLOW_MAX_HOPS) {
          path.push({ node: ins.node, type: 'number_flow', detail: other ? 'Too many hand-offs — voicemail' : 'That number has no flow — its default routing' });
          if (!other) return { outcome: 'default_routing', path, missedCallText: null };
          ins = { kind: 'voicemail', node: null, greeting: null, userId: null };
          continue;
        }
        hops += 1;
        current = other;
        ins = enterFlowNode(current, current.start, simFacts, path);
        continue;
      }
      case 'voicemail':
      case 'hangup': {
        // The text goes out from the number that was called, under its settings.
        const text = flow.missed_call_text?.enabled ? flow.missed_call_text.body : null;
        if (text) path.push({ node: null, type: 'missed_call_text', detail: `Texts the caller: “${text}”` });
        return { outcome: ins.kind, path, missedCallText: text };
      }
      case 'done':
        return { outcome: 'answered', path, missedCallText: null };
    }
  }
  return { outcome: 'voicemail', path, missedCallText: null };
}
