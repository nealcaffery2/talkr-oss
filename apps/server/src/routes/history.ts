/**
 * Activity history (docs/reporting.md §8): one filterable feed over calls and
 * texts, a KPI block that follows the same filters, and a CSV export. Read
 * side only. Every metric reuses the definitions in services/reports.ts
 * (talk time = answered→ended, connect rate = answered / terminal, a call
 * belongs to the local day it started) — nothing here invents a new number.
 *
 * Scope follows the existing read permissions: `calls.read.org` /
 * `messages.read.org` see the org; everyone else sees their own rows (calls
 * attributed to them; conversations assigned to them or unassigned, the same
 * rule the inbox applies). Both sources are queried through one UNION ALL so
 * pagination and export order are exact rather than merged approximately.
 */

import { Readable } from 'node:stream';
import { sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Permission } from '@talkr/core';
import type { Db } from '@talkr/db';
import type { AppDeps } from '../app.js';
import { hasPermission, type AuthContext } from '../auth.js';
import { localDayString, orgTimezone } from '../services/reports.js';

function requirePermission(permission: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = req.authCtx;
    if (!ctx) return reply.code(401).send({ error: 'unauthenticated' });
    if (!hasPermission(ctx, permission)) {
      req.log.info({ userId: ctx.userId, permission }, 'permission denied');
      return reply.code(403).send({ error: 'forbidden', permission });
    }
  };
}

// ---------------------------------------------------------------------------
// Query parsing
// ---------------------------------------------------------------------------

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const EXPORT_MAX_ROWS = 10_000;
const DEFAULT_RANGE_DAYS = 30;
/** Same ceiling as the reports (366 days) with a day of slack for tz offsets. */
const MAX_RANGE_MS = 367 * 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const boolParam = z.enum(['true', 'false']).transform((v) => v === 'true');

const querySchema = z.object({
  type: z.enum(['all', 'calls', 'sms']).default('all'),
  from: z.string().max(40).optional(),
  to: z.string().max(40).optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  status: z.string().min(1).max(40).optional(),
  user_id: z.string().uuid().optional(),
  disposition: z.string().min(1).max(80).optional(),
  min_duration: z.coerce.number().int().min(0).optional(),
  max_duration: z.coerce.number().int().min(0).optional(),
  has_recording: boolParam.optional(),
  has_note: boolParam.optional(),
  q: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_LIMIT).default(DEFAULT_LIMIT),
  offset: z.coerce.number().int().min(0).default(0),
});

type HistoryQuery = z.infer<typeof querySchema>;

