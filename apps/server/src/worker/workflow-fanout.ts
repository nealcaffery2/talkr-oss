/**
 * Workflow trigger feed (Phase 7 — docs/workflows.md §2-3). Modeled on the
 * Phase 10 webhook-fanout: a cursor-tailing sweep over append-only sources
 * that NEVER touches apply-events.ts. Exactly-once is structural — the
 * unique (workflow_id, trigger_source, trigger_event_id) constraint on
 * workflow_runs absorbs the 5-minute overlap re-scan, duplicate upstream
 * applications, and concurrent sweeps.
 *
 * Loop safety at the feed level (docs/workflows.md §7):
 *  - message.received reads the messages table filtered direction='inbound';
 *    workflow-sent SMS are outbound rows and structurally invisible.
 *  - call/disposition/lead sources cannot be written by any workflow action.
 *  - no_contact_for_days dedupes on a period bucket, at most one fire per
 *    lead per workflow per N-day period.
 */

import { and, asc, eq, gt, inArray, lt, lte, sql } from 'drizzle-orm';
import { enqueueJob, schema, type DbLike } from '@talkr/db';
import type { JobHandler } from './handlers.js';

/** Terminal call facts; the sources of both call triggers. */
const TERMINAL_CALL_EVENTS = [
  'call.completed',
  'call.no_answer',
  'call.busy',
  'call.failed',
  'call.canceled',
];

/** Re-scan window (same as Phase 10): late commits are never missed. */
const OVERLAP_MS = 5 * 60_000;
const BATCH_SIZE = 500;

type WorkflowRow = typeof schema.workflows.$inferSelect;

interface TriggerCandidate {
  orgId: string;
  /** workflow_runs.trigger_source */
  triggerSource: string;
  /** workflow_runs.trigger_event_id */
  triggerEventId: string;
  leadId: string | null;
  /** Source-row commit time; workflows created after it do not fire (no history). */
  createdAt: Date;
}

// ---------------------------------------------------------------------------
// Cursors: reuse webhook_fanout_cursors under workflow:* keys (docs §3.1 —
// identical shape and access pattern; a second table would add surface with
// zero isolation benefit).
// ---------------------------------------------------------------------------

async function readCursor(db: DbLike, source: string, now: Date): Promise<Date> {
  const row = (
    await db
      .select()
      .from(schema.webhookFanoutCursors)
      .where(eq(schema.webhookFanoutCursors.source, source))
      .limit(1)
  )[0];
  if (row) return row.cursorAt;
  const initial = new Date(now.getTime() - OVERLAP_MS);
  await db
    .insert(schema.webhookFanoutCursors)
    .values({ source, cursorAt: initial })
    .onConflictDoNothing();
  return initial;
}

async function writeCursor(db: DbLike, source: string, cursorAt: Date): Promise<void> {
  await db
    .update(schema.webhookFanoutCursors)
    .set({ cursorAt, updatedAt: new Date() })
    .where(
      and(
        eq(schema.webhookFanoutCursors.source, source),
        sql`${schema.webhookFanoutCursors.cursorAt} < ${cursorAt}`,
      ),
    );
}

// ---------------------------------------------------------------------------
// Candidate collection per source
// ---------------------------------------------------------------------------

/** Terminal call events → call.completed and call.missed candidates, keyed
 * on the CALL id (a call can journal several terminal facts; the run key
 * makes each call trigger at most once per call — docs §2). */
