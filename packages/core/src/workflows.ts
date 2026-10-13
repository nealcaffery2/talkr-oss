/**
 * Workflow engine core (Phase 7 — docs/workflows.md): trigger/action
 * vocabulary, zod schemas for write-time validation, and the pure condition
 * DSL evaluator. Zero I/O — the server validates with the schemas and the
 * worker evaluates with `evaluateConditions`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Trigger vocabulary (docs/workflows.md §2)
// ---------------------------------------------------------------------------

export const WORKFLOW_TRIGGER_TYPES = [
  'call.completed',
  'call.missed',
  'disposition.created',
  'message.received',
  'lead.created',
  'no_contact_for_days',
  /**
   * Never fired by the trigger feed or the time sweep: runs exist only when a
   * user enrolls leads (POST /v1/sequences/:id/enroll — docs/sequences.md).
   */
  'manual',
] as const;

/** What a workflow row is for: an event-driven automation or a drip sequence. */
export const WORKFLOW_KINDS = ['workflow', 'sequence'] as const;
export type WorkflowKind = (typeof WORKFLOW_KINDS)[number];

export type WorkflowTriggerType = (typeof WORKFLOW_TRIGGER_TYPES)[number];

/** Per-trigger config: only the time trigger carries configuration. */
export const triggerConfigSchema = z
  .object({
    /** no_contact_for_days: the inactivity window in days (1–365). */
    days: z.number().int().min(1).max(365).optional(),
  })
  .strict();

export type WorkflowTriggerConfig = z.infer<typeof triggerConfigSchema>;

// ---------------------------------------------------------------------------
// Condition DSL (docs/workflows.md §5)
// ---------------------------------------------------------------------------

export const CONDITION_OPS = [
  'eq',
  'neq',
  'gt',
  'lt',
  'contains',
  'is_null',
  'not_null',
  'in',
] as const;

export type ConditionOp = (typeof CONDITION_OPS)[number];

export interface ConditionPredicate {
  field: string;
  op: ConditionOp;
  value?: unknown;
}

export type ConditionNode =
  | { all: ConditionNode[] }
  | { any: ConditionNode[] }
  | ConditionPredicate;

const predicateSchema = z
  .object({
    field: z.string().min(1).max(200),
    op: z.enum(CONDITION_OPS),
    value: z.unknown().optional(),
  })
  .strict();

/** Recursive tree; depth-capped so a pathological config cannot recurse away. */
export const conditionNodeSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.union([
    z.object({ all: z.array(conditionNodeSchema).max(20) }).strict(),
    z.object({ any: z.array(conditionNodeSchema).max(20) }).strict(),
    predicateSchema,
  ]),
);

/** Workflow-level conditions: null/absent means "always matches". */
export const conditionsSchema = conditionNodeSchema.nullable();

const MAX_CONDITION_DEPTH = 10;

/**
 * Thrown for configuration errors discovered at evaluation time (unknown
 * field, unknown op, type mismatch). The engine turns this into a `failed`
 * run with the message — never a crash, never a silent pass.
 */
export class WorkflowConditionError extends Error {}

/** Flattened evaluation context: every key the trigger can know, nulls included. */
export type WorkflowContext = Record<string, unknown>;

function evalPredicate(p: ConditionPredicate, context: WorkflowContext): boolean {
  if (!Object.prototype.hasOwnProperty.call(context, p.field)) {
    throw new WorkflowConditionError(
      `unknown condition field "${p.field}" (available: ${Object.keys(context).sort().join(', ')})`,
    );
  }
  const actual = context[p.field];
  switch (p.op) {
    case 'eq':
      return looseEquals(actual, p.value);
    case 'neq':
      return !looseEquals(actual, p.value);
    case 'is_null':
      return actual == null;
    case 'not_null':
      return actual != null;
    case 'gt':
    case 'lt': {
      const cmp = compare(actual, p.value, p.field);
      return p.op === 'gt' ? cmp > 0 : cmp < 0;
    }
    case 'contains': {
      if (typeof actual === 'string') {
        if (typeof p.value !== 'string') {
          throw new WorkflowConditionError(
            `contains on string field "${p.field}" needs a string value`,
          );
        }
        return actual.toLowerCase().includes(p.value.toLowerCase());
      }
      if (Array.isArray(actual)) return actual.some((v) => looseEquals(v, p.value));
      if (actual == null) return false;
      throw new WorkflowConditionError(
        `contains needs a string or array field; "${p.field}" is ${typeof actual}`,
      );
    }
    case 'in': {
      if (!Array.isArray(p.value)) {
        throw new WorkflowConditionError(`op "in" on "${p.field}" needs an array value`);
      }
      return p.value.some((v) => looseEquals(actual, v));
    }
    default: {
      // Unreachable through the zod schema; direct rows can still get here.
      throw new WorkflowConditionError(`unknown condition op "${String(p.op)}"`);
    }
  }
}

