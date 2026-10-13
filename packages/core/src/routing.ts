/**
 * Inbound routing decision engine (docs/inbound-routing.md §1).
 * Pure functions only — the TwiML route feeds it plain data and renders the
 * decision. Every decision is stored on the call so "why did it ring who it
 * rang" is always answerable.
 */

export interface BusinessHoursConfig {
  timezone?: string;
  /** Day key (mon..sun) → list of [start, end] "HH:MM" ranges. Absent day = closed. */
  businessHours?: Partial<Record<DayKey, Array<[string, string]>>>;
  voicemailGreeting?: string;
}

export type DayKey = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';

const DAY_KEYS: Record<string, DayKey> = {
  Mon: 'mon',
  Tue: 'tue',
  Wed: 'wed',
  Thu: 'thu',
  Fri: 'fri',
  Sat: 'sat',
  Sun: 'sun',
};

/**
 * No businessHours config = always open (a shop that answers when it can).
 * A configured schedule with an absent day = closed that day.
 */
export function isWithinBusinessHours(config: BusinessHoursConfig, now: Date): boolean {
  const hours = config.businessHours;
  if (!hours) return true;
  const timezone = config.timezone ?? 'America/New_York';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(now);
  const weekday = parts.find((p) => p.type === 'weekday')?.value ?? '';
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '00';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '00';
  const day = DAY_KEYS[weekday];
  if (!day) return true; // unparseable — fail open, never drop a call for a formatting bug
  const ranges = hours[day];
  if (!ranges || ranges.length === 0) return false;
  // Intl can render midnight as "24"; normalize.
  const hm = `${hour === '24' ? '00' : hour}:${minute}`;
  return ranges.some(([start, end]) => hm >= start && hm < end);
}

export interface PresenceInfo {
  status: 'available' | 'away' | 'offline';
  lastSeenAt: Date;
  /** Ring fairness inputs (docs/inbound-routing.md §9). */
  lastRungAt?: Date | null;
  lastCallEndedAt?: Date | null;
}

export const PRESENCE_FRESHNESS_MS = 90_000;

export function isAvailable(presence: PresenceInfo | undefined, now: Date): boolean {
  if (!presence) return false;
  return (
    presence.status === 'available' &&
    now.getTime() - presence.lastSeenAt.getTime() <= PRESENCE_FRESHNESS_MS
  );
}

export type QueueStrategy = 'simultaneous' | 'round_robin' | 'longest_idle';

export interface QueueConfig {
  id: string;
  strategy: QueueStrategy;
  memberUserIds: string[];
  maxWaitSeconds: number;
  waitMessage?: string | null;
  overflow: 'voicemail' | 'forward';
  overflowForwardE164?: string | null;
}

/** IVR digit-menu config stored on phone_numbers.ivr. */
export interface IvrConfig {
  greeting: string;
  options: Record<
    string,
    | { type: 'queue'; queueId: string }
    | { type: 'user'; userId: string }
    | { type: 'forward'; to: string }
    | { type: 'voicemail' }
  >;
}

// ---------------------------------------------------------------------------
// Last contact: ring the rep who most recently reached out to the caller
// (docs/inbound-routing.md §10). Outbound pools rotate caller IDs, so the
// number a seller calls back says nothing about who called them; the touch
// history does.
// ---------------------------------------------------------------------------

/** Default look-back for a callback to count as "about" an earlier touch. */
export const LAST_CONTACT_DEFAULT_DAYS = 14;
/** The longest window a flow target may ask for (and what is loaded for flows). */
export const LAST_CONTACT_MAX_DAYS = 90;

/** call/sms come from Talkr's own records; the rest are posted by a partner (POST /v1/outreach). */
export const OUTREACH_CHANNELS = ['rvm', 'email', 'other'] as const;
export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];
export type TouchChannel = 'call' | 'sms' | OutreachChannel;

/** One outbound touch to the caller's number by an org member. */
export interface LastTouch {
  userId: string;
  channel: TouchChannel;
  at: Date;
  /** Talkr call/message id, or the partner's ref for an outreach event. */
  ref: string | null;
}

/**
 * The most recent touch inside the window whose rep is eligible (available,
 * per the same presence rule every other target uses). A newer touch by a rep
 * who is offline yields to an older one by a rep who is in; nobody eligible
 * is null, and the caller falls through to the rest of the chain.
 */
export function pickLastContact(
  touches: readonly LastTouch[],
  opts: { now: Date; withinDays?: number; isEligible(userId: string): boolean },
): LastTouch | null {
  const days = opts.withinDays ?? LAST_CONTACT_DEFAULT_DAYS;
  const since = opts.now.getTime() - days * 86_400_000;
  const inWindow = touches
    .filter((t) => t.at.getTime() >= since && t.at.getTime() <= opts.now.getTime() + 60_000)
    .sort((a, b) => b.at.getTime() - a.at.getTime());
  return inWindow.find((t) => opts.isEligible(t.userId)) ?? null;
}

/** The wire shape of a touch on a call (raw.lastContact, the call DTOs). */
export interface LastContactDto {
  user_id: string;
  channel: TouchChannel;
  occurred_at: string;
  ref: string | null;
}

export function lastContactDto(t: LastTouch): LastContactDto {
  return { user_id: t.userId, channel: t.channel, occurred_at: t.at.toISOString(), ref: t.ref };
}

