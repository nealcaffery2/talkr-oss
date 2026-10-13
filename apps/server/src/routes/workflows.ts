/**
 * Workflows + tasks API (Phase 7 — docs/workflows.md §8-9). Auth is provided
 * by the /v1 preHandler hook registered in registerV1Routes; register this
 * module after it in app.ts. Trigger/condition/action shapes are rejected at
 * write time — an unknown action or trigger never reaches the database.
 */

import { and, desc, eq, isNull, lt, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  RESERVED_WORKFLOW_ACTION_TYPES,
  WORKFLOW_ACTION_TYPES,
  WORKFLOW_TRIGGER_TYPES,
  validateWorkflowDefinition,
  workflowDefinitionSchema,
  type Permission,
} from '@talkr/core';
import { schema } from '@talkr/db';
import type { AppDeps } from '../app.js';
import { hasPermission } from '../auth.js';
import { writeAudit } from '../services/audit.js';

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

/**
 * Action-type pre-check so reserved names get a distinct, clear error
 * (`action_not_available`) instead of a generic zod failure, and unknown
 * names are named explicitly (`unknown_action_type`).
 */
function checkActionTypes(raw: unknown): { code: string; detail: Record<string, unknown> } | null {
  const actions = (raw as { actions?: unknown }).actions;
  if (!Array.isArray(actions)) return null; // let zod report the shape error
  for (const action of actions) {
    const type = (action as { type?: unknown })?.type;
    if (typeof type !== 'string') continue;
    if ((RESERVED_WORKFLOW_ACTION_TYPES as readonly string[]).includes(type)) {
      return {
        code: 'action_not_available',
        detail: { action: type, message: `${type} is reserved for the Phase 5 dialer integration` },
      };
    }
    if (!(WORKFLOW_ACTION_TYPES as readonly string[]).includes(type)) {
      return {
        code: 'unknown_action_type',
        detail: { action: type, known: WORKFLOW_ACTION_TYPES },
      };
    }
  }
  return null;
}

const updateWorkflowSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  enabled: z.boolean().optional(),
  trigger_type: z.enum(WORKFLOW_TRIGGER_TYPES).optional(),
  trigger_config: workflowDefinitionSchema.shape.trigger_config.optional(),
  conditions: workflowDefinitionSchema.shape.conditions.optional(),
  actions: workflowDefinitionSchema.shape.actions.optional(),
  max_runs_per_lead_per_day: z.number().int().min(1).max(100).optional(),
  max_runs_per_day: z.number().int().min(1).max(10_000).optional(),
});

const createTaskSchema = z.object({
  title: z.string().min(1).max(500),
  note: z.string().max(10_000).optional(),
  lead_id: z.string().uuid().optional(),
  assigned_user_id: z.string().uuid().optional(),
  due_at: z.coerce.date().optional(),
});

