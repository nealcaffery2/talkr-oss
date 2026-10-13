'use client';

/**
 * Dialer workspace (design 1c): dial column, the live call in the centre, and
 * the team's clocks on the right. Three columns because a rep on a call needs
 * all three at once — what they are dialing, who they are talking to, and who
 * they could hand it to.
 *
 * The centre always carries the party's context (CallContext): before a call
 * for the number typed or picked, while a call rings in, and beside the live
 * call the moment it starts — lead, script and objections, without a click.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ApiError, api, type CallContextParams, type CallDto, type MeDto, type TeamMemberDto } from '@/lib/api';
import { shortDeviceLabel, useSoftphone } from '@/lib/softphone';
import { TopBar } from '@/components/TopBar';
import { ActiveCall } from '@/components/ActiveCall';
import { Icon } from '@/components/Icon';
import { Avatar, Button, Card, EmptyState, Eyebrow, Segmented, StatusMarker } from '@/components/ui';
import { CALL_CONTEXT_TABS, CallContext, defaultCallContextTab, type CallContextTab } from '@/components/CallContext';
import { CallerIdPicker, callerIdLabel } from '@/components/CallerIdPicker';
import { callWindow, duration, formatPhone, toE164, tzAbbr, tzTime, zoneForNumber } from '@/lib/time';

const KEYS: Array<[string, string]> = [
  ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
  ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
  ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
  ['*', ''], ['0', '+'], ['#', ''],
];

const ZONES: Array<[string, string]> = [
  ['Eastern', 'America/New_York'],
  ['Central', 'America/Chicago'],
  ['Mountain', 'America/Denver'],
  ['Pacific', 'America/Los_Angeles'],
];

/** The phone's in-call switch: the call itself, or one of the panel's tabs. */
type MobileCallTab = 'call' | CallContextTab;