export interface RouteInput {
  now: Date;
  hours: BusinessHoursConfig;
  /**
   * The number has route_callbacks_to_last_contact on: try the rep who last
   * reached out to the caller before the lead owner.
   */
  routeToLastContact?: boolean;
  /** Touches to the caller's number (any order; filtered by the window here). */
  lastTouches?: readonly LastTouch[];
  lastContactWithinDays?: number;
  /** Lead owner recognized from the caller's number, if any. */
  leadOwnerUserId?: string | null;
  numberAssignedUserId?: string | null;
  /** Members of the number's assigned team (already resolved). */
  teamMemberUserIds?: string[];
  /** Queue the number feeds, with members resolved. */
  queue?: QueueConfig | null;
  forwardToE164?: string | null;
  presence: Map<string, PresenceInfo>;
}

export const SIMULTANEOUS_RING_CAP = 5;
export const DEFAULT_RING_TIMEOUT_SECONDS = 25;

export type RoutingDecision =
  | {
      action: 'ring_users';
      userIds: string[];
      timeoutSeconds: number;
      /** Which chain step produced the target — for the call journey. */
      reason: 'last_contact' | 'lead_owner' | 'number_assignee' | 'team';
      /** reason last_contact: the touch that picked the rep. */
      lastContact?: LastContactDto;
    }
  | { action: 'queue'; queueId: string; reason: 'queue' }
  | { action: 'forward'; to: string; reason: 'external_forward' }
  | { action: 'voicemail'; reason: 'after_hours' | 'no_agents' };

/**
 * Pick who a queue rings right now, per its strategy. Returns [] when no
 * member is currently available (the wait loop holds the caller and retries).
 */
export function pickQueueTargets(
  queue: Pick<QueueConfig, 'strategy' | 'memberUserIds'>,
  presence: Map<string, PresenceInfo>,
  now: Date,
): string[] {
  const availableMembers = queue.memberUserIds.filter((id) => isAvailable(presence.get(id), now));
  if (availableMembers.length === 0) return [];
  switch (queue.strategy) {
    case 'simultaneous':
      return availableMembers.slice(0, SIMULTANEOUS_RING_CAP);
    case 'round_robin': {
      // Fairness: the member rung longest ago (never-rung first).
      const sorted = [...availableMembers].sort(
        (a, b) => timeOrEpoch(presence.get(a)?.lastRungAt) - timeOrEpoch(presence.get(b)?.lastRungAt),
      );
      return [sorted[0]!];
    }
    case 'longest_idle': {
      // The member whose last call ended longest ago (never-called first).
      const sorted = [...availableMembers].sort(
        (a, b) =>
          timeOrEpoch(presence.get(a)?.lastCallEndedAt) - timeOrEpoch(presence.get(b)?.lastCallEndedAt),
      );
      return [sorted[0]!];
    }
  }
}

// -1 sentinel sorts never-rung/never-called members first without producing
// a NaN comparator (−Infinity − −Infinity) when two members tie on "never".
function timeOrEpoch(d: Date | null | undefined): number {
  return d ? d.getTime() : -1;
}

export function decideInboundRoute(input: RouteInput): RoutingDecision {
  const { now, presence } = input;

  if (!isWithinBusinessHours(input.hours, now)) {
    return { action: 'voicemail', reason: 'after_hours' };
  }

  const available = (userId: string | null | undefined): userId is string =>
    Boolean(userId && isAvailable(presence.get(userId), now));

  // A callback to a rotated pool number rings whoever last reached out —
  // first, when the number asks for it. Nobody eligible falls through.
  if (input.routeToLastContact && input.lastTouches && input.lastTouches.length > 0) {
    const touch = pickLastContact(input.lastTouches, {
      now,
      withinDays: input.lastContactWithinDays,
      isEligible: (id) => available(id),
    });
    if (touch) {
      return {
        action: 'ring_users',
        userIds: [touch.userId],
        timeoutSeconds: DEFAULT_RING_TIMEOUT_SECONDS,
        reason: 'last_contact',
        lastContact: lastContactDto(touch),
      };
    }
  }

  // CRM-aware owner-first always wins, even over a queue.
  if (available(input.leadOwnerUserId)) {
    return {
      action: 'ring_users',
      userIds: [input.leadOwnerUserId],
      timeoutSeconds: DEFAULT_RING_TIMEOUT_SECONDS,
      reason: 'lead_owner',
    };
  }

  // A queue with members owns the rest of the treatment (its wait loop holds
  // the caller even when nobody is available *right now*). A memberless queue
  // is configuration debris — fall through the chain instead of trapping the
  // caller in a hold loop nobody can answer.
  if (input.queue && input.queue.memberUserIds.length > 0) {
    return { action: 'queue', queueId: input.queue.id, reason: 'queue' };
  }

  if (available(input.numberAssignedUserId)) {
    return {
      action: 'ring_users',
      userIds: [input.numberAssignedUserId],
      timeoutSeconds: DEFAULT_RING_TIMEOUT_SECONDS,
      reason: 'number_assignee',
    };
  }

  const availableTeam = (input.teamMemberUserIds ?? [])
    .filter((id) => available(id))
    .slice(0, SIMULTANEOUS_RING_CAP);
  if (availableTeam.length > 0) {
    return {
      action: 'ring_users',
      userIds: availableTeam,
      timeoutSeconds: DEFAULT_RING_TIMEOUT_SECONDS,
      reason: 'team',
    };
  }

  if (input.forwardToE164) {
    return { action: 'forward', to: input.forwardToE164, reason: 'external_forward' };
  }

  return { action: 'voicemail', reason: 'no_agents' };
}
