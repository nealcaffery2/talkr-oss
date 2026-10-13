/**
 * Workflow run executor (Phase 7 — docs/workflows.md §4-6). One job per run;
 * the run row is the ledger:
 *  - rate caps are checked before any action executes (skipped runs stay
 *    visible in history with their reason);
 *  - conditions are evaluated by the pure core DSL — config errors fail the
 *    run loudly and deterministically, they never crash or retry;
 *  - each action's result is persisted immediately after it completes, so a
 *    queue retry never re-executes an action that already finished
 *    (recorded-completion idempotency; create_task/emit_webhook are
 *    additionally structurally exactly-once via unique keys);
 *  - transient action failures throw into the queue's backoff/retry; the
 *    final attempt marks the run failed.
 *
 * Sequences (docs/sequences.md) add pause/resume on top of the same ledger:
 * a `wait` action parks the run (`status = waiting`, `resume_at`) and
 * schedules a `workflow-run` job for `resume_at` in the same transaction;
 * the resumed job walks the recorded results and continues at the first
 * unfinished action. Exit rules and stop requests (unenroll, archive) are
 * checked before every action, so a parked run that should end never sends
 * another message.
 *
 * Compliance: send_sms goes through the EXISTING Phase 4 service
 * (sendMessage) — suppression and quiet hours are enforced there with no
 * bypass flag; a refusal becomes a skipped_* action result and the run still
 * succeeds (docs/workflows.md §6). The one sequence-specific difference: a
 * quiet-hours refusal parks the run until the org's send window opens and
 * retries the same step (bounded), instead of skipping it.
 */

import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import {
  evaluateConditions,
  exitRulesSchema,
  MergeFieldError,
  nextSmsSendWindowStart,
  renderMergeFields,
  resumeAtFor,
  WorkflowConditionError,
  type AgentPlan,
  type ConditionNode,
  type ExitRules,
  type MergeField,
  type SmsSendWindowConfig,
  type WorkflowAction,
  type WorkflowContext,
} from '@talkr/core';
import { enqueueJob, schema, type DbHandle } from '@talkr/db';
import type { AuthContext } from '../auth.js';
import { agentModel } from '../config.js';
import { planAgentStep } from '../services/agent-step.js';
import { MessageServiceError, sendMessage } from '../services/messages.js';
import { writeAudit } from '../services/audit.js';
import { loadLeadHistory, renderLeadHistory } from '../services/lead-history.js';
import { SequenceAiError } from '../services/sequence-ai.js';
import { routeOnComplete } from '../services/sequence-routing.js';
import type { HandlerDeps, JobHandler } from './handlers.js';

type RunRow = typeof schema.workflowRuns.$inferSelect;
type WorkflowRow = typeof schema.workflows.$inferSelect;
type LeadRow = typeof schema.leads.$inferSelect;

export interface ActionResult {
  index: number;
  type: string;
  status:
    | 'succeeded'
    | 'skipped_suppressed'
    | 'skipped_quiet_hours'
    | 'skipped_no_lead'
    | 'skipped_campaign_archived'
    /** A `wait` action the run is parked on; flips to succeeded when it resumes. */
    | 'waiting'
    /** A sequence SMS blocked by quiet hours; the run is parked and retries this step. */
    | 'deferred_quiet_hours'
    | 'failed';
  /** Per-type detail: message_id, task_id, delivery_count, resume_at, error… */
  detail?: Record<string, unknown>;
  error?: string;
}

/** A result the loop must never re-execute. */
function isTerminalResult(r: ActionResult): boolean {
  return r.status !== 'failed' && r.status !== 'waiting' && r.status !== 'deferred_quiet_hours';
}

/** Deterministic problem: retrying cannot help — fail the run, finish the job. */
class WorkflowConfigError extends Error {}

/** A resume job may fire this much before resume_at (clock skew) and still run. */
const EARLY_RESUME_TOLERANCE_MS = 60_000;
/** A disabled sequence re-checks this often whether it may continue. */
const PAUSED_RECHECK_MS = 15 * 60_000;
/** Quiet-hours deferrals per SMS step before it is skipped like an event workflow's. */
const MAX_QUIET_HOURS_DEFERRALS = 3;

// ---------------------------------------------------------------------------
// Context building (docs/workflows.md §5): flattened, per-trigger families,
// null-valued keys when the entity is absent so "unknown field" stays a
// loud configuration error, never a data-dependent one.
// ---------------------------------------------------------------------------

interface RunRefs {
  call: typeof schema.calls.$inferSelect | null;
  lead: LeadRow | null;
  contact: typeof schema.contacts.$inferSelect | null;
  disposition: typeof schema.callDispositions.$inferSelect | null;
  message: typeof schema.messages.$inferSelect | null;
  conversation: typeof schema.conversations.$inferSelect | null;
}