/** eq semantics: strict equality with number/numeric-string tolerance. */
function looseEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  if (typeof a === 'number' && typeof b === 'string' && b.trim() !== '' && !Number.isNaN(Number(b))) {
    return a === Number(b);
  }
  if (typeof b === 'number' && typeof a === 'string' && a.trim() !== '' && !Number.isNaN(Number(a))) {
    return Number(a) === b;
  }
  return false;
}

function compare(actual: unknown, expected: unknown, field: string): number {
  if (actual == null || expected == null) {
    throw new WorkflowConditionError(`cannot order-compare null on field "${field}"`);
  }
  const aNum = typeof actual === 'number' ? actual : NaN;
  const bNum =
    typeof expected === 'number'
      ? expected
      : typeof expected === 'string' && expected.trim() !== ''
        ? Number(expected)
        : NaN;
  if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) return aNum === bNum ? 0 : aNum > bNum ? 1 : -1;
  if (typeof actual === 'string' && typeof expected === 'string') {
    return actual === expected ? 0 : actual > expected ? 1 : -1;
  }
  throw new WorkflowConditionError(
    `cannot order-compare ${typeof actual} with ${typeof expected} on field "${field}"`,
  );
}

/**
 * Evaluate a condition tree against a flattened context. Pure; throws
 * WorkflowConditionError on any configuration problem (unknown field/op,
 * type mismatch, over-deep nesting).
 */
export function evaluateConditions(
  node: ConditionNode | null | undefined,
  context: WorkflowContext,
  depth = 0,
): boolean {
  if (node == null) return true;
  if (depth > MAX_CONDITION_DEPTH) {
    throw new WorkflowConditionError(`conditions nested deeper than ${MAX_CONDITION_DEPTH}`);
  }
  if ('all' in node && Array.isArray((node as { all: unknown }).all)) {
    return (node as { all: ConditionNode[] }).all.every((c) =>
      evaluateConditions(c, context, depth + 1),
    );
  }
  if ('any' in node && Array.isArray((node as { any: unknown }).any)) {
    const branches = (node as { any: ConditionNode[] }).any;
    if (branches.length === 0) return true; // empty OR matches (vacuous config)
    // No short-circuit: every branch is validated so config errors surface
    // deterministically instead of depending on data.
    let matched = false;
    for (const branch of branches) {
      if (evaluateConditions(branch, context, depth + 1)) matched = true;
    }
    return matched;
  }
  if ('field' in node && 'op' in node) {
    return evalPredicate(node as ConditionPredicate, context);
  }
  throw new WorkflowConditionError('malformed condition node (expected all/any/predicate)');
}

// ---------------------------------------------------------------------------
// Action registry (docs/workflows.md §6)
// ---------------------------------------------------------------------------

/** Executable actions this phase. */
export const WORKFLOW_ACTION_TYPES = [
  'send_sms',
  'create_task',
  'update_lead_status',
  'assign_lead',
  'emit_webhook',
  'add_to_campaign',
  'wait',
  'ai_agent',
] as const;

/** Longest single wait: 90 days, in minutes. */
export const MAX_WAIT_MINUTES = 90 * 24 * 60;

/**
 * Reserved names: known vocabulary, not executable yet — CRUD rejects them
 * with a clear error and the engine fails a run that somehow carries one.
 * (`add_to_campaign` graduated to executable with the Phase 5 dialer merge.)
 */
