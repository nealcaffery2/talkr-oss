'use client';

/**
 * SoftphoneProvider owns the carrier engine, the active call, and the SSE
 * subscription — mounted once in the root layout so client-side navigation
 * NEVER drops a call (docs/architecture.md "global dialer"). The server is
 * always authoritative for call state; the browser holds the media leg and
 * a fast local view that reconciles against SSE updates.
 *
 * The media leg is carried by Telnyx's WebRTC SDK, hidden behind
 * lib/softphone-engine.ts.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError, eventStreamUrl, type CallDto, type ParticipantDto, type PhoneLookupDto } from './api';
import {
  createEngine,
  type EngineAudio,
  type EngineCall,
  type EngineOutputCollection,
  type SoftphoneEngine,
} from './softphone-engine';
import { playSound } from './sounds';

/**
 * 'offline' = the engine exists but lost its registration (network blip,
 * laptop sleep); the provider re-registers on its own and the UI can say so.
 */
export type DeviceState = 'uninitialized' | 'initializing' | 'ready' | 'offline' | 'error';
export type LocalCallState = 'idle' | 'connecting' | 'ringing' | 'in_call' | 'wrapup';

export interface ActiveCall {
  record: CallDto;
  startedAt: number | null;
  muted: boolean;
}

/** A microphone or an output the rep can route call audio through. */
export interface AudioDevice {
  deviceId: string;
  label: string;
  kind: 'audioinput' | 'audiooutput';
}

/** Browser microphone permission; 'unknown' when the Permissions API cannot say (Firefox, Safari). */
export type MicPermission = 'granted' | 'denied' | 'prompt' | 'unknown';

export interface IncomingCallInfo {
  from: string;
  talkrCallId: string | null;
  context: PhoneLookupDto | null;
}

interface SoftphoneContextValue {
  deviceState: DeviceState;
  deviceError: string | null;
  /** Which carrier SDK is loaded, once the softphone has connected. */
  carrier: 'telnyx' | null;
  callState: LocalCallState;
  active: ActiveCall | null;
  incoming: IncomingCallInfo | null;
  serverStatus: string | null;
  wrapupCallId: string | null;
  initDevice: () => Promise<void>;
  placeCall: (input: { to_number?: string; lead_id?: string; contact_id?: string; from_phone_number_id?: string }) => Promise<void>;
  /** Open the media leg for a call the server already created (Phase 5 dial sessions). */
  connectExisting: (call: CallDto) => Promise<void>;
  acceptIncoming: () => void;
  rejectIncoming: () => void;
  hangup: () => void;
  toggleMute: () => void;
  sendDigit: (digit: string) => void;
  finishWrapup: () => void;
  authed: boolean;

  // ── Conference call control (docs/telephony-events.md §9) ─────────────────
  /** Everyone in the room, refreshed on every server nudge. */
  participants: ParticipantDto[];
  /** True while the customer is held. Derived from the roster, not guessed. */
  onHold: boolean;
  /** True once a third party is in and nobody is held. */
  merged: boolean;
  /** The last control that was refused, for the UI to surface briefly. */
  controlError: string | null;
  /**
   * The refusal's machine code (`call_not_active`, `nothing_to_merge`, …) when
   * the server named one, so the surface can say it in the rep's words instead
   * of echoing an identifier. Null for failures that carry no code.
   */
  controlErrorCode: string | null;
  toggleHold: () => Promise<void>;
  addParticipant: (input: { user_id?: string; to_number?: string; consult?: boolean }) => Promise<void>;
  merge: () => Promise<void>;
  dropParticipant: (providerParticipantId: string) => Promise<void>;
  transfer: (input: { mode: 'warm' | 'blind'; user_id?: string; to_number?: string }) => Promise<void>;
  completeTransfer: () => Promise<void>;

  // ── Audio devices ─────────────────────────────────────────────────────────
  micPermission: MicPermission;
  /** Prompt for the microphone, release it at once, and refresh the device lists. */
  requestMicPermission: () => Promise<boolean>;
  inputDevices: AudioDevice[];
  outputDevices: AudioDevice[];
  /** Alias of `outputDevices`, kept for the in-call output toggle. */
  audioDevices: AudioDevice[];
  /** The mic the next (or current) call uses; null means the browser default. */
  activeInputDeviceId: string | null;
  /** Where call audio is actually routed right now, read back from the SDK. */
  activeOutputDeviceId: string | null;
  /** Alias of `activeOutputDeviceId`. */
  activeAudioDeviceId: string | null;
  /** Where incoming calls ring, read back from the SDK. */
  activeRingtoneDeviceId: string | null;
  /** False in browsers without `setSinkId` (Safari, Firefox): outputs follow the OS. */
  outputSelectionSupported: boolean;
  selectInputDevice: (deviceId: string) => Promise<void>;
  selectOutputDevice: (deviceId: string) => Promise<void>;
  /** Alias of `selectOutputDevice`. */
  selectAudioDevice: (deviceId: string) => Promise<void>;
  selectRingtoneDevice: (deviceId: string) => Promise<void>;
  testSpeaker: () => Promise<void>;
  testRingtone: () => Promise<void>;
  /** Microphone level 0..1, updated at most ~10×/s. */
  inputLevel: number;
  /** Run a local mic meter (used by Settings); stop it when the card unmounts. */
  startMicMeter: (deviceId: string | null) => Promise<void>;
  stopMicMeter: () => void;
  refreshAudioDevices: () => Promise<void>;
}

