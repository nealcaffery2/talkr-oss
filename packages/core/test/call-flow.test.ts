/**
 * Call-flow validator and executor (packages/core/src/call-flow.ts), pure:
 * the same walk /twiml/flow renders and the Settings simulator shows.
 */

import { describe, expect, it } from 'vitest';
import {
  enterFlowNode,
  flowUsesLastContact,
  resumeFlow,
  simulateCallFlow,
  validateCallFlow,
  type CallFlow,
  type FlowFacts,
} from '../src/index.js';

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';
const TEAM = '44444444-4444-4444-8444-444444444444';

function facts(over: Partial<FlowFacts> = {}): FlowFacts {
  return {
    now: new Date('2026-09-14T15:00:00Z'), // Monday 10:00 in Chicago
    everyone: [A, B, C],
    teams: { [TEAM]: [A, B] },
    leadOwnerUserId: null,
    isAvailable: () => true,
    lastRungAt: () => -1,
    personalPhone: (id) => (id === A ? '+12105550199' : null),
    tried: {},
    ...over,
  };
}

/** Draft input as a person writes it: defaults omitted, validated into a CallFlow. */
function flow(partial: Record<string, unknown>): CallFlow {
  const v = validateCallFlow({ version: 2, recording: true, ...partial });
  if (!v.ok) throw new Error(v.errors.join('; '));
  return v.flow;
}

const weekdays: Record<string, Array<[string, string]>> = { mon: [['09:00', '17:00']], tue: [['09:00', '17:00']], wed: [['09:00', '17:00']], thu: [['09:00', '17:00']], fri: [['09:00', '17:00']] };

describe('validateCallFlow', () => {
  it('refuses loops, dangling pointers and unreachable steps', () => {
    const loop = validateCallFlow({
      version: 2,
      start: 'a',
      nodes: {
        a: { type: 'ring', strategy: 'all', targets: [{ kind: 'everyone' }], no_answer: 'b' },
        b: { type: 'menu', greeting: { tts: 'Press 1' }, options: { '1': 'a' }, no_input: null },
        orphan: { type: 'hangup' },
        c: { type: 'forward', to: { kind: 'e164', e164: '+12105550100' }, no_answer: 'missing' },
      },
    });
    expect(loop.ok).toBe(false);
    const errors = (loop as { errors: string[] }).errors.join('\n');
    expect(errors).toContain('no step "missing"');
    const graph = validateCallFlow({
      version: 2,
      start: 'a',
      nodes: {
        a: { type: 'ring', strategy: 'all', targets: [{ kind: 'everyone' }], no_answer: 'b' },
        b: { type: 'menu', greeting: { tts: 'Press 1' }, options: { '1': 'a' }, no_input: null },
        orphan: { type: 'hangup' },
      },
    });
    const graphErrors = (graph as { errors: string[] }).errors.join('\n');
    expect(graphErrors).toContain('loop: a → b → a');
    expect(graphErrors).toContain('nodes.orphan: unreachable');
  });

  it('refuses a malformed step with a path to it', () => {
    const v = validateCallFlow({ version: 2, start: 'a', nodes: { a: { type: 'ring', strategy: 'loud', targets: [] } } });
    expect(v.ok).toBe(false);
    expect((v as { errors: string[] }).errors.some((e) => e.startsWith('nodes.a'))).toBe(true);
  });
});

