/**
 * The coaching rollup a manager reads (docs/coaching.md §4): per-rep average
 * score, average per category, the three weakest categories, and the trend
 * against the previous period of the same length.
 *
 * Read side only — this module never writes. It borrows reporting's range
 * vocabulary (services/reports.ts: org-timezone local days, from/to
 * inclusive) so "last 7 days" means the same thing on /coaching as it does on
 * /reports, and it dates a score by the *call*, not by when the score was
 * written, for the same reason.
 *
 * The per-category averaging happens in TypeScript rather than SQL: the
 * categories live in a jsonb blob whose keys are a code-owned vocabulary
 * (@talkr/core COACHING_CATEGORIES), and a range is capped at 366 days of one
 * org's scored calls, which is a few thousand small rows at most.
 */

import { and, asc, eq, gte, lt, sql, type SQL } from 'drizzle-orm';
import {
  COACHING_CATEGORIES,
  averageOf,
  weakestCategories,
  type CategoryAverage,
  type CategoryScore,
  type CoachingCategoryId,
} from '@talkr/core';
import { schema, type Db } from '@talkr/db';
import type { ReportRange } from './reports.js';

export interface CoachingRepRow {
  /** Null for calls no rep owns (inbound that nobody answered, API-placed). */
  user_id: string | null;
  user_name: string;
  calls_scored: number;
  /** 0-100, the stored scale. */
  avg_overall: number | null;
  /** 0-1 rep share of speaking time, averaged over the rep's scored calls. */
  avg_talk_ratio: number | null;
  categories: CategoryAverage[];
  /** Lowest first; categories nobody was scored on are left out, not ranked 0. */
  weakest: CategoryAverage[];
  previous_calls_scored: number;
  previous_avg_overall: number | null;
  /** avg_overall minus the previous period's; null when either side is empty. */
  trend: number | null;
  /** The rep's lowest-scoring call in the range — where to listen first. */
  example_call_id: string | null;
  example_overall: number | null;
}

export interface CoachingSummary {
  range: ReportRange;
  /** The equal-length period immediately before `range`, which `trend` compares against. */
  previous_range: { from: string; to: string };
  totals: {
    calls_scored: number;
    avg_overall: number | null;
    previous_calls_scored: number;
    previous_avg_overall: number | null;
    trend: number | null;
    categories: CategoryAverage[];
    weakest: CategoryAverage[];
  };
  reps: CoachingRepRow[];
}

interface ScoreRow {
  callId: string;
  userId: string | null;
  userName: string | null;
  overall: number | null;
  repTalkRatio: number | null;
  categories: Partial<Record<CoachingCategoryId, CategoryScore>>;
}

const UNASSIGNED = 'Unassigned';

/** A call belongs to the local day it started — the same rule reporting uses. */
const startedAt = sql`COALESCE(${schema.calls.initiatedAt}, ${schema.calls.createdAt})`;

function dayStart(day: string, timezone: string): SQL {
  return sql`((${day}::date)::timestamp AT TIME ZONE ${timezone})`;
}

function dayAfter(day: string, timezone: string): SQL {
  return sql`((${day}::date + 1)::timestamp AT TIME ZONE ${timezone})`;
}

