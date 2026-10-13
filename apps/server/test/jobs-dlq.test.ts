/**
 * Job queue semantics: claim, retry with backoff, dead-letter, replay,
 * dedupe, stuck-job reaping (docs/architecture.md §2, telephony-events.md §7).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import {
  claimJobs,
  completeJob,
  enqueueJob,
  failJob,
  reapStuckJobs,
  retryDeadJob,
  schema,
} from '@talkr/db';
import { JobRunner } from '../src/worker/runner.js';
import type { HandlerDeps } from '../src/worker/handlers.js';
import { authHeader, createTestContext, webhookPost, type TestContext } from './helpers.js';
import { voiceStatus } from './fixtures/texml.js';

let ctx: TestContext;

beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => {
  await ctx.close();
});

describe('job queue primitives', () => {
  it('claims due jobs exactly once and completes them', async () => {
    await enqueueJob(ctx.dbh.db, { jobType: 'noop', payload: { n: 1 } });
    const claimedA = await claimJobs(ctx.dbh.db, { workerId: 'w1' });
    const claimedB = await claimJobs(ctx.dbh.db, { workerId: 'w2' });
    expect(claimedA).toHaveLength(1);
    expect(claimedB).toHaveLength(0); // already locked
    await completeJob(ctx.dbh.db, claimedA[0]!.id);
    const row = (await ctx.dbh.db.select().from(schema.jobs).where(eq(schema.jobs.id, claimedA[0]!.id)))[0]!;
    expect(row.status).toBe('succeeded');
  });

  it('dedupe_key makes logical jobs exactly-once', async () => {
    const a = await enqueueJob(ctx.dbh.db, { jobType: 'noop', dedupeKey: 'once-1' });
    const b = await enqueueJob(ctx.dbh.db, { jobType: 'noop', dedupeKey: 'once-1' });
    expect(a).not.toBeNull();
    expect(b).toBeNull();
  });

  it('failures retry with backoff then dead-letter at max_attempts', async () => {
    const job = (await enqueueJob(ctx.dbh.db, { jobType: 'always-fails', maxAttempts: 3 }))!;
    let statuses: string[] = [];
    for (let i = 0; i < 3; i++) {
      const claimed = await claimJobs(ctx.dbh.db, { workerId: 'w1' });
      expect(claimed.map((j) => j.id)).toContain(job.id);
      statuses.push(await failJob(ctx.dbh.db, job.id, `boom ${i}`, { backoffBaseMs: 0 }));
    }
    expect(statuses).toEqual(['pending', 'pending', 'dead']);
    const row = (await ctx.dbh.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id)))[0]!;
    expect(row.status).toBe('dead');
    expect(row.lastError).toBe('boom 2');
  });

  it('applies real exponential backoff to run_at', async () => {
    const job = (await enqueueJob(ctx.dbh.db, { jobType: 'backoff-check', maxAttempts: 5 }))!;
    await claimJobs(ctx.dbh.db, { workerId: 'w1' });
    await failJob(ctx.dbh.db, job.id, 'x', { backoffBaseMs: 60_000 });
    const row = (await ctx.dbh.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id)))[0]!;
    // attempts=1 → base*2^1=120s, jittered to [60s, 120s].
    const deltaMs = row.runAt.getTime() - Date.now();
    expect(deltaMs).toBeGreaterThan(50_000);
    expect(deltaMs).toBeLessThanOrEqual(125_000);
  });

  it('replays dead jobs with a fresh attempt budget', async () => {
    const job = (await enqueueJob(ctx.dbh.db, { jobType: 'dead-then-replay', maxAttempts: 1 }))!;
    await claimJobs(ctx.dbh.db, { workerId: 'w1' });
    expect(await failJob(ctx.dbh.db, job.id, 'boom', { backoffBaseMs: 0 })).toBe('dead');
    expect(await retryDeadJob(ctx.dbh.db, job.id)).toBe(true);
    const row = (await ctx.dbh.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id)))[0]!;
    expect(row.status).toBe('pending');
    expect(row.attempts).toBe(0);
  });

  it('reaps stuck running jobs back to pending', async () => {
    const job = (await enqueueJob(ctx.dbh.db, { jobType: 'stuck' }))!;
    await claimJobs(ctx.dbh.db, { workerId: 'w-crashed' });
    await ctx.dbh.db.execute(sql`
      UPDATE jobs SET locked_at = now() - interval '1 hour' WHERE id = ${job.id}`);
    const reaped = await reapStuckJobs(ctx.dbh.db, 10 * 60_000);
    expect(reaped).toBeGreaterThanOrEqual(1);
    const row = (await ctx.dbh.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id)))[0]!;
    expect(row.status).toBe('pending');
  });
});

describe('webhook dead-letter + admin replay', () => {
  it('a webhook whose processing keeps failing dead-letters, then replays clean', async () => {
    // A poison handler: normalization succeeds but apply explodes. We simulate
    // by pointing a runner at a handler set whose process-webhook always throws.
    const params = voiceStatus({ callSid: 'CA_poison', status: 'ringing', sequence: 1 });
    await webhookPost(ctx, '/webhooks/telnyx/voice-status?call=none', params);

    const webhookRow = (
      await ctx.dbh.db
        .select()
        .from(schema.webhookEvents)
        .where(eq(schema.webhookEvents.providerObjectId, 'CA_poison'))
    )[0]!;

    const poisonDeps: HandlerDeps = {
      dbh: ctx.dbh,
      provider: ctx.provider,
      podio: ctx.podio,
      config: { ...ctx.deps.config, JOB_BACKOFF_BASE_MS: 0 },
      logger: ctx.deps.logger,
    };
    const poisonRunner = new JobRunner(
      poisonDeps,
      {
        'process-webhook': async () => {
          throw new Error('simulated poison payload');
        },
      },
      { backoffBaseMs: 0 },
    );
    // Job max_attempts default is 8; run enough batches to exhaust it.
    for (let i = 0; i < 10; i++) await poisonRunner.runOnce();

    const jobRow = (
      await ctx.dbh.db
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.dedupeKey, `process-webhook:${webhookRow.id}`))
    )[0]!;
    expect(jobRow.status).toBe('dead');
    expect(jobRow.attempts).toBe(8);
    const deadWebhook = (
      await ctx.dbh.db
        .select()
        .from(schema.webhookEvents)
        .where(eq(schema.webhookEvents.id, webhookRow.id))
    )[0]!;
    expect(deadWebhook.status).toBe('dead_letter');

    // Admin replays the webhook event through the REAL handler; the orphan
    // path handles it cleanly (call=none is unknown → explicit orphan).
    const adminAuth = await authHeader('auth-admin-test-org');
    const replay = await ctx.app.inject({
      method: 'POST',
      url: `/v1/admin/webhook-events/${webhookRow.id}/replay`,
      headers: adminAuth,
    });
    expect(replay.statusCode).toBe(200);
    await ctx.runner.drain();
    const replayed = (
      await ctx.dbh.db
        .select()
        .from(schema.webhookEvents)
        .where(eq(schema.webhookEvents.id, webhookRow.id))
    )[0]!;
    expect(replayed.status).toBe('processed');
  });

  it('podio outage retries and eventually syncs without double-posting', async () => {
    const repAuth = await authHeader('auth-rep-test-org');
    const create = await ctx.app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: repAuth,
      payload: { lead_id: ctx.seed.leadId },
    });
    const callId = (create.json() as { call: { id: string } }).call.id;

    ctx.podio.failuresRemaining = 2; // two 503s, then healthy
    const before = ctx.podio.comments.length;
    await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/disposition`,
      headers: repAuth,
      payload: { disposition: 'voicemail' },
    });
    await ctx.runner.drain();

    expect(ctx.podio.comments.length).toBe(before + 1);
    const call = (await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.id, callId)))[0]!;
    expect(call.crmSyncStatus).toBe('synced');
  });
});
