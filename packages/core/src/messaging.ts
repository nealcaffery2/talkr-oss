/**
 * SMS domain logic (docs/sms.md). Pure functions only — the worker and API
 * apply the results to the database.
 *   §2 message state machine (monotonic, out-of-order-safe, sticky terminal)
 *   §4 CTIA keyword parsing (STOP/HELP/START families)
 *   §4 quiet-hours send window (org timezone, Intl-based like routing.ts)
 *   §6 merge-field rendering for every outbound body — `{field}` and
 *      `{{field}}`, and never a brace left for a carrier to deliver
 */

export const MESSAGE_STATUSES = [
  'queued',
  'sending',
  'sent',
  'delivered',
  'undelivered',
  'failed',
  'received',
] as const;

export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export type MessageFailureClass = 'none' | 'carrier_failure' | 'platform_failure' | 'suppressed';

/** Outbound delivery ranks. `received` is inbound-only and terminal. */
const MESSAGE_RANK: Record<MessageStatus, number> = {
  queued: 0,
  sending: 1,
  sent: 2,
  delivered: 3,
  undelivered: 3,
  failed: 3,
  received: 3,
};

export function isTerminalMessageStatus(status: MessageStatus): boolean {
  return MESSAGE_RANK[status] === 3;
}

/**
 * Twilio message error codes: 21xxx are request/app-side misuse (e.g. 21610
 * "message to an unsubscribed recipient", 21211 invalid number at API time)
 * — our platform's fault or config, not the carrier. 30xxx are delivery-side
 * (30003 unreachable, 30005 unknown destination, 30006 landline, 30007
 * carrier filtering) — carrier territory. Absent/unknown codes on a failed
 * message default to carrier_failure.
 */
export function classifyMessageFailure(errorCode?: string | null): MessageFailureClass {
  if (!errorCode) return 'carrier_failure';
  const n = Number(errorCode);
  if (Number.isNaN(n)) return 'carrier_failure';
  if (n >= 21000 && n < 22000) return 'platform_failure';
  return 'carrier_failure';
}

export interface MessageSnapshot {
  status: MessageStatus;
  sentAt: Date | null;
  deliveredAt: Date | null;
  failedAt: Date | null;
  errorCode: string | null;
  failureClass: MessageFailureClass;
}

export interface MessageStatusEvent {
  status: MessageStatus;
  errorCode?: string;
  occurredAt: Date;
}

export interface MessageStateChange {
  /** New status, present only when the status should actually change. */
  status?: MessageStatus;
  sentAt?: Date;
  deliveredAt?: Date;
  failedAt?: Date;
  errorCode?: string;
  failureClass?: MessageFailureClass;
  /** True when the event told us nothing new (safe no-op duplicate). */
  noop: boolean;
}

/**
 * Reduce one delivery-status event against the current snapshot. Mirrors the
 * call state machine's invariants (docs/telephony-events.md §4):
 *   1. rank is monotonic — lower-or-equal-rank events never regress status
 *   2. terminal (delivered/undelivered/failed) is sticky
 *   3. timestamps are first-write-wins regardless of arrival order
 * Never throws on weird ordering — weirdness is data, not an error.
 */
export function reduceMessageStatus(
  snapshot: MessageSnapshot,
  event: MessageStatusEvent,
): MessageStateChange {
  const change: MessageStateChange = { noop: true };
  const at = event.occurredAt;

  // First-write-wins timestamps, applied regardless of ordering.
  if (event.status === 'sent' && snapshot.sentAt == null) {
    change.sentAt = at;
    change.noop = false;
  }
  if (event.status === 'delivered' && snapshot.deliveredAt == null) {
    change.deliveredAt = at;
    change.noop = false;
  }
  if ((event.status === 'undelivered' || event.status === 'failed') && snapshot.failedAt == null) {
    change.failedAt = at;
    change.noop = false;
  }

  if (isTerminalMessageStatus(snapshot.status)) {
    // Terminal is sticky: duplicates and stragglers backfill timestamps only.
    return change;
  }

  if (MESSAGE_RANK[event.status] > MESSAGE_RANK[snapshot.status]) {
    change.status = event.status;
    change.noop = false;
    if (event.status === 'undelivered' || event.status === 'failed') {
      change.errorCode = event.errorCode;
      change.failureClass = classifyMessageFailure(event.errorCode);
    }
  }

  return change;
}

