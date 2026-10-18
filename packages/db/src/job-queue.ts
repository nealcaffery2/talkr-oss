/**
 * Durable Postgres-backed job queue (docs/architecture.md §2).
 * - transactional enqueue (pass the same tx that wrote your business rows)
 * - FOR UPDATE SKIP LOCKED claiming
 * - exponential backoff with jitter; dead-letter after max_attempts
 * - dedupe_key for exactly-once semantics per logical job
 * The interface is intentionally small so BullMQ can replace it later.
 */

import { sql } from 'drizzle-orm';
import { jobs } from './schema.js';
import type { DbLike } from './client.js';

export interface EnqueueInput {
  jobType: string;
  payload?: unknown;
  queue?: string;
  dedupeKey?: string;
  runAt?: Date;
  maxAttempts?: number;
  priority?: number;
  correlationId?: string;
}

export type JobRow = typeof jobs.$inferSelect;

/** Insert a job; a dedupe_key conflict is a silent no-op (already scheduled). */
export async function enqueueJob(db: DbLike, input: EnqueueInput): Promise<JobRow | null> {
  const rows = await db
    .insert(jobs)
    .values({
      jobType: input.jobType,
      payload: input.payload ?? {},
      queue: input.queue ?? 'default',
      dedupeKey: input.dedupeKey,
      runAt: input.runAt ?? new Date(),
      maxAttempts: input.maxAttempts ?? 8,
      priority: input.priority ?? 0,
      correlationId: input.correlationId,
    })
    .onConflictDoNothing({ target: jobs.dedupeKey })
    .returning();
  return rows[0] ?? null;
}

export interface ClaimOptions {
  workerId: string;
  queues?: string[];
  limit?: number;
  /** Only the job with this dedupe_key (a send run the moment it is queued). */
  dedupeKey?: string;
}

/** Claim due jobs. Increments attempts as part of the claim. */
export async function claimJobs(db: DbLike, opts: ClaimOptions): Promise<JobRow[]> {
  const queues = opts.queues ?? ['default'];
  const limit = opts.limit ?? 10;
  const queueList = sql.join(
    queues.map((q) => sql`${q}`),
    sql`, `,
  );
  const result = await db.execute(sql`
    UPDATE jobs SET
      status = 'running',
      locked_at = now(),
      locked_by = ${opts.workerId},
      attempts = attempts + 1,
      updated_at = now()
    WHERE id IN (
      SELECT id FROM jobs
      WHERE status = 'pending'
        AND run_at <= now()
        AND queue IN (${queueList})
        AND (${opts.dedupeKey ?? null}::text IS NULL OR dedupe_key = ${opts.dedupeKey ?? null})
      ORDER BY priority DESC, run_at ASC
      LIMIT ${limit}
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *`);
  return camelizeJobRows(result.rows as Record<string, unknown>[]);
}

export async function completeJob(db: DbLike, jobId: string): Promise<void> {
  await db.execute(sql`
    UPDATE jobs SET status = 'succeeded', locked_at = NULL, locked_by = NULL, updated_at = now()
    WHERE id = ${jobId}`);
}

export interface FailOptions {
  backoffBaseMs?: number;
  backoffCapMs?: number;
}

/**
 * Record a failure: retry with exponential backoff + jitter, or dead-letter
 * once attempts have reached max_attempts. Returns the resulting status.
 */
export async function failJob(
  db: DbLike,
  jobId: string,
  error: string,
  opts: FailOptions = {},
): Promise<'pending' | 'dead'> {
  const base = opts.backoffBaseMs ?? 30_000;
  const cap = opts.backoffCapMs ?? 3_600_000;
  const result = await db.execute(sql`
    UPDATE jobs SET
      status = CASE WHEN attempts >= max_attempts THEN 'dead' ELSE 'pending' END,
      run_at = now() + (
        least(${base} * (2 ^ attempts), ${cap}) * (0.5 + random() / 2) || ' milliseconds'
      )::interval,
      last_error = ${error},
      locked_at = NULL,
      locked_by = NULL,
      updated_at = now()
    WHERE id = ${jobId}
    RETURNING status`);
  return (result.rows[0] as { status: 'pending' | 'dead' }).status;
}

/** Admin replay of a dead-lettered job: fresh attempt budget, runs now. */
export async function retryDeadJob(db: DbLike, jobId: string): Promise<boolean> {
  const result = await db.execute(sql`
    UPDATE jobs SET status = 'pending', attempts = 0, run_at = now(),
      last_error = NULL, updated_at = now()
    WHERE id = ${jobId} AND status = 'dead'
    RETURNING id`);
  return result.rows.length > 0;
}

/** Crash recovery: return long-running claims to pending (lock expired). */
export async function reapStuckJobs(db: DbLike, olderThanMs: number): Promise<number> {
  const result = await db.execute(sql`
    UPDATE jobs SET status = 'pending', locked_at = NULL, locked_by = NULL, updated_at = now()
    WHERE status = 'running' AND locked_at < now() - (${olderThanMs} || ' milliseconds')::interval
    RETURNING id`);
  return result.rows.length;
}

// db.execute returns snake_case columns; map to the drizzle row shape.
function camelizeJobRows(rows: Record<string, unknown>[]): JobRow[] {
  return rows.map((r) => ({
    id: r.id,
    queue: r.queue,
    jobType: r.job_type,
    payload: r.payload,
    dedupeKey: r.dedupe_key,
    status: r.status,
    priority: r.priority,
    runAt: r.run_at,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    lastError: r.last_error,
    lockedAt: r.locked_at,
    lockedBy: r.locked_by,
    correlationId: r.correlation_id,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  })) as JobRow[];
}