async function loadRefs(dbh: DbHandle, run: RunRow): Promise<RunRefs> {
  const { db } = dbh;
  const refs: RunRefs = {
    call: null,
    lead: null,
    contact: null,
    disposition: null,
    message: null,
    conversation: null,
  };

  const loadCall = async (callId: string) => {
    refs.call =
      (await db.select().from(schema.calls).where(eq(schema.calls.id, callId)).limit(1))[0] ?? null;
  };

  if (run.triggerSource === 'call.completed' || run.triggerSource === 'call.missed') {
    await loadCall(run.triggerEventId);
    if (!refs.call) throw new WorkflowConfigError(`trigger call ${run.triggerEventId} not found`);
  } else if (run.triggerSource === 'disposition.created') {
    const auditId = run.triggerEventId.replace(/^audit:/, '');
    const audit = (
      await db.select().from(schema.auditLog).where(eq(schema.auditLog.id, auditId)).limit(1)
    )[0];
    if (!audit?.objectId) throw new WorkflowConfigError(`trigger audit row ${auditId} not found`);
    await loadCall(audit.objectId);
    if (!refs.call) throw new WorkflowConfigError(`disposition call ${audit.objectId} not found`);
  } else if (run.triggerSource === 'message.received') {
    refs.message =
      (
        await db.select().from(schema.messages).where(eq(schema.messages.id, run.triggerEventId)).limit(1)
      )[0] ?? null;
    if (!refs.message) throw new WorkflowConfigError(`trigger message ${run.triggerEventId} not found`);
    refs.conversation =
      (
        await db
          .select()
          .from(schema.conversations)
          .where(eq(schema.conversations.id, refs.message.conversationId))
          .limit(1)
      )[0] ?? null;
  }

  const leadId = run.leadId ?? refs.call?.leadId ?? null;
  if (leadId) {
    refs.lead =
      (await db.select().from(schema.leads).where(eq(schema.leads.id, leadId)).limit(1))[0] ?? null;
  }
  const contactId = refs.call?.contactId ?? refs.lead?.primaryContactId ?? null;
  if (contactId) {
    refs.contact =
      (await db.select().from(schema.contacts).where(eq(schema.contacts.id, contactId)).limit(1))[0] ??
      null;
  }
  if (refs.call?.dispositionId) {
    refs.disposition =
      (
        await db
          .select()
          .from(schema.callDispositions)
          .where(eq(schema.callDispositions.id, refs.call.dispositionId))
          .limit(1)
      )[0] ?? null;
  }
  return refs;
}

export function buildContext(triggerSource: string, refs: RunRefs): WorkflowContext {
  const ctx: WorkflowContext = { 'event.type': triggerSource };
  const withCall = triggerSource.startsWith('call.') || triggerSource === 'disposition.created';
  const withMessage = triggerSource === 'message.received';

  if (withCall) {
    ctx['call.status'] = refs.call?.status ?? null;
    ctx['call.direction'] = refs.call?.direction ?? null;
    ctx['call.duration_seconds'] = refs.call?.durationSeconds ?? null;
    ctx['call.from_number'] = refs.call?.fromNumber ?? null;
    ctx['call.to_number'] = refs.call?.toNumber ?? null;
    ctx['call.failure_class'] = refs.call?.failureClass ?? null;
    ctx['call.answered'] = refs.call ? refs.call.answeredAt != null : null;
    ctx['disposition.slug'] = refs.disposition?.slug ?? null;
    ctx['disposition.name'] = refs.disposition?.name ?? null;
    ctx['disposition.note'] = refs.call?.dispositionNote ?? null;
  }
  if (withMessage) {
    ctx['message.body'] = refs.message?.body ?? null;
    // Inbound: their number is the sender, our number the recipient.
    ctx['message.from'] = refs.conversation?.theirNumber ?? null;
    ctx['message.to'] = refs.conversation?.ourNumber ?? null;
  }
  // Lead/contact families are present for every trigger.
  ctx['lead.status'] = refs.lead?.status ?? null;
  ctx['lead.source'] = refs.lead?.source ?? null;
  ctx['lead.assigned_user_id'] = refs.lead?.assignedUserId ?? null;
  ctx['lead.external_item_id'] = refs.lead?.externalItemId ?? null;
  ctx['contact.display_name'] = refs.contact?.displayName ?? null;
  return ctx;
}

// ---------------------------------------------------------------------------
// Rate caps (docs/workflows.md §4.4): only matched runs consume budget. A
// parked (`waiting`) or early-ended (`stopped`) run got past the caps and
// executed, so it counts like a running one.
// ---------------------------------------------------------------------------

async function checkRateCaps(
  dbh: DbHandle,
  workflow: WorkflowRow,
  run: RunRow,
): Promise<'ok' | 'rate_cap_lead_daily' | 'rate_cap_workflow_daily'> {
  const dayStart = new Date();
  dayStart.setUTCHours(0, 0, 0, 0);
  const base = [
    eq(schema.workflowRuns.workflowId, workflow.id),
    ne(schema.workflowRuns.id, run.id),
    eq(schema.workflowRuns.matched, true),
    inArray(schema.workflowRuns.status, ['running', 'waiting', 'succeeded', 'failed', 'stopped']),
    gte(schema.workflowRuns.createdAt, dayStart),
  ];

  if (run.leadId) {
    const perLead = (
      await dbh.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.workflowRuns)
        .where(and(...base, eq(schema.workflowRuns.leadId, run.leadId)))
    )[0]!;
    if (perLead.n >= workflow.maxRunsPerLeadPerDay) return 'rate_cap_lead_daily';
  }

  const perWorkflow = (
    await dbh.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.workflowRuns)
      .where(and(...base))
  )[0]!;
  if (perWorkflow.n >= workflow.maxRunsPerDay) return 'rate_cap_workflow_daily';
  return 'ok';
}

