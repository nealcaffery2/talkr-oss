/**
 * Phase 7 workflow engine (docs/workflows.md): triggers driven through the
 * REAL pipelines (signed Twilio webhooks, real API calls, real worker jobs
 * against Postgres) — never synthetic run rows. Pins: exactly-once under
 * re-scan, compliance skips (suppression / quiet hours) through the Phase 4
 * send path, loop safety (workflow SMS never re-triggers message.received),
 * rate caps visible in history, ordered actions with idempotent retry, and
 * emit_webhook landing signed Phase 10 deliveries.
 */

import http from 'node:http';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { enqueueJob, schema } from '@talkr/db';
import { authHeader, createTestContext, webhookPost, type TestContext } from './helpers.js';
import { twimlOutbound, voiceStatus } from './fixtures/texml.js';
import { inboundSms } from './fixtures/texml-sms.js';

let ctx: TestContext;
let adminAuth: Record<string, string>;
let repAuth: Record<string, string>;
let templateId: string;

const PLATFORM_NUMBER = '+15005550006';
const SELLER = '+15005550009'; // seeded contact phone → seeded lead
const ALWAYS_OPEN = { timezone: 'UTC', smsSendWindowStart: '00:00', smsSendWindowEnd: '00:00' };

let sweepCount = 0;
/** One trigger-feed sweep + full queue drain (runs, sends, deliveries). */
async function fanoutAndDrain(): Promise<void> {
  await enqueueJob(ctx.dbh.db, {
    jobType: 'workflow-fanout',
    dedupeKey: `workflow-fanout:test:${++sweepCount}:${Date.now()}`,
  });
  await ctx.runner.drain();
}

async function setOrgSettings(settings: Record<string, unknown>) {
  await ctx.dbh.db
    .update(schema.organizations)
    .set({ settings })
    .where(eq(schema.organizations.id, ctx.seed.orgId));
}

async function createWorkflow(payload: Record<string, unknown>): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/workflows',
    headers: adminAuth,
    payload,
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { workflow: { id: string } }).workflow.id;
}

async function disableWorkflow(id: string) {
  const res = await ctx.app.inject({
    method: 'PATCH',
    url: `/v1/workflows/${id}`,
    headers: adminAuth,
    payload: { enabled: false },
  });
  expect(res.statusCode).toBe(200);
}

async function runsFor(workflowId: string) {
  return ctx.dbh.db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.workflowId, workflowId))
    .orderBy(schema.workflowRuns.createdAt);
}

/** A contact + primary phone + lead assigned to the seeded rep. */
async function createLeadWithPhone(phone: string, name: string): Promise<string> {
  const contact = (
    await ctx.dbh.db
      .insert(schema.contacts)
      .values({ orgId: ctx.seed.orgId, displayName: name })
      .returning()
  )[0]!;
  await ctx.dbh.db.insert(schema.contactPhones).values({
    orgId: ctx.seed.orgId,
    contactId: contact.id,
    phoneE164: phone,
    isPrimary: true,
  });
  const lead = (
    await ctx.dbh.db
      .insert(schema.leads)
      .values({
        orgId: ctx.seed.orgId,
        status: 'new',
        source: 'test',
        primaryContactId: contact.id,
        assignedUserId: ctx.seed.repId,
        receivedAt: new Date(),
      })
      .returning()
  )[0]!;
  return lead.id;
}

/** Drive a REAL missed inbound call: inbound TwiML (no agents → voicemail),
 * then the parent leg's terminal status webhook. answered_at stays null. */
async function driveMissedInboundCall(callSid: string, from: string): Promise<string> {
  const twiml = await webhookPost(ctx, '/twiml/inbound', {
    AccountSid: 'ACtest00000000000000000000000000',
    CallSid: callSid,
    CallStatus: 'ringing',
    From: from,
    To: PLATFORM_NUMBER,
    Direction: 'inbound',
    ApiVersion: '2010-04-01',
  });
  expect(twiml.statusCode).toBe(200);
  await webhookPost(
    ctx,
    '/webhooks/telnyx/voice-status',
    voiceStatus({ callSid, status: 'completed', sequence: 1, duration: 15, direction: 'inbound', from, to: PLATFORM_NUMBER }),
  );
  await ctx.runner.drain();
  const call = (
    await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.providerCallId, callSid))
  )[0]!;
  expect(call.answeredAt).toBeNull(); // missed = inbound ∧ never answered ∧ terminal
  return call.id;
}