export default function DialerPage() {
  const {
    deviceState,
    deviceError,
    callState,
    initDevice,
    placeCall,
    authed,
    active,
    incoming,
    inputDevices,
    outputDevices,
    activeInputDeviceId,
    activeOutputDeviceId,
  } = useSoftphone();
  const router = useRouter();
  const [digits, setDigits] = useState('');
  const [recent, setRecent] = useState<CallDto[]>([]);
  const [team, setTeam] = useState<TeamMemberDto[]>([]);
  const [me, setMe] = useState<MeDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notes, setNotes] = useState('');
  const [now, setNow] = useState<number | null>(null);
  // What a phone shows when there is no call: the keypad fills the screen,
  // Recent and the party's context sit behind a switch. A desk shows all of it.
  const [pane, setPane] = useState<'keypad' | 'recent' | 'lead'>('keypad');
  // What a phone shows during a call: the call, or one tab of the context panel.
  const [mobileCallTab, setMobileCallTab] = useState<MobileCallTab>('call');

  const inCall = callState !== 'idle';

  // Clocks tick client-side only: the server cannot know the rep's zone, and a
  // mismatched first paint is a hydration error.
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const load = useCallback(() => {
    if (!authed) return;
    api.listCalls().then((r) => setRecent(r.calls.slice(0, 8))).catch(() => setRecent([]));
    api.listTeam().then((r) => setTeam(r.members)).catch(() => setTeam([]));
    api.getMe().then(setMe).catch(() => undefined);
  }, [authed]);

  useEffect(load, [load]);
  // A finished call belongs in Recent straight away.
  useEffect(() => {
    if (callState === 'idle') load();
  }, [callState, load]);

  async function dial(input: { to_number?: string; lead_id?: string; contact_id?: string }) {
    setError(null);
    try {
      await placeCall(input);
      setDigits('');
    } catch (err) {
      if (err instanceof ApiError && err.code === 'suppressed') {
        setError('This number is on the Do-Not-Call list.');
      } else {
        setError((err as Error).message);
      }
    }
  }

  const dialZone = useMemo(() => (digits.length >= 3 ? zoneForNumber(toE164(digits)) : null), [digits]);

  // Ten digits is a whole number: that is when the party's context loads. The
  // panel debounces the fetch itself and drops a stale party the moment the
  // number changes.
  const contextPhone = useMemo(() => (digits.replace(/^1/, '').length === 10 ? toE164(digits) : null), [digits]);

  // The caller while the phone rings — a real E.164, not Twilio's "Unknown".
  const incomingPhone = incoming && /^\+\d{7,}$/.test(incoming.from) ? incoming.from : null;

  // The live call's identity for the panel: the server's call id, or the other
  // party's number until an accepted inbound call has learned its id.
  const activeCallId = active && active.record.id && active.record.id !== 'unknown' ? active.record.id : undefined;
  const activeParams = useMemo<CallContextParams | null>(() => {
    if (!active) return null;
    if (activeCallId) return { call_id: activeCallId };
    const other = active.record.direction === 'outbound' ? active.record.to_number : active.record.from_number;
    return other ? { phone: other } : null;
  }, [active, activeCallId]);

  // A phone opens a new call on the panel's default tab — the script on an
  // outbound call, the lead on an inbound one — because the global call bar
  // already carries mute, hold and end.
  const activeDirection = active?.record.direction;
  useEffect(() => {
    if (activeDirection) setMobileCallTab(defaultCallContextTab('incall', activeDirection));
    else setMobileCallTab('call');
  }, [activeDirection]);
  useEffect(() => {
    if (!contextPhone) setPane((v) => (v === 'lead' ? 'keypad' : v));
  }, [contextPhone]);

  if (!authed) {
    return (
      <p className="p-6" style={{ font: '400 13px/1.5 Inter', color: 'var(--muted)' }}>
        Not signed in — open <a href="/login" style={{ color: 'var(--accent)' }}>Account</a> and add your access token.
      </p>
    );
  }

  const dialDisabled = !digits || inCall || deviceState !== 'ready';
  const canCall = !inCall && deviceState === 'ready';
  // Worded exactly as components/ProspectTime does it, so the two places this
  // page states the seller's clock never look like two different facts.
  const hint =
    dialZone && now !== null
      ? `${tzTime(dialZone, now)} their time`
      : callerIdLabel(me) || 'No number assigned to you yet';
  const openText = (phone: string) => router.push(`/messages?to=${encodeURIComponent(phone)}`);

  /** The number being dialed. Typed, pasted or tapped in; a phone keyboard when typed. */
  const numberField = (big: boolean) => (
    <input
      value={formatPhone(digits)}
      onChange={(e) => setDigits(e.target.value.replace(/\D/g, '').slice(0, 11))}
      onKeyDown={(e) => {
        if (e.key === 'Enter' && digits && !inCall) void dial({ to_number: toE164(digits) });
      }}
      placeholder={big ? 'Enter a number' : '(   )   -'}
      inputMode="tel"
      autoComplete="tel"
      enterKeyHint="go"
      aria-label="Number to dial"
      className={`min-w-0 flex-1 bg-transparent outline-none ${big ? 'w-full text-center' : ''}`}
      style={big ? { font: '600 34px/1.15 Inter', letterSpacing: '-0.01em' } : { font: '600 15px/1 Inter' }}
    />
  );

  /** The twelve keys. On a phone they grow to fill the screen, capped so they stay keys. */
  const keys = (big: boolean) => (
    <div
      className={big ? 'grid min-h-0 w-full flex-1 grid-cols-3 gap-2.5' : 'grid grid-cols-3 gap-1.5'}
      style={big ? { gridAutoRows: 'minmax(56px, 1fr)', maxHeight: 400 } : undefined}
    >
      {KEYS.map(([d, letters]) => (
        <button
          key={d}
          type="button"
          onClick={() => setDigits((v) => (v + d).slice(0, 11))}
          className={`flex flex-col items-center justify-center transition-transform active:scale-95 ${
            big ? 'gap-0.5' : 'h-11 gap-px'
          }`}
          style={{
            border: '1px solid var(--line)',
            borderRadius: big ? 16 : 'var(--r-btn)',
            background: 'var(--panel)',
            boxShadow: big ? 'var(--shadow-rest)' : undefined,
            cursor: 'pointer',
            touchAction: 'manipulation',
          }}
        >
          <span style={{ font: big ? '500 28px/1 Inter' : '500 17px/1 Inter' }}>{d}</span>
          <span
            style={{
              font: big ? '600 9px/1 Inter' : '600 7px/1 Inter',
              letterSpacing: '0.14em',
              color: 'var(--muted-2)',
              minHeight: big ? 9 : 7,
            }}
          >
            {letters}
          </span>
        </button>
      ))}
    </div>
  );

  const recentList = (big: boolean) => (
    <>
      {recent.length === 0 && (
        <EmptyState
          compact
          icon="phone"
          title="No calls yet"
          hint="Your last few calls land here, one tap from redialling them."
        />
      )}
      {recent.map((c) => {
        const other = c.direction === 'outbound' ? c.to_number : c.from_number;
        const missed = c.status === 'no_answer' || c.status === 'busy';
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => {
              // Picking a row loads that party: the number lands in the field
              // and the context panel follows it by phone.
              setDigits(other.replace(/\D/g, '').slice(-10));
              setPane('lead');
            }}
            className={`lift-row flex items-center gap-2.5 px-2 text-left ${big ? 'py-3' : 'py-2'}`}
            style={{ borderBottom: '1px solid var(--panel-2)', borderRadius: 8, cursor: 'pointer' }}
          >
            <span
              className={`inline-flex items-center justify-center ${big ? 'h-9 w-9' : 'h-6 w-6'}`}
              style={{
                borderRadius: big ? 11 : 8,
                background: 'var(--panel-2)',
                color: missed ? 'var(--red)' : c.direction === 'inbound' ? 'var(--accent)' : 'var(--green)',
              }}
            >
              <Icon name="phone" size={big ? 15 : 12} />
            </span>
            <span className="mr-auto flex min-w-0 flex-col gap-1">
              <span className="truncate" style={{ font: big ? '600 14px/1 Inter' : '600 12px/1 Inter' }}>
                {c.contact_name ?? formatPhone(other)}
              </span>
              <span style={{ font: big ? '500 11.5px/1 Inter' : '500 10px/1 Inter', color: 'var(--muted)' }}>
                {c.direction} · {c.status.replace(/_/g, ' ')}
              </span>
            </span>
            <span style={{ font: big ? '500 12px/1 Inter' : '500 10px/1 Inter', color: 'var(--muted-2)' }}>
              {c.duration_seconds != null ? duration(c.duration_seconds) : ''}
            </span>
          </button>
        );
      })}
    </>
  );

  const micLabel = shortDeviceLabel(
    inputDevices.find((d) => d.deviceId === activeInputDeviceId)?.label ?? 'Default mic',
  );
  const speakerLabel = shortDeviceLabel(
    outputDevices.find((d) => d.deviceId === activeOutputDeviceId)?.label ?? 'Default speaker',
  );

  const softphoneRow = (
    <>
      {deviceState !== 'ready' && (
        <Button tone="accent" onClick={() => void initDevice()} disabled={deviceState === 'initializing'}>
          {deviceState === 'initializing'
            ? 'Connecting…'
            : deviceState === 'offline'
              ? 'Reconnect softphone'
              : deviceState === 'error'
                ? 'Retry softphone'
                : 'Enable softphone'}
        </Button>
      )}
      {deviceState === 'ready' && (
        // Which headset is live, at a glance: the wrong one is the commonest "I can't hear them".
        <p className="truncate" style={{ font: '500 10.5px/1.4 Inter', color: 'var(--muted-2)' }}>
          Audio: {micLabel} → {speakerLabel} ·{' '}
          <Link href="/settings" style={{ color: 'var(--muted)' }}>
            change
          </Link>
        </p>
      )}
      {deviceError && <p style={{ font: '400 11px/1.4 Inter', color: 'var(--red)' }}>{deviceError}</p>}
      {error && <p style={{ font: '400 11px/1.4 Inter', color: 'var(--red)' }}>{error}</p>}
    </>
  );

  const notesCard = (
    <Card className="flex flex-col gap-2.5">
      <Eyebrow>Call notes</Eyebrow>
      <textarea
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
        placeholder="Asking price, timeline, condition…"
        className="min-h-24 resize-none outline-none"
        style={{
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-btn)',
          padding: '10px 12px',
          font: '400 12.5px/1.5 Inter',
        }}
      />
      <div className="flex flex-wrap gap-1.5">
        {['motivated', 'callback after 5pm local', 'do not call'].map((tag) => (
          <Button
            key={tag}
            tone="ghost"
            style={{ padding: '7px 10px', font: '600 11px/1 Inter' }}
            onClick={() => setNotes((n) => `${n} [${tag}]`.trim())}
          >
            + {tag}
          </Button>
        ))}
      </div>
      <p style={{ font: '400 10.5px/1.4 Inter', color: 'var(--muted-2)' }}>
        Notes are saved with the call&apos;s disposition at wrap-up.
      </p>
    </Card>
  );

  /** Before a call: the party behind the number, or, while a call rings in, the caller. */
  const precallContext = incomingPhone && !active ? (
    <CallContext mode="incoming" params={{ phone: incomingPhone }} onText={openText} />
  ) : contextPhone ? (
    <CallContext
      mode="precall"
      params={{ phone: contextPhone }}
      onCall={(input) => void dial(input)}
      canCall={canCall}
      onText={openText}
    />
  ) : (
    <Card>
      <EmptyState
        icon="phone"
        title="No call in progress"
        hint="Dial a number to see who it is, their history and the script. Hold, add a call, merge and transfer all appear here once you are connected."
      />
    </Card>
  );

  /** The live call's context panel, shared by the desk's right column and the phone's tabs. */
  const inCallContext = (controlled: boolean) =>
    active && (
      <CallContext
        mode="incall"
        callId={activeCallId}
        params={activeParams}
        direction={active.record.direction}
        onText={openText}
        {...(controlled
          ? {
              tab: mobileCallTab === 'call' ? defaultCallContextTab('incall', active.record.direction) : mobileCallTab,
              onTabChange: (t: CallContextTab) => setMobileCallTab(t),
            }
          : {})}
      />
    );

  return (
    <>
      <TopBar
        title="Dialer"
        subtitle={inCall ? 'One live call' : 'Ready to dial'}
        onPresenceChange={(s) => void api.heartbeat(s).catch(() => undefined)}
      />

      {/* ── Phone: one screen at a time ─────────────────────────────────── */}
      <div className="flex min-h-0 flex-1 flex-col md:hidden">
        {active ? (
          <>
            <div className="px-3 pt-3">
              <Segmented
                value={mobileCallTab}
                onChange={setMobileCallTab}
                options={[{ value: 'call' as const, label: 'Call' }, ...CALL_CONTEXT_TABS]}
              />
            </div>
            {/* pb-24 keeps the last card clear of the global call bar. */}
            <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3 pb-24">
              <div className={mobileCallTab === 'call' ? 'flex flex-col gap-3' : 'hidden'}>
                <ActiveCall team={team} />
                {notesCard}
              </div>
              <div className={mobileCallTab === 'call' ? 'hidden' : 'flex flex-col'}>{inCallContext(true)}</div>
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 px-4 pt-3">
              <Segmented
                value={pane}
                onChange={setPane}
                options={[
                  { value: 'keypad', label: 'Keypad' },
                  { value: 'recent', label: 'Recent' },
                  ...(contextPhone ? [{ value: 'lead' as const, label: 'Lead' }] : []),
                ]}
              />
              <span className="truncate" style={{ font: '500 11px/1 Inter', color: 'var(--muted)' }}>
                {hint}
              </span>
            </div>

            {pane === 'recent' && (
              <div className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto px-4 pb-4 pt-2">
                {recentList(true)}
              </div>
            )}

            {pane === 'lead' && contextPhone && (
              <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-3">
                <CallContext
                  mode="precall"
                  params={{ phone: contextPhone }}
                  onCall={(input) => void dial(input)}
                  canCall={canCall}
                  onText={openText}
                />
              </div>
            )}

            {pane === 'keypad' && (
              <div className="flex min-h-0 flex-1 flex-col gap-3 px-5 pb-3 pt-4">
                <div className="flex min-h-12 items-center">{numberField(true)}</div>
                {keys(true)}
                <div className="grid grid-cols-[1fr_auto_1fr] items-center gap-3 pt-1">
                  <button
                    type="button"
                    aria-label="Text this number"
                    onClick={() => {
                      window.location.href = '/messages';
                    }}
                    className="inline-flex h-14 w-14 items-center justify-center justify-self-end"
                    style={{ border: '1px solid var(--line)', borderRadius: 18, background: 'var(--panel)', color: 'var(--text)' }}
                  >
                    <Icon name="msg" size={22} />
                  </button>
                  <button
                    type="button"
                    aria-label="Call"
                    disabled={dialDisabled}
                    onClick={() => void dial({ to_number: toE164(digits) })}
                    className="inline-flex items-center justify-center transition-transform active:scale-95"
                    style={{
                      width: 76,
                      height: 76,
                      borderRadius: '50%',
                      border: 'none',
                      background: 'var(--green)',
                      color: '#fff',
                      boxShadow: '0 10px 24px rgba(22,163,74,.34)',
                      opacity: dialDisabled ? 0.45 : 1,
                      touchAction: 'manipulation',
                    }}
                  >
                    <Icon name="phone" size={30} />
                  </button>
                  <button
                    type="button"
                    aria-label="Backspace"
                    onClick={() => setDigits((d) => d.slice(0, -1))}
                    className="inline-flex h-14 w-14 items-center justify-center justify-self-start"
                    style={{ background: 'transparent', border: 'none', color: 'var(--muted)', touchAction: 'manipulation' }}
                  >
                    <Icon name="backspace" size={26} />
                  </button>
                </div>
                {softphoneRow}
              </div>
            )}
          </>
        )}
      </div>

      {/* ── Desk: three columns; two while a call is up, so the call and its
             context sit side by side (the team column returns at 2xl) ──── */}
      <div
        className={
          active
            ? 'hidden min-h-0 flex-1 grid-cols-[280px_1fr] md:grid 2xl:grid-cols-[280px_1fr_300px]'
            : 'hidden min-h-0 flex-1 grid-cols-[280px_1fr_280px] md:grid xl:grid-cols-[300px_1fr_320px]'
        }
      >
        {/* ── Dial ──────────────────────────────────────────────────────── */}
        <div
          className="flex min-h-0 flex-col border-r border-[var(--line)]"
          style={{ background: 'var(--panel)' }}
        >
          <div className="flex flex-col gap-2.5 px-4 pb-3 pt-4">
            <Eyebrow>Dial</Eyebrow>

            <div
              className="flex items-center gap-2 px-3 py-2"
              style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-btn)' }}
            >
              {numberField(false)}
              <button
                type="button"
                onClick={() => setDigits((d) => d.slice(0, -1))}
                aria-label="Backspace"
                style={{ color: 'var(--muted-2)', cursor: 'pointer' }}
              >
                <Icon name="backspace" size={16} />
              </button>
            </div>

            {keys(false)}

            <div className="flex gap-2">
              <Button
                tone="green"
                className="flex-1"
                style={{ height: 42 }}
                disabled={dialDisabled}
                onClick={() => void dial({ to_number: toE164(digits) })}
              >
                <Icon name="phone" size={16} />
                Call
              </Button>
              <Button tone="ghost" onClick={() => { window.location.href = '/messages'; }} style={{ width: 44 }}>
                <Icon name="msg" size={16} />
              </Button>
            </div>

            {softphoneRow}

            {me && me.org_numbers.length > 0 && (
              <div className="flex flex-col gap-1.5">
                <Eyebrow>Caller ID</Eyebrow>
                <CallerIdPicker me={me} onChange={setMe} compact />
              </div>
            )}
            <div
              className="flex items-center gap-2 px-3 py-2"
              style={{ border: '1px dashed var(--line)', borderRadius: 'var(--r-btn)' }}
            >
              <Icon name="pin" size={14} style={{ color: 'var(--accent)' }} />
              <span style={{ font: '500 11px/1.35 Inter', color: 'var(--muted)' }}>{hint}</span>
            </div>
          </div>

          <div
            className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-auto px-4 pb-4 pt-3"
            style={{ borderTop: '1px solid var(--line-soft)' }}
          >
            <Eyebrow className="pb-1.5">Recent</Eyebrow>
            {recentList(false)}
          </div>
        </div>

        {/* ── The call beside its context, or the context alone ─────────── */}
        <div className="flex min-h-0 min-w-0 flex-col gap-3.5 overflow-auto p-5">
          {active ? (
            <div className="grid items-start gap-3.5 min-[1100px]:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
              {/* The controls stay put while the rep scrolls the script. */}
              <div className="flex min-w-0 flex-col gap-3.5 min-[1100px]:sticky min-[1100px]:top-0">
                <ActiveCall team={team} />
                {notesCard}
              </div>
              <div className="min-w-0">{inCallContext(false)}</div>
            </div>
          ) : (
            <>
              {precallContext}
              {notesCard}
            </>
          )}
        </div>

        {/* ── Team clocks ───────────────────────────────────────────────── */}
        <div
          className={`${active ? 'hidden 2xl:flex' : 'flex'} min-h-0 flex-col gap-4 overflow-auto border-l border-[var(--line)] p-4`}
          style={{ background: 'var(--panel)' }}
        >
          <div className="flex flex-col gap-2.5">
            <Eyebrow>Team presence</Eyebrow>
            {team.length === 0 && (
              <EmptyState
                compact
                icon="users"
                title="No teammates yet"
                hint="Their local time and presence show here, so you know who can take a transfer."
              />
            )}
            {team.map((m) => (
              <div
                key={m.id}
                className="flex items-center gap-2.5 py-2"
                style={{ borderBottom: '1px solid var(--panel-2)' }}
              >
                <Avatar name={m.display_name} size={30} />
                <span className="mr-auto flex min-w-0 flex-col gap-1">
                  <span className="truncate" style={{ font: '600 12px/1 Inter' }}>{m.display_name}</span>
                  <span style={{ font: '500 10px/1 Inter', color: 'var(--muted)' }}>
                    {m.city ?? 'Zone not set'}
                    {m.timezone && now !== null ? ` · ${tzAbbr(m.timezone, now)}` : ''}
                  </span>
                </span>
                <span className="flex flex-col items-end gap-1">
                  <span style={{ font: '600 12px/1 Inter' }}>
                    {m.timezone && now !== null ? tzTime(m.timezone, now) : '—'}
                  </span>
                  <StatusMarker
                    color={
                      m.presence === 'available'
                        ? 'var(--green)'
                        : m.presence === 'away'
                          ? 'var(--amber)'
                          : 'var(--muted-2)'
                    }
                    label={m.presence}
                  />
                </span>
              </div>
            ))}
          </div>

          <Card className="flex flex-col gap-2.5">
            <Eyebrow>Dialing windows</Eyebrow>
            {ZONES.map(([label, tz]) => {
              const w = now === null ? null : callWindow(tz, now);
              return (
                <div
                  key={tz}
                  className="flex items-center gap-2.5 py-1.5"
                  style={{ borderBottom: '1px solid var(--panel-2)' }}
                >
                  <span
                    style={{ width: 6, height: 6, background: w ? w.color : 'var(--muted-2)' }}
                    aria-hidden
                  />
                  <span className="mr-auto" style={{ font: '600 11.5px/1 Inter' }}>{label}</span>
                  <span style={{ font: '600 11.5px/1 Inter', color: 'var(--muted)' }}>
                    {now === null ? '—' : tzTime(tz, now)}
                  </span>
                  <span
                    style={{
                      font: '600 9px/1 Inter',
                      letterSpacing: '0.1em',
                      textTransform: 'uppercase',
                      color: w ? w.color : 'var(--muted-2)',
                      width: 74,
                      textAlign: 'right',
                    }}
                  >
                    {w ? (w.safe ? 'Open' : 'Quiet hours') : '—'}
                  </span>
                </div>
              );
            })}
            <p style={{ font: '400 10.5px/1.4 Inter', color: 'var(--muted-2)' }}>
              9:00 AM — 8:00 PM in the lead&apos;s local time.
            </p>
          </Card>
        </div>
      </div>
    </>
  );
}
