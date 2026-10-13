/**
 * Phase 6 read side: reporting queries (docs/reporting.md).
 * Every metric here is parameterized SQL over the facts the event pipeline
 * already captured — this module never writes anything. Definitions are
 * pinned by apps/server/test/reports.test.ts with hand-computed expectations;
 * change a query here and a test must change with it, deliberately.
 */

import { eq, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from '@talkr/db';

export const DEFAULT_TIMEZONE = 'America/New_York';
const MAX_RANGE_DAYS = 366;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// Date range resolution (org-timezone local calendar days)
// ---------------------------------------------------------------------------

export interface ReportRange {
  /** Inclusive local start day, YYYY-MM-DD. */
  from: string;
  /** Inclusive local end day, YYYY-MM-DD. */
  to: string;
  timezone: string;
}

export class ReportRangeError extends Error {
  constructor(public readonly code: 'invalid_date' | 'invalid_range' | 'range_too_large', message: string) {
    super(message);
  }
}

/** IANA zones both Intl and Postgres evaluate from the platform tzdata. */
export function validTimezone(tz: unknown): string {
  if (typeof tz !== 'string' || tz.length === 0) return DEFAULT_TIMEZONE;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return tz;
  } catch {
    return DEFAULT_TIMEZONE;
  }
}

/** The local calendar day (YYYY-MM-DD) of an instant in a timezone. */
export function localDayString(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

function parseLocalDate(value: string): number {
  if (!DATE_RE.test(value)) throw new ReportRangeError('invalid_date', `not a YYYY-MM-DD date: ${value}`);
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
    throw new ReportRangeError('invalid_date', `not a real calendar date: ${value}`);
  }
  return ms;
}

function addDays(day: string, days: number): string {
  return new Date(parseLocalDate(day) + days * 86_400_000).toISOString().slice(0, 10);
}

/**
 * Resolve from/to query params into a validated range. Defaults to the last
 * 7 local days including today. Throws ReportRangeError (→ HTTP 400).
 */
export function resolveRange(
  params: { from?: string; to?: string },
  timezone: string,
  now: Date = new Date(),
): ReportRange {
  const tz = validTimezone(timezone);
  const to = params.to ?? localDayString(now, tz);
  const from = params.from ?? addDays(to, -6);
  const fromMs = parseLocalDate(from);
  const toMs = parseLocalDate(to);
  if (fromMs > toMs) throw new ReportRangeError('invalid_range', `from ${from} is after to ${to}`);
  const days = (toMs - fromMs) / 86_400_000 + 1;
  if (days > MAX_RANGE_DAYS) {
    throw new ReportRangeError('range_too_large', `range spans ${days} days (max ${MAX_RANGE_DAYS})`);
  }
  return { from, to, timezone: tz };
}

export async function orgTimezone(db: Db, orgId: string): Promise<string> {
  const org = (
    await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1)
  )[0];
  const settings = (org?.settings ?? {}) as { timezone?: string };
  return validTimezone(settings.timezone);
}

// ---------------------------------------------------------------------------
// Shared SQL fragments (docs/reporting.md §1-2)
// ---------------------------------------------------------------------------

/** UTC instant of local midnight starting `range.from`. */
function rangeStart(range: ReportRange): SQL {
  return sql`((${range.from}::date)::timestamp AT TIME ZONE ${range.timezone})`;
}

/** UTC instant of local midnight after `range.to` (exclusive bound). */
function rangeEnd(range: ReportRange): SQL {
  return sql`((${range.to}::date + 1)::timestamp AT TIME ZONE ${range.timezone})`;
}

/** A call belongs to the local day it started. */
const startedAt = sql`COALESCE(c.initiated_at, c.created_at)`;

function inRange(range: ReportRange): SQL {
  return sql`${startedAt} >= ${rangeStart(range)} AND ${startedAt} < ${rangeEnd(range)}`;
}

/** Terminal statuses; in-flight calls never count toward rates or misses. */
const TERMINAL = sql`c.status IN ('completed', 'no_answer', 'busy', 'failed', 'canceled')`;

