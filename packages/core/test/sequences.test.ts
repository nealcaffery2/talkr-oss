/**
 * Sequence units (docs/sequences.md): wait-step scheduling math, the
 * quiet-hours deferral helper, step <-> action translation, merge fields,
 * and the AI draft validator's safety rules. Pure — no database.
 */

import { describe, expect, it } from 'vitest';
import { nextSmsSendWindowStart } from '../src/messaging.js';
import {
  actionsToSteps,
  renderMergeFields,
  resumeAtFor,
  sequenceDurationMinutes,
  sequenceTimeline,
  smsSegments,
  splitWaitMinutes,
  stepsToActions,
  unknownMergeFields,
  validateAgentPlan,
  validateRoutingChoice,
  validateSequenceDraft,
  validateSequenceSteps,
  waitMinutes,
  type SequenceStep,
} from '../src/sequences.js';
import {
  onCompleteSchema,
  validateOnComplete,
  validateWorkflowDefinition,
  workflowDefinitionSchema,
} from '../src/workflows.js';

const T0 = new Date('2026-09-08T15:00:00Z');

describe('wait math', () => {
  it('sums days, hours and minutes and splits them back', () => {
    expect(waitMinutes({ days: 2 })).toBe(2880);
    expect(waitMinutes({ days: 1, hours: 2, minutes: 30 })).toBe(1590);
    expect(waitMinutes({})).toBe(0);
    expect(splitWaitMinutes(1590)).toEqual({ days: 1, hours: 2, minutes: 30 });
    expect(splitWaitMinutes(2880)).toEqual({ days: 2, hours: 0, minutes: 0 });
    expect(splitWaitMinutes(45)).toEqual({ days: 0, hours: 0, minutes: 45 });
  });

  it('resume_at is now + the wait, to the millisecond', () => {
    expect(resumeAtFor(T0, 1).toISOString()).toBe('2026-09-08T15:01:00.000Z');
    expect(resumeAtFor(T0, 2880).toISOString()).toBe('2026-09-10T15:00:00.000Z');
  });

  it('timeline reports the day each non-wait step fires on', () => {
    const steps: SequenceStep[] = [
      { type: 'sms', body: 'one' },
      { type: 'wait', days: 2 },
      { type: 'sms', body: 'two' },
      { type: 'wait', days: 1, hours: 12 },
      { type: 'task', title: 'Call', due_in_days: 1 },
      { type: 'wait', hours: 36 },
      { type: 'sms', body: 'three' },
      { type: 'status', status: 'nurture' },
    ];
    const tl = sequenceTimeline(steps);
    expect(tl.map((t) => [t.index, t.day, t.offset_minutes])).toEqual([
      [0, 0, 0],
      [2, 2, 2880],
      [4, 3, 2880 + 2160],
      [6, 5, 2880 + 2160 + 2160],
      [7, 5, 2880 + 2160 + 2160],
    ]);
    expect(sequenceDurationMinutes(steps)).toBe(7200);
  });
});

describe('quiet-hours deferral: nextSmsSendWindowStart', () => {
  const ny = { timezone: 'America/New_York' }; // default 08:00-21:00

  it('is null inside the window (nothing to defer to)', () => {
    expect(nextSmsSendWindowStart(ny, new Date('2026-09-08T18:00:00Z'))).toBeNull(); // 14:00 ET
  });

  it('returns the next 08:00 local after an evening send attempt', () => {
    // 22:30 ET on Sep 8 (EDT, UTC-4) -> 08:00 ET Sep 9 = 12:00Z
    const next = nextSmsSendWindowStart(ny, new Date('2026-09-09T02:30:00Z'));
    expect(next?.toISOString()).toBe('2026-09-09T12:00:00.000Z');
  });

  it('returns the same-day opening before the window starts', () => {
    // 06:15 ET -> 08:00 ET same day
    const next = nextSmsSendWindowStart(ny, new Date('2026-09-08T10:15:00Z'));
    expect(next?.toISOString()).toBe('2026-09-08T12:00:00.000Z');
  });

  it('handles a configured window and fails open on a bad zone', () => {
    const cfg = { timezone: 'America/Chicago', smsSendWindowStart: '09:00', smsSendWindowEnd: '17:00' };
    // 17:30 CDT (UTC-5) = 22:30Z -> 09:00 CDT next day = 14:00Z
    expect(nextSmsSendWindowStart(cfg, new Date('2026-09-08T22:30:00Z'))?.toISOString()).toBe(
      '2026-09-09T14:00:00.000Z',
    );
    expect(nextSmsSendWindowStart({ timezone: 'Not/AZone' }, new Date('2026-09-09T02:30:00Z'))).toBeNull();
  });
});

