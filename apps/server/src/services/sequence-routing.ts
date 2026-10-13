/**
 * Completion routing (docs/sequences.md §12): when a sequence run ends, its
 * `on_complete` rule decides where the lead goes next.
 *
 *  - fixed: enroll in one named sequence;
 *  - smart: the model picks one of the candidate sequences (or none) from
 *    the lead's history; without an API key, or when the model fails, the
 *    deterministic fallback picks the first candidate the lead has never
 *    been through, so a plan never silently dead-ends on a config problem.
 *
 * A lead is never routed into a sequence it already ran (the engine's
 * unique key would refuse it anyway, and the router says so), into an
 * archived or disabled one, or into the one that just finished. The next run
 * is created through createRunForWorkflow, the same exactly-once path a
 * person's enroll call uses, and the finished run records where it sent the
 * lead and why.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import {
  AI_ROUTING_CHOICE_JSON_SCHEMA,
  actionsToSteps,
  onCompleteSchema,
  validateRoutingChoice,
  type OnComplete,
} from '@talkr/core';
import { schema, type DbHandle } from '@talkr/db';
import type { Logger } from '../logger.js';
import { createRunForWorkflow } from '../worker/workflow-fanout.js';
import { writeAudit } from './audit.js';
import { loadLeadHistory, renderLeadHistory } from './lead-history.js';
import { ANTHROPIC_URL, ANTHROPIC_VERSION } from './sequence-ai.js';

type WorkflowRow = typeof schema.workflows.$inferSelect;
type RunRow = typeof schema.workflowRuns.$inferSelect;

export interface RoutingDeps {
  dbh: DbHandle;
  logger: Logger;
  ai: { apiKey: string | null; model: string };
  fetchImpl?: typeof fetch;
}

export interface RoutingOutcome {
  /** The run created in the next sequence, or null when the lead was not routed. */
  routed_run_id: string | null;
  reason: string;
}

/** The stored rule, or null when it is absent or malformed (a bad row routes nobody). */
export function parseOnComplete(raw: unknown): OnComplete | null {
  if (raw == null) return null;
  const parsed = onCompleteSchema.safeParse(raw);
  return parsed.success && parsed.data.mode !== 'none' ? parsed.data : null;
}

const SYSTEM_PROMPT = `You route real-estate seller leads between follow-up plans for an acquisitions team. A lead just finished one plan. From their history and the candidate plans, choose the single plan that best fits what should happen next, or choose none.

Rules:
- Choose none when the lead has replied and a person should take over, when they asked to stop, when the house is sold or the lead is dead, or when no candidate fits.
- Never choose a plan the lead has already been through.
- Prefer the plan whose description matches the lead's situation (silent lead, not-now lead, warm but stalled, long-term nurture).
- Give one or two plain sentences of reason for the run history.`;

interface AnthropicMessageResponse {
  model: string;
  stop_reason: string | null;
  content: Array<{ type: string; text?: string }>;
}

function supportsEffort(model: string): boolean {
  return !/haiku|sonnet-4-5/.test(model);
}

interface Candidate {
  row: WorkflowRow;
  summary: string;
}

function describe(row: WorkflowRow): string {
  const steps = actionsToSteps(Array.isArray(row.actions) ? row.actions : []);
  const texts = steps.filter((s) => s.type === 'sms').length;
  const agents = steps.filter((s) => s.type === 'agent').length;
  const days = Math.round(
    steps.reduce((sum, s) => (s.type === 'wait' ? sum + (s.days ?? 0) + (s.hours ?? 0) / 24 : sum), 0),
  );
  return `${row.name}: ${row.description?.trim() || 'no description'} (${texts} texts, ${agents} agent steps, about ${days} days)`;
}

async function chooseWithModel(
  deps: RoutingDeps,
  history: string,
  candidates: Candidate[],
): Promise<{ sequence_id: string | null; reason: string } | null> {
  if (!deps.ai.apiKey) return null;
  const doFetch = deps.fetchImpl ?? fetch;
  const user = [
    'History:',
    history,
    '',
    'Candidate plans (id: description):',
    ...candidates.map((c) => `- ${c.row.id}: ${c.summary}`),
    '',
    'Choose the next plan for this lead, or none.',
  ].join('\n');
  try {
    const res = await doFetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: { 'x-api-key': deps.ai.apiKey, 'anthropic-version': ANTHROPIC_VERSION, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: deps.ai.model,
        max_tokens: 1024,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: user }],
        output_config: {
          ...(supportsEffort(deps.ai.model) ? { effort: 'medium' } : {}),
          format: { type: 'json_schema', schema: AI_ROUTING_CHOICE_JSON_SCHEMA },
        },
      }),
    });
    if (!res.ok) {
      deps.logger.warn({ status: res.status }, 'sequence routing: model call failed');
      return null;
    }
    const msg = (await res.json()) as AnthropicMessageResponse;
    const text = msg.content.find((b) => b.type === 'text')?.text;
    if (!text || msg.stop_reason === 'refusal') return null;
    const checked = validateRoutingChoice(JSON.parse(text), candidates.map((c) => c.row.id));
    if (!checked.ok) {
      deps.logger.warn({ errors: checked.errors }, 'sequence routing: invalid choice');
      return null;
    }
    return checked.choice;
  } catch (err) {
    deps.logger.warn({ err }, 'sequence routing: model error');
    return null;
  }
}

