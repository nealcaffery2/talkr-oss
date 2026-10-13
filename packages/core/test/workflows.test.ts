/**
 * Condition DSL units (docs/workflows.md §5): every op, all/any nesting,
 * unknown field/op failure, and the write-time schemas' rejection rules.
 */

import { describe, expect, it } from 'vitest';
import {
  evaluateConditions,
  validateWorkflowDefinition,
  WorkflowConditionError,
  workflowActionSchema,
  workflowDefinitionSchema,
  type ConditionNode,
  type WorkflowContext,
} from '../src/workflows.js';

const ctx: WorkflowContext = {
  'event.type': 'call.missed',
  'call.status': 'completed',
  'call.direction': 'inbound',
  'call.duration_seconds': 42,
  'call.answered': false,
  'call.failure_class': 'none',
  'lead.status': 'new',
  'lead.source': 'ppc',
  'lead.assigned_user_id': null,
  'contact.display_name': 'Sally Seller',
  'disposition.slug': null,
  'disposition.name': null,
  'message.tags': ['hot', 'urgent'],
};

const p = (field: string, op: string, value?: unknown): ConditionNode =>
  ({ field, op, value }) as ConditionNode;

describe('predicates — every op', () => {
  it('eq / neq', () => {
    expect(evaluateConditions(p('call.direction', 'eq', 'inbound'), ctx)).toBe(true);
    expect(evaluateConditions(p('call.direction', 'eq', 'outbound'), ctx)).toBe(false);
    expect(evaluateConditions(p('call.direction', 'neq', 'outbound'), ctx)).toBe(true);
    expect(evaluateConditions(p('call.duration_seconds', 'eq', 42), ctx)).toBe(true);
    // Numeric-string tolerance (builder inputs arrive as strings).
    expect(evaluateConditions(p('call.duration_seconds', 'eq', '42'), ctx)).toBe(true);
    expect(evaluateConditions(p('call.answered', 'eq', false), ctx)).toBe(true);
    expect(evaluateConditions(p('lead.assigned_user_id', 'eq', null), ctx)).toBe(true);
  });

  it('gt / lt (numbers, numeric strings, lexical strings)', () => {
    expect(evaluateConditions(p('call.duration_seconds', 'gt', 41), ctx)).toBe(true);
    expect(evaluateConditions(p('call.duration_seconds', 'gt', 42), ctx)).toBe(false);
    expect(evaluateConditions(p('call.duration_seconds', 'lt', 43), ctx)).toBe(true);
    expect(evaluateConditions(p('call.duration_seconds', 'gt', '40'), ctx)).toBe(true);
    expect(evaluateConditions(p('lead.status', 'gt', 'm'), ctx)).toBe(true); // 'new' > 'm'
    expect(evaluateConditions(p('lead.status', 'lt', 'a'), ctx)).toBe(false);
  });

  it('contains (substring, case-insensitive; array membership)', () => {
    expect(evaluateConditions(p('contact.display_name', 'contains', 'sally'), ctx)).toBe(true);
    expect(evaluateConditions(p('contact.display_name', 'contains', 'bob'), ctx)).toBe(false);
    expect(evaluateConditions(p('message.tags', 'contains', 'hot'), ctx)).toBe(true);
    expect(evaluateConditions(p('message.tags', 'contains', 'cold'), ctx)).toBe(false);
    // contains on a null field is false, not an error (absent data ≠ bad config).
    expect(evaluateConditions(p('disposition.slug', 'contains', 'x'), ctx)).toBe(false);
  });

  it('is_null / not_null', () => {
    expect(evaluateConditions(p('disposition.slug', 'is_null'), ctx)).toBe(true);
    expect(evaluateConditions(p('disposition.slug', 'not_null'), ctx)).toBe(false);
    expect(evaluateConditions(p('lead.status', 'not_null'), ctx)).toBe(true);
  });

  it('in', () => {
    expect(evaluateConditions(p('lead.status', 'in', ['new', 'working']), ctx)).toBe(true);
    expect(evaluateConditions(p('lead.status', 'in', ['dead']), ctx)).toBe(false);
    expect(evaluateConditions(p('call.duration_seconds', 'in', [41, 42]), ctx)).toBe(true);
  });
});

describe('all/any nesting', () => {
  it('null/empty conditions match everything', () => {
    expect(evaluateConditions(null, ctx)).toBe(true);
    expect(evaluateConditions(undefined, ctx)).toBe(true);
    expect(evaluateConditions({ all: [] }, ctx)).toBe(true);
    expect(evaluateConditions({ any: [] }, ctx)).toBe(true);
  });

  it('all = AND, any = OR, nested', () => {
    const tree: ConditionNode = {
      all: [
        p('call.direction', 'eq', 'inbound'),
        {
          any: [p('lead.status', 'eq', 'dead'), p('call.duration_seconds', 'gt', 10)],
        },
      ],
    };
    expect(evaluateConditions(tree, ctx)).toBe(true);
    const failing: ConditionNode = {
      all: [
        p('call.direction', 'eq', 'inbound'),
        { any: [p('lead.status', 'eq', 'dead'), p('call.duration_seconds', 'gt', 100)] },
      ],
    };
    expect(evaluateConditions(failing, ctx)).toBe(false);
  });

  it('any does not short-circuit past config errors', () => {
    const tree: ConditionNode = {
      any: [p('call.direction', 'eq', 'inbound'), p('bogus.field', 'eq', 1)],
    };
    expect(() => evaluateConditions(tree, ctx)).toThrow(WorkflowConditionError);
  });
});

