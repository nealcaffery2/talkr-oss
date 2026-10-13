/**
 * Webhook ordering and duplicate torture tests (docs/telephony-events.md §4).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { authHeader, createTestContext, webhookPost, type TestContext } from './helpers.js';
import { recordingStatus, twimlOutbound, voiceStatus } from './fixtures/texml.js';

let ctx: TestContext;
let repAuth: Record<string, string>;

beforeAll(async () => {
  ctx = await createTestContext();
  repAuth = await authHeader('auth-rep-test-org');
});
afterAll(async () => {
  await ctx.close();
});

async function startCall(clientSid: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/calls',
    headers: repAuth,
    payload: { lead_id: ctx.seed.leadId },
  });
  const callId = (res.json() as { call: { id: string } }).call.id;
  await webhookPost(
    ctx,
    '/twiml/outbound-dial',
    twimlOutbound({ clientCallSid: clientSid, talkrCallId: callId, identity: ctx.seed.repId }),
  );
  return callId;
}

describe('out-of-order and duplicate webhooks', () => {
  it('completed arriving before answered never regresses; answered backfills', async () => {
    const callId = await startCall('CA_ooo_client');
    const path = `/webhooks/telnyx/voice-status?call=${callId}&leg=pstn`;
    const t0 = new Date('2026-08-25T15:00:00Z');
    const t1 = new Date('2026-08-25T15:00:20Z');
    const t2 = new Date('2026-08-25T15:02:00Z');

    // Delivered wildly out of order: completed, then ringing, then answered.
    await webhookPost(ctx, path, voiceStatus({ callSid: 'CA_ooo_pstn', status: 'completed', sequence: 3, duration: 100, timestamp: t2, parentCallSid: 'CA_ooo_client' }));
    await ctx.runner.drain();
    await webhookPost(ctx, path, voiceStatus({ callSid: 'CA_ooo_pstn', status: 'ringing', sequence: 1, timestamp: t0, parentCallSid: 'CA_ooo_client' }));
    await webhookPost(ctx, path, voiceStatus({ callSid: 'CA_ooo_pstn', status: 'in-progress', sequence: 2, timestamp: t1, parentCallSid: 'CA_ooo_client' }));
    await ctx.runner.drain();

    const call = (await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.id, callId)))[0]!;
    expect(call.status).toBe('completed'); // terminal stuck
    expect(call.durationSeconds).toBe(100);
    expect(call.ringingAt?.toISOString()).toBe(t0.toISOString()); // backfilled
    expect(call.answeredAt?.toISOString()).toBe(t1.toISOString()); // backfilled
    expect(call.endedAt?.toISOString()).toBe(t2.toISOString());
  });

  it('the same webhook replayed through processing applies exactly once', async () => {
    const callId = await startCall('CA_dup_client');
    const path = `/webhooks/telnyx/voice-status?call=${callId}&leg=pstn`;
    const params = voiceStatus({ callSid: 'CA_dup_pstn', status: 'ringing', sequence: 1, parentCallSid: 'CA_dup_client' });

    // HTTP-level duplicate (same idempotency key) plus a forced re-process
    // of the same stored event (worker retry semantics).
    await webhookPost(ctx, path, params);
    await webhookPost(ctx, path, params);
    await ctx.runner.drain();

    const webhookRow = (
      await ctx.dbh.db
        .select()
        .from(schema.webhookEvents)
        .where(eq(schema.webhookEvents.providerObjectId, 'CA_dup_pstn'))
    )[0]!;
    // Simulate an at-least-once redelivery of the processing job.
    const { enqueueJob } = await import('@talkr/db');
    await ctx.dbh.db
      .update(schema.webhookEvents)
      .set({ status: 'received' })
      .where(eq(schema.webhookEvents.id, webhookRow.id));
    await enqueueJob(ctx.dbh.db, {
      jobType: 'process-webhook',
      payload: { webhookEventId: webhookRow.id },
      dedupeKey: `process-webhook:${webhookRow.id}:redelivery`,
    });
    await ctx.runner.drain();

    const events = await ctx.dbh.db
      .select()
      .from(schema.callEvents)
      .where(eq(schema.callEvents.callId, callId));
    const ringing = events.filter((e) => e.eventType === 'call.ringing');
    expect(ringing).toHaveLength(1); // dedupe token gate held
  });

  it('a recording webhook for an untracked call becomes an explicit orphan', async () => {
    await webhookPost(
      ctx,
      '/webhooks/telnyx/recording-status',
      recordingStatus({ recordingSid: 'RE_orphan', callSid: 'CA_never_seen', status: 'completed', duration: 10 }),
    );
    await ctx.runner.drain();
    const rows = await ctx.dbh.db
      .select()
      .from(schema.reconciliationMismatches)
      .where(eq(schema.reconciliationMismatches.providerObjectId, 'RE_orphan'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.objectType).toBe('orphan_recording');
  });

  it('a failed recording is visible, not silent', async () => {
    const callId = await startCall('CA_recfail_client');
    const path = `/webhooks/telnyx/voice-status?call=${callId}&leg=pstn`;
    await webhookPost(ctx, path, voiceStatus({ callSid: 'CA_recfail_pstn', status: 'completed', sequence: 1, duration: 40, parentCallSid: 'CA_recfail_client' }));
    await webhookPost(
      ctx,
      `/webhooks/telnyx/recording-status?call=${callId}`,
      recordingStatus({ recordingSid: 'RE_failed', callSid: 'CA_recfail_pstn', status: 'absent' }),
    );
    await ctx.runner.drain();
    const recs = await ctx.dbh.db
      .select()
      .from(schema.recordings)
      .where(eq(schema.recordings.callId, callId));
    expect(recs).toHaveLength(1);
    expect(recs[0]!.status).toBe('failed');
    expect(recs[0]!.errorCode).toBe('absent');
  });
});