/** `?status=` from a cleared select means "no filter", not "status is empty". */
function stripEmpty(query: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (query && typeof query === 'object') {
    for (const [k, v] of Object.entries(query as Record<string, unknown>)) {
      if (typeof v === 'string' && v !== '') out[k] = v;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Date range: local calendar days in the org zone, or exact instants
// ---------------------------------------------------------------------------

export class HistoryRangeError extends Error {
  constructor(
    public readonly code: 'invalid_date' | 'invalid_range' | 'range_too_large',
    message: string,
  ) {
    super(message);
  }
}

export interface HistoryRange {
  /** Inclusive lower bound, as a SQL timestamptz expression. */
  start: SQL;
  /** Exclusive upper bound, as a SQL timestamptz expression. */
  end: SQL;
  /** Echo of the resolved bounds: YYYY-MM-DD for day precision, ISO otherwise. */
  from: string;
  to: string;
  timezone: string;
}

interface Bound {
  expr: SQL;
  /** Approximate UTC ms — only used to order the bounds and cap the span. */
  ms: number;
  label: string;
}

function shiftDay(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function parseBound(value: string, timezone: string, edge: 'start' | 'end'): Bound {
  if (DATE_RE.test(value)) {
    const ms = Date.parse(`${value}T00:00:00Z`);
    if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
      throw new HistoryRangeError('invalid_date', `not a real calendar date: ${value}`);
    }
    // Day precision buckets exactly like the reports (docs/reporting.md §1):
    // Postgres evaluates local midnight in the org zone, DST included.
    return edge === 'start'
      ? { expr: sql`((${value}::date)::timestamp AT TIME ZONE ${timezone})`, ms, label: value }
      : {
          expr: sql`((${value}::date + 1)::timestamp AT TIME ZONE ${timezone})`,
          ms: ms + 86_400_000,
          label: value,
        };
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new HistoryRangeError('invalid_date', `not an ISO datetime or YYYY-MM-DD date: ${value}`);
  }
  // An instant `to` is inclusive: nudge it by 1ms so the shared `<` bound
  // still admits a row stamped at exactly that instant.
  const edgeMs = edge === 'start' ? ms : ms + 1;
  return {
    expr: sql`${new Date(edgeMs).toISOString()}::timestamptz`,
    ms: edgeMs,
    label: new Date(ms).toISOString(),
  };
}

/** Defaults to the last 30 local days including today. Throws HistoryRangeError (→ 400). */
export function resolveHistoryRange(
  params: { from?: string; to?: string },
  timezone: string,
  now: Date = new Date(),
): HistoryRange {
  const toValue = params.to ?? localDayString(now, timezone);
  const end = parseBound(toValue, timezone, 'end');
  const fromValue =
    params.from ??
    (DATE_RE.test(toValue)
      ? shiftDay(toValue, -(DEFAULT_RANGE_DAYS - 1))
      : new Date(end.ms - 1 - DEFAULT_RANGE_DAYS * 86_400_000).toISOString());
  const start = parseBound(fromValue, timezone, 'start');
  if (start.ms >= end.ms) {
    throw new HistoryRangeError('invalid_range', `from ${start.label} is after to ${end.label}`);
  }
  if (end.ms - start.ms > MAX_RANGE_MS) {
    throw new HistoryRangeError('range_too_large', 'range spans more than 366 days');
  }
  return { start: start.expr, end: end.expr, from: start.label, to: end.label, timezone };
}

// ---------------------------------------------------------------------------
// Filters + scope → SQL
// ---------------------------------------------------------------------------

export interface HistoryFilters {
  type: 'all' | 'calls' | 'sms';
  range: HistoryRange;
  direction?: 'inbound' | 'outbound';
  status?: string;
  userId?: string;
  disposition?: string;
  minDuration?: number;
  maxDuration?: number;
  hasRecording?: boolean;
  hasNote?: boolean;
  q?: string;
}

export interface HistoryScope {
  orgId: string;
  userId: string;
  /** May see every call in the org (`calls.read.org`). */
  orgCalls: boolean;
  /** May see every conversation in the org (`messages.read.org`). */
  orgSms: boolean;
  /** May see texts at all (`messages.read.own`). */
  sms: boolean;
}

/** A call belongs to the moment it started (docs/reporting.md §1). */
const CALL_AT = sql`COALESCE(c.initiated_at, c.created_at)`;
const CALL_TERMINAL = sql`c.status IN ('completed', 'no_answer', 'busy', 'failed', 'canceled')`;
const CALL_HAS_TALK = sql`c.answered_at IS NOT NULL AND c.ended_at IS NOT NULL`;
/** Talk time = answered→ended, never the billed leg duration (docs/reporting.md §2.1). */
const CALL_TALK_SECONDS = sql`EXTRACT(EPOCH FROM c.ended_at - c.answered_at)`;
const CALL_DURATION = sql`CASE WHEN ${CALL_HAS_TALK} THEN round(${CALL_TALK_SECONDS})::int ELSE NULL END`;
/** Only a completed recording is playable; processing/failed/absent are not "has recording". */
const CALL_HAS_RECORDING = sql`EXISTS (SELECT 1 FROM recordings r WHERE r.call_id = c.id AND r.status = 'completed')`;
const CALL_HAS_NOTE = sql`(c.disposition_note IS NOT NULL AND btrim(c.disposition_note) <> '')`;
/**
 * The rep behind a text: the sender for outbound, the conversation's assignee
 * for inbound. Compliance auto-replies (STOP/HELP) are nobody's work.
 */
const SMS_USER = sql`CASE WHEN m.is_auto_reply THEN NULL ELSE COALESCE(m.created_by, conv.assigned_user_id) END`;
const SMS_MEDIA_COUNT = sql`CASE WHEN jsonb_typeof(m.media_urls) = 'array' THEN jsonb_array_length(m.media_urls) ELSE 0 END`;

/**
 * The property behind a row — how a phone number ties to a house. Leads carry
 * the CRM (Podio) address via `leads.property_id`; when the row has a contact
 * but no lead (inbound from a known number), the newest lead whose primary
 * contact is that contact stands in.
 */
function addressJoin(leadCol: SQL, contactCol: SQL, orgCol: SQL): SQL {
  return sql`LEFT JOIN LATERAL (
    SELECT p.address_line1, p.city, p.state, p.postal_code
    FROM leads l
    JOIN properties p ON p.id = l.property_id
    WHERE l.org_id = ${orgCol}
      AND (l.id = ${leadCol} OR (${leadCol} IS NULL AND l.primary_contact_id = ${contactCol}))
    ORDER BY (l.id = ${leadCol}) DESC NULLS LAST, l.created_at DESC
    LIMIT 1
  ) addr ON TRUE`;
}

/**
 * The address join is a per-row LATERAL lookup, so the aggregate queries only
 * pay for it when the search text has to be matched against it.
 */
function callsFrom(f: HistoryFilters, forRows: boolean): SQL {
  return sql`FROM calls c
  LEFT JOIN contacts ct ON ct.id = c.contact_id
  LEFT JOIN users u ON u.id = c.user_id
  LEFT JOIN call_dispositions d ON d.id = c.disposition_id
  ${forRows || f.q ? addressJoin(sql`c.lead_id`, sql`c.contact_id`, sql`c.org_id`) : sql``}`;
}

function smsFrom(f: HistoryFilters, forRows: boolean): SQL {
  return sql`FROM messages m
  JOIN conversations conv ON conv.id = m.conversation_id
  LEFT JOIN contacts ct ON ct.id = conv.contact_id
  LEFT JOIN users u ON u.id = ${SMS_USER}
  ${forRows || f.q ? addressJoin(sql`conv.lead_id`, sql`conv.contact_id`, sql`conv.org_id`) : sql``}`;
}

const ADDRESS_COLS: SQL[] = [
  sql`addr.address_line1`,
  sql`addr.city`,
  sql`addr.state`,
  sql`addr.postal_code`,
];

/** `%q%` with LIKE metacharacters escaped, so a literal `_` in a note is searchable. */
function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/**
 * Case-insensitive substring over text columns; phone columns match on digits
 * only, so "512 555" finds +15125550134. Every value is a bound parameter.
 */
function searchClause(q: string, textCols: SQL[], phoneCols: SQL[]): SQL {
  const pattern = likePattern(q.trim());
  const parts = textCols.map((col) => sql`${col} ILIKE ${pattern}`);
  const digits = q.replace(/\D/g, '');
  if (digits.length >= 3) {
    const digitPattern = `%${digits}%`;
    for (const col of phoneCols) {
      parts.push(sql`regexp_replace(${col}, '\\D', '', 'g') LIKE ${digitPattern}`);
    }
  }
  return sql`(${sql.join(parts, sql` OR `)})`;
}

function callsWhere(f: HistoryFilters, scope: HistoryScope): SQL {
  const parts: SQL[] = [
    sql`c.org_id = ${scope.orgId}`,
    sql`${CALL_AT} >= ${f.range.start}`,
    sql`${CALL_AT} < ${f.range.end}`,
  ];
  // Own scope is attribution, the same rule GET /v1/calls applies.
  if (!scope.orgCalls) parts.push(sql`c.user_id = ${scope.userId}`);
  // Enum columns compare as text: an unknown value is an empty result, not a
  // Postgres "invalid input value for enum" error.
  if (f.direction) parts.push(sql`c.direction::text = ${f.direction}`);
  if (f.status) parts.push(sql`c.status::text = ${f.status}`);
  if (f.userId) parts.push(sql`c.user_id = ${f.userId}`);
  if (f.disposition) parts.push(sql`d.slug = ${f.disposition}`);
  if (f.minDuration != null) parts.push(sql`${CALL_DURATION} >= ${f.minDuration}`);
  if (f.maxDuration != null) parts.push(sql`${CALL_DURATION} <= ${f.maxDuration}`);
  if (f.hasRecording != null) parts.push(f.hasRecording ? CALL_HAS_RECORDING : sql`NOT ${CALL_HAS_RECORDING}`);
  if (f.hasNote != null) parts.push(f.hasNote ? CALL_HAS_NOTE : sql`NOT ${CALL_HAS_NOTE}`);
  if (f.q) {
    parts.push(
      searchClause(
        f.q,
        [sql`ct.display_name`, sql`c.disposition_note`, sql`d.name`, sql`u.display_name`, ...ADDRESS_COLS],
        [sql`c.from_number`, sql`c.to_number`],
      ),
    );
  }
  return sql.join(parts, sql` AND `);
}

function smsWhere(f: HistoryFilters, scope: HistoryScope): SQL {
  const parts: SQL[] = [
    sql`m.org_id = ${scope.orgId}`,
    sql`m.created_at >= ${f.range.start}`,
    sql`m.created_at < ${f.range.end}`,
  ];
  // Own scope mirrors the inbox (services/messages.ts listConversations):
  // threads assigned to me, plus unassigned ones.
  if (!scope.orgSms) {
    parts.push(sql`(conv.assigned_user_id = ${scope.userId} OR conv.assigned_user_id IS NULL)`);
  }
  if (f.direction) parts.push(sql`m.direction::text = ${f.direction}`);
  if (f.status) parts.push(sql`m.status::text = ${f.status}`);
  if (f.userId) parts.push(sql`${SMS_USER} = ${f.userId}`);
  if (f.q) {
    parts.push(
      searchClause(
        f.q,
        [sql`ct.display_name`, sql`m.body`, sql`u.display_name`, ...ADDRESS_COLS],
        [sql`conv.our_number`, sql`conv.their_number`],
      ),
    );
  }
  return sql.join(parts, sql` AND `);
}

function includeCalls(f: HistoryFilters): boolean {
  return f.type !== 'sms';
}

/**
 * Texts drop out when a call-only filter is asserted (a disposition, a
 * duration, "has recording", "has note"): a text can never satisfy those.
 * The negative forms (`has_recording=false`) keep texts — they have none.
 */
function includeSms(f: HistoryFilters, scope: HistoryScope): boolean {
  return (
    scope.sms &&
    f.type !== 'calls' &&
    f.disposition == null &&
    f.minDuration == null &&
    f.maxDuration == null &&
    f.hasRecording !== true &&
    f.hasNote !== true
  );
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

function str(v: unknown): string | null {
  return v == null ? null : String(v);
}

function num(v: unknown): number {
  return typeof v === 'number' ? v : v == null ? 0 : Number(v);
}

function isoOf(v: unknown): string {
  return (v instanceof Date ? v : new Date(String(v))).toISOString();
}

export interface HistoryItem {
  kind: 'call' | 'sms';
  id: string;
  direction: 'inbound' | 'outbound';
  status: string;
  at: string;
  duration_seconds: number | null;
  from_number: string;
  to_number: string;
  contact_name: string | null;
  address: string | null;
  user_id: string | null;
  user_name: string | null;
  disposition_slug: string | null;
  disposition_label: string | null;
  note: string | null;
  has_recording: boolean;
  /** The caller was sent to voicemail (calls.raw.voicemailOffered). */
  voicemail: boolean;
  body: string | null;
  media_count: number;
  lead_id: string | null;
  contact_id: string | null;
  conversation_id: string | null;
}

/** "123 Main St, San Antonio, TX" — whichever parts the CRM gave us. */
function oneLineAddress(line1: unknown, city: unknown, state: unknown): string | null {
  const cityState = [str(city), str(state)].filter((v): v is string => Boolean(v && v.trim())).join(', ');
  const parts = [str(line1), cityState].filter((v): v is string => Boolean(v && v.trim()));
  return parts.length ? parts.join(', ') : null;
}

function toItem(r: Row): HistoryItem {
  return {
    kind: r.kind === 'sms' ? 'sms' : 'call',
    id: String(r.id),
    direction: r.direction === 'inbound' ? 'inbound' : 'outbound',
    status: String(r.status),
    at: isoOf(r.at),
    duration_seconds: r.duration_seconds == null ? null : num(r.duration_seconds),
    from_number: String(r.from_number ?? ''),
    to_number: String(r.to_number ?? ''),
    contact_name: str(r.contact_name),
    address: oneLineAddress(r.address_line1, r.city, r.state),
    user_id: str(r.user_id),
    user_name: str(r.user_name),
    disposition_slug: str(r.disposition_slug),
    disposition_label: str(r.disposition_label),
    note: str(r.note),
    has_recording: r.has_recording === true,
    voicemail: r.voicemail === true,
    body: str(r.body),
    media_count: num(r.media_count),
    lead_id: str(r.lead_id),
    contact_id: str(r.contact_id),
    conversation_id: str(r.conversation_id),
  };
}

function callSelect(f: HistoryFilters, scope: HistoryScope): SQL {
  return sql`SELECT
      'call' AS kind, c.id::text AS id, c.direction::text AS direction, c.status::text AS status,
      ${CALL_AT} AS at, ${CALL_DURATION} AS duration_seconds,
      c.from_number, c.to_number, ct.display_name AS contact_name,
      addr.address_line1, addr.city, addr.state,
      c.user_id::text AS user_id, u.display_name AS user_name,
      d.slug AS disposition_slug, d.name AS disposition_label, c.disposition_note AS note,
      ${CALL_HAS_RECORDING} AS has_recording,
      COALESCE((c.raw->>'voicemailOffered')::boolean, FALSE) AS voicemail,
      NULL::text AS body, 0::int AS media_count,
      c.lead_id::text AS lead_id, c.contact_id::text AS contact_id, NULL::text AS conversation_id
    ${callsFrom(f, true)}
    WHERE ${callsWhere(f, scope)}`;
}

function smsSelect(f: HistoryFilters, scope: HistoryScope): SQL {
  return sql`SELECT
      'sms' AS kind, m.id::text AS id, m.direction::text AS direction, m.status::text AS status,
      m.created_at AS at, NULL::int AS duration_seconds,
      CASE WHEN m.direction = 'outbound' THEN conv.our_number ELSE conv.their_number END AS from_number,
      CASE WHEN m.direction = 'outbound' THEN conv.their_number ELSE conv.our_number END AS to_number,
      ct.display_name AS contact_name,
      addr.address_line1, addr.city, addr.state,
      ${SMS_USER}::text AS user_id, u.display_name AS user_name,
      NULL::text AS disposition_slug, NULL::text AS disposition_label, NULL::text AS note,
      FALSE AS has_recording,
      FALSE AS voicemail,
      m.body AS body, ${SMS_MEDIA_COUNT}::int AS media_count,
      conv.lead_id::text AS lead_id, conv.contact_id::text AS contact_id, m.conversation_id::text AS conversation_id
    ${smsFrom(f, true)}
    WHERE ${smsWhere(f, scope)}`;
}

/** Exported (with the KPI queries) so the SQL can be compiled and inspected without a route. */
export async function listItems(
  db: Db,
  f: HistoryFilters,
  scope: HistoryScope,
  limit: number,
  offset: number,
): Promise<HistoryItem[]> {
  const branches: SQL[] = [];
  if (includeCalls(f)) branches.push(callSelect(f, scope));
  if (includeSms(f, scope)) branches.push(smsSelect(f, scope));
  if (branches.length === 0) return [];
  const rows = (
    await db.execute(sql`
      SELECT * FROM (${sql.join(branches, sql` UNION ALL `)}) h
      ORDER BY h.at DESC, h.id DESC
      LIMIT ${limit} OFFSET ${offset}`)
  ).rows as Row[];
  return rows.map(toItem);
}

interface CallKpis {
  calls: number;
  answered: number;
  terminal: number;
  inbound: number;
  outbound: number;
  talk_seconds: number;
  talk_calls: number;
  by_disposition: Array<{ slug: string; label: string; count: number }>;
  by_rep: Map<string, { name: string; calls: number; answered: number; talk_seconds: number }>;
}

export async function callKpis(db: Db, f: HistoryFilters, scope: HistoryScope): Promise<CallKpis> {
  const empty: CallKpis = {
    calls: 0, answered: 0, terminal: 0, inbound: 0, outbound: 0, talk_seconds: 0, talk_calls: 0,
    by_disposition: [], by_rep: new Map(),
  };
  if (!includeCalls(f)) return empty;
  const where = callsWhere(f, scope);
  const from = callsFrom(f, false);
  const [totals, dispositions, reps] = await Promise.all([
    db.execute(sql`
      SELECT
        count(*)::int AS calls,
        count(*) FILTER (WHERE c.answered_at IS NOT NULL)::int AS answered,
        count(*) FILTER (WHERE ${CALL_TERMINAL})::int AS terminal,
        count(*) FILTER (WHERE c.direction = 'inbound')::int AS inbound,
        count(*) FILTER (WHERE c.direction = 'outbound')::int AS outbound,
        COALESCE(sum(${CALL_TALK_SECONDS}) FILTER (WHERE ${CALL_HAS_TALK}), 0)::float8 AS talk_seconds,
        count(*) FILTER (WHERE ${CALL_HAS_TALK})::int AS talk_calls
      ${from}
      WHERE ${where}`),
    db.execute(sql`
      SELECT d.slug, d.name, count(*)::int AS n
      ${from}
      WHERE ${where} AND c.disposition_id IS NOT NULL
      GROUP BY d.slug, d.name
      ORDER BY n DESC, d.slug`),
    db.execute(sql`
      SELECT c.user_id::text AS user_id, u.display_name AS name,
        count(*)::int AS calls,
        count(*) FILTER (WHERE c.answered_at IS NOT NULL)::int AS answered,
        COALESCE(sum(${CALL_TALK_SECONDS}) FILTER (WHERE ${CALL_HAS_TALK}), 0)::float8 AS talk_seconds
      ${from}
      WHERE ${where} AND c.user_id IS NOT NULL
      GROUP BY c.user_id, u.display_name`),
  ]);
  const t = (totals.rows[0] ?? {}) as Row;
  const byRep = new Map<string, { name: string; calls: number; answered: number; talk_seconds: number }>();
  for (const r of reps.rows as Row[]) {
    byRep.set(String(r.user_id), {
      name: str(r.name) ?? 'Unknown',
      calls: num(r.calls),
      answered: num(r.answered),
      talk_seconds: num(r.talk_seconds),
    });
  }
  return {
    calls: num(t.calls),
    answered: num(t.answered),
    terminal: num(t.terminal),
    inbound: num(t.inbound),
    outbound: num(t.outbound),
    talk_seconds: num(t.talk_seconds),
    talk_calls: num(t.talk_calls),
    by_disposition: (dispositions.rows as Row[]).map((d) => ({
      slug: String(d.slug),
      label: String(d.name),
      count: num(d.n),
    })),
    by_rep: byRep,
  };
}

interface SmsKpis {
  total: number;
  sent: number;
  received: number;
  by_rep: Map<string, { name: string; sms: number }>;
}

export async function smsKpis(db: Db, f: HistoryFilters, scope: HistoryScope): Promise<SmsKpis> {
  if (!includeSms(f, scope)) return { total: 0, sent: 0, received: 0, by_rep: new Map() };
  const where = smsWhere(f, scope);
  const from = smsFrom(f, false);
  const [totals, reps] = await Promise.all([
    db.execute(sql`
      SELECT
        count(*)::int AS total,
        count(*) FILTER (WHERE m.direction = 'outbound')::int AS sent,
        count(*) FILTER (WHERE m.direction = 'inbound')::int AS received
      ${from}
      WHERE ${where}`),
    db.execute(sql`
      SELECT ${SMS_USER}::text AS user_id, u.display_name AS name, count(*)::int AS sms
      ${from}
      WHERE ${where} AND ${SMS_USER} IS NOT NULL
      GROUP BY 1, 2`),
  ]);
  const t = (totals.rows[0] ?? {}) as Row;
  const byRep = new Map<string, { name: string; sms: number }>();
  for (const r of reps.rows as Row[]) {
    byRep.set(String(r.user_id), { name: str(r.name) ?? 'Unknown', sms: num(r.sms) });
  }
  return { total: num(t.total), sent: num(t.sent), received: num(t.received), by_rep: byRep };
}

export interface HistoryKpis {
  calls: number;
  answered: number;
  /** answered / terminal calls, both directions; null when nothing is terminal. */
  connect_rate: number | null;
  /** Mean talk time over calls with both stamps; null when none. */
  avg_duration_seconds: number | null;
  talk_time_seconds: number;
  inbound: number;
  outbound: number;
  sms_sent: number;
  sms_received: number;
  by_disposition: Array<{ slug: string; label: string; count: number }>;
  by_rep: Array<{
    user_id: string;
    name: string;
    calls: number;
    answered: number;
    talk_time_seconds: number;
    sms: number;
  }>;
}

function mergeKpis(calls: CallKpis, sms: SmsKpis): HistoryKpis {
  const reps = new Map<string, HistoryKpis['by_rep'][number]>();
  for (const [userId, r] of calls.by_rep) {
    reps.set(userId, { user_id: userId, name: r.name, calls: r.calls, answered: r.answered, talk_time_seconds: r.talk_seconds, sms: 0 });
  }
  for (const [userId, r] of sms.by_rep) {
    const existing = reps.get(userId);
    if (existing) existing.sms = r.sms;
    else reps.set(userId, { user_id: userId, name: r.name, calls: 0, answered: 0, talk_time_seconds: 0, sms: r.sms });
  }
  return {
    calls: calls.calls,
    answered: calls.answered,
    connect_rate: calls.terminal > 0 ? calls.answered / calls.terminal : null,
    avg_duration_seconds: calls.talk_calls > 0 ? calls.talk_seconds / calls.talk_calls : null,
    talk_time_seconds: calls.talk_seconds,
    inbound: calls.inbound,
    outbound: calls.outbound,
    sms_sent: sms.sent,
    sms_received: sms.received,
    by_disposition: calls.by_disposition,
    by_rep: [...reps.values()].sort((a, b) => b.calls - a.calls || b.sms - a.sms || a.name.localeCompare(b.name)),
  };
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/** RFC 4180 quoting. */
function csvCell(value: string | number | boolean | null): string {
  if (value == null) return '';
  const s = typeof value === 'string' ? value : String(value);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/**
 * Free text written by reps or sellers is neutralized against spreadsheet
 * formula injection (a note starting with `=HYPERLINK(...)` must open as
 * text). Our own phone numbers and ids are not run through this.
 */
function csvText(value: string | null): string {
  if (value == null) return '';
  return /^[=+\-@\t\r]/.test(value) ? `'${value}` : value;
}

function localStampFormatter(timezone: string): (iso: string) => string {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  return (iso) => {
    const parts = fmt.formatToParts(new Date(iso));
    const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
  };
}

function* csvLines(items: HistoryItem[], timezone: string): Generator<string> {
  const stamp = localStampFormatter(timezone);
  const header = [
    `when (${timezone})`, 'kind', 'direction', 'status', 'contact', 'phone', 'address', 'rep',
    'duration_seconds', 'disposition', 'note', 'recording', 'sms_body', 'id',
  ];
  // BOM so Excel reads UTF-8 names and addresses correctly.
  yield `﻿${header.map(csvCell).join(',')}\r\n`;
  for (const it of items) {
    const counterpart = it.direction === 'outbound' ? it.to_number : it.from_number;
    const cells = [
      stamp(it.at),
      it.kind === 'sms' ? 'text' : 'call',
      it.direction,
      it.status,
      csvText(it.contact_name),
      counterpart,
      csvText(it.address),
      csvText(it.user_name),
      it.duration_seconds,
      csvText(it.disposition_label),
      csvText(it.note),
      it.kind === 'call' ? (it.has_recording ? 'yes' : 'no') : '',
      csvText(it.body),
      it.id,
    ];
    yield `${cells.map(csvCell).join(',')}\r\n`;
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

interface Prepared {
  filters: HistoryFilters;
  scope: HistoryScope;
  limit: number;
  offset: number;
}

function scopeFor(ctx: AuthContext): HistoryScope {
  return {
    orgId: ctx.orgId,
    userId: ctx.userId,
    orgCalls: hasPermission(ctx, 'calls.read.org'),
    orgSms: hasPermission(ctx, 'messages.read.org'),
    sms: hasPermission(ctx, 'messages.read.own'),
  };
}

function toFilters(q: HistoryQuery, range: HistoryRange): HistoryFilters {
  const f: HistoryFilters = { type: q.type, range };
  if (q.direction) f.direction = q.direction;
  if (q.status) f.status = q.status;
  if (q.user_id) f.userId = q.user_id;
  if (q.disposition) f.disposition = q.disposition;
  if (q.min_duration != null) f.minDuration = q.min_duration;
  if (q.max_duration != null) f.maxDuration = q.max_duration;
  if (q.has_recording != null) f.hasRecording = q.has_recording;
  if (q.has_note != null) f.hasNote = q.has_note;
  if (q.q && q.q.trim()) f.q = q.q;
  return f;
}

export function registerHistoryRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { dbh } = deps;
  // Everyone who can read their own calls can read their own history; the
  // org/own split is decided per source inside the queries.
  const gate = { preHandler: requirePermission('calls.read.own') };

  /** Parse + validate the query or reply 400; returns null after replying. */
  async function prepare(req: FastifyRequest, reply: FastifyReply): Promise<Prepared | null> {
    const ctx = req.authCtx!;
    const parsed = querySchema.safeParse(stripEmpty(req.query));
    if (!parsed.success) {
      await reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
      return null;
    }
    const q = parsed.data;
    if (q.min_duration != null && q.max_duration != null && q.min_duration > q.max_duration) {
      await reply.code(400).send({ error: 'invalid_query', message: 'min_duration is greater than max_duration' });
      return null;
    }
    const timezone = await orgTimezone(dbh.db, ctx.orgId);
    let range: HistoryRange;
    try {
      range = resolveHistoryRange({ from: q.from, to: q.to }, timezone);
    } catch (err) {
      if (err instanceof HistoryRangeError) {
        await reply.code(400).send({ error: err.code, message: err.message });
        return null;
      }
      throw err;
    }
    return { filters: toFilters(q, range), scope: scopeFor(ctx), limit: q.limit, offset: q.offset };
  }

  app.get('/v1/history', gate, async (req, reply) => {
    const prepared = await prepare(req, reply);
    if (!prepared) return reply;
    const { filters, scope, limit, offset } = prepared;
    const [items, calls, sms] = await Promise.all([
      listItems(dbh.db, filters, scope, limit, offset),
      callKpis(dbh.db, filters, scope),
      smsKpis(dbh.db, filters, scope),
    ]);
    return {
      range: { from: filters.range.from, to: filters.range.to, timezone: filters.range.timezone },
      scope: scope.orgCalls ? 'org' : 'own',
      items,
      total: calls.calls + sms.total,
      kpis: mergeKpis(calls, sms),
    };
  });

  app.get('/v1/history/export.csv', gate, async (req, reply) => {
    const prepared = await prepare(req, reply);
    if (!prepared) return reply;
    const { filters, scope } = prepared;
    // The export ignores limit/offset: it is the whole filtered set, capped.
    const items = await listItems(dbh.db, filters, scope, EXPORT_MAX_ROWS, 0);
    const safe = (s: string) => s.replace(/[^0-9A-Za-z-]/g, '-');
    const filename = `talkr-history-${safe(filters.range.from)}-to-${safe(filters.range.to)}.csv`;
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('cache-control', 'no-store')
      .send(Readable.from(csvLines(items, filters.range.timezone)));
  });
}