// ---------------------------------------------------------------------------
// Exit rules + stop requests (docs/sequences.md §5): checked before every
// action, on fresh data — a run that has been parked for days must see what
// happened while it slept.
// ---------------------------------------------------------------------------

type StopCheck = { kind: 'continue' } | { kind: 'already_stopped' } | { kind: 'stop'; reason: string };

function parseExitRules(raw: unknown): ExitRules | null {
  if (raw == null) return null;
  const parsed = exitRulesSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

async function checkStop(dbh: DbHandle, workflow: WorkflowRow, run: RunRow): Promise<StopCheck> {
  const { db } = dbh;
  // Someone ended the run while it was in flight (unenroll, archive).
  const fresh = (
    await db
      .select({ status: schema.workflowRuns.status })
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.id, run.id))
      .limit(1)
  )[0];
  if (!fresh || fresh.status === 'stopped') return { kind: 'already_stopped' };

  const rules = parseExitRules(workflow.exitRules);
  if (!rules || !run.leadId) return { kind: 'continue' };

  const lead = (
    await db
      .select({ status: schema.leads.status, primaryContactId: schema.leads.primaryContactId })
      .from(schema.leads)
      .where(eq(schema.leads.id, run.leadId))
      .limit(1)
  )[0];
  if (!lead) return { kind: 'continue' };

  if (rules.stop_on_statuses.length > 0 && rules.stop_on_statuses.includes(lead.status)) {
    return { kind: 'stop', reason: `status:${lead.status}` };
  }
  if (rules.stop_on_reply) {
    // An inbound message on any thread linked to the lead (or its contact)
    // since enrollment. Outbound rows — including every message this run
    // sent — cannot match: direction is the loop guard, as in the feed.
    const replied = (
      await db.execute(sql`
        SELECT 1 FROM messages m
        JOIN conversations c ON c.id = m.conversation_id
        WHERE m.direction = 'inbound'
          AND m.created_at > ${run.createdAt}
          AND (c.lead_id = ${run.leadId}
               OR (${lead.primaryContactId}::uuid IS NOT NULL AND c.contact_id = ${lead.primaryContactId}))
        LIMIT 1`)
    ).rows;
    if (replied.length > 0) return { kind: 'stop', reason: 'replied' };
  }
  if (rules.stop_on_call_answered) {
    const answered = (
      await db.execute(sql`
        SELECT 1 FROM calls
        WHERE lead_id = ${run.leadId} AND answered_at > ${run.createdAt}
        LIMIT 1`)
    ).rows;
    if (answered.length > 0) return { kind: 'stop', reason: 'call_answered' };
  }
  return { kind: 'continue' };
}

// ---------------------------------------------------------------------------
// Actions (docs/workflows.md §6)
// ---------------------------------------------------------------------------

async function actingContext(
  dbh: DbHandle,
  workflow: WorkflowRow,
  lead: LeadRow | null,
): Promise<AuthContext> {
  const userId = lead?.assignedUserId ?? workflow.createdBy;
  if (!userId) {
    throw new WorkflowConfigError(
      'no_acting_user: lead has no assigned user and the workflow has no creator on record',
    );
  }
  const user = (
    await dbh.db.select().from(schema.users).where(eq(schema.users.id, userId)).limit(1)
  )[0];
  if (!user || user.orgId !== workflow.orgId) {
    throw new WorkflowConfigError(`no_acting_user: user ${userId} not found in org`);
  }
  return {
    userId: user.id,
    orgId: user.orgId,
    role: user.role,
    email: user.email,
    displayName: user.displayName,
  };
}

/** Merge-field values for an inline SMS body (docs/sequences.md §4). */
async function buildMergeVars(
  dbh: DbHandle,
  ctx: AuthContext,
  refs: RunRefs,
  orgName: string,
): Promise<Record<MergeField, string | null>> {
  const property = refs.lead?.propertyId
    ? (
        await dbh.db
          .select()
          .from(schema.properties)
          .where(eq(schema.properties.id, refs.lead.propertyId))
          .limit(1)
      )[0]
    : undefined;
  const name = refs.contact?.displayName?.trim() || null;
  return {
    name,
    first_name: name ? name.split(/\s+/)[0]! : null,
    address: property?.addressLine1 ?? null,
    city: property?.city ?? null,
    state: property?.state ?? null,
    rep_name: ctx.displayName,
    company: orgName,
  };
}

async function loadOrg(dbh: DbHandle, orgId: string) {
  const org = (
    await dbh.db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1)
  )[0];
  if (!org) throw new WorkflowConfigError(`organization ${orgId} not found`);
  return org;
}