describe('executor', () => {
  it('ring-all rings the whole team at once, skipping whoever is away', () => {
    const f = flow({ start: 'ring', nodes: { ring: { type: 'ring', strategy: 'all', targets: [{ kind: 'team', team_id: TEAM }, { kind: 'user', user_id: C }], timeout_seconds: 20, no_answer: null } } });
    const ins = enterFlowNode(f, f.start, facts({ isAvailable: (id) => id !== B }));
    expect(ins).toEqual({ kind: 'ring', node: 'ring', userIds: [A, C], timeoutSeconds: 20 });
  });

  it('sequential rings A then B, then forwards to A’s personal phone', () => {
    const f = flow({
      start: 'seq',
      nodes: {
        seq: { type: 'ring', strategy: 'sequential', targets: [{ kind: 'user', user_id: A }, { kind: 'user', user_id: B }], timeout_seconds: 20, no_answer: 'cell' },
        cell: { type: 'forward', to: { kind: 'personal', user_id: A }, timeout_seconds: 25, no_answer: 'vm' },
        vm: { type: 'voicemail' },
      },
    });
    const first = enterFlowNode(f, f.start, facts());
    expect(first).toMatchObject({ kind: 'ring', userIds: [A] });
    const second = resumeFlow(f, 'seq', { kind: 'dial', status: 'no-answer' }, facts({ tried: { seq: [A] } }));
    expect(second).toMatchObject({ kind: 'ring', userIds: [B] });
    const cell = resumeFlow(f, 'seq', { kind: 'dial', status: 'no-answer' }, facts({ tried: { seq: [A, B] } }));
    expect(cell).toEqual({ kind: 'forward', node: 'cell', to: '+12105550199', timeoutSeconds: 25 });
    expect(resumeFlow(f, 'cell', { kind: 'dial', status: 'no-answer' }, facts())).toMatchObject({ kind: 'voicemail', node: 'vm' });
    expect(resumeFlow(f, 'seq', { kind: 'dial', status: 'completed' }, facts())).toEqual({ kind: 'done' });
  });

  it('round-robin starts with whoever was rung longest ago', () => {
    const f = flow({ start: 'rr', nodes: { rr: { type: 'ring', strategy: 'round_robin', targets: [{ kind: 'everyone' }], no_answer: null } } });
    const ins = enterFlowNode(f, f.start, facts({ lastRungAt: (id) => (id === A ? 3000 : id === B ? 1000 : 2000) }));
    expect(ins).toMatchObject({ kind: 'ring', userIds: [B] });
  });

  it('after hours goes to voicemail and texts the caller', () => {
    const f = flow({
      start: 'hours',
      nodes: {
        hours: { type: 'hours', timezone: 'America/Chicago', schedule: weekdays, holidays: [], open: 'ring', closed: 'vm' },
        ring: { type: 'ring', strategy: 'all', targets: [{ kind: 'everyone' }], no_answer: 'vm2' },
        vm: { type: 'voicemail', greeting: { tts: 'We are closed.' } },
        vm2: { type: 'voicemail' },
      },
      missed_call_text: { enabled: true, body: 'Sorry we missed you, {first_name}!', cooldown_hours: 24 },
    });
    const night = facts({ now: new Date('2026-09-15T04:00:00Z') }); // 23:00 Monday in Chicago
    const sim = simulateCallFlow(f, night, { digits: [], answeredBy: null, flows: {} });
    expect(sim.outcome).toBe('voicemail');
    expect(sim.path.map((p) => p.detail)).toEqual(['Closed', 'Voicemail', 'Texts the caller: “Sorry we missed you, {first_name}!”']);
    expect(sim.missedCallText).toBe('Sorry we missed you, {first_name}!');

    // A holiday is closed even inside the weekly hours.
    const holiday = flow({ ...f, nodes: { ...f.nodes, hours: { ...f.nodes.hours!, holidays: ['2026-09-14'] } } });
    expect(enterFlowNode(holiday, 'hours', facts())).toMatchObject({ kind: 'voicemail', node: 'vm' });
    // Open hours ring instead.
    expect(enterFlowNode(f, 'hours', facts())).toMatchObject({ kind: 'ring' });
  });

  it('an IVR key branches; silence replays, then falls to no_input', () => {
    const f = flow({
      start: 'menu',
      nodes: {
        menu: { type: 'menu', greeting: { tts: 'Press 1 for sales, 2 for Bella' }, options: { '1': 'sales', '2': 'bella' }, repeat: 1, timeout_seconds: 6, no_input: 'bye' },
        sales: { type: 'ring', strategy: 'all', targets: [{ kind: 'team', team_id: TEAM }], no_answer: null },
        bella: { type: 'ring', strategy: 'sequential', targets: [{ kind: 'user', user_id: B }], no_answer: null },
        bye: { type: 'hangup', message: 'Goodbye' },
      },
    });
    expect(enterFlowNode(f, f.start, facts())).toMatchObject({ kind: 'gather', node: 'menu', attempt: 0 });
    expect(resumeFlow(f, 'menu', { kind: 'digits', digits: '2', attempt: 0 }, facts())).toMatchObject({ kind: 'ring', node: 'bella', userIds: [B] });
    expect(resumeFlow(f, 'menu', { kind: 'digits', digits: null, attempt: 0 }, facts())).toMatchObject({ kind: 'gather', attempt: 1 });
    expect(resumeFlow(f, 'menu', { kind: 'digits', digits: '9', attempt: 1 }, facts())).toEqual({ kind: 'hangup', node: 'bye', message: 'Goodbye' });

    const sim = simulateCallFlow(f, facts(), { digits: ['1'], answeredBy: B, flows: {} });
    expect(sim.outcome).toBe('answered');
  });

  it('hands off to another number’s flow, and a missing personal phone is skipped', () => {
    const other = flow({ start: 'x', nodes: { x: { type: 'hangup' } } });
    const f = flow({
      start: 'cell',
      nodes: {
        cell: { type: 'forward', to: { kind: 'personal', user_id: B }, no_answer: 'hand' },
        hand: { type: 'number_flow', phone_number_id: C },
      },
    });
    const sim = simulateCallFlow(f, facts(), { digits: [], answeredBy: null, flows: { [C]: other } });
    expect(sim.outcome).toBe('hangup');
    expect(sim.path[0]!.detail).toBe('No personal phone on file — skipped');
  });
});