/** Drive a REAL completed outbound call on a lead through click-to-call. */
async function driveCompletedOutboundCall(n: number, leadId: string): Promise<string> {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/v1/calls',
    headers: repAuth,
    payload: { lead_id: leadId },
  });
  expect(created.statusCode).toBe(201);
  const callId = (created.json() as { call: { id: string } }).call.id;
  const clientSid = `CA_wf_client_${n}`;
  const pstnSid = `CA_wf_pstn_${n}`;
  await webhookPost(
    ctx,
    '/twiml/outbound-dial',
    twimlOutbound({ clientCallSid: clientSid, talkrCallId: callId, identity: ctx.seed.repId }),
  );
  const path = `/webhooks/telnyx/voice-status?call=${callId}&leg=pstn`;
  await webhookPost(ctx, path, voiceStatus({ callSid: pstnSid, status: 'in-progress', sequence: 0, parentCallSid: clientSid }));
  await webhookPost(ctx, path, voiceStatus({ callSid: pstnSid, status: 'completed', sequence: 1, parentCallSid: clientSid, duration: 33 }));
  await ctx.runner.drain();
  return callId;
}

beforeAll(async () => {
  ctx = await createTestContext();
  adminAuth = await authHeader('auth-admin-test-org');
  repAuth = await authHeader('auth-rep-test-org');
  await setOrgSettings(ALWAYS_OPEN);
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/v1/message-templates',
    headers: adminAuth,
    payload: { name: 'wf-intro', body: 'Sorry we missed you, {{first_name}}!' },
  });
  templateId = (created.json() as { template: { id: string } }).template.id;
});
afterAll(async () => {
  await ctx.close();
});