/**
 * Route a finished run's lead. Idempotent per run: a run that already
 * routed (routed_run_id set) is left alone, and the unique run key refuses a
 * second enrollment in the same sequence.
 */
export async function routeOnComplete(
  deps: RoutingDeps,
  workflow: WorkflowRow,
  run: RunRow,
  ended: 'succeeded' | 'stopped',
): Promise<RoutingOutcome | null> {
  const rule = parseOnComplete(workflow.onComplete);
  if (!rule) return null;
  if (ended === 'stopped' && !rule.also_when_stopped) return null;
  if (!run.leadId) return null;
  if (run.routedRunId) return { routed_run_id: run.routedRunId, reason: run.routedReason ?? 'already routed' };
  const { db } = deps.dbh;

  const record = async (outcome: RoutingOutcome) => {
    await db
      .update(schema.workflowRuns)
      .set({ routedRunId: outcome.routed_run_id, routedReason: outcome.reason })
      .where(eq(schema.workflowRuns.id, run.id));
    return outcome;
  };

  // Candidates: live, enabled sequences of this org that are not the one that just ended.
  const wanted = rule.mode === 'fixed' ? [rule.sequence_id!] : rule.candidate_ids;
  const rows = await db
    .select()
    .from(schema.workflows)
    .where(
      and(
        eq(schema.workflows.orgId, run.orgId),
        eq(schema.workflows.kind, 'sequence'),
        eq(schema.workflows.enabled, true),
        isNull(schema.workflows.archivedAt),
        ...(wanted.length > 0 ? [inArray(schema.workflows.id, wanted)] : []),
      ),
    );
  const alreadyRan = new Set(
    (
      await db
        .select({ workflowId: schema.workflowRuns.workflowId })
        .from(schema.workflowRuns)
        .where(eq(schema.workflowRuns.leadId, run.leadId))
    ).map((r) => r.workflowId),
  );
  const candidates: Candidate[] = rows
    .filter((r) => r.id !== workflow.id && !alreadyRan.has(r.id))
    .map((r) => ({ row: r, summary: describe(r) }));

  if (candidates.length === 0) {
    const why =
      rule.mode === 'fixed'
        ? 'next plan is unavailable (archived, disabled, or the lead already ran it)'
        : 'no candidate plan the lead has not already been through';
    return record({ routed_run_id: null, reason: why });
  }

  let chosen: Candidate | null = null;
  let reason: string;
  if (rule.mode === 'fixed') {
    chosen = candidates[0]!;
    reason = `fixed rule: continue in "${chosen.row.name}"`;
  } else {
    const history = await loadLeadHistory(db, run.leadId);
    const choice = history ? await chooseWithModel(deps, renderLeadHistory(history), candidates) : null;
    if (choice) {
      chosen = choice.sequence_id ? (candidates.find((c) => c.row.id === choice.sequence_id) ?? null) : null;
      reason = `smart: ${choice.reason}`;
    } else {
      // Deterministic fallback: never dead-end a plan on a missing key or a model error.
      chosen = candidates[0]!;
      reason = `fallback: ${deps.ai.apiKey ? 'router unavailable' : 'AI not configured'}, first unseen candidate "${chosen.row.name}"`;
    }
  }

  if (!chosen) return record({ routed_run_id: null, reason });

  const next = chosen.row;
  const leadId = run.leadId;
  const nextRunId = await db.transaction((tx) =>
    createRunForWorkflow(tx, next, { orgId: run.orgId, triggerSource: 'manual', triggerEventId: leadId, leadId }),
  );
  if (!nextRunId) return record({ routed_run_id: null, reason: `${reason}; lead was already enrolled there` });

  await writeAudit(db, {
    orgId: run.orgId,
    actorType: 'system',
    actorId: `workflow:${workflow.id}`,
    action: 'sequence.route',
    objectType: 'workflow',
    objectId: next.id,
    metadata: { from_run_id: run.id, to_run_id: nextRunId, lead_id: leadId, mode: rule.mode, reason },
  });
  deps.logger.info({ runId: run.id, nextRunId, nextWorkflowId: next.id, mode: rule.mode }, 'sequence routed');
  return record({ routed_run_id: nextRunId, reason });
}
