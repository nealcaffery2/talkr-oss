/**
 * Webhook ingestion: signature gate, raw persistence, dedupe, transactional
 * enqueue, fast ack (docs/telephony-events.md §1).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { createTestContext, webhookPost, type TestContext } from './helpers.js';
import { voiceStatus } from './fixtures/texml.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('webhook ingestion', () => {
  it('still accepts the legacy /webhooks/twilio/ path that older Telnyx setups point at', async () => {
    const params = voiceStatus({ callSid: 'CA_ingest_legacy', status: 'ringing', sequence: 1 });
    const res = await webhookPost(ctx, '/webhooks/twilio/voice-status?call=none&leg=pstn', params);
    expect(res.statusCode).toBe(200);
    const rows = await ctx.dbh.db
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.providerObjectId, 'CA_ingest_legacy'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provider).toBe('telnyx');
  });

  it('persists the raw delivery and enqueues processing on a valid signature', async () => {
    const params = voiceStatus({ callSid: 'CA_ingest_1', status: 'ringing', sequence: 1 });
    const res = await webhookPost(ctx, '/webhooks/telnyx/voice-status?call=none&leg=pstn', params);
    expect(res.statusCode).toBe(200);

    const rows = await ctx.dbh.db
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.providerObjectId, 'CA_ingest_1'));
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.signatureValid).toBe(true);
    expect(row.status).toBe('received');
    expect(row.rawBody).toContain('CallSid=CA_ingest_1');
    expect(row.rawBody).toContain('CallStatus=ringing');
    expect((row.headers as Record<string, string>)['telnyx-signature-ed25519']).toBeTruthy();
    // Query params merged into parsed for downstream call resolution.
    expect((row.parsed as Record<string, string>).leg).toBe('pstn');

    const jobs = await ctx.dbh.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.dedupeKey, `process-webhook:${row.id}`));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.status).toBe('pending');
  });

  it('acks duplicate deliveries without duplicating records or jobs', async () => {
    const params = voiceStatus({ callSid: 'CA_ingest_2', status: 'ringing', sequence: 1 });
    const first = await webhookPost(ctx, '/webhooks/telnyx/voice-status', params);
    const second = await webhookPost(ctx, '/webhooks/telnyx/voice-status', params);
    const third = await webhookPost(ctx, '/webhooks/telnyx/voice-status', params);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(200);

    const rows = await ctx.dbh.db
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.providerObjectId, 'CA_ingest_2'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.duplicateCount).toBe(2);

    const jobs = await ctx.dbh.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.dedupeKey, `process-webhook:${rows[0]!.id}`));
    expect(jobs).toHaveLength(1);
  });

  it('treats a different SequenceNumber as a distinct event', async () => {
    const p1 = voiceStatus({ callSid: 'CA_ingest_3', status: 'ringing', sequence: 1 });
    const p2 = voiceStatus({ callSid: 'CA_ingest_3', status: 'in-progress', sequence: 2 });
    await webhookPost(ctx, '/webhooks/telnyx/voice-status', p1);
    await webhookPost(ctx, '/webhooks/telnyx/voice-status', p2);
    const rows = await ctx.dbh.db
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.providerObjectId, 'CA_ingest_3'));
    expect(rows).toHaveLength(2);
  });

  it('rejects an invalid signature with 403, logs the attempt, enqueues nothing', async () => {
    const params = voiceStatus({ callSid: 'CA_ingest_4', status: 'ringing', sequence: 1 });
    const res = await webhookPost(ctx, '/webhooks/telnyx/voice-status', params, {
      tamperSignature: true,
    });
    expect(res.statusCode).toBe(403);

    const rows = await ctx.dbh.db
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.providerObjectId, 'CA_ingest_4'));
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe('rejected');
    expect(rows[0]!.signatureValid).toBe(false);

    const jobs = await ctx.dbh.db.select().from(schema.jobs);
    expect(jobs.filter((j) => (j.payload as { webhookEventId?: string }).webhookEventId === rows[0]!.id)).toHaveLength(0);
  });
});