// ---------------------------------------------------------------------------
// call.missed → send_sms (through the REAL Phase 4 path)
// ---------------------------------------------------------------------------
describe('call.missed → send_sms', () => {
  let wfId: string;

  it('a missed inbound call fires the workflow and sends the SMS via the Phase 4 service', async () => {
    wfId = await createWorkflow({
      name: 'missed call text-back',
      trigger_type: 'call.missed',
      actions: [{ type: 'send_sms', template_id: templateId }],
    });

    const sendsBefore = ctx.sentMessages.length;
    await driveMissedInboundCall('CA_wf_missed_1', SELLER);
    await fanoutAndDrain();

    const runs = await runsFor(wfId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.matched).toBe(true);
    expect(runs[0]!.leadId).toBe(ctx.seed.leadId);
    const results = runs[0]!.actionResults as Array<{ status: string; detail?: { message_id?: string } }>;
    expect(results[0]!.status).toBe('succeeded');

    // Exactly one real provider send, to the lead's primary phone, rendered.
    expect(ctx.sentMessages.length).toBe(sendsBefore + 1);
    const sent = ctx.sentMessages.at(-1)!;
    expect(sent.to).toBe(SELLER);
    expect(sent.body).toBe('Sorry we missed you, Sally!');

    // The message row went through the normal path, attributed to the rep.
    const message = (
      await ctx.dbh.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.id, results[0]!.detail!.message_id!))
    )[0]!;
    expect(message.direction).toBe('outbound');
    expect(message.createdBy).toBe(ctx.seed.repId);
    expect(message.templateId).toBe(templateId);
  });

  it('re-scanning the same events (overlap window) never double-runs', async () => {
    const sendsBefore = ctx.sentMessages.length;
    await fanoutAndDrain();
    await fanoutAndDrain();
    expect(await runsFor(wfId)).toHaveLength(1); // unique key pinned
    expect(ctx.sentMessages.length).toBe(sendsBefore);
  });

  it('an answered inbound call does not fire call.missed', async () => {
    // Rep available → client leg answers → parent completes.
    await ctx.dbh.db
      .insert(schema.agentPresence)
      .values({ userId: ctx.seed.repId, orgId: ctx.seed.orgId, status: 'available', lastSeenAt: new Date() })
      .onConflictDoUpdate({
        target: schema.agentPresence.userId,
        set: { status: 'available', lastSeenAt: new Date() },
      });
    await webhookPost(ctx, '/twiml/inbound', {
      AccountSid: 'ACtest00000000000000000000000000',
      CallSid: 'CA_wf_answered',
      CallStatus: 'ringing',
      From: SELLER,
      To: PLATFORM_NUMBER,
      Direction: 'inbound',
      ApiVersion: '2010-04-01',
    });
    const call = (
      await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.providerCallId, 'CA_wf_answered'))
    )[0]!;
    await webhookPost(ctx, `/webhooks/telnyx/voice-status?call=${call.id}&leg=client`, voiceStatus({
      callSid: 'CA_wf_answered_client', status: 'in-progress', sequence: 0, parentCallSid: 'CA_wf_answered', direction: 'inbound',
    }));
    await webhookPost(ctx, '/webhooks/telnyx/voice-status', voiceStatus({
      callSid: 'CA_wf_answered', status: 'completed', sequence: 1, duration: 40, direction: 'inbound', from: SELLER, to: PLATFORM_NUMBER,
    }));
    await ctx.runner.drain();
    await fanoutAndDrain();
    expect(await runsFor(wfId)).toHaveLength(1); // still just the missed one
    await ctx.dbh.db.execute(sql`DELETE FROM agent_presence`);
  });

  it('a suppressed destination skips the action (skipped_suppressed) and the run still succeeds', async () => {
    const phone = '+16145559911';
    await createLeadWithPhone(phone, 'Serge Suppressed');
    await ctx.dbh.db.insert(schema.suppressionRecords).values({
      orgId: ctx.seed.orgId,
      phoneE164: phone,
      scope: 'org',
      channel: 'sms',
      reason: 'stop',
    });
    const sendsBefore = ctx.sentMessages.length;
    await driveMissedInboundCall('CA_wf_missed_sup', phone);
    await fanoutAndDrain();

    const runs = await runsFor(wfId);
    expect(runs).toHaveLength(2);
    const run = runs.at(-1)!;
    expect(run.status).toBe('succeeded'); // compliance skip is not a failure
    const results = run.actionResults as Array<{ status: string }>;
    expect(results[0]!.status).toBe('skipped_suppressed');
    expect(ctx.sentMessages.length).toBe(sendsBefore); // provider never called
  });

  it('quiet hours skip the action (skipped_quiet_hours), never force or defer the send', async () => {
    const phone = '+16145559912';
    await createLeadWithPhone(phone, 'Quinn Quiet');
    // A window that is closed right now (starts in 2h, org clock = UTC).
    const hh = (offset: number) => `${String((new Date().getUTCHours() + offset) % 24).padStart(2, '0')}:00`;
    await setOrgSettings({ timezone: 'UTC', smsSendWindowStart: hh(2), smsSendWindowEnd: hh(5) });

    const sendsBefore = ctx.sentMessages.length;
    await driveMissedInboundCall('CA_wf_missed_qh', phone);
    await fanoutAndDrain();

    const runs = await runsFor(wfId);
    const run = runs.at(-1)!;
    expect(run.status).toBe('succeeded');
    const results = run.actionResults as Array<{ status: string }>;
    expect(results[0]!.status).toBe('skipped_quiet_hours');
    expect(ctx.sentMessages.length).toBe(sendsBefore);
    // Nothing was silently queued for later.
    const pending = await ctx.dbh.db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.jobType, 'send-message'), eq(schema.jobs.status, 'pending')));
    expect(pending).toHaveLength(0);

    await setOrgSettings(ALWAYS_OPEN);
    await disableWorkflow(wfId);
  });
});

