'use client';

/**
 * Reports (design 1c): a range picker, eight KPI tiles, calls-by-day as an
 * inline SVG (no chart deps), then by-rep, queues, quality and costs as
 * hairline tables. Manager-level (`reports.view.org`); reps see a clear
 * permission message instead of numbers.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ApiError,
  api,
  type ByDayReportDto,
  type ByRepReportDto,
  type CostsReportDto,
  type OverviewReportDto,
  type QualityReportDto,
  type QueuesReportDto,
} from '@/lib/api';
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

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function fmtSeconds(s: number | null | undefined): string {
  if (s == null) return '—';
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

function fmtRate(r: number | null): string {
  return r == null ? '—' : `${Math.round(r * 100)}%`;
}

function fmtMoney(amount: string, currency: string): string {
  const n = Number(amount);
  if (!Number.isFinite(n)) return `${amount} ${currency}`;
  return `${currency === 'USD' ? '$' : `${currency} `}${n.toFixed(2)}`;
}

function fmtDay(day: string): string {
  const d = new Date(`${day}T00:00:00`);
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

type Quick = 'today' | '7d' | '30d' | 'custom';

const QUICK: Array<{ value: Quick; label: string; days: number }> = [
  { value: 'today', label: 'Today', days: 0 },
  { value: '7d', label: '7 days', days: 6 },
  { value: '30d', label: '30 days', days: 29 },
];

const TEXT = { font: '500 12px/1 Inter' } as const;
const MUTED = { font: '500 11px/1 Inter', color: 'var(--muted)' } as const;
const NUM = { font: '600 12px/1 Inter' } as const;

/** Grouped bars: total (dim) with answered (accent) and missed (amber) inside. */
function ByDayChart({ days }: { days: ByDayReportDto['days'] }) {
  const width = 720;
  const height = 150;
  const pad = 4;
  const max = Math.max(1, ...days.map((d) => d.total));
  const bw = (width - pad * 2) / Math.max(1, days.length);
  const labelEvery = days.length > 16 ? Math.ceil(days.length / 12) : 1;
  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${width} ${height + 22}`} className="w-full" style={{ minWidth: 480 }} role="img" aria-label="Calls per day">
        {[0.25, 0.5, 0.75].map((f) => (
          <line key={f} x1={0} x2={width} y1={height * f} y2={height * f} stroke="var(--line-soft)" strokeWidth={1} />
        ))}
        {days.map((d, i) => {
          const x = pad + i * bw;
          const hTotal = (d.total / max) * height;
          const hAnswered = (d.answered / max) * height;
          const hMissed = (d.missed / max) * height;
          return (
            <g key={d.day}>
              <rect x={x + bw * 0.16} y={height - hTotal} width={bw * 0.68} height={hTotal} rx={3} fill="var(--panel-2)" />
              <rect x={x + bw * 0.16} y={height - hAnswered} width={bw * 0.32} height={hAnswered} rx={3} fill="var(--accent)" />
              <rect x={x + bw * 0.52} y={height - hMissed} width={bw * 0.32} height={hMissed} rx={3} fill="var(--amber)" />
              {i % labelEvery === 0 && (
                <text x={x + bw / 2} y={height + 15} textAnchor="middle" fontSize="9.5" fontWeight={600} fill="var(--muted-2)" fontFamily="Inter">
                  {fmtDay(d.day)}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Legend({ items }: { items: Array<{ color: string; label: string }> }) {
  return (
    <div className="flex flex-wrap gap-4">
      {items.map((it) => (
        <span key={it.label} className="inline-flex items-center gap-1.5">
          <span style={{ width: 6, height: 6, background: it.color }} aria-hidden />
          <span style={{ font: '600 9px/1 Inter', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--muted)' }}>
            {it.label}
          </span>
        </span>
      ))}
    </div>
  );
}

function TrendSparkline({ trend }: { trend: QualityReportDto['carrier_failure_trend'] }) {
  const width = 240;
  const height = 44;
  if (trend.length === 0) return <span style={MUTED}>No terminal calls in range.</span>;
  const rates = trend.map((t) => (t.terminal_calls > 0 ? t.carrier_failures / t.terminal_calls : null));
  const step = width / Math.max(1, trend.length - 1);
  const points = rates
    .map((r, i) => (r == null ? null : `${(i * step).toFixed(1)},${(height - 4 - r * (height - 8)).toFixed(1)}`))
    .filter((p): p is string => p != null);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} className="h-11 w-full" role="img" aria-label="Carrier failure rate trend">
      <line x1="0" y1={height - 1} x2={width} y2={height - 1} stroke="var(--line)" strokeWidth="1" />
      {points.length > 1 && <polyline points={points.join(' ')} fill="none" stroke="var(--red)" strokeWidth="1.5" strokeLinejoin="round" />}
      {points.length === 1 && <circle cx={points[0]!.split(',')[0]} cy={points[0]!.split(',')[1]} r="2.5" fill="var(--red)" />}
    </svg>
  );
}

function KeyValue({ rows }: { rows: Array<{ label: string; value: string; tone?: 'red' | 'amber' }> }) {
  return (
    <div className="flex flex-col">
      {rows.map((r, i) => (
        <div
          key={r.label}
          className="flex items-center justify-between gap-3 py-2"
          style={{ borderBottom: i === rows.length - 1 ? 'none' : '1px solid var(--line-soft)' }}
        >
          <span style={{ ...TEXT, color: r.tone === 'red' ? 'var(--red)' : 'var(--text)' }}>{r.label}</span>
          <span style={{ ...NUM, color: r.tone === 'amber' ? 'var(--amber)' : r.tone === 'red' ? 'var(--red)' : 'var(--text)' }}>
            {r.value}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function ReportsPage() {
  const { authed } = useSoftphone();
  const [quick, setQuick] = useState<Quick>('7d');
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 6 * 86_400_000)));
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [applied, setApplied] = useState<{ from: string; to: string }>({
    from: isoDay(new Date(Date.now() - 6 * 86_400_000)),
    to: isoDay(new Date()),
  });
  const [overview, setOverview] = useState<OverviewReportDto | null>(null);
  const [byRep, setByRep] = useState<ByRepReportDto | null>(null);
  const [byDay, setByDay] = useState<ByDayReportDto | null>(null);
  const [queues, setQueues] = useState<QueuesReportDto | null>(null);
  const [quality, setQuality] = useState<QualityReportDto | null>(null);
  const [costs, setCosts] = useState<CostsReportDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (range: { from: string; to: string }) => {
    setLoading(true);
    setError(null);
    try {
      const [o, r, d, q, ql, c] = await Promise.all([
        api.reportOverview(range),
        api.reportByRep(range),
        api.reportByDay(range),
        api.reportQueues(range),
        api.reportQuality(range),
        api.reportCosts(range),
      ]);
      setOverview(o);
      setByRep(r);
      setByDay(d);
      setQueues(q);
      setQuality(ql);
      setCosts(c);
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

  const subtitle = overview
    ? `${fmtDay(overview.range.from)} – ${fmtDay(overview.range.to)} · ${overview.range.timezone}`
    : loading
      ? 'Loading…'
      : 'Calls, reps, queues, quality, spend';

  const REP_COLS = '1.6fr 0.7fr 0.8fr 0.8fr 1fr 1fr 1.6fr 0.9fr';
  const QUEUE_COLS = '1.4fr 1fr 0.8fr 0.8fr 0.9fr 1.1fr 1.1fr';

  return (
    <>
      <TopBar title="Reports" subtitle={subtitle} />

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
                title="Reports are manager-level"
                hint="Ask an admin for the manager role if you need org-wide numbers."
              />
            </Card>
          )}

          {overview && (
            <>
              {/* ── KPIs ───────────────────────────────────────────────── */}
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <Kpi label="Total calls" value={String(overview.totals.total)} sub={`${overview.totals.outbound} out · ${overview.totals.inbound} in`} />
                <Kpi
                  label="Answered"
                  value={String(overview.totals.answered)}
                  sub={`out ${fmtRate(overview.answer_rate.outbound)} · in ${fmtRate(overview.answer_rate.inbound)}`}
                />
                <Kpi
                  label="Missed inbound"
                  value={String(overview.totals.missed)}
                  sub={`${overview.totals.voicemails_left} voicemail${overview.totals.voicemails_left === 1 ? '' : 's'} left`}
                  tone={overview.totals.missed > 0 ? 'amber' : undefined}
                />
                <Kpi
                  label="Talk time"
                  value={fmtSeconds(overview.talk.total_seconds)}
                  sub={`avg ${fmtSeconds(overview.talk.avg_seconds)} over ${overview.talk.calls_with_talk} calls`}
                />
                <Kpi
                  label="Speed to lead"
                  value={fmtSeconds(overview.speed_to_lead.avg_seconds)}
                  sub={`${overview.speed_to_lead.leads_received} leads · ${overview.speed_to_lead.leads_awaiting_first_attempt} untouched`}
                />
                <Kpi
                  label="Undispositioned"
                  value={String(overview.totals.undispositioned)}
                  sub="calls without wrap-up"
                  tone={overview.totals.undispositioned > 0 ? 'amber' : undefined}
                />
                <Kpi
                  label="Open mismatches"
                  value={quality ? String(quality.mismatches.open) : '—'}
                  sub={quality ? `${quality.mismatches.resolved} resolved in range` : undefined}
                  tone={quality && quality.mismatches.open > 0 ? 'red' : undefined}
                />
                <Kpi
                  label="Spend"
                  value={costs?.has_data ? costs.total.map((t) => fmtMoney(t.amount, t.currency)).join(' · ') : 'No data'}
                  sub={costs?.has_data ? `${costs.total.reduce((a, t) => a + t.items, 0)} priced items` : 'prices arrive from the carrier'}
                />
              </div>

              {/* ── By day ─────────────────────────────────────────────── */}
              <Card className="flex flex-col gap-3.5">
                <SectionTitle
                  icon={<Icon name="grid" size={16} />}
                  right={
                    <Legend
                      items={[
                        { color: 'var(--panel-2)', label: 'Total' },
                        { color: 'var(--accent)', label: 'Answered' },
                        { color: 'var(--amber)', label: 'Missed' },
                      ]}
                    />
                  }
                >
                  Calls by day
                </SectionTitle>
                {byDay && byDay.days.length > 0 ? (
                  <ByDayChart days={byDay.days} />
                ) : (
                  <span style={MUTED}>No calls in this range.</span>
                )}
              </Card>

              {/* ── By rep ─────────────────────────────────────────────── */}
              <Card padded={false} className="overflow-x-auto">
                <div className="px-4 pt-4 pb-3">
                  <SectionTitle icon={<Icon name="users" size={16} />}>By rep</SectionTitle>
                </div>
                <GridHead cols={REP_COLS} minWidth={880}>
                  <Eyebrow>Rep</Eyebrow>
                  <Eyebrow>Made</Eyebrow>
                  <Eyebrow>Received</Eyebrow>
                  <Eyebrow>Answered</Eyebrow>
                  <Eyebrow>Talk time</Eyebrow>
                  <Eyebrow>Avg wrap-up</Eyebrow>
                  <Eyebrow>Dispositions</Eyebrow>
                  <Eyebrow className="text-right">Cost</Eyebrow>
                </GridHead>
                {(byRep?.reps.length ?? 0) === 0 && <EmptyState title="No rep activity in this range" />}
                {byRep?.reps.map((r, i) => (
                  <GridRow key={r.user_id} cols={REP_COLS} minWidth={880} style={i === byRep.reps.length - 1 ? { borderBottom: 'none' } : undefined}>
                    <span className="flex min-w-0 items-center gap-2.5">
                      <Avatar name={r.display_name} size={28} />
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="truncate" style={{ font: '600 12.5px/1 Inter' }}>{r.display_name}</span>
                        <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted)', textTransform: 'capitalize' }}>{r.role}</span>
                      </span>
                    </span>
                    <span style={NUM}>{r.calls_made}</span>
                    <span style={NUM}>{r.calls_received}</span>
                    <span style={NUM}>{r.answered}</span>
                    <span style={NUM}>{fmtSeconds(r.talk_seconds)}</span>
                    <span style={NUM}>{fmtSeconds(r.avg_wrapup_seconds)}</span>
                    <span className="truncate" style={MUTED}>
                      {Object.entries(r.dispositions)
                        .map(([slug, n]) => `${slug.replace(/_/g, ' ')} ${n}`)
                        .join(' · ') || '—'}
                    </span>
                    <span className="text-right" style={NUM}>
                      {r.cost
                        ? Object.entries(r.cost)
                            .map(([currency, amount]) => fmtMoney(amount, currency))
                            .join(' · ')
                        : '—'}
                    </span>
                  </GridRow>
                ))}
              </Card>

              {/* ── Queues ─────────────────────────────────────────────── */}
              <Card padded={false} className="overflow-x-auto">
                <div className="px-4 pt-4 pb-3">
                  <SectionTitle icon={<Icon name="voicemail" size={16} />}>Queues</SectionTitle>
                </div>
                <GridHead cols={QUEUE_COLS} minWidth={760}>
                  <Eyebrow>Queue</Eyebrow>
                  <Eyebrow>Strategy</Eyebrow>
                  <Eyebrow>Offered</Eyebrow>
                  <Eyebrow>Answered</Eyebrow>
                  <Eyebrow>Overflowed</Eyebrow>
                  <Eyebrow>Wait → answer</Eyebrow>
                  <Eyebrow>Wait → overflow</Eyebrow>
                </GridHead>
                {(queues?.queues.length ?? 0) === 0 && (
                  <EmptyState title="No queues configured" hint="Inbound routing rings reps directly until a queue exists." />
                )}
                {queues?.queues.map((q, i) => (
                  <GridRow key={q.queue_id} cols={QUEUE_COLS} minWidth={760} style={i === queues.queues.length - 1 ? { borderBottom: 'none' } : undefined}>
                    <span style={{ font: '600 12.5px/1 Inter' }}>{q.name}</span>
                    <span style={{ ...MUTED, textTransform: 'capitalize' }}>{q.strategy.replace(/_/g, ' ')}</span>
                    <span style={NUM}>{q.offered}</span>
                    <span style={NUM}>{q.answered}</span>
                    <span style={{ ...NUM, color: q.overflowed > 0 ? 'var(--amber)' : 'var(--text)' }}>{q.overflowed}</span>
                    <span style={NUM}>{fmtSeconds(q.avg_wait_to_answer_seconds)}</span>
                    <span style={NUM}>{fmtSeconds(q.avg_wait_to_overflow_seconds)}</span>
                  </GridRow>
                ))}
              </Card>

              {/* ── Quality ────────────────────────────────────────────── */}
              {quality && (
                <div className="grid gap-3 md:grid-cols-2">
                  <Card className="flex flex-col gap-3">
                    <SectionTitle icon={<Icon name="check" size={16} />}>Why calls ended</SectionTitle>
                    {Object.keys(quality.failure_classes).length === 0 ? (
                      <span style={MUTED}>No terminal calls in range.</span>
                    ) : (
                      <KeyValue
                        rows={Object.entries(quality.failure_classes).map(([cls, n]) => ({
                          label: cls === 'none' ? 'Clean' : cls.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase()),
                          value: String(n),
                          tone: cls === 'platform_failure' || cls === 'carrier_failure' ? 'red' : undefined,
                        }))}
                      />
                    )}
                  </Card>
                  <Card className="flex flex-col gap-3">
                    <SectionTitle icon={<Icon name="globe" size={16} />}>Carrier health</SectionTitle>
                    <div className="flex flex-col gap-1.5">
                      <Eyebrow>Carrier failure rate</Eyebrow>
                      <TrendSparkline trend={quality.carrier_failure_trend} />
                    </div>
                    <KeyValue
                      rows={[
                        { label: 'Recordings missing', value: String(quality.recordings.missing), tone: quality.recordings.missing > 0 ? 'amber' : undefined },
                        { label: 'Recordings failed', value: String(quality.recordings.failed), tone: quality.recordings.failed > 0 ? 'red' : undefined },
                        { label: 'Mismatches open / resolved', value: `${quality.mismatches.open} / ${quality.mismatches.resolved}` },
                      ]}
                    />
                  </Card>
                </div>
              )}

              {/* ── Costs ──────────────────────────────────────────────── */}
              {costs && !costs.has_data && (
                <Notice>
                  No cost data for this range. Carrier prices land via status callbacks and reconciliation, so very recent
                  traffic may not be priced yet. This is “no data”, not $0.00.
                </Notice>
              )}
              {costs?.has_data && (
                <div className="grid gap-3 md:grid-cols-2">
                  <Card padded={false}>
                    <div className="px-4 pt-4 pb-3">
                      <SectionTitle icon={<Icon name="clock" size={16} />}>Spend by day</SectionTitle>
                    </div>
                    <GridHead cols="1fr auto">
                      <Eyebrow>Day</Eyebrow>
                      <Eyebrow className="text-right">Spend</Eyebrow>
                    </GridHead>
                    {costs.by_day.map((d, i) => (
                      <GridRow key={`${d.day}-${d.currency}`} cols="1fr auto" style={i === costs.by_day.length - 1 ? { borderBottom: 'none' } : undefined}>
                        <span style={TEXT}>{fmtDay(d.day)}</span>
                        <span style={NUM}>{fmtMoney(d.amount, d.currency)}</span>
                      </GridRow>
                    ))}
                  </Card>
                  <Card padded={false}>
                    <div className="px-4 pt-4 pb-3">
                      <SectionTitle icon={<Icon name="users" size={16} />}>Spend by rep</SectionTitle>
                    </div>
                    <GridHead cols="1fr auto">
                      <Eyebrow>Rep</Eyebrow>
                      <Eyebrow className="text-right">Spend</Eyebrow>
                    </GridHead>
                    {costs.by_rep.map((r, i) => (
                      <GridRow key={`${r.user_id ?? 'none'}-${r.currency}-${i}`} cols="1fr auto" style={i === costs.by_rep.length - 1 ? { borderBottom: 'none' } : undefined}>
                        <span style={TEXT}>{r.display_name ?? 'Unattributed'}</span>
                        <span style={NUM}>{fmtMoney(r.amount, r.currency)}</span>
                      </GridRow>
                    ))}
                  </Card>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
