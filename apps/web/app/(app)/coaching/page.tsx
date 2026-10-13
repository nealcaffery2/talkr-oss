'use client';

/**
 * Coaching (docs/coaching.md §5): what a manager opens on Monday. A range
 * picker, the org's average and its move against the previous period, the
 * rubric averaged across every scored call, and then the reps — each with an
 * average, the three categories they are weakest at, and a link straight into
 * their worst scored call in the range.
 *
 * Its own page rather than a seventh section of /reports: reports answers
 * "how much did we do", this answers "how well", it is gated on a different
 * permission (`calls.read.org`), and a manager coaching a rep stays here for
 * ten minutes rather than glancing at a tile.
 */

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { ApiError, api, type CoachingSummaryDto, type CategoryAverageDto } from '@/lib/api';
import { useSoftphone } from '@/lib/softphone';
import { TopBar } from '@/components/TopBar';
import { Icon } from '@/components/Icon';
import {
  Avatar,
  Button,
  Card,
  EmptyState,
  Eyebrow,
  GridHead,
  GridRow,
  Input,
  Kpi,
  Notice,
  SectionTitle,
  Segmented,
} from '@/components/ui';
import { BAND_COLOR, BAND_LABEL, categoryColor, formatTrend, scoreBand, trendColor } from '@/lib/coaching';

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtDay(day: string): string {
  return new Date(`${day}T00:00:00`).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

type Quick = 'today' | '7d' | '30d' | 'custom';

const QUICK: Array<{ value: Quick; label: string; days: number }> = [
  { value: 'today', label: 'Today', days: 0 },
  { value: '7d', label: '7 days', days: 6 },
  { value: '30d', label: '30 days', days: 29 },
];

const MUTED = { font: '500 11px/1.4 Inter', color: 'var(--muted)' } as const;
const NUM = { font: '600 12px/1 Inter', fontVariantNumeric: 'tabular-nums' } as const;

const REP_COLS = '1.7fr 0.7fr 0.9fr 0.8fr 0.9fr 2.4fr 0.9fr';

/** One 0–10 category average as a bar plus its number. */
function CategoryBar({ row }: { row: CategoryAverageDto }) {
  const pct = row.average != null ? (row.average / 10) * 100 : 0;
  return (
    <div className="flex items-center gap-3">
      <span className="truncate" style={{ font: '600 11.5px/1.3 Inter', width: 132 }} title={row.label}>
        {row.label}
      </span>
      <span className="flex h-1.5 flex-1 overflow-hidden" style={{ borderRadius: 2, background: 'var(--panel-2)' }}>
        <span style={{ width: `${pct}%`, background: categoryColor(row.average) }} />
      </span>
      <span style={{ ...NUM, minWidth: 30, textAlign: 'right', color: row.average == null ? 'var(--muted-2)' : 'var(--text)' }}>
        {row.average ?? '—'}
      </span>
      <span style={{ font: '500 10px/1 Inter', color: 'var(--muted-2)', minWidth: 52 }}>
        {row.scored} call{row.scored === 1 ? '' : 's'}
      </span>
    </div>
  );
}

export default function CoachingPage() {
  const { authed } = useSoftphone();
  const [quick, setQuick] = useState<Quick>('30d');
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 29 * 86_400_000)));
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [applied, setApplied] = useState<{ from: string; to: string }>({
    from: isoDay(new Date(Date.now() - 29 * 86_400_000)),
    to: isoDay(new Date()),
  });
  const [summary, setSummary] = useState<CoachingSummaryDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (range: { from: string; to: string }) => {
    setLoading(true);
    setError(null);
    try {
      setSummary(await api.coachingSummary(range));
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      else setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authed) return;
    void load(applied);
  }, [authed, applied, load]);

  function pickQuick(next: Quick) {
    setQuick(next);
    const q = QUICK.find((x) => x.value === next);
    if (!q) return;
    const t = isoDay(new Date());
    const f = isoDay(new Date(Date.now() - q.days * 86_400_000));
    setFrom(f);
    setTo(t);
    setApplied({ from: f, to: t });
  }

  if (!authed) {
    return (
      <p className="p-6" style={{ font: '400 13px/1.5 Inter', color: 'var(--muted)' }}>
        Not signed in — open <a href="/login" style={{ color: 'var(--accent)' }}>Account</a>.
      </p>
    );
  }

  const totals = summary?.totals;
  const band = totals?.avg_overall != null ? scoreBand(totals.avg_overall) : null;
  const subtitle = summary
    ? `${fmtDay(summary.range.from)} – ${fmtDay(summary.range.to)} · ${summary.range.timezone}`
    : loading
      ? 'Loading…'
      : 'How the team is selling, call by call';

  return (
    <>
      <TopBar title="Coaching" subtitle={subtitle} />

      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div className="flex flex-col gap-4">
          {/* ── Range ───────────────────────────────────────────────────── */}
          <div className="flex flex-wrap items-center gap-2.5">
            <Segmented
              value={quick}
              options={[...QUICK.map((q) => ({ value: q.value, label: q.label })), { value: 'custom' as Quick, label: 'Custom' }]}
              onChange={(v) => (v === 'custom' ? setQuick('custom') : pickQuick(v))}
            />
            <div className="ml-auto flex flex-wrap items-center gap-2">
              <Input
                type="date"
                aria-label="From"
                value={from}
                onChange={(e) => {
                  setFrom(e.target.value);
                  setQuick('custom');
                }}
                style={{ padding: '7px 10px', font: '500 11.5px/1 Inter' }}
              />
              <span style={{ font: '500 11px/1 Inter', color: 'var(--muted-2)' }}>to</span>
              <Input
                type="date"
                aria-label="To"
                value={to}
                onChange={(e) => {
                  setTo(e.target.value);
                  setQuick('custom');
                }}
                style={{ padding: '7px 10px', font: '500 11.5px/1 Inter' }}
              />
              <Button tone="dark" onClick={() => setApplied({ from, to })} disabled={loading || !from || !to} style={{ padding: '8px 13px' }}>
                {loading ? 'Loading…' : 'Apply'}
              </Button>
            </div>
          </div>

          {error && <Notice tone="error">{error}</Notice>}

          {forbidden && (
            <Card padded={false}>
              <EmptyState
                title="Coaching is manager-level"
                hint="Ask an admin for the manager role if you need the whole team's scores."
              />
            </Card>
          )}

          {summary && !summary.configured && (
            <Notice tone="warn">
              Call scoring is not set up — add <code>ANTHROPIC_API_KEY</code> to the API environment and finished
              transcripts will be scored automatically.
            </Notice>
          )}

          {summary && (
            <>
              {/* ── The org ─────────────────────────────────────────────── */}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Kpi
                  label="Average score"
                  value={totals?.avg_overall != null ? String(totals.avg_overall) : '—'}
                  sub={band ? `${BAND_LABEL[band]} · out of 100` : 'nothing scored yet'}
                  tone={band === 'strong' ? 'green' : band === 'developing' ? 'amber' : band === 'weak' ? 'red' : undefined}
                />
                <Kpi
                  label="Trend"
                  value={formatTrend(totals?.trend ?? null)}
                  sub={`vs ${fmtDay(summary.previous_range.from)} – ${fmtDay(summary.previous_range.to)}`}
                  tone={totals?.trend == null || totals.trend === 0 ? undefined : totals.trend > 0 ? 'green' : 'red'}
                />
                <Kpi
                  label="Calls scored"
                  value={String(totals?.calls_scored ?? 0)}
                  sub={`${totals?.previous_calls_scored ?? 0} in the previous period`}
                />
                <Kpi
                  label="Weakest"
                  value={totals?.weakest[0]?.label ?? '—'}
                  sub={totals?.weakest[0]?.average != null ? `${totals.weakest[0].average}/10 across the team` : 'nothing scored yet'}
                  tone={totals?.weakest[0]?.average != null && totals.weakest[0].average < 5 ? 'amber' : undefined}
                />
              </div>

              {/* ── The rubric ──────────────────────────────────────────── */}
              <Card className="flex flex-col gap-3.5">
                <SectionTitle icon={<Icon name="award" size={16} />}>Rubric across the team</SectionTitle>
                {totals && totals.calls_scored > 0 ? (
                  <div className="flex flex-col gap-2">
                    {totals.categories.map((c) => (
                      <CategoryBar key={c.category} row={c} />
                    ))}
                  </div>
                ) : (
                  <span style={MUTED}>No calls were scored in this range.</span>
                )}
              </Card>

              {/* ── By rep ──────────────────────────────────────────────── */}
              <Card padded={false} className="overflow-x-auto">
                <div className="px-4 pb-3 pt-4">
                  <SectionTitle icon={<Icon name="users" size={16} />}>By rep</SectionTitle>
                </div>
                <GridHead cols={REP_COLS} minWidth={900}>
                  <Eyebrow>Rep</Eyebrow>
                  <Eyebrow>Scored</Eyebrow>
                  <Eyebrow>Average</Eyebrow>
                  <Eyebrow>Trend</Eyebrow>
                  <Eyebrow>Talk ratio</Eyebrow>
                  <Eyebrow>Weakest categories</Eyebrow>
                  <Eyebrow className="text-right">Listen to</Eyebrow>
                </GridHead>
                {summary.reps.length === 0 && (
                  <EmptyState
                    title="Nothing scored in this range"
                    hint="Calls are scored automatically once their transcript finishes. Open a call and use “Score this call” to score an older one."
                  />
                )}
                {summary.reps.map((r, i) => {
                  const repBand = r.avg_overall != null ? scoreBand(r.avg_overall) : null;
                  return (
                    <GridRow
                      key={r.user_id ?? 'unassigned'}
                      cols={REP_COLS}
                      minWidth={900}
                      style={i === summary.reps.length - 1 ? { borderBottom: 'none' } : undefined}
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <Avatar name={r.user_name} size={28} />
                        <span className="truncate" style={{ font: '600 12.5px/1 Inter' }}>{r.user_name}</span>
                      </span>
                      <span style={NUM}>{r.calls_scored}</span>
                      <span style={{ ...NUM, font: '700 14px/1 Inter', color: repBand ? BAND_COLOR[repBand] : 'var(--muted-2)' }}>
                        {r.avg_overall ?? '—'}
                      </span>
                      <span style={{ ...NUM, color: trendColor(r.trend) }}>{formatTrend(r.trend)}</span>
                      <span style={NUM}>
                        {r.avg_talk_ratio != null ? `${Math.round(r.avg_talk_ratio * 100)}%` : '—'}
                      </span>
                      <span className="flex min-w-0 flex-wrap gap-x-3 gap-y-1">
                        {r.weakest.length === 0 && <span style={MUTED}>—</span>}
                        {r.weakest.map((w) => (
                          <span key={w.category} className="inline-flex items-center gap-1.5">
                            <span style={{ width: 6, height: 6, background: categoryColor(w.average) }} aria-hidden />
                            <span style={{ font: '500 11.5px/1 Inter' }}>{w.label}</span>
                            <span style={{ font: '600 11px/1 Inter', color: 'var(--muted)', fontVariantNumeric: 'tabular-nums' }}>
                              {w.average}
                            </span>
                          </span>
                        ))}
                      </span>
                      <span className="text-right">
                        {r.example_call_id ? (
                          <Link
                            href={`/calls/${r.example_call_id}`}
                            style={{ font: '600 11.5px/1 Inter', color: 'var(--accent)' }}
                            title="Their lowest-scoring call in this range"
                          >
                            {r.example_overall != null ? `${r.example_overall}/100` : 'Open'} →
                          </Link>
                        ) : (
                          <span style={MUTED}>—</span>
                        )}
                      </span>
                    </GridRow>
                  );
                })}
              </Card>
            </>
          )}
        </div>
      </div>
    </>
  );
}