// ---------------------------------------------------------------------------
// disposition.created → create_task (condition on disposition slug)
// ---------------------------------------------------------------------------
describe('disposition.created → create_task', () => {
  let wfId: string;

  it('a follow_up disposition creates a task assigned to the lead owner with the right due date', async () => {
    wfId = await createWorkflow({
      name: 'follow-up task',
      trigger_type: 'disposition.created',
      conditions: { all: [{ field: 'disposition.slug', op: 'eq', value: 'follow_up' }] },
      actions: [
        { type: 'create_task', title: 'Call the seller back', note: 'from workflow', assign_to: 'lead_owner', due_in_hours: 24 },
      ],
    });

    const callId = await driveCompletedOutboundCall(1, ctx.seed.leadId);
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/disposition`,
      headers: repAuth,
      payload: { disposition: 'follow_up', note: 'wants an offer' },
    });
    expect(res.statusCode).toBe(200);
    await ctx.runner.drain();
    await fanoutAndDrain();

    const runs = await runsFor(wfId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.matched).toBe(true);

    const tasks = await ctx.dbh.db
      .select()
      .from(schema.tasks)
      .where(eq(schema.tasks.workflowId, wfId));
    expect(tasks).toHaveLength(1);
    const task = tasks[0]!;
    expect(task.leadId).toBe(ctx.seed.leadId);
    expect(task.assignedUserId).toBe(ctx.seed.repId); // lead_owner resolved
    expect(task.source).toBe('workflow');
    expect(task.status).toBe('open');
    const expectedDue = Date.now() + 24 * 3_600_000;
    expect(Math.abs(task.dueAt!.getTime() - expectedDue)).toBeLessThan(5 * 60_000);
  });

  it('a non-matching disposition is skipped as conditions_not_matched (no task)', async () => {
    const callId = await driveCompletedOutboundCall(2, ctx.seed.leadId);
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/disposition`,
      headers: repAuth,
      payload: { disposition: 'wrong_number' },
    });
    await ctx.runner.drain();
    await fanoutAndDrain();

    const runs = await runsFor(wfId);
    expect(runs).toHaveLength(2);
    const run = runs.at(-1)!;
    expect(run.status).toBe('skipped');
    expect(run.matched).toBe(false);
    expect(run.skipReason).toBe('conditions_not_matched');
    expect(await ctx.dbh.db.select().from(schema.tasks).where(eq(schema.tasks.workflowId, wfId))).toHaveLength(1);
    await disableWorkflow(wfId);
  });
});

// ---------------------------------------------------------------------------
// message.received: real inbound webhook fires; workflow-sent SMS never does
// ---------------------------------------------------------------------------
describe('message.received loop safety', () => {
  let wfId: string;

  it('a real inbound SMS webhook fires the workflow, which replies via send_sms', async () => {
    wfId = await createWorkflow({
      name: 'inbound text auto-followup',
      trigger_type: 'message.received',
      actions: [{ type: 'send_sms', template_id: templateId }],
    });

    const sendsBefore = ctx.sentMessages.length;
    await webhookPost(
      ctx,
      '/webhooks/telnyx/inbound-sms',
      inboundSms({ sid: 'SM_wf_in_1', from: SELLER, to: PLATFORM_NUMBER, body: 'Is the offer still on?' }),
    );
    await ctx.runner.drain(); // applies the inbound message
    await fanoutAndDrain();

    const runs = await runsFor(wfId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
    expect(ctx.sentMessages.length).toBe(sendsBefore + 1);
    expect(ctx.sentMessages.at(-1)!.to).toBe(SELLER);
  });

  it('the workflow-sent outbound message does NOT re-trigger message.received', async () => {
    const sendsBefore = ctx.sentMessages.length;
    // The outbound reply from the previous test is already in messages;
    // sweep again (twice) — outbound rows are structurally invisible.
    await fanoutAndDrain();
    await fanoutAndDrain();
    expect(await runsFor(wfId)).toHaveLength(1);
    expect(ctx.sentMessages.length).toBe(sendsBefore);

    // A rep-sent outbound message does not trigger either.
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/messages',
      headers: repAuth,
      payload: { to_number: SELLER, body: 'manual outbound' },
    });
    expect(res.statusCode).toBe(201);
    await ctx.runner.drain();
    await fanoutAndDrain();
    expect(await runsFor(wfId)).toHaveLength(1);
    await disableWorkflow(wfId);
  });
});