const SoftphoneContext = createContext<SoftphoneContextValue | null>(null);

export function useSoftphone(): SoftphoneContextValue {
  const ctx = useContext(SoftphoneContext);
  if (!ctx) throw new Error('useSoftphone outside SoftphoneProvider');
  return ctx;
}

// ── Audio device helpers (pure, SSR-safe) ────────────────────────────────────

type AudioRole = 'input' | 'output' | 'ringtone';

/** Set once the rep has enabled the softphone; later page loads connect on their own. */
const SOFTPHONE_ENABLED_KEY = 'talkr:softphone:enabled';
const REREGISTER_BACKOFF_MS = [2_000, 4_000, 8_000, 15_000, 30_000];

function isRegistered(e: SoftphoneEngine | null | undefined): boolean {
  return !!e && e.isRegistered();
}

const STORAGE_KEYS: Record<AudioRole, string> = {
  input: 'talkr:audio:input',
  output: 'talkr:audio:output',
  ringtone: 'talkr:audio:ringtone',
};

const MIC_BLOCKED = "Microphone blocked — allow it in the browser's site settings";
const MIC_MISSING = 'No microphone found — plug one in and try again';

function readPref(role: AudioRole): string | null {
  try {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(STORAGE_KEYS[role]);
  } catch {
    return null;
  }
}

function writePref(role: AudioRole, deviceId: string | null): void {
  try {
    if (typeof window === 'undefined') return;
    if (deviceId) window.localStorage.setItem(STORAGE_KEYS[role], deviceId);
    else window.localStorage.removeItem(STORAGE_KEYS[role]);
  } catch {
    /* private mode or storage disabled: selection lives for this page only */
  }
}

/**
 * Labels are empty until the microphone has been granted once, so an
 * unlabelled device gets a stable "Microphone 1" style name instead of a blank
 * option.
 */
function describeDevice(d: MediaDeviceInfo, index: number): AudioDevice {
  const kind: AudioDevice['kind'] = d.kind === 'audioinput' ? 'audioinput' : 'audiooutput';
  let label = d.label;
  if (!label) {
    if (d.deviceId === 'default') label = 'System default';
    else if (d.deviceId === 'communications') label = 'Communications default';
    else label = `${kind === 'audioinput' ? 'Microphone' : 'Speaker'} ${index}`;
  }
  return { deviceId: d.deviceId, label, kind };
}

/** "Default - Jabra Evolve2 65 (0b0e:24c7)" → "Jabra Evolve2 65", for one-line summaries. */
export function shortDeviceLabel(label: string): string {
  return label
    .replace(/^(Default|Communications)\s+-\s+/i, '')
    .replace(/\s+\([0-9a-f]{4}:[0-9a-f]{4}\)\s*$/i, '')
    .trim();
}

/**
 * Point one output collection (speaker or ringtone) at the persisted device
 * when it is plugged in, else at the browser default, then read back what the
 * SDK actually routed — it reverts to default on its own when a device is lost.
 */
async function applyOutput(
  audio: EngineAudio,
  collection: EngineOutputCollection,
  want: string | null,
): Promise<string | null> {
  if (!audio.isOutputSelectionSupported) return null;
  const available = audio.availableOutputDevices;
  const target = want && available.has(want) ? want : available.has('default') ? 'default' : null;
  const current = [...collection.get()][0]?.deviceId ?? null;
  if (target && target !== current) {
    try {
      await collection.set(target);
    } catch {
      /* browser refused the switch; audio keeps flowing to the old device */
    }
  }
  return [...collection.get()][0]?.deviceId ?? null;
}

interface MicMeter {
  ctx: AudioContext;
  stream: MediaStream;
  raf: number;
}