function addDays(day: string, days: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

/** The equal-length window ending the day before `range.from`. */
export function previousRange(range: ReportRange): { from: string; to: string } {
  const days = (Date.parse(`${range.to}T00:00:00Z`) - Date.parse(`${range.from}T00:00:00Z`)) / 86_400_000 + 1;
  const to = addDays(range.from, -1);
  return { from: addDays(to, -(days - 1)), to };
}

async function loadScores(
  db: Db,
  orgId: string,
  window: { from: string; to: string },
  timezone: string,
  userId?: string,
): Promise<ScoreRow[]> {
  const where = [
    eq(schema.callScores.orgId, orgId),
    eq(schema.callScores.status, 'completed'),
    gte(startedAt, dayStart(window.from, timezone)),
    lt(startedAt, dayAfter(window.to, timezone)),
  ];
  if (userId) where.push(eq(schema.calls.userId, userId));

  const rows = await db
    .select({
      callId: schema.callScores.callId,
      userId: schema.calls.userId,
      userName: schema.users.displayName,
      overall: schema.callScores.overall,
      repTalkRatio: schema.callScores.repTalkRatio,
      categories: schema.callScores.categories,
    })
    .from(schema.callScores)
    .innerJoin(schema.calls, eq(schema.calls.id, schema.callScores.callId))
    .leftJoin(schema.users, eq(schema.users.id, schema.calls.userId))
    .where(and(...where))
    .orderBy(asc(schema.callScores.overall));

  return rows.map((r) => ({
    callId: r.callId,
    userId: r.userId,
    userName: r.userName,
    overall: r.overall,
    // numeric(4,3) arrives as a string; null stays null.
    repTalkRatio: r.repTalkRatio != null ? Number(r.repTalkRatio) : null,
    categories: (r.categories ?? {}) as Partial<Record<CoachingCategoryId, CategoryScore>>,
  }));
}

/** Per-category averages over a set of scores, in the rubric's own order. */
export function categoryAverages(rows: ScoreRow[]): CategoryAverage[] {
  return COACHING_CATEGORIES.map((c) => {
    const scores = rows
      .map((r) => r.categories[c.id]?.score)
      .filter((s): s is number => typeof s === 'number' && Number.isFinite(s));
    return { category: c.id, label: c.label, average: averageOf(scores), scored: scores.length };
  });
}

function summarize(rows: ScoreRow[], previous: ScoreRow[]): CoachingSummary['totals'] {
  const avg = averageOf(rows.map((r) => r.overall));
  const previousAvg = averageOf(previous.map((r) => r.overall));
  const categories = categoryAverages(rows);
  return {
    calls_scored: rows.length,
    avg_overall: avg,
    previous_calls_scored: previous.length,
    previous_avg_overall: previousAvg,
    trend: avg != null && previousAvg != null ? Math.round((avg - previousAvg) * 10) / 10 : null,
    categories,
    weakest: weakestCategories(categories),
  };
}

function groupByRep(rows: ScoreRow[]): Map<string, ScoreRow[]> {
  const groups = new Map<string, ScoreRow[]>();
  for (const row of rows) {
    const key = row.userId ?? '';
    const list = groups.get(key);
    if (list) list.push(row);
    else groups.set(key, [row]);
  }
  return groups;
}

export async function coachingSummary(
  db: Db,
  orgId: string,
  range: ReportRange,
  opts: { userId?: string } = {},
): Promise<CoachingSummary> {
  const previous = previousRange(range);
  const [rows, previousRows] = await Promise.all([
    loadScores(db, orgId, range, range.timezone, opts.userId),
    loadScores(db, orgId, previous, range.timezone, opts.userId),
  ]);

  const previousByRep = groupByRep(previousRows);
  const reps: CoachingRepRow[] = [...groupByRep(rows).entries()].map(([key, repRows]) => {
    const before = previousByRep.get(key) ?? [];
    const avg = averageOf(repRows.map((r) => r.overall));
    const previousAvg = averageOf(before.map((r) => r.overall));
    const categories = categoryAverages(repRows);
    // Rows arrive ordered by overall ascending, so the first with a score is
    // the weakest call — the one worth listening to.
    const example = repRows.find((r) => r.overall != null) ?? null;
    return {
      user_id: key || null,
      user_name: repRows.find((r) => r.userName)?.userName ?? UNASSIGNED,
      calls_scored: repRows.length,
      avg_overall: avg,
      avg_talk_ratio: averageOf(repRows.map((r) => r.repTalkRatio), 3),
      categories,
      weakest: weakestCategories(categories),
      previous_calls_scored: before.length,
      previous_avg_overall: previousAvg,
      trend: avg != null && previousAvg != null ? Math.round((avg - previousAvg) * 10) / 10 : null,
      example_call_id: example?.callId ?? null,
      example_overall: example?.overall ?? null,
    };
  });

  // Most-scored first, then by name, so the table has a stable order that
  // puts the reps a manager has evidence about at the top.
  reps.sort((a, b) => b.calls_scored - a.calls_scored || a.user_name.localeCompare(b.user_name));

  return { range, previous_range: previous, totals: summarize(rows, previousRows), reps };
}