export const RESERVED_WORKFLOW_ACTION_TYPES = [] as const;

export type WorkflowActionType = (typeof WORKFLOW_ACTION_TYPES)[number];

const sendSmsActionSchema = z
  .object({
    type: z.literal('send_sms'),
    /** Phase 4 message template; rendered by the existing send path. */
    template_id: z.string().uuid().optional(),
    /**
     * Inline body with {first_name} {name} {address} {city} {rep_name} merge
     * fields (docs/sequences.md §4), rendered by the engine before the send
     * path. Exactly one of template_id / body — checked in
     * validateWorkflowDefinition (a discriminated union cannot carry a refine).
     */
    body: z.string().min(1).max(1600).optional(),
  })
  .strict();

const waitActionSchema = z
  .object({
    type: z.literal('wait'),
    /** Pause the run for this long before the next action (1 min – 90 days). */
    minutes: z.number().int().min(1).max(MAX_WAIT_MINUTES),
  })
  .strict();

const createTaskActionSchema = z
  .object({
    type: z.literal('create_task'),
    title: z.string().min(1).max(500),
    note: z.string().max(10_000).optional(),
    /** Explicit user id or the literal "lead_owner". */
    assign_to: z.union([z.string().uuid(), z.literal('lead_owner')]),
    due_in_hours: z.number().min(0).max(24 * 365),
  })
  .strict();

const updateLeadStatusActionSchema = z
  .object({
    type: z.literal('update_lead_status'),
    status: z.string().min(1).max(100),
  })
  .strict();

const assignLeadActionSchema = z
  .object({
    type: z.literal('assign_lead'),
    user_id: z.string().uuid(),
  })
  .strict();

const emitWebhookActionSchema = z
  .object({
    type: z.literal('emit_webhook'),
  })
  .strict();

const addToCampaignActionSchema = z
  .object({
    type: z.literal('add_to_campaign'),
    /** Phase 5 dialer campaign; existence + org checked at run time. */
    campaign_id: z.string().uuid(),
  })
  .strict();

/**
 * What an AI agent step may do on the lead's behalf (docs/sequences.md §11).
 * The engine executes only what is listed; the model plans, it never sends.
 */
export const AGENT_CAPABILITIES = ['send_sms', 'create_task', 'update_lead_status'] as const;
export type AgentCapability = (typeof AGENT_CAPABILITIES)[number];

const aiAgentActionSchema = z
  .object({
    type: z.literal('ai_agent'),
    /** What the agent is trying to achieve at this point of the plan. */
    goal: z.string().min(10).max(1000),
    /** Capabilities the agent may use; everything else is refused at plan time. */
    allowed: z.array(z.enum(AGENT_CAPABILITIES)).min(1).max(AGENT_CAPABILITIES.length),
  })
  .strict();

export const workflowActionSchema = z.discriminatedUnion('type', [
  sendSmsActionSchema,
  createTaskActionSchema,
  updateLeadStatusActionSchema,
  assignLeadActionSchema,
  emitWebhookActionSchema,
  addToCampaignActionSchema,
  waitActionSchema,
  aiAgentActionSchema,
]);

export type WorkflowAction = z.infer<typeof workflowActionSchema>;

/** Event workflows stay short; a sequence interleaves waits, so it gets more room. */
export const MAX_WORKFLOW_ACTIONS = 10;
export const MAX_SEQUENCE_ACTIONS = 40;

export const workflowActionsSchema = z.array(workflowActionSchema).min(1).max(MAX_SEQUENCE_ACTIONS);

// ---------------------------------------------------------------------------
// Exit rules (docs/sequences.md §5): evaluated before every action of a run
// that carries them. Null = the run only ends when its actions do.
// ---------------------------------------------------------------------------

export const exitRulesSchema = z
  .object({
    /** Stop once the lead's contact has sent an inbound message after enrollment. */
    stop_on_reply: z.boolean().default(false),
    /** Stop when the lead's status is one of these (free-text statuses). */
    stop_on_statuses: z.array(z.string().min(1).max(100)).max(50).default([]),
    /** Stop once a call with the lead has been answered after enrollment. */
    stop_on_call_answered: z.boolean().default(false),
  })
  .strict();

