'use client';

/**
 * Settings (design 1c): your working zone, number forwarding, the dialing
 * windows every lead's local time is judged against, and the SMS templates.
 *
 * What is here is what the platform can actually honour today. Local-presence
 * caller ID and per-number business hours are called out as not-yet-built
 * rather than shown as controls that would quietly do nothing.
 */

import { useCallback, useEffect, useState, type CSSProperties } from 'react';
import { api, type HoldMusicDto, type MeDto, type MessageTemplateDto, type PhoneNumberDto } from '@/lib/api';
import { useSoftphone, type AudioDevice, type MicPermission } from '@/lib/softphone';
import { TopBar } from '@/components/TopBar';
import { Icon } from '@/components/Icon';
import { Button, Card, EmptyState, Eyebrow, StatusMarker, Toggle } from '@/components/ui';
import { playSound, setSoundsEnabled, soundsEnabled, type SoundName } from '@/lib/sounds';
import { CallerIdPicker } from '@/components/CallerIdPicker';
import { TemplateManager, canManageTemplates } from '@/components/MessageTemplates';
import { PhoneText } from '@/components/CopyPhone';
import { SAFE_WINDOW, callWindow, localZone, tzTime } from '@/lib/time';

/** PATCH /v1/numbers takes numbers.manage (admins and owners). */
const canManageNumbers = (role?: string | null) => role === 'owner' || role === 'admin';

/** Same field styling as the time-zone select below. */
const FIELD: CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-btn)',
  padding: '9px 11px',
  font: '500 12.5px/1 Inter',
  background: 'var(--panel)',
};

const HELP: CSSProperties = { font: '400 10.5px/1.4 Inter', color: 'var(--muted-2)' };

const PERMISSION: Record<MicPermission, { color: string; label: string }> = {
  granted: { color: 'var(--green)', label: 'Allowed' },
  denied: { color: 'var(--red)', label: 'Blocked' },
  prompt: { color: 'var(--amber)', label: 'Not asked' },
  unknown: { color: 'var(--muted-2)', label: 'Unknown' },
};

/** Device picker: a "System default" row only when the browser does not list one itself. */
function DeviceSelect({
  devices,
  value,
  onChange,
  disabled,
  label,
  className = 'w-full',
}: {
  devices: AudioDevice[];
  value: string | null;
  onChange: (deviceId: string) => void;
  disabled?: boolean;
  label: string;
  className?: string;
}) {
  const hasDefault = devices.some((d) => d.deviceId === 'default');
  return (
    <select
      value={value ?? ''}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-label={label}
      className={`outline-none disabled:cursor-not-allowed disabled:opacity-45 ${className}`}
      style={FIELD}
    >
      {!hasDefault && <option value="">System default</option>}
      {devices.map((d, i) => (
        <option key={`${d.deviceId}-${i}`} value={d.deviceId}>
          {d.label}
        </option>
      ))}
    </select>
  );
}

/**
 * Audio devices: mic, speaker and ringtone routing with a live level meter.
 * First in the grid because a rep with the wrong headset selected cannot work
 * at all. Everything here is per browser — the SDK owns the routing and the
 * choice is remembered in localStorage, never on the server.
 */