/** missed = inbound ∧ never in_progress ∧ terminal (docs/reporting.md §2.1). */
const MISSED = sql`c.direction = 'inbound' AND c.answered_at IS NULL AND ${TERMINAL}`;

/** Talk time = answered→ended, not the billed leg duration. */
const TALK_SECONDS = sql`EXTRACT(EPOCH FROM c.ended_at - c.answered_at)`;
const HAS_TALK = sql`c.answered_at IS NOT NULL AND c.ended_at IS NOT NULL`;

type Row = Record<string, unknown>;

function num(row: Row | undefined, key: string): number {
  const v = row?.[key];
  return typeof v === 'number' ? v : v == null ? 0 : Number(v);
}

function numOrNull(row: Row | undefined, key: string): number | null {
  const v = row?.[key];
  if (v == null) return null;
  return typeof v === 'number' ? v : Number(v);
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

export async function overviewReport(db: Db, orgId: string, range: ReportRange) {
  const totals = (
    await db.execute(sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE c.direction = 'outbound')::int AS outbound,
        count(*) FILTER (WHERE c.direction = 'inbound')::int AS inbound,
        count(*) FILTER (WHERE c.answered_at IS NOT NULL)::int AS answered,
        count(*) FILTER (WHERE c.direction = 'outbound' AND c.answered_at IS NOT NULL)::int AS answered_outbound,
        count(*) FILTER (WHERE c.direction = 'inbound' AND c.answered_at IS NOT NULL)::int AS answered_inbound,
        count(*) FILTER (WHERE c.direction = 'outbound' AND ${TERMINAL})::int AS terminal_outbound,
        count(*) FILTER (WHERE c.direction = 'inbound' AND ${TERMINAL})::int AS terminal_inbound,
        count(*) FILTER (WHERE ${MISSED})::int AS missed,
        count(*) FILTER (WHERE c.raw ->> 'voicemailLeft' = 'true')::int AS voicemails_left,
        count(*) FILTER (WHERE c.disposition_id IS NULL)::int AS undispositioned,
        COALESCE(sum(${TALK_SECONDS}) FILTER (WHERE ${HAS_TALK}), 0)::float8 AS talk_seconds_total,
        count(*) FILTER (WHERE ${HAS_TALK})::int AS talk_calls
      FROM calls c
      WHERE c.org_id = ${orgId} AND ${inRange(range)}`)
  ).rows[0] as Row;

  const stl = (
    await db.execute(sql`
      SELECT
        count(*)::int AS leads_received,
        count(*) FILTER (WHERE l.first_attempt_at IS NULL)::int AS awaiting,
        avg(EXTRACT(EPOCH FROM l.first_attempt_at - l.received_at))
          FILTER (WHERE l.first_attempt_at IS NOT NULL)::float8 AS avg_seconds
      FROM leads l
      WHERE l.org_id = ${orgId}
        AND l.received_at >= ${rangeStart(range)} AND l.received_at < ${rangeEnd(range)}`)
  ).rows[0] as Row;

  const dispositions = (
    await db.execute(sql`
      SELECT d.slug, d.name, count(*)::int AS n
      FROM calls c
      JOIN call_dispositions d ON d.id = c.disposition_id
      WHERE c.org_id = ${orgId} AND ${inRange(range)}
      GROUP BY d.slug, d.name
      ORDER BY n DESC, d.slug`)
  ).rows as Row[];

  const terminalOutbound = num(totals, 'terminal_outbound');
  const terminalInbound = num(totals, 'terminal_inbound');
  const talkCalls = num(totals, 'talk_calls');
  const talkTotal = num(totals, 'talk_seconds_total');

  return {
    range,
    totals: {
      total: num(totals, 'total'),
      outbound: num(totals, 'outbound'),
      inbound: num(totals, 'inbound'),
      answered: num(totals, 'answered'),
      answered_outbound: num(totals, 'answered_outbound'),
      answered_inbound: num(totals, 'answered_inbound'),
      missed: num(totals, 'missed'),
      voicemails_left: num(totals, 'voicemails_left'),
      undispositioned: num(totals, 'undispositioned'),
    },
    answer_rate: {
      outbound: terminalOutbound > 0 ? num(totals, 'answered_outbound') / terminalOutbound : null,
      inbound: terminalInbound > 0 ? num(totals, 'answered_inbound') / terminalInbound : null,
    },
    talk: {
      total_seconds: talkTotal,
      avg_seconds: talkCalls > 0 ? talkTotal / talkCalls : null,
      calls_with_talk: talkCalls,
    },
    speed_to_lead: {
      avg_seconds: numOrNull(stl, 'avg_seconds'),
      leads_received: num(stl, 'leads_received'),
      leads_awaiting_first_attempt: num(stl, 'awaiting'),
    },
    dispositions: dispositions.map((d) => ({
      slug: String(d.slug),
      name: String(d.name),
      count: num(d, 'n'),
    })),
  };
}

// ---------------------------------------------------------------------------
// By-rep
// ---------------------------------------------------------------------------

export async function byRepReport(db: Db, orgId: string, range: ReportRange) {
  const reps = (
    await db.execute(sql`
      SELECT
        u.id AS user_id,
        u.display_name,
        u.role::text AS role,
        count(c.id) FILTER (WHERE c.direction = 'outbound')::int AS calls_made,
        count(c.id) FILTER (WHERE c.direction = 'inbound')::int AS calls_received,
        count(c.id) FILTER (WHERE c.answered_at IS NOT NULL)::int AS answered,
        COALESCE(sum(${TALK_SECONDS}) FILTER (WHERE ${HAS_TALK}), 0)::float8 AS talk_seconds,
        avg(EXTRACT(EPOCH FROM c.wrapup_completed_at - c.ended_at))
          FILTER (WHERE c.wrapup_completed_at IS NOT NULL AND c.ended_at IS NOT NULL
                    AND c.wrapup_completed_at >= c.ended_at)::float8 AS avg_wrapup_seconds
      FROM users u
      LEFT JOIN calls c
        ON c.user_id = u.id AND c.org_id = u.org_id AND ${inRange(range)}
      WHERE u.org_id = ${orgId} AND u.status = 'active'
      GROUP BY u.id, u.display_name, u.role
      ORDER BY u.display_name`)
  ).rows as Row[];

  const dispositionRows = (
    await db.execute(sql`
      SELECT c.user_id, d.slug, count(*)::int AS n
      FROM calls c
      JOIN call_dispositions d ON d.id = c.disposition_id
      WHERE c.org_id = ${orgId} AND c.user_id IS NOT NULL AND ${inRange(range)}
      GROUP BY c.user_id, d.slug`)
  ).rows as Row[];

  // Per-rep spend over the same calls the rep's other columns count.
  const costRows = (
    await db.execute(sql`
      SELECT c.user_id, pc.currency, sum(pc.amount)::text AS amount
      FROM provider_costs pc
      JOIN calls c ON c.id = pc.call_id
      WHERE pc.org_id = ${orgId} AND c.user_id IS NOT NULL AND ${inRange(range)}
      GROUP BY c.user_id, pc.currency`)
  ).rows as Row[];

  const dispositionsByUser = new Map<string, Record<string, number>>();
  for (const row of dispositionRows) {
    const userId = String(row.user_id);
    const bucket = dispositionsByUser.get(userId) ?? {};
    bucket[String(row.slug)] = num(row, 'n');
    dispositionsByUser.set(userId, bucket);
  }
  const costsByUser = new Map<string, Record<string, string>>();
  for (const row of costRows) {
    const userId = String(row.user_id);
    const bucket = costsByUser.get(userId) ?? {};
    bucket[String(row.currency)] = String(row.amount);
    costsByUser.set(userId, bucket);
  }

  return {
    range,
    reps: reps.map((r) => {
      const userId = String(r.user_id);
      return {
        user_id: userId,
        display_name: String(r.display_name),
        role: String(r.role),
        calls_made: num(r, 'calls_made'),
        calls_received: num(r, 'calls_received'),
        answered: num(r, 'answered'),
        talk_seconds: num(r, 'talk_seconds'),
        avg_wrapup_seconds: numOrNull(r, 'avg_wrapup_seconds'),
        dispositions: dispositionsByUser.get(userId) ?? {},
        /** currency → decimal-string spend; null = no cost data (not $0.00). */
        cost: costsByUser.get(userId) ?? null,
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// By-day series (the timezone-proof endpoint)
// ---------------------------------------------------------------------------

export async function byDayReport(db: Db, orgId: string, range: ReportRange) {
  const rows = (
    await db.execute(sql`
      SELECT
        to_char(d.day::date, 'YYYY-MM-DD') AS day,
        COALESCE(s.total, 0)::int AS total,
        COALESCE(s.outbound, 0)::int AS outbound,
        COALESCE(s.inbound, 0)::int AS inbound,
        COALESCE(s.answered, 0)::int AS answered,
        COALESCE(s.missed, 0)::int AS missed
      FROM generate_series(${range.from}::date, ${range.to}::date, interval '1 day') AS d(day)
      LEFT JOIN (
        SELECT
          (${startedAt} AT TIME ZONE ${range.timezone})::date AS day,
          count(*)::int AS total,
          count(*) FILTER (WHERE c.direction = 'outbound')::int AS outbound,
          count(*) FILTER (WHERE c.direction = 'inbound')::int AS inbound,
          count(*) FILTER (WHERE c.answered_at IS NOT NULL)::int AS answered,
          count(*) FILTER (WHERE ${MISSED})::int AS missed
        FROM calls c
        WHERE c.org_id = ${orgId} AND ${inRange(range)}
        GROUP BY 1
      ) s ON s.day = d.day::date
      ORDER BY d.day`)
  ).rows as Row[];

  return {
    range,
    days: rows.map((r) => ({
      day: String(r.day),
      total: num(r, 'total'),
      outbound: num(r, 'outbound'),
      inbound: num(r, 'inbound'),
      answered: num(r, 'answered'),
      missed: num(r, 'missed'),
    })),
  };
}

// ---------------------------------------------------------------------------
// Queues (reconstructed from journal + timestamps — docs/reporting.md §2.4)
// ---------------------------------------------------------------------------

export async function queuesReport(db: Db, orgId: string, range: ReportRange) {
  const rows = (
    await db.execute(sql`
      SELECT
        q.id AS queue_id,
        q.name,
        q.strategy,
        count(c.id)::int AS offered,
        count(c.id) FILTER (WHERE c.answered_at IS NOT NULL)::int AS answered,
        count(c.id) FILTER (WHERE EXISTS (
          SELECT 1 FROM call_events e
          WHERE e.call_id = c.id AND e.event_type = 'call.queue_overflow'
            AND e.payload ->> 'queueId' = q.id::text
        ))::int AS overflowed,
        avg(EXTRACT(EPOCH FROM c.answered_at - ${startedAt}))
          FILTER (WHERE c.answered_at IS NOT NULL)::float8 AS avg_wait_to_answer_seconds
      FROM queues q
      LEFT JOIN calls c
        ON c.org_id = q.org_id AND c.raw ->> 'queueId' = q.id::text AND ${inRange(range)}
      WHERE q.org_id = ${orgId}
      GROUP BY q.id, q.name, q.strategy
      ORDER BY q.name`)
  ).rows as Row[];

  // Overflow hold time comes from the journal itself: the wait loop computed
  // and recorded elapsedSeconds at the moment it overflowed.
  const overflowWaits = (
    await db.execute(sql`
      SELECT e.payload ->> 'queueId' AS queue_id,
             avg((e.payload ->> 'elapsedSeconds')::numeric)::float8 AS avg_wait
      FROM call_events e
      JOIN calls c ON c.id = e.call_id
      WHERE c.org_id = ${orgId} AND e.event_type = 'call.queue_overflow' AND ${inRange(range)}
      GROUP BY 1`)
  ).rows as Row[];
  const overflowByQueue = new Map(overflowWaits.map((r) => [String(r.queue_id), numOrNull(r, 'avg_wait')]));

  return {
    range,
    queues: rows.map((r) => ({
      queue_id: String(r.queue_id),
      name: String(r.name),
      strategy: String(r.strategy),
      offered: num(r, 'offered'),
      answered: num(r, 'answered'),
      overflowed: num(r, 'overflowed'),
      avg_wait_to_answer_seconds: numOrNull(r, 'avg_wait_to_answer_seconds'),
      avg_wait_to_overflow_seconds: overflowByQueue.get(String(r.queue_id)) ?? null,
    })),
  };
}

// ---------------------------------------------------------------------------
// Quality
// ---------------------------------------------------------------------------

export async function qualityReport(db: Db, orgId: string, range: ReportRange) {
  const failureRows = (
    await db.execute(sql`
      SELECT c.failure_class::text AS failure_class, count(*)::int AS n
      FROM calls c
      WHERE c.org_id = ${orgId} AND ${inRange(range)} AND ${TERMINAL}
      GROUP BY c.failure_class`)
  ).rows as Row[];

  const trend = (
    await db.execute(sql`
      SELECT
        to_char(d.day::date, 'YYYY-MM-DD') AS day,
        COALESCE(s.carrier_failures, 0)::int AS carrier_failures,
        COALESCE(s.terminal_calls, 0)::int AS terminal_calls
      FROM generate_series(${range.from}::date, ${range.to}::date, interval '1 day') AS d(day)
      LEFT JOIN (
        SELECT
          (${startedAt} AT TIME ZONE ${range.timezone})::date AS day,
          count(*) FILTER (WHERE c.failure_class = 'carrier_failure')::int AS carrier_failures,
          count(*)::int AS terminal_calls
        FROM calls c
        WHERE c.org_id = ${orgId} AND ${inRange(range)} AND ${TERMINAL}
        GROUP BY 1
      ) s ON s.day = d.day::date
      ORDER BY d.day`)
  ).rows as Row[];

  const mismatches = (
    await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE m.resolved_at IS NULL)::int AS open,
        count(*) FILTER (WHERE m.resolved_at IS NOT NULL)::int AS resolved
      FROM reconciliation_mismatches m
      WHERE m.org_id = ${orgId}
        AND m.detected_at >= ${rangeStart(range)} AND m.detected_at < ${rangeEnd(range)}`)
  ).rows[0] as Row;

  // Expected-but-missing recordings: answered ∧ completed ∧ past the
  // 10-minute recording-arrival grace period, and no recordings row at all.
  const recordings = (
    await db.execute(sql`
      SELECT
        count(*) FILTER (WHERE NOT EXISTS (
          SELECT 1 FROM recordings r WHERE r.call_id = c.id
        ))::int AS missing,
        count(*) FILTER (WHERE EXISTS (
          SELECT 1 FROM recordings r WHERE r.call_id = c.id AND r.status = 'failed'
        ))::int AS failed
      FROM calls c
      WHERE c.org_id = ${orgId} AND ${inRange(range)}
        AND c.answered_at IS NOT NULL AND c.status = 'completed'
        AND c.ended_at < now() - interval '10 minutes'`)
  ).rows[0] as Row;

  const failureClasses: Record<string, number> = {
    none: 0,
    seller_no_answer: 0,
    seller_busy: 0,
    carrier_failure: 0,
    platform_failure: 0,
    canceled: 0,
  };
  for (const row of failureRows) failureClasses[String(row.failure_class)] = num(row, 'n');

  return {
    range,
    failure_classes: failureClasses,
    carrier_failure_trend: trend.map((r) => ({
      day: String(r.day),
      carrier_failures: num(r, 'carrier_failures'),
      terminal_calls: num(r, 'terminal_calls'),
    })),
    mismatches: { open: num(mismatches, 'open'), resolved: num(mismatches, 'resolved') },
    recordings: { missing: num(recordings, 'missing'), failed: num(recordings, 'failed') },
  };
}