// ---------------------------------------------------------------------------
// CTIA keywords (docs/sms.md §4)
// ---------------------------------------------------------------------------

export type SmsKeyword = 'stop' | 'help' | 'start';

const STOP_KEYWORDS = new Set(['stop', 'stopall', 'unsubscribe', 'cancel', 'end', 'quit']);
const HELP_KEYWORDS = new Set(['help', 'info']);
const START_KEYWORDS = new Set(['start', 'yes', 'unstop']);

/**
 * Keyword handling matches carrier behavior: the trimmed message must BE the
 * keyword (case-insensitive; trailing '.'/'!' tolerated). "please stop
 * texting me" is a human sentence, not an opt-out keyword — a rep reads it.
 */
export function parseSmsKeyword(body: string | null | undefined): SmsKeyword | null {
  if (!body) return null;
  const word = body.trim().replace(/[.!]+$/, '').toLowerCase();
  if (STOP_KEYWORDS.has(word)) return 'stop';
  if (HELP_KEYWORDS.has(word)) return 'help';
  if (START_KEYWORDS.has(word)) return 'start';
  return null;
}

// ---------------------------------------------------------------------------
// Quiet hours (docs/sms.md §4) — org-timezone send window
// ---------------------------------------------------------------------------

export interface SmsSendWindowConfig {
  timezone?: string;
  /** "HH:MM" inclusive start of the allowed send window (default 08:00). */
  smsSendWindowStart?: string;
  /** "HH:MM" exclusive end of the allowed send window (default 21:00). */
  smsSendWindowEnd?: string;
}

export const DEFAULT_SMS_SEND_WINDOW_START = '08:00';
export const DEFAULT_SMS_SEND_WINDOW_END = '21:00';

/**
 * True when `now` falls inside the org's allowed SMS send window. Uses the
 * same Intl approach (and the same default timezone) as
 * `isWithinBusinessHours` in routing.ts. Wrap-around windows (start > end,
 * e.g. 20:00–02:00) are supported; start === end means always allowed.
 * Unparseable timezone output fails open — compliance auto-replies bypass
 * this function entirely, and a formatting bug must not block a rep replying
 * to an active seller conversation. Quiet hours are evaluated in the ORG's
 * timezone (documented assumption — docs/sms.md §8.2).
 */
export function isWithinSmsSendWindow(config: SmsSendWindowConfig, now: Date): boolean {
  const timezone = config.timezone ?? 'America/New_York';
  const start = config.smsSendWindowStart ?? DEFAULT_SMS_SEND_WINDOW_START;
  const end = config.smsSendWindowEnd ?? DEFAULT_SMS_SEND_WINDOW_END;
  if (start === end) return true;
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
  } catch {
    return true; // invalid configured timezone — fail open, surfaced by admin UI later
  }
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  // Intl can render midnight as "24"; normalize.
  const hm = `${hour === '24' ? '00' : hour}:${minute}`;
  if (start < end) return hm >= start && hm < end;
  return hm >= start || hm < end; // wrap-around window
}

/**
 * The next instant at-or-after `now` that falls inside the send window, or
 * null when `now` is already inside it (nothing to defer to). Used by
 * sequences to park a quiet-hours-blocked SMS step until the window opens
 * (docs/sequences.md §6) instead of skipping it the way event workflows do.
 *
 * Walks forward minute by minute in the org's zone (at most 24h + 1, so a DST
 * fold or gap cannot strand it) and returns the first allowed minute, on the
 * minute. Fails open like isWithinSmsSendWindow: an invalid timezone means
 * "inside", hence null.
 */
export function nextSmsSendWindowStart(config: SmsSendWindowConfig, now: Date): Date | null {
  if (isWithinSmsSendWindow(config, now)) return null;
  const floor = new Date(now);
  floor.setUTCSeconds(0, 0);
  for (let i = 1; i <= 24 * 60 + 1; i++) {
    const candidate = new Date(floor.getTime() + i * 60_000);
    if (isWithinSmsSendWindow(config, candidate)) return candidate;
  }
  return null; // unreachable for any well-formed window; treat as open
}