export function registerWorkflowRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { dbh } = deps;
  const manage = { preHandler: requirePermission('workflows.manage' as Permission) };

  // -------------------------------------------------------------------------
  // Workflow CRUD
  // -------------------------------------------------------------------------
  app.post('/v1/workflows', manage, async (req, reply) => {
    const ctx = req.authCtx!;
    const body = req.body ?? {};
    const typeError = checkActionTypes(body);
    if (typeError) return reply.code(400).send({ error: typeError.code, ...typeError.detail });
    const parsed = workflowDefinitionSchema.safeParse(body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const crossError = validateWorkflowDefinition(parsed.data);
    if (crossError) return reply.code(400).send({ error: 'invalid_trigger_config', message: crossError });

    const row = (
      await dbh.db
        .insert(schema.workflows)
        .values({
          orgId: ctx.orgId,
          name: parsed.data.name,
          enabled: parsed.data.enabled,
          kind: parsed.data.kind,
          triggerType: parsed.data.trigger_type,
          triggerConfig: parsed.data.trigger_config,
          conditions: parsed.data.conditions,
          actions: parsed.data.actions,
          exitRules: parsed.data.exit_rules,
          ...(parsed.data.max_runs_per_lead_per_day != null
            ? { maxRunsPerLeadPerDay: parsed.data.max_runs_per_lead_per_day }
            : {}),
          ...(parsed.data.max_runs_per_day != null
            ? { maxRunsPerDay: parsed.data.max_runs_per_day }
            : {}),
          createdBy: ctx.userId,
        })
        .returning()
    )[0]!;
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'workflow.create',
      objectType: 'workflow',
      objectId: row.id,
      metadata: { name: row.name, trigger_type: row.triggerType, enabled: row.enabled },
    });
    return reply.code(201).send({ workflow: serializeWorkflow(row) });
  });

  app.get('/v1/workflows', manage, async (req) => {
    const ctx = req.authCtx!;
    // Sequences share the table but have their own surface (/v1/sequences);
    // the Workflows page lists event automations only.
    const rows = await dbh.db
      .select()
      .from(schema.workflows)
      .where(and(eq(schema.workflows.orgId, ctx.orgId), eq(schema.workflows.kind, 'workflow')))
      .orderBy(desc(schema.workflows.createdAt));

    // Run counts per workflow (total + last 24h) for the list view.
    const counts = (
      await dbh.db.execute(sql`
        SELECT workflow_id,
               count(*)::int AS total,
               count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last_24h
        FROM workflow_runs
        WHERE org_id = ${ctx.orgId}
        GROUP BY workflow_id`)
    ).rows as Array<{ workflow_id: string; total: number; last_24h: number }>;
    const countById = new Map(counts.map((c) => [String(c.workflow_id), c]));
    return {
      workflows: rows.map((r) => ({
        ...serializeWorkflow(r),
        run_counts: {
          total: countById.get(r.id)?.total ?? 0,
          last_24h: countById.get(r.id)?.last_24h ?? 0,
        },
      })),
    };
  });

  app.get('/v1/workflows/:id', manage, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    const row = (
      await dbh.db
        .select()
        .from(schema.workflows)
        .where(and(eq(schema.workflows.id, id), eq(schema.workflows.orgId, ctx.orgId)))
        .limit(1)
    )[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { workflow: serializeWorkflow(row) };
  });

  app.patch('/v1/workflows/:id', manage, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    const body = req.body ?? {};
    const typeError = checkActionTypes(body);
    if (typeError) return reply.code(400).send({ error: typeError.code, ...typeError.detail });
    const parsed = updateWorkflowSchema.safeParse(body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const existing = (
      await dbh.db
        .select()
        .from(schema.workflows)
        .where(and(eq(schema.workflows.id, id), eq(schema.workflows.orgId, ctx.orgId)))
        .limit(1)
    )[0];
    if (!existing) return reply.code(404).send({ error: 'not_found' });

    const d = parsed.data;
    const update: Partial<typeof schema.workflows.$inferInsert> = { updatedAt: new Date() };
    if (d.name !== undefined) update.name = d.name;
    if (d.enabled !== undefined) update.enabled = d.enabled;
    if (d.trigger_type !== undefined) update.triggerType = d.trigger_type;
    if (d.trigger_config !== undefined) update.triggerConfig = d.trigger_config;
    if (d.conditions !== undefined) update.conditions = d.conditions;
    if (d.actions !== undefined) update.actions = d.actions;
    if (d.max_runs_per_lead_per_day !== undefined) update.maxRunsPerLeadPerDay = d.max_runs_per_lead_per_day;
    if (d.max_runs_per_day !== undefined) update.maxRunsPerDay = d.max_runs_per_day;

    // Cross-field validation over the merged definition.
    const merged = {
      name: update.name ?? existing.name,
      enabled: update.enabled ?? existing.enabled,
      kind: existing.kind,
      trigger_type: (update.triggerType ?? existing.triggerType) as (typeof WORKFLOW_TRIGGER_TYPES)[number],
      trigger_config: (update.triggerConfig ?? existing.triggerConfig) as { days?: number },
      conditions: null,
      actions: (update.actions ?? existing.actions) as never,
      exit_rules: null,
    };
    const crossError = validateWorkflowDefinition(merged as never);
    if (crossError) return reply.code(400).send({ error: 'invalid_trigger_config', message: crossError });

    const row = (
      await dbh.db
        .update(schema.workflows)
        .set(update)
        .where(and(eq(schema.workflows.id, id), eq(schema.workflows.orgId, ctx.orgId)))
        .returning()
    )[0]!;
    const action =
      d.enabled === undefined || d.enabled === existing.enabled
        ? 'workflow.update'
        : d.enabled
          ? 'workflow.enable'
          : 'workflow.disable';
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action,
      objectType: 'workflow',
      objectId: row.id,
      metadata: { name: row.name, enabled: row.enabled },
    });
    return { workflow: serializeWorkflow(row) };
  });

  // -------------------------------------------------------------------------
  // Run history (per workflow, paginated) + org-wide recent runs
  // -------------------------------------------------------------------------
  app.get('/v1/workflows/:id/runs', manage, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    const { limit: rawLimit, cursor } = req.query as { limit?: string; cursor?: string };
    const limit = Math.min(Math.max(Number(rawLimit) || 25, 1), 100);
    const workflow = (
      await dbh.db
        .select({ id: schema.workflows.id })
        .from(schema.workflows)
        .where(and(eq(schema.workflows.id, id), eq(schema.workflows.orgId, ctx.orgId)))
        .limit(1)
    )[0];
    if (!workflow) return reply.code(404).send({ error: 'not_found' });

    const where: SQL[] = [eq(schema.workflowRuns.workflowId, id)];
    if (cursor) {
      const before = new Date(cursor);
      if (Number.isNaN(before.getTime())) return reply.code(400).send({ error: 'invalid_cursor' });
      where.push(lt(schema.workflowRuns.createdAt, before));
    }
    const rows = await dbh.db
      .select()
      .from(schema.workflowRuns)
      .where(and(...where))
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(limit + 1);
    const page = rows.slice(0, limit);
    return {
      runs: page.map(serializeRun),
      next_cursor: rows.length > limit ? page[page.length - 1]!.createdAt.toISOString() : null,
    };
  });

  app.get('/v1/workflow-runs', manage, async (req) => {
    const ctx = req.authCtx!;
    const { limit: rawLimit } = req.query as { limit?: string };
    const limit = Math.min(Math.max(Number(rawLimit) || 50, 1), 200);
    const rows = await dbh.db
      .select()
      .from(schema.workflowRuns)
      .where(eq(schema.workflowRuns.orgId, ctx.orgId))
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(limit);
    return { runs: rows.map(serializeRun) };
  });

  // -------------------------------------------------------------------------
  // Tasks (docs/workflows.md §8): assignee + managers visibility
  // -------------------------------------------------------------------------
  app.get('/v1/tasks', { preHandler: requirePermission('tasks.read.own' as Permission) }, async (req) => {
    const ctx = req.authCtx!;
    const { lead_id, status, mine } = req.query as { lead_id?: string; status?: string; mine?: string };
    const seeOrg = hasPermission(ctx, 'tasks.read.org' as Permission);

    const where: SQL[] = [eq(schema.tasks.orgId, ctx.orgId)];
    if (!seeOrg || mine === 'true') {
      // Own scope: my tasks + unassigned ones (shared pool, like conversations).
      where.push(
        or(eq(schema.tasks.assignedUserId, ctx.userId), isNull(schema.tasks.assignedUserId))!,
      );
    }
    if (lead_id) where.push(eq(schema.tasks.leadId, lead_id));
    if (status) where.push(eq(schema.tasks.status, status));

    // Open first, then most urgent due date; closed tasks trail, newest first.
    const rows = await dbh.db
      .select()
      .from(schema.tasks)
      .where(and(...where))
      .orderBy(
        sql`CASE WHEN ${schema.tasks.status} = 'open' THEN 0 ELSE 1 END`,
        sql`${schema.tasks.dueAt} ASC NULLS LAST`,
        desc(schema.tasks.createdAt),
      )
      .limit(200);
    return { tasks: rows.map(serializeTask) };
  });

  app.post('/v1/tasks', { preHandler: requirePermission('tasks.write' as Permission) }, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = createTaskSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const d = parsed.data;
    if (d.lead_id) {
      const lead = (
        await dbh.db
          .select({ id: schema.leads.id })
          .from(schema.leads)
          .where(and(eq(schema.leads.id, d.lead_id), eq(schema.leads.orgId, ctx.orgId)))
          .limit(1)
      )[0];
      if (!lead) return reply.code(404).send({ error: 'not_found', message: 'lead not found' });
    }
    if (d.assigned_user_id) {
      const user = (
        await dbh.db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(and(eq(schema.users.id, d.assigned_user_id), eq(schema.users.orgId, ctx.orgId)))
          .limit(1)
      )[0];
      if (!user) return reply.code(404).send({ error: 'not_found', message: 'assignee not found' });
    }
    const row = (
      await dbh.db
        .insert(schema.tasks)
        .values({
          orgId: ctx.orgId,
          leadId: d.lead_id ?? null,
          assignedUserId: d.assigned_user_id ?? ctx.userId,
          title: d.title,
          note: d.note ?? null,
          dueAt: d.due_at ?? null,
          source: 'manual',
          createdBy: ctx.userId,
        })
        .returning()
    )[0]!;
    return reply.code(201).send({ task: serializeTask(row) });
  });

  for (const verb of ['complete', 'cancel'] as const) {
    app.post(
      `/v1/tasks/:id/${verb}`,
      { preHandler: requirePermission('tasks.write' as Permission) },
      async (req, reply) => {
        const ctx = req.authCtx!;
        const { id } = req.params as { id: string };
        const task = (
          await dbh.db
            .select()
            .from(schema.tasks)
            .where(and(eq(schema.tasks.id, id), eq(schema.tasks.orgId, ctx.orgId)))
            .limit(1)
        )[0];
        if (!task) return reply.code(404).send({ error: 'not_found' });
        const seeOrg = hasPermission(ctx, 'tasks.read.org' as Permission);
        if (!seeOrg && task.assignedUserId != null && task.assignedUserId !== ctx.userId) {
          return reply.code(403).send({ error: 'forbidden' });
        }
        if (task.status !== 'open') {
          return reply.code(409).send({ error: 'not_open', status: task.status });
        }
        const row = (
          await dbh.db
            .update(schema.tasks)
            .set({
              status: verb === 'complete' ? 'done' : 'canceled',
              completedAt: verb === 'complete' ? new Date() : null,
              updatedAt: new Date(),
            })
            .where(eq(schema.tasks.id, id))
            .returning()
        )[0]!;
        return { task: serializeTask(row) };
      },
    );
  }
}

