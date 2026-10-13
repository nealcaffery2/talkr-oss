'use client';

/**
 * Campaigns + dial sessions (design 1c, docs/dialers.md §9). A session call
 * IS a normal call: the global CallBar/WrapUp handle in-call + disposition.
 * This page lists campaigns as a hairline table, starts sessions, shows the
 * live session on near-black (the colour that carries the call everywhere in
 * the app), advances (explicit Next in power/parallel, auto-advance countdown
 * in progressive), and stays live via SSE.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ApiError,
  api,
  eventStreamUrl,
  type CampaignDto,
  type CampaignSettingsDto,
  type CampaignStatsDto,
  type DialNextDto,
  type DialSessionCallDto,
  type DialSessionDto,
  type LeadCardDto,
} from '@/lib/api';
import { useSoftphone } from '@/lib/softphone';
import { TopBar } from '@/components/TopBar';
import { Icon } from '@/components/Icon';
import {
  Button,
  Card,
  EmptyState,
  Eyebrow,
  GridHead,
  GridRow,
  Input,
  Labeled,
  Modal,
  Notice,
  Select,
  StatusMarker,
  TextArea,
  Toggle,
} from '@/components/ui';
import { PhoneText } from '@/components/CopyPhone';

const LEAD_STATUS_COLORS: Record<string, string> = {
  pending: 'var(--accent)',
  in_progress: 'var(--amber)',
  contacted: 'var(--green)',
  completed: 'var(--muted)',
  suppressed: 'var(--red)',
  removed: 'var(--line)',
};

const CAMPAIGN_STATUS_COLORS: Record<string, string> = {
  active: 'var(--green)',
  paused: 'var(--amber)',
  draft: 'var(--muted-2)',
  archived: 'var(--line)',
};

const MODE_LABEL: Record<string, string> = {
  power: 'Power',
  progressive: 'Progressive',
  parallel: 'Parallel',
  predictive: 'Predictive',
};

const AUTO_ADVANCE_SECONDS = 5;

function pct(part: number, total: number): string {
  return total > 0 ? `${(part / total) * 100}%` : '0%';
}

const COLS = '1.7fr 1fr 1.6fr auto';
const MIN_W = 720;

export default function CampaignsPage() {
  const softphone = useSoftphone();
  const { authed, deviceState, initDevice, connectExisting, callState } = softphone;

  const [campaigns, setCampaigns] = useState<CampaignDto[]>([]);
  const [statsFor, setStatsFor] = useState<Record<string, CampaignStatsDto>>({});
  const [session, setSession] = useState<DialSessionDto | null>(null);
  const [sessionCampaign, setSessionCampaign] = useState<CampaignDto | null>(null);
  const [latestCall, setLatestCall] = useState<DialSessionCallDto | null>(null);
  const [card, setCard] = useState<LeadCardDto | null>(null);
  const [idleReason, setIdleReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<CampaignDto | 'new' | null>(null);
  const [countdown, setCountdown] = useState<{ callId: string; secondsLeft: number } | null>(null);
  const countdownRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const refreshCampaigns = useCallback(async () => {
    try {
      const { campaigns } = await api.listCampaigns();
      setCampaigns(campaigns);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const refreshSession = useCallback(async (sessionId?: string) => {
    try {
      const id = sessionId ?? (await api.activeDialSession()).session?.id;
      if (!id) {
        setSession(null);
        setSessionCampaign(null);
        setLatestCall(null);
        setCard(null);
        return;
      }
      const detail = await api.getDialSession(id);
      setSession(detail.session);
      setSessionCampaign(detail.campaign);
      setLatestCall(detail.latest_call);
      setCard(detail.card);
    } catch {
      /* keep last view */
    }
  }, []);

  useEffect(() => {
    if (!authed) return;
    void refreshCampaigns();
    void refreshSession();
  }, [authed, refreshCampaigns, refreshSession]);

  const clearCountdown = useCallback(() => {
    if (countdownRef.current) clearInterval(countdownRef.current);
    countdownRef.current = null;
    setCountdown(null);
  }, []);

  const connectCall = useCallback(
    async (callId: string) => {
      clearCountdown();
      try {
        const { call } = await api.getCall(callId);
        if (call.status !== 'queued') return; // already progressed elsewhere
        await connectExisting(call);
      } catch (err) {
        setError((err as Error).message);
      }
    },
    [clearCountdown, connectExisting],
  );

  /** Progressive auto-advance: SSE announces the server-dialed call; give the
   * rep a cancelable countdown, then open the media leg. */
  const startCountdown = useCallback(
    (callId: string) => {
      clearCountdown();
      setCountdown({ callId, secondsLeft: AUTO_ADVANCE_SECONDS });
      countdownRef.current = setInterval(() => {
        setCountdown((current) => {
          if (!current) return current;
          if (current.secondsLeft <= 1) {
            void connectCall(current.callId);
            return null;
          }
          return { ...current, secondsLeft: current.secondsLeft - 1 };
        });
      }, 1000);
    },
    [clearCountdown, connectCall],
  );

  // Live session progress over the existing SSE stream.
  useEffect(() => {
    if (!authed) return;
    const url = eventStreamUrl();
    if (!url) return;
    const source = new EventSource(url);
    const onSession = (raw: MessageEvent) => {
      try {
        const event = JSON.parse(raw.data) as {
          data?: { sessionId?: string; event?: string; systemInitiated?: boolean; callIds?: string[] };
        };
        const data = event.data;
        if (!data?.sessionId) return;
        void refreshSession(data.sessionId);
        if (data.event === 'dialed' && data.systemInitiated && data.callIds?.[0]) {
          startCountdown(data.callIds[0]);
        }
      } catch {
        /* ignore malformed */
      }
    };
    source.addEventListener('session.updated', onSession);
    return () => source.close();
  }, [authed, refreshSession, startCountdown]);

  useEffect(() => () => clearCountdown(), [clearCountdown]);

  async function guard(fn: () => Promise<void>) {
    setError(null);
    try {
      await fn();
    } catch (err) {
      if (err instanceof ApiError) setError(`${err.code}: ${err.message}`);
      else setError((err as Error).message);
    }
  }

  async function startSession(campaign: CampaignDto) {
    await guard(async () => {
      const { session } = await api.startDialSession(campaign.id);
      setIdleReason(null);
      await refreshSession(session.id);
    });
  }

  async function sessionAction(action: 'pause' | 'resume' | 'end') {
    if (!session) return;
    await guard(async () => {
      clearCountdown();
      await api.dialSessionAction(session.id, action);
      await refreshSession(action === 'end' ? undefined : session.id);
      if (action === 'end') setIdleReason(null);
    });
  }

  async function next() {
    if (!session) return;
    await guard(async () => {
      setIdleReason(null);
      const result: DialNextDto = await api.dialSessionNext(session.id);
      if (result.idle) {
        setIdleReason(result.reason ?? 'idle');
        return;
      }
      await refreshSession(session.id);
      // Power/progressive: the browser carries the media leg. Parallel lines
      // dial server-side and ring in when a seller answers.
      if (session.mode !== 'parallel' && result.lines?.[0]) {
        await connectCall(result.lines[0].call.id);
      }
    });
  }

  async function toggleStats(campaign: CampaignDto) {
    if (statsFor[campaign.id]) {
      setStatsFor((s) => {
        const nextStats = { ...s };
        delete nextStats[campaign.id];
        return nextStats;
      });
      return;
    }
    await guard(async () => {
      const stats = await api.campaignStats(campaign.id);
      setStatsFor((s) => ({ ...s, [campaign.id]: stats }));
    });
  }

  async function setStatus(campaign: CampaignDto, status: string) {
    await guard(async () => {
      await api.updateCampaign(campaign.id, { status });
      await refreshCampaigns();
    });
  }

  if (!authed) {
    return (
      <p className="p-6" style={{ font: '400 13px/1.5 Inter', color: 'var(--muted)' }}>
        Not signed in — open <a href="/login" style={{ color: 'var(--accent)' }}>Account</a>.
      </p>
    );
  }

  const inCall = callState !== 'idle';
  const liveSession = session && session.state !== 'ended' ? session : null;
  const activeCount = campaigns.filter((c) => c.status === 'active').length;
  const leadTotal = campaigns.reduce((s, c) => s + Object.values(c.lead_counts ?? {}).reduce((a, b) => a + b, 0), 0);
  const subtitle = liveSession
    ? `Session ${liveSession.state} · ${sessionCampaign?.name ?? ''}`
    : campaigns.length === 0
      ? 'Power, progressive and parallel dialing'
      : `${campaigns.length} campaign${campaigns.length === 1 ? '' : 's'} · ${activeCount} active · ${leadTotal} leads`;

  return (
    <>
      <TopBar title="Campaigns" subtitle={subtitle} />

      <div className="min-h-0 flex-1 overflow-auto p-5">
        <div className="flex flex-col gap-4">
          {error && <Notice tone="error">{error}</Notice>}

          {deviceState !== 'ready' && (
            <Notice
              action={
                <Button tone="accent" onClick={() => void initDevice()} disabled={deviceState === 'initializing'}>
                  {deviceState === 'initializing' ? 'Enabling…' : 'Enable softphone'}
                </Button>
              }
            >
              Dial sessions need the softphone running: you have to be online and available for the campaign to hand you
              calls.
            </Notice>
          )}

          {/* ── Live session ─────────────────────────────────────────── */}
          {liveSession && (
            <SessionHero
              session={liveSession}
              campaign={sessionCampaign}
              card={card}
              latestCall={latestCall}
              countdown={countdown}
              idleReason={idleReason}
              inCall={inCall}
              deviceReady={deviceState === 'ready'}
              onNext={() => void next()}
              onPause={() => void sessionAction('pause')}
              onResume={() => void sessionAction('resume')}
              onEnd={() => void sessionAction('end')}
              onCancelCountdown={clearCountdown}
              onDialNow={(id) => void connectCall(id)}
            />
          )}

          {/* ── Campaign list ────────────────────────────────────────── */}
          <div className="flex items-center gap-3">
            <Eyebrow>All campaigns</Eyebrow>
            <Button tone="accent" className="ml-auto" onClick={() => setEditing('new')}>
              <Icon name="plus" size={14} />
              New campaign
            </Button>
          </div>

          <Card padded={false} className="overflow-x-auto">
            <GridHead cols={COLS} minWidth={MIN_W}>
              <Eyebrow>Campaign</Eyebrow>
              <Eyebrow>Status</Eyebrow>
              <Eyebrow>Leads</Eyebrow>
              <Eyebrow className="text-right">Actions</Eyebrow>
            </GridHead>

            {campaigns.length === 0 && (
              <EmptyState
                title="No campaigns yet"
                hint="Create one, attach leads by source, and start a session to dial through them."
                action={
                  <Button tone="dark" onClick={() => setEditing('new')}>
                    Create a campaign
                  </Button>
                }
              />
            )}

            {campaigns.map((campaign, i) => {
              const counts = campaign.lead_counts ?? {};
              const total = Object.values(counts).reduce((a, b) => a + b, 0);
              const stats = statsFor[campaign.id];
              const last = i === campaigns.length - 1;
              const statusColor = CAMPAIGN_STATUS_COLORS[campaign.status] ?? 'var(--muted-2)';
              const ghost = { padding: '8px 11px', font: '600 11.5px/1 Inter' } as const;
              return (
                <div key={campaign.id} style={{ borderBottom: last ? 'none' : '1px solid var(--panel-2)' }}>
                  <GridRow cols={COLS} minWidth={MIN_W} style={{ borderBottom: 'none' }}>
                    <span className="flex min-w-0 flex-col gap-1.5">
                      <span className="truncate" style={{ font: '600 13px/1 Inter' }}>
                        {campaign.name}
                      </span>
                      <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted)' }}>
                        {MODE_LABEL[campaign.mode] ?? campaign.mode} dialer
                        {campaign.mode === 'parallel' && ` · ${campaign.settings.parallelLines ?? 2} lines`}
                        {campaign.settings.callingWindowStart &&
                          ` · ${campaign.settings.callingWindowStart}–${campaign.settings.callingWindowEnd ?? ''} local`}
                      </span>
                    </span>

                    <StatusMarker color={statusColor} label={campaign.status} />

                    <span className="flex min-w-0 flex-col gap-1.5">
                      <span style={{ font: '600 12px/1 Inter' }}>
                        {total} lead{total === 1 ? '' : 's'}
                        <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted)' }}>
                          {total > 0 && ` · ${counts.pending ?? 0} pending · ${counts.contacted ?? 0} contacted`}
                        </span>
                      </span>
                      <span className="flex h-1.5 overflow-hidden" style={{ borderRadius: 2, background: 'var(--panel-2)' }} aria-hidden>
                        {Object.entries(counts).map(([status, n]) => (
                          <span
                            key={status}
                            title={`${status}: ${n}`}
                            style={{ width: pct(n, total), background: LEAD_STATUS_COLORS[status] ?? 'var(--line)' }}
                          />
                        ))}
                      </span>
                    </span>

                    <span className="flex items-center justify-end gap-1.5">
                      {campaign.status === 'active' && !liveSession && (
                        <Button
                          tone="green"
                          onClick={() => void startSession(campaign)}
                          disabled={deviceState !== 'ready'}
                          title={deviceState !== 'ready' ? 'Enable the softphone first' : undefined}
                          style={ghost}
                        >
                          <Icon name="phone" size={12} />
                          Start session
                        </Button>
                      )}
                      {campaign.status === 'draft' && (
                        <Button tone="dark" onClick={() => void setStatus(campaign, 'active')} style={ghost}>
                          Activate
                        </Button>
                      )}
                      {campaign.status === 'active' && (
                        <Button tone="ghost" onClick={() => void setStatus(campaign, 'paused')} style={ghost}>
                          <Icon name="pause" size={12} />
                          Pause
                        </Button>
                      )}
                      {campaign.status === 'paused' && (
                        <Button tone="dark" onClick={() => void setStatus(campaign, 'active')} style={ghost}>
                          Resume
                        </Button>
                      )}
                      <Button tone={stats ? 'quiet' : 'ghost'} onClick={() => void toggleStats(campaign)} style={ghost}>
                        <Icon name="grid" size={12} />
                        {stats ? 'Hide stats' : 'Stats'}
                      </Button>
                      <Button tone="ghost" onClick={() => setEditing(campaign)} style={ghost}>
                        <Icon name="settings" size={12} />
                        Edit
                      </Button>
                    </span>
                  </GridRow>

                  {stats && (
                    <div className="mx-4 mb-4 flex flex-col gap-3.5 p-4" style={{ background: 'var(--bg)', border: '1px solid var(--line)', borderRadius: 'var(--r-md)' }}>
                      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
                        {[
                          { label: 'Calls', value: String(stats.calls.total) },
                          { label: 'Connected', value: String(stats.calls.connected) },
                          { label: 'Abandoned', value: String(stats.calls.abandoned) },
                          {
                            label: `Abandon rate · ${stats.abandonment.window_days}d`,
                            value: `${(stats.abandonment.rate * 100).toFixed(1)}%`,
                            sub: `cap ${stats.abandonment.cap_percent}%`,
                            warn: stats.abandonment.rate * 100 > stats.abandonment.cap_percent,
                          },
                        ].map((k) => (
                          <div key={k.label} className="flex flex-col gap-1.5">
                            <Eyebrow>{k.label}</Eyebrow>
                            <span style={{ font: '700 18px/1 Inter', color: 'warn' in k && k.warn ? 'var(--red)' : 'var(--text)' }}>
                              {k.value}
                              {'sub' in k && k.sub && (
                                <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted)', marginLeft: 6 }}>{k.sub}</span>
                              )}
                            </span>
                          </div>
                        ))}
                      </div>
                      <AttachLeads campaignId={campaign.id} onDone={refreshCampaigns} />
                    </div>
                  )}
                </div>
              );
            })}
          </Card>
        </div>
      </div>

      {editing && (
        <CampaignForm
          campaign={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={async () => {
            setEditing(null);
            await refreshCampaigns();
          }}
        />
      )}
    </>
  );
}

