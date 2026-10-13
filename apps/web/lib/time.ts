/**
 * Time-zone helpers. The design surfaces every counterpart's *local* time —
 * a teammate's, a seller's — because calling someone at 6am loses the deal
 * and, for the seller, breaks the calling window.
 *
 * All of it is `Intl` against a live clock; nothing is precomputed, so a tab
 * left open overnight still shows the truth.
 */

/** "9:41 AM" in the given zone. */
export function tzTime(tz: string, now: number = Date.now()): string {
  try {
    return new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      timeZone: tz,
    }).format(new Date(now));
  } catch {
    return '—';
  }
}

/** Hour 0–23 in the given zone — the input to every window check. */
export function tzHour(tz: string, now: number = Date.now()): number {
  try {
    return Number(
      new Intl.DateTimeFormat('en-US', { hour: 'numeric', hour12: false, timeZone: tz }).format(
        new Date(now),
      ),
    );
  } catch {
    return 12;
  }
}

/** Short zone name, e.g. "CDT". */
export function tzAbbr(tz: string, now: number = Date.now()): string {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZoneName: 'short', timeZone: tz })
      .format(new Date(now))
      .split(', ')
      .pop()!;
  } catch {
    return '';
  }
}

/**
 * The city half of an IANA zone — "America/New_York" → "New York". The design
 * pairs this with the abbreviation ("EDT · New York"); the full identifier is
 * accurate but nobody reads a slash and an underscore at 10px.
 */
export function tzCity(tz: string): string {
  const last = tz.split('/').pop() ?? tz;
  return last.replace(/_/g, ' ');
}

/** The rep's own zone, straight from the browser. */
export function localZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    return 'UTC';
  }
}

/** Default calling window, in the *called party's* local time. */
export const SAFE_WINDOW = { startHour: 9, endHour: 20 } as const;

export interface CallWindow {
  safe: boolean;
  label: string;
  color: string;
  /** Where "now" sits across a 24h bar, as a percentage. */
  nowPercent: number;
}

/**
 * Whether it is a decent hour to call someone in `tz`. Outside the window is
 * "quiet hours" rather than an error — the rep can still dial, they just do
 * it knowingly.
 */
export function callWindow(tz: string, now: number = Date.now(), city?: string): CallWindow {
  const hour = tzHour(tz, now);
  const safe = hour >= SAFE_WINDOW.startHour && hour < SAFE_WINDOW.endHour;
  const minutes = new Date(now).getMinutes();
  return {
    safe,
    label: safe
      ? 'Safe to call — inside the 9a–8p window'
      : `Quiet hours${city ? ` in ${city}` : ''}`,
    color: safe ? 'var(--green)' : 'var(--amber)',
    nowPercent: ((hour + minutes / 60) / 24) * 100,
  };
}

/** m:ss for a live call timer. */
export function duration(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * "just now" / "5m ago" / "3h ago" / "2d ago", then a calendar date — the
 * grain a rep scanning a list actually reads. Null when nothing has happened.
 */
export function timeAgo(iso: string | null, now: number = Date.now()): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const seconds = Math.max(0, Math.round((now - then) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  const d = new Date(then);
  const sameYear = d.getFullYear() === new Date(now).getFullYear();
  return d.toLocaleDateString([], sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' });
}

/** (512) 555-0134 from any digit soup; partial input formats as you type. */
export function formatPhone(input: string): string {
  const n = input.replace(/\D/g, '').replace(/^1(?=\d{10})/, '');
  if (!n) return '';
  if (n.length <= 3) return n;
  if (n.length <= 6) return `(${n.slice(0, 3)}) ${n.slice(3)}`;
  return `(${n.slice(0, 3)}) ${n.slice(3, 6)}-${n.slice(6, 10)}`;
}

/** E.164 for the API, assuming NANP when no country code is given. */
export function toE164(input: string): string {
  const n = input.replace(/\D/g, '');
  if (!n) return '';
  if (input.trim().startsWith('+')) return `+${n}`;
  return n.length === 11 && n.startsWith('1') ? `+${n}` : `+1${n}`;
}

/** Area code → IANA zone, for showing a stranger's local time before pickup. */
const AREA_CODE_ZONES: Record<string, string> = {
  '212': 'America/New_York', '216': 'America/New_York', '404': 'America/New_York',
  '305': 'America/New_York', '617': 'America/New_York', '215': 'America/New_York',
  '312': 'America/Chicago', '512': 'America/Chicago', '214': 'America/Chicago',
  '713': 'America/Chicago', '615': 'America/Chicago', '913': 'America/Chicago',
  '303': 'America/Denver', '720': 'America/Denver', '801': 'America/Denver',
  '602': 'America/Phoenix', '480': 'America/Phoenix',
  '213': 'America/Los_Angeles', '415': 'America/Los_Angeles', '206': 'America/Los_Angeles',
  '503': 'America/Los_Angeles', '702': 'America/Los_Angeles',
};

/**
 * Best-effort zone for a number. Area codes moved around long before number
 * portability, so this is a hint for the UI, never a compliance decision.
 */
export function zoneForNumber(e164: string): string | null {
  const m = /^\+1(\d{3})/.exec(e164);
  return m ? (AREA_CODE_ZONES[m[1]!] ?? null) : null;
}