async function executeAction(
  deps: HandlerDeps,
  workflow: WorkflowRow,
  run: RunRow,
  refs: RunRefs,
  action: WorkflowAction | { type: string },
  index: number,
  prior: ActionResult | undefined,
): Promise<ActionResult> {
  const { dbh } = deps;
  const base = { index, type: (action as { type: string }).type };
  const isSequence = workflow.kind === 'sequence';

  switch (action.type) {
    case 'send_sms': {
      const a = action as Extract<WorkflowAction, { type: 'send_sms' }>;
      if (!refs.lead) return { ...base, status: 'skipped_no_lead' };
      const ctx = await actingContext(dbh, workflow, refs.lead);

      // Inline body: merge fields render here; the send path gets literal text.
      let body: string | undefined;
      if (a.body != null) {
        const org = await loadOrg(dbh, run.orgId);
        try {
          body = renderMergeFields(a.body, await buildMergeVars(dbh, ctx, refs, org.name));
        } catch (err) {
          if (err instanceof MergeFieldError) throw new WorkflowConfigError(`send_sms: ${err.message}`);
          throw err;
        }
      } else if (a.template_id == null) {
        throw new WorkflowConfigError('send_sms: action has neither template_id nor body');
      }

      try {
        // The EXISTING Phase 4 send path: suppression + quiet hours enforced
        // inside; destination = the lead's primary contact phone.
        const result = await sendMessage(dbh, ctx, {
          leadId: refs.lead.id,
          ...(body != null ? { body } : { templateId: a.template_id! }),
        });
        return {
          ...base,
          status: 'succeeded',
          detail: { message_id: result.message.id, conversation_id: result.conversationId },
        };
      } catch (err) {
        if (err instanceof MessageServiceError) {
          if (err.code === 'suppressed') {
            return { ...base, status: 'skipped_suppressed', detail: { reason: err.message } };
          }
          if (err.code === 'quiet_hours') {
            if (isSequence) {
              // Sequence policy (docs/sequences.md §6): park until the org's
              // window opens and retry this step, a bounded number of times.
              const deferrals = Number(prior?.detail?.deferrals ?? 0) + 1;
              const org = await loadOrg(dbh, run.orgId);
              const settings = (org.settings ?? {}) as SmsSendWindowConfig;
              const resumeAt = nextSmsSendWindowStart(settings, new Date());
              if (resumeAt && deferrals <= MAX_QUIET_HOURS_DEFERRALS) {
                return {
                  ...base,
                  status: 'deferred_quiet_hours',
                  detail: { reason: err.message, resume_at: resumeAt.toISOString(), deferrals },
                };
              }
            }
            // Event-workflow policy: skip, never defer/force (docs/workflows.md assumption 1).
            return { ...base, status: 'skipped_quiet_hours', detail: { reason: err.message } };
          }
          // Bad template / number / config — deterministic, fail the run.
          throw new WorkflowConfigError(`send_sms ${err.code}: ${err.message}`);
        }
        throw err; // transient — let the queue retry
      }
    }

    case 'create_task': {
      const a = action as Extract<WorkflowAction, { type: 'create_task' }>;
      const assignedUserId =
        a.assign_to === 'lead_owner' ? (refs.lead?.assignedUserId ?? null) : a.assign_to;
      const dueAt = new Date(Date.now() + a.due_in_hours * 3_600_000);
      // Structurally exactly-once: unique (workflow_run_id, action_index).
      const inserted = await dbh.db
        .insert(schema.tasks)
        .values({
          orgId: run.orgId,
          leadId: refs.lead?.id ?? null,
          assignedUserId,
          title: a.title,
          note: a.note ?? null,
          dueAt,
          source: 'workflow',
          workflowId: workflow.id,
          workflowRunId: run.id,
          actionIndex: index,
        })
        .onConflictDoNothing()
        .returning({ id: schema.tasks.id });
      let taskId = inserted[0]?.id;
      if (!taskId) {
        const existing = (
          await dbh.db
            .select({ id: schema.tasks.id })
            .from(schema.tasks)
            .where(
              and(eq(schema.tasks.workflowRunId, run.id), eq(schema.tasks.actionIndex, index)),
            )
            .limit(1)
        )[0];
        taskId = existing?.id;
      }
      return { ...base, status: 'succeeded', detail: { task_id: taskId ?? null } };
    }

    case 'update_lead_status': {
      const a = action as Extract<WorkflowAction, { type: 'update_lead_status' }>;
      if (!refs.lead) return { ...base, status: 'skipped_no_lead' };
      await dbh.db
        .update(schema.leads)
        .set({ status: a.status })
        .where(eq(schema.leads.id, refs.lead.id));
      // Static loop-safety marker: a future lead-status trigger MUST exclude
      // workflow-actored changes (docs/workflows.md §7).
      await writeAudit(dbh.db, {
        orgId: run.orgId,
        actorType: 'system',
        actorId: `workflow:${workflow.id}`,
        action: 'lead.status_updated',
        objectType: 'lead',
        objectId: refs.lead.id,
        metadata: { status: a.status, workflow_run_id: run.id },
      });
      return { ...base, status: 'succeeded', detail: { lead_id: refs.lead.id, status: a.status } };
    }

    case 'assign_lead': {
      const a = action as Extract<WorkflowAction, { type: 'assign_lead' }>;
      if (!refs.lead) return { ...base, status: 'skipped_no_lead' };
      const user = (
        await dbh.db
          .select({ id: schema.users.id, orgId: schema.users.orgId })
          .from(schema.users)
          .where(eq(schema.users.id, a.user_id))
          .limit(1)
      )[0];
      if (!user || user.orgId !== run.orgId) {
        throw new WorkflowConfigError(`assign_lead: user ${a.user_id} not found in org`);
      }
      await dbh.db
        .update(schema.leads)
        .set({
          assignedUserId: a.user_id,
          // Speed-to-lead ladder: assigned_at stays first-write-wins.
          assignedAt: sql`COALESCE(${schema.leads.assignedAt}, now())`,
        })
        .where(eq(schema.leads.id, refs.lead.id));
      await writeAudit(dbh.db, {
        orgId: run.orgId,
        actorType: 'system',
        actorId: `workflow:${workflow.id}`,
        action: 'lead.assigned',
        objectType: 'lead',
        objectId: refs.lead.id,
        metadata: { user_id: a.user_id, workflow_run_id: run.id },
      });
      return { ...base, status: 'succeeded', detail: { lead_id: refs.lead.id, user_id: a.user_id } };
    }

    case 'emit_webhook': {
      // Hand off to the Phase 10 delivery machinery: one delivery per active
      // subscription listening for workflow.executed. Exactly-once per
      // (subscription, run, action index) via the deliveries unique key.
      const subs = await dbh.db
        .select()
        .from(schema.webhookSubscriptions)
        .where(
          and(
            eq(schema.webhookSubscriptions.orgId, run.orgId),
            eq(schema.webhookSubscriptions.active, true),
          ),
        );
      const eventId = `wfrun:${run.id}:${index}`;
      let deliveryCount = 0;
      for (const sub of subs) {
        const types = Array.isArray(sub.eventTypes) ? (sub.eventTypes as string[]) : [];
        if (!types.includes('workflow.executed')) continue;
        const envelope = {
          id: eventId,
          type: 'workflow.executed',
          occurredAt: new Date().toISOString(),
          data: {
            workflow: { id: workflow.id, name: workflow.name, trigger_type: workflow.triggerType },
            run: {
              id: run.id,
              trigger_source: run.triggerSource,
              trigger_event_id: run.triggerEventId,
            },
            lead: refs.lead
              ? {
                  id: refs.lead.id,
                  status: refs.lead.status,
                  source: refs.lead.source,
                  assigned_user_id: refs.lead.assignedUserId,
                  external_item_id: refs.lead.externalItemId,
                }
              : null,
          },
        };
        await dbh.db.transaction(async (tx) => {
          const inserted = await tx
            .insert(schema.webhookDeliveries)
            .values({
              orgId: run.orgId,
              subscriptionId: sub.id,
              eventId,
              eventType: 'workflow.executed',
              payload: envelope,
            })
            .onConflictDoNothing()
            .returning({ id: schema.webhookDeliveries.id });
          const deliveryId = inserted[0]?.id;
          if (!deliveryId) return;
          deliveryCount += 1;
          await enqueueJob(tx, {
            jobType: 'webhook-deliver',
            payload: { deliveryId },
            dedupeKey: `webhook-deliver:${deliveryId}`,
          });
        });
      }
      return { ...base, status: 'succeeded', detail: { delivery_count: deliveryCount } };
    }

    case 'add_to_campaign': {
      const a = action as Extract<WorkflowAction, { type: 'add_to_campaign' }>;
      if (!refs.lead) return { ...base, status: 'skipped_no_lead' };
      const campaign = (
        await dbh.db
          .select({
            id: schema.campaigns.id,
            orgId: schema.campaigns.orgId,
            status: schema.campaigns.status,
          })
          .from(schema.campaigns)
          .where(eq(schema.campaigns.id, a.campaign_id))
          .limit(1)
      )[0];
      if (!campaign || campaign.orgId !== run.orgId) {
        throw new WorkflowConfigError(`add_to_campaign: campaign ${a.campaign_id} not found in org`);
      }
      if (campaign.status === 'archived') {
        return { ...base, status: 'skipped_campaign_archived' };
      }
      // Structurally idempotent via campaign_leads_uq (campaign_id, lead_id):
      // a retry or an already-enrolled lead is a no-op, never a duplicate.
      const inserted = await dbh.db
        .insert(schema.campaignLeads)
        .values({ orgId: run.orgId, campaignId: campaign.id, leadId: refs.lead.id })
        .onConflictDoNothing()
        .returning({ id: schema.campaignLeads.id });
      return {
        ...base,
        status: 'succeeded',
        detail: { campaign_id: campaign.id, lead_id: refs.lead.id, attached: inserted.length > 0 },
      };
    }

    case 'ai_agent': {
      // docs/sequences.md §11: the model plans inside the step's allowed
      // capabilities; this engine executes the plan through the same
      // primitives the plain actions use. A plan parked by quiet hours is
      // kept on the result so the retry sends what was decided, not a new
      // decision; a transient failure before any send re-plans on retry.
      const a = action as Extract<WorkflowAction, { type: 'ai_agent' }>;
      if (!refs.lead) return { ...base, status: 'skipped_no_lead' };
      const apiKey = deps.config.ANTHROPIC_API_KEY?.trim();
      if (!apiKey) throw new WorkflowConfigError('ai_agent: ANTHROPIC_API_KEY is not set');
      const ctx = await actingContext(dbh, workflow, refs.lead);
      const org = await loadOrg(dbh, run.orgId);

      let plan = (prior?.detail?.plan ?? null) as AgentPlan | null;
      let model = (prior?.detail?.model as string | undefined) ?? agentModel(deps.config);
      if (!plan) {
        const history = await loadLeadHistory(dbh.db, refs.lead.id);
        const total = Array.isArray(workflow.actions) ? workflow.actions.length : index + 1;
        try {
          const planned = await planAgentStep({
            apiKey,
            model: agentModel(deps.config),
            goal: a.goal,
            allowed: a.allowed,
            history: history ? renderLeadHistory(history) : 'No history on record.',
            position: `"${workflow.name}", step ${index + 1} of ${total}`,
            context: { companyName: org.name, repName: ctx.displayName },
            logger: deps.logger,
            fetchImpl: deps.fetchImpl,
          });
          plan = planned.plan;
          model = planned.model;
        } catch (err) {
          if (err instanceof SequenceAiError && err.code !== 'ai_upstream') {
            // A refusal or a plan that cannot pass validation will not change on retry.
            const why = err.details.length > 0 ? ` (${err.details.join('; ')})` : '';
            throw new WorkflowConfigError(`ai_agent ${err.code}: ${err.message}${why}`);
          }
          throw err; // upstream outage: let the queue retry
        }
      }

      const detail: Record<string, unknown> = { summary: plan.summary, plan, model, executed: {} };
      const executed = detail.executed as Record<string, unknown>;

      if (plan.sms) {
        let body: string;
        try {
          body = renderMergeFields(plan.sms.body, await buildMergeVars(dbh, ctx, refs, org.name));
        } catch (err) {
          if (err instanceof MergeFieldError) throw new WorkflowConfigError(`ai_agent: ${err.message}`);
          throw err;
        }
        try {
          const sent = await sendMessage(dbh, ctx, { leadId: refs.lead.id, body });
          executed.message_id = sent.message.id;
        } catch (err) {
          if (err instanceof MessageServiceError) {
            if (err.code === 'suppressed') {
              return { ...base, status: 'skipped_suppressed', detail: { ...detail, reason: err.message } };
            }
            if (err.code === 'quiet_hours') {
              const deferrals = Number(prior?.detail?.deferrals ?? 0) + 1;
              const settings = (org.settings ?? {}) as SmsSendWindowConfig;
              const resumeAt = nextSmsSendWindowStart(settings, new Date());
              if (isSequence && resumeAt && deferrals <= MAX_QUIET_HOURS_DEFERRALS) {
                return {
                  ...base,
                  status: 'deferred_quiet_hours',
                  detail: { ...detail, reason: err.message, resume_at: resumeAt.toISOString(), deferrals },
                };
              }
              return { ...base, status: 'skipped_quiet_hours', detail: { ...detail, reason: err.message } };
            }
            throw new WorkflowConfigError(`ai_agent send ${err.code}: ${err.message}`);
          }
          throw err;
        }
      }

      if (plan.task) {
        // Structurally exactly-once like create_task: one task per (run, action index).
        const inserted = await dbh.db
          .insert(schema.tasks)
          .values({
            orgId: run.orgId,
            leadId: refs.lead.id,
            assignedUserId: refs.lead.assignedUserId ?? ctx.userId,
            title: plan.task.title,
            note: plan.summary,
            dueAt: new Date(Date.now() + plan.task.due_in_days * 86_400_000),
            source: 'workflow',
            workflowId: workflow.id,
            workflowRunId: run.id,
            actionIndex: index,
          })
          .onConflictDoNothing()
          .returning({ id: schema.tasks.id });
        executed.task_id = inserted[0]?.id ?? null;
      }

      if (plan.status) {
        await dbh.db.update(schema.leads).set({ status: plan.status }).where(eq(schema.leads.id, refs.lead.id));
        await writeAudit(dbh.db, {
          orgId: run.orgId,
          actorType: 'system',
          actorId: `workflow:${workflow.id}`,
          action: 'lead.status_updated',
          objectType: 'lead',
          objectId: refs.lead.id,
          metadata: { status: plan.status, workflow_run_id: run.id, by: 'ai_agent' },
        });
        executed.status = plan.status;
      }

      return { ...base, status: 'succeeded', detail };
    }

    case 'wait':
      // Handled by the run loop (it changes run state, not just a result).
      throw new WorkflowConfigError('wait reached executeAction');

    default:
      throw new WorkflowConfigError(`unknown action type "${(action as { type: string }).type}"`);
  }
}

