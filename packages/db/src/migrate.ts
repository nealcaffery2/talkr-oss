/**
 * Minimal, dependency-free migration runner: applies packages/db/migrations/*.sql
 * in lexical order, once each, recorded in _talkr_migrations. Statements are
 * split on drizzle-kit's `--> statement-breakpoint` marker.
 *
 * Locking: the whole pending set runs in ONE transaction under
 * pg_advisory_xact_lock. Production sits behind a transaction-mode pooler
 * (Supavisor), where a session-level pg_advisory_lock and its later
 * pg_advisory_unlock can land on different backends; the lock then outlives
 * the instance that took it and every later cold boot blocks on it until the
 * pooled backend is recycled (seen as 60 s FUNCTION_INVOCATION_TIMEOUTs after
 * deploys). A transaction-scoped lock cannot leak: it is released at COMMIT
 * or ROLLBACK, and inside one transaction the pooler pins one backend.
 *
 * The common boot — nothing pending — never takes the lock at all.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type pg from 'pg';

const DEFAULT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const LOCK_KEY = 727272;
/** Another instance mid-migration is worth waiting for; a stuck lock is not. */
const LOCK_TIMEOUT_MS = 20_000;

async function appliedNames(client: pg.PoolClient): Promise<Set<string>> {
  const res = await client.query('SELECT name FROM _talkr_migrations');
  return new Set(res.rows.map((r) => r.name as string));
}

export async function migrate(pool: pg.Pool, migrationsDir: string = DEFAULT_DIR): Promise<string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS _talkr_migrations (
        name text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();

    // Fast path: up to date. Two cheap reads, no lock, no transaction.
    const done = await appliedNames(client);
    if (files.every((f) => done.has(f))) return applied;

    await client.query('BEGIN');
    try {
      await client.query(`SET LOCAL lock_timeout = '${LOCK_TIMEOUT_MS}ms'`);
      await client.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
      // Re-read under the lock: a sibling instance may have finished meanwhile.
      const doneNow = await appliedNames(client);
      for (const file of files) {
        if (doneNow.has(file)) continue;
        const sql = await readFile(join(migrationsDir, file), 'utf8');
        const statements = sql
          .split(/-->\s*statement-breakpoint/)
          .map((s) => s.trim())
          .filter(Boolean);
        try {
          for (const stmt of statements) await client.query(stmt);
          await client.query('INSERT INTO _talkr_migrations (name) VALUES ($1)', [file]);
        } catch (err) {
          throw new Error(`migration ${file} failed: ${(err as Error).message}`, { cause: err });
        }
        applied.push(file);
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      applied.length = 0;
      throw err;
    }
  } finally {
    client.release();
  }
  return applied;
}