/* ── Live session hero ───────────────────────────────────────────────────── */

function SessionHero({
  session,
  campaign,
  card,
  latestCall,
  countdown,
  idleReason,
  inCall,
  deviceReady,
  onNext,
  onPause,
  onResume,
  onEnd,
  onCancelCountdown,
  onDialNow,
}: {
  session: DialSessionDto;
  campaign: CampaignDto | null;
  card: LeadCardDto | null;
  latestCall: DialSessionCallDto | null;
  countdown: { callId: string; secondsLeft: number } | null;
  idleReason: string | null;
  inCall: boolean;
  deviceReady: boolean;
  onNext: () => void;
  onPause: () => void;
  onResume: () => void;
  onEnd: () => void;
  onCancelCountdown: () => void;
  onDialNow: (callId: string) => void;
}) {
  const active = session.state === 'active';
  const dim = 'rgba(255,255,255,0.55)';
  const line = 'var(--dark-2)';
  const eyebrow = { font: '600 9px/1 Inter', letterSpacing: '0.12em', textTransform: 'uppercase' as const, color: 'rgba(255,255,255,0.45)' };

  return (
    <Card className="flex flex-col gap-4" style={{ background: 'var(--dark-1)', color: '#fff', borderColor: 'var(--dark-1)' }}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="relative inline-flex h-2.5 w-2.5 shrink-0">
          {active && (
            <span
              className="absolute inset-0 rounded-full"
              style={{ background: 'var(--green)', animation: 'ringpulse 1.6s ease-out infinite' }}
              aria-hidden
            />
          )}
          <span className="relative inline-flex h-2.5 w-2.5 rounded-full" style={{ background: active ? 'var(--green)' : 'var(--amber)' }} />
        </span>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="truncate" style={{ font: '700 15px/1 Inter', letterSpacing: '-0.015em' }}>
            {campaign?.name ?? 'Dial session'}
          </span>
          <span style={{ font: '500 11px/1 Inter', color: dim }}>
            {MODE_LABEL[session.mode] ?? session.mode} dialer · {active ? 'Running' : 'Paused'}
            {session.line_limit === 1 && session.mode === 'parallel' && (
              <span style={{ color: 'var(--accent-light)' }}> · reduced to 1 line (abandonment cap)</span>
            )}
          </span>
        </div>

        <div className="flex items-center gap-5 pr-2">
          {[
            { label: 'Dialed', value: session.dialed },
            { label: 'Connected', value: session.connected },
            { label: 'Abandoned', value: session.abandoned, warn: session.abandoned > 0 },
          ].map((k) => (
            <div key={k.label} className="flex flex-col items-end gap-1.5">
              <span style={eyebrow}>{k.label}</span>
              <span style={{ font: '700 18px/1 Inter', color: 'warn' in k && k.warn ? 'var(--accent-light)' : '#fff' }}>{k.value}</span>
            </div>
          ))}
        </div>

        <div className="flex items-center gap-2">
          {active && (
            <Button tone="green" onClick={onNext} disabled={inCall || !deviceReady} title={inCall ? 'Finish the current call first' : undefined}>
              <Icon name="phone" size={14} />
              {session.mode === 'parallel' ? 'Dial next batch' : 'Next lead'}
            </Button>
          )}
          {active ? (
            <Button onClick={onPause} style={{ background: 'var(--dark-2)', color: '#fff', border: '1px solid var(--dark-3)' }}>
              <Icon name="pause" size={13} />
              Pause
            </Button>
          ) : (
            <Button onClick={onResume} style={{ background: 'var(--dark-2)', color: '#fff', border: '1px solid var(--dark-3)' }}>
              Resume
            </Button>
          )}
          <Button tone="accent" onClick={onEnd}>
            End session
          </Button>
        </div>
      </div>

      {countdown && (
        <div className="flex items-center gap-3 px-3.5 py-3" style={{ background: 'var(--dark-2)', borderRadius: 'var(--r-md)' }}>
          <span style={{ width: 6, height: 6, background: 'var(--amber)' }} aria-hidden />
          <span className="flex-1" style={{ font: '500 12.5px/1 Inter' }}>
            Auto-dialing the next lead in <strong style={{ fontVariantNumeric: 'tabular-nums' }}>{countdown.secondsLeft}s</strong>
          </span>
          <Button onClick={onCancelCountdown} style={{ background: 'transparent', color: '#fff', border: '1px solid var(--dark-3)', padding: '7px 11px' }}>
            Cancel
          </Button>
        </div>
      )}

      {idleReason && (
        <div className="flex items-center gap-3 px-3.5 py-3" style={{ background: 'var(--dark-2)', borderRadius: 'var(--r-md)' }}>
          <span style={{ width: 6, height: 6, background: 'var(--amber)' }} aria-hidden />
          <span style={{ font: '500 12px/1.45 Inter', color: dim }}>
            Nothing dialable right now: <span style={{ color: '#fff' }}>{idleReason.replaceAll('_', ' ')}</span>
            {idleReason === 'outside_calling_window' && ' — dialing resumes when leads are inside their local calling window.'}
          </span>
        </div>
      )}

      {card && (
        <div className="grid gap-4 pt-4 md:grid-cols-3" style={{ borderTop: `1px solid ${line}` }}>
          <div className="flex flex-col gap-1.5">
            <span style={eyebrow}>Contact</span>
            <span style={{ font: '700 14px/1 Inter' }}>{card.contact?.display_name ?? 'Unknown'}</span>
            {card.contact?.phone ? (
              <PhoneText e164={card.contact.phone} size={20} tone="dark" style={{ font: '500 11.5px/1 Inter', color: dim }} />
            ) : (
              <span style={{ font: '500 11.5px/1 Inter', color: dim }}>—</span>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <span style={eyebrow}>Property</span>
            <span style={{ font: '600 13px/1 Inter' }}>{card.property?.address_line1 ?? '—'}</span>
            <span style={{ font: '500 11.5px/1 Inter', color: dim }}>
              {[card.property?.city, card.property?.state].filter(Boolean).join(', ')}
            </span>
          </div>
          <div className="flex flex-col gap-1.5">
            <span style={eyebrow}>Lead</span>
            <span style={{ font: '600 13px/1 Inter', textTransform: 'capitalize' }}>
              {card.lead.status.replace(/_/g, ' ')}
              <span style={{ font: '500 11.5px/1 Inter', color: dim, textTransform: 'none' }}> · {card.lead.source ?? 'unknown source'}</span>
            </span>
            {latestCall && (
              <span className="inline-flex items-center gap-2" style={{ font: '500 11.5px/1 Inter', color: dim }}>
                Call {latestCall.status.replace(/_/g, ' ')}
                {latestCall.status === 'queued' && session.mode !== 'parallel' && !inCall && (
                  <button
                    type="button"
                    onClick={() => onDialNow(latestCall.id)}
                    style={{ border: 'none', background: 'transparent', color: 'var(--accent-light)', cursor: 'pointer', font: '600 11.5px/1 Inter', padding: 0 }}
                  >
                    Dial now
                  </button>
                )}
              </span>
            )}
          </div>
        </div>
      )}

      {session.mode === 'parallel' && (
        <span style={{ font: '500 11px/1.4 Inter', color: dim }}>
          Parallel lines dial server-side; the first seller to answer rings into your softphone.
        </span>
      )}
    </Card>
  );
}

/* ── Attach leads ────────────────────────────────────────────────────────── */

function AttachLeads({ campaignId, onDone }: { campaignId: string; onDone: () => Promise<void> }) {
  const [source, setSource] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-col gap-1.5 pt-3.5" style={{ borderTop: '1px solid var(--line-soft)' }}>
      <Eyebrow>Attach leads</Eyebrow>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="flex-1"
          style={{ minWidth: 200 }}
          value={source}
          onChange={(e) => setSource(e.target.value)}
          placeholder="Lead source filter — blank attaches every lead"
        />
        <Button
          tone="dark"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void api
              .attachCampaignLeads(campaignId, { filter: source ? { source } : {} })
              .then(async (r) => {
                setResult(`Attached ${r.attached}, revived ${r.revived}.`);
                await onDone();
              })
              .catch((e: Error) => setResult((e as ApiError).message ?? e.message))
              .finally(() => setBusy(false));
          }}
        >
          {busy ? 'Attaching…' : 'Attach'}
        </Button>
      </div>
      {result && <span style={{ font: '500 11px/1.3 Inter', color: 'var(--muted)' }}>{result}</span>}
    </div>
  );
}

