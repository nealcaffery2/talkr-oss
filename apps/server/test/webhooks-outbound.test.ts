/**
 * Phase 10 outbound webhooks (docs/public-api.md §7): decoupled fan-out from
 * the append-only sources, exactly-once per (subscription, event), HMAC
 * signatures verified against the recorded body, queue-native retry to
 * dead-letter, auto-disable after sustained failure, and redelivery — all
 * against a real local HTTP receiver.
 */

import http from 'node:http';
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { enqueueJob, schema } from '@talkr/db';
import { authHeader, createTestContext, webhookPost, type TestContext } from './helpers.js';
import { dialComplete, recordingStatus, twimlOutbound, voiceStatus } from './fixtures/texml.js';

interface ReceivedRequest {
  headers: http.IncomingHttpHeaders;
  body: string;
  url: string;
}

interface Receiver {
  url: string;
  received: ReceivedRequest[];
  status: number;
  close(): Promise<void>;
}

function startReceiver(): Promise<Receiver> {
  return new Promise((resolve) => {
    const received: ReceivedRequest[] = [];
    const receiver: Receiver = {
      url: '',
      received,
      status: 200,
      close: () => new Promise((r) => server.close(() => r())),
    };
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        received.push({
          headers: req.headers,
          body: Buffer.concat(chunks).toString('utf8'),
          url: req.url ?? '',
        });
        res.writeHead(receiver.status, { 'content-type': 'text/plain' });
        res.end('ok');
      });
    });
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      receiver.url = `http://127.0.0.1:${addr.port}/hook`;
      resolve(receiver);
    });
  });
}

let ctx: TestContext;
let adminAuth: Record<string, string>;
let repAuth: Record<string, string>;
let receiver1: Receiver;
let sub1Id: string;
let sub1Secret: string;

let sweepCount = 0;
/** Run one fan-out sweep + drain the queue (delivery jobs included). */
async function sweepAndDrain(): Promise<void> {
  await enqueueJob(ctx.dbh.db, {
    jobType: 'webhook-fanout',
    dedupeKey: `webhook-fanout:test:${++sweepCount}:${Date.now()}`,
  });
  await ctx.runner.drain();
}

function verifySignature(secret: string, req: ReceivedRequest): boolean {
  const header = String(req.headers['x-talkr-signature'] ?? '');
  const match = /^t=(\d+),v1=([0-9a-f]{64})$/.exec(header);
  if (!match) return false;
  const expected = createHmac('sha256', secret).update(`${match[1]}.${req.body}`).digest('hex');
  return expected === match[2];
}

async function deliveriesFor(subscriptionId: string, eventType?: string) {
  return ctx.dbh.db
    .select()
    .from(schema.webhookDeliveries)
    .where(
      eventType
        ? and(
            eq(schema.webhookDeliveries.subscriptionId, subscriptionId),
            eq(schema.webhookDeliveries.eventType, eventType),
          )
        : eq(schema.webhookDeliveries.subscriptionId, subscriptionId),
    );
}

beforeAll(async () => {
  ctx = await createTestContext();
  adminAuth = await authHeader('auth-admin-test-org');
  repAuth = await authHeader('auth-rep-test-org');
  receiver1 = await startReceiver();
});
afterAll(async () => {
  await receiver1.close();
  await ctx.close();
});

describe('subscription management', () => {
  it('creates a subscription, returns the signing secret once, and validates event types', async () => {
    const bad = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/webhook-subscriptions',
      headers: adminAuth,
      payload: { url: receiver1.url, event_types: ['call.exploded'] },
    });
    expect(bad.statusCode).toBe(400);
    expect((bad.json() as { error: string }).error).toBe('invalid_event_types');

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/webhook-subscriptions',
      headers: adminAuth,
      payload: {
        url: receiver1.url,
        event_types: ['call.completed', 'recording.completed', 'disposition.created'],
      },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json() as { subscription: { id: string; active: boolean }; signing_secret: string };
    expect(body.signing_secret).toMatch(/^whsec_[0-9a-f]{48}$/);
    expect(body.subscription.active).toBe(true);
    sub1Id = body.subscription.id;
    sub1Secret = body.signing_secret;

    // The list never exposes the secret.
    const list = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/webhook-subscriptions',
      headers: adminAuth,
    });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(sub1Secret);

    // Management requires admin RBAC.
    const asRep = await ctx.app.inject({
      method: 'GET',
      url: '/v1/admin/webhook-subscriptions',
      headers: repAuth,
    });
    expect(asRep.statusCode).toBe(403);
  });
});

