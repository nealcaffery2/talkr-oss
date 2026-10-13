'use client';

/**
 * Live floor (design 1c): one tile per rep, dominated by what they are doing
 * right now — a live call timer on near-black when they are talking, their
 * presence when they are not — over today's totals. Live updates ride the
 * existing SSE stream (debounced refetch on call.updated / presence.updated),
 * durations tick locally every second, and a 30s poll is the fallback.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, eventStreamUrl, type FloorStateDto } from '@/lib/api';
import { useSoftphone } from '@/lib/softphone';
import { TopBar } from '@/components/TopBar';
import { Icon } from '@/components/Icon';
import { Avatar, Card, EmptyState, Eyebrow, Kpi, Notice, StatusMarker } from '@/components/ui';
import { PhoneText } from '@/components/CopyPhone';

function fmtClock(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  if (m >= 60) return `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtTalk(s: number): string {
  const m = Math.round(s / 60);
  return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
}

type Rep = FloorStateDto['reps'][number];

function presence(rep: Rep): { color: string; label: string } {
  if (rep.on_call) return { color: 'var(--accent)', label: 'On a call' };
  if (rep.presence.status === 'available' && rep.presence.fresh) return { color: 'var(--green)', label: 'Available' };
  if (rep.presence.status === 'available') return { color: 'var(--amber)', label: 'Stale' };
  if (rep.presence.status === 'away') return { color: 'var(--amber)', label: 'Away' };
  return { color: 'var(--muted-2)', label: 'Offline' };
}

function RepTile({ rep, now }: { rep: Rep; now: number }) {
  const dot = presence(rep);
  const call = rep.on_call;
  const since = call ? Date.parse(call.answered_at ?? call.initiated_at ?? '') : NaN;
  const live = Number.isFinite(since) ? (now - since) / 1000 : null;
  const other = call ? (call.direction === 'outbound' ? call.to_number : call.from_number) : null;
  const dark = Boolean(call);

  const muted = dark ? 'rgba(255,255,255,0.55)' : 'var(--muted)';

  return (
    <Card
      className="flex flex-col gap-3.5"
      style={dark ? { background: 'var(--dark-1)', color: '#fff', borderColor: 'var(--dark-1)' } : undefined}
    >
      <div className="flex items-center gap-2.5">
        <Avatar name={rep.display_name} size={34} dark={dark} />
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate" style={{ font: '700 13px/1 Inter', letterSpacing: '-0.01em' }}>
            {rep.display_name}
          </span>
          <span className="truncate" style={{ font: '500 10.5px/1 Inter', color: muted, textTransform: 'capitalize' }}>
            {rep.role}
          </span>
        </div>
        <span className="inline-flex items-center gap-1.5">
          <span style={{ width: 6, height: 6, background: dot.color }} aria-hidden />
          <span
            style={{
              font: '600 9px/1 Inter',
              letterSpacing: '0.1em',
              textTransform: 'uppercase',
              color: dark ? 'rgba(255,255,255,0.8)' : 'var(--muted)',
            }}
          >
            {dot.label}
          </span>
        </span>
      </div>

      <div className="flex items-end justify-between gap-3" style={{ minHeight: 44 }}>
        {call ? (
          <>
            <div className="flex min-w-0 flex-col gap-1.5">
              <span style={{ font: '600 9px/1 Inter', letterSpacing: '0.12em', textTransform: 'uppercase', color: muted }}>
                {call.answered_at ? 'Talking' : call.status.replace(/_/g, ' ')}
              </span>
              <span className="display" style={{ font: '700 26px/1 Inter', fontVariantNumeric: 'tabular-nums' }}>
                {live != null ? fmtClock(live) : '—'}
              </span>
            </div>
            <div className="flex min-w-0 flex-col items-end gap-1.5 text-right">
              <span className="inline-flex items-center gap-1.5" style={{ font: '600 11px/1 Inter', color: 'var(--accent-light)' }}>
                <Icon name={call.direction === 'outbound' ? 'forward' : 'phone'} size={12} />
                {call.direction === 'outbound' ? 'Outbound' : 'Inbound'}
              </span>
              {/* The tile is near-black whenever there is a call, so the copy
                  control on it always takes the dark tone. */}
              {other && (
                <PhoneText e164={other} size={20} tone="dark" style={{ font: '500 11px/1 Inter', color: muted }} />
              )}
            </div>
          </>
        ) : (
          <div className="flex flex-col gap-1.5">
            <Eyebrow>Now</Eyebrow>
            <span style={{ font: '600 15px/1 Inter', color: rep.presence.status === 'offline' ? 'var(--muted-2)' : 'var(--text)' }}>
              {rep.presence.status === 'offline' ? 'Offline' : 'Idle'}
            </span>
          </div>
        )}
      </div>

      <div
        className="grid grid-cols-3 gap-2 pt-3"
        style={{ borderTop: `1px solid ${dark ? 'var(--dark-2)' : 'var(--line-soft)'}` }}
      >
        {[
          { label: 'Calls', value: String(rep.today.calls) },
          { label: 'Answered', value: String(rep.today.answered) },
          { label: 'Talk', value: fmtTalk(rep.today.talk_seconds) },
        ].map((k) => (
          <div key={k.label} className="flex flex-col gap-1.5">
            <span style={{ font: '600 9px/1 Inter', letterSpacing: '0.12em', textTransform: 'uppercase', color: dark ? 'rgba(255,255,255,0.45)' : 'var(--muted-2)' }}>
              {k.label}
            </span>
            <span style={{ font: '700 14px/1 Inter' }}>{k.value}</span>
          </div>
        ))}
      </div>
    </Card>
  );
}