describe('steps <-> actions', () => {
  it('translates every step type and round-trips', () => {
    const steps: SequenceStep[] = [
      { type: 'sms', body: 'Hi {first_name}, {rep_name} with {company}. Reply STOP to opt out.' },
      { type: 'wait', days: 2, hours: 3 },
      { type: 'task', title: 'Call them', due_in_days: 1 },
      { type: 'sms', template_id: '11111111-1111-4111-8111-111111111111' },
      { type: 'status', status: 'nurture' },
    ];
    const actions = stepsToActions(steps);
    expect(actions).toEqual([
      { type: 'send_sms', body: 'Hi {first_name}, {rep_name} with {company}. Reply STOP to opt out.' },
      { type: 'wait', minutes: 3060 },
      { type: 'create_task', title: 'Call them', assign_to: 'lead_owner', due_in_hours: 24 },
      { type: 'send_sms', template_id: '11111111-1111-4111-8111-111111111111' },
      { type: 'update_lead_status', status: 'nurture' },
    ]);
    expect(actionsToSteps(actions)).toEqual([
      steps[0],
      { type: 'wait', days: 2, hours: 3, minutes: 0 },
      steps[2],
      steps[3],
      steps[4],
    ]);
  });

  it('the translated actions satisfy the workflow definition schema as a sequence', () => {
    const def = workflowDefinitionSchema.parse({
      name: 'x',
      kind: 'sequence',
      trigger_type: 'manual',
      actions: stepsToActions([
        { type: 'sms', body: 'a' },
        { type: 'wait', days: 1 },
        { type: 'sms', body: 'b' },
      ]),
      exit_rules: { stop_on_reply: true },
    });
    expect(def.exit_rules).toEqual({ stop_on_reply: true, stop_on_statuses: [], stop_on_call_answered: false });
    expect(validateWorkflowDefinition(def)).toBeNull();
    // A send_sms with both or neither of body/template_id is rejected.
    expect(
      validateWorkflowDefinition({ ...def, actions: [{ type: 'send_sms' }] as never }),
    ).toMatch(/exactly one of template_id or body/);
    // A sequence must be manual; a manual trigger never fires from the feed.
    expect(validateWorkflowDefinition({ ...def, trigger_type: 'lead.created' })).toMatch(/manual/);
  });

  it('rejects step lists that cannot run', () => {
    expect(validateSequenceSteps([{ type: 'wait', days: 1 }])).toMatch(/at least one step/);
    expect(validateSequenceSteps([{ type: 'sms', body: 'x' }, { type: 'wait', days: 1 }])).toMatch(/end with a wait/);
    expect(validateSequenceSteps([{ type: 'sms', body: '' }])).toMatch(/needs a body or a template/);
    expect(validateSequenceSteps([{ type: 'sms', body: 'Hi {nickname}' }])).toMatch(/unknown merge field \{nickname\}/);
    expect(validateSequenceSteps([{ type: 'sms', body: 'x' }, { type: 'wait' }, { type: 'sms', body: 'y' }])).toMatch(
      /at least 1 minute/,
    );
    expect(validateSequenceSteps([{ type: 'sms', body: 'Hi {first_name}' }])).toBeNull();
  });

  it('translates an agent step and keeps it out of event workflows', () => {
    const steps: SequenceStep[] = [
      { type: 'agent', goal: 'Re-engage a lead who went quiet after the first call', allowed: ['send_sms', 'create_task'] },
    ];
    const actions = stepsToActions(steps);
    expect(actions).toEqual([
      { type: 'ai_agent', goal: 'Re-engage a lead who went quiet after the first call', allowed: ['send_sms', 'create_task'] },
    ]);
    expect(actionsToSteps(actions)).toEqual(steps);
    expect(validateSequenceSteps(steps)).toBeNull();
    const base = { name: 'x', trigger_type: 'manual' as const, trigger_config: {}, conditions: null, exit_rules: null };
    expect(validateWorkflowDefinition({ ...base, kind: 'sequence', enabled: true, actions })).toBeNull();
    expect(validateWorkflowDefinition({ ...base, kind: 'workflow', enabled: true, actions })).toMatch(/only available in a sequence/);
  });
});