describe('fan-out and signed delivery', () => {
  let callId: string;
  const CLIENT_SID = 'CA_client_wh';
  const PSTN_SID = 'CA_pstn_wh';

  it('a completed call fans out exactly one signed delivery to the matching subscription', async () => {
    // Full real path: click-to-call → TwiML → status webhooks → worker.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: repAuth,
      payload: { lead_id: ctx.seed.leadId },
    });
    expect(created.statusCode).toBe(201);
    callId = (created.json() as { call: { id: string } }).call.id;

    await webhookPost(
      ctx,
      '/twiml/outbound-dial',
      twimlOutbound({ clientCallSid: CLIENT_SID, talkrCallId: callId, identity: ctx.seed.repId }),
    );
    const path = `/webhooks/telnyx/voice-status?call=${callId}&leg=pstn`;
    await webhookPost(ctx, path, voiceStatus({ callSid: PSTN_SID, status: 'ringing', sequence: 0, parentCallSid: CLIENT_SID }));
    await webhookPost(ctx, path, voiceStatus({ callSid: PSTN_SID, status: 'in-progress', sequence: 1, parentCallSid: CLIENT_SID }));
    await webhookPost(
      ctx,
      path,
      voiceStatus({ callSid: PSTN_SID, status: 'completed', sequence: 2, parentCallSid: CLIENT_SID, duration: 42 }),
    );
    await ctx.runner.drain();

    await sweepAndDrain();

    const deliveries = await deliveriesFor(sub1Id, 'call.completed');
    expect(deliveries).toHaveLength(1);
    const delivery = deliveries[0]!;
    expect(delivery.state).toBe('delivered');
    expect(delivery.lastStatusCode).toBe(200);
    expect(delivery.deliveredAt).not.toBeNull();

    const requests = receiver1.received.filter((r) => r.headers['x-talkr-event'] === 'call.completed');
    expect(requests).toHaveLength(1);
    const req = requests[0]!;
    expect(req.headers['content-type']).toBe('application/json');
    expect(req.headers['x-talkr-delivery']).toBe(delivery.id);

    // Signature verifies against the exact recorded body with the sub secret.
    expect(verifySignature(sub1Secret, req)).toBe(true);
    expect(verifySignature(`${sub1Secret}x`, req)).toBe(false);

    const envelope = JSON.parse(req.body) as {
      id: string;
      type: string;
      occurredAt: string;
      data: { id: string; status: string; duration_seconds: number };
    };
    expect(envelope.type).toBe('call.completed');
    expect(envelope.id).toBe(delivery.eventId);
    expect(new Date(envelope.occurredAt).getTime()).not.toBeNaN();
    expect(envelope.data.id).toBe(callId);
    expect(envelope.data.status).toBe('completed');
    expect(envelope.data.duration_seconds).toBe(42);
  });

  it('duplicate webhook application and repeated sweeps never double-deliver', async () => {
    // Same completed callback again (at-least-once provider delivery)…
    const path = `/webhooks/telnyx/voice-status?call=${callId}&leg=pstn`;
    await webhookPost(
      ctx,
      path,
      voiceStatus({ callSid: PSTN_SID, status: 'completed', sequence: 2, parentCallSid: CLIENT_SID, duration: 42 }),
    );
    await ctx.runner.drain();
    // …and two extra sweeps over the same (overlapping) range.
    await sweepAndDrain();
    await sweepAndDrain();

    expect(await deliveriesFor(sub1Id, 'call.completed')).toHaveLength(1);
    expect(receiver1.received.filter((r) => r.headers['x-talkr-event'] === 'call.completed')).toHaveLength(1);
  });

  it('a disposition fans out disposition.created from the audit trail', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/disposition`,
      headers: repAuth,
      payload: { disposition: 'follow_up', note: 'send offer' },
    });
    expect(res.statusCode).toBe(200);
    await ctx.runner.drain(); // podio job etc.
    await sweepAndDrain();

    const deliveries = await deliveriesFor(sub1Id, 'disposition.created');
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.state).toBe('delivered');
    const req = receiver1.received.find((r) => r.headers['x-talkr-event'] === 'disposition.created')!;
    expect(verifySignature(sub1Secret, req)).toBe(true);
    const envelope = JSON.parse(req.body) as {
      id: string;
      data: { call_id: string; disposition: string; note: string };
    };
    expect(envelope.id).toMatch(/^audit:/);
    expect(envelope.data.call_id).toBe(callId);
    expect(envelope.data.disposition).toBe('follow_up');
    expect(envelope.data.note).toBe('send offer');
  });

  it('a completed recording fans out recording.completed', async () => {
    await webhookPost(
      ctx,
      `/webhooks/telnyx/recording-status?call=${callId}`,
      recordingStatus({ recordingSid: 'RE_wh', callSid: PSTN_SID, status: 'completed', duration: 42, channels: 2 }),
    );
    await ctx.runner.drain();
    await sweepAndDrain();

    const deliveries = await deliveriesFor(sub1Id, 'recording.completed');
    expect(deliveries).toHaveLength(1);
    const req = receiver1.received.find((r) => r.headers['x-talkr-event'] === 'recording.completed')!;
    const envelope = JSON.parse(req.body) as {
      data: { call_id: string; recording: { duration_seconds: number; channels: number } };
    };
    expect(envelope.data.call_id).toBe(callId);
    expect(envelope.data.recording.channels).toBe(2);
  });

  it('events the subscription did not opt into are not delivered', async () => {
    // sub1 subscribes to completed/recording/disposition only; the ringing and
    // answered events on the call above must produce no deliveries.
    const all = await deliveriesFor(sub1Id);
    const types = new Set(all.map((d) => d.eventType));
    expect(types.has('call.no_answer')).toBe(false);
    expect([...types].sort()).toEqual(['call.completed', 'disposition.created', 'recording.completed']);
  });
});

describe('retry → dead-letter → auto-disable → redelivery', () => {
  let receiver2: Receiver;
  let sub2Id: string;

  afterAll(async () => {
    await receiver2.close();
  });

  async function insertCompletedCallEvent(n: number): Promise<string> {
    const call = (
      await ctx.dbh.db
        .insert(schema.calls)
        .values({
          orgId: ctx.seed.orgId,
          direction: 'outbound',
          status: 'completed',
          userId: ctx.seed.repId,
          fromNumber: '+15005550006',
          toNumber: `+1614555${String(9100 + n)}`,
        })
        .returning()
    )[0]!;
    const event = (
      await ctx.dbh.db
        .insert(schema.callEvents)
        .values({
          orgId: ctx.seed.orgId,
          callId: call.id,
          eventType: 'call.completed',
          occurredAt: new Date(),
          source: 'webhook',
          dedupeToken: `synthetic:${n}:${Date.now()}`,
          payload: {},
        })
        .returning()
    )[0]!;
    return event.id;
  }

  it('a 500ing receiver exhausts retries, dead-letters, and auto-disables at the threshold', async () => {
    // Quiesce sub1 so this scenario is isolated.
    const off = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/admin/webhook-subscriptions/${sub1Id}`,
      headers: adminAuth,
      payload: { active: false },
    });
    expect(off.statusCode).toBe(200);

    receiver2 = await startReceiver();
    receiver2.status = 500;
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/webhook-subscriptions',
      headers: adminAuth,
      payload: { url: receiver2.url, event_types: ['call.completed'] },
    });
    sub2Id = (created.json() as { subscription: { id: string } }).subscription.id;

    // Three events, each exhausting its retry budget → threshold (3) reached.
    for (let i = 0; i < 3; i++) await insertCompletedCallEvent(i);
    await sweepAndDrain();

    const deliveries = await deliveriesFor(sub2Id, 'call.completed');
    expect(deliveries).toHaveLength(3);
    for (const d of deliveries) {
      expect(d.state).toBe('dead');
      expect(d.attemptCount).toBe(8); // the queue's full retry budget
      expect(d.lastStatusCode).toBe(500);
      expect(d.lastError).toContain('http 500');
    }
    // Every attempt actually hit the receiver: 3 deliveries × 8 attempts.
    expect(receiver2.received).toHaveLength(24);

    // The delivery jobs are dead-lettered in the queue itself.
    const deadJobs = await ctx.dbh.db
      .select()
      .from(schema.jobs)
      .where(and(eq(schema.jobs.jobType, 'webhook-deliver'), eq(schema.jobs.status, 'dead')));
    expect(deadJobs.length).toBeGreaterThanOrEqual(3);

    // Sustained failure auto-disabled the subscription, audited.
    const sub = (
      await ctx.dbh.db
        .select()
        .from(schema.webhookSubscriptions)
        .where(eq(schema.webhookSubscriptions.id, sub2Id))
    )[0]!;
    expect(sub.active).toBe(false);
    expect(sub.failureCount).toBe(3);
    expect(sub.disabledAt).not.toBeNull();
    const audit = await ctx.dbh.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, 'webhook_subscription.auto_disabled'),
          eq(schema.auditLog.objectId, sub2Id),
        ),
      );
    expect(audit).toHaveLength(1);

    // A disabled subscription receives no further fan-out.
    await insertCompletedCallEvent(99);
    await sweepAndDrain();
    expect(await deliveriesFor(sub2Id, 'call.completed')).toHaveLength(3);
  });

  it('redelivery re-enqueues a dead delivery and succeeds once the receiver recovers', async () => {
    // Re-enable (resets the failure streak) and fix the receiver.
    const on = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/admin/webhook-subscriptions/${sub2Id}`,
      headers: adminAuth,
      payload: { active: true },
    });
    expect(on.statusCode).toBe(200);
    expect((on.json() as { subscription: { failure_count: number } }).subscription.failure_count).toBe(0);
    receiver2.status = 200;

    const dead = (await deliveriesFor(sub2Id, 'call.completed'))[0]!;
    const before = receiver2.received.length;
    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/admin/webhook-deliveries/${dead.id}/redeliver`,
      headers: adminAuth,
    });
    expect(res.statusCode).toBe(200);
    await ctx.runner.drain();

    const after = (
      await ctx.dbh.db
        .select()
        .from(schema.webhookDeliveries)
        .where(eq(schema.webhookDeliveries.id, dead.id))
    )[0]!;
    expect(after.state).toBe('delivered');
    expect(after.deliveredAt).not.toBeNull();
    expect(receiver2.received.length).toBe(before + 1);

    const audit = await ctx.dbh.db
      .select()
      .from(schema.auditLog)
      .where(
        and(
          eq(schema.auditLog.action, 'webhook_delivery.redeliver'),
          eq(schema.auditLog.objectId, dead.id),
        ),
      );
    expect(audit).toHaveLength(1);
  });

  it('a delivery to a disabled subscription is skipped, not sent', async () => {
    await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/admin/webhook-subscriptions/${sub2Id}`,
      headers: adminAuth,
      payload: { active: false },
    });
    const target = (await deliveriesFor(sub2Id, 'call.completed')).find((d) => d.state === 'dead')!;
    const before = receiver2.received.length;
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/admin/webhook-deliveries/${target.id}/redeliver`,
      headers: adminAuth,
    });
    await ctx.runner.drain();
    const after = (
      await ctx.dbh.db
        .select()
        .from(schema.webhookDeliveries)
        .where(eq(schema.webhookDeliveries.id, target.id))
    )[0]!;
    expect(after.state).toBe('failed');
    expect(after.lastError).toBe('subscription_disabled');
    expect(receiver2.received.length).toBe(before);
  });
});