function AudioCard() {
  const {
    deviceState,
    deviceError,
    initDevice,
    micPermission,
    requestMicPermission,
    inputDevices,
    outputDevices,
    activeInputDeviceId,
    activeOutputDeviceId,
    activeRingtoneDeviceId,
    outputSelectionSupported,
    selectInputDevice,
    selectOutputDevice,
    selectRingtoneDevice,
    testSpeaker,
    testRingtone,
    inputLevel,
    startMicMeter,
    stopMicMeter,
  } = useSoftphone();
  const [testing, setTesting] = useState<'speaker' | 'ringtone' | null>(null);
  const [testError, setTestError] = useState<string | null>(null);
  const ready = deviceState === 'ready';

  // The local meter opens the chosen mic only while this card is on screen
  // and only once the browser has already said yes — never a surprise prompt.
  useEffect(() => {
    if (!ready || micPermission !== 'granted') return;
    void startMicMeter(activeInputDeviceId);
    return () => stopMicMeter();
  }, [ready, micPermission, activeInputDeviceId, startMicMeter, stopMicMeter]);

  async function runTest(kind: 'speaker' | 'ringtone') {
    setTestError(null);
    setTesting(kind);
    try {
      await (kind === 'speaker' ? testSpeaker() : testRingtone());
    } catch (e) {
      setTestError(e instanceof Error ? e.message : 'Could not play the test sound');
    } finally {
      setTesting(null);
    }
  }

  const permission = PERMISSION[micPermission];

  return (
    <Card className="flex flex-col gap-3.5">
      <div className="flex items-center gap-2.5">
        <Icon name="speaker" size={16} style={{ color: 'var(--accent)' }} />
        <span className="mr-auto" style={{ font: '700 13.5px/1 Inter' }}>Audio</span>
        {ready && <StatusMarker color={permission.color} label={`Mic ${permission.label}`} />}
      </div>

      {!ready ? (
        <>
          <p style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>
            Enable the softphone to manage audio devices. The microphone, speaker and ringtone
            pickers, the level meter and the test sounds all need the phone engine running.
          </p>
          <div>
            <Button tone="accent" onClick={() => void initDevice()} disabled={deviceState === 'initializing'}>
              {deviceState === 'initializing' ? 'Enabling…' : 'Enable softphone'}
            </Button>
          </div>
          {deviceError && <p style={{ font: '400 11px/1.4 Inter', color: 'var(--red)' }}>{deviceError}</p>}
        </>
      ) : (
        <>
          {/* ── Permission ─────────────────────────────────────────────── */}
          <div className="flex flex-col gap-1.5">
            <Eyebrow>Microphone access</Eyebrow>
            <div className="flex flex-wrap items-center gap-2.5">
              <StatusMarker color={permission.color} label={permission.label} />
              {micPermission !== 'granted' && (
                <Button
                  tone="ghost"
                  style={{ padding: '7px 10px', font: '600 11px/1 Inter' }}
                  onClick={() => void requestMicPermission()}
                >
                  <Icon name="mic" size={12} />
                  Allow microphone
                </Button>
              )}
            </div>
            {micPermission === 'denied' && (
              <span style={{ ...HELP, color: 'var(--red)' }}>
                Blocked by the browser: click the lock icon in the address bar → Site settings →
                Microphone → Allow, then reload this page.
              </span>
            )}
            {deviceError && micPermission !== 'denied' && (
              <span style={{ ...HELP, color: 'var(--red)' }}>{deviceError}</span>
            )}
          </div>

          {/* ── Microphone ─────────────────────────────────────────────── */}
          <div className="flex flex-col gap-1.5">
            <Eyebrow>Microphone</Eyebrow>
            <DeviceSelect
              label="Microphone"
              devices={inputDevices}
              value={activeInputDeviceId}
              onChange={(id) => void selectInputDevice(id)}
            />
            <span
              role="meter"
              aria-label="Microphone level"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(inputLevel * 100)}
              className="block overflow-hidden"
              style={{ height: 4, borderRadius: 2, background: 'var(--panel-2)' }}
            >
              <span
                className="block h-full"
                style={{
                  width: `${Math.round(inputLevel * 100)}%`,
                  background: 'var(--green)',
                  transition: 'width 90ms linear',
                }}
              />
            </span>
            <span style={HELP}>
              {micPermission === 'granted'
                ? 'Say something — the bar should move. Applied when your next call starts; switches live on a call.'
                : 'Allow the microphone to see the level meter and device names.'}
            </span>
          </div>

          {/* ── Speaker ────────────────────────────────────────────────── */}
          <div className="flex flex-col gap-1.5">
            <Eyebrow>Speaker</Eyebrow>
            <div className="flex gap-1.5">
              <DeviceSelect
                label="Speaker"
                devices={outputDevices}
                value={activeOutputDeviceId}
                onChange={(id) => void selectOutputDevice(id)}
                disabled={!outputSelectionSupported}
                className="min-w-0 flex-1"
              />
              <Button
                tone="ghost"
                className="shrink-0"
                disabled={!outputSelectionSupported || testing !== null}
                onClick={() => void runTest('speaker')}
              >
                <Icon name="play" size={12} />
                {testing === 'speaker' ? 'Playing…' : 'Play test sound'}
              </Button>
            </div>
            <span style={HELP}>
              {outputSelectionSupported
                ? 'Where you hear the caller.'
                : 'This browser cannot choose an output device; call audio follows the system default. Use Chrome or Edge to pick a speaker.'}
            </span>
          </div>

          {/* ── Ringtone ───────────────────────────────────────────────── */}
          <div className="flex flex-col gap-1.5">
            <Eyebrow>Ringtone device</Eyebrow>
            <div className="flex gap-1.5">
              <DeviceSelect
                label="Ringtone device"
                devices={outputDevices}
                value={activeRingtoneDeviceId}
                onChange={(id) => void selectRingtoneDevice(id)}
                disabled={!outputSelectionSupported}
                className="min-w-0 flex-1"
              />
              <Button
                tone="ghost"
                className="shrink-0"
                disabled={!outputSelectionSupported || testing !== null}
                onClick={() => void runTest('ringtone')}
              >
                <Icon name="phone" size={12} />
                {testing === 'ringtone' ? 'Ringing…' : 'Test ring'}
              </Button>
            </div>
            <span style={HELP}>
              Where incoming calls ring — pick your desk speakers so you hear calls with the
              headset off.
            </span>
          </div>

          {testError && <p style={{ font: '400 11px/1.4 Inter', color: 'var(--red)' }}>{testError}</p>}

          <p style={HELP}>Saved in this browser only.</p>
        </>
      )}
    </Card>
  );
}