describe('agent plan validator', () => {
  it('accepts a plan inside the allowed capabilities and clips a task', () => {
    const r = validateAgentPlan(
      { summary: 'They asked for a call back.', sms_body: null, task_title: 'Call {first_name} back', task_due_in_days: 999, lead_status: null },
      ['send_sms', 'create_task'],
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.sms).toBeUndefined();
      expect(r.plan.task).toEqual({ title: 'Call {first_name} back', due_in_days: 365 });
    }
  });

  it('rejects a capability the step did not allow and an over-long text', () => {
    const r = validateAgentPlan(
      { summary: 's', sms_body: 'x'.repeat(321), task_title: null, task_due_in_days: null, lead_status: 'dead' },
      ['send_sms'],
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.join('\n')).toMatch(/limit is 320/);
      expect(r.errors.join('\n')).toMatch(/may not change the lead status/);
    }
  });

  it('a do-nothing plan is valid', () => {
    const r = validateAgentPlan(
      { summary: 'They replied yesterday; a person should pick this up.', sms_body: null, task_title: null, task_due_in_days: null, lead_status: null },
      ['send_sms'],
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.plan).toEqual({ summary: 'They replied yesterday; a person should pick this up.' });
  });
});

describe('completion routing', () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';

  it('fixed needs a target and nobody routes into themselves', () => {
    expect(validateOnComplete(onCompleteSchema.parse({ mode: 'fixed' }))).toMatch(/needs sequence_id/);
    expect(validateOnComplete(onCompleteSchema.parse({ mode: 'fixed', sequence_id: A }), A)).toMatch(/into itself/);
    expect(validateOnComplete(onCompleteSchema.parse({ mode: 'fixed', sequence_id: A }), B)).toBeNull();
    expect(validateOnComplete(onCompleteSchema.parse({ mode: 'smart', candidate_ids: [A] }), A)).toMatch(/own candidate/);
    expect(validateOnComplete(onCompleteSchema.parse({ mode: 'smart' }), A)).toBeNull();
    expect(validateOnComplete(null)).toBeNull();
  });

  it('a routing choice must name a candidate or null', () => {
    expect(validateRoutingChoice({ sequence_id: A, reason: 'quiet lead' }, [A, B])).toEqual({
      ok: true,
      choice: { sequence_id: A, reason: 'quiet lead' },
    });
    expect(validateRoutingChoice({ sequence_id: '', reason: 'replied' }, [A])).toEqual({
      ok: true,
      choice: { sequence_id: null, reason: 'replied' },
    });
    const bad = validateRoutingChoice({ sequence_id: B, reason: 'x' }, [A]);
    expect(bad.ok).toBe(false);
  });
});

describe('merge fields + segments', () => {
  it('renders known fields (both brace styles), blanks missing values, throws on unknown', () => {
    const vars = { first_name: 'Sally', rep_name: 'Alex', company: 'Your Company', city: null };
    expect(renderMergeFields('Hi {first_name}, {{rep_name}} with {company} in {city}.', vars)).toBe(
      'Hi Sally, Alex with Your Company in .',
    );
    expect(() => renderMergeFields('Hi {nickname}', vars)).toThrow(/unknown merge field \{nickname\}/);
    expect(unknownMergeFields('{first_name} {foo} {bar} {foo}')).toEqual(['foo', 'bar']);
  });

  it('estimates carrier segments', () => {
    expect(smsSegments('')).toEqual({ chars: 0, segments: 0, encoding: 'gsm7' });
    expect(smsSegments('a'.repeat(160)).segments).toBe(1);
    expect(smsSegments('a'.repeat(161)).segments).toBe(2);
    expect(smsSegments('a'.repeat(306)).segments).toBe(2);
    expect(smsSegments('a'.repeat(307)).segments).toBe(3);
    expect(smsSegments('hi 😀').encoding).toBe('ucs2');
    expect(smsSegments('x'.repeat(71)).segments).toBe(1);
    expect(smsSegments('😀'.repeat(71)).segments).toBe(2);
  });
});

