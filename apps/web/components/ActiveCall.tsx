'use client';

/**
 * The live-call surface (design 1c centre column, and the same control set the
 * extension shows). Near-black with a blue radial glow top-right — the one
 * place in the app that goes dark, because during a call nothing else matters.
 *
 * Every control here is a real conference operation against the server
 * (docs/telephony-events.md §9); none of it is local-only state.
 *
 * "Add call" and "Transfer" open two different panels on purpose. They look
 * alike but they are opposite intents — adding brings a third party in while
 * the caller waits on hold, transferring hands the caller away and lets the
 * rep leave — and one shared panel meant a warm/blind toggle sat above an
 * "Add" button it never applied to, with nowhere at all to type a number that
 * is not a teammate. The API has taken `to_number` since day one; only this
 * surface never offered it.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Icon, HangupIcon } from './Icon';
import { Avatar, Eyebrow, Segmented } from './ui';
import { ProspectTime } from './ProspectTime';
import { useSoftphone } from '@/lib/softphone';
import { api, type ContactDto, type ParticipantDto, type TeamMemberDto } from '@/lib/api';
import { duration, formatPhone, toE164, tzTime, zoneForNumber } from '@/lib/time';

const DARK_BTN: React.CSSProperties = {
  border: '1px solid var(--dark-2)',
  background: 'rgba(255,255,255,.04)',
  color: '#e4e4e7',
  borderRadius: 11,
  font: '600 12px/1 Inter',
  padding: '11px 15px',
  cursor: 'pointer',
};

const ON: React.CSSProperties = { background: 'var(--accent)', color: '#fff' };

/** The light `FIELD` token inverted — the one text-field look inside the call hero. */
const DARK_FIELD: React.CSSProperties = {
  border: '1px solid var(--dark-2)',
  background: 'rgba(255,255,255,.05)',
  color: '#fff',
  borderRadius: 11,
  padding: '11px 13px',
  font: '500 13px/1 Inter',
  outline: 'none',
};

const PANEL: React.CSSProperties = {
  border: '1px solid var(--dark-2)',
  borderRadius: 'var(--r-card)',
};

const ROW_LINE = '1px solid #1f1f23';

/**
 * The server refuses a control with a machine code, never a sentence
 * (`ControlRefusal` in packages/core, plus the route's own 400/403/404s). A
 * rep mid-call should not have to read `nothing_to_merge`, so every code the
 * API can return is spelled out here and anything unrecognised falls back to
 * a plain apology rather than leaking the identifier onto the screen.
 */
const REFUSAL_SENTENCES: Record<string, string> = {
  call_not_active: 'That call already ended.',
  no_agent: 'You are not on this call any more.',
  no_customer: 'The caller has already dropped off.',
  nothing_to_merge: 'Nobody to merge yet — add someone first.',
  already_merged: 'Everyone is already in the same conversation.',
  already_held: 'That caller is already on hold.',
  not_held: 'Nobody is on hold right now.',
  participant_not_found: 'That person has already left the call.',
  cannot_remove_agent: 'You cannot drop yourself — use End call.',
  invalid_body: 'That does not look like a phone number. Check it and try again.',
  not_found: 'That call is no longer on the server.',
  forbidden: 'That call belongs to someone else.',
  backend_unreachable: 'Cannot reach Talkr right now — check your connection.',
};

/** Capitalise and full-stop a server sentence so it reads like everything else. */
function asSentence(text: string): string {
  const t = text.trim();
  if (!t) return '';
  const head = `${t[0]!.toUpperCase()}${t.slice(1)}`;
  return /[.!?]$/.test(head) ? head : `${head}.`;
}

/** A refusal in the rep's words. Never returns a code, however odd the input. */
function controlSentence(code: string | null, raw: string | null): string | null {
  if (!code && !raw) return null;
  const mapped = code ? REFUSAL_SENTENCES[code] : undefined;
  if (mapped) return mapped;
  // `invalid_target` is the one refusal whose message the server already wrote
  // for a person ("Dana Reyes has not enabled their softphone yet").
  if (code === 'invalid_target' && raw) return asSentence(raw);
  return 'That did not go through. Try again in a moment.';
}

