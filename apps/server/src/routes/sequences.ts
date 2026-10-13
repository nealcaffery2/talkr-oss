/**
 * Sequences API (docs/sequences.md §2, §7): the builder's CRUD over workflow
 * rows of kind 'sequence', enrollment, and the AI draft endpoint. Same
 * permission as workflows (`workflows.manage`); auth comes from the /v1
 * preHandler hook registered in registerV1Routes, so this module is
 * registered after it in app.ts.
 *
 * The builder speaks in steps (sms / wait / task / status); the engine speaks
 * in actions. Translation happens here at write time and read time
 * (stepsToActions / actionsToSteps in @talkr/core) so the stored row is a
 * plain workflow the existing engine, run history and tests understand.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  actionsToSteps,
  exitRulesSchema,
  onCompleteSchema,
  validateOnComplete,
  sequenceDurationMinutes,
  sequenceStepsSchema,
  sequenceTimeline,
  stepsToActions,
  validateSequenceSteps,
  validateWorkflowDefinition,
  type Permission,
  type SequenceStep,
} from '@talkr/core';
import { schema } from '@talkr/db';
import type { AppDeps } from '../app.js';
import { hasPermission } from '../auth.js';
import { builderModel } from '../config.js';
import { writeAudit } from '../services/audit.js';
import { draftSequenceWithAi, SequenceAiError } from '../services/sequence-ai.js';
import {
  countActiveRuns,
  emptyStats,
  enrollInSequence,
  listSequenceRuns,
  MAX_ENROLL_BATCH,
  sequenceStats,
  stopRuns,
  unenrollFromSequence,
  type SequenceRunRow,
  type SequenceStats,
} from '../services/sequences.js';

function requirePermission(permission: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = req.authCtx;
    if (!ctx) return reply.code(401).send({ error: 'unauthenticated' });
    if (!hasPermission(ctx, permission)) {
      req.log.info({ userId: ctx.userId, permission }, 'permission denied');
      return reply.code(403).send({ error: 'forbidden', permission });
    }
  };
}

const createSequenceSchema = z.object({
  name: z.string().trim().min(1).max(200),
  description: z.string().trim().max(1000).nullable().optional(),
  steps: sequenceStepsSchema,
  exit_rules: exitRulesSchema.nullable().optional(),
  /** Completion routing (docs/sequences.md §12); null or mode "none" = the lead leaves the plan. */
  on_complete: onCompleteSchema.nullable().optional(),
  enabled: z.boolean().optional().default(true),
});

const updateSequenceSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(1000).nullable().optional(),
  steps: sequenceStepsSchema.optional(),
  exit_rules: exitRulesSchema.nullable().optional(),
  on_complete: onCompleteSchema.nullable().optional(),
  enabled: z.boolean().optional(),
});

const idList = z.array(z.string().uuid()).max(MAX_ENROLL_BATCH);

const enrollSchema = z
  .object({
    lead_ids: idList.optional(),
    contact_ids: idList.optional(),
    /** Raw phone numbers; resolved to contacts by E.164 (docs/sequences.md §2). */
    phones: z.array(z.string().trim().min(3).max(40)).max(MAX_ENROLL_BATCH).optional(),
  })
  .refine(
    (b) => (b.lead_ids?.length ?? 0) + (b.contact_ids?.length ?? 0) + (b.phones?.length ?? 0) > 0,
    { message: 'provide lead_ids, contact_ids or phones' },
  )
  .refine(
    (b) => (b.lead_ids?.length ?? 0) + (b.contact_ids?.length ?? 0) + (b.phones?.length ?? 0) <= MAX_ENROLL_BATCH,
    { message: `at most ${MAX_ENROLL_BATCH} leads per enroll call` },
  );

const unenrollSchema = z.object({
  lead_ids: z.array(z.string().uuid()).min(1).max(MAX_ENROLL_BATCH),
});

const draftSchema = z.object({
  goal: z.string().trim().min(10).max(600),
  audience: z.string().trim().max(300).nullable().optional(),
  tone: z.enum(['friendly', 'direct', 'professional']).optional().default('friendly'),
  channel: z.literal('sms').optional().default('sms'),
  steps: z.number().int().min(2).max(8),
  days: z.number().int().min(1).max(60),
  company_name: z.string().trim().min(1).max(120).nullable().optional(),
});

type WorkflowRow = typeof schema.workflows.$inferSelect;