// ---------------------------------------------------------------------------
// Rate caps: per-lead daily cap → skipped, visible in run history
// ---------------------------------------------------------------------------
describe('rate caps', () => {
  it('the per-lead daily cap skips the excess run with a visible reason', async () => {
    const wfId = await createWorkflow({
      name: 'capped tasker',
      trigger_type: 'call.completed',
      actions: [{ type: 'create_task', title: 'post-call task', assign_to: 'lead_owner', due_in_hours: 1 }],
      max_runs_per_lead_per_day: 1,
    });

    await driveCompletedOutboundCall(3, ctx.seed.leadId);
    await driveCompletedOutboundCall(4, ctx.seed.leadId);
    await fanoutAndDrain();

    const runs = await runsFor(wfId);
    expect(runs).toHaveLength(2);
    const statuses = runs.map((r) => r.status).sort();
    expect(statuses).toEqual(['skipped', 'succeeded']);
    const capped = runs.find((r) => r.status === 'skipped')!;
    expect(capped.matched).toBe(true);
    expect(capped.skipReason).toBe('rate_cap_lead_daily');

    // Exactly one task despite two completed calls.
    expect(await ctx.dbh.db.select().from(schema.tasks).where(eq(schema.tasks.workflowId, wfId))).toHaveLength(1);

    // The cap skip is visible in the run-history API.
    const history = await ctx.app.inject({
      method: 'GET',
      url: `/v1/workflows/${wfId}/runs`,
      headers: adminAuth,
    });
    const listed = (history.json() as { runs: Array<{ status: string; skip_reason: string | null }> }).runs;
    expect(listed.some((r) => r.status === 'skipped' && r.skip_reason === 'rate_cap_lead_daily')).toBe(true);
    await disableWorkflow(wfId);
  });
});

// ---------------------------------------------------------------------------
// Multi-action ordering + idempotent retry (recorded completion)
// ---------------------------------------------------------------------------
describe('multi-action retry idempotency', () => {
  it('when the second action keeps failing, retries never re-execute the completed first action', async () => {
    const phone = '+16145559913';
    await createLeadWithPhone(phone, 'Retta Retry');
    const wfId = await createWorkflow({
      name: 'send then break',
      trigger_type: 'call.missed',
      actions: [
        { type: 'send_sms', template_id: templateId },
        // FK-violating assignee: fails on every attempt (transient class).
        { type: 'create_task', title: 'doomed', assign_to: '00000000-0000-0000-0000-00000000dead', due_in_hours: 1 },
      ],
    });

    const sendsBefore = ctx.sentMessages.length;
    await driveMissedInboundCall('CA_wf_missed_retry', phone);
    await fanoutAndDrain(); // drains through all 8 queue attempts (backoff 0)

    const runs = await runsFor(wfId);
    expect(runs).toHaveLength(1);
    const run = runs[0]!;
    expect(run.status).toBe('failed');
    const results = run.actionResults as Array<{ index: number; status: string; error?: string }>;
    expect(results.find((r) => r.index === 0)!.status).toBe('succeeded');
    expect(results.find((r) => r.index === 1)!.status).toBe('failed');

    // The pin: exactly ONE provider send despite 8 attempts of the run job.
    expect(ctx.sentMessages.length).toBe(sendsBefore + 1);
    expect(ctx.sentMessages.at(-1)!.to).toBe(phone);
    const messagesToPhone = await ctx.dbh.db
      .select()
      .from(schema.messages)
      .where(eq(schema.messages.orgId, ctx.seed.orgId));
    expect(messagesToPhone.filter((m) => m.templateId === templateId && m.body.includes('Retta')).length).toBe(1);

    // The run job itself dead-lettered after the queue's full retry budget.
    const job = (
      await ctx.dbh.db
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.dedupeKey, `workflow-run:${run.id}`))
    )[0]!;
    expect(job.status).toBe('dead');
    expect(job.attempts).toBe(8);
    await disableWorkflow(wfId);
  });
});