describe('unknown field/op and type errors fail loudly', () => {
  it('unknown field names the field and the available keys', () => {
    expect(() => evaluateConditions(p('no.such_field', 'eq', 1), ctx)).toThrow(/no\.such_field/);
  });

  it('unknown op throws (direct rows bypassing zod)', () => {
    expect(() => evaluateConditions(p('lead.status', 'matches', 'x'), ctx)).toThrow(
      WorkflowConditionError,
    );
  });

  it('in without an array value throws', () => {
    expect(() => evaluateConditions(p('lead.status', 'in', 'new'), ctx)).toThrow(/needs an array/);
  });

  it('order comparison across incompatible types throws', () => {
    expect(() => evaluateConditions(p('call.answered', 'gt', 1), ctx)).toThrow(
      WorkflowConditionError,
    );
    expect(() => evaluateConditions(p('lead.assigned_user_id', 'gt', 1), ctx)).toThrow(/null/);
  });

  it('over-deep nesting throws instead of recursing away', () => {
    let node: ConditionNode = p('lead.status', 'eq', 'new');
    for (let i = 0; i < 15; i++) node = { all: [node] };
    expect(() => evaluateConditions(node, ctx)).toThrow(/nested deeper/);
  });

  it('malformed nodes throw', () => {
    expect(() => evaluateConditions({} as ConditionNode, ctx)).toThrow(/malformed/);
  });
});

describe('write-time schemas', () => {
  it('rejects unknown action types', () => {
    expect(workflowActionSchema.safeParse({ type: 'launch_missiles' }).success).toBe(false);
    // add_to_campaign is executable since the Phase 5 merge; campaign_id required.
    expect(workflowActionSchema.safeParse({ type: 'add_to_campaign' }).success).toBe(false);
    expect(
      workflowActionSchema.safeParse({
        type: 'add_to_campaign',
        campaign_id: '3f0e8a52-7f0e-4c3a-9b1d-2a6c5e4d8f01',
      }).success,
    ).toBe(true);
  });

  it('accepts each executable action shape and rejects bad configs', () => {
    expect(
      workflowActionSchema.safeParse({
        type: 'send_sms',
        template_id: '00000000-0000-0000-0000-000000000001',
      }).success,
    ).toBe(true);
    // send_sms takes a template OR an inline body (docs/sequences.md §4); the
    // shape schema accepts either, and the exactly-one rule lives in
    // validateWorkflowDefinition because a discriminated union cannot refine.
    expect(workflowActionSchema.safeParse({ type: 'send_sms', body: 'Hi {first_name}' }).success).toBe(true);
    expect(
      validateWorkflowDefinition(
        workflowDefinitionSchema.parse({
          name: 'wf',
          trigger_type: 'call.missed',
          actions: [{ type: 'send_sms' }],
        }),
      ),
    ).toMatch(/exactly one of template_id or body/);
    expect(
      validateWorkflowDefinition(
        workflowDefinitionSchema.parse({
          name: 'wf',
          trigger_type: 'call.missed',
          actions: [{ type: 'send_sms', template_id: '00000000-0000-0000-0000-000000000001', body: 'x' }],
        }),
      ),
    ).toMatch(/exactly one of template_id or body/);
    expect(
      workflowActionSchema.safeParse({
        type: 'create_task',
        title: 'Call back',
        assign_to: 'lead_owner',
        due_in_hours: 4,
      }).success,
    ).toBe(true);
    expect(
      workflowActionSchema.safeParse({
        type: 'create_task',
        title: 'Call back',
        assign_to: 'somebody',
        due_in_hours: 4,
      }).success,
    ).toBe(false);
    expect(workflowActionSchema.safeParse({ type: 'update_lead_status', status: 'working' }).success).toBe(true);
    expect(
      workflowActionSchema.safeParse({
        type: 'assign_lead',
        user_id: '00000000-0000-0000-0000-000000000002',
      }).success,
    ).toBe(true);
    expect(workflowActionSchema.safeParse({ type: 'emit_webhook' }).success).toBe(true);
    expect(workflowActionSchema.safeParse({ type: 'emit_webhook', extra: 1 }).success).toBe(false);
  });

  it('workflow definition validates trigger vocabulary and cross-field rules', () => {
    const base = {
      name: 'wf',
      trigger_type: 'call.missed',
      actions: [{ type: 'update_lead_status', status: 'missed' }],
    };
    expect(workflowDefinitionSchema.safeParse(base).success).toBe(true);
    expect(workflowDefinitionSchema.safeParse({ ...base, trigger_type: 'call.exploded' }).success).toBe(false);
    expect(workflowDefinitionSchema.safeParse({ ...base, actions: [] }).success).toBe(false);

    const timeTrigger = workflowDefinitionSchema.parse({
      ...base,
      trigger_type: 'no_contact_for_days',
    });
    expect(validateWorkflowDefinition(timeTrigger)).toMatch(/requires trigger_config.days/);
    const withDays = workflowDefinitionSchema.parse({
      ...base,
      trigger_type: 'no_contact_for_days',
      trigger_config: { days: 7 },
    });
    expect(validateWorkflowDefinition(withDays)).toBeNull();
  });
});