describe('AI draft validator', () => {
  const step = (over: Record<string, unknown>) => ({
    type: 'sms',
    body: null,
    days: null,
    hours: null,
    title: null,
    due_in_days: null,
    status: null,
    ...over,
  });
  const good = {
    name: 'Post-call follow-up',
    description: 'Three light touches after a first call.',
    steps: [
      step({ type: 'sms', body: 'Hi {first_name}, this is {rep_name} with {company} about {address}. Still open to an offer? Reply STOP to opt out.' }),
      step({ type: 'wait', days: 2 }),
      step({ type: 'sms', body: 'Hi {first_name}, {rep_name} again. Would a quick call this week work?' }),
      step({ type: 'wait', days: 3 }),
      step({ type: 'task', title: 'Call {first_name}', due_in_days: 1 }),
      step({ type: 'wait', days: 2 }),
      step({ type: 'sms', body: 'Last note from me, {first_name} — happy to help whenever the timing is right.' }),
      step({ type: 'status', status: 'nurture' }),
    ],
    exit_rules: { stop_on_reply: true, stop_on_statuses: ['dead'], stop_on_call_answered: true },
  };
  const constraints = { steps: 3, days: 10, companyName: 'Your Company' };

  it('accepts a compliant draft and types the steps', () => {
    const r = validateSequenceDraft(good, constraints);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.steps).toEqual([
      { type: 'sms', body: good.steps[0]!.body },
      { type: 'wait', days: 2, hours: 0 },
      { type: 'sms', body: good.steps[2]!.body },
      { type: 'wait', days: 3, hours: 0 },
      { type: 'task', title: 'Call {first_name}', due_in_days: 1 },
      { type: 'wait', days: 2, hours: 0 },
      { type: 'sms', body: good.steps[6]!.body },
      { type: 'status', status: 'nurture' },
    ]);
    expect(r.draft.exit_rules).toEqual({ stop_on_reply: true, stop_on_statuses: ['dead'], stop_on_call_answered: true });
    expect(r.warnings).toEqual([]);
  });

  it('rejects an over-long SMS, a missing opt-out, an anonymous sender, unknown fields', () => {
    const long = { ...good, steps: good.steps.map((s, i) => (i === 2 ? step({ type: 'sms', body: 'x'.repeat(321) }) : s)) };
    const r1 = validateSequenceDraft(long, constraints);
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.errors.join('\n')).toMatch(/SMS 2 is 321 characters; the limit is 320/);

    const noOptOut = { ...good, steps: good.steps.map((s, i) => (i === 0 ? step({ type: 'sms', body: 'Hi {first_name}, {rep_name} with {company} here.' }) : s)) };
    const r2 = validateSequenceDraft(noOptOut, constraints);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.errors.join('\n')).toMatch(/how to opt out/);

    const anonymous = { ...good, steps: good.steps.map((s, i) => (i === 0 ? step({ type: 'sms', body: 'Hi {first_name}, still thinking of selling? Reply STOP to opt out.' }) : s)) };
    const r3 = validateSequenceDraft(anonymous, constraints);
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.errors.join('\n')).toMatch(/identify the sender/);

    const unknown = { ...good, steps: good.steps.map((s, i) => (i === 2 ? step({ type: 'sms', body: 'Hi {nickname}' }) : s)) };
    const r4 = validateSequenceDraft(unknown, constraints);
    expect(r4.ok).toBe(false);
    if (!r4.ok) expect(r4.errors.join('\n')).toMatch(/unknown merge field \{nickname\}/);
  });

  it('enforces the requested SMS count and span; merges double waits; drops a trailing wait', () => {
    const tooMany = validateSequenceDraft(good, { ...constraints, steps: 2 });
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.errors.join('\n')).toMatch(/at most 2 were requested/);

    const tooLong = validateSequenceDraft(good, { ...constraints, days: 5 });
    expect(tooLong.ok).toBe(false);
    if (!tooLong.ok) expect(tooLong.errors.join('\n')).toMatch(/spans 7 days; it must fit in 5/);

    const messy = {
      ...good,
      steps: [
        good.steps[0],
        step({ type: 'wait', days: 1 }),
        step({ type: 'wait', hours: 12 }),
        good.steps[2],
        step({ type: 'wait', days: 1 }),
      ],
    };
    const r = validateSequenceDraft(messy, constraints);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.draft.steps).toEqual([
      { type: 'sms', body: good.steps[0]!.body },
      { type: 'wait', days: 1, hours: 12, minutes: 0 },
      { type: 'sms', body: good.steps[2]!.body },
    ]);
    expect(r.warnings).toEqual(['steps 2-3: consecutive waits merged', 'trailing wait dropped']);
  });

  it('flags pressure language as a warning, not an error', () => {
    const pushy = { ...good, steps: good.steps.map((s, i) => (i === 2 ? step({ type: 'sms', body: 'Last chance, {first_name} — act now!' }) : s)) };
    const r = validateSequenceDraft(pushy, constraints);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.warnings[0]).toMatch(/pressure language/);
  });

  it('reports schema problems from the raw shape', () => {
    const r = validateSequenceDraft({ name: '', steps: [] }, constraints);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.length).toBeGreaterThan(0);
  });
});
