/**
 * Phase 4 outbound SMS (docs/sms.md §2, §5): send path + send job, delivery
 * status lifecycle (out-of-order, duplicates, failure classification), quiet
 * hours, template rendering, retry → dead-letter. Genuine signed webhooks
 * against real Postgres.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { authHeader, createTestContext, webhookPost, type TestContext } from './helpers.js';
import { smsStatus } from './fixtures/texml-sms.js';

let ctx: TestContext;
let repAuth: Record<string, string>;
let adminAuth: Record<string, string>;
const OUR_NUMBER = '+15005550006';
const DEST = '+16145550888'; // plain destination, no CRM links
const DEST_SUPPRESS = '+16145550889';
const DEST_DLQ = '+16145550890';

const ALWAYS_OPEN = { timezone: 'UTC', smsSendWindowStart: '00:00', smsSendWindowEnd: '00:00' };

beforeAll(async () => {
  ctx = await createTestContext();
  repAuth = await authHeader('auth-rep-test-org');
  adminAuth = await authHeader('auth-admin-test-org');
  await setOrgSettings(ALWAYS_OPEN);
});
afterAll(async () => {
  await ctx.close();
});

async function setOrgSettings(settings: Record<string, string>) {
  await ctx.dbh.db
    .update(schema.organizations)
    .set({ settings })
    .where(eq(schema.organizations.id, ctx.seed.orgId));
}

async function send(payload: Record<string, unknown>) {
  return ctx.app.inject({ method: 'POST', url: '/v1/messages', headers: repAuth, payload });
}

async function messageById(id: string) {
  return (await ctx.dbh.db.select().from(schema.messages).where(eq(schema.messages.id, id)))[0]!;
}

async function messageBySid(sid: string) {
  return (
    await ctx.dbh.db.select().from(schema.messages).where(eq(schema.messages.providerMessageSid, sid))
  )[0]!;
}

describe('send path', () => {
  it('queues, audits, then the send job calls the provider and stamps the SID', async () => {
    const res = await send({ to_number: DEST, body: 'Hi — Riley with Your Company here.' });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { message: { id: string; status: string }; conversation_id: string };
    expect(body.message.status).toBe('queued');

    const audit = await ctx.dbh.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'message.create'), eq(schema.auditLog.objectId, body.message.id)));
    expect(audit).toHaveLength(1);

    await ctx.runner.drain();
    const sent = ctx.sentMessages.at(-1)!;
    expect(sent.to).toBe(DEST);
    expect(sent.from).toBe(OUR_NUMBER);
    expect(sent.body).toBe('Hi — Riley with Your Company here.');
    expect(sent.statusCallbackUrl).toBe('https://talkr.test/webhooks/telnyx/sms-status');

    const row = await messageById(body.message.id);
    expect(row.status).toBe('sending');
    expect(row.providerMessageSid).toBe(sent.providerMessageId);
    expect(row.createdBy).toBe(ctx.seed.repId);

    // Conversation created for the thread, reused on the next send.
    const res2 = await send({ to_number: DEST, body: 'Second message, same thread.' });
    expect((res2.json() as { conversation_id: string }).conversation_id).toBe(body.conversation_id);
    await ctx.runner.drain();
  });

  it('validates the body/template choice', async () => {
    expect((await send({ to_number: DEST })).statusCode).toBe(400);
    expect((await send({ to_number: DEST, body: 'x', template_id: '00000000-0000-0000-0000-000000000000' })).statusCode).toBe(400);
    expect((await send({ to_number: 'not-a-number', body: 'x' })).statusCode).toBe(400);
  });
});

describe('status callback lifecycle', () => {
  async function freshSid(): Promise<string> {
    const res = await send({ to_number: DEST, body: 'lifecycle probe' });
    await ctx.runner.drain();
    const { message } = res.json() as { message: { id: string } };
    return (await messageById(message.id)).providerMessageSid!;
  }

  it('walks the full lifecycle: sent then delivered', async () => {
    const sid = await freshSid();
    await webhookPost(ctx, '/webhooks/telnyx/sms-status', smsStatus({ sid, status: 'sent', to: DEST }));
    await ctx.runner.drain();
    let row = await messageBySid(sid);
    expect(row.status).toBe('sent');
    expect(row.sentAt).not.toBeNull();

    await webhookPost(ctx, '/webhooks/telnyx/sms-status', smsStatus({ sid, status: 'delivered', to: DEST }));
    await ctx.runner.drain();
    row = await messageBySid(sid);
    expect(row.status).toBe('delivered');
    expect(row.deliveredAt).not.toBeNull();
    expect(row.failureClass).toBe('none');
  });

  it('is out-of-order-safe: delivered before sent never regresses', async () => {
    const sid = await freshSid();
    await webhookPost(ctx, '/webhooks/telnyx/sms-status', smsStatus({ sid, status: 'delivered', to: DEST }));
    await ctx.runner.drain();
    let row = await messageBySid(sid);
    expect(row.status).toBe('delivered');

    await webhookPost(ctx, '/webhooks/telnyx/sms-status', smsStatus({ sid, status: 'sent', to: DEST }));
    await ctx.runner.drain();
    row = await messageBySid(sid);
    expect(row.status).toBe('delivered'); // no regression
    expect(row.sentAt).not.toBeNull(); // timestamp backfilled
  });

  it('duplicate callbacks are no-ops (webhook-level and apply-level)', async () => {
    const sid = await freshSid();
    const params = smsStatus({ sid, status: 'delivered', to: DEST });
    await webhookPost(ctx, '/webhooks/telnyx/sms-status', params);
    await ctx.runner.drain();
    const before = await messageBySid(sid);

    await webhookPost(ctx, '/webhooks/telnyx/sms-status', params);
    await ctx.runner.drain();
    const after = await messageBySid(sid);
    expect(after.status).toBe('delivered');
    expect(after.deliveredAt?.toISOString()).toBe(before.deliveredAt?.toISOString());
    const webhook = (
      await ctx.dbh.db
        .select()
        .from(schema.webhookEvents)
        .where(eq(schema.webhookEvents.idempotencyKey, `telnyx:sms-status:${sid}:delivered`))
    )[0]!;
    expect(webhook.duplicateCount).toBe(1);
  });

  it('failed with a carrier error code classifies carrier_failure', async () => {
    const sid = await freshSid();
    await webhookPost(
      ctx,
      '/webhooks/telnyx/sms-status',
      smsStatus({ sid, status: 'failed', errorCode: '30005', to: DEST }),
    );
    await ctx.runner.drain();
    const row = await messageBySid(sid);
    expect(row.status).toBe('failed');
    expect(row.errorCode).toBe('30005');
    expect(row.failureClass).toBe('carrier_failure');
    expect(row.failedAt).not.toBeNull();
  });

  it('undelivered with a 21xxx code classifies platform_failure', async () => {
    const sid = await freshSid();
    await webhookPost(
      ctx,
      '/webhooks/telnyx/sms-status',
      smsStatus({ sid, status: 'undelivered', errorCode: '21610', to: DEST }),
    );
    await ctx.runner.drain();
    const row = await messageBySid(sid);
    expect(row.status).toBe('undelivered');
    expect(row.failureClass).toBe('platform_failure');
  });
});

describe('quiet hours', () => {
  it('rejects outside the window and honors the org timezone', async () => {
    // A 3-hour UTC window starting 2 hours from now: "now" is outside it in
    // UTC, inside it for an org whose clock runs 2 hours ahead (Etc/GMT-2 is
    // UTC+2 — POSIX sign inversion). Deterministic at any wall-clock time.
    const hh = (offset: number) => `${String((new Date().getUTCHours() + offset) % 24).padStart(2, '0')}:00`;
    const windowStart = hh(2);
    const windowEnd = hh(5);

    await setOrgSettings({ timezone: 'UTC', smsSendWindowStart: windowStart, smsSendWindowEnd: windowEnd });
    const blocked = await send({ to_number: DEST, body: 'late-night blast attempt' });
    expect(blocked.statusCode).toBe(422);
    expect((blocked.json() as { error: string }).error).toBe('quiet_hours');
    // Explicit refusal, no silent queueing: nothing new pending.
    const pending = await ctx.dbh.db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.jobType, 'send-message'), eq(schema.jobs.status, 'pending')));
    expect(pending).toHaveLength(0);

    await setOrgSettings({ timezone: 'Etc/GMT-2', smsSendWindowStart: windowStart, smsSendWindowEnd: windowEnd });
    const allowed = await send({ to_number: DEST, body: 'daytime in the org timezone' });
    expect(allowed.statusCode).toBe(201);

    await setOrgSettings(ALWAYS_OPEN);
    await ctx.runner.drain();
  });
});

describe('templates', () => {
  it('renders lead/contact/property/rep variables into the send', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/v1/message-templates',
      headers: adminAuth,
      payload: {
        name: 'intro',
        body: 'Hi {{first_name}}, this is {{rep_name}} with {{org_name}} about {{address}} in {{city}}.',
      },
    });
    expect(created.statusCode).toBe(201);
    const templateId = (created.json() as { template: { id: string } }).template.id;

    // Reps can list templates for the composer picker.
    const list = await ctx.app.inject({ method: 'GET', url: '/v1/message-templates', headers: repAuth });
    expect((list.json() as { templates: Array<{ id: string }> }).templates.some((t) => t.id === templateId)).toBe(true);

    const res = await send({ lead_id: ctx.seed.leadId, template_id: templateId });
    expect(res.statusCode).toBe(201);
    await ctx.runner.drain();
    const sent = ctx.sentMessages.at(-1)!;
    expect(sent.to).toBe('+15005550009'); // lead's primary contact phone
    expect(sent.body).toBe(
      'Hi Sally, this is Riley Rep with Your Company about 123 Maple St in Columbus.',
    );
    const { message } = res.json() as { message: { id: string } };
    expect((await messageById(message.id)).templateId).toBe(templateId);
  });

  it('a body naming an unknown merge field is rejected when the template is SAVED', async () => {
    // Loud failure moved to write time (docs/sms.md §6): a manager fixes the
    // typo here, instead of a rep discovering it mid-conversation.
    const countBefore = (await ctx.dbh.db.select().from(schema.messages)).length;
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/v1/message-templates',
      headers: adminAuth,
      payload: { name: 'broken', body: 'Hello {{bogus_field}} at {addres}!' },
    });
    expect(created.statusCode).toBe(400);
    const body = created.json() as { error: string; fields: string[]; message: string };
    expect(body.error).toBe('unknown_merge_field');
    expect(body.fields).toEqual(['bogus_field', 'addres']);
    expect(body.message).toContain('bogus_field');
    expect((await ctx.dbh.db.select().from(schema.messages)).length).toBe(countBefore);
  });

  it('template creation requires the manage permission', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/message-templates',
      headers: repAuth,
      payload: { name: 'nope', body: 'x' },
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('send-job failure handling', () => {
  it('a suppression landing between queue and send blocks at send time', async () => {
    const res = await send({ to_number: DEST_SUPPRESS, body: 'queued before the STOP' });
    expect(res.statusCode).toBe(201);
    const { message } = res.json() as { message: { id: string } };
    // The STOP arrives before the worker runs.
    await ctx.dbh.db.insert(schema.suppressionRecords).values({
      orgId: ctx.seed.orgId,
      phoneE164: DEST_SUPPRESS,
      scope: 'org',
      channel: 'sms',
      reason: 'stop',
    });
    const sentBefore = ctx.sentMessages.length;
    await ctx.runner.drain();
    expect(ctx.sentMessages.length).toBe(sentBefore); // provider never called
    const row = await messageById(message.id);
    expect(row.status).toBe('failed');
    expect(row.failureClass).toBe('suppressed');
  });

  it('provider outage retries with backoff, then succeeds without double-send', async () => {
    ctx.smsFailures.remaining = 2; // two 503s, then healthy
    const res = await send({ to_number: DEST, body: 'through the outage' });
    const { message } = res.json() as { message: { id: string } };
    const sentBefore = ctx.sentMessages.length;
    await ctx.runner.drain();

    expect(ctx.sentMessages.length).toBe(sentBefore + 1); // exactly one send
    const row = await messageById(message.id);
    expect(row.status).toBe('sending');
    const job = (
      await ctx.dbh.db
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.dedupeKey, `send-message:${message.id}`))
    )[0]!;
    expect(job.status).toBe('succeeded');
    expect(job.attempts).toBe(3);
  });

  it('a persistent provider failure dead-letters and marks the message failed', async () => {
    ctx.smsFailures.remaining = 1000;
    const res = await send({ to_number: DEST_DLQ, body: 'doomed' });
    const { message } = res.json() as { message: { id: string } };
    await ctx.runner.drain();
    ctx.smsFailures.remaining = 0;

    const job = (
      await ctx.dbh.db
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.dedupeKey, `send-message:${message.id}`))
    )[0]!;
    expect(job.status).toBe('dead');
    expect(job.attempts).toBe(8); // default max_attempts
    expect(job.lastError).toContain('carrier 503');

    const row = await messageById(message.id);
    expect(row.status).toBe('failed');
    expect(row.failureClass).toBe('platform_failure');
    expect(row.errorCode).toBe('send_dead_letter');
  });

  it('the dead send job shows up in the admin DLQ listing', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/jobs?status=dead',
      headers: adminAuth,
    });
    const jobs = (res.json() as { jobs: Array<{ jobType: string }> }).jobs;
    expect(jobs.some((j) => j.jobType === 'send-message')).toBe(true);
  });
});

describe('conversation ordering', () => {
  it('the inbox lists most recently active conversations first', async () => {
    const list = await ctx.app.inject({ method: 'GET', url: '/v1/conversations', headers: adminAuth });
    const conversations = (list.json() as {
      conversations: Array<{ their_number: string; last_message_at: string | null }>;
    }).conversations;
    expect(conversations.length).toBeGreaterThanOrEqual(3);
    const stamps = conversations
      .map((c) => (c.last_message_at ? Date.parse(c.last_message_at) : 0));
    const sorted = [...stamps].sort((a, b) => b - a);
    expect(stamps).toEqual(sorted);
    // Sanity: freshest activity belongs to one of the numbers we just used.
    const latest = (
      await ctx.dbh.db
        .select()
        .from(schema.conversations)
        .orderBy(desc(schema.conversations.lastMessageAt))
        .limit(1)
    )[0]!;
    expect([DEST, DEST_SUPPRESS, DEST_DLQ]).toContain(latest.theirNumber);
  });
});

// ---------------------------------------------------------------------------
// Merge fields on EVERY send (docs/sms.md §6) — the prod bug: a body typed
// into the composer went to the carrier with `{first_name}` still in it.
// ---------------------------------------------------------------------------
describe('merge fields', () => {
  it('renders a typed body, not just a template, in both grammars', async () => {
    const res = await send({
      lead_id: ctx.seed.leadId,
      body: 'Hi {first_name}, still thinking about {{address}} in {city}? - {rep_name}',
    });
    expect(res.statusCode).toBe(201);
    await ctx.runner.drain();
    const sent = ctx.sentMessages.at(-1)!;
    expect(sent.body).toBe('Hi Sally, still thinking about 123 Maple St in Columbus? - Riley Rep');
    expect(sent.body).not.toMatch(/[{}]/);
  });

  it('blanks a field nobody knows rather than shipping braces', async () => {
    const res = await send({ lead_id: ctx.seed.leadId, body: 'Hi {frist_name}, about {address}.' });
    expect(res.statusCode).toBe(201);
    await ctx.runner.drain();
    expect(ctx.sentMessages.at(-1)!.body).toBe('Hi, about 123 Maple St.');
  });

  it('a destination with no property renders the address as nothing, and still sends', async () => {
    const res = await send({ to_number: DEST, body: 'Following up on {address}. - {rep_name}' });
    expect(res.statusCode).toBe(201);
    await ctx.runner.drain();
    expect(ctx.sentMessages.at(-1)!.body).toBe('Following up on. - Riley Rep');
  });
});

describe('preview', () => {
  it('returns exactly what the carrier would receive, with the unknown fields named', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/messages/preview',
      headers: repAuth,
      payload: { lead_id: ctx.seed.leadId, body: 'Hi {first_name} at {address} - {rep_name} {bogus}' },
    });
    expect(res.statusCode).toBe(200);
    const preview = res.json() as {
      body: string;
      merge_fields: Record<string, string>;
      segments: number;
      characters: number;
      unknown_fields: string[];
    };
    expect(preview.body).toBe('Hi Sally at 123 Maple St - Riley Rep');
    expect(preview.unknown_fields).toEqual(['bogus']);
    expect(preview.merge_fields.first_name).toBe('Sally');
    expect(preview.merge_fields.org_name).toBe('Your Company');
    expect(preview.characters).toBe(preview.body.length);
    expect(preview.segments).toBe(1);
  });

  it('previews with no recipient at all — every contact field renders empty', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/messages/preview',
      headers: repAuth,
      payload: { body: 'Hi {first_name}, this is {rep_name}.' },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { body: string }).body).toBe('Hi, this is Riley Rep.');
  });

  it('queues nothing', async () => {
    const before = (await ctx.dbh.db.select().from(schema.messages)).length;
    await ctx.app.inject({
      method: 'POST',
      url: '/v1/messages/preview',
      headers: repAuth,
      payload: { to_number: DEST, body: 'just looking' },
    });
    expect((await ctx.dbh.db.select().from(schema.messages)).length).toBe(before);
  });
});

// ---------------------------------------------------------------------------
// From-number override (docs/sms.md §5)
// ---------------------------------------------------------------------------
describe('from-number override', () => {
  const SECOND_NUMBER = '+15005550123';
  const DEST_FORK = '+16145550991';
  let secondNumberId: string;

  it('sends from the number the rep picked', async () => {
    secondNumberId = (
      await ctx.dbh.db
        .insert(schema.phoneNumbers)
        .values({
          orgId: ctx.seed.orgId,
          phoneE164: SECOND_NUMBER,
          providerNumberId: 'PN_second',
          capabilities: { voice: true, sms: true, mms: false },
          areaCode: SECOND_NUMBER.slice(2, 5),
          purchasedAt: new Date(),
        })
        .returning({ id: schema.phoneNumbers.id })
    )[0]!.id;

    const res = await send({
      to_number: DEST,
      body: 'from the other line',
      from_phone_number_id: secondNumberId,
    });
    expect(res.statusCode).toBe(201);
    await ctx.runner.drain();
    expect(ctx.sentMessages.at(-1)!.from).toBe(SECOND_NUMBER);
  });

  it('rejects a number the org does not own or that is not active', async () => {
    const res = await send({
      to_number: DEST,
      body: 'x',
      from_phone_number_id: '00000000-0000-4000-8000-000000000000',
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { error: string }).error).toBe('invalid_caller_id');
  });

  it('leaves the original thread alone: a different our_number IS a different thread', async () => {
    const first = await send({ to_number: DEST_FORK, body: 'opening on the main line' });
    const originalId = (first.json() as { conversation_id: string }).conversation_id;
    await ctx.runner.drain();

    const second = await send({
      conversation_id: originalId,
      body: 'same seller, other line',
      from_phone_number_id: secondNumberId,
    });
    expect(second.statusCode).toBe(201);
    const forkedId = (second.json() as { conversation_id: string }).conversation_id;
    expect(forkedId).not.toBe(originalId);
    await ctx.runner.drain();
    expect(ctx.sentMessages.at(-1)!.from).toBe(SECOND_NUMBER);

    const rows = await ctx.dbh.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.theirNumber, DEST_FORK));
    expect(rows).toHaveLength(2);
    expect(rows.find((r) => r.id === originalId)!.ourNumber).toBe(OUR_NUMBER);
    expect(rows.find((r) => r.id === forkedId)!.ourNumber).toBe(SECOND_NUMBER);
  });

  it('an existing thread keeps its own number when no override is given', async () => {
    const res = await send({ conversation_id: (
      await ctx.dbh.db
        .select()
        .from(schema.conversations)
        .where(
          and(
            eq(schema.conversations.theirNumber, DEST_FORK),
            eq(schema.conversations.ourNumber, OUR_NUMBER),
          ),
        )
    )[0]!.id, body: 'back on the main line' });
    expect(res.statusCode).toBe(201);
    await ctx.runner.drain();
    expect(ctx.sentMessages.at(-1)!.from).toBe(OUR_NUMBER);
  });
});

// ---------------------------------------------------------------------------
// Template management (docs/sms.md §6)
// ---------------------------------------------------------------------------
describe('template management', () => {
  let templateId: string;

  it('creates, then edits, a template', async () => {
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/v1/message-templates',
      headers: adminAuth,
      payload: { name: 'follow up', body: 'Hi {first_name}, following up.', category: 'warm' },
    });
    expect(created.statusCode).toBe(201);
    const template = (
      created.json() as { template: { id: string; merge_fields: string[]; is_active: boolean } }
    ).template;
    templateId = template.id;
    expect(template.merge_fields).toEqual(['first_name']);
    expect(template.is_active).toBe(true);

    const patched = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/message-templates/${templateId}`,
      headers: adminAuth,
      payload: { body: 'Hi {first_name}, following up on {address}.', category: 'hot' },
    });
    expect(patched.statusCode).toBe(200);
    const updated = (patched.json() as { template: { body: string; category: string } }).template;
    expect(updated.body).toContain('{address}');
    expect(updated.category).toBe('hot');
  });

  it('rejects an edit that introduces an unknown merge field', async () => {
    const res = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/message-templates/${templateId}`,
      headers: adminAuth,
      payload: { body: 'Hi {frist_name}!' },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { fields: string[] }).fields).toEqual(['frist_name']);
  });

  it('previews a template against a real lead', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/message-templates/${templateId}/preview`,
      headers: repAuth,
      payload: { lead_id: ctx.seed.leadId },
    });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { body: string }).body).toBe('Hi Sally, following up on 123 Maple St.');
  });

  it('deactivates a template that has been used, and hard-deletes one that has not', async () => {
    // Used: the send stamps template_id, and the sent history depends on it.
    const sent = await send({ lead_id: ctx.seed.leadId, template_id: templateId });
    expect(sent.statusCode).toBe(201);
    await ctx.runner.drain();

    const softDeleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/message-templates/${templateId}`,
      headers: adminAuth,
    });
    expect(softDeleted.statusCode).toBe(200);
    expect((softDeleted.json() as { deleted: string }).deleted).toBe('soft');
    const stillThere = (
      await ctx.dbh.db
        .select()
        .from(schema.messageTemplates)
        .where(eq(schema.messageTemplates.id, templateId))
    )[0]!;
    expect(stillThere.isActive).toBe(false);

    // Inactive templates are hidden by default and can no longer be sent...
    const list = await ctx.app.inject({ method: 'GET', url: '/v1/message-templates', headers: repAuth });
    expect(
      (list.json() as { templates: Array<{ id: string }> }).templates.some((t) => t.id === templateId),
    ).toBe(false);
    const withInactive = await ctx.app.inject({
      method: 'GET',
      url: '/v1/message-templates?include_inactive=true',
      headers: repAuth,
    });
    expect(
      (withInactive.json() as { templates: Array<{ id: string; use_count: number }> }).templates.find(
        (t) => t.id === templateId,
      )!.use_count,
    ).toBeGreaterThan(0);
    expect((await send({ lead_id: ctx.seed.leadId, template_id: templateId })).statusCode).toBe(404);

    // ...while an unused one leaves nothing behind.
    const unused = await ctx.app.inject({
      method: 'POST',
      url: '/v1/message-templates',
      headers: adminAuth,
      payload: { name: 'never used', body: 'draft' },
    });
    const unusedId = (unused.json() as { template: { id: string } }).template.id;
    const hardDeleted = await ctx.app.inject({
      method: 'DELETE',
      url: `/v1/message-templates/${unusedId}`,
      headers: adminAuth,
    });
    expect((hardDeleted.json() as { deleted: string }).deleted).toBe('hard');
    expect(
      await ctx.dbh.db
        .select()
        .from(schema.messageTemplates)
        .where(eq(schema.messageTemplates.id, unusedId)),
    ).toHaveLength(0);
  });

  it('writing needs the manage permission, reading needs only messages.send', async () => {
    for (const [method, url] of [
      ['POST', '/v1/message-templates'],
      ['PATCH', `/v1/message-templates/${templateId}`],
      ['DELETE', `/v1/message-templates/${templateId}`],
    ] as const) {
      const res = await ctx.app.inject({
        method,
        url,
        headers: repAuth,
        payload: { name: 'nope', body: 'x' },
      });
      expect(res.statusCode).toBe(403);
    }
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/v1/message-templates', headers: repAuth })).statusCode,
    ).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// Inbox filters (docs/sms.md §6)
// ---------------------------------------------------------------------------
describe('inbox filters', () => {
  interface InboxRow {
    id: string;
    their_number: string;
    contact_type: string | null;
    contact_name: string | null;
    temperature: string | null;
    tags: string[];
    assigned_user_name: string | null;
    last_message: { direction: string; status: string; body: string } | null;
    unread_count: number;
  }

  async function inbox(query: string) {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/conversations${query}`,
      headers: adminAuth,
    });
    const body = res.json() as {
      conversations: InboxRow[];
      total: number;
      counts: { unread: number; by_type: Record<string, number>; by_temperature: Record<string, number> };
    };
    return { status: res.statusCode, ...body };
  }

  it('returns totals and counts alongside the page', async () => {
    const all = await inbox('');
    expect(all.status).toBe(200);
    expect(all.total).toBeGreaterThanOrEqual(all.conversations.length);
    expect(typeof all.counts.unread).toBe('number');
    expect(all.counts.by_type).toBeDefined();
    expect(all.counts.by_temperature).toBeDefined();

    const paged = await inbox('?limit=1');
    expect(paged.conversations).toHaveLength(1);
    expect(paged.total).toBe(all.total);
  });

  it('filters by contact type and by the last message direction', async () => {
    const sellers = await inbox('?type=seller');
    for (const c of sellers.conversations) expect(c.contact_type).toBe('seller');
    expect(sellers.total).toBe(sellers.counts.by_type.seller ?? 0);

    const outbound = await inbox('?direction=outbound');
    for (const c of outbound.conversations) expect(c.last_message!.direction).toBe('outbound');
  });

  it('searches names, digits and the last message body', async () => {
    const byDigits = await inbox(`?q=${DEST.slice(-7)}`);
    expect(byDigits.conversations.some((c) => c.their_number === DEST)).toBe(true);

    const byName = await inbox('?q=Sally');
    for (const c of byName.conversations) expect(c.contact_name).toContain('Sally');
  });

  it('sorts oldest-first on request', async () => {
    const recent = await inbox('?sort=recent');
    const oldest = await inbox('?sort=oldest');
    expect(oldest.conversations[0]!.id).not.toBe(recent.conversations[0]!.id);
  });

  it('rejects a bad filter value instead of ignoring it', async () => {
    expect((await inbox('?type=landlord')).status).toBe(400);
    expect((await inbox('?from=2026-13-01')).status).toBe(400);
    expect((await inbox('?sort=hottest')).status).toBe(400);
    expect((await inbox('?limit=500')).status).toBe(400);
  });

  it('carries the delivery state of the newest message so a failed send is visible', async () => {
    const failed = (
      await ctx.dbh.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.status, 'failed'))
        .limit(1)
    )[0]!;
    const newest = (
      await ctx.dbh.db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, failed.conversationId))
        .orderBy(desc(schema.messages.createdAt))
        .limit(1)
    )[0]!;
    const row = (await inbox('?limit=200')).conversations.find((c) => c.id === failed.conversationId)!;
    expect(row.last_message!.status).toBe(newest.status);
  });
});