export function serializeWorkflow(row: typeof schema.workflows.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    kind: row.kind,
    description: row.description,
    trigger_type: row.triggerType,
    trigger_config: row.triggerConfig,
    conditions: row.conditions,
    actions: row.actions,
    exit_rules: row.exitRules,
    max_runs_per_lead_per_day: row.maxRunsPerLeadPerDay,
    max_runs_per_day: row.maxRunsPerDay,
    archived_at: row.archivedAt,
    created_by: row.createdBy,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

export function serializeRun(row: typeof schema.workflowRuns.$inferSelect) {
  return {
    id: row.id,
    workflow_id: row.workflowId,
    trigger_source: row.triggerSource,
    trigger_event_id: row.triggerEventId,
    lead_id: row.leadId,
    status: row.status,
    matched: row.matched,
    skip_reason: row.skipReason,
    action_results: row.actionResults,
    error: row.error,
    current_action_index: row.currentActionIndex,
    resume_at: row.resumeAt,
    stopped_reason: row.stoppedReason,
    started_at: row.startedAt,
    finished_at: row.finishedAt,
    created_at: row.createdAt,
  };
}

function serializeTask(row: typeof schema.tasks.$inferSelect) {
  return {
    id: row.id,
    lead_id: row.leadId,
    assigned_user_id: row.assignedUserId,
    title: row.title,
    note: row.note,
    due_at: row.dueAt,
    status: row.status,
    source: row.source,
    workflow_id: row.workflowId,
    created_by: row.createdBy,
    created_at: row.createdAt,
    completed_at: row.completedAt,
  };
}