// ---------------------------------------------------------------------------
// The workflow-run job handler
// ---------------------------------------------------------------------------

async function persistRun(
  dbh: DbHandle,
  runId: string,
  patch: Partial<typeof schema.workflowRuns.$inferInsert>,
): Promise<void> {
  await dbh.db.update(schema.workflowRuns).set(patch).where(eq(schema.workflowRuns.id, runId));
}

/** Resume-job identity: one job per (run, resume instant). */
export function resumeDedupeKey(runId: string, resumeAt: Date): string {
  return `workflow-run:${runId}:resume:${resumeAt.getTime()}`;
}

/**
 * Park the run and schedule its continuation in ONE transaction, so there is
 * never a `waiting` row without a job that will wake it (docs/sequences.md §3).
 */
async function parkRun(
  dbh: DbHandle,
  runId: string,
  patch: { actionResults: ActionResult[]; currentActionIndex: number },
  resumeAt: Date,
): Promise<void> {
  await dbh.db.transaction(async (tx) => {
    await tx
      .update(schema.workflowRuns)
      .set({ status: 'waiting', resumeAt, ...patch })
      .where(eq(schema.workflowRuns.id, runId));
    await enqueueJob(tx, {
      jobType: 'workflow-run',
      payload: { runId },
      dedupeKey: resumeDedupeKey(runId, resumeAt),
      runAt: resumeAt,
    });
  });
}

