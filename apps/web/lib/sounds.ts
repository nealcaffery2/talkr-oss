/**
 * Call sounds, synthesized.
 *
 * A rep on the phone all day needs to *hear* the two moments that matter — the
 * call connected, the call ended — without looking away from the script. These
 * are four short oscillator sequences, not audio files: nothing to download,
 * nothing to cache, no dependency, and no request that can 404 mid-call.
 *
 * Rules the implementation keeps:
 *  - The `AudioContext` is created on first *play*, never at import time. A
 *    module-scope context would break SSR (no `AudioContext` on the server)
 *    and would be born suspended under the browser's autoplay policy anyway.
 *  - Every sequence is ≤ 400ms and peaks at ~0.08 gain — audible over a headset
 *    without stepping on the caller's voice.
 *  - Every call is wrapped: a browser that refuses audio (no Web Audio, a
 *    context that will not resume, a tab with no gesture yet) fails silently.
 *    A missing chime must never surface as an error on a live call.
 *  - A "Sounds" preference (Settings, default on) is honoured, and is read from
 *    `localStorage` once and cached — a hangup should not touch storage.
 *
 * Where these fire:
 *  - `connected` / `ended` — lib/softphone.tsx, off the call lifecycle
 *    (`accept` for outbound, `acceptIncoming` for inbound, the shared `onEnd`).
 *  - `appointment` — components/WrapUp.tsx, once a disposition that means a
 *    booked appointment saves.
 *  - `messageIn` — NOT WIRED. Inbound texts arrive on the SSE `message.received`
 *    listener in app/(app)/messages/page.tsx, which is owned by another change
 *    right now. The hook is one line inside that file's `onMessageEvent`, after
 *    it decides the message is inbound:
 *        import { playSound } from '@/lib/sounds';
 *        if (msg.direction === 'inbound') playSound('messageIn');
 *    Nothing else needs to change; this module is already SSR-safe and
 *    preference-aware.
 */

export type SoundName = 'connected' | 'ended' | 'appointment' | 'messageIn';

/** Per-browser, like the audio-device choices next to it in Settings. */
export const SOUNDS_ENABLED_KEY = 'talkr:sounds:enabled';

/** One step of a sequence: a note, when it starts, and how long it rings. */
interface Note {
  /** Hz. */
  freq: number;
  /** Seconds after the sequence starts. */
  at: number;
  /** Seconds. */
  dur: number;
  /** Peak gain, 0–1. Kept at or under 0.08 so nothing is ever startling. */
  peak: number;
  type?: OscillatorType;
}

const PEAK = 0.08;

/**
 * The four sequences. Equal-tempered frequencies, chosen so "connected" rises
 * and "ended" falls — the shape carries the meaning even at low volume, and a
 * rep learns them without being told.
 */
const SEQUENCES: Record<SoundName, Note[]> = {
  // D5 → A5: a soft two-tone rise. 200ms end to end.
  connected: [
    { freq: 587.33, at: 0, dur: 0.1, peak: PEAK * 0.85, type: 'sine' },
    { freq: 880.0, at: 0.09, dur: 0.13, peak: PEAK, type: 'sine' },
  ],
  // A4 → D4: the same interval, walked down, and quieter. The call is over;
  // this is a full stop, not an announcement.
  ended: [
    { freq: 440.0, at: 0, dur: 0.1, peak: PEAK * 0.6, type: 'sine' },
    { freq: 293.66, at: 0.09, dur: 0.16, peak: PEAK * 0.7, type: 'sine' },
  ],
  // C5–E5–G5–C6: a major arpeggio for the one disposition that is a win.
  // 320ms, the longest thing here, because it only plays a few times a day.
  appointment: [
    { freq: 523.25, at: 0, dur: 0.09, peak: PEAK * 0.7, type: 'triangle' },
    { freq: 659.25, at: 0.075, dur: 0.09, peak: PEAK * 0.8, type: 'triangle' },
    { freq: 783.99, at: 0.15, dur: 0.09, peak: PEAK * 0.9, type: 'triangle' },
    { freq: 1046.5, at: 0.225, dur: 0.16, peak: PEAK, type: 'triangle' },
  ],
  // One short blip an octave above the room — noticeable, over in 110ms.
  messageIn: [{ freq: 987.77, at: 0, dur: 0.11, peak: PEAK * 0.55, type: 'sine' }],
};