async function collectCallCandidates(
  db: DbLike,
  scanFrom: Date,
): Promise<{ candidates: TriggerCandidate[]; maxCreatedAt: Date | null }> {
  const rows = await db
    .select()
    .from(schema.callEvents)
    .where(
      and(
        gt(schema.callEvents.createdAt, scanFrom),
        inArray(schema.callEvents.eventType, TERMINAL_CALL_EVENTS),
      ),
    )
    .orderBy(asc(schema.callEvents.createdAt))
    .limit(BATCH_SIZE);
  if (rows.length === 0) return { candidates: [], maxCreatedAt: null };

  const callIds = [...new Set(rows.map((r) => r.callId))];
  const calls = await db.select().from(schema.calls).where(inArray(schema.calls.id, callIds));
  const callById = new Map(calls.map((c) => [c.id, c]));

  const candidates: TriggerCandidate[] = [];
  for (const row of rows) {
    const call = callById.get(row.callId);
    if (!call) continue;
    if (row.eventType === 'call.completed') {
      candidates.push({
        orgId: call.orgId,
        triggerSource: 'call.completed',
        triggerEventId: call.id,
        leadId: call.leadId,
        createdAt: row.createdAt,
      });
    }
    // Phase 6 missed definition: inbound ∧ never answered ∧ terminal.
    if (call.direction === 'inbound' && call.answeredAt == null) {
      candidates.push({
        orgId: call.orgId,
        triggerSource: 'call.missed',
        triggerEventId: call.id,
        leadId: call.leadId,
        createdAt: row.createdAt,
      });
    }
  }
  return { candidates, maxCreatedAt: rows[rows.length - 1]!.createdAt };
}

/** Audit tail (Phase 10 precedent): a wrap-up is a call.disposition row. */
async function collectDispositionCandidates(
  db: DbLike,
  scanFrom: Date,
): Promise<{ candidates: TriggerCandidate[]; maxCreatedAt: Date | null }> {
  const rows = await db
    .select()
    .from(schema.auditLog)
    .where(
      and(gt(schema.auditLog.createdAt, scanFrom), eq(schema.auditLog.action, 'call.disposition')),
    )
    .orderBy(asc(schema.auditLog.createdAt))
    .limit(BATCH_SIZE);
  if (rows.length === 0) return { candidates: [], maxCreatedAt: null };

  const callIds = [...new Set(rows.map((r) => r.objectId).filter((v): v is string => !!v))];
  const calls = callIds.length
    ? await db.select().from(schema.calls).where(inArray(schema.calls.id, callIds))
    : [];
  const callById = new Map(calls.map((c) => [c.id, c]));

  const candidates: TriggerCandidate[] = [];
  for (const row of rows) {
    if (!row.orgId || !row.objectId) continue;
    const call = callById.get(row.objectId);
    candidates.push({
      orgId: row.orgId,
      triggerSource: 'disposition.created',
      triggerEventId: `audit:${row.id}`,
      leadId: call?.leadId ?? null,
      createdAt: row.createdAt,
    });
  }
  return { candidates, maxCreatedAt: rows[rows.length - 1]!.createdAt };
}

/** Inbound messages only — the direction filter IS the loop guard. */
async function collectInboundMessageCandidates(
  db: DbLike,
  scanFrom: Date,
): Promise<{ candidates: TriggerCandidate[]; maxCreatedAt: Date | null }> {
  const rows = await db
    .select()
    .from(schema.messages)
    .where(and(gt(schema.messages.createdAt, scanFrom), eq(schema.messages.direction, 'inbound')))
    .orderBy(asc(schema.messages.createdAt))
    .limit(BATCH_SIZE);
  if (rows.length === 0) return { candidates: [], maxCreatedAt: null };

  const convoIds = [...new Set(rows.map((r) => r.conversationId))];
  const convos = await db
    .select()
    .from(schema.conversations)
    .where(inArray(schema.conversations.id, convoIds));
  const convoById = new Map(convos.map((c) => [c.id, c]));

  const candidates: TriggerCandidate[] = rows.map((row) => ({
    orgId: row.orgId,
    triggerSource: 'message.received',
    triggerEventId: row.id,
    leadId: convoById.get(row.conversationId)?.leadId ?? null,
    createdAt: row.createdAt,
  }));
  return { candidates, maxCreatedAt: rows[rows.length - 1]!.createdAt };
}