export const workflowRun: JobHandler = async (deps, job) => {
  const { dbh, logger } = deps;
  const { runId } = job.payload as { runId: string };

  const run = (
    await dbh.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.id, runId)).limit(1)
  )[0];
  if (!run) throw new Error(`workflow run ${runId} not found`);
  // Terminal states: an idempotent re-run (retry, replay, safety-net sweep).
  if (run.status === 'succeeded' || run.status === 'skipped' || run.status === 'stopped') return;

  const workflow = (
    await dbh.db.select().from(schema.workflows).where(eq(schema.workflows.id, run.workflowId)).limit(1)
  )[0];
  if (!workflow) throw new Error(`workflow ${run.workflowId} not found`);

  const isSequence = workflow.kind === 'sequence';
  const resuming = run.status === 'waiting';

  /**
   * Completion routing (docs/sequences.md §12). Runs after the run's own
   * terminal state is persisted, so a routing problem can only cost the
   * hand-off, never the record of what this run did.
   */
  const routeAfter = async (ended: 'succeeded' | 'stopped') => {
    if (!isSequence) return;
    try {
      await routeOnComplete(
        {
          dbh,
          logger,
          ai: { apiKey: deps.config.ANTHROPIC_API_KEY?.trim() || null, model: agentModel(deps.config) },
          fetchImpl: deps.fetchImpl,
        },
        workflow,
        run,
        ended,
      );
    } catch (err) {
      logger.warn({ runId: run.id, workflowId: workflow.id, err }, 'sequence routing failed');
    }
  };

  const stopRun = async (reason: string, index: number, results?: ActionResult[]) => {
    await persistRun(dbh, run.id, {
      status: 'stopped',
      stoppedReason: reason,
      currentActionIndex: index,
      resumeAt: null,
      finishedAt: new Date(),
      ...(results ? { actionResults: results } : {}),
    });
    logger.info({ runId: run.id, workflowId: workflow.id, reason }, 'workflow run stopped');
    await routeAfter('stopped');
  };

  if (resuming) {
    // Fired ahead of its time (clock skew, a replayed job): stay parked. The
    // scheduled job — or the hourly safety net — brings it back when due.
    if (run.resumeAt && run.resumeAt.getTime() - Date.now() > EARLY_RESUME_TOLERANCE_MS) return;
    if (isSequence && workflow.archivedAt) return stopRun('sequence_archived', run.currentActionIndex);
    if (isSequence && !workflow.enabled) {
      // Disabled = paused, not cancelled: check again later and continue
      // from the same step once the sequence is switched back on.
      const recheck = new Date(Date.now() + PAUSED_RECHECK_MS);
      await enqueueJob(dbh.db, {
        jobType: 'workflow-run',
        payload: { runId: run.id },
        dedupeKey: `workflow-run:${run.id}:paused:${Math.floor(recheck.getTime() / PAUSED_RECHECK_MS)}`,
        runAt: recheck,
      });
      return;
    }
  }

  await persistRun(dbh, run.id, {
    status: 'running',
    startedAt: run.startedAt ?? new Date(),
    resumeAt: null,
  });

  const failRun = async (error: string) => {
    await persistRun(dbh, run.id, { status: 'failed', error, finishedAt: new Date() });
    logger.warn({ runId: run.id, workflowId: workflow.id, error }, 'workflow run failed');
  };

  // ── Context ────────────────────────────────────────────────────────────────
  let refs: RunRefs;
  try {
    refs = await loadRefs(dbh, run);
  } catch (err) {
    if (err instanceof WorkflowConfigError) return failRun(err.message);
    throw err;
  }

  // Conditions and caps are decided once, on the first attempt. A run that
  // already parked (current_action_index > 0) or is resuming has executed
  // actions; re-judging it now could cap or skip it mid-flight.
  const firstPass = !resuming && run.currentActionIndex === 0;
  if (firstPass) {
    const context = buildContext(run.triggerSource, refs);

    // ── Conditions (pure; config errors fail loudly, never crash) ───────────
    let matched: boolean;
    try {
      matched = evaluateConditions((workflow.conditions ?? null) as ConditionNode | null, context);
    } catch (err) {
      if (err instanceof WorkflowConditionError) return failRun(`condition error: ${err.message}`);
      throw err;
    }
    if (!matched) {
      await persistRun(dbh, run.id, {
        status: 'skipped',
        matched: false,
        skipReason: 'conditions_not_matched',
        finishedAt: new Date(),
      });
      return;
    }
    await persistRun(dbh, run.id, { matched: true });
    run.matched = true;

    // ── Rate caps: hard loop-safety, visible in history ─────────────────────
    const cap = await checkRateCaps(dbh, workflow, run);
    if (cap !== 'ok') {
      await persistRun(dbh, run.id, {
        status: 'skipped',
        matched: true,
        skipReason: cap,
        finishedAt: new Date(),
      });
      logger.info({ runId: run.id, workflowId: workflow.id, cap }, 'workflow run rate-capped');
      return;
    }
  }

  // ── Actions, in order, with recorded completion ───────────────────────────
  const actions = (Array.isArray(workflow.actions) ? workflow.actions : []) as Array<
    WorkflowAction | { type: string }
  >;
  const results = (Array.isArray(run.actionResults) ? run.actionResults : []) as ActionResult[];

  for (let i = 0; i < actions.length; i++) {
    const prior = results.find((r) => r.index === i);
    if (prior && isTerminalResult(prior)) continue; // already completed — never re-execute

    // Stop requests + exit rules, on fresh data, before every action.
    const stop = await checkStop(dbh, workflow, run);
    if (stop.kind === 'already_stopped') return;
    if (stop.kind === 'stop') return stopRun(stop.reason, i, results);

    const action = actions[i]!;

    if (action.type === 'wait') {
      if (prior?.status === 'waiting') {
        // Resumed: the wait is over; record it and move on.
        upsertResult(results, {
          ...prior,
          status: 'succeeded',
          detail: { ...prior.detail, resumed_at: new Date().toISOString() },
        });
        await persistRun(dbh, run.id, { actionResults: results, currentActionIndex: i + 1 });
        continue;
      }
      const minutes = Number((action as { minutes?: unknown }).minutes);
      if (!Number.isFinite(minutes) || minutes < 1) {
        const message = `wait: invalid minutes ${String((action as { minutes?: unknown }).minutes)}`;
        upsertResult(results, { index: i, type: 'wait', status: 'failed', error: message });
        await persistRun(dbh, run.id, { actionResults: results });
        return failRun(message);
      }
      const resumeAt = resumeAtFor(new Date(), minutes);
      upsertResult(results, {
        index: i,
        type: 'wait',
        status: 'waiting',
        detail: { minutes, resume_at: resumeAt.toISOString() },
      });
      await parkRun(dbh, run.id, { actionResults: results, currentActionIndex: i + 1 }, resumeAt);
      logger.info({ runId: run.id, workflowId: workflow.id, index: i, resumeAt }, 'workflow run waiting');
      return;
    }

    let result: ActionResult;
    try {
      result = await executeAction(deps, workflow, run, refs, action, i, prior);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      const failure: ActionResult = {
        index: i,
        type: (action as { type: string }).type,
        status: 'failed',
        error: message,
      };
      upsertResult(results, failure);
      if (err instanceof WorkflowConfigError) {
        // Deterministic: retries cannot help. Fail now, complete the job.
        await persistRun(dbh, run.id, { actionResults: results });
        return failRun(message);
      }
      // Transient: record, mark failed on the final attempt, throw to retry.
      const isFinalAttempt = job.attempts >= job.maxAttempts;
      await persistRun(dbh, run.id, {
        actionResults: results,
        ...(isFinalAttempt ? { status: 'failed', error: message, finishedAt: new Date() } : {}),
      });
      throw err;
    }

    upsertResult(results, result);

    if (result.status === 'deferred_quiet_hours') {
      // Park until the send window opens; this step runs again first.
      const resumeAt = new Date(String(result.detail?.resume_at));
      await parkRun(dbh, run.id, { actionResults: results, currentActionIndex: i }, resumeAt);
      logger.info({ runId: run.id, workflowId: workflow.id, index: i, resumeAt }, 'workflow run deferred (quiet hours)');
      return;
    }

    // Persist immediately: a later action's failure or a crash never causes
    // this action to run again (docs/workflows.md §4.6).
    await persistRun(dbh, run.id, { actionResults: results, currentActionIndex: i + 1 });

    if (isSequence && result.status === 'skipped_suppressed') {
      // The seller opted out: walking the remaining steps would only record
      // more skips. End the run visibly instead (docs/sequences.md §6).
      return stopRun('suppressed', i + 1, results);
    }
  }

  await persistRun(dbh, run.id, {
    status: 'succeeded',
    error: null,
    resumeAt: null,
    currentActionIndex: actions.length,
    finishedAt: new Date(),
  });
  logger.info(
    { runId: run.id, workflowId: workflow.id, actions: results.length },
    'workflow run succeeded',
  );
  await routeAfter('succeeded');
};

function upsertResult(results: ActionResult[], result: ActionResult): void {
  const at = results.findIndex((r) => r.index === result.index);
  if (at >= 0) results[at] = result;
  else results.push(result);
}
