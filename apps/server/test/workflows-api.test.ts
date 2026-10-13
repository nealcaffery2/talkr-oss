/**
 * Phase 7 API surface (docs/workflows.md §8-9): workflow CRUD validation
 * (unknown/reserved types rejected at write time), RBAC (rep cannot manage
 * workflows), audit rows, run-history endpoints, and the tasks API with
 * assignee-vs-manager visibility.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { authHeader, createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;
let adminAuth: Record<string, string>;
let repAuth: Record<string, string>;

beforeAll(async () => {
  ctx = await createTestContext();
  adminAuth = await authHeader('auth-admin-test-org');
  repAuth = await authHeader('auth-rep-test-org');
});
afterAll(async () => {
  await ctx.close();
});

const VALID = {
  name: 'valid workflow',
  trigger_type: 'lead.created',
  actions: [{ type: 'update_lead_status', status: 'working' }],
};

describe('workflow CRUD validation', () => {
  it('rejects unknown action types at write time with a clear error', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/workflows',
      headers: adminAuth,
      payload: { ...VALID, actions: [{ type: 'launch_missiles' }] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('unknown_action_type');
    expect(await ctx.dbh.db.select().from(schema.workflows)).toHaveLength(0); // nothing stored
  });

  it('accepts add_to_campaign (executable since the Phase 5 merge; campaign_id must be a uuid)', async () => {
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/v1/workflows',
      headers: adminAuth,
      payload: { ...VALID, actions: [{ type: 'add_to_campaign', campaign_id: 'x' }] },
    });
    expect(bad.statusCode).toBe(400); // not a uuid

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/workflows',
      headers: adminAuth,
      payload: {
        ...VALID,
        actions: [
          { type: 'add_to_campaign', campaign_id: '3f0e8a52-7f0e-4c3a-9b1d-2a6c5e4d8f01' },
        ],
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects unknown trigger types and unknown condition ops', async () => {
    const badTrigger = await ctx.app.inject({
      method: 'POST',
      url: '/v1/workflows',
      headers: adminAuth,
      payload: { ...VALID, trigger_type: 'call.exploded' },
    });
    expect(badTrigger.statusCode).toBe(400);

    const badOp = await ctx.app.inject({
      method: 'POST',
      url: '/v1/workflows',
      headers: adminAuth,
      payload: {
        ...VALID,
        conditions: { all: [{ field: 'lead.status', op: 'matches', value: 'x' }] },
      },
    });
    expect(badOp.statusCode).toBe(400);
    expect((badOp.json() as { error: string }).error).toBe('invalid_body');
  });

  it('requires trigger_config.days for no_contact_for_days', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/workflows',
      headers: adminAuth,
      payload: { ...VALID, trigger_type: 'no_contact_for_days' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_trigger_config');
  });

  it('creates, lists with run counts, and audits enable/disable', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/v1/workflows',
      headers: adminAuth,
      payload: VALID,
    });
    expect(created.statusCode).toBe(201);
    const wf = (created.json() as { workflow: { id: string; enabled: boolean; max_runs_per_lead_per_day: number; max_runs_per_day: number } }).workflow;
    expect(wf.enabled).toBe(true);
    expect(wf.max_runs_per_lead_per_day).toBe(3); // documented defaults
    expect(wf.max_runs_per_day).toBe(500);

    const audit = await ctx.dbh.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'workflow.create'), eq(schema.auditLog.objectId, wf.id)));
    expect(audit).toHaveLength(1);

    const list = await ctx.app.inject({ method: 'GET', url: '/v1/workflows', headers: adminAuth });
    const listed = (list.json() as { workflows: Array<{ id: string; run_counts: { total: number } }> }).workflows;
    expect(listed.find((w) => w.id === wf.id)!.run_counts.total).toBe(0);

    const off = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/workflows/${wf.id}`,
      headers: adminAuth,
      payload: { enabled: false },
    });
    expect(off.statusCode).toBe(200);
    expect((off.json() as { workflow: { enabled: boolean } }).workflow.enabled).toBe(false);
    const disableAudit = await ctx.dbh.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'workflow.disable'), eq(schema.auditLog.objectId, wf.id)));
    expect(disableAudit).toHaveLength(1);

    const on = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/workflows/${wf.id}`,
      headers: adminAuth,
      payload: { enabled: true },
    });
    expect(on.statusCode).toBe(200);
    const enableAudit = await ctx.dbh.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'workflow.enable'), eq(schema.auditLog.objectId, wf.id)));
    expect(enableAudit).toHaveLength(1);

    // Runs endpoint 404s for a workflow that does not exist in this org.
    const missing = await ctx.app.inject({
      method: 'GET',
      url: '/v1/workflows/00000000-0000-0000-0000-000000000123/runs',
      headers: adminAuth,
    });
    expect(missing.statusCode).toBe(404);
  });

  it('RBAC: a rep cannot manage or read workflows', async () => {
    for (const [method, url] of [
      ['POST', '/v1/workflows'],
      ['GET', '/v1/workflows'],
      ['GET', '/v1/workflow-runs'],
    ] as const) {
      const res = await ctx.app.inject({
        method,
        url,
        headers: repAuth,
        ...(method === 'POST' ? { payload: VALID } : {}),
      });
      expect(res.statusCode).toBe(403);
    }
  });
});

describe('tasks API', () => {
  let repTaskId: string;
  let adminTaskId: string;

  it('a rep creates a manual task defaulting to self-assignment', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: repAuth,
      payload: { title: 'Call Sally back', lead_id: ctx.seed.leadId },
    });
    expect(res.statusCode).toBe(201);
    const task = (res.json() as { task: { id: string; assigned_user_id: string; source: string } }).task;
    expect(task.assigned_user_id).toBe(ctx.seed.repId);
    expect(task.source).toBe('manual');
    repTaskId = task.id;
  });

  it('managers can assign tasks to others; reps see own + unassigned only', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: adminAuth,
      payload: {
        title: 'Admin-only review',
        assigned_user_id: ctx.seed.adminId,
        due_at: new Date(Date.now() + 3_600_000).toISOString(),
      },
    });
    expect(res.statusCode).toBe(201);
    adminTaskId = (res.json() as { task: { id: string } }).task.id;

    const repList = await ctx.app.inject({ method: 'GET', url: '/v1/tasks', headers: repAuth });
    const repTasks = (repList.json() as { tasks: Array<{ id: string }> }).tasks;
    expect(repTasks.some((t) => t.id === repTaskId)).toBe(true);
    expect(repTasks.some((t) => t.id === adminTaskId)).toBe(false); // not mine

    const adminList = await ctx.app.inject({ method: 'GET', url: '/v1/tasks', headers: adminAuth });
    const adminTasks = (adminList.json() as { tasks: Array<{ id: string }> }).tasks;
    expect(adminTasks.some((t) => t.id === repTaskId)).toBe(true); // org scope
    expect(adminTasks.some((t) => t.id === adminTaskId)).toBe(true);
  });

  it('filters by lead and orders open-first', async () => {
    const byLead = await ctx.app.inject({
      method: 'GET',
      url: `/v1/tasks?lead_id=${ctx.seed.leadId}`,
      headers: adminAuth,
    });
    const tasks = (byLead.json() as { tasks: Array<{ id: string; status: string }> }).tasks;
    expect(tasks.some((t) => t.id === repTaskId)).toBe(true);
    expect(tasks.every((t) => t.status === 'open' || tasks.indexOf(t) > 0)).toBe(true);
  });

  it('a rep cannot complete a task assigned to someone else; managers can', async () => {
    const denied = await ctx.app.inject({
      method: 'POST',
      url: `/v1/tasks/${adminTaskId}/complete`,
      headers: repAuth,
    });
    expect(denied.statusCode).toBe(403);

    const done = await ctx.app.inject({
      method: 'POST',
      url: `/v1/tasks/${adminTaskId}/complete`,
      headers: adminAuth,
    });
    expect(done.statusCode).toBe(200);
    const task = (done.json() as { task: { status: string; completed_at: string | null } }).task;
    expect(task.status).toBe('done');
    expect(task.completed_at).not.toBeNull();

    // Completing a non-open task conflicts.
    const again = await ctx.app.inject({
      method: 'POST',
      url: `/v1/tasks/${adminTaskId}/complete`,
      headers: adminAuth,
    });
    expect(again.statusCode).toBe(409);
  });

  it('the assignee completes and cancels their own tasks', async () => {
    const done = await ctx.app.inject({
      method: 'POST',
      url: `/v1/tasks/${repTaskId}/complete`,
      headers: repAuth,
    });
    expect(done.statusCode).toBe(200);

    const created = await ctx.app.inject({
      method: 'POST',
      url: '/v1/tasks',
      headers: repAuth,
      payload: { title: 'cancel me' },
    });
    const cancelId = (created.json() as { task: { id: string } }).task.id;
    const canceled = await ctx.app.inject({
      method: 'POST',
      url: `/v1/tasks/${cancelId}/cancel`,
      headers: repAuth,
    });
    expect(canceled.statusCode).toBe(200);
    expect((canceled.json() as { task: { status: string } }).task.status).toBe('canceled');
  });
});