/**
 * Call sounds. Synthesized in the browser (lib/sounds.ts) — nothing to
 * download, nothing to configure beyond on or off. Per browser, like the
 * device choices above it, because "on" is a property of where the rep sits.
 */
function SoundsCard() {
  // `true` on the first render on purpose: the server cannot read localStorage,
  // and a toggle that flips after hydration is a mismatch. The real value
  // lands in the effect below, before anyone can click it.
  const [on, setOn] = useState(true);
  useEffect(() => setOn(soundsEnabled()), []);

  const change = (next: boolean) => {
    setOn(next);
    setSoundsEnabled(next);
    // Confirm the choice with the thing being chosen.
    if (next) playSound('connected');
  };

  return (
    <Card className="flex flex-col gap-3.5">
      <div className="flex items-center gap-2.5">
        <Icon name="speaker" size={16} style={{ color: 'var(--accent)' }} />
        <span className="mr-auto" style={{ font: '700 13.5px/1 Inter' }}>Sounds</span>
        <Toggle on={on} onChange={change} label="Call sounds" />
      </div>
      <p style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>
        Short tones for the moments you should not have to look up for: a call
        connecting, a call ending, an appointment booked, and a text arriving
        while Talkr is open.
      </p>

      <div className="flex flex-col gap-1.5">
        <Eyebrow>Preview</Eyebrow>
        <div className="flex flex-wrap gap-1.5">
          {SOUND_PREVIEWS.map(([name, label]) => (
            <Button
              key={name}
              tone="ghost"
              disabled={!on}
              title={on ? `Play the ${label.toLowerCase()} sound` : 'Turn sounds on to preview them'}
              onClick={() => playSound(name)}
              style={{ padding: '7px 10px', font: '600 11px/1 Inter' }}
            >
              <Icon name="play" size={11} />
              {label}
            </Button>
          ))}
        </div>
      </div>

      <p style={HELP}>
        Saved in this browser only. They play through your system output, not
        the call speaker chosen above.
      </p>
    </Card>
  );
}

const SOUND_PREVIEWS: Array<[SoundName, string]> = [
  ['connected', 'Connected'],
  ['ended', 'Ended'],
  ['appointment', 'Appointment'],
  ['messageIn', 'Text in'],
];

// ─── Hold music (docs/telephony-events.md §9.7) ─────────────────────────────
// Admin-only: the endpoint behind it is `admin.users`-gated, so a rep who
// somehow reached this card would only get a 403. It is not rendered for them.

const HOLD_MUSIC_CHOICES: Array<{ mode: HoldMusicDto['mode']; label: string; help: string }> = [
  { mode: 'default', label: 'Default', help: "The carrier's own hold music." },
  { mode: 'silence', label: 'Silence', help: 'Nothing at all until the seller picks up.' },
  { mode: 'url', label: 'Custom URL', help: 'Your own audio file (MP3 or WAV) or TwiML.' },
];

