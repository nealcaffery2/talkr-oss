'use client';

/**
 * History (design 1c): one filterable feed of calls and texts, a KPI strip
 * that follows the filters, and a CSV export. Filter state lives in the URL
 * so a manager can send a teammate exactly the view they are looking at.
 *
 * Numbers come from GET /v1/history and share the reporting definitions
 * (docs/reporting.md): talk time is answered→ended, connect rate is answered
 * over terminal calls. The page adds nothing of its own.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  ApiError,
  api,
  type ContactDto,
  type DispositionDto,
  type HistoryItemDto,
  type HistoryQuery,
  type HistoryResponseDto,
  type HistoryType,
  type TeamMemberDto,
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
  Segmented,
  Select,
  Toggle,
} from '@/components/ui';
import { AddContactButton } from '@/components/AddContact';
import { duration, formatPhone } from '@/lib/time';

const PAGE = 50;

// ── Filters ↔ URL ────────────────────────────────────────────────────────────

type Preset = 'today' | 'yesterday' | '7d' | '30d' | 'month' | 'custom';

const PRESETS: Array<{ value: Preset; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: 'Last 7' },
  { value: '30d', label: 'Last 30' },
  { value: 'month', label: 'This month' },
  { value: 'custom', label: 'Custom' },
];

const DURATIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'Any length' },
  { value: '30', label: '30s+' },
  { value: '60', label: '1m+' },
  { value: '300', label: '5m+' },
];

interface Filters {
  preset: Preset;
  /** Only meaningful when preset is custom. */
  from: string;
  to: string;
  type: HistoryType;
  direction: '' | 'inbound' | 'outbound';
  user: string;
  disposition: string;
  min: string;
  rec: boolean;
  note: boolean;
  q: string;
}

function isPreset(v: string | null): v is Preset {
  return PRESETS.some((p) => p.value === v);
}

function isType(v: string | null): v is HistoryType {
  return v === 'all' || v === 'calls' || v === 'sms';
}

/** YYYY-MM-DD in the browser's zone; the server buckets it in the org zone. */
function localDay(d: Date): string {
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}

function daysAgo(n: number, now: Date): Date {
  const d = new Date(now);
  d.setDate(d.getDate() - n);
  return d;
}

function presetRange(preset: Preset, now: Date = new Date()): { from: string; to: string } {
  const today = localDay(now);
  switch (preset) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday': {
      const y = localDay(daysAgo(1, now));
      return { from: y, to: y };
    }
    case '7d':
      return { from: localDay(daysAgo(6, now)), to: today };
    case 'month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case '30d':
    case 'custom':
    default:
      return { from: localDay(daysAgo(29, now)), to: today };
  }
}

function parseFilters(p: URLSearchParams): Filters {
  const from = p.get('from') ?? '';
  const to = p.get('to') ?? '';
  const range = p.get('range');
  const type = p.get('type');
  const dir = p.get('dir');
  return {
    preset: isPreset(range) ? range : from || to ? 'custom' : '30d',
    from,
    to,
    type: isType(type) ? type : 'all',
    direction: dir === 'inbound' || dir === 'outbound' ? dir : '',
    user: p.get('user') ?? '',
    disposition: p.get('disp') ?? '',
    min: DURATIONS.some((d) => d.value === p.get('min')) ? (p.get('min') ?? '') : '',
    rec: p.get('rec') === '1',
    note: p.get('note') === '1',
    q: p.get('q') ?? '',
  };
}

/** Only non-default values go in the URL, so the bare route stays clean. */
function serializeFilters(f: Filters): string {
  const p = new URLSearchParams();
  if (f.preset !== '30d') p.set('range', f.preset);
  if (f.preset === 'custom') {
    if (f.from) p.set('from', f.from);
    if (f.to) p.set('to', f.to);
  }
  if (f.type !== 'all') p.set('type', f.type);
  if (f.direction) p.set('dir', f.direction);
  if (f.user) p.set('user', f.user);
  if (f.disposition) p.set('disp', f.disposition);
  if (f.min) p.set('min', f.min);
  if (f.rec) p.set('rec', '1');
  if (f.note) p.set('note', '1');
  if (f.q.trim()) p.set('q', f.q.trim());
  return p.toString();
}