/** True for the North American shapes `formatPhone` is actually written for. */
function isNanp(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

/**
 * Format for display, leaving anything non-NANP exactly as it came —
 * `formatPhone` groups 3-3-4, which silently truncates a longer country's
 * number rather than showing it wrong-but-whole.
 */
function displayNumber(raw: string): string {
  return isNanp(raw) ? formatPhone(raw) : raw;
}

/**
 * Format the dial field as the rep types. Letters mean they are searching for
 * a contact by name, and an explicit `+` means they know their own country
 * code; both are left exactly as typed.
 */
function formatAsTyped(value: string): string {
  if (/[A-Za-z]/.test(value)) return value;
  if (value.trim().startsWith('+')) return value;
  if (value.replace(/\D/g, '').length > 11) return value;
  return formatPhone(value);
}

/** The number to dial for a contact, primary first. */
function contactNumber(c: ContactDto): string | null {
  return (
    c.primary_phone ??
    c.phones.find((p) => p.is_primary)?.phone_e164 ??
    c.phones[0]?.phone_e164 ??
    null
  );
}

/** A party's name, or their number formatted when the label *is* a number. */
function partyName(p: ParticipantDto): string {
  const raw = p.label ?? p.address ?? '';
  return displayNumber(raw) || 'Unknown';
}

const ROLE_LABELS: Record<ParticipantDto['role'], string> = {
  agent: 'You',
  customer: 'Caller',
  teammate: 'Teammate',
  external: 'Added number',
};

const STATE_LABELS: Record<ParticipantDto['state'], string> = {
  ringing: 'Ringing',
  joined: 'Connected',
  on_hold: 'On hold',
  left: 'Left',
};

const STATE_COLORS: Record<ParticipantDto['state'], string> = {
  ringing: 'var(--amber)',
  joined: 'var(--green)',
  on_hold: 'var(--amber)',
  left: 'var(--muted-2)',
};

function presenceColor(presence: string): string {
  if (presence === 'available') return 'var(--green)';
  if (presence === 'away') return 'var(--amber)';
  return 'var(--muted-2)';
}

/** A ring that turns while a leg is still dialling. Global CSS stills it under prefers-reduced-motion. */
function RingingSpinner({ size = 11 }: { size?: number }) {
  return (
    <span
      className="inline-block animate-spin"
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        border: '2px solid rgba(255,255,255,.2)',
        borderTopColor: 'var(--amber)',
      }}
      aria-hidden
    />
  );
}

function ControlButton({
  icon,
  label,
  active,
  onClick,
  disabled,
  disabledReason,
}: {
  icon: React.ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  /** Why the control is unavailable. Shown on hover — never a silent dead button. */
  disabledReason?: string;
}) {
  const button = (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      title={disabled ? disabledReason : undefined}
      className="inline-flex items-center gap-2 disabled:opacity-40"
      style={{ ...DARK_BTN, ...(active ? ON : {}) }}
    >
      {icon}
      {label}
    </button>
  );
  // A disabled button swallows its own pointer events in several browsers, so
  // the reason hangs on a wrapper the cursor can still reach.
  return disabled && disabledReason ? (
    <span className="inline-flex" title={disabledReason}>
      {button}
    </span>
  ) : (
    button
  );
}