/**
 * What a party alone in the room hears — the rep for the second or two before
 * the seller's phone is answered, and the seller while they are on hold.
 */
function HoldMusicCard() {
  const [setting, setSetting] = useState<HoldMusicDto | null>(null);
  const [mode, setMode] = useState<HoldMusicDto['mode']>('default');
  const [url, setUrl] = useState('');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .getOrgSettings()
      .then((r) => {
        setSetting(r.hold_music);
        setMode(r.hold_music.mode);
        setUrl(r.hold_music.url ?? '');
      })
      .catch((e) => setError((e as Error).message));
  }, []);

  const dirty = setting !== null && (mode !== setting.mode || (mode === 'url' && url !== (setting.url ?? '')));

  async function save() {
    setError(null);
    setSaved(false);
    setSaving(true);
    try {
      // The server is the authority on what plays: an unreachable URL is
      // refused here, at save time, rather than becoming dead air on a call.
      const r = await api.updateOrgSettings({
        hold_music: mode === 'url' ? { mode, url: url.trim() } : { mode },
      });
      setSetting(r.hold_music);
      setMode(r.hold_music.mode);
      setUrl(r.hold_music.url ?? '');
      setSaved(true);
      setTimeout(() => setSaved(false), 2500);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not save hold music');
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card className="flex flex-col gap-3.5">
      <div className="flex items-center gap-2.5">
        <Icon name="speaker" size={16} style={{ color: 'var(--accent)' }} />
        <span className="mr-auto" style={{ font: '700 13.5px/1 Inter' }}>Hold music</span>
        {saved && <StatusMarker color="var(--green)" label="Saved" />}
      </div>
      <p style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>
        What plays to whoever is alone in the call — you for the moment before the seller answers,
        and the seller while you have them on hold. Applies to the whole org.
      </p>

      {setting === null && !error ? (
        <span style={{ font: '400 11.5px/1.5 Inter', color: 'var(--muted-2)' }}>Loading…</span>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            {HOLD_MUSIC_CHOICES.map((choice) => (
              <label key={choice.mode} className="flex cursor-pointer items-start gap-2">
                <input
                  type="radio"
                  name="hold-music-mode"
                  checked={mode === choice.mode}
                  onChange={() => setMode(choice.mode)}
                  className="mt-0.5"
                />
                <span className="flex flex-col gap-0.5">
                  <span style={{ font: '600 12.5px/1 Inter' }}>{choice.label}</span>
                  <span style={HELP}>{choice.help}</span>
                </span>
              </label>
            ))}
          </div>

          {mode === 'url' && (
            <label className="flex flex-col gap-1.5">
              <Eyebrow>Audio URL</Eyebrow>
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://example.com/hold.mp3"
                inputMode="url"
                aria-label="Hold music URL"
                className="outline-none"
                style={FIELD}
              />
              <span style={HELP}>
                A public https link the carrier can fetch. Local and private addresses are rejected —
                the carrier fetches this from the internet, not from your network.
              </span>
            </label>
          )}

          <div>
            <Button tone="accent" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? 'Saving…' : 'Save hold music'}
            </Button>
          </div>
        </>
      )}

      {error && <p style={{ font: '400 11px/1.4 Inter', color: 'var(--red)' }}>{error}</p>}
    </Card>
  );
}
// ─── end hold music ─────────────────────────────────────────────────────────

const ZONES = [
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Phoenix',
  'America/Los_Angeles',
  'America/Anchorage',
  'Pacific/Honolulu',
  'Europe/Lisbon',
  'Europe/London',
  'Asia/Manila',
];

const WINDOW_ZONES: Array<[string, string]> = [
  ['Eastern', 'America/New_York'],
  ['Central', 'America/Chicago'],
  ['Mountain', 'America/Denver'],
  ['Pacific', 'America/Los_Angeles'],
];