describe('last_contact target', () => {
  const NOW = new Date('2026-09-14T15:00:00Z');
  const touch = (userId: string, daysAgo: number, channel: 'call' | 'sms' | 'rvm' = 'rvm') => ({
    userId,
    channel,
    at: new Date(NOW.getTime() - daysAgo * 86_400_000),
    ref: null,
  });
  const callback = flow({
    start: 'first',
    nodes: {
      first: { type: 'ring', strategy: 'sequential', targets: [{ kind: 'last_contact' }, { kind: 'lead_owner' }], no_answer: 'team' },
      team: { type: 'ring', strategy: 'all', targets: [{ kind: 'team', team_id: TEAM }], no_answer: null },
    },
  });

  it('validates, with an optional window of 1-90 days', () => {
    expect(validateCallFlow({ version: 2, start: 'a', nodes: { a: { type: 'ring', strategy: 'all', targets: [{ kind: 'last_contact', within_days: 30 }], no_answer: null } } }).ok).toBe(true);
    expect(validateCallFlow({ version: 2, start: 'a', nodes: { a: { type: 'ring', strategy: 'all', targets: [{ kind: 'last_contact', within_days: 0 }], no_answer: null } } }).ok).toBe(false);
    expect(flowUsesLastContact(callback)).toBe(true);
  });

  it('rings the most recent toucher and says why', () => {
    const path: Parameters<typeof enterFlowNode>[3] = [];
    const ins = enterFlowNode(callback, callback.start, facts({ lastTouches: [touch(B, 6, 'call'), touch(C, 2)], leadOwnerUserId: A }), path);
    expect(ins).toMatchObject({ kind: 'ring', userIds: [C], lastContact: { user_id: C, channel: 'rvm', ref: null } });
    expect(path.at(-1)?.detail).toContain('voicemail drop');
  });

  it('skips an unavailable toucher for the next most recent one', () => {
    const ins = enterFlowNode(callback, callback.start, facts({ lastTouches: [touch(C, 1), touch(B, 3)], isAvailable: (id) => id !== C }));
    expect(ins).toMatchObject({ kind: 'ring', userIds: [B] });
  });

  it('nobody in the window falls through to the next target, like an unknown lead owner', () => {
    const ins = enterFlowNode(callback, callback.start, facts({ lastTouches: [touch(C, 20)], leadOwnerUserId: A }));
    expect(ins).toMatchObject({ kind: 'ring', userIds: [A] });
    expect((ins as { lastContact?: unknown }).lastContact).toBeUndefined();
    // No touches and no owner: the step has nobody and the call moves on.
    const none = enterFlowNode(callback, callback.start, facts({}));
    expect(none).toMatchObject({ kind: 'ring', node: 'team', userIds: [A, B] });
  });

  it('a longer window reaches older touches', () => {
    const wide = flow({ start: 'a', nodes: { a: { type: 'ring', strategy: 'all', targets: [{ kind: 'last_contact', within_days: 30 }], no_answer: null } } });
    expect(enterFlowNode(wide, 'a', facts({ lastTouches: [touch(C, 20)] }))).toMatchObject({ kind: 'ring', userIds: [C] });
  });

  it('after the toucher misses, sequential moves on to the owner', () => {
    const f = facts({ lastTouches: [touch(C, 1)], leadOwnerUserId: A, tried: { first: [C] } });
    expect(resumeFlow(callback, 'first', { kind: 'dial', status: 'no-answer' }, f)).toMatchObject({ kind: 'ring', userIds: [A] });
  });
});