export function SoftphoneProvider({ children }: { children: ReactNode }) {
  const engineRef = useRef<SoftphoneEngine | null>(null);
  const activeCallRef = useRef<EngineCall | null>(null);
  const incomingCallRef = useRef<EngineCall | null>(null);
  /** Last ten digits of every org number — server legs present these. */
  const ownNumbersRef = useRef<Set<string>>(new Set());
  const [deviceState, setDeviceState] = useState<DeviceState>('uninitialized');
  const [deviceError, setDeviceError] = useState<string | null>(null);
  const [carrier, setCarrier] = useState<'telnyx' | null>(null);
  const [callState, setCallState] = useState<LocalCallState>('idle');
  const [active, setActive] = useState<ActiveCall | null>(null);
  const [incoming, setIncoming] = useState<IncomingCallInfo | null>(null);
  const [serverStatus, setServerStatus] = useState<string | null>(null);
  const [wrapupCallId, setWrapupCallId] = useState<string | null>(null);
  const [participants, setParticipants] = useState<ParticipantDto[]>([]);
  const [controlError, setControlError] = useState<string | null>(null);
  const [controlErrorCode, setControlErrorCode] = useState<string | null>(null);
  const [inputDevices, setInputDevices] = useState<AudioDevice[]>([]);
  const [outputDevices, setOutputDevices] = useState<AudioDevice[]>([]);
  const [micPermission, setMicPermission] = useState<MicPermission>('unknown');
  const [prefs, setPrefs] = useState<Record<AudioRole, string | null>>({ input: null, output: null, ringtone: null });
  const prefsRef = useRef(prefs);
  const [activeOutputDeviceId, setActiveOutputDeviceId] = useState<string | null>(null);
  const [activeRingtoneDeviceId, setActiveRingtoneDeviceId] = useState<string | null>(null);
  const [outputSelectionSupported, setOutputSelectionSupported] = useState(false);
  const [inputLevel, setInputLevel] = useState(0);
  const lastLevelAtRef = useRef(0);
  const meterRef = useRef<MicMeter | null>(null);
  const meterGenRef = useRef(0);
  // Browsing the app does not require a pasted token. Every API endpoint is
  // authenticated server-side, so gating the client on a stored token only hid
  // the UI without protecting anything. Requests still send a token when one is
  // set; without one they surface a connection or auth error in place.
  const [authed] = useState(true);

  // Presence heartbeat: routing only rings fresh, available browsers
  // (docs/inbound-routing.md §2). Stale = unreachable, automatically.
  useEffect(() => {
    if (deviceState !== 'ready') return;
    void api.heartbeat('available').catch(() => undefined);
    const t = setInterval(() => void api.heartbeat('available').catch(() => undefined), 30_000);
    const onUnload = () => void api.heartbeat('offline').catch(() => undefined);
    window.addEventListener('beforeunload', onUnload);
    return () => {
      clearInterval(t);
      window.removeEventListener('beforeunload', onUnload);
      void api.heartbeat('offline').catch(() => undefined);
    };
  }, [deviceState]);

  // ── Microphone selection for calls ────────────────────────────────────────
  // The chosen mic is applied just before a call opens and released when it
  // ends, so the tab is not holding the microphone (and its red indicator)
  // between calls. Outputs carry no such cost and are applied the moment the
  // engine is ready.

  const applyInputForCall = useCallback(async () => {
    const audio = engineRef.current?.audio;
    if (!audio) return;
    const want = prefsRef.current.input;
    // No preference, or the headset is unplugged: the SDK opens the default mic itself.
    if (!want || !audio.availableInputDevices.has(want)) return;
    try {
      await audio.setInputDevice(want);
    } catch {
      /* the default mic carries the call instead */
    }
  }, []);

  const releaseInput = useCallback(() => {
    void engineRef.current?.audio?.unsetInputDevice().catch(() => undefined);
    setInputLevel(0);
  }, []);

  // One connection attempt at a time, shared by the dialer button, the
  // auto-connect on page load and any call button that finds the engine down.
  const initPromiseRef = useRef<Promise<void> | null>(null);
  const deviceErrorRef = useRef<string | null>(null);
  const reregisterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reregisterAttemptRef = useRef(0);
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fatalRef = useRef(false);

  const scheduleReregister = useCallback((engine: SoftphoneEngine) => {
    if (fatalRef.current || reregisterTimerRef.current) return;
    const attempt = reregisterAttemptRef.current;
    const delay = REREGISTER_BACKOFF_MS[Math.min(attempt, REREGISTER_BACKOFF_MS.length - 1)]!;
    reregisterAttemptRef.current = attempt + 1;
    reregisterTimerRef.current = setTimeout(async () => {
      reregisterTimerRef.current = null;
      if (engineRef.current !== engine) return;
      try {
        const fresh = await api.voiceToken();
        engine.updateToken(fresh.token);
        await engine.register();
      } catch (err) {
        deviceErrorRef.current = err instanceof Error && err.message ? err.message : deviceErrorRef.current;
        setDeviceError(deviceErrorRef.current);
        scheduleReregister(engine);
      }
    }, delay);
  }, []);

  /**
   * Keep the credential fresh for as long as the tab is open: a minute before
   * it expires, fetch another and hand it to the engine, which uses it on the
   * next (re)login.
   */
  const scheduleTokenRefresh = useCallback((engine: SoftphoneEngine, ttlSeconds: number) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    const delay = Math.max(30, ttlSeconds - 60) * 1000;
    refreshTimerRef.current = setTimeout(async () => {
      refreshTimerRef.current = null;
      if (engineRef.current !== engine) return;
      try {
        const fresh = await api.voiceToken();
        engine.updateToken(fresh.token);
        scheduleTokenRefresh(engine, fresh.ttl_seconds);
      } catch {
        /* the next call attempt or re-registration surfaces auth errors */
      }
    }, delay);
  }, []);

  /** An incoming leg from the carrier: offer it, or auto-reject when busy. */
  const onIncoming = useCallback((call: EngineCall) => {
    // Never busy-reject an invite from one of our own numbers — that is a
    // Telnyx server leg (ours or another softphone's). Rejecting it sends
    // SipHangupCause=486 and can cancel the fork the answering client holds.
    const fromKey = (call.from ?? '').replace(/\D/g, '').slice(-10);
    const fromUs = fromKey.length === 10 && ownNumbersRef.current.has(fromKey);
    if (fromUs) return;
    // One call at a time in v1: an already-busy rep auto-rejects and the
    // server-side routing chain proceeds to the next fallback.
    if (activeCallRef.current) {
      call.reject();
      return;
    }
    incomingCallRef.current = call;
    const talkrCallId = call.talkrCallId;
    const from = call.from ?? 'Unknown';
    setIncoming({ from, talkrCallId, context: null });
    void api
      .lookupPhone(from)
      .then((context) => setIncoming((cur) => (cur && cur.from === from ? { ...cur, context } : cur)))
      .catch(() => undefined);
    const clear = () => {
      if (incomingCallRef.current === call) {
        incomingCallRef.current = null;
        setIncoming(null);
      }
    };
    call.on('cancel', clear);
    call.on('disconnect', clear);
  }, []);

  const initDevice = useCallback(async () => {
    if (isRegistered(engineRef.current)) return;
    if (initPromiseRef.current) return initPromiseRef.current;
    const attempt = (async () => {
      setDeviceState('initializing');
      setDeviceError(null);
      deviceErrorRef.current = null;
      fatalRef.current = false;
      const token = await api.voiceToken();
      // An engine that exists but fell off the network only needs a fresh token
      // and a new registration; keep its audio selections and handlers.
      const existing = engineRef.current;
      if (existing) {
        existing.updateToken(token.token);
        await existing.register();
        scheduleTokenRefresh(existing, token.ttl_seconds);
        return;
      }
      let engine: SoftphoneEngine | null = null;
      engine = await createEngine(token, {
        onRegistered: () => {
          reregisterAttemptRef.current = 0;
          if (engineRef.current === engine) {
            setDeviceState('ready');
            setDeviceError(null);
            deviceErrorRef.current = null;
          }
        },
        onUnregistered: () => {
          // Network change, laptop sleep, carrier edge restart: come back quietly.
          if (engineRef.current !== engine || activeCallRef.current || !engine) return;
          setDeviceState('offline');
          scheduleReregister(engine);
        },
        onError: (err) => {
          deviceErrorRef.current = err.message;
          setDeviceError(err.message);
          if (err.fatal) {
            // Token cannot be fixed by retrying (account suspended / wrong key).
            fatalRef.current = true;
            if (reregisterTimerRef.current) {
              clearTimeout(reregisterTimerRef.current);
              reregisterTimerRef.current = null;
            }
            if (engineRef.current === engine) setDeviceState('error');
          } else if (engineRef.current === engine && engine && !engine.isRegistered()) {
            setDeviceState('offline');
            scheduleReregister(engine);
          }
        },
        onIncoming,
      });
      engineRef.current = engine;
      setCarrier(engine.kind);
      await engine.register();
      void api
        .getMe()
        .then((me) => {
          const numbers = (me.org_numbers ?? []).map((n) => n.phone_e164);
          ownNumbersRef.current = new Set(numbers.map((n) => n.replace(/\D/g, '').slice(-10)).filter((n) => n.length === 10));
          engine.setOwnNumbers(numbers);
        })
        .catch(() => undefined);
      scheduleTokenRefresh(engine, token.ttl_seconds);
    })();
    initPromiseRef.current = attempt;
    try {
      await attempt;
      setDeviceState('ready');
      try {
        window.localStorage.setItem(SOFTPHONE_ENABLED_KEY, '1');
      } catch {
        /* private mode: the rep enables it again next visit */
      }
    } catch (err) {
      // register() can reject with a non-Error (or nothing) when the SDK has
      // already reported the failure through the error handler above.
      const message =
        err instanceof Error && err.message ? err.message : (deviceErrorRef.current ?? 'Could not start the softphone');
      deviceErrorRef.current = message;
      setDeviceError(message);
      setDeviceState('error');
      // An engine that never registered is not worth keeping: the next attempt
      // starts clean with a fresh token.
      const e = engineRef.current;
      if (e && !isRegistered(e)) {
        engineRef.current = null;
        e.destroy();
      }
    } finally {
      initPromiseRef.current = null;
    }
  }, [onIncoming, scheduleReregister, scheduleTokenRefresh]);

  /** Bring the softphone up if it is down; throws a rep-readable reason when it cannot. */
  const ensureDevice = useCallback(async () => {
    if (isRegistered(engineRef.current)) return;
    await initDevice();
    if (!isRegistered(engineRef.current)) {
      throw new Error(deviceErrorRef.current ?? 'The softphone could not connect. Check your network and try again.');
    }
  }, [initDevice]);

  // The softphone comes up on its own on every page load: a rep who can open
  // the app can take a call. The only way to stop that is the stored '0'.
  useEffect(() => {
    let enabled = true;
    try {
      enabled = window.localStorage.getItem(SOFTPHONE_ENABLED_KEY) !== '0';
    } catch {
      /* no storage */
    }
    if (enabled) void initDevice().catch(() => undefined);
    const onOnline = () => {
      const e = engineRef.current;
      if (e && !isRegistered(e) && !fatalRef.current) void initDevice().catch(() => undefined);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') onOnline();
    };
    window.addEventListener('online', onOnline);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', onOnline);
      document.removeEventListener('visibilitychange', onVisible);
      if (reregisterTimerRef.current) clearTimeout(reregisterTimerRef.current);
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    };
    // initDevice is stable (its deps are refs); run once per provider mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Open the media leg for an already-created call (click-to-call step 2,
   * also used directly by Phase 5 dial sessions whose calls the server made). */
  const connectExisting = useCallback(
    async (call: CallDto) => {
      if (activeCallRef.current) throw new Error('a call is already active');
      await ensureDevice();
      setActive({ record: call, startedAt: null, muted: false });
      setCallState('connecting');
      setServerStatus(call.status);
      await applyInputForCall();
      // The server's call control decides the dial; the browser only carries
      // media. The server rings this browser and the engine answers
      // (softphone-engine.ts).
      const engine = engineRef.current;
      if (!engine) throw new Error(deviceErrorRef.current ?? 'The softphone could not connect.');
      let leg: EngineCall;
      try {
        leg = await engine.connect(call.id, {
          ringServer: () => api.ringBrowserLeg(call.id),
          expectFrom: call.from_number,
        });
      } catch (err) {
        releaseInput();
        setActive(null);
        setCallState('idle');
        setServerStatus(null);
        throw err;
      }
      activeCallRef.current = leg;
      leg.on('accept', () => {
        setActive((a) => (a ? { ...a, startedAt: Date.now() } : a));
        setCallState('in_call');
        // The seller picked up. A rep watching the script rather than the
        // timer hears it (lib/sounds.ts; silent when Sounds is off).
        playSound('connected');
      });
      leg.on('mute', (muted: boolean) => {
        setActive((a) => (a ? { ...a, muted } : a));
      });
      const onEnd = () => {
        // 'disconnect', 'cancel' and 'error' all land here and the SDK can fire
        // more than one; the ref guard keeps the chime to a single play.
        const wasLive = activeCallRef.current !== null;
        activeCallRef.current = null;
        releaseInput();
        if (wasLive) playSound('ended');
        setCallState('wrapup');
        setWrapupCallId(call.id);
      };
      leg.on('disconnect', onEnd);
      leg.on('cancel', onEnd);
      leg.on('error', onEnd);
    },
    [applyInputForCall, releaseInput, ensureDevice],
  );

  const placeCall = useCallback(
    async (input: { to_number?: string; lead_id?: string; contact_id?: string; from_phone_number_id?: string }) => {
      if (activeCallRef.current) throw new Error('a call is already active');
      await ensureDevice();
      // 1. Server creates the authoritative call record (suppression-gated).
      const { call } = await api.createCall(input);
      // 2. Browser opens the media leg.
      await connectExisting(call);
    },
    [connectExisting, ensureDevice],
  );

  const acceptIncoming = useCallback(() => {
    const leg = incomingCallRef.current;
    const info = incoming;
    if (!leg || !info) return;
    incomingCallRef.current = null;
    activeCallRef.current = leg;
    setIncoming(null);
    const placeholder: CallDto = {
      id: info.talkrCallId ?? 'unknown',
      correlation_id: '',
      direction: 'inbound',
      status: 'in_progress',
      user_id: null,
      lead_id: info.context?.lead?.id ?? null,
      contact_id: info.context?.contact?.id ?? null,
      contact_name: info.context?.contact?.display_name ?? null,
      from_number: info.from,
      to_number: '',
      answered_at: null,
      ended_at: null,
      duration_seconds: null,
      failure_class: 'none',
      disposition_id: null,
      crm_sync_status: 'none',
      created_at: new Date().toISOString(),
    };
    setActive({ record: placeholder, startedAt: Date.now(), muted: false });
    setCallState('in_call');
    // Accepting an inbound call is the same moment as an outbound 'accept':
    // the media leg is open and the seller is on the line.
    playSound('connected');
    // A Telnyx invite names the caller, not our call; ask which call is ringing
    // from that number so wrap-up and call controls work on inbound calls.
    let talkrCallId = info.talkrCallId;
    const record = talkrCallId
      ? api.getCall(talkrCallId).then((r) => r.call)
      : api.ringingCall(info.from).then((r) => r.call);
    void record
      .then((call) => {
        if (activeCallRef.current !== leg) return; // hung up before the answer came back
        talkrCallId = call.id;
        setActive((a) => (a ? { ...a, record: call } : a));
      })
      .catch(() => undefined);
    leg.on('mute', (muted: boolean) => setActive((a) => (a ? { ...a, muted } : a)));
    const onEnd = () => {
      const wasLive = activeCallRef.current !== null;
      activeCallRef.current = null;
      releaseInput();
      if (wasLive) playSound('ended');
      if (talkrCallId) {
        setCallState('wrapup');
        setWrapupCallId(talkrCallId);
      } else {
        setCallState('idle');
        setActive(null);
      }
    };
    leg.on('disconnect', onEnd);
    leg.on('cancel', onEnd);
    leg.on('error', onEnd);
    // The chosen mic is opened first so the call starts on it; if the caller
    // hangs up meanwhile, accept() on a no-longer-pending call is a no-op.
    void applyInputForCall().then(() => leg.accept());
  }, [incoming, applyInputForCall, releaseInput]);

  const rejectIncoming = useCallback(() => {
    incomingCallRef.current?.reject();
    incomingCallRef.current = null;
    setIncoming(null);
  }, []);

  const hangup = useCallback(() => {
    activeCallRef.current?.disconnect();
  }, []);

  const toggleMute = useCallback(() => {
    const call = activeCallRef.current;
    if (call) call.mute(!call.isMuted());
  }, []);

  const sendDigit = useCallback((digit: string) => {
    activeCallRef.current?.sendDigits(digit);
  }, []);

  const finishWrapup = useCallback(() => {
    setWrapupCallId(null);
    setActive(null);
    setServerStatus(null);
    setCallState('idle');
    setParticipants([]);
  }, []);

  // ── Conference call control ───────────────────────────────────────────────
  // The server owns the room; the browser only asks. Every control refreshes
  // the roster from the server rather than guessing what the room now looks
  // like, so the UI can never drift into showing a party who is not there.

  const activeCallId = active?.record.id ?? null;

  const refreshParticipants = useCallback(async (callId: string) => {
    try {
      const { participants: rows } = await api.listParticipants(callId);
      setParticipants(rows);
    } catch {
      /* a transient read failure leaves the last known roster in place */
    }
  }, []);

  /**
   * Run one control, then re-read the roster. A refusal (409) is shown to the
   * rep rather than thrown: asking to hold an already-held caller is a
   * mis-click, not a crash.
   */
  const control = useCallback(
    async (fn: (callId: string) => Promise<unknown>) => {
      if (!activeCallId) return;
      setControlError(null);
      setControlErrorCode(null);
      try {
        await fn(activeCallId);
      } catch (err) {
        setControlError(err instanceof Error ? err.message : 'control failed');
        setControlErrorCode(err instanceof ApiError ? err.code : null);
      }
      await refreshParticipants(activeCallId);
    },
    [activeCallId, refreshParticipants],
  );

  const onHold = participants.some((p) => p.role === 'customer' && p.state === 'on_hold');
  const merged =
    participants.filter((p) => p.state === 'joined').length >= 3 &&
    participants.some((p) => p.role === 'customer' && p.state === 'joined');

  const toggleHold = useCallback(
    () => control((id) => api.setHold(id, !onHold)),
    [control, onHold],
  );
  const addParticipant = useCallback(
    (input: { user_id?: string; to_number?: string; consult?: boolean }) =>
      control((id) => api.addParticipant(id, input)),
    [control],
  );
  const merge = useCallback(() => control((id) => api.mergeCall(id)), [control]);
  const dropParticipant = useCallback(
    (providerParticipantId: string) =>
      control((id) => api.removeParticipant(id, providerParticipantId)),
    [control],
  );
  const transfer = useCallback(
    (input: { mode: 'warm' | 'blind'; user_id?: string; to_number?: string }) =>
      control((id) => api.transferCall(id, input)),
    [control],
  );
  const completeTransferFn = useCallback(
    () => control((id) => api.completeTransfer(id)),
    [control],
  );

  // Load the roster when a call becomes active, and clear it when one ends.
  useEffect(() => {
    if (!activeCallId) {
      setParticipants([]);
      return;
    }
    void refreshParticipants(activeCallId);
  }, [activeCallId, refreshParticipants]);

  // ── Audio devices ─────────────────────────────────────────────────────────

  const setPref = useCallback((role: AudioRole, deviceId: string | null) => {
    prefsRef.current = { ...prefsRef.current, [role]: deviceId };
    setPrefs(prefsRef.current);
    writePref(role, deviceId);
  }, []);

  /** Throttle the meter to ~10 updates/s: the SDK and the local analyser both emit per frame. */
  const pushLevel = useCallback((raw: number) => {
    const now = Date.now();
    if (now - lastLevelAtRef.current < 100) return;
    lastLevelAtRef.current = now;
    const level = Math.round(Math.min(1, Math.max(0, raw)) * 100) / 100;
    setInputLevel((cur) => (cur === level ? cur : level));
  }, []);

  /**
   * Enumerate through the browser rather than the SDK so the lists exist
   * before the softphone is enabled. Labels are empty until the microphone has
   * been granted; a labelled list is also proof of permission in browsers
   * whose Permissions API cannot answer for the microphone.
   */
  const refreshAudioDevices = useCallback(async () => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      const ins: AudioDevice[] = [];
      const outs: AudioDevice[] = [];
      for (const d of all) {
        if (d.kind === 'audioinput') ins.push(describeDevice(d, ins.length + 1));
        else if (d.kind === 'audiooutput') outs.push(describeDevice(d, outs.length + 1));
      }
      setInputDevices(ins);
      setOutputDevices(outs);
      if (all.some((d) => d.kind === 'audioinput' && d.label)) {
        setMicPermission((p) => (p === 'unknown' ? 'granted' : p));
      }
    } catch {
      /* enumeration refused; the pickers keep their last list */
    }
  }, []);

  const refreshMicPermission = useCallback(async (): Promise<MicPermission> => {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return 'unknown';
    try {
      const status = await navigator.permissions.query({ name: 'microphone' as PermissionName });
      setMicPermission(status.state);
      return status.state;
    } catch {
      return 'unknown';
    }
  }, []);

  const requestMicPermission = useCallback(async (): Promise<boolean> => {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
      setDeviceError(MIC_BLOCKED);
      return false;
    }
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      // Only the grant is wanted; holding the mic open would light the tab indicator.
      stream.getTracks().forEach((t) => t.stop());
      setDeviceError((e) => (e === MIC_BLOCKED || e === MIC_MISSING ? null : e));
      const state = await refreshMicPermission();
      if (state === 'unknown') setMicPermission('granted');
      await refreshAudioDevices();
      return true;
    } catch (err) {
      const name = err instanceof DOMException ? err.name : '';
      const state = await refreshMicPermission();
      if (name === 'NotFoundError' || name === 'OverconstrainedError') {
        setDeviceError(MIC_MISSING);
      } else {
        if (state === 'unknown') setMicPermission('denied');
        setDeviceError(MIC_BLOCKED);
      }
      return false;
    }
  }, [refreshAudioDevices, refreshMicPermission]);

  /** Re-point speaker and ringtone at the persisted devices and read back reality. */
  const syncOutputs = useCallback(async () => {
    const audio = engineRef.current?.audio;
    if (!audio) return;
    setOutputSelectionSupported(audio.isOutputSelectionSupported);
    const [speaker, ringtone] = await Promise.all([
      applyOutput(audio, audio.speakerDevices, prefsRef.current.output),
      applyOutput(audio, audio.ringtoneDevices, prefsRef.current.ringtone),
    ]);
    setActiveOutputDeviceId(speaker);
    setActiveRingtoneDeviceId(ringtone);
  }, []);

  const selectInputDevice = useCallback(
    async (deviceId: string) => {
      setPref('input', deviceId || null);
      const audio = engineRef.current?.audio;
      // Off a call the choice waits for the next dial; on a call it switches live.
      if (!audio || !activeCallRef.current) return;
      const target =
        deviceId && audio.availableInputDevices.has(deviceId)
          ? deviceId
          : audio.availableInputDevices.has('default')
            ? 'default'
            : null;
      if (!target) return;
      try {
        await audio.setInputDevice(target);
      } catch {
        /* live switch refused; the call keeps its current mic */
      }
    },
    [setPref],
  );

  const selectOutputDevice = useCallback(
    async (deviceId: string) => {
      setPref('output', deviceId || null);
      const audio = engineRef.current?.audio;
      if (!audio) return;
      setActiveOutputDeviceId(await applyOutput(audio, audio.speakerDevices, deviceId || null));
    },
    [setPref],
  );

  const selectRingtoneDevice = useCallback(
    async (deviceId: string) => {
      setPref('ringtone', deviceId || null);
      const audio = engineRef.current?.audio;
      if (!audio) return;
      setActiveRingtoneDeviceId(await applyOutput(audio, audio.ringtoneDevices, deviceId || null));
    },
    [setPref],
  );

  const testSpeaker = useCallback(async () => {
    const audio = engineRef.current?.audio;
    if (!audio) throw new Error('Enable the softphone first');
    await audio.speakerDevices.test();
  }, []);

  const testRingtone = useCallback(async () => {
    const audio = engineRef.current?.audio;
    if (!audio) throw new Error('Enable the softphone first');
    await audio.ringtoneDevices.test();
  }, []);

  /**
   * Local meter for the Settings card. The SDK only reports input volume while
   * it holds a mic (setInputDevice, i.e. during a call), so between calls the
   * level comes from a short-lived analyser on the chosen device instead.
   */
  const stopMicMeter = useCallback(() => {
    meterGenRef.current += 1;
    const meter = meterRef.current;
    if (!meter) return;
    meterRef.current = null;
    cancelAnimationFrame(meter.raf);
    meter.stream.getTracks().forEach((t) => t.stop());
    void meter.ctx.close().catch(() => undefined);
    setInputLevel(0);
  }, []);

  const startMicMeter = useCallback(
    async (deviceId: string | null) => {
      stopMicMeter();
      if (
        typeof navigator === 'undefined' ||
        !navigator.mediaDevices?.getUserMedia ||
        typeof AudioContext === 'undefined'
      ) {
        return;
      }
      const gen = meterGenRef.current;
      const open = (constraints: MediaStreamConstraints) => navigator.mediaDevices.getUserMedia(constraints);
      let stream: MediaStream;
      try {
        try {
          stream = await open({ audio: deviceId ? { deviceId: { exact: deviceId } } : true });
        } catch (err) {
          // A stale id (device just unplugged) must not blank the meter: fall back to any mic once.
          if (!deviceId || (err instanceof DOMException && err.name === 'NotAllowedError')) throw err;
          stream = await open({ audio: true });
        }
      } catch (err) {
        if (err instanceof DOMException && err.name === 'NotAllowedError') setMicPermission('denied');
        return;
      }
      // Stopped or restarted while the prompt was open: release this stream.
      if (gen !== meterGenRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;
      ctx.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const meter: MicMeter = { ctx, stream, raf: 0 };
      meterRef.current = meter;
      const tick = () => {
        if (meterRef.current !== meter) return;
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i += 1) {
          const x = (samples[i] - 128) / 128;
          sum += x * x;
        }
        // RMS of speech at a normal distance sits around 0.05–0.2; ×4 makes it readable.
        pushLevel(Math.sqrt(sum / samples.length) * 4);
        meter.raf = requestAnimationFrame(tick);
      };
      meter.raf = requestAnimationFrame(tick);
      // A context created outside a click starts suspended in some browsers.
      void ctx.resume().catch(() => undefined);
    },
    [pushLevel, stopMicMeter],
  );

  // Persisted choices and the browser's device list, from first paint on.
  useEffect(() => {
    const loaded: Record<AudioRole, string | null> = {
      input: readPref('input'),
      output: readPref('output'),
      ringtone: readPref('ringtone'),
    };
    prefsRef.current = loaded;
    setPrefs(loaded);
    void refreshAudioDevices();
    const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    if (!media?.addEventListener) return;
    const onChange = () => void refreshAudioDevices();
    media.addEventListener('devicechange', onChange);
    return () => media.removeEventListener('devicechange', onChange);
  }, [refreshAudioDevices]);

  // Microphone permission, live. Browsers that cannot query it throw and stay 'unknown'.
  useEffect(() => {
    if (typeof navigator === 'undefined' || !navigator.permissions?.query) return;
    let status: PermissionStatus | null = null;
    let cancelled = false;
    const onChange = () => {
      if (status) setMicPermission(status.state);
    };
    navigator.permissions
      .query({ name: 'microphone' as PermissionName })
      .then((s) => {
        if (cancelled) return;
        status = s;
        setMicPermission(s.state);
        s.addEventListener('change', onChange);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      status?.removeEventListener('change', onChange);
    };
  }, []);

  // Once the engine exists: apply persisted outputs, follow hot-plug events,
  // and read the SDK's own input meter (only live while it holds a mic).
  useEffect(() => {
    if (deviceState !== 'ready') return;
    const audio = engineRef.current?.audio;
    if (!audio) return;
    let replug: ReturnType<typeof setTimeout> | null = null;
    const onDeviceChange = () => {
      void refreshAudioDevices();
      void syncOutputs();
      // Mid-call the SDK already fell back to the default mic; re-take the
      // persisted one shortly after, once the SDK's own re-acquire has settled.
      if (activeCallRef.current) {
        if (replug) clearTimeout(replug);
        replug = setTimeout(() => {
          replug = null;
          if (activeCallRef.current) void applyInputForCall();
        }, 500);
      }
    };
    const onInputVolume = (volume: number) => {
      // The local analyser wins while Settings is open; two scales would flicker.
      if (!meterRef.current) pushLevel(volume);
    };
    audio.on('deviceChange', onDeviceChange);
    audio.on('inputVolume', onInputVolume);
    void refreshAudioDevices();
    void syncOutputs();
    return () => {
      if (replug) clearTimeout(replug);
      audio.off('deviceChange', onDeviceChange);
      audio.off('inputVolume', onInputVolume);
    };
  }, [deviceState, refreshAudioDevices, syncOutputs, applyInputForCall, pushLevel]);

  // Never leave a mic stream behind if the provider itself unmounts.
  useEffect(() => () => stopMicMeter(), [stopMicMeter]);

  /** The mic the next call opens: the persisted one when present, else the browser default. */
  const activeInputDeviceId = useMemo(() => {
    const want = prefs.input;
    if (want && inputDevices.some((d) => d.deviceId === want)) return want;
    return inputDevices.some((d) => d.deviceId === 'default') ? 'default' : null;
  }, [prefs.input, inputDevices]);

  // Server-truth stream: reconcile local state with authoritative status.
  useEffect(() => {
    if (!authed) return;
    const url = eventStreamUrl();
    if (!url) return;
    const source = new EventSource(url);
    const onUpdate = (raw: MessageEvent) => {
      try {
        const event = JSON.parse(raw.data) as { callId?: string; status?: string };
        setActive((a) => {
          if (!a || !event.callId || event.callId !== a.record.id) return a;
          setServerStatus(event.status ?? null);
          // Every roster change publishes call.updated, so this is also how a
          // party joining, holding or dropping reaches the UI — including
          // changes this browser did not initiate.
          void refreshParticipants(a.record.id);
          return a;
        });
      } catch {
        /* ignore malformed */
      }
    };
    source.addEventListener('call.updated', onUpdate);
    source.addEventListener('call.wrapup', onUpdate);
    return () => source.close();
  }, [authed, refreshParticipants]);

  const value = useMemo<SoftphoneContextValue>(
    () => ({
      deviceState,
      deviceError,
      carrier,
      callState,
      active,
      incoming,
      serverStatus,
      wrapupCallId,
      initDevice,
      placeCall,
      connectExisting,
      acceptIncoming,
      rejectIncoming,
      hangup,
      toggleMute,
      sendDigit,
      finishWrapup,
      authed,
      participants,
      onHold,
      merged,
      controlError,
      controlErrorCode,
      toggleHold,
      addParticipant,
      merge,
      dropParticipant,
      transfer,
      completeTransfer: completeTransferFn,
      micPermission,
      requestMicPermission,
      inputDevices,
      outputDevices,
      audioDevices: outputDevices,
      activeInputDeviceId,
      activeOutputDeviceId,
      activeAudioDeviceId: activeOutputDeviceId,
      activeRingtoneDeviceId,
      outputSelectionSupported,
      selectInputDevice,
      selectOutputDevice,
      selectAudioDevice: selectOutputDevice,
      selectRingtoneDevice,
      testSpeaker,
      testRingtone,
      inputLevel,
      startMicMeter,
      stopMicMeter,
      refreshAudioDevices,
    }),
    [deviceState, deviceError, carrier, callState, active, incoming, serverStatus, wrapupCallId, initDevice, placeCall, connectExisting, acceptIncoming, rejectIncoming, hangup, toggleMute, sendDigit, finishWrapup, authed, participants, onHold, merged, controlError, controlErrorCode, toggleHold, addParticipant, merge, dropParticipant, transfer, completeTransferFn, micPermission, requestMicPermission, inputDevices, outputDevices, activeInputDeviceId, activeOutputDeviceId, activeRingtoneDeviceId, outputSelectionSupported, selectInputDevice, selectOutputDevice, selectRingtoneDevice, testSpeaker, testRingtone, inputLevel, startMicMeter, stopMicMeter, refreshAudioDevices],
  );

  return <SoftphoneContext.Provider value={value}>{children}</SoftphoneContext.Provider>;
}
