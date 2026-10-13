/**
 * Sequence enrollment (docs/sequences.md §2). A sequence is a workflow row
 * with kind = 'sequence' and trigger_type = 'manual'; nothing in the trigger
 * feed ever starts one. Runs exist only because someone enrolled a lead here:
 *
 *  - the caller's lead ids, contact ids or phone numbers are resolved to lead
 *    rows (a contact with no lead gets a minimal one, like /v1/leads does);
 *  - one run per lead is inserted through createRunForWorkflow, so the
 *    engine's unique (workflow_id, trigger_source, trigger_event_id) key —
 *    ('manual', lead id) here — makes enrollment exactly-once per lead per
 *    sequence, and the run's job is enqueued in the same transaction;
 *  - unenroll marks the lead's active run `stopped / unenrolled`; the engine
 *    re-reads run status before every action, so an in-flight run ends at
 *    its next step and a parked one never sends again.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { normalizePhone } from '@talkr/core';
import { schema, type DbHandle, type DbLike } from '@talkr/db';
import type { AuthContext } from '../auth.js';
import { createRunForWorkflow } from '../worker/workflow-fanout.js';
import { writeAudit } from './audit.js';

type WorkflowRow = typeof schema.workflows.$inferSelect;

/** Runs that can still do something: a stop request applies to these. */
export const ACTIVE_RUN_STATUSES = ['pending', 'running', 'waiting'] as const;

/** Hard cap on one enroll call, across lead_ids + contact_ids + phones. */
export const MAX_ENROLL_BATCH = 500;

export interface EnrollInput {
  leadIds: string[];
  contactIds: string[];
  phones: string[];
}

export interface EnrollSkip {
  /** The id or phone the caller sent. */
  ref: string;
  reason: 'lead_not_found' | 'contact_not_found' | 'invalid_phone' | 'unknown_phone';
}

export interface EnrollResult {
  enrolled: number;
  already_enrolled: number;
  skipped: number;
  skipped_details: EnrollSkip[];
}

/** The lead behind a contact: the newest one, or a fresh minimal row. */
async function leadForContact(
  db: DbLike,
  ctx: AuthContext,
  contactId: string,
): Promise<{ id: string; created: boolean }> {
  const existing = (
    await db
      .select({ id: schema.leads.id })
      .from(schema.leads)
      .where(and(eq(schema.leads.orgId, ctx.orgId), eq(schema.leads.primaryContactId, contactId)))
      .orderBy(desc(schema.leads.createdAt))
      .limit(1)
  )[0];
  if (existing) return { id: existing.id, created: false };
  // Same minimal shape as POST /v1/leads, minus the contact it already has.
  const row = (
    await db
      .insert(schema.leads)
      .values({
        orgId: ctx.orgId,
        source: 'sequence',
        primaryContactId: contactId,
        receivedAt: new Date(),
      })
      .returning({ id: schema.leads.id })
  )[0]!;
  await writeAudit(db, {
    orgId: ctx.orgId,
    actorType: 'user',
    actorId: ctx.userId,
    action: 'lead.create',
    objectType: 'lead',
    objectId: row.id,
    metadata: { source: 'sequence', contact_id: contactId },
  });
  return { id: row.id, created: true };
}