// ---------------------------------------------------------------------------
// Merge fields (docs/sms.md §6)
//
// One grammar for every outbound body — a typed composer message, a template,
// a sequence step. A message that reaches a carrier with `{first_name}` still
// in it is the worst bug this system can ship, so rendering happens on EVERY
// send path and the renderer is total: every placeholder it recognizes is
// replaced, whether or not anyone knows the field.
// ---------------------------------------------------------------------------

/**
 * Everything an SMS body may carry: the sequence/script set (so a body written
 * in the sequence builder renders identically here) plus `contact_name` and
 * `org_name`, which Phase 4 templates already used.
 *
 * `company` is OUR company, not the contact's — that is what it means in
 * scripts.ts and workflow-engine.ts, and one grammar cannot have two meanings.
 * `org_name` is its alias. `phone` is the contact's number, formatted the way
 * a person writes it, matching `GET /v1/call-context`.
 */
export const MESSAGE_MERGE_FIELDS = [
  'first_name',
  'name',
  'contact_name',
  'address',
  'city',
  'state',
  'postal_code',
  'company',
  'rep_name',
  'rep_first_name',
  'org_name',
  'phone',
] as const;
export type MessageMergeField = (typeof MESSAGE_MERGE_FIELDS)[number];
export type MessageMergeVars = Record<MessageMergeField, string>;

/**
 * Single or double braces, optional inner whitespace: `{name}`, `{{ name }}`,
 * and the mismatched `{name}}` a human types at 11pm. Identical to the script
 * and sequence grammars on purpose. A field name is `[A-Za-z0-9_]+` — braces
 * around anything else (`{50%}`) are the rep's own text, not merge syntax,
 * and are left exactly as typed.
 */
const MESSAGE_MERGE_RE = /\{\{?\s*([a-zA-Z0-9_]+)\s*\}?\}/g;

export function isMessageMergeField(name: string): name is MessageMergeField {
  return (MESSAGE_MERGE_FIELDS as readonly string[]).includes(name.toLowerCase());
}

export function emptyMessageMergeVars(): MessageMergeVars {
  return {
    first_name: '',
    name: '',
    contact_name: '',
    address: '',
    city: '',
    state: '',
    postal_code: '',
    company: '',
    rep_name: '',
    rep_first_name: '',
    org_name: '',
    phone: '',
  };
}

/** Every distinct field a body references, lowercased, in order of appearance. */
export function findMessageMergeFields(body: string): string[] {
  const seen: string[] = [];
  for (const m of body.matchAll(MESSAGE_MERGE_RE)) {
    const name = m[1]!.toLowerCase();
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

/** The referenced fields nobody knows — a template write rejects on these. */
export function unknownMessageMergeFields(body: string): string[] {
  return findMessageMergeFields(body).filter((f) => !isMessageMergeField(f));
}

/**
 * Render a body for sending. Total by construction:
 *   - a known field with a value → the value
 *   - a known field with no value → ''
 *   - a field nobody knows       → ''   (never the raw braces)
 *
 * The gap a blank field leaves is tidied: runs of spaces mid-line collapse, a
 * space stranded before punctuation is dropped, and the result is trimmed, so
 * "Hi {first_name}, about {address}." with neither value reads "Hi, about."
 * rather than "Hi , about  .". Newlines survive. The tidy-up runs ONLY when
 * something was actually substituted — a body with no merge fields comes back
 * byte-identical, because reformatting text we did not touch is not ours to
 * do.
 *
 * Loud failure for unknown fields lives at template-WRITE time (POST/PATCH
 * /v1/message-templates), not here: mid-conversation is the worst possible
 * moment to discover a typo in a body somebody else saved last month.
 */
export function renderMessageBody(
  body: string,
  vars: Partial<Record<string, string | null | undefined>>,
): string {
  let substituted = false;
  const rendered = body.replace(MESSAGE_MERGE_RE, (_match, name: string) => {
    substituted = true;
    return vars[name.toLowerCase()] ?? '';
  });
  if (!substituted) return body;
  return rendered
    .replace(/(?<=\S)[ \t]{2,}/g, ' ')
    .replace(/(?<=\S) +([,.!?;:])/g, '$1')
    .trim();
}
