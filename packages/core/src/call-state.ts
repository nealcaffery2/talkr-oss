/**
 * The call state machine. Pure functions only — the worker applies the result
 * to the database. Invariants (docs/telephony-events.md §4):
 *   1. status rank is monotonic; late/out-of-order events never regress it
 *   2. terminal is sticky for webhook-sourced events; only reconciliation may
 *      correct one terminal state to another
 *   3. timestamps are first-write-wins
 */

import type { CanonicalCallEvent } from './events.js';

export const CALL_STATUSES = [
  'queued',
  'initiated',
  'ringing',
  'in_progress',
  'completed',
  'no_answer',
  'busy',
  'failed',
  'canceled',
] as const;

export type CallStatus = (typeof CALL_STATUSES)[number];

export type FailureClass =
  | 'none'
  | 'seller_no_answer'
  | 'seller_busy'
  | 'carrier_failure'
  | 'platform_failure'
  | 'canceled';

const RANK: Record<CallStatus, number> = {
  queued: 0,
  initiated: 1,
  ringing: 2,
  in_progress: 3,
  completed: 4,
  no_answer: 4,
  busy: 4,
  failed: 4,
  canceled: 4,
};

export function isTerminal(status: CallStatus): boolean {
  return RANK[status] === 4;
}

const EVENT_TO_STATUS: Record<CanonicalCallEvent['type'], CallStatus> = {
  'call.initiated': 'initiated',
  'call.ringing': 'ringing',
  'call.answered': 'in_progress',
  'call.completed': 'completed',
  'call.no_answer': 'no_answer',
  'call.busy': 'busy',
  'call.failed': 'failed',
  'call.canceled': 'canceled',
};

/**
 * Twilio error codes in these ranges indicate our application/config failed
 * (bad TwiML, auth, webhook errors) rather than the carrier or the callee.
 * Everything else on a `failed` call is classed as carrier_failure.
 */
function classifyFailure(status: CallStatus, errorCode?: string): FailureClass {
  switch (status) {
    case 'no_answer':
      return 'seller_no_answer';
    case 'busy':
      return 'seller_busy';
    case 'canceled':
      return 'canceled';
    case 'failed': {
      if (!errorCode) return 'carrier_failure';
      const n = Number(errorCode);
      if ((n >= 11000 && n < 14000) || (n >= 20000 && n < 21000)) {
        return 'platform_failure';
      }
      return 'carrier_failure';
    }
    default:
      return 'none';
  }
}

export interface CallSnapshot {
  status: CallStatus;
  initiatedAt: Date | null;
  ringingAt: Date | null;
  answeredAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
  failureClass: FailureClass;
}

export interface CallStateChange {
  /** New status, present only when the status should actually change. */
  status?: CallStatus;
  initiatedAt?: Date;
  ringingAt?: Date;
  answeredAt?: Date;
  endedAt?: Date;
  durationSeconds?: number;
  failureClass?: FailureClass;
  failureDetail?: string;
  /** True when the event told us nothing new (safe no-op duplicate). */
  noop: boolean;
}

export type EventSource = 'webhook' | 'api' | 'client' | 'reconciliation' | 'system';

/**
 * Reduce one canonical call event against the current snapshot.
 * Returns the field changes to persist. Never throws on weird ordering —
 * weirdness is data, not an error.
 */
export function reduceCallEvent(
  snapshot: CallSnapshot,
  event: CanonicalCallEvent,
  source: EventSource = 'webhook',
): CallStateChange {
  const target = EVENT_TO_STATUS[event.type];
  const change: CallStateChange = { noop: true };
  const at = event.occurredAt;

  // Timestamps: first-write-wins, applied regardless of ordering.
  const stampFor: Partial<Record<CallStatus, keyof CallSnapshot>> = {
    initiated: 'initiatedAt',
    ringing: 'ringingAt',
    in_progress: 'answeredAt',
  };
  const stamp = stampFor[target];
  if (stamp && snapshot[stamp] == null) {
    if (stamp === 'initiatedAt') change.initiatedAt = at;
    else if (stamp === 'ringingAt') change.ringingAt = at;
    else if (stamp === 'answeredAt') change.answeredAt = at;
    change.noop = false;
  }
  if (isTerminal(target)) {
    if (snapshot.endedAt == null) {
      change.endedAt = at;
      change.noop = false;
    }
    if (snapshot.durationSeconds == null && event.data.durationSeconds != null) {
      change.durationSeconds = event.data.durationSeconds;
      change.noop = false;
    }
  }

  const currentRank = RANK[snapshot.status];
  const targetRank = RANK[target];

  if (isTerminal(snapshot.status)) {
    // Terminal is sticky for webhooks; reconciliation may correct terminal→terminal.
    if (source === 'reconciliation' && isTerminal(target) && target !== snapshot.status) {
      change.status = target;
      change.failureClass = classifyFailure(target, event.data.errorCode);
      if (event.data.errorCode) change.failureDetail = String(event.data.errorCode);
      change.noop = false;
    }
    return change;
  }

  if (targetRank > currentRank || (isTerminal(target) && !isTerminal(snapshot.status))) {
    change.status = target;
    change.noop = false;
    if (isTerminal(target)) {
      change.failureClass = classifyFailure(target, event.data.errorCode);
      if (event.data.errorCode) change.failureDetail = String(event.data.errorCode);
    }
  }

  return change;
}

/** Snapshot with everything unset — a freshly created call. */
export function newCallSnapshot(status: CallStatus = 'queued'): CallSnapshot {
  return {
    status,
    initiatedAt: null,
    ringingAt: null,
    answeredAt: null,
    endedAt: null,
    durationSeconds: null,
    failureClass: 'none',
  };
}