async function collectLeadCandidates(
  db: DbLike,
  scanFrom: Date,
): Promise<{ candidates: TriggerCandidate[]; maxCreatedAt: Date | null }> {
  const rows = await db
    .select()
    .from(schema.leads)
    .where(gt(schema.leads.createdAt, scanFrom))
    .orderBy(asc(schema.leads.createdAt))
    .limit(BATCH_SIZE);
  if (rows.length === 0) return { candidates: [], maxCreatedAt: null };
  const candidates: TriggerCandidate[] = rows.map((row) => ({
    orgId: row.orgId,
    triggerSource: 'lead.created',
    triggerEventId: row.id,
    leadId: row.id,
    createdAt: row.createdAt,
  }));
  return { candidates, maxCreatedAt: rows[rows.length - 1]!.createdAt };
}

// ---------------------------------------------------------------------------
// Fan-out: candidate × matching enabled workflow → run + job, exactly once
// ---------------------------------------------------------------------------

async function loadWorkflowsByOrg(
  db: DbLike,
  orgIds: string[],
  triggerTypes: string[],
): Promise<Map<string, WorkflowRow[]>> {
  const map = new Map<string, WorkflowRow[]>();
  if (orgIds.length === 0) return map;
  const rows = await db
    .select()
    .from(schema.workflows)
    .where(
      and(
        eq(schema.workflows.enabled, true),
        inArray(schema.workflows.orgId, orgIds),
        inArray(schema.workflows.triggerType, triggerTypes),
      ),
    );
  for (const row of rows) {
    const list = map.get(row.orgId) ?? [];
    list.push(row);
    map.set(row.orgId, list);
  }
  return map;
}

/** Insert the run + enqueue its job; a unique-key conflict is a silent no-op. */
export async function createRunForWorkflow(
  tx: DbLike,
  workflow: WorkflowRow,
  candidate: Omit<TriggerCandidate, 'createdAt'>,
): Promise<string | null> {
  const inserted = await tx
    .insert(schema.workflowRuns)
    .values({
      orgId: candidate.orgId,
      workflowId: workflow.id,
      triggerSource: candidate.triggerSource,
      triggerEventId: candidate.triggerEventId,
      leadId: candidate.leadId,
    })
    .onConflictDoNothing()
    .returning({ id: schema.workflowRuns.id });
  const runId = inserted[0]?.id;
  if (!runId) return null; // already fanned out — the exactly-once guard
  await enqueueJob(tx, {
    jobType: 'workflow-run',
    payload: { runId },
    dedupeKey: `workflow-run:${runId}`,
  });
  return runId;
}

export const workflowFanout: JobHandler = async (deps) => {
  const { dbh, config } = deps;
  const now = new Date();

  await dbh.db.transaction(async (tx) => {
    const sources = [
      { name: 'workflow:call_events', triggers: ['call.completed', 'call.missed'], collect: collectCallCandidates },
      { name: 'workflow:audit_dispositions', triggers: ['disposition.created'], collect: collectDispositionCandidates },
      { name: 'workflow:messages', triggers: ['message.received'], collect: collectInboundMessageCandidates },
      { name: 'workflow:leads', triggers: ['lead.created'], collect: collectLeadCandidates },
    ] as const;

    for (const source of sources) {
      const cursor = await readCursor(tx, source.name, now);
      const scanFrom = new Date(cursor.getTime() - OVERLAP_MS);
      const { candidates, maxCreatedAt } = await source.collect(tx, scanFrom);
      if (candidates.length > 0) {
        const orgIds = [...new Set(candidates.map((c) => c.orgId))];
        const byOrg = await loadWorkflowsByOrg(tx, orgIds, [...source.triggers]);
        for (const candidate of candidates) {
          for (const workflow of byOrg.get(candidate.orgId) ?? []) {
            if (workflow.triggerType !== candidate.triggerSource) continue;
            // No history: a workflow only fires on rows created at-or-after it.
            if (workflow.createdAt.getTime() > candidate.createdAt.getTime()) continue;
            await createRunForWorkflow(tx, workflow, candidate);
          }
        }
      }
      if (maxCreatedAt) await writeCursor(tx, source.name, maxCreatedAt);
    }
  });

  // Self-perpetuating sweep (worker-main seeds the first one).
  const intervalMs = config.WORKFLOW_FANOUT_INTERVAL_MS ?? 5_000;
  const nextRun = Date.now() + intervalMs;
  await enqueueJob(dbh.db, {
    jobType: 'workflow-fanout',
    dedupeKey: `workflow-fanout:${Math.floor(nextRun / intervalMs)}`,
    runAt: new Date(nextRun),
  });
};

