/**
 * Agent steps and completion routing (docs/sequences.md §11-12), through the
 * real sequence API, the real engine and the real Phase 4 send path, with
 * the Messages API replaced by a fake that answers structured plans. Pins:
 * an agent step sends exactly what the model planned (rendered merge
 * fields), creates its task exactly-once, refuses capabilities the step did
 * not allow, and a finished run routes its lead into the next sequence once,
 * recording why; a plan that names nothing routes nobody.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { authHeader, createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;
let adminAuth: Record<string, string>;
const ALWAYS_OPEN = { timezone: 'UTC', smsSendWindowStart: '00:00', smsSendWindowEnd: '00:00' };

/** What the fake model answers next, keyed by the schema it is asked for. */
const fake = {
  plan: { summary: 'Quiet since the first call; one gentle nudge.', sms_body: 'Hi {first_name}, {rep_name} here. Still thinking about {address}?', task_title: 'Call {first_name} if no reply', task_due_in_days: 2, lead_status: null } as Record<string, unknown>,
  choice: { sequence_id: null as string | null, reason: 'default' },
  calls: [] as Array<{ kind: 'plan' | 'choice'; body: Record<string, unknown> }>,
};

const fakeFetch: typeof fetch = async (url, init) => {
  if (!String(url).includes('api.anthropic.com')) return new Response('unexpected fetch in test', { status: 599 });
  const body = JSON.parse(String(init?.body)) as { output_config: { format: { schema: { properties: Record<string, unknown> } } } };
  const isPlan = 'sms_body' in body.output_config.format.schema.properties;
  fake.calls.push({ kind: isPlan ? 'plan' : 'choice', body: body as never });
  const answer = isPlan ? fake.plan : fake.choice;
  return new Response(
    JSON.stringify({ model: 'claude-test', stop_reason: 'end_turn', content: [{ type: 'text', text: JSON.stringify(answer) }], usage: { input_tokens: 1, output_tokens: 1 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
};

let leadSeq = 0;
async function createLead(name: string): Promise<{ leadId: string; phone: string }> {
  const phone = `+1500555${String(1000 + ++leadSeq).padStart(4, '0')}`;
  const contact = (await ctx.dbh.db.insert(schema.contacts).values({ orgId: ctx.seed.orgId, displayName: name }).returning())[0]!;
  await ctx.dbh.db.insert(schema.contactPhones).values({ orgId: ctx.seed.orgId, contactId: contact.id, phoneE164: phone, isPrimary: true });
  const property = (await ctx.dbh.db.insert(schema.properties).values({ orgId: ctx.seed.orgId, addressLine1: '12 Elm St', city: 'Tampa', state: 'FL' }).returning())[0]!;
  const lead = (
    await ctx.dbh.db
      .insert(schema.leads)
      .values({ orgId: ctx.seed.orgId, status: 'new', source: 'test', primaryContactId: contact.id, propertyId: property.id, assignedUserId: ctx.seed.repId, receivedAt: new Date() })
      .returning()
  )[0]!;
  return { leadId: lead.id, phone };
}

async function createSequence(payload: Record<string, unknown>): Promise<string> {
  const res = await ctx.app.inject({ method: 'POST', url: '/v1/sequences', headers: adminAuth, payload });
  expect(res.statusCode, res.body).toBe(201);
  return (res.json() as { sequence: { id: string } }).sequence.id;
}

async function enroll(sequenceId: string, leadId: string) {
  const res = await ctx.app.inject({ method: 'POST', url: `/v1/sequences/${sequenceId}/enroll`, headers: adminAuth, payload: { lead_ids: [leadId] } });
  expect(res.statusCode, res.body).toBe(200);
  await ctx.runner.drain();
}

async function runFor(sequenceId: string, leadId: string) {
  return (
    await ctx.dbh.db
      .select()
      .from(schema.workflowRuns)
      .where(and(eq(schema.workflowRuns.workflowId, sequenceId), eq(schema.workflowRuns.leadId, leadId)))
  )[0] ?? null;
}

beforeAll(async () => {
  ctx = await createTestContext({ config: { ANTHROPIC_API_KEY: 'test-key', AI_AGENT_MODEL: 'claude-test' }, fetchImpl: fakeFetch });
  adminAuth = await authHeader('auth-admin-test-org');
  await ctx.dbh.db.update(schema.organizations).set({ settings: ALWAYS_OPEN }).where(eq(schema.organizations.id, ctx.seed.orgId));
});
afterAll(async () => {
  await ctx.close();
});

describe('agent step', () => {
  it('sends the planned text with merge fields rendered, creates the task once, and records the plan', async () => {
    const { leadId, phone } = await createLead('Renata Vasquez');
    const seq = await createSequence({
      name: 'Agent nudge',
      steps: [{ type: 'agent', goal: 'Re-engage a seller who went quiet after the first call', allowed: ['send_sms', 'create_task'] }],
    });
    await enroll(seq, leadId);

    const run = await runFor(seq, leadId);
    expect(run?.status).toBe('succeeded');
    const result = (run!.actionResults as Array<{ type: string; status: string; detail: Record<string, unknown> }>)[0]!;
    expect(result.type).toBe('ai_agent');
    expect(result.status).toBe('succeeded');
    expect(result.detail.summary).toMatch(/gentle nudge/);
    expect(result.detail.model).toBe('claude-test');

    const sent = await ctx.dbh.db.select().from(schema.messages).where(eq(schema.messages.direction, 'outbound'));
    const mine = sent.find((m) => m.body?.includes('12 Elm St'));
    expect(mine?.body).toBe('Hi Renata, Riley Rep here. Still thinking about 12 Elm St?');
    expect((result.detail.executed as { message_id: string }).message_id).toBe(mine!.id);

    const tasks = await ctx.dbh.db.select().from(schema.tasks).where(eq(schema.tasks.workflowRunId, run!.id));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.title).toBe('Call {first_name} if no reply');
    expect(tasks[0]!.assignedUserId).toBe(ctx.seed.repId);
    expect(tasks[0]!.note).toMatch(/gentle nudge/);

    // The brief the model saw carried the lead's history, not just the goal.
    const planCall = fake.calls.find((c) => c.kind === 'plan')!;
    const user = (planCall.body.messages as Array<{ content: string }>)[0]!.content;
    expect(user).toMatch(/Goal of this step: Re-engage/);
    expect(user).toMatch(/12 Elm St/);
    expect(user).toMatch(/Allowed now: send one text/);
    expect(phone).toBeTruthy();
  });

  it('fails the run deterministically when the model uses a capability the step did not allow', async () => {
    const { leadId } = await createLead('Marcus Aiyepola');
    fake.plan = { summary: 'Mark dead.', sms_body: null, task_title: null, task_due_in_days: null, lead_status: 'dead' };
    const seq = await createSequence({
      name: 'Text only',
      steps: [{ type: 'agent', goal: 'Send one friendly check-in text, nothing else', allowed: ['send_sms'] }],
    });
    await enroll(seq, leadId);
    const run = await runFor(seq, leadId);
    expect(run?.status).toBe('failed');
    expect(run?.error).toMatch(/ai_invalid_draft/);
    expect(run?.error).toMatch(/may not change the lead status/);
    const lead = (await ctx.dbh.db.select().from(schema.leads).where(eq(schema.leads.id, leadId)))[0]!;
    expect(lead.status).toBe('new');
    // Two model calls: the plan and its one correction round.
    expect(fake.calls.filter((c) => c.kind === 'plan').length).toBeGreaterThanOrEqual(3);
  });
});

describe('completion routing', () => {
  it('fixed: a finished run enrolls its lead in the next sequence once and records why', async () => {
    const { leadId } = await createLead('Dana Ortiz');
    const next = await createSequence({ name: 'Long nurture', steps: [{ type: 'status', status: 'nurture' }] });
    const first = await createSequence({
      name: 'Two-touch',
      steps: [{ type: 'status', status: 'contacted' }],
      on_complete: { mode: 'fixed', sequence_id: next, candidate_ids: [], also_when_stopped: false },
    });
    await enroll(first, leadId);

    const run = await runFor(first, leadId);
    expect(run?.status).toBe('succeeded');
    const nextRun = await runFor(next, leadId);
    expect(nextRun).not.toBeNull();
    expect(run?.routedRunId).toBe(nextRun!.id);
    expect(run?.routedReason).toMatch(/fixed rule: continue in "Long nurture"/);
    expect(nextRun?.status).toBe('succeeded');
    const lead = (await ctx.dbh.db.select().from(schema.leads).where(eq(schema.leads.id, leadId)))[0]!;
    expect(lead.status).toBe('nurture');

    // A replayed job for the finished run does not route twice.
    const { enqueueJob } = await import('@talkr/db');
    await enqueueJob(ctx.dbh.db, { jobType: 'workflow-run', payload: { runId: run!.id }, dedupeKey: `replay:${run!.id}` });
    await ctx.runner.drain();
    const again = await ctx.dbh.db.select().from(schema.workflowRuns).where(eq(schema.workflowRuns.leadId, leadId));
    expect(again).toHaveLength(2);

    // The API surfaces both on the run row.
    const detail = await ctx.app.inject({ method: 'GET', url: `/v1/sequences/${first}`, headers: adminAuth });
    const shown = (detail.json() as { runs: Array<{ routed_run_id: string | null; routed_reason: string | null }> }).runs[0]!;
    expect(shown.routed_run_id).toBe(nextRun!.id);
    expect(shown.routed_reason).toMatch(/fixed rule/);
  });

  it('smart: the model picks among candidates the lead has not run, and none means nobody is enrolled', async () => {
    const { leadId } = await createLead('Priya Natarajan');
    const warm = await createSequence({ name: 'Warm follow-up', description: 'Replied once, then stalled', steps: [{ type: 'status', status: 'warm' }] });
    const cold = await createSequence({ name: 'Cold drip', description: 'Never answered', steps: [{ type: 'status', status: 'cold' }] });
    const start = await createSequence({
      name: 'Opener',
      steps: [{ type: 'status', status: 'contacted' }],
      on_complete: { mode: 'smart', sequence_id: null, candidate_ids: [warm, cold], also_when_stopped: false },
    });

    fake.choice = { sequence_id: cold, reason: 'No inbound texts or answered calls: the silent track.' };
    await enroll(start, leadId);
    const run = await runFor(start, leadId);
    expect(run?.routedRunId).toBeTruthy();
    expect(run?.routedReason).toBe('smart: No inbound texts or answered calls: the silent track.');
    expect(await runFor(cold, leadId)).not.toBeNull();
    expect(await runFor(warm, leadId)).toBeNull();
    const choiceCall = fake.calls.filter((c) => c.kind === 'choice').pop()!;
    const user = (choiceCall.body.messages as Array<{ content: string }>)[0]!.content;
    expect(user).toMatch(/Warm follow-up: Replied once, then stalled/);
    expect(user).toMatch(/"Opener": succeeded/);

    // A lead that just finished the cold track: the router says none.
    const { leadId: other } = await createLead('Sam Lee');
    fake.choice = { sequence_id: null, reason: 'They replied; a person should take over.' };
    await enroll(start, other);
    const run2 = await runFor(start, other);
    expect(run2?.routedRunId).toBeNull();
    expect(run2?.routedReason).toBe('smart: They replied; a person should take over.');
    expect(await runFor(cold, other)).toBeNull();
  });

  it('refuses a rule that routes into itself or an unknown sequence', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/sequences',
      headers: adminAuth,
      payload: { name: 'Bad', steps: [{ type: 'status', status: 'x' }], on_complete: { mode: 'fixed', sequence_id: '00000000-0000-4000-8000-000000000000' } },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_routing');

    const id = await createSequence({ name: 'Self', steps: [{ type: 'status', status: 'x' }] });
    const patch = await ctx.app.inject({ method: 'PATCH', url: `/v1/sequences/${id}`, headers: adminAuth, payload: { on_complete: { mode: 'fixed', sequence_id: id } } });
    expect(patch.statusCode).toBe(400);
    expect((patch.json() as { message: string }).message).toMatch(/into itself/);
  });
});