export function registerSequenceRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { dbh } = deps;
  const manage = { preHandler: requirePermission('workflows.manage' as Permission) };

  /** A live (non-archived) sequence of this org, or null. */
  async function loadSequence(orgId: string, id: string): Promise<WorkflowRow | null> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
    return (
      (
        await dbh.db
          .select()
          .from(schema.workflows)
          .where(
            and(
              eq(schema.workflows.id, id),
              eq(schema.workflows.orgId, orgId),
              eq(schema.workflows.kind, 'sequence'),
              isNull(schema.workflows.archivedAt),
            ),
          )
          .limit(1)
      )[0] ?? null
    );
  }

  /**
   * A routing rule's targets must be live sequences of this org. Returns an
   * error string or null. The self-reference check needs the row id, so a
   * create validates the shape here and the self rule at update time.
   */
  async function checkOnComplete(
    orgId: string,
    rule: z.infer<typeof onCompleteSchema> | null | undefined,
    selfId: string | null,
  ): Promise<string | null> {
    const shape = validateOnComplete(rule, selfId);
    if (shape) return shape;
    if (!rule || rule.mode === 'none') return null;
    const targets = rule.mode === 'fixed' ? [rule.sequence_id!] : rule.candidate_ids;
    if (targets.length === 0) return null;
    const found = await dbh.db
      .select({ id: schema.workflows.id })
      .from(schema.workflows)
      .where(
        and(
          eq(schema.workflows.orgId, orgId),
          eq(schema.workflows.kind, 'sequence'),
          isNull(schema.workflows.archivedAt),
          inArray(schema.workflows.id, targets),
        ),
      );
    const ok = new Set(found.map((r) => r.id));
    const missing = targets.filter((t) => !ok.has(t));
    return missing.length > 0 ? `on_complete: unknown sequence ${missing.join(', ')}` : null;
  }

  /** Steps → validated actions, or a 400 body. */
  function compileSteps(steps: SequenceStep[]): { actions: ReturnType<typeof stepsToActions> } | { error: string } {
    const stepError = validateSequenceSteps(steps);
    if (stepError) return { error: stepError };
    return { actions: stepsToActions(steps) };
  }

  // -------------------------------------------------------------------------
  // List + create
  // -------------------------------------------------------------------------
  app.get('/v1/sequences', manage, async (req) => {
    const ctx = req.authCtx!;
    const rows = await dbh.db
      .select()
      .from(schema.workflows)
      .where(
        and(
          eq(schema.workflows.orgId, ctx.orgId),
          eq(schema.workflows.kind, 'sequence'),
          isNull(schema.workflows.archivedAt),
        ),
      )
      .orderBy(schema.workflows.createdAt);
    const stats = await sequenceStats(dbh.db, ctx.orgId);
    return {
      sequences: rows.map((r) => serializeSequence(r, stats.get(r.id) ?? emptyStats())),
    };
  });

  app.post('/v1/sequences', manage, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = createSequenceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const compiled = compileSteps(parsed.data.steps);
    if ('error' in compiled) return reply.code(400).send({ error: 'invalid_steps', message: compiled.error });
    const exitRules = parsed.data.exit_rules ?? null;
    const crossError = validateWorkflowDefinition({
      name: parsed.data.name,
      enabled: parsed.data.enabled,
      kind: 'sequence',
      trigger_type: 'manual',
      trigger_config: {},
      conditions: null,
      actions: compiled.actions,
      exit_rules: exitRules,
    });
    if (crossError) return reply.code(400).send({ error: 'invalid_steps', message: crossError });
    const onComplete = parsed.data.on_complete?.mode && parsed.data.on_complete.mode !== 'none' ? parsed.data.on_complete : null;
    const routeError = await checkOnComplete(ctx.orgId, onComplete, null);
    if (routeError) return reply.code(400).send({ error: 'invalid_routing', message: routeError });

    const row = (
      await dbh.db
        .insert(schema.workflows)
        .values({
          orgId: ctx.orgId,
          name: parsed.data.name,
          description: parsed.data.description ?? null,
          enabled: parsed.data.enabled,
          kind: 'sequence',
          triggerType: 'manual',
          triggerConfig: {},
          conditions: null,
          actions: compiled.actions,
          exitRules,
          onComplete,
          createdBy: ctx.userId,
        })
        .returning()
    )[0]!;
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'sequence.create',
      objectType: 'workflow',
      objectId: row.id,
      metadata: { name: row.name, steps: parsed.data.steps.length, enabled: row.enabled },
    });
    return reply.code(201).send({ sequence: serializeSequence(row, emptyStats()) });
  });

  // -------------------------------------------------------------------------
  // One sequence: definition + stats + recent runs
  // -------------------------------------------------------------------------
  app.get('/v1/sequences/:id', manage, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    const row = await loadSequence(ctx.orgId, id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    const [stats, runs] = await Promise.all([
      sequenceStats(dbh.db, ctx.orgId, row.id),
      listSequenceRuns(dbh.db, row.id, 50),
    ]);
    const steps = actionsToSteps(Array.isArray(row.actions) ? row.actions : []);
    return {
      sequence: serializeSequence(row, stats.get(row.id) ?? emptyStats()),
      runs: runs.map((r) => serializeSequenceRun(r, steps)),
    };
  });

  app.patch('/v1/sequences/:id', manage, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    const parsed = updateSequenceSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const existing = await loadSequence(ctx.orgId, id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    const d = parsed.data;
    const update: Partial<typeof schema.workflows.$inferInsert> = { updatedAt: new Date() };
    if (d.name !== undefined) update.name = d.name;
    if (d.description !== undefined) update.description = d.description;
    if (d.enabled !== undefined) update.enabled = d.enabled;
    if (d.exit_rules !== undefined) update.exitRules = d.exit_rules;
    if (d.on_complete !== undefined) {
      const onComplete = d.on_complete?.mode && d.on_complete.mode !== 'none' ? d.on_complete : null;
      const routeError = await checkOnComplete(ctx.orgId, onComplete, existing.id);
      if (routeError) return reply.code(400).send({ error: 'invalid_routing', message: routeError });
      update.onComplete = onComplete;
    }
    if (d.steps !== undefined) {
      const compiled = compileSteps(d.steps);
      if ('error' in compiled) return reply.code(400).send({ error: 'invalid_steps', message: compiled.error });
      const changed = JSON.stringify(compiled.actions) !== JSON.stringify(existing.actions);
      if (changed) {
        // Runs remember where they are by action index; re-ordering the list
        // under a parked run would make it continue at the wrong step.
        const active = await countActiveRuns(dbh.db, existing.id);
        if (active > 0) {
          return reply.code(409).send({
            error: 'runs_active',
            active_runs: active,
            message: `${active} lead${active === 1 ? ' is' : 's are'} still in this sequence. Unenroll them (or wait for them to finish) before changing the steps.`,
          });
        }
        update.actions = compiled.actions;
      }
    }
    const crossError = validateWorkflowDefinition({
      name: update.name ?? existing.name,
      enabled: update.enabled ?? existing.enabled,
      kind: 'sequence',
      trigger_type: 'manual',
      trigger_config: {},
      conditions: null,
      actions: (update.actions ?? existing.actions) as never,
      exit_rules: null,
    });
    if (crossError) return reply.code(400).send({ error: 'invalid_steps', message: crossError });

    const row = (
      await dbh.db
        .update(schema.workflows)
        .set(update)
        .where(eq(schema.workflows.id, existing.id))
        .returning()
    )[0]!;
    const action =
      d.enabled === undefined || d.enabled === existing.enabled
        ? 'sequence.update'
        : d.enabled
          ? 'sequence.enable'
          : 'sequence.disable';
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action,
      objectType: 'workflow',
      objectId: row.id,
      metadata: { name: row.name, enabled: row.enabled, changed: Object.keys(d) },
    });
    const stats = await sequenceStats(dbh.db, ctx.orgId, row.id);
    return { sequence: serializeSequence(row, stats.get(row.id) ?? emptyStats()) };
  });

  /** Archive: hidden from the list, enrolls nobody, every active run stopped. */
  app.delete('/v1/sequences/:id', manage, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    const existing = await loadSequence(ctx.orgId, id);
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    const stopped = await dbh.db.transaction(async (tx) => {
      await tx
        .update(schema.workflows)
        .set({ enabled: false, archivedAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.workflows.id, existing.id));
      return stopRuns(tx, existing.id, 'sequence_archived');
    });
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'sequence.archive',
      objectType: 'workflow',
      objectId: existing.id,
      metadata: { name: existing.name, runs_stopped: stopped },
    });
    return { ok: true, runs_stopped: stopped };
  });

  // -------------------------------------------------------------------------
  // Enrollment
  // -------------------------------------------------------------------------
  app.post('/v1/sequences/:id/enroll', manage, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    const parsed = enrollSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const sequence = await loadSequence(ctx.orgId, id);
    if (!sequence) return reply.code(404).send({ error: 'not_found' });
    if (!sequence.enabled) {
      return reply.code(409).send({
        error: 'sequence_disabled',
        message: 'Enable the sequence before enrolling leads into it.',
      });
    }
    const result = await enrollInSequence(dbh, ctx, sequence, {
      leadIds: [...new Set(parsed.data.lead_ids ?? [])],
      contactIds: [...new Set(parsed.data.contact_ids ?? [])],
      phones: [...new Set(parsed.data.phones ?? [])],
    });
    return result;
  });

  app.post('/v1/sequences/:id/unenroll', manage, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    const parsed = unenrollSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const sequence = await loadSequence(ctx.orgId, id);
    if (!sequence) return reply.code(404).send({ error: 'not_found' });
    const stopped = await unenrollFromSequence(dbh, ctx, sequence, [...new Set(parsed.data.lead_ids)]);
    return { stopped };
  });

  // -------------------------------------------------------------------------
  // AI builder (docs/sequences.md §7)
  // -------------------------------------------------------------------------
  app.post('/v1/ai/sequence-draft', manage, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = draftSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const apiKey = deps.config.ANTHROPIC_API_KEY?.trim();
    if (!apiKey) {
      return reply.code(503).send({
        error: 'ai_not_configured',
        message: 'Drafting with AI needs ANTHROPIC_API_KEY on the server. Build the sequence by hand, or ask an admin to add the key.',
      });
    }
    const org = (
      await dbh.db
        .select({ name: schema.organizations.name })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, ctx.orgId))
        .limit(1)
    )[0];
    const companyName = parsed.data.company_name?.trim() || org?.name || 'our team';
    const model = builderModel(deps.config);
    try {
      const result = await draftSequenceWithAi({
        apiKey,
        model,
        request: {
          goal: parsed.data.goal,
          audience: parsed.data.audience ?? null,
          tone: parsed.data.tone,
          channel: 'sms',
          steps: parsed.data.steps,
          days: parsed.data.days,
        },
        context: { companyName, repName: ctx.displayName },
        logger: deps.logger,
        fetchImpl: deps.fetchImpl,
      });
      req.log.info(
        { userId: ctx.userId, model: result.model, usage: result.usage, steps: result.draft.steps.length },
        'ai sequence draft',
      );
      await writeAudit(dbh.db, {
        orgId: ctx.orgId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'sequence.ai_draft',
        objectType: 'workflow',
        metadata: { model: result.model, usage: result.usage, steps: result.draft.steps.length },
      });
      return {
        draft: {
          ...result.draft,
          timeline: sequenceTimeline(result.draft.steps).map((t) => ({ index: t.index, day: t.day })),
          duration_minutes: sequenceDurationMinutes(result.draft.steps),
        },
        warnings: result.warnings,
        model: result.model,
        usage: result.usage,
      };
    } catch (err) {
      if (err instanceof SequenceAiError) {
        req.log.warn({ code: err.code, details: err.details, model }, 'ai sequence draft failed');
        return reply.code(502).send({ error: err.code, message: err.message, details: err.details });
      }
      req.log.error({ err, model }, 'ai sequence draft failed');
      return reply.code(502).send({
        error: 'ai_upstream',
        message: 'The AI service did not answer. Try again in a moment.',
      });
    }
  });
}