export type ExitRules = z.infer<typeof exitRulesSchema>;

// ---------------------------------------------------------------------------
// Completion routing (docs/sequences.md §12): what happens to a lead once a
// sequence run finishes. Null = nothing, the lead simply leaves the plan.
// ---------------------------------------------------------------------------

export const ON_COMPLETE_MODES = ['none', 'fixed', 'smart'] as const;

export const onCompleteSchema = z
  .object({
    /** none: do nothing. fixed: enroll in sequence_id. smart: pick from candidates by history. */
    mode: z.enum(ON_COMPLETE_MODES).default('none'),
    /** fixed mode: the next sequence. */
    sequence_id: z.string().uuid().nullable().default(null),
    /** smart mode: the sequences the router may choose from; empty = every enabled sequence. */
    candidate_ids: z.array(z.string().uuid()).max(50).default([]),
    /** Also route a run that an exit rule stopped (a reply, a status). Off by default: a lead who answered needs a person. */
    also_when_stopped: z.boolean().default(false),
  })
  .strict();

export type OnComplete = z.infer<typeof onCompleteSchema>;

/** Cross-field rule the schema cannot express. Returns an error string or null. */
export function validateOnComplete(rule: OnComplete | null | undefined, selfId?: string | null): string | null {
  if (!rule || rule.mode === 'none') return null;
  if (rule.mode === 'fixed') {
    if (!rule.sequence_id) return 'on_complete: fixed routing needs sequence_id';
    if (selfId && rule.sequence_id === selfId) return 'on_complete: a sequence cannot route into itself';
  }
  if (rule.mode === 'smart' && selfId && rule.candidate_ids.includes(selfId)) {
    return 'on_complete: a sequence cannot be its own candidate';
  }
  return null;
}

// ---------------------------------------------------------------------------
// Whole-workflow write-time validation (server CRUD uses this)
// ---------------------------------------------------------------------------

export const workflowDefinitionSchema = z.object({
  name: z.string().min(1).max(200),
  enabled: z.boolean().optional().default(true),
  kind: z.enum(WORKFLOW_KINDS).optional().default('workflow'),
  trigger_type: z.enum(WORKFLOW_TRIGGER_TYPES),
  trigger_config: triggerConfigSchema.optional().default({}),
  conditions: conditionsSchema.optional().default(null),
  actions: workflowActionsSchema,
  exit_rules: exitRulesSchema.nullable().optional().default(null),
  max_runs_per_lead_per_day: z.number().int().min(1).max(100).optional(),
  max_runs_per_day: z.number().int().min(1).max(10_000).optional(),
});

export type WorkflowDefinition = z.infer<typeof workflowDefinitionSchema>;

/**
 * Cross-field checks zod's shape alone can't express. Returns a clear
 * error string or null. Reserved actions are rejected here so the caller
 * can name them distinctly from unknown ones.
 */
export function validateWorkflowDefinition(def: WorkflowDefinition): string | null {
  if (def.trigger_type === 'no_contact_for_days' && !def.trigger_config.days) {
    return 'trigger no_contact_for_days requires trigger_config.days (1-365)';
  }
  if (def.kind !== 'sequence' && def.actions.length > MAX_WORKFLOW_ACTIONS) {
    return `a workflow may have at most ${MAX_WORKFLOW_ACTIONS} actions`;
  }
  if (def.kind === 'sequence' && def.trigger_type !== 'manual') {
    return 'a sequence must use trigger_type "manual" (runs start on enrollment)';
  }
  for (const [i, action] of def.actions.entries()) {
    if (action.type === 'ai_agent' && def.kind !== 'sequence') {
      return `action ${i + 1} (ai_agent) is only available in a sequence`;
    }
    if (action.type !== 'send_sms') continue;
    const hasTemplate = action.template_id != null;
    const hasBody = action.body != null;
    if (hasTemplate === hasBody) {
      return `action ${i + 1} (send_sms) needs exactly one of template_id or body`;
    }
  }
  return null;
}
