/**
 * Extension side panel — design 1b, 400×780.
 *
 * Layout B: the same call as the popup, but laid out for a surface that stays
 * open beside the CRM. The controls are an inline 4-across grid rather than a
 * sheet, the roster and transfer list are always visible instead of hidden
 * behind a button, and there is room for notes.
 *
 * Both surfaces render the same offscreen snapshot, so opening one while the
 * other is up shows the same call in the same state.
 */

import { useEffect, useRef, useState } from 'react';
import { Icon, HangupIcon, type IconName } from '@/shared/Icon';
import { Avatar, Button, Card, ControlTile, Eyebrow, StatusMarker } from '@/shared/ui';
import { AudioSheet } from '@/shared/AudioSheet';
import { useCall } from '@/shared/useCall';
import { useSession } from '@/shared/useSession';
import { useCallContext } from '@/shared/callContext';
import { TEMP_LABEL, TempDot } from '@/shared/contacts';
import { api, type TeamMemberDto } from '@/shared/api';
import { duration, formatPhone, tzTime, zoneForNumber } from '@/shared/time';
import { LeadTab } from './context/LeadTab';
import { ScriptTab } from './context/ScriptTab';
import { ObjectionsTab } from './context/ObjectionsTab';

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'];

/**
 * The panel's body. Lead / Script / Objections are the in-call context (one
 * GET /v1/call-context per call); Call is the roster, transfer list and the
 * panel's own notes.
 */
type PanelTab = 'lead' | 'script' | 'objections' | 'call';

const TABS: Array<[PanelTab, string, IconName]> = [
  ['lead', 'Lead', 'user'],
  ['script', 'Script', 'template'],
  ['objections', 'Objections', 'shield'],
  ['call', 'Call', 'users'],
];