/* ── Create / edit ───────────────────────────────────────────────────────── */

function CampaignForm({
  campaign,
  onClose,
  onSaved,
}: {
  campaign: CampaignDto | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const s = campaign?.settings ?? {};
  const [name, setName] = useState(campaign?.name ?? '');
  const [mode, setMode] = useState(campaign?.mode ?? 'power');
  const [windowStart, setWindowStart] = useState(s.callingWindowStart ?? '09:00');
  const [windowEnd, setWindowEnd] = useState(s.callingWindowEnd ?? '20:00');
  const [attemptsPerDay, setAttemptsPerDay] = useState(s.maxAttemptsPerDay ?? 2);
  const [attemptsTotal, setAttemptsTotal] = useState(s.maxAttemptsTotal ?? 8);
  const [backoffHours, setBackoffHours] = useState(s.retryBackoffHours ?? 4);
  const [lines, setLines] = useState(s.parallelLines ?? 2);
  const [amdEnabled, setAmdEnabled] = useState(s.amdEnabled ?? false);
  const [amdAction, setAmdAction] = useState<'hangup' | 'voicemail_drop'>(s.amdAction ?? 'hangup');
  const [amdText, setAmdText] = useState(s.amdVoicemailText ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    setError(null);
    const settings: CampaignSettingsDto = {
      callingWindowStart: windowStart,
      callingWindowEnd: windowEnd,
      maxAttemptsPerDay: Number(attemptsPerDay),
      maxAttemptsTotal: Number(attemptsTotal),
      retryBackoffHours: Number(backoffHours),
      parallelLines: Number(lines),
      amdEnabled,
      amdAction,
      ...(amdText ? { amdVoicemailText: amdText } : {}),
    };
    try {
      if (campaign) await api.updateCampaign(campaign.id, { name: name.trim(), mode, settings });
      else await api.createCampaign({ name: name.trim(), mode, settings });
      await onSaved();
    } catch (err) {
      setError(err instanceof ApiError ? `${err.code}: ${err.message}` : (err as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Modal title={campaign ? 'Edit campaign' : 'New campaign'} onClose={onClose}>
      <div className="flex flex-col gap-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Labeled label="Name" className="sm:col-span-2">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Austin absentee owners" autoFocus />
          </Labeled>
          <Labeled label="Dialer mode">
            <Select value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="power">Power — you press Next</option>
              <option value="progressive">Progressive — auto-advances</option>
              <option value="parallel">Parallel — multi-line</option>
              <option value="predictive" disabled>
                Predictive — needs real-world stats
              </option>
            </Select>
          </Labeled>
          <Labeled label="Parallel lines · max 3">
            <Input type="number" min={1} max={3} value={lines} onChange={(e) => setLines(Number(e.target.value))} disabled={mode !== 'parallel'} />
          </Labeled>
        </div>

        <section className="flex flex-col gap-3">
          <Eyebrow>Calling window · lead’s local time</Eyebrow>
          <div className="grid gap-3 sm:grid-cols-2">
            <Labeled label="Start">
              <Input value={windowStart} onChange={(e) => setWindowStart(e.target.value)} placeholder="09:00" />
            </Labeled>
            <Labeled label="End">
              <Input value={windowEnd} onChange={(e) => setWindowEnd(e.target.value)} placeholder="20:00" />
            </Labeled>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <Eyebrow>Attempts</Eyebrow>
          <div className="grid gap-3 sm:grid-cols-3">
            <Labeled label="Per day">
              <Input type="number" min={1} max={6} value={attemptsPerDay} onChange={(e) => setAttemptsPerDay(Number(e.target.value))} />
            </Labeled>
            <Labeled label="Total">
              <Input type="number" min={1} max={30} value={attemptsTotal} onChange={(e) => setAttemptsTotal(Number(e.target.value))} />
            </Labeled>
            <Labeled label="Retry after · hours">
              <Input type="number" min={1} max={72} value={backoffHours} onChange={(e) => setBackoffHours(Number(e.target.value))} />
            </Labeled>
          </div>
        </section>

        <section className="flex flex-col gap-3">
          <div className="flex items-center gap-3">
            <div className="flex min-w-0 flex-1 flex-col gap-1">
              <span style={{ font: '600 12.5px/1 Inter' }}>Answering machine detection</span>
              <span style={{ font: '500 10.5px/1.3 Inter', color: 'var(--muted)' }}>Parallel sessions only. Decide what happens when a machine picks up.</span>
            </div>
            <Toggle on={amdEnabled} onChange={setAmdEnabled} label="Answering machine detection" />
          </div>
          {amdEnabled && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Labeled label="On machine">
                <Select value={amdAction} onChange={(e) => setAmdAction(e.target.value as 'hangup' | 'voicemail_drop')}>
                  <option value="hangup">Hang up</option>
                  <option value="voicemail_drop">Drop a voicemail</option>
                </Select>
              </Labeled>
              {amdAction === 'voicemail_drop' && (
                <Labeled label="Voicemail message" className="sm:col-span-2">
                  <TextArea value={amdText} onChange={(e) => setAmdText(e.target.value)} rows={3} placeholder="Hi, this is Alex with Your Company…" />
                </Labeled>
              )}
            </div>
          )}
        </section>

        <span style={{ font: '500 10.5px/1.45 Inter', color: 'var(--muted-2)' }}>
          The abandonment cap is fixed at 3% of answered calls (FTC guidance). Parallel sessions drop to one line automatically
          when it is breached.
        </span>

        {error && <Notice tone="error">{error}</Notice>}

        <div className="flex items-center justify-end gap-2" style={{ borderTop: '1px solid var(--line-soft)', paddingTop: 14 }}>
          <Button tone="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button tone="accent" onClick={() => void save()} disabled={!name.trim() || saving}>
            {saving ? 'Saving…' : campaign ? 'Save changes' : 'Create campaign'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