export default function FloorPage() {
  const { authed } = useSoftphone();
  const [state, setState] = useState<FloorStateDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [forbidden, setForbidden] = useState(false);
  const [now, setNow] = useState<number | null>(null);
  const refetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await api.floorState());
      setError(null);
    } catch (err) {
      if (err instanceof ApiError && err.status === 403) setForbidden(true);
      else setError((err as Error).message);
    }
  }, []);

  useEffect(() => {
    if (!authed) return;
    void load();
    const poll = setInterval(() => void load(), 30_000);
    return () => clearInterval(poll);
  }, [authed, load]);

  useEffect(() => {
    if (!authed) return;
    const url = eventStreamUrl();
    if (!url) return;
    const source = new EventSource(url);
    const scheduleRefetch = () => {
      if (refetchTimer.current) return;
      refetchTimer.current = setTimeout(() => {
        refetchTimer.current = null;
        void load();
      }, 400);
    };
    source.addEventListener('call.updated', scheduleRefetch);
    source.addEventListener('presence.updated', scheduleRefetch);
    return () => {
      source.close();
      if (refetchTimer.current) clearTimeout(refetchTimer.current);
      refetchTimer.current = null;
    };
  }, [authed, load]);

  // Local 1s tick for live durations — no server round-trips. Started after
  // mount so the first paint matches the server's.
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  if (!authed) {
    return (
      <p className="p-6" style={{ font: '400 13px/1.5 Inter', color: 'var(--muted)' }}>
        Not signed in — open <a href="/login" style={{ color: 'var(--accent)' }}>Account</a>.
      </p>
    );
  }

  const onCall = state?.reps.filter((r) => r.on_call).length ?? 0;
  const online = state?.reps.filter((r) => r.presence.status !== 'offline').length ?? 0;
  const subtitle = state
    ? `${state.reps.length} reps · ${online} online · ${onCall} on ${onCall === 1 ? 'a call' : 'calls'} · live`
    : 'Loading…';

  return (
    <>
      <TopBar title="Floor" subtitle={subtitle} />

      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div className="flex flex-col gap-4">
          {error && <Notice tone="error">{error}</Notice>}

          {forbidden && (
            <Card padded={false}>
              <EmptyState
                title="The floor view is manager-level"
                hint="Ask an admin for the manager role to see who is on the phone right now."
              />
            </Card>
          )}

          {state && (
            <>
              {/* ── Today ─────────────────────────────────────────────── */}
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
                <Kpi label="Calls today" value={String(state.totals.calls)} sub={state.today} />
                <Kpi label="Outbound" value={String(state.totals.outbound)} />
                <Kpi label="Inbound" value={String(state.totals.inbound)} />
                <Kpi
                  label="Answered"
                  value={String(state.totals.answered)}
                  sub={state.totals.calls > 0 ? `${Math.round((state.totals.answered / state.totals.calls) * 100)}% of calls` : undefined}
                />
                <Kpi
                  label="Missed"
                  value={String(state.totals.missed)}
                  sub={`${state.totals.voicemails_left} voicemail${state.totals.voicemails_left === 1 ? '' : 's'}`}
                  tone={state.totals.missed > 0 ? 'amber' : undefined}
                />
                <Kpi label="Talk time" value={fmtTalk(state.totals.talk_seconds)} />
              </div>

              {/* ── Queues ────────────────────────────────────────────── */}
              {state.queues.length > 0 && (
                <div className="flex flex-wrap gap-2.5">
                  {state.queues.map((q) => (
                    <Card key={q.queue_id} className="inline-flex items-center gap-2.5" style={{ padding: '9px 13px' }}>
                      <StatusMarker color={q.waiting > 0 ? 'var(--amber)' : 'var(--muted-2)'} label={q.name} />
                      <span style={{ font: '700 12.5px/1 Inter', color: q.waiting > 0 ? 'var(--amber)' : 'var(--text)' }}>
                        {q.waiting}
                      </span>
                      <span style={{ font: '500 11px/1 Inter', color: 'var(--muted)' }}>waiting</span>
                    </Card>
                  ))}
                </div>
              )}

              {/* ── Reps ──────────────────────────────────────────────── */}
              {state.reps.length === 0 ? (
                <Card padded={false}>
                  <EmptyState title="No reps on the floor" hint="Teammates appear here once they sign in." />
                </Card>
              ) : (
                <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
                  {[...state.reps]
                    .sort((a, b) => Number(Boolean(b.on_call)) - Number(Boolean(a.on_call)))
                    .map((rep) => (
                      <RepTile key={rep.user_id} rep={rep} now={now ?? Date.now()} />
                    ))}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}