// ---------------------------------------------------------------------------
// workflow-time-sweep: the hourly no_contact_for_days evaluation (docs §2-3)
// ---------------------------------------------------------------------------

export const workflowTimeSweep: JobHandler = async (deps) => {
  const { dbh } = deps;
  const nowMs = Date.now();

  await resumeOverdueWaitingRuns(dbh.db, nowMs);

  const timeWorkflows = await dbh.db
    .select()
    .from(schema.workflows)
    .where(
      and(eq(schema.workflows.enabled, true), eq(schema.workflows.triggerType, 'no_contact_for_days')),
    );

  for (const workflow of timeWorkflows) {
    const days = Number((workflow.triggerConfig as { days?: number }).days ?? 0);
    if (!Number.isFinite(days) || days < 1) continue; // invalid config: never fire
    const cutoff = new Date(nowMs - days * 86_400_000);
    // Period bucket: at most one fire per lead per workflow per N-day window.
    const bucket = Math.floor(nowMs / 86_400_000 / days);

    // Stale = lead older than the window with NO call and NO message (either
    // direction — a workflow-sent SMS counts as contact and resets the clock,
    // which is loop-safety, not a bug: docs/workflows.md §7).
    const stale = await dbh.db
      .select({ id: schema.leads.id })
      .from(schema.leads)
      .where(
        and(
          eq(schema.leads.orgId, workflow.orgId),
          lte(schema.leads.createdAt, cutoff),
          sql`NOT EXISTS (
            SELECT 1 FROM calls c
            WHERE c.lead_id = ${schema.leads.id} AND c.created_at > ${cutoff}
          )`,
          sql`NOT EXISTS (
            SELECT 1 FROM messages m
            JOIN conversations cv ON cv.id = m.conversation_id
            WHERE cv.lead_id = ${schema.leads.id} AND m.created_at > ${cutoff}
          )`,
        ),
      )
      .limit(BATCH_SIZE);

    for (const lead of stale) {
      await dbh.db.transaction(async (tx) => {
        await createRunForWorkflow(tx, workflow, {
          orgId: workflow.orgId,
          triggerSource: 'no_contact',
          triggerEventId: `${lead.id}:${bucket}`,
          leadId: lead.id,
        });
      });
    }
  }
};

/**
 * Safety net for parked sequence runs (docs/sequences.md §3). A `wait` parks
 * the run and schedules its resume job in the same transaction, so a run is
 * only ever stranded if that job row was removed or dead-lettered. Anything
 * still `waiting` an hour past resume_at gets a fresh job, deduped per hour;
 * the handler itself is idempotent, so a duplicate wake-up is harmless.
 */
const OVERDUE_RESUME_GRACE_MS = 60 * 60_000;

export async function resumeOverdueWaitingRuns(db: DbLike, nowMs: number): Promise<number> {
  const overdue = await db
    .select({ id: schema.workflowRuns.id })
    .from(schema.workflowRuns)
    .where(
      and(
        eq(schema.workflowRuns.status, 'waiting'),
        lt(schema.workflowRuns.resumeAt, new Date(nowMs - OVERDUE_RESUME_GRACE_MS)),
      ),
    )
    .limit(BATCH_SIZE);
  const hour = Math.floor(nowMs / 3_600_000);
  for (const run of overdue) {
    await enqueueJob(db, {
      jobType: 'workflow-run',
      payload: { runId: run.id },
      dedupeKey: `workflow-run:${run.id}:sweep:${hour}`,
    });
  }
  return overdue.length;
}

/** Seed the self-perpetuating trigger sweep (idempotent per interval bucket). */
export async function seedWorkflowFanout(db: DbLike, intervalMs: number): Promise<void> {
  await enqueueJob(db, {
    jobType: 'workflow-fanout',
    dedupeKey: `workflow-fanout:${Math.floor(Date.now() / intervalMs)}`,
  });
}