function serializeSequence(row: WorkflowRow, stats: SequenceStats) {
  const steps = actionsToSteps(Array.isArray(row.actions) ? row.actions : []);
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    enabled: row.enabled,
    steps,
    exit_rules: row.exitRules ?? null,
    on_complete: row.onComplete ?? null,
    /** Non-wait steps with the day they fire on — the list's "Day 0 / 2 / 5" line. */
    timeline: sequenceTimeline(steps).map((t) => ({ index: t.index, day: t.day, type: t.step.type })),
    duration_minutes: sequenceDurationMinutes(steps),
    sms_count: steps.filter((s) => s.type === 'sms').length,
    agent_count: steps.filter((s) => s.type === 'agent').length,
    stats,
    created_by: row.createdBy,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

function serializeSequenceRun(r: SequenceRunRow, steps: SequenceStep[]) {
  const { run } = r;
  // The action list and the step list are index-aligned (one action per step).
  const stepNumber = Math.min(run.currentActionIndex, Math.max(steps.length - 1, 0)) + 1;
  return {
    id: run.id,
    lead_id: run.leadId,
    lead_name: r.leadName?.trim() || null,
    phone: r.phone,
    lead_status: r.leadStatus,
    status: run.status,
    step: run.status === 'succeeded' ? steps.length : stepNumber,
    step_count: steps.length,
    current_action_index: run.currentActionIndex,
    resume_at: run.resumeAt,
    stopped_reason: run.stoppedReason,
    routed_run_id: run.routedRunId ?? null,
    routed_reason: run.routedReason ?? null,
    skip_reason: run.skipReason,
    error: run.error,
    action_results: run.actionResults,
    started_at: run.startedAt,
    finished_at: run.finishedAt,
    created_at: run.createdAt,
  };
}
