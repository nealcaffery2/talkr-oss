/**
 * Job runner: claims due jobs, executes handlers, applies retry/backoff and
 * dead-letter transitions. Runs as its own process (`npm run worker`) or
 * inline in the API process for dev/tests (WORKER_INLINE=true).
 */

import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { claimJobs, completeJob, failJob, reapStuckJobs, schema } from '@talkr/db';
import type { HandlerDeps, JobHandler } from './handlers.js';

export interface RunnerOptions {
  pollIntervalMs?: number;
  batchSize?: number;
  backoffBaseMs?: number;
  stuckAfterMs?: number;
}

export class JobRunner {
  private readonly workerId = `worker-${randomUUID().slice(0, 8)}`;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;

  constructor(
    private readonly deps: HandlerDeps,
    private readonly handlers: Record<string, JobHandler>,
    private readonly options: RunnerOptions = {},
  ) {}

  /** Process one batch of due jobs. Returns how many jobs ran. Used by tests. */
  async runOnce(): Promise<number> {
    const { dbh, logger } = this.deps;
    const jobs = await claimJobs(dbh.db, {
      workerId: this.workerId,
      limit: this.options.batchSize ?? 10,
    });
    for (const job of jobs) {
      const handler = this.handlers[job.jobType];
      const log = logger.child({ jobId: job.id, jobType: job.jobType, attempt: job.attempts });
      if (!handler) {
        await failJob(dbh.db, job.id, `no handler for job type ${job.jobType}`, {
          backoffBaseMs: this.options.backoffBaseMs,
        });
        log.error('no handler registered');
        continue;
      }
      try {
        await handler(this.deps, job);
        await completeJob(dbh.db, job.id);
        log.info('job succeeded');
      } catch (err) {
        const message = (err as Error).message ?? String(err);
        const status = await failJob(dbh.db, job.id, message, {
          backoffBaseMs: this.options.backoffBaseMs,
        });
        log.warn({ err: message, status }, 'job failed');
        if (status === 'dead') {
          await this.onDead(job.jobType, job.payload as Record<string, unknown>);
        }
      }
    }
    return jobs.length;
  }

  /** Dead-letter side effects: keep linked records honest. */
  private async onDead(jobType: string, payload: Record<string, unknown>): Promise<void> {
    const { dbh } = this.deps;
    if (
      (jobType === 'process-webhook' || jobType === 'process-sms-webhook') &&
      typeof payload.webhookEventId === 'string'
    ) {
      await dbh.db
        .update(schema.webhookEvents)
        .set({ status: 'dead_letter' })
        .where(eq(schema.webhookEvents.id, payload.webhookEventId));
    }
    // A dead send-message job means the provider never accepted the message:
    // mark it failed so the inbox tells the truth (docs/sms.md §5).
    if (jobType === 'send-message' && typeof payload.messageId === 'string') {
      await dbh.db
        .update(schema.messages)
        .set({
          status: 'failed',
          failureClass: 'platform_failure',
          errorCode: 'send_dead_letter',
          failedAt: new Date(),
        })
        .where(
          and(eq(schema.messages.id, payload.messageId), eq(schema.messages.status, 'queued')),
        );
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const interval = this.options.pollIntervalMs ?? 500;
    let sinceReap = 0;
    const tick = async () => {
      if (!this.running) return;
      try {
        const n = await this.runOnce();
        sinceReap += interval;
        if (sinceReap >= 60_000) {
          sinceReap = 0;
          await reapStuckJobs(this.deps.dbh.db, this.options.stuckAfterMs ?? 10 * 60_000);
        }
        // Busy queue: poll again immediately; idle: wait the interval.
        this.timer = setTimeout(tick, n > 0 ? 0 : interval);
      } catch (err) {
        this.deps.logger.error({ err: (err as Error).message }, 'worker tick failed');
        this.timer = setTimeout(tick, interval);
      }
    };
    this.timer = setTimeout(tick, 0);
  }

  stop(): void {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /** Drain helper for tests: run until no due jobs remain (bounded). */
  async drain(maxIterations = 50): Promise<void> {
    for (let i = 0; i < maxIterations; i++) {
      const n = await this.runOnce();
      if (n === 0) return;
    }
    throw new Error('drain did not converge — jobs keep being enqueued');
  }
}