// ---------------------------------------------------------------------------
// Costs (docs/reporting.md §3.3) — "no data" is distinct from $0.00
// ---------------------------------------------------------------------------

export async function costsReport(db: Db, orgId: string, range: ReportRange) {
  const inCostRange = sql`
    pc.occurred_at >= ${rangeStart(range)} AND pc.occurred_at < ${rangeEnd(range)}`;

  const total = (
    await db.execute(sql`
      SELECT pc.currency, sum(pc.amount)::text AS amount, count(*)::int AS items
      FROM provider_costs pc
      WHERE pc.org_id = ${orgId} AND ${inCostRange}
      GROUP BY pc.currency
      ORDER BY pc.currency`)
  ).rows as Row[];

  const byDay = (
    await db.execute(sql`
      SELECT to_char((pc.occurred_at AT TIME ZONE ${range.timezone})::date, 'YYYY-MM-DD') AS day,
             pc.currency, sum(pc.amount)::text AS amount
      FROM provider_costs pc
      WHERE pc.org_id = ${orgId} AND ${inCostRange}
      GROUP BY 1, pc.currency
      ORDER BY 1`)
  ).rows as Row[];

  const byType = (
    await db.execute(sql`
      SELECT pc.item_type, pc.currency, sum(pc.amount)::text AS amount, count(*)::int AS items
      FROM provider_costs pc
      WHERE pc.org_id = ${orgId} AND ${inCostRange}
      GROUP BY pc.item_type, pc.currency
      ORDER BY pc.item_type`)
  ).rows as Row[];

  const byRep = (
    await db.execute(sql`
      SELECT c.user_id, u.display_name, pc.currency, sum(pc.amount)::text AS amount
      FROM provider_costs pc
      LEFT JOIN calls c ON c.id = pc.call_id
      LEFT JOIN users u ON u.id = c.user_id
      WHERE pc.org_id = ${orgId} AND ${inCostRange}
      GROUP BY c.user_id, u.display_name, pc.currency
      ORDER BY u.display_name NULLS LAST`)
  ).rows as Row[];

  return {
    range,
    has_data: total.length > 0,
    total: total.map((r) => ({
      currency: String(r.currency),
      amount: String(r.amount),
      items: num(r, 'items'),
    })),
    by_day: byDay.map((r) => ({
      day: String(r.day),
      currency: String(r.currency),
      amount: String(r.amount),
    })),
    by_type: byType.map((r) => ({
      item_type: String(r.item_type),
      currency: String(r.currency),
      amount: String(r.amount),
      items: num(r, 'items'),
    })),
    by_rep: byRep.map((r) => ({
      user_id: r.user_id == null ? null : String(r.user_id),
      display_name: r.display_name == null ? null : String(r.display_name),
      currency: String(r.currency),
      amount: String(r.amount),
    })),
  };
}