// ---------------------------------------------------------------------------
// lead.created → emit_webhook (Phase 10 delivery with verifiable signature)
// ---------------------------------------------------------------------------
describe('emit_webhook via lead.created', () => {
  it('lands a signed workflow.executed delivery through the Phase 10 machinery', async () => {
    // Local receiver (Phase 10 test pattern).
    const received: Array<{ headers: http.IncomingHttpHeaders; body: string }> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
        res.writeHead(200);
        res.end('ok');
      });
    });
    const url = await new Promise<string>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}/hook`);
      });
    });

    const subRes = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/webhook-subscriptions',
      headers: adminAuth,
      payload: { url, event_types: ['workflow.executed'] }, // accepted vocabulary
    });
    expect(subRes.statusCode).toBe(201);
    const { subscription, signing_secret } = subRes.json() as {
      subscription: { id: string };
      signing_secret: string;
    };

    const wfId = await createWorkflow({
      name: 'announce new leads',
      trigger_type: 'lead.created',
      actions: [{ type: 'emit_webhook' }],
    });

    const leadRes = await ctx.app.inject({
      method: 'POST',
      url: '/v1/leads',
      headers: adminAuth,
      payload: { contact_name: 'Wanda Webhook', phone: '+16145559914', source: 'webform' },
    });
    expect(leadRes.statusCode).toBe(201);
    const leadId = (leadRes.json() as { lead: { id: string } }).lead.id;

    await fanoutAndDrain();

    const runs = await runsFor(wfId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
    const results = runs[0]!.actionResults as Array<{ status: string; detail?: { delivery_count?: number } }>;
    expect(results[0]!.status).toBe('succeeded');
    expect(results[0]!.detail?.delivery_count).toBe(1);

    const deliveries = await ctx.dbh.db
      .select()
      .from(schema.webhookDeliveries)
      .where(
        and(
          eq(schema.webhookDeliveries.subscriptionId, subscription.id),
          eq(schema.webhookDeliveries.eventType, 'workflow.executed'),
        ),
      );
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.state).toBe('delivered');

    // Signature verifies against the exact recorded body with the sub secret.
    expect(received).toHaveLength(1);
    const req = received[0]!;
    expect(req.headers['x-talkr-event']).toBe('workflow.executed');
    const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(String(req.headers['x-talkr-signature']));
    expect(match).not.toBeNull();
    const expected = createHmac('sha256', signing_secret).update(`${match![1]}.${req.body}`).digest('hex');
    expect(expected).toBe(match![2]);

    const envelope = JSON.parse(req.body) as {
      type: string;
      data: { workflow: { id: string; trigger_type: string }; run: { trigger_source: string }; lead: { id: string } };
    };
    expect(envelope.type).toBe('workflow.executed');
    expect(envelope.data.workflow.id).toBe(wfId);
    expect(envelope.data.workflow.trigger_type).toBe('lead.created');
    expect(envelope.data.run.trigger_source).toBe('lead.created');
    expect(envelope.data.lead.id).toBe(leadId);

    await disableWorkflow(wfId);
    await new Promise<void>((r) => server.close(() => r()));
  });
});

// ---------------------------------------------------------------------------
// no_contact_for_days: stale fires once per period, active never fires
// ---------------------------------------------------------------------------
describe('no_contact_for_days sweep', () => {
  it('fires once for a stale lead, not for active leads, and not twice in one period', async () => {
    const wfId = await createWorkflow({
      name: 'stale lead nudge',
      trigger_type: 'no_contact_for_days',
      trigger_config: { days: 7 },
      actions: [{ type: 'update_lead_status', status: 'stale' }],
    });

    // A lead created 10 days ago with zero call/message activity.
    const staleLeadId = await createLeadWithPhone('+16145559915', 'Stan Stale');
    await ctx.dbh.db.execute(
      sql`UPDATE leads SET created_at = now() - interval '10 days' WHERE id = ${staleLeadId}`,
    );
    // A lead just as old but with a recent call → active, must not fire.
    const activeLeadId = await createLeadWithPhone('+16145559916', 'Ava Active');
    await ctx.dbh.db.execute(
      sql`UPDATE leads SET created_at = now() - interval '10 days' WHERE id = ${activeLeadId}`,
    );
    await driveCompletedOutboundCall(5, activeLeadId);

    await enqueueJob(ctx.dbh.db, {
      jobType: 'workflow-time-sweep',
      dedupeKey: `workflow-time-sweep:test:1:${Date.now()}`,
    });
    await ctx.runner.drain();

    const runs = await runsFor(wfId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.leadId).toBe(staleLeadId);
    expect(runs[0]!.status).toBe('succeeded');
    expect(runs[0]!.triggerSource).toBe('no_contact');

    const stale = (
      await ctx.dbh.db.select().from(schema.leads).where(eq(schema.leads.id, staleLeadId))
    )[0]!;
    expect(stale.status).toBe('stale'); // the action ran
    const active = (
      await ctx.dbh.db.select().from(schema.leads).where(eq(schema.leads.id, activeLeadId))
    )[0]!;
    expect(active.status).toBe('new'); // untouched

    // Second sweep in the same period: the bucketed unique key absorbs it.
    await enqueueJob(ctx.dbh.db, {
      jobType: 'workflow-time-sweep',
      dedupeKey: `workflow-time-sweep:test:2:${Date.now()}`,
    });
    await ctx.runner.drain();
    expect(await runsFor(wfId)).toHaveLength(1);
    await disableWorkflow(wfId);
  });
});