export default function SettingsPage() {
  const { authed } = useSoftphone();
  const [me, setMe] = useState<MeDto | null>(null);
  const [numbers, setNumbers] = useState<PhoneNumberDto[]>([]);
  const [templates, setTemplates] = useState<MessageTemplateDto[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [forwardDrafts, setForwardDrafts] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  /** Managers see the retired templates too, so they can bring one back. */
  const loadTemplates = useCallback(() => {
    setTemplatesLoading(true);
    api
      .listMessageTemplates({ include_inactive: canManageTemplates(me?.role) })
      .then((r) => setTemplates(r.templates))
      .catch(() => undefined)
      .finally(() => setTemplatesLoading(false));
  }, [me?.role]);

  useEffect(() => {
    if (!authed) return;
    api.getMe().then(setMe).catch((e) => setError((e as Error).message));
    api
      .listNumbers()
      .then((r) => {
        setNumbers(r.numbers);
        setForwardDrafts(Object.fromEntries(r.numbers.map((n) => [n.id, n.forward_to_e164 ?? ''])));
      })
      .catch(() => setNumbers([]));
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    loadTemplates();
  }, [authed, loadTemplates]);

  async function saveProfile(patch: {
    timezone?: string | null;
    city?: string | null;
    title?: string | null;
  }) {
    setError(null);
    try {
      const next = await api.updateMe(patch);
      setMe((m) => (m ? { ...m, ...patch, timezone: next.timezone, city: next.city } : m));
      setSaved('Profile saved');
      setTimeout(() => setSaved(null), 2500);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveForwarding(id: string) {
    setError(null);
    try {
      const next = await api.updateNumber(id, { forward_to_e164: forwardDrafts[id] ?? '' });
      setNumbers((ns) => ns.map((n) => (n.id === id ? { ...n, forward_to_e164: next.forward_to_e164 } : n)));
      setSaved('Forwarding saved');
      setTimeout(() => setSaved(null), 2500);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  async function saveLastContact(id: string, on: boolean) {
    setError(null);
    try {
      const next = await api.updateNumber(id, { route_callbacks_to_last_contact: on });
      const value = next.number?.route_callbacks_to_last_contact ?? on;
      setNumbers((ns) => ns.map((n) => (n.id === id ? { ...n, route_callbacks_to_last_contact: value } : n)));
      setSaved(value ? 'Callbacks ring the last rep first' : 'Callbacks use the normal ring order');
      setTimeout(() => setSaved(null), 2500);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  if (!authed) {
    return (
      <p className="p-6" style={{ font: '400 13px/1.5 Inter', color: 'var(--muted)' }}>
        Not signed in — open <a href="/login" style={{ color: 'var(--accent)' }}>Account</a>.
      </p>
    );
  }

  return (
    <>
      <TopBar title="Settings" subtitle="Audio, your zone, forwarding, hours and templates" />

      <div className="min-h-0 flex-1 overflow-auto p-5">
        {error && <p className="pb-3" style={{ font: '400 12px/1.4 Inter', color: 'var(--red)' }}>{error}</p>}
        {saved && (
          <p className="inline-flex items-center gap-1.5 pb-3" style={{ font: '600 12px/1 Inter', color: 'var(--green)' }}>
            <Icon name="check" size={13} />
            {saved}
          </p>
        )}

        <div className="grid items-start gap-4" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(420px, 100%), 1fr))' }}>
          {/* ── Audio devices ───────────────────────────────────────────── */}
          <AudioCard />

          {/* ── Call sounds ─────────────────────────────────────────────── */}
          <SoundsCard />

          {/* ── Caller ID ───────────────────────────────────────────── */}
          <Card className="flex flex-col gap-3.5">
            <div className="flex items-center gap-2.5">
              <Icon name="phone" size={16} style={{ color: 'var(--accent)' }} />
              <span className="mr-auto" style={{ font: '700 13.5px/1 Inter' }}>Caller ID</span>
            </div>
            <p style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>
              The number sellers see when you call or text. Pick a dedicated line, or let Talkr match
              the seller&apos;s area code from the org&apos;s numbers.
            </p>
            {me ? (
              <CallerIdPicker me={me} onChange={setMe} />
            ) : (
              <span style={{ font: '400 11.5px/1.5 Inter', color: 'var(--muted-2)' }}>Loading…</span>
            )}
          </Card>

          {/* ── Your working zone ───────────────────────────────────────── */}
          <Card className="flex flex-col gap-3.5">
            <div className="flex items-center gap-2.5">
              <Icon name="globe" size={16} style={{ color: 'var(--accent)' }} />
              <span className="mr-auto" style={{ font: '700 13.5px/1 Inter' }}>Your working zone</span>
            </div>
            <p style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>
              {/* The zone is read after mount, like the clock: the server has no browser zone. */}
              Teammates see this as your local time before they transfer you a call. Your browser
              is currently in <strong>{now === null ? '…' : localZone()}</strong>.
            </p>

            <label className="flex flex-col gap-1.5">
              <Eyebrow>Time zone</Eyebrow>
              <select
                value={me?.timezone ?? ''}
                onChange={(e) => void saveProfile({ timezone: e.target.value || null })}
                className="outline-none"
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--r-btn)',
                  padding: '9px 11px',
                  font: '500 12.5px/1 Inter',
                  background: 'var(--panel)',
                }}
              >
                <option value="">Not set</option>
                {[...new Set(now === null ? ZONES : [localZone(), ...ZONES])].map((z) => (
                  <option key={z} value={z}>
                    {z}
                    {now !== null ? ` — ${tzTime(z, now)}` : ''}
                  </option>
                ))}
              </select>
            </label>

            <label className="flex flex-col gap-1.5">
              <Eyebrow>City label</Eyebrow>
              <input
                defaultValue={me?.city ?? ''}
                onBlur={(e) => {
                  if (e.target.value !== (me?.city ?? '')) void saveProfile({ city: e.target.value || null });
                }}
                placeholder="Austin, TX"
                className="outline-none"
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--r-btn)',
                  padding: '9px 11px',
                  font: '500 12.5px/1 Inter',
                }}
              />
            </label>

            <label className="flex flex-col gap-1.5">
              <Eyebrow>Job title</Eyebrow>
              <input
                defaultValue={me?.title ?? ''}
                onBlur={(e) => {
                  if (e.target.value !== (me?.title ?? '')) {
                    void saveProfile({ title: e.target.value || null });
                  }
                }}
                placeholder="Acquisitions"
                className="outline-none"
                style={{
                  border: '1px solid var(--line)',
                  borderRadius: 'var(--r-btn)',
                  padding: '9px 11px',
                  font: '500 12.5px/1 Inter',
                }}
              />
              <span style={{ font: '400 10.5px/1.4 Inter', color: 'var(--muted-2)' }}>
                What teammates see on your card. Separate from your role, which
                is a permission and only an admin can change.
              </span>
            </label>
          </Card>

          {/* ── Forwarding ──────────────────────────────────────────────── */}
          <Card className="flex flex-col gap-3.5">
            <div className="flex items-center gap-2.5">
              <Icon name="forward" size={16} style={{ color: 'var(--accent)' }} />
              <span className="mr-auto" style={{ font: '700 13.5px/1 Inter' }}>Call forwarding</span>
            </div>
            <p style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>
              When nobody on the team can take a call, the router forwards it to this number
              before falling back to voicemail.
            </p>

            {numbers.length === 0 && (
              <EmptyState
                compact
                icon="phone"
                title="No numbers on this org yet"
                hint="Forwarding is per number. Once a line is bought and pointed at Talkr it shows up here."
              />
            )}

            {numbers.map((n) => (
              <div key={n.id} className="flex flex-col gap-1.5 py-2" style={{ borderBottom: '1px solid var(--panel-2)' }}>
                <div className="flex items-center gap-2">
                  <PhoneText e164={n.phone_e164} size={20} style={{ font: '600 12.5px/1 Inter' }} />
                  <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted)' }}>
                    {n.label ?? (n.capabilities.sms ? 'Voice + SMS' : 'Voice')}
                  </span>
                </div>
                <div className="flex gap-1.5">
                  <input
                    value={forwardDrafts[n.id] ?? ''}
                    onChange={(e) => setForwardDrafts((d) => ({ ...d, [n.id]: e.target.value }))}
                    placeholder="+15125550100 (blank = voicemail)"
                    inputMode="tel"
                    aria-label={`Forwarding for ${n.phone_e164}`}
                    className="flex-1 outline-none"
                    style={{
                      border: '1px solid var(--line)',
                      borderRadius: 'var(--r-btn)',
                      padding: '8px 10px',
                      font: '500 12px/1 Inter',
                    }}
                  />
                  <Button
                    tone="ghost"
                    disabled={(forwardDrafts[n.id] ?? '') === (n.forward_to_e164 ?? '')}
                    onClick={() => void saveForwarding(n.id)}
                  >
                    Save
                  </Button>
                </div>
                {canManageNumbers(me?.role) && (
                  <div className="flex items-center gap-2.5">
                    <Toggle
                      on={Boolean(n.route_callbacks_to_last_contact)}
                      onChange={(next) => void saveLastContact(n.id, next)}
                      label={`Ring the rep who last reached out first, for ${n.phone_e164}`}
                    />
                    <span style={{ font: '500 11.5px/1.4 Inter', color: 'var(--muted)' }}>
                      Ring the rep who last reached out first
                      <span style={{ display: 'block', font: '400 10.5px/1.4 Inter', color: 'var(--muted-2)' }}>
                        A callback rings whoever last called, texted or dropped a voicemail to that person
                        (14 days) before the lead owner. Lines with a call flow use its “last contact” step instead.
                      </span>
                    </span>
                  </div>
                )}
              </div>
            ))}

            <p style={{ font: '400 10.5px/1.4 Inter', color: 'var(--muted-2)' }}>
              Ring order, business hours and queue membership are configured in the routing
              tables; there is no editor for them yet.
            </p>
          </Card>

          {/* ── Hold music (admins and owners only) ─────────────────────── */}
          {(me?.role === 'owner' || me?.role === 'admin') && <HoldMusicCard />}

          {/* ── Dialing windows ─────────────────────────────────────────── */}
          <Card className="flex flex-col gap-3.5">
            <div className="flex items-center gap-2.5">
              <Icon name="clock" size={16} style={{ color: 'var(--accent)' }} />
              <span className="mr-auto" style={{ font: '700 13.5px/1 Inter' }}>Dialing windows</span>
              <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted-2)' }}>Lead&apos;s local time</span>
            </div>

            {WINDOW_ZONES.map(([label, tz]) => {
              const w = now === null ? null : callWindow(tz, now);
              return (
                <div key={tz} className="flex items-center gap-2.5 py-2" style={{ borderBottom: '1px solid var(--panel-2)' }}>
                  <span style={{ width: 6, height: 6, background: w ? w.color : 'var(--muted-2)' }} aria-hidden />
                  <span className="mr-auto flex flex-col gap-1">
                    <span style={{ font: '600 12px/1 Inter' }}>{label}</span>
                    <span style={{ font: '500 10px/1 Inter', color: 'var(--muted)' }}>
                      {SAFE_WINDOW.startHour}:00 AM — {SAFE_WINDOW.endHour - 12}:00 PM local
                    </span>
                  </span>
                  <span style={{ font: '600 12px/1 Inter' }}>{now === null ? '—' : tzTime(tz, now)}</span>
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
              The window is advisory in the UI — it warns the rep, it does not block the dial.
              SMS quiet hours are enforced server-side.
            </p>
          </Card>

          {/* ── Templates ───────────────────────────────────────────────── */}
          {/* The same manager the inbox shows, so the openers a manager writes
              here are exactly the rows a rep clicks mid-thread. */}
          <Card className="flex flex-col gap-3.5" style={{ gridColumn: '1 / -1' }}>
            <div className="flex items-center gap-2.5">
              <Icon name="template" size={16} style={{ color: 'var(--accent)' }} />
              <span className="mr-auto" style={{ font: '700 13.5px/1 Inter' }}>SMS templates</span>
              <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted-2)' }}>
                {templates.length} template{templates.length === 1 ? '' : 's'}
              </span>
            </div>

            <p style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>
              What a rep can insert into a thread. Merge fields like{' '}
              <code style={{ font: '600 11.5px/1 ui-monospace, monospace' }}>{'{first_name}'}</code> are
              filled in when the text is sent, and the editor shows exactly what the seller reads.
            </p>

            <TemplateManager
              templates={templates}
              loading={templatesLoading}
              canManage={canManageTemplates(me?.role)}
              reload={loadTemplates}
            />
          </Card>
        </div>
      </div>
    </>
  );
}