function effectiveRange(f: Filters): { from: string; to: string } {
  const fallback = presetRange(f.preset);
  if (f.preset !== 'custom') return fallback;
  return { from: f.from || fallback.from, to: f.to || fallback.to };
}

function toQuery(f: Filters): HistoryQuery {
  const range = effectiveRange(f);
  const q: HistoryQuery = { type: f.type, from: range.from, to: range.to };
  if (f.direction) q.direction = f.direction;
  if (f.user) q.user_id = f.user;
  if (f.disposition) q.disposition = f.disposition;
  if (f.min) q.min_duration = Number(f.min);
  if (f.rec) q.has_recording = true;
  if (f.note) q.has_note = true;
  if (f.q.trim()) q.q = f.q.trim();
  return q;
}

// ── Formatting ───────────────────────────────────────────────────────────────

const STATUS_COLOR: Record<string, string> = {
  // calls
  completed: 'var(--green)',
  in_progress: 'var(--accent)',
  ringing: 'var(--accent)',
  initiated: 'var(--accent)',
  queued: 'var(--muted)',
  no_answer: 'var(--amber)',
  busy: 'var(--amber)',
  failed: 'var(--red)',
  canceled: 'var(--muted)',
  // texts
  delivered: 'var(--green)',
  sent: 'var(--green)',
  received: 'var(--green)',
  sending: 'var(--accent)',
  undelivered: 'var(--red)',
};

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

/** Same number, one key: "+15125550134" and "5125550134" match. */
function numberKey(n: string): string {
  return n.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
}

function whenParts(iso: string): { day: string; time: string } {
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return {
    day: today ? 'Today' : d.toLocaleDateString([], { month: 'short', day: 'numeric' }),
    time: d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }),
  };
}

const TEXT = { font: '500 12px/1 Inter' } as const;
const MUTED = { font: '500 11px/1 Inter', color: 'var(--muted)' } as const;
const NUM = { font: '600 12px/1 Inter' } as const;
const FIELD_SM = { padding: '7px 10px', font: '500 11.5px/1 Inter' } as const;

// ── Page ─────────────────────────────────────────────────────────────────────

export default function HistoryPage() {
  // useSearchParams needs a Suspense boundary for the static shell.
  return (
    <Suspense fallback={null}>
      <HistoryScreen />
    </Suspense>
  );
}