export async function enrollInSequence(
  dbh: DbHandle,
  ctx: AuthContext,
  sequence: WorkflowRow,
  input: EnrollInput,
): Promise<EnrollResult> {
  const { db } = dbh;
  const skipped: EnrollSkip[] = [];
  /** lead id → the caller's reference for it (first one wins). */
  const leads = new Map<string, string>();

  // ── lead_ids: must exist in this org ─────────────────────────────────────
  if (input.leadIds.length > 0) {
    const found = new Set(
      (
        await db
          .select({ id: schema.leads.id })
          .from(schema.leads)
          .where(and(eq(schema.leads.orgId, ctx.orgId), inArray(schema.leads.id, input.leadIds)))
      ).map((r) => r.id),
    );
    for (const id of input.leadIds) {
      if (found.has(id)) leads.set(id, id);
      else skipped.push({ ref: id, reason: 'lead_not_found' });
    }
  }

  // ── contact_ids: find-or-create the lead ─────────────────────────────────
  const contactRefs: Array<{ contactId: string; ref: string }> = [];
  if (input.contactIds.length > 0) {
    const found = new Set(
      (
        await db
          .select({ id: schema.contacts.id })
          .from(schema.contacts)
          .where(and(eq(schema.contacts.orgId, ctx.orgId), inArray(schema.contacts.id, input.contactIds)))
      ).map((r) => r.id),
    );
    for (const id of input.contactIds) {
      if (found.has(id)) contactRefs.push({ contactId: id, ref: id });
      else skipped.push({ ref: id, reason: 'contact_not_found' });
    }
  }

  // ── phones: E.164 → contact_phones → contact → lead ──────────────────────
  for (const raw of input.phones) {
    const normalized = normalizePhone(raw);
    if (!normalized.ok || normalized.e164.startsWith('client:')) {
      skipped.push({ ref: raw, reason: 'invalid_phone' });
      continue;
    }
    const phone = (
      await db
        .select({ contactId: schema.contactPhones.contactId })
        .from(schema.contactPhones)
        .where(
          and(
            eq(schema.contactPhones.orgId, ctx.orgId),
            eq(schema.contactPhones.phoneE164, normalized.e164),
          ),
        )
        .orderBy(sql`${schema.contactPhones.isPrimary} DESC`)
        .limit(1)
    )[0];
    if (!phone) {
      skipped.push({ ref: raw, reason: 'unknown_phone' });
      continue;
    }
    contactRefs.push({ contactId: phone.contactId, ref: raw });
  }

  for (const { contactId, ref } of contactRefs) {
    const lead = await db.transaction((tx) => leadForContact(tx, ctx, contactId));
    if (!leads.has(lead.id)) leads.set(lead.id, ref);
  }

  // ── One run per lead, exactly once, job enqueued in the same tx ──────────
  let enrolled = 0;
  let alreadyEnrolled = 0;
  for (const leadId of leads.keys()) {
    const runId = await db.transaction((tx) =>
      createRunForWorkflow(tx, sequence, {
        orgId: ctx.orgId,
        triggerSource: 'manual',
        triggerEventId: leadId,
        leadId,
      }),
    );
    if (runId) enrolled += 1;
    else alreadyEnrolled += 1;
  }

  await writeAudit(db, {
    orgId: ctx.orgId,
    actorType: 'user',
    actorId: ctx.userId,
    action: 'sequence.enroll',
    objectType: 'workflow',
    objectId: sequence.id,
    metadata: { enrolled, already_enrolled: alreadyEnrolled, skipped: skipped.length },
  });

  return { enrolled, already_enrolled: alreadyEnrolled, skipped: skipped.length, skipped_details: skipped };
}

/**
 * Stop the active runs of these leads. Returns how many were stopped; leads
 * with no active run are simply not counted (nothing to stop is not an error).
 */
export async function unenrollFromSequence(
  dbh: DbHandle,
  ctx: AuthContext,
  sequence: WorkflowRow,
  leadIds: string[],
): Promise<number> {
  if (leadIds.length === 0) return 0;
  const stopped = await stopRuns(dbh.db, sequence.id, 'unenrolled', leadIds);
  await writeAudit(dbh.db, {
    orgId: ctx.orgId,
    actorType: 'user',
    actorId: ctx.userId,
    action: 'sequence.unenroll',
    objectType: 'workflow',
    objectId: sequence.id,
    metadata: { requested: leadIds.length, stopped },
  });
  return stopped;
}

/** Mark active runs stopped with a reason; all of the sequence's when no leads are given. */
export async function stopRuns(
  db: DbLike,
  sequenceId: string,
  reason: string,
  leadIds?: string[],
): Promise<number> {
  const rows = await db
    .update(schema.workflowRuns)
    .set({ status: 'stopped', stoppedReason: reason, resumeAt: null, finishedAt: new Date() })
    .where(
      and(
        eq(schema.workflowRuns.workflowId, sequenceId),
        inArray(schema.workflowRuns.status, [...ACTIVE_RUN_STATUSES]),
        leadIds ? inArray(schema.workflowRuns.leadId, leadIds) : undefined,
      ),
    )
    .returning({ id: schema.workflowRuns.id });
  return rows.length;
}