// ---------------------------------------------------------------------------
// Floor snapshot (docs/reporting.md §4)
// ---------------------------------------------------------------------------

const NON_TERMINAL = sql`c.status IN ('queued', 'initiated', 'ringing', 'in_progress')`;

export async function floorSnapshot(db: Db, orgId: string, now: Date = new Date()) {
  const timezone = await orgTimezone(db, orgId);
  const today = localDayString(now, timezone);
  const todayRange: ReportRange = { from: today, to: today, timezone };

  const reps = (
    await db.execute(sql`
      SELECT u.id AS user_id, u.display_name, u.role::text AS role,
             p.status AS presence_status, p.last_seen_at
      FROM users u
      LEFT JOIN agent_presence p ON p.user_id = u.id
      WHERE u.org_id = ${orgId} AND u.status = 'active'
      ORDER BY u.display_name`)
  ).rows as Row[];

  const activeCalls = (
    await db.execute(sql`
      SELECT DISTINCT ON (c.user_id)
        c.user_id, c.id AS call_id, c.direction::text AS direction, c.status::text AS status,
        c.from_number, c.to_number, c.initiated_at, c.answered_at, c.created_at
      FROM calls c
      WHERE c.org_id = ${orgId} AND c.user_id IS NOT NULL AND ${NON_TERMINAL}
      ORDER BY c.user_id, c.created_at DESC`)
  ).rows as Row[];
  const activeByUser = new Map(activeCalls.map((r) => [String(r.user_id), r]));

  const todayByRep = (
    await db.execute(sql`
      SELECT c.user_id,
        count(*)::int AS calls,
        count(*) FILTER (WHERE c.answered_at IS NOT NULL)::int AS answered,
        COALESCE(sum(${TALK_SECONDS}) FILTER (WHERE ${HAS_TALK}), 0)::float8 AS talk_seconds
      FROM calls c
      WHERE c.org_id = ${orgId} AND c.user_id IS NOT NULL AND ${inRange(todayRange)}
      GROUP BY c.user_id`)
  ).rows as Row[];
  const todayByUser = new Map(todayByRep.map((r) => [String(r.user_id), r]));

  const totals = (
    await db.execute(sql`
      SELECT
        count(*)::int AS calls,
        count(*) FILTER (WHERE c.direction = 'inbound')::int AS inbound,
        count(*) FILTER (WHERE c.direction = 'outbound')::int AS outbound,
        count(*) FILTER (WHERE c.answered_at IS NOT NULL)::int AS answered,
        count(*) FILTER (WHERE ${MISSED})::int AS missed,
        count(*) FILTER (WHERE c.raw ->> 'voicemailLeft' = 'true')::int AS voicemails_left,
        COALESCE(sum(${TALK_SECONDS}) FILTER (WHERE ${HAS_TALK}), 0)::float8 AS talk_seconds
      FROM calls c
      WHERE c.org_id = ${orgId} AND ${inRange(todayRange)}`)
  ).rows[0] as Row;

  // Callers currently held by a queue: in treatment, unanswered, not overflowed.
  const queueDepth = (
    await db.execute(sql`
      SELECT q.id AS queue_id, q.name, count(c.id)::int AS waiting
      FROM queues q
      LEFT JOIN calls c
        ON c.org_id = q.org_id AND c.raw ->> 'queueId' = q.id::text
        AND ${NON_TERMINAL} AND c.answered_at IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM call_events e
          WHERE e.call_id = c.id AND e.event_type = 'call.queue_overflow'
        )
      WHERE q.org_id = ${orgId}
      GROUP BY q.id, q.name
      ORDER BY q.name`)
  ).rows as Row[];

  // Same freshness math the router uses (PRESENCE_FRESHNESS_MS = 90s).
  const FRESHNESS_MS = 90_000;

  return {
    generated_at: now.toISOString(),
    today,
    timezone,
    reps: reps.map((r) => {
      const userId = String(r.user_id);
      const lastSeen = r.last_seen_at ? new Date(r.last_seen_at as string) : null;
      const fresh = lastSeen != null && now.getTime() - lastSeen.getTime() <= FRESHNESS_MS;
      const active = activeByUser.get(userId);
      const counters = todayByUser.get(userId);
      return {
        user_id: userId,
        display_name: String(r.display_name),
        role: String(r.role),
        presence: {
          status: r.presence_status ? String(r.presence_status) : 'offline',
          last_seen_at: lastSeen ? lastSeen.toISOString() : null,
          fresh,
        },
        on_call: active
          ? {
              call_id: String(active.call_id),
              direction: String(active.direction),
              status: String(active.status),
              from_number: String(active.from_number),
              to_number: String(active.to_number),
              initiated_at: active.initiated_at
                ? new Date(active.initiated_at as string).toISOString()
                : null,
              answered_at: active.answered_at
                ? new Date(active.answered_at as string).toISOString()
                : null,
            }
          : null,
        today: {
          calls: num(counters, 'calls'),
          answered: num(counters, 'answered'),
          talk_seconds: num(counters, 'talk_seconds'),
        },
      };
    }),
    queues: queueDepth.map((r) => ({
      queue_id: String(r.queue_id),
      name: String(r.name),
      waiting: num(r, 'waiting'),
    })),
    totals: {
      calls: num(totals, 'calls'),
      inbound: num(totals, 'inbound'),
      outbound: num(totals, 'outbound'),
      answered: num(totals, 'answered'),
      missed: num(totals, 'missed'),
      voicemails_left: num(totals, 'voicemails_left'),
      talk_seconds: num(totals, 'talk_seconds'),
    },
  };
}