function HistoryScreen() {
  const { authed, callState } = useSoftphone();
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const paramString = params.toString();
  const filters = useMemo(() => parseFilters(new URLSearchParams(paramString)), [paramString]);
  const filtersRef = useRef(filters);
  filtersRef.current = filters;

  const update = useCallback(
    (patch: Partial<Filters>) => {
      const qs = serializeFilters({ ...filtersRef.current, ...patch });
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [router, pathname],
  );

  const query = useMemo(() => toQuery(filters), [filters]);

  const [data, setData] = useState<HistoryResponseDto | null>(null);
  const [items, setItems] = useState<HistoryItemDto[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [team, setTeam] = useState<TeamMemberDto[]>([]);
  const [dispositions, setDispositions] = useState<DispositionDto[]>([]);
  // Stale responses from an older filter set must not overwrite a newer one.
  const requestSeq = useRef(0);

  useEffect(() => {
    if (!authed) return;
    api.listTeam().then((r) => setTeam(r.members)).catch(() => undefined);
    api.listDispositions().then((r) => setDispositions(r.dispositions)).catch(() => undefined);
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    const seq = ++requestSeq.current;
    setLoading(true);
    setError(null);
    api
      .history({ ...query, limit: PAGE, offset: 0 })
      .then((r) => {
        if (seq !== requestSeq.current) return;
        setData(r);
        setItems(r.items);
        setForbidden(false);
      })
      .catch((err) => {
        if (seq !== requestSeq.current) return;
        if (err instanceof ApiError && err.status === 403) setForbidden(true);
        else setError((err as Error).message);
      })
      .finally(() => {
        if (seq === requestSeq.current) setLoading(false);
      });
  }, [authed, query, callState]); // callState: refetch once a call ends

  // Search: local echo, URL after 300ms of quiet. `pushedQ` tells an incoming
  // URL change that came from us apart from one from the back button, so a
  // keystroke typed during the debounce is never wiped by our own update.
  const [qInput, setQInput] = useState(filters.q);
  const pushedQ = useRef(filters.q);
  useEffect(() => {
    if (filters.q !== pushedQ.current) {
      pushedQ.current = filters.q;
      setQInput(filters.q);
    }
  }, [filters.q]);
  useEffect(() => {
    if (qInput.trim() === filters.q.trim()) return;
    const t = setTimeout(() => {
      pushedQ.current = qInput.trim();
      update({ q: qInput });
    }, 300);
    return () => clearTimeout(t);
  }, [qInput, filters.q, update]);

  // Custom range: edited locally, applied on the button like the reports page.
  const range = effectiveRange(filters);
  const [customFrom, setCustomFrom] = useState(range.from);
  const [customTo, setCustomTo] = useState(range.to);
  useEffect(() => {
    setCustomFrom(range.from);
    setCustomTo(range.to);
  }, [range.from, range.to]);

  /**
   * A number just became somebody. Every row for that number gets the name at
   * once — a stranger who called five times is five rows, and re-fetching the
   * whole page would scroll the rep away from where they were.
   */
  const nameNumber = useCallback((number: string, contact: ContactDto) => {
    const key = numberKey(number);
    setItems((prev) =>
      prev.map((it) =>
        numberKey(it.direction === 'outbound' ? it.to_number : it.from_number) === key
          ? { ...it, contact_name: contact.display_name, contact_id: contact.id }
          : it,
      ),
    );
  }, []);

  async function loadMore() {
    setLoadingMore(true);
    try {
      const r = await api.history({ ...query, limit: PAGE, offset: items.length });
      setItems((prev) => [...prev, ...r.items]);
      setData(r);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoadingMore(false);
    }
  }

  async function exportCsv() {
    setExporting(true);
    setError(null);
    try {
      const { blob, filename } = await api.historyExportCsv(query);
      // Same name the server sends; CORS may hide the header, so build it too.
      const name = filename ?? `talkr-history-${range.from}-to-${range.to}.csv`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1_000);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setExporting(false);
    }
  }

  if (!authed) {
    return (
      <p className="p-6" style={{ font: '400 13px/1.5 Inter', color: 'var(--muted)' }}>
        Not signed in — open <a href="/login" style={{ color: 'var(--accent)' }}>Account</a>.
      </p>
    );
  }

  const kpis = data?.kpis ?? null;
  const seesOrg = data?.scope === 'org';
  const texts = kpis ? kpis.sms_sent + kpis.sms_received : 0;
  const subtitle = data
    ? `${data.total} rows · ${kpis?.calls ?? 0} calls · ${texts} texts · ${data.range.timezone}`
    : loading
      ? 'Loading…'
      : 'Calls and texts, filtered';

  // Disposition options: the org's list, else whatever the current rows carry.
  const dispositionOptions: Array<{ slug: string; label: string }> = dispositions.length
    ? dispositions.map((d) => ({ slug: d.slug, label: d.name }))
    : (kpis?.by_disposition ?? []).map((d) => ({ slug: d.slug, label: d.label }));

  const COLS = '96px 24px 1.5fr 1.5fr 1fr 1.1fr 64px 1fr 1.6fr 64px';
  const MIN_WIDTH = 1180;
  const REP_COLS = '1.6fr 0.7fr 0.8fr 1fr 0.7fr';

  return (
    <>
      <TopBar title="History" subtitle={subtitle} />

      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div className="flex flex-col gap-4">
          {/* ── Filters ────────────────────────────────────────────────── */}
          <Card className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2.5">
              <Segmented
                value={filters.preset}
                options={PRESETS}
                onChange={(v) => update(v === 'custom' ? { preset: 'custom', from: range.from, to: range.to } : { preset: v, from: '', to: '' })}
              />
              {filters.preset === 'custom' && (
                <div className="flex flex-wrap items-center gap-2">
                  <Input type="date" aria-label="From" value={customFrom} onChange={(e) => setCustomFrom(e.target.value)} style={FIELD_SM} />
                  <span style={{ font: '500 11px/1 Inter', color: 'var(--muted-2)' }}>to</span>
                  <Input type="date" aria-label="To" value={customTo} onChange={(e) => setCustomTo(e.target.value)} style={FIELD_SM} />
                  <Button
                    tone="dark"
                    onClick={() => update({ preset: 'custom', from: customFrom, to: customTo })}
                    disabled={!customFrom || !customTo || customFrom > customTo}
                    style={{ padding: '8px 13px' }}
                  >
                    Apply
                  </Button>
                </div>
              )}
              <div className="ml-auto flex items-center gap-2">
                <Button tone="ghost" onClick={exportCsv} disabled={exporting || loading} title="Download the filtered rows as CSV" style={{ padding: '8px 13px' }}>
                  <Icon name="forward" size={13} />
                  {exporting ? 'Exporting…' : 'Export CSV'}
                </Button>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <Segmented<HistoryType>
                value={filters.type}
                options={[
                  { value: 'all', label: 'All' },
                  { value: 'calls', label: 'Calls' },
                  { value: 'sms', label: 'Texts' },
                ]}
                onChange={(type) => update({ type })}
              />
              <Select aria-label="Direction" value={filters.direction} onChange={(e) => update({ direction: e.target.value as Filters['direction'] })} style={FIELD_SM}>
                <option value="">Any direction</option>
                <option value="inbound">Inbound</option>
                <option value="outbound">Outbound</option>
              </Select>
              {seesOrg && (
                <Select aria-label="Rep" value={filters.user} onChange={(e) => update({ user: e.target.value })} style={FIELD_SM}>
                  <option value="">All reps</option>
                  {team.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.display_name}
                      {m.is_self ? ' (you)' : ''}
                    </option>
                  ))}
                </Select>
              )}
              <Select aria-label="Disposition" value={filters.disposition} onChange={(e) => update({ disposition: e.target.value })} style={FIELD_SM}>
                <option value="">Any disposition</option>
                {dispositionOptions.map((d) => (
                  <option key={d.slug} value={d.slug}>
                    {d.label}
                  </option>
                ))}
              </Select>
              <Select aria-label="Minimum duration" value={filters.min} onChange={(e) => update({ min: e.target.value })} style={FIELD_SM}>
                {DURATIONS.map((d) => (
                  <option key={d.value || 'any'} value={d.value}>
                    {d.label}
                  </option>
                ))}
              </Select>
              <span className="inline-flex items-center gap-1.5">
                <Toggle on={filters.rec} onChange={(rec) => update({ rec })} label="Only calls with a recording" />
                <span style={MUTED}>Recorded</span>
              </span>
              <span className="inline-flex items-center gap-1.5">
                <Toggle on={filters.note} onChange={(note) => update({ note })} label="Only calls with a note" />
                <span style={MUTED}>Has note</span>
              </span>
              <span className="relative ml-auto flex min-w-[200px] flex-1 items-center md:max-w-[320px] md:flex-none">
                <span className="pointer-events-none absolute left-2.5" style={{ color: 'var(--muted-2)', display: 'inline-flex' }}>
                  <Icon name="search" size={13} />
                </span>
                <Input
                  type="search"
                  aria-label="Search"
                  placeholder="Name, phone, address, note…"
                  value={qInput}
                  onChange={(e) => setQInput(e.target.value)}
                  className="w-full"
                  style={{ ...FIELD_SM, paddingLeft: 28 }}
                />
              </span>
            </div>
          </Card>

          {error && <Notice tone="error">{error}</Notice>}

          {forbidden && (
            <Card padded={false}>
              <EmptyState title="History is not available for this account" hint="Ask an admin for the rep role or higher." />
            </Card>
          )}

          {/* ── KPIs (follow the filters) ─────────────────────────────── */}
          {kpis && (
            <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
              <Kpi label="Calls" value={String(kpis.calls)} sub={`${kpis.answered} answered`} />
              <Kpi label="Connect rate" value={fmtRate(kpis.connect_rate)} sub="answered / ended" />
              <Kpi label="Avg duration" value={fmtSeconds(kpis.avg_duration_seconds)} sub="per answered call" />
              <Kpi label="Talk time" value={fmtSeconds(kpis.talk_time_seconds)} sub="answered → hang-up" />
              <Kpi label="In / out" value={`${kpis.inbound} / ${kpis.outbound}`} sub="inbound / outbound calls" />
              <Kpi label="Texts" value={String(texts)} sub={`${kpis.sms_sent} sent · ${kpis.sms_received} received`} />
            </div>
          )}

          {/* ── By rep (org viewers) ──────────────────────────────────── */}
          {kpis && seesOrg && kpis.by_rep.length > 0 && (
            <Card padded={false} className="overflow-x-auto">
              <GridHead cols={REP_COLS} minWidth={560}>
                <Eyebrow>Rep</Eyebrow>
                <Eyebrow>Calls</Eyebrow>
                <Eyebrow>Answered</Eyebrow>
                <Eyebrow>Talk time</Eyebrow>
                <Eyebrow className="text-right">Texts</Eyebrow>
              </GridHead>
              {kpis.by_rep.map((r, i) => (
                <GridRow key={r.user_id} cols={REP_COLS} minWidth={560} className="!py-2" style={i === kpis.by_rep.length - 1 ? { borderBottom: 'none' } : undefined}>
                  <button
                    type="button"
                    onClick={() => update({ user: filters.user === r.user_id ? '' : r.user_id })}
                    className="flex min-w-0 items-center gap-2 text-left"
                    style={{ background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--text)' }}
                    title="Filter to this rep"
                  >
                    <Avatar name={r.name} size={24} />
                    <span className="truncate" style={{ font: '600 12px/1 Inter' }}>{r.name}</span>
                  </button>
                  <span style={NUM}>{r.calls}</span>
                  <span style={NUM}>{r.answered}</span>
                  <span style={NUM}>{fmtSeconds(r.talk_time_seconds)}</span>
                  <span className="text-right" style={NUM}>{r.sms}</span>
                </GridRow>
              ))}
            </Card>
          )}

          {/* ── Rows ──────────────────────────────────────────────────── */}
          {!forbidden && (
            <Card padded={false} className="overflow-x-auto">
              <GridHead cols={COLS} minWidth={MIN_WIDTH}>
                <Eyebrow>When</Eyebrow>
                <span aria-hidden />
                <Eyebrow>Contact</Eyebrow>
                <Eyebrow>Address</Eyebrow>
                <Eyebrow>Rep</Eyebrow>
                <Eyebrow>Status</Eyebrow>
                <Eyebrow>Length</Eyebrow>
                <Eyebrow>Disposition</Eyebrow>
                <Eyebrow>Note / text</Eyebrow>
                <span aria-hidden />
              </GridHead>

              {items.length === 0 && !loading && data && (
                <EmptyState
                  title="Nothing matches these filters"
                  hint="Widen the date range or clear a filter. Texts drop out when a call-only filter (disposition, length, recorded, note) is on."
                />
              )}
              {items.length === 0 && loading && (
                <p className="p-5" style={{ font: '400 12.5px/1.5 Inter', color: 'var(--muted)' }}>
                  Loading…
                </p>
              )}

              {items.map((it) => {
                const other = it.direction === 'outbound' ? it.to_number : it.from_number;
                const name = it.contact_name ?? formatPhone(other);
                const color = STATUS_COLOR[it.status] ?? 'var(--muted)';
                const when = whenParts(it.at);
                const text = it.kind === 'sms' ? it.body : it.note;
                const href = it.kind === 'call' ? `/calls/${it.id}` : `/messages?conversation=${it.conversation_id ?? ''}`;
                return (
                  <GridRow key={`${it.kind}-${it.id}`} cols={COLS} minWidth={MIN_WIDTH}>
                    <span className="flex flex-col gap-1">
                      <span style={TEXT}>{when.day}</span>
                      <span style={MUTED}>{when.time}</span>
                    </span>

                    <span
                      title={it.kind === 'call' ? 'Call' : 'Text'}
                      style={{ color: it.kind === 'call' ? 'var(--accent)' : 'var(--muted)', display: 'inline-flex' }}
                    >
                      <Icon name={it.kind === 'call' ? 'phone' : 'msg'} size={14} />
                    </span>

                    <span className="flex min-w-0 items-center gap-2.5">
                      <Avatar name={name} size={28} />
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="truncate" style={{ font: '600 12.5px/1 Inter' }}>{name}</span>
                        {it.contact_name && <span style={MUTED}>{formatPhone(other)}</span>}
                      </span>
                      {!it.contact_name && (
                        <AddContactButton
                          size="icon"
                          phone={other}
                          onCreated={(contact) => nameNumber(other, contact)}
                        />
                      )}
                    </span>

                    <span className="truncate" style={{ ...TEXT, color: it.address ? 'var(--text)' : 'var(--muted-2)' }} title={it.address ?? undefined}>
                      {it.address ?? '—'}
                    </span>

                    <span className="truncate" style={{ ...TEXT, color: it.user_name ? 'var(--text)' : 'var(--muted-2)' }}>
                      {it.user_name ?? '—'}
                    </span>

                    <span className="flex min-w-0 flex-col gap-1">
                      <span className="inline-flex items-center gap-2" style={{ font: '600 11px/1 Inter', color }}>
                        <span style={{ width: 6, height: 6, background: color, flexShrink: 0 }} aria-hidden />
                        {it.direction}
                      </span>
                      <span style={MUTED}>{it.status.replace(/_/g, ' ')}</span>
                    </span>

                    <span style={NUM}>
                      {it.kind === 'call'
                        ? it.duration_seconds != null
                          ? duration(it.duration_seconds)
                          : '—'
                        : it.media_count > 0
                          ? `${it.media_count} media`
                          : '—'}
                    </span>

                    <span className="truncate" style={{ ...TEXT, color: it.disposition_label ? 'var(--text)' : 'var(--muted-2)' }}>
                      {it.disposition_label ?? '—'}
                    </span>

                    <span className="truncate" style={{ ...TEXT, color: text ? 'var(--text)' : 'var(--muted-2)' }} title={text ?? undefined}>
                      {text || '—'}
                    </span>

                    <span className="flex items-center justify-end gap-2">
                      {it.kind === 'call' && it.has_recording ? (
                        <a
                          href={href}
                          aria-label="Play recording"
                          title="Open call and play recording"
                          className="inline-flex h-7 w-7 items-center justify-center rounded-full"
                          style={{ border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--accent)' }}
                        >
                          <Icon name="play" size={11} />
                        </a>
                      ) : (
                        <a href={href} style={{ font: '600 11px/1 Inter', color: 'var(--accent)' }}>
                          {it.kind === 'call' ? 'Open' : 'Thread'}
                        </a>
                      )}
                    </span>
                  </GridRow>
                );
              })}

              {data && items.length < data.total && (
                <div className="flex items-center justify-between gap-3 px-4 py-3">
                  <span style={MUTED}>
                    Showing {items.length} of {data.total}
                  </span>
                  <Button tone="ghost" onClick={loadMore} disabled={loadingMore || loading} style={{ padding: '8px 13px' }}>
                    {loadingMore ? 'Loading…' : 'Load more'}
                  </Button>
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
    </>
  );
}