export function SidePanel() {
  const { snapshot, dispatch } = useCall();
  const sessionState = useSession();
  const [now, setNow] = useState(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [keypadOpen, setKeypadOpen] = useState(false);
  const [dtmf, setDtmf] = useState('');
  const [mode, setMode] = useState<'warm' | 'blind'>('warm');
  const [team, setTeam] = useState<TeamMemberDto[]>([]);
  const [notes, setNotes] = useState('');
  const [audioOpen, setAudioOpen] = useState(false);
  const [tab, setTab] = useState<PanelTab>('lead');
  // Once the rep picks a tab for this call, the phase-driven default stops.
  const pickedTab = useRef(false);

  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      if (snapshot.startedAt) setElapsed(Math.floor((Date.now() - snapshot.startedAt) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [snapshot.startedAt]);

  const signedInAs = sessionState?.user?.id ?? null;
  useEffect(() => {
    if (!signedInAs) return;
    const load = () => api.listTeam().then((r) => setTeam(r.members)).catch(() => undefined);
    load();
    // Presence goes stale after 90s; a panel left open all day must re-read.
    const t = setInterval(load, 30_000);
    return () => clearInterval(t);
  }, [signedInAs]);

  const counterparty = snapshot.counterparty ?? snapshot.incoming?.from ?? null;
  const counterZone = counterparty ? zoneForNumber(counterparty) : null;
  const ringing = snapshot.incoming !== null || snapshot.phase === 'connecting' || snapshot.phase === 'ringing';
  const inCall = snapshot.phase === 'in_call';

  /**
   * The lead, scripts and rebuttals for whoever is on the line. Keyed by the
   * platform call id when the snapshot has one (outbound from the first
   * moment; inbound once accepted), otherwise by the other party's number
   * (inbound while still ringing). Cached per call, so switching tabs or
   * re-opening the panel mid-call never re-reads it.
   */
  const context = useCallContext({
    callId: snapshot.callId,
    phone: counterparty,
    enabled: Boolean(signedInAs && counterparty && (ringing || inCall || snapshot.phase === 'wrapup')),
  });
  const contact = context.context?.contact ?? null;

  // Default tab per call: Lead while it rings — who is this? — and, for an
  // outbound call, Script the moment they pick up.
  const callKey = snapshot.callId ?? counterparty;
  useEffect(() => {
    pickedTab.current = false;
    setTab('lead');
  }, [callKey]);
  useEffect(() => {
    if (!pickedTab.current && inCall && snapshot.direction === 'outbound') setTab('script');
  }, [inCall, snapshot.direction]);

  function pickTab(next: PanelTab) {
    pickedTab.current = true;
    setTab(next);
  }

  /** Add call / Transfer live on the Call tab; the tiles take the rep there. */
  function showTransferList() {
    pickTab('call');
    requestAnimationFrame(() => {
      document.getElementById('transfer-list')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }

  const contactName = contact?.display_name ?? snapshot.incoming?.contactName ?? null;
  const displayName = contactName ?? formatPhone(counterparty ?? '');
  const placeSource = contact?.address ?? context.context?.property ?? null;
  const place = placeSource?.city
    ? `${placeSource.city}${placeSource.state ? `, ${placeSource.state}` : ''}`
    : null;
  const live = snapshot.participants.filter((p) => p.state !== 'left');
  const guests = live.filter((p) => p.role === 'teammate' || p.role === 'external');
  const phaseLabel = snapshot.onHold
    ? 'On hold'
    : snapshot.incoming
      ? 'Incoming'
      : snapshot.phase === 'connecting' || snapshot.phase === 'ringing'
        ? 'Ringing'
        : snapshot.phase === 'in_call'
          ? 'Connected'
          : snapshot.phase === 'wrapup'
            ? 'Ended'
            : snapshot.phase;

  if (sessionState === null) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <PanelHeader status="signed out" />
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            padding: 24,
            textAlign: 'center',
          }}
        >
          <Icon name="user" size={22} style={{ color: 'var(--muted-2)' }} />
          <div style={{ font: '600 14px/1 Inter' }}>Not signed in</div>
          <p style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>
            Sign in from the toolbar popup. The side panel shares that session.
          </p>
        </div>
      </div>
    );
  }

  if (!inCall && snapshot.phase === 'idle' && !snapshot.incoming) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh' }}>
        <PanelHeader status={snapshot.device} />
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            padding: 24,
            textAlign: 'center',
          }}
        >
          <Icon name="phone" size={22} style={{ color: 'var(--muted-2)' }} />
          <div style={{ font: '600 14px/1 Inter' }}>No call in progress</div>
          <p style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>
            Start a call from the toolbar popup. It will appear here with the full control set —
            hold, add call, merge and transfer.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100vh',
        background: 'var(--bg)',
        position: 'relative',
      }}
    >
      <PanelHeader status={snapshot.device} onHold={snapshot.onHold} />

      {/* ── Who and how long ─────────────────────────────────────────── */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 11, padding: 14, background: 'var(--dark-1)' }}>
        <Avatar name={displayName} size={46} dark />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginRight: 'auto', minWidth: 0 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              minWidth: 0,
              font: '600 15px/1 Inter',
              color: '#fff',
            }}
          >
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{displayName}</span>
            {contact && (
              <span
                title={`${TEMP_LABEL[contact.temperature]} · score ${Math.round(contact.temperature_score)}`}
                style={{ display: 'inline-flex', alignItems: 'center', gap: 4, flexShrink: 0 }}
              >
                <TempDot temperature={contact.temperature} size={7} />
                <span style={{ font: '600 9px/1 Inter', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--muted-2)' }}>
                  {TEMP_LABEL[contact.temperature]}
                </span>
              </span>
            )}
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 7,
              font: '500 11px/1 Inter',
              color: 'var(--muted-2)',
            }}
          >
            <span>{formatPhone(counterparty ?? '')}</span>
            {counterZone && (
              <>
                <span style={{ color: 'var(--dark-3)' }}>·</span>
                <span>
                  {place ? `${place} ` : ''}
                  {tzTime(counterZone, now)}
                  {place ? '' : ' local'}
                </span>
              </>
            )}
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 5 }}>
          <span style={{ font: '600 17px/1 Inter', color: '#fff' }}>{duration(elapsed)}</span>
          <span
            style={{
              font: '600 9px/1 Inter',
              letterSpacing: '0.12em',
              textTransform: 'uppercase',
              color: 'var(--accent-light)',
            }}
          >
            {phaseLabel}
          </span>
        </div>
      </div>

      {/* ── Incoming: answer or decline from here, with the lead in view ── */}
      {snapshot.incoming && !inCall && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr',
            gap: 8,
            padding: '10px 12px',
            background: 'var(--dark-1)',
            borderBottom: '1px solid var(--dark-2)',
          }}
        >
          <Button tone="green" style={{ height: 40 }} onClick={() => void dispatch({ type: 'acceptIncoming' })}>
            <Icon name="phone" size={15} />
            Answer
          </Button>
          <Button tone="red" style={{ height: 40 }} onClick={() => void dispatch({ type: 'rejectIncoming' })}>
            <HangupIcon size={15} />
            Decline
          </Button>
        </div>
      )}

      {/* ── Controls: inline 4-across grid (layout B) ─────────────────── */}
      {!(snapshot.incoming && !inCall) && (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4,1fr)',
            gap: 6,
            padding: '10px 12px',
            background: 'var(--dark-1)',
            borderBottom: '1px solid var(--dark-2)',
          }}
        >
          <ControlTile
            icon={<Icon name={snapshot.muted ? 'mic-off' : 'mic'} size={17} />}
            label={snapshot.muted ? 'Unmute' : 'Mute'}
            active={snapshot.muted}
            onClick={() => void dispatch({ type: 'toggleMute' })}
          />
          <ControlTile
            icon={<Icon name="pause" size={17} />}
            label={snapshot.onHold ? 'Resume' : 'Hold'}
            active={snapshot.onHold}
            onClick={() => void dispatch({ type: 'setHold', hold: !snapshot.onHold })}
          />
          <ControlTile
            icon={<Icon name="grid" size={17} />}
            label="Keypad"
            active={keypadOpen}
            onClick={() => {
              setKeypadOpen((v) => !v);
              setDtmf('');
            }}
          />
          <ControlTile
            icon={<Icon name="plus" size={17} />}
            label="Add call"
            disabled={!inCall}
            onClick={showTransferList}
          />
          <ControlTile
            icon={<Icon name="users" size={17} />}
            label={snapshot.merged ? 'Merged' : 'Merge'}
            active={snapshot.merged}
            disabled={guests.length === 0}
            onClick={() => void dispatch({ type: 'merge' })}
          />
          <ControlTile
            icon={<Icon name="transfer" size={17} />}
            label="Transfer"
            disabled={!inCall}
            onClick={showTransferList}
          />
          <ControlTile
            icon={<Icon name="speaker" size={17} />}
            label="Audio"
            active={audioOpen}
            onClick={() => setAudioOpen((v) => !v)}
          />
          <ControlTile
            icon={<HangupIcon size={17} />}
            label="End"
            danger
            onClick={() => void dispatch({ type: 'hangup' })}
          />
        </div>
      )}

      {audioOpen && <AudioSheet snapshot={snapshot} dispatch={dispatch} onClose={() => setAudioOpen(false)} />}

      {keypadOpen && (
        <div
          style={{
            padding: '10px 12px 12px',
            background: 'var(--ink)',
            borderBottom: '1px solid var(--dark-2)',
            display: 'flex',
            flexDirection: 'column',
            gap: 7,
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <Eyebrow>Tone dial</Eyebrow>
            <span style={{ font: '600 13px/1 Inter', letterSpacing: '0.1em', color: '#fff' }}>{dtmf}</span>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6,1fr)', gap: 5 }}>
            {KEYS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => {
                  void dispatch({ type: 'digit', digit: d });
                  setDtmf((v) => (v + d).slice(-8));
                }}
                style={{
                  height: 34,
                  borderRadius: 9,
                  border: '1px solid var(--dark-2)',
                  background: 'rgba(255,255,255,.05)',
                  color: '#fff',
                  font: '500 14px/1 Inter',
                }}
              >
                {d}
              </button>
            ))}
          </div>
        </div>
      )}

      {snapshot.error && (
        <p style={{ padding: '8px 12px', font: '500 11px/1.4 Inter', color: 'var(--red)', background: 'var(--panel)' }}>
          {snapshot.error}
        </p>
      )}

      {/* ── Tabs: the context view, plus the call's own roster ─────────── */}
      <div
        role="tablist"
        style={{
          display: 'flex',
          gap: 2,
          padding: '6px 8px 0',
          background: 'var(--panel)',
          borderBottom: '1px solid var(--line)',
        }}
      >
        {TABS.map(([id, label, icon]) => {
          const selected = tab === id;
          const count = id === 'call' && guests.length > 0 ? live.length : null;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => pickTab(id)}
              style={{
                flex: 1,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 5,
                height: 32,
                border: 'none',
                borderBottom: `2px solid ${selected ? 'var(--accent)' : 'transparent'}`,
                background: 'transparent',
                color: selected ? 'var(--text)' : 'var(--muted)',
                font: '600 11px/1 Inter',
                marginBottom: -1,
              }}
            >
              <Icon name={icon} size={13} />
              {label}
              {count !== null && (
                <span
                  style={{
                    minWidth: 15,
                    height: 15,
                    padding: '0 4px',
                    borderRadius: 5,
                    background: 'var(--accent)',
                    color: '#fff',
                    font: '700 9.5px/15px Inter',
                  }}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div className="scroll" style={{ flex: 1, padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
        {context.error && context.context && (
          <p style={{ margin: 0, font: '500 10.5px/1.4 Inter', color: 'var(--amber)' }}>
            Showing the last known context — refresh failed: {context.error}
          </p>
        )}
        {tab === 'lead' && <LeadTab state={context} now={now} />}
        {tab === 'script' && <ScriptTab ctx={context.context} callId={snapshot.callId} />}
        {tab === 'objections' && <ObjectionsTab ctx={context.context} callId={snapshot.callId} />}
        {tab === 'call' && (
          <>
            <Card>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  padding: '9px 12px',
                  borderBottom: '1px solid var(--line-soft)',
                }}
              >
                <Eyebrow>On the line</Eyebrow>
                <span style={{ font: '600 10px/1 Inter', color: 'var(--muted)' }}>{live.length}</span>
              </div>
              {live.length === 0 && (
                <p style={{ padding: 12, font: '400 11.5px/1.5 Inter', color: 'var(--muted)' }}>
                  Waiting for the room…
                </p>
              )}
              {live.map((p) => (
                <div
                  key={p.id}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    padding: '10px 12px',
                    borderBottom: '1px solid var(--line-soft)',
                  }}
                >
                  <Avatar name={p.role === 'customer' ? displayName : (p.label ?? p.address ?? '?')} size={28} />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 3, marginRight: 'auto', minWidth: 0 }}>
                    <span style={{ font: '600 12px/1 Inter' }}>
                      {p.role === 'customer' ? displayName : (p.label ?? p.address)}
                    </span>
                    <span style={{ font: '500 10px/1 Inter', color: 'var(--muted)' }}>{p.role}</span>
                  </span>
                  <StatusMarker
                    color={
                      p.state === 'joined'
                        ? 'var(--green)'
                        : p.state === 'on_hold'
                          ? 'var(--amber)'
                          : 'var(--muted-2)'
                    }
                    label={p.state === 'on_hold' ? 'On hold' : p.state}
                  />
                  {p.role !== 'agent' && (
                    <button
                      type="button"
                      aria-label="Drop"
                      onClick={() =>
                        void dispatch({
                          type: 'dropParticipant',
                          providerParticipantId: p.provider_participant_id,
                        })
                      }
                      style={{
                        width: 24,
                        height: 24,
                        borderRadius: 7,
                        border: '1px solid var(--line)',
                        background: 'var(--panel)',
                        color: 'var(--muted)',
                      }}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  )}
                </div>
              ))}
            </Card>

            <Card style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div id="transfer-list" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <Eyebrow>Transfer to</Eyebrow>
                <div style={{ display: 'flex', gap: 4, padding: 2, borderRadius: 8, background: 'var(--panel-2)' }}>
                  {(['warm', 'blind'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setMode(m)}
                      style={{
                        padding: '5px 9px',
                        borderRadius: 6,
                        border: 'none',
                        background: mode === m ? 'var(--dark-1)' : 'transparent',
                        color: mode === m ? '#fff' : 'var(--muted)',
                        font: '600 10px/1 Inter',
                      }}
                    >
                      {m === 'warm' ? 'Warm' : 'Blind'}
                    </button>
                  ))}
                </div>
              </div>

              {team.filter((m) => !m.is_self).length === 0 && (
                <p style={{ font: '400 11px/1.5 Inter', color: 'var(--muted)' }}>No teammates available.</p>
              )}

              {team
                .filter((m) => !m.is_self)
                .map((m) => (
                  <div
                    key={m.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 9,
                      padding: '8px 0',
                      borderBottom: '1px solid var(--line-soft)',
                    }}
                  >
                    <Avatar name={m.display_name} size={28} />
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 3, marginRight: 'auto', minWidth: 0 }}>
                      <span style={{ font: '600 12px/1 Inter' }}>{m.display_name}</span>
                      <span style={{ font: '500 10px/1 Inter', color: 'var(--muted)' }}>
                        {m.title ?? m.role.charAt(0).toUpperCase() + m.role.slice(1)}
                        {m.city ? ` · ${m.city}` : ''}
                      </span>
                    </span>
                    <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                      <span style={{ font: '600 11px/1 Inter' }}>{m.timezone ? tzTime(m.timezone, now) : '—'}</span>
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
                    <Button
                      tone="ghost"
                      disabled={!inCall}
                      style={{ padding: '6px 9px', font: '600 10px/1 Inter' }}
                      onClick={() => void dispatch({ type: 'addParticipant', userId: m.id, consult: true })}
                    >
                      Add
                    </Button>
                    <Button
                      tone="accent"
                      disabled={!inCall}
                      style={{ padding: '6px 9px', font: '600 10px/1 Inter' }}
                      onClick={() => void dispatch({ type: 'transfer', mode, userId: m.id })}
                    >
                      Send
                    </Button>
                  </div>
                ))}

              <p style={{ font: '400 10.5px/1.4 Inter', color: 'var(--muted-2)' }}>
                {mode === 'warm'
                  ? 'Warm transfer keeps you on the line until the teammate picks up.'
                  : 'Blind transfer hands the caller over immediately and drops you.'}
              </p>

              {mode === 'warm' && guests.length > 0 && (
                <Button tone="accent" onClick={() => void dispatch({ type: 'completeTransfer' })}>
                  <Icon name="check" size={14} />
                  Complete transfer and leave
                </Button>
              )}
            </Card>

            <Card style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
              <Eyebrow>Call notes</Eyebrow>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="Asking price, timeline, condition…"
                style={{
                  minHeight: 66,
                  resize: 'none',
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  padding: '9px 10px',
                  font: '400 12px/1.45 Inter',
                  outline: 'none',
                }}
              />
              <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                {['motivated', 'callback after 5pm local', 'do not call'].map((tag) => (
                  <Button
                    key={tag}
                    tone="ghost"
                    style={{ padding: '6px 9px', font: '600 10.5px/1 Inter' }}
                    onClick={() => setNotes((n) => `${n} [${tag}]`.trim())}
                  >
                    + {tag}
                  </Button>
                ))}
              </div>
              <p style={{ font: '400 10px/1.4 Inter', color: 'var(--muted-2)' }}>
                Notes stay in this panel for now — saving them with the call needs the notes endpoint,
                which is not wired up yet. Notes about the person go on the Lead tab and are saved.
              </p>
            </Card>
          </>
        )}
      </div>
    </div>
  );
}

/** Softphone states as copy; raw enum names are not for reps. */
const PANEL_STATUS: Record<string, string> = {
  ready: 'Connected',
  initializing: 'Connecting',
  uninitialized: 'Softphone off',
  error: 'Softphone off',
};

function PanelHeader({ status, onHold }: { status: string; onHold?: boolean }) {
  return (
    <header
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '11px 14px',
        background: 'var(--ink)',
      }}
    >
      <img src="icons/48.png" alt="" width={24} height={24} />
      <span style={{ font: '700 12px/1 Inter', color: '#fff', marginRight: 'auto' }}>
        Talkr · side panel
      </span>
      <span
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 5,
          font: '600 9px/1 Inter',
          letterSpacing: '0.12em',
          textTransform: 'uppercase',
          color: 'var(--muted-2)',
        }}
      >
        <span
          style={{
            width: 5,
            height: 5,
            background: onHold ? 'var(--amber)' : status === 'ready' ? 'var(--green)' : 'var(--amber)',
          }}
          aria-hidden
        />
        {onHold ? 'On hold' : (PANEL_STATUS[status] ?? status)}
      </span>
    </header>
  );
}