export async function countActiveRuns(db: DbLike, sequenceId: string): Promise<number> {
  const row = (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.workflowRuns)
      .where(
        and(
          eq(schema.workflowRuns.workflowId, sequenceId),
          inArray(schema.workflowRuns.status, [...ACTIVE_RUN_STATUSES]),
        ),
      )
  )[0];
  return row?.n ?? 0;
}

export interface SequenceStats {
  enrolled: number;
  /** In flight: pending, running or waiting. */
  active: number;
  waiting: number;
  completed: number;
  stopped: number;
  failed: number;
  /** Leads that sent an inbound message after enrollment, whatever the exit rules say. */
  replied: number;
}

const EMPTY_STATS: SequenceStats = {
  enrolled: 0,
  active: 0,
  waiting: 0,
  completed: 0,
  stopped: 0,
  failed: 0,
  replied: 0,
};

export function emptyStats(): SequenceStats {
  return { ...EMPTY_STATS };
}

/** Per-sequence run counts for the org (or one sequence), keyed by workflow id. */
export async function sequenceStats(
  db: DbLike,
  orgId: string,
  sequenceId?: string,
): Promise<Map<string, SequenceStats>> {
  const rows = (
    await db.execute(sql`
      SELECT r.workflow_id,
             count(*)::int AS enrolled,
             count(*) FILTER (WHERE r.status IN ('pending', 'running', 'waiting'))::int AS active,
             count(*) FILTER (WHERE r.status = 'waiting')::int AS waiting,
             count(*) FILTER (WHERE r.status = 'succeeded')::int AS completed,
             count(*) FILTER (WHERE r.status = 'stopped')::int AS stopped,
             count(*) FILTER (WHERE r.status = 'failed')::int AS failed,
             count(*) FILTER (WHERE EXISTS (
               SELECT 1 FROM messages m
               JOIN conversations c ON c.id = m.conversation_id
               WHERE m.direction = 'inbound'
                 AND m.created_at > r.created_at
                 AND c.lead_id = r.lead_id
             ))::int AS replied
      FROM workflow_runs r
      JOIN workflows w ON w.id = r.workflow_id
      WHERE r.org_id = ${orgId}
        AND w.kind = 'sequence'
        ${sequenceId ? sql`AND r.workflow_id = ${sequenceId}` : sql``}
      GROUP BY r.workflow_id`)
  ).rows as unknown as Array<SequenceStats & { workflow_id: string }>;
  const out = new Map<string, SequenceStats>();
  for (const r of rows) {
    out.set(String(r.workflow_id), {
      enrolled: Number(r.enrolled),
      active: Number(r.active),
      waiting: Number(r.waiting),
      completed: Number(r.completed),
      stopped: Number(r.stopped),
      failed: Number(r.failed),
      replied: Number(r.replied),
    });
  }
  return out;
}

export interface SequenceRunRow {
  run: typeof schema.workflowRuns.$inferSelect;
  leadStatus: string | null;
  leadName: string | null;
  phone: string | null;
}

/** Newest runs of a sequence with the lead's name, phone and status joined in. */
export async function listSequenceRuns(db: DbLike, sequenceId: string, limit = 50): Promise<SequenceRunRow[]> {
  return db
    .select({
      run: schema.workflowRuns,
      leadStatus: schema.leads.status,
      leadName: schema.contacts.displayName,
      phone: sql<string | null>`(
        SELECT cp.phone_e164 FROM contact_phones cp
        WHERE cp.contact_id = ${schema.contacts.id}
        ORDER BY cp.is_primary DESC
        LIMIT 1)`,
    })
    .from(schema.workflowRuns)
    .leftJoin(schema.leads, eq(schema.leads.id, schema.workflowRuns.leadId))
    .leftJoin(schema.contacts, eq(schema.contacts.id, schema.leads.primaryContactId))
    .where(eq(schema.workflowRuns.workflowId, sequenceId))
    .orderBy(desc(schema.workflowRuns.createdAt))
    .limit(limit);
}