/* ── Preference ───────────────────────────────────────────────────────────── */

/** `undefined` = not read yet. Cached so a hangup never touches storage. */
let enabledCache: boolean | undefined;

/** True unless the rep turned sounds off. Safe on the server and in private mode. */
export function soundsEnabled(): boolean {
  if (enabledCache !== undefined) return enabledCache;
  if (typeof window === 'undefined') return true;
  let value = true;
  try {
    value = window.localStorage.getItem(SOUNDS_ENABLED_KEY) !== '0';
  } catch {
    /* storage disabled: sounds stay on for this page */
  }
  enabledCache = value;
  return value;
}

/** Persist the Settings toggle. Takes effect on the very next sound. */
export function setSoundsEnabled(on: boolean): void {
  enabledCache = on;
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SOUNDS_ENABLED_KEY, on ? '1' : '0');
  } catch {
    /* private mode: the choice lives for this page only */
  }
}

/* ── Audio ────────────────────────────────────────────────────────────────── */

let ctx: AudioContext | null = null;
/** Set once the browser has proved it cannot play; stops us retrying per call. */
let unavailable = false;

/** The one context, created on first use. Null when the browser has no Web Audio. */
function audioContext(): AudioContext | null {
  if (ctx || unavailable) return ctx;
  if (typeof window === 'undefined') return null;
  try {
    // Safari still ships the prefixed constructor; neither is on `window`'s type.
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) {
      unavailable = true;
      return null;
    }
    ctx = new Ctor();
  } catch {
    unavailable = true;
    return null;
  }
  return ctx;
}

/** One note: an oscillator through its own short envelope, then thrown away. */
function schedule(context: AudioContext, note: Note, start: number): void {
  const osc = context.createOscillator();
  const gain = context.createGain();
  osc.type = note.type ?? 'sine';
  osc.frequency.setValueAtTime(note.freq, start);

  // A hard start or stop on a sine is a click. 10ms in, the rest fading out.
  const attack = Math.min(0.012, note.dur / 3);
  gain.gain.setValueAtTime(0.0001, start);
  gain.gain.linearRampToValueAtTime(note.peak, start + attack);
  // Exponential to a floor rather than to zero: ramping to 0 is a no-op in the
  // spec and leaves the note ringing at full volume until it is stopped.
  gain.gain.exponentialRampToValueAtTime(0.0001, start + note.dur);

  osc.connect(gain).connect(context.destination);
  osc.start(start);
  osc.stop(start + note.dur + 0.02);
  osc.onended = () => {
    try {
      osc.disconnect();
      gain.disconnect();
    } catch {
      /* already torn down */
    }
  };
}

/**
 * Play one of the four sounds. Never throws, never returns a promise to
 * forget: call sites are event handlers on a live call.
 */
export function playSound(name: SoundName): void {
  try {
    if (!soundsEnabled()) return;
    const context = audioContext();
    if (!context) return;
    // Created outside a gesture, or suspended after a tab slept: nudge it and
    // schedule anyway — the notes are absolute-timed, so a context that wakes
    // in a few milliseconds still plays them.
    if (context.state === 'suspended') void context.resume().catch(() => undefined);
    const start = context.currentTime + 0.01;
    for (const note of SEQUENCES[name]) schedule(context, note, start + note.at);
  } catch {
    /* a browser that refuses audio stays silent; a call is never interrupted */
  }
}

/* ── Disposition matching ─────────────────────────────────────────────────── */

/** "Appointment set", "appointment_booked", "Set Appt" — all of them. */
const APPOINTMENT = /\bappoint(?:ment)?\b|\bappt\b/i;

/**
 * Whether a wrap-up disposition means a booked appointment — the one outcome
 * worth a sound. Matched on the slug and the label, because an org renames the
 * label ("Appointment set" → "Booked") long before anyone touches the slug.
 */
export function isAppointmentDisposition(d: {
  slug?: string | null;
  name?: string | null;
}): boolean {
  const slug = (d.slug ?? '').replace(/[_-]+/g, ' ');
  return APPOINTMENT.test(slug) || APPOINTMENT.test(d.name ?? '');
}
