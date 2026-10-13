/**
 * contact-temperature-sweep (docs/contacts.md §4): keeps `temperature`,
 * `temperature_score` and `last_activity_at` on contacts current.
 *
 * Two shapes of job share the handler:
 * - targeted — payload `{ orgId, contactIds }`, queued by the API when a
 *   status edit, bulk status change or import changed a contact's inputs;
 * - the hourly sweep — empty payload, deduped per hour by worker-main /
 *   the serverless tick. Per org it rescores contacts with a call or text
 *   in the last two hours (direct/lead linkage) plus a bounded slice of
 *   contacts whose score is missing or older than twelve hours, oldest
 *   first, so every contact decays on schedule without scanning the table.
 *
 * Idempotent by construction: scores are recomputed from the rows, never
 * incremented, so a re-run after a crash lands on the same numbers.
 */

import { enqueueJob, schema, type DbLike } from '@talkr/db';
import {
  recentlyActiveContactIds,
  rescoreContacts,
  staleContactIds,
} from '../services/contact-temperature.js';
import type { JobHandler } from './handlers.js';

export const CONTACT_SWEEP_JOB = 'contact-temperature-sweep';
/** How far back "recently active" reaches; overlaps the hourly cadence. */
const RECENT_ACTIVITY_MS = 2 * 60 * 60_000;
/** A score older than this is recomputed even without new activity. */
const STALE_AFTER_MS = 12 * 60 * 60_000;
/** Stale contacts rescored per org per run — bounds the sweep's cost. */
const STALE_BATCH = 500;
const RESCORE_CHUNK = 200;

interface SweepPayload {
  orgId?: string;
  contactIds?: string[];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export const contactTemperatureSweep: JobHandler = async (deps, job) => {
  const { dbh, logger } = deps;
  const payload = (job.payload ?? {}) as SweepPayload;
  const now = new Date();

  if (payload.orgId && payload.contactIds?.length) {
    let updated = 0;
    for (const ids of chunk(payload.contactIds, RESCORE_CHUNK)) {
      updated += (await rescoreContacts(dbh.db, payload.orgId, ids, now)).length;
    }
    logger.info({ orgId: payload.orgId, requested: payload.contactIds.length, updated }, 'contact rescore complete');
    return;
  }

  const orgs = await dbh.db.select({ id: schema.organizations.id }).from(schema.organizations);
  let updated = 0;
  for (const org of orgs) {
    const recent = await recentlyActiveContactIds(dbh.db, org.id, new Date(now.getTime() - RECENT_ACTIVITY_MS));
    const stale = await staleContactIds(dbh.db, org.id, new Date(now.getTime() - STALE_AFTER_MS), STALE_BATCH);
    const ids = [...new Set([...recent, ...stale])];
    for (const batch of chunk(ids, RESCORE_CHUNK)) {
      updated += (await rescoreContacts(dbh.db, org.id, batch, now)).length;
    }
  }
  logger.info({ orgs: orgs.length, updated }, 'contact temperature sweep complete');
};

/** Hourly, deduped per hour so restarts and multiple workers collapse into one run. */
/**
 * Rescore named contacts now, rather than waiting for the hourly sweep to
 * reach them. Used wherever something that feeds the score has just changed:
 * a status edit or an import (routes/contacts.ts), or a call score landing
 * with a fresh seller read (worker/score-handlers.ts).
 */
export async function enqueueContactRescore(
  db: DbLike,
  orgId: string,
  contactIds: string[],
): Promise<void> {
  const ids = [...new Set(contactIds)].filter(Boolean);
  if (ids.length === 0) return;
  for (const batch of chunk(ids, 500)) {
    await enqueueJob(db, { jobType: CONTACT_SWEEP_JOB, payload: { orgId, contactIds: batch } });
  }
}

export async function scheduleContactTemperatureSweep(db: DbLike, at: Date = new Date()): Promise<void> {
  const hour = at.toISOString().slice(0, 13);
  await enqueueJob(db, {
    jobType: CONTACT_SWEEP_JOB,
    payload: {},
    dedupeKey: `${CONTACT_SWEEP_JOB}:${hour}`,
  });
}