/** One teammate, with whatever action the surrounding panel offers. */
function TeammateRow({
  member,
  now,
  children,
}: {
  member: TeamMemberDto;
  now: number | null;
  children: React.ReactNode;
}) {
  return (
    <div
      className="flex flex-wrap items-center gap-2.5 py-2"
      style={{ borderBottom: '1px solid var(--dark-2)' }}
    >
      <Avatar name={member.display_name} size={28} dark />
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="truncate" style={{ font: '600 12px/1 Inter', color: '#fff' }}>
          {member.display_name}
        </span>
        <span className="truncate" style={{ font: '500 10px/1 Inter', color: 'var(--muted)' }}>
          {member.role}
          {member.city ? ` · ${member.city}` : ''}
        </span>
      </span>
      <span className="flex flex-col items-end gap-1">
        <span style={{ font: '600 11px/1 Inter', color: '#e4e4e7' }}>
          {member.timezone && now !== null ? tzTime(member.timezone, now) : '—'}
        </span>
        <span
          className="inline-flex items-center gap-1"
          style={{ font: '600 9px/1 Inter', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--muted)' }}
        >
          <span
            style={{ width: 5, height: 5, background: presenceColor(member.presence) }}
            aria-hidden
          />
          {member.presence}
        </span>
      </span>
      {children}
    </div>
  );
}

/** Hairline rule with a caption, splitting the two ways to pick someone. */
function Divider({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2.5">
      <span className="flex-1" style={{ height: 1, background: 'var(--dark-2)' }} aria-hidden />
      <Eyebrow>{label}</Eyebrow>
      <span className="flex-1" style={{ height: 1, background: 'var(--dark-2)' }} aria-hidden />
    </div>
  );
}

type Panel = 'none' | 'add' | 'transfer';

export function ActiveCall({ team }: { team: TeamMemberDto[] }) {
  const {
    active,
    callState,
    serverStatus,
    participants,
    onHold,
    merged,
    controlError,
    controlErrorCode,
    hangup,
    toggleMute,
    toggleHold,
    sendDigit,
    addParticipant,
    merge,
    dropParticipant,
    transfer,
    completeTransfer,
    audioDevices,
    activeAudioDeviceId,
    selectAudioDevice,
  } = useSoftphone();

  const [elapsed, setElapsed] = useState(0);
  const [keypadOpen, setKeypadOpen] = useState(false);
  const [dtmf, setDtmf] = useState('');
  const [panel, setPanel] = useState<Panel>('none');
  const [mode, setMode] = useState<'warm' | 'blind'>('warm');
  const [now, setNow] = useState<number | null>(null);

  // ── The Add-call number field ─────────────────────────────────────────────
  const [target, setTarget] = useState('');
  const [matches, setMatches] = useState<ContactDto[]>([]);
  /** The value a contact row just filled in, so the search does not re-open on it. */
  const [picked, setPicked] = useState<string | null>(null);
  const [dialing, setDialing] = useState(false);
  const targetRef = useRef<HTMLInputElement>(null);

  const startedAt = active?.startedAt ?? null;
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => {
      setNow(Date.now());
      // A held call is still connected; the timer keeps running, as it does on
      // every phone the rep has ever used.
      if (startedAt) setElapsed(Math.floor((Date.now() - startedAt) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [startedAt]);

  /**
   * Contact lookup for the number field. Debounced, and deliberately
   * best-effort: a failed search leaves `matches` empty so plain number entry
   * still works, which is the whole point of the field.
   */
  useEffect(() => {
    const q = target.trim();
    if (panel !== 'add' || q.length < 3 || q === picked) {
      setMatches([]);
      return;
    }
    let cancelled = false;
    const t = setTimeout(() => {
      api
        .listContacts({ q, limit: 6, has_phone: true })
        .then((res) => {
          if (!cancelled) setMatches(res.contacts.filter((c) => contactNumber(c) !== null));
        })
        .catch(() => {
          if (!cancelled) setMatches([]);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [target, panel, picked]);

  const live = useMemo(() => participants.filter((p) => p.state !== 'left'), [participants]);
  const guests = useMemo(
    () => live.filter((p) => p.role === 'teammate' || p.role === 'external'),
    [live],
  );

  const looksLikeName = /[A-Za-z]/.test(target);
  const e164 = looksLikeName ? '' : toE164(target);
  const targetValid = /^\+\d{8,15}$/.test(e164);
  const alreadyOnCall = targetValid && live.some((p) => p.address === e164);

  const addExternal = useCallback(async () => {
    if (!targetValid || dialing || alreadyOnCall) return;
    setDialing(true);
    try {
      // consult: true is what "add call" means — the caller goes on hold while
      // the new leg rings, and Merge brings everyone together afterwards.
      await addParticipant({ to_number: e164, consult: true });
    } finally {
      setDialing(false);
    }
  }, [targetValid, dialing, alreadyOnCall, addParticipant, e164]);

  const fillFromContact = useCallback((number: string) => {
    const filled = isNanp(number) ? formatPhone(number) : number;
    setTarget(filled);
    setPicked(filled);
    setMatches([]);
    targetRef.current?.focus();
  }, []);

  if (!active) return null;

  const counterparty =
    active.record.direction === 'outbound' ? active.record.to_number : active.record.from_number;
  const hasZone = zoneForNumber(counterparty) !== null;
  const inCall = callState === 'in_call';
  const transferPending = guests.length > 0 && live.some((p) => p.role === 'agent');
  const canMergeNow = !merged && guests.some((p) => p.state === 'joined');
  const message = controlSentence(controlErrorCode, controlError);
  const teammates = team.filter((m) => !m.is_self);

  const notInCallReason =
    callState === 'connecting' || callState === 'ringing'
      ? 'Wait until the call connects.'
      : 'Only while a call is in progress.';
  const mergeReason = !inCall
    ? notInCallReason
    : guests.length === 0
      ? 'Add someone first — there is nobody to merge yet.'
      : merged
        ? 'Everyone is already together.'
        : undefined;
  const addReason = alreadyOnCall
    ? 'That number is already on this call.'
    : looksLikeName
      ? 'Pick a contact below, or type their number.'
      : !targetValid
        ? 'Enter a full phone number first.'
        : undefined;

  return (
    <section
      className="relative overflow-hidden p-5"
      style={{ borderRadius: 'var(--r-lg)', background: 'var(--ink)' }}
      aria-label="Active call"
    >
      <div
        className="pointer-events-none absolute"
        style={{
          top: -90,
          right: -60,
          width: 320,
          height: 320,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(255,35,59,.40), rgba(255,35,59,0) 70%)',
        }}
        aria-hidden
      />

      <div className="relative flex flex-wrap items-start gap-4">
        <Avatar name={active.record.lead_id ? 'Seller Lead' : formatPhone(counterparty)} size={64} dark />
        <div className="mr-auto flex flex-col gap-1.5">
          <div className="flex items-center gap-2.5">
            <span
              style={{
                font: '600 9px/1 Inter',
                letterSpacing: '0.14em',
                textTransform: 'uppercase',
                color: 'var(--accent-light)',
              }}
            >
              {onHold ? 'On hold' : (serverStatus ?? callState).replace(/_/g, ' ')}
            </span>
            {active.record.lead_id && (
              <span
                style={{
                  padding: '3px 7px',
                  borderRadius: 6,
                  background: 'var(--orange)',
                  color: '#fff',
                  font: '700 9px/1 Inter',
                  letterSpacing: '0.1em',
                  textTransform: 'uppercase',
                }}
              >
                Seller lead
              </span>
            )}
          </div>
          <div className="display" style={{ font: '600 26px/1 Inter', color: '#fff' }}>
            {formatPhone(counterparty)}
          </div>
          <div
            className="flex flex-wrap items-center gap-x-2.5 gap-y-1"
            style={{ font: '500 12px/1 Inter', color: 'var(--muted-2)' }}
          >
            {/* The seller's clock, not ours — the single most useful thing on
                this surface after the number itself. Nothing renders when the
                area code does not map to a zone. */}
            {hasZone && (
              <>
                <ProspectTime e164={counterparty} tone="dark" now={now} size={12} />
                <span style={{ color: 'var(--dark-3)' }}>·</span>
              </>
            )}
            <span className="inline-flex items-center gap-1.5">
              <Icon name="pin" size={12} style={{ color: 'var(--accent-light)' }} />
              from {formatPhone(active.record.from_number)}
            </span>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <span className="display" style={{ font: '600 30px/1 Inter', color: '#fff' }}>
            {duration(elapsed)}
          </span>
          <Eyebrow>{audioDevices.find((d) => d.deviceId === activeAudioDeviceId)?.label ?? 'Default audio'}</Eyebrow>
        </div>
      </div>

      <div className="relative flex flex-wrap gap-2 pt-5">
        <ControlButton
          icon={<Icon name={active.muted ? 'mic-off' : 'mic'} size={16} />}
          label={active.muted ? 'Unmute' : 'Mute'}
          active={active.muted}
          onClick={toggleMute}
        />
        <ControlButton
          icon={<Icon name="pause" size={16} />}
          label={onHold ? 'Resume' : 'Hold'}
          active={onHold}
          onClick={() => void toggleHold()}
        />
        <ControlButton
          icon={<Icon name="grid" size={16} />}
          label="Keypad"
          active={keypadOpen}
          onClick={() => {
            setKeypadOpen((v) => !v);
            setDtmf('');
          }}
        />
        <ControlButton
          icon={<Icon name="plus" size={16} />}
          label="Add call"
          active={panel === 'add'}
          onClick={() => setPanel((p) => (p === 'add' ? 'none' : 'add'))}
          disabled={!inCall}
          disabledReason={notInCallReason}
        />
        <ControlButton
          icon={<Icon name="users" size={16} />}
          label={merged ? 'Merged' : 'Merge'}
          active={merged}
          onClick={() => void merge()}
          disabled={Boolean(mergeReason)}
          disabledReason={mergeReason}
        />
        <ControlButton
          icon={<Icon name="transfer" size={16} />}
          label="Transfer"
          active={panel === 'transfer'}
          onClick={() => setPanel((p) => (p === 'transfer' ? 'none' : 'transfer'))}
          disabled={!inCall}
          disabledReason={notInCallReason}
        />
        <ControlButton
          icon={<Icon name="speaker" size={16} />}
          label="Audio"
          onClick={() => {
            // Cycle rather than open a menu: one control, one thumb.
            if (audioDevices.length === 0) return;
            const i = audioDevices.findIndex((d) => d.deviceId === activeAudioDeviceId);
            void selectAudioDevice(audioDevices[(i + 1) % audioDevices.length]!.deviceId);
          }}
          disabled={audioDevices.length === 0}
          disabledReason="No speaker to switch to."
        />
        <button
          type="button"
          onClick={hangup}
          className="ml-auto inline-flex items-center gap-2"
          style={{ ...DARK_BTN, background: 'var(--red)', border: 'none', color: '#fff', padding: '11px 18px' }}
        >
          <HangupIcon size={16} />
          End call
        </button>
      </div>

      {/* When a panel is open the refusal belongs next to the control that caused it. */}
      {message && panel === 'none' && (
        <p className="relative pt-3" role="status" style={{ font: '500 11px/1.4 Inter', color: '#fca5a5' }}>
          {message}
        </p>
      )}

      {keypadOpen && (
        <div className="relative mt-4 flex flex-wrap items-center gap-3.5 p-3.5" style={PANEL}>
          <Eyebrow>Tone dial</Eyebrow>
          <div className="flex flex-wrap gap-1.5">
            {['1', '2', '3', '4', '5', '6', '7', '8', '9', '*', '0', '#'].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => {
                  sendDigit(d);
                  setDtmf((v) => (v + d).slice(-8));
                }}
                style={{
                  width: 42,
                  height: 38,
                  borderRadius: 9,
                  border: '1px solid var(--dark-2)',
                  background: 'rgba(255,255,255,.05)',
                  color: '#fff',
                  font: '500 15px/1 Inter',
                  cursor: 'pointer',
                }}
              >
                {d}
              </button>
            ))}
          </div>
          <span className="ml-auto" style={{ font: '600 15px/1 Inter', letterSpacing: '0.12em', color: '#fff' }}>
            {dtmf}
          </span>
        </div>
      )}

      {panel === 'add' && (
        <div className="relative mt-4 flex flex-col gap-3 p-3.5" style={PANEL}>
          <div className="flex items-center justify-between gap-2">
            <Eyebrow>Add someone to this call</Eyebrow>
            <button
              type="button"
              onClick={() => setPanel('none')}
              aria-label="Close"
              style={{ ...DARK_BTN, padding: 7 }}
            >
              <Icon name="x" size={13} />
            </button>
          </div>

          <p style={{ font: '400 10.5px/1.4 Inter', color: 'var(--muted)' }}>
            The caller goes on hold while we ring whoever you pick. Merge when you want everyone to
            hear each other.
          </p>

          {message && (
            <p role="status" style={{ font: '500 11px/1.4 Inter', color: '#fca5a5' }}>
              {message}
            </p>
          )}

          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void addExternal();
            }}
          >
            <input
              ref={targetRef}
              value={target}
              onChange={(e) => setTarget(formatAsTyped(e.target.value))}
              onKeyDown={(e) => {
                // Explicit rather than the form's implicit submission, which a
                // browser suppresses whenever the submit button is disabled.
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void addExternal();
                }
              }}
              inputMode="tel"
              autoComplete="off"
              spellCheck={false}
              placeholder="Type a number, or search a contact"
              aria-label="Number to add to this call"
              className="min-w-0 flex-1"
              style={{ ...DARK_FIELD, flexBasis: 170 }}
            />
            <button
              type="submit"
              disabled={!targetValid || dialing || alreadyOnCall}
              title={addReason}
              className="inline-flex items-center gap-2 disabled:opacity-40"
              style={{ ...DARK_BTN, ...(targetValid && !alreadyOnCall ? ON : {}) }}
            >
              {dialing ? <RingingSpinner /> : <Icon name="plus" size={14} />}
              {dialing ? 'Dialling' : 'Add'}
            </button>
          </form>

          {matches.length > 0 && (
            <div className="flex flex-col overflow-hidden" style={{ border: '1px solid var(--dark-2)', borderRadius: 11 }}>
              {matches.map((c, i) => {
                const number = contactNumber(c)!;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => fillFromContact(number)}
                    className="lift-row on-dark flex w-full items-center gap-2.5 px-2.5 py-2 text-left"
                    // No inline `background` here: an inline value would beat
                    // the .lift-row hover rule, and the row would never light up.
                    style={{
                      border: 'none',
                      borderBottom: i === matches.length - 1 ? 'none' : ROW_LINE,
                      cursor: 'pointer',
                    }}
                  >
                    <Avatar name={c.display_name} size={22} dark />
                    <span className="min-w-0 flex-1 truncate" style={{ font: '600 11.5px/1 Inter', color: '#fff' }}>
                      {c.display_name}
                    </span>
                    <span style={{ font: '500 11px/1 Inter', color: 'var(--muted-2)' }}>
                      {displayNumber(number)}
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          <Divider label="or a teammate" />

          {teammates.length === 0 ? (
            /* Deliberately plain text, not the shared EmptyState: this sits on
               the near-black call hero, where that component's light panel-2
               glyph tile would read as a hole punched in the card. */
            <p style={{ font: '400 11px/1.4 Inter', color: 'var(--muted)' }}>
              No teammates yet — type a number above instead.
            </p>
          ) : (
            <div className="max-h-56 overflow-auto">
              {teammates.map((m) => {
                const on = live.some((p) => p.user_id === m.id);
                return (
                  <TeammateRow key={m.id} member={m} now={now}>
                    <button
                      type="button"
                      onClick={() => void addParticipant({ user_id: m.id, consult: true })}
                      disabled={on}
                      title={on ? 'They are already on this call.' : undefined}
                      className="disabled:opacity-40"
                      style={{ ...DARK_BTN, ...(on ? {} : ON), padding: '7px 12px', font: '600 10.5px/1 Inter' }}
                    >
                      {on ? 'On the call' : 'Add'}
                    </button>
                  </TeammateRow>
                );
              })}
            </div>
          )}
        </div>
      )}

      {panel === 'transfer' && (
        <div className="relative mt-4 flex flex-col gap-2.5 p-3.5" style={PANEL}>
          <div className="flex items-center justify-between gap-2">
            <Eyebrow>Transfer this call</Eyebrow>
            <div className="flex items-center gap-2">
              <Segmented
                value={mode}
                onChange={setMode}
                options={[
                  { value: 'warm', label: 'Warm' },
                  { value: 'blind', label: 'Blind' },
                ]}
              />
              <button
                type="button"
                onClick={() => setPanel('none')}
                aria-label="Close"
                style={{ ...DARK_BTN, padding: 7 }}
              >
                <Icon name="x" size={13} />
              </button>
            </div>
          </div>

          <p style={{ font: '400 10.5px/1.4 Inter', color: 'var(--muted)' }}>
            {mode === 'warm'
              ? 'Warm keeps you on the line until the teammate picks up.'
              : 'Blind hands the caller over immediately and drops you.'}
          </p>

          {message && (
            <p role="status" style={{ font: '500 11px/1.4 Inter', color: '#fca5a5' }}>
              {message}
            </p>
          )}

          {teammates.length === 0 && (
            <p style={{ font: '400 11px/1.4 Inter', color: 'var(--muted)' }}>No teammates to transfer to.</p>
          )}

          <div className="max-h-56 overflow-auto">
            {teammates.map((m) => (
              <TeammateRow key={m.id} member={m} now={now}>
                <button
                  type="button"
                  onClick={() => {
                    void transfer({ mode, user_id: m.id });
                    setPanel('none');
                  }}
                  style={{ ...DARK_BTN, ...ON, padding: '7px 12px', font: '600 10.5px/1 Inter' }}
                >
                  Transfer
                </button>
              </TeammateRow>
            ))}
          </div>

          {transferPending && mode === 'warm' && (
            <button
              type="button"
              onClick={() => void completeTransfer()}
              className="inline-flex items-center gap-2"
              style={{ ...DARK_BTN, ...ON, alignSelf: 'flex-start' }}
            >
              <Icon name="check" size={14} />
              Complete transfer and leave
            </button>
          )}
        </div>
      )}

      {live.length > 0 && (
        <div className="relative mt-4 overflow-hidden" style={PANEL}>
          <div className="px-3 py-2" style={{ borderBottom: '1px solid var(--dark-2)' }}>
            <Eyebrow>On the line · {live.length}</Eyebrow>
          </div>
          {live.map((p) => {
            const ringing = p.state === 'ringing';
            return (
              <div key={p.id} className="flex flex-wrap items-center gap-2.5 px-3 py-2" style={{ borderBottom: ROW_LINE }}>
                <Avatar name={partyName(p)} size={24} dark />
                <span className="flex min-w-0 flex-1 flex-col gap-1">
                  <span className="truncate" style={{ font: '600 12px/1 Inter', color: '#fff' }}>
                    {partyName(p)}
                  </span>
                  <span style={{ font: '500 10px/1 Inter', color: 'var(--muted)' }}>{ROLE_LABELS[p.role]}</span>
                </span>
                <span
                  className="inline-flex items-center gap-1.5"
                  style={{ font: '600 9px/1 Inter', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--muted)' }}
                >
                  {ringing ? (
                    <RingingSpinner />
                  ) : (
                    <span style={{ width: 5, height: 5, background: STATE_COLORS[p.state] }} aria-hidden />
                  )}
                  {STATE_LABELS[p.state]}
                </span>
                {p.role !== 'agent' &&
                  (ringing ? (
                    <button
                      type="button"
                      onClick={() => void dropParticipant(p.provider_participant_id)}
                      title={`Stop ringing ${partyName(p)}`}
                      style={{ ...DARK_BTN, padding: '6px 10px', font: '600 10.5px/1 Inter' }}
                    >
                      Cancel
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => void dropParticipant(p.provider_participant_id)}
                      aria-label={`Drop ${partyName(p)}`}
                      title={`Drop ${partyName(p)}`}
                      style={{ ...DARK_BTN, padding: 5 }}
                    >
                      <Icon name="x" size={12} />
                    </button>
                  ))}
              </div>
            );
          })}

          {canMergeNow && (
            <div
              className="flex flex-wrap items-center gap-2.5 px-3 py-2.5"
              style={{ background: 'rgba(255,255,255,.03)' }}
            >
              <span
                className="min-w-0"
                style={{ flex: '1 1 190px', font: '500 11px/1.4 Inter', color: 'var(--muted-2)' }}
              >
                {onHold
                  ? 'The caller is on hold and cannot hear you yet.'
                  : 'They are connected but not in the same room as the caller.'}
              </span>
              <button
                type="button"
                onClick={() => void merge()}
                className="inline-flex items-center gap-2"
                style={{ ...DARK_BTN, ...ON }}
              >
                <Icon name="users" size={14} />
                Bring everyone together
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
