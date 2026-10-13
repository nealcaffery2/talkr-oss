/**
 * Conference call control — hold, add call, merge, warm/blind transfer.
 *
 * A browser call runs inside a per-call provider conference rather than a
 * plain two-leg bridge, because a bridge cannot hold one party, add a third,
 * or hand the customer to a teammate. The rep's browser leg and the customer's
 * PSTN leg are both *participants* of the room named by `conferenceRoomName`;
 * every control below is an operation on a participant, never on the call.
 *
 * Pure functions only (docs/architecture.md §4) — the server applies results.
 */

import type { AddParticipantParams, ParticipantPatch } from './providers.js';

export const PARTICIPANT_ROLES = ['agent', 'customer', 'teammate', 'external', 'supervisor'] as const;

/**
 * `agent` is the rep who owns the call; `customer` the party the call is with;
 * `teammate` another platform user dialed into the room (transfer target or
 * conference guest); `external` any other PSTN number added mid-call;
 * `supervisor` a manager monitoring the call (listen / whisper / barge) —
 * never a guest for merge or transfer, and never the one who ends the room.
 */
export type ParticipantRole = (typeof PARTICIPANT_ROLES)[number];

export const PARTICIPANT_STATES = ['ringing', 'joined', 'on_hold', 'left'] as const;
export type ParticipantState = (typeof PARTICIPANT_STATES)[number];

export const TRANSFER_MODES = ['warm', 'blind'] as const;

/**
 * `warm` announces first: the target joins while the customer is held, the rep
 * talks to them, and only then does the rep leave. `blind` hands the customer
 * over immediately and drops the rep in the same operation.
 */
export type TransferMode = (typeof TRANSFER_MODES)[number];

export interface ParticipantSnapshot {
  /** Provider participant id (Twilio CallSid of that participant's leg). */
  providerParticipantId: string;
  role: ParticipantRole;
  state: ParticipantState;
}

/**
 * Deterministic room name. TwiML (which names the room the browser joins) and
 * the REST participant calls (which address the room by name) are issued from
 * different requests, so the name must be derivable from the call id alone.
 */
export function conferenceRoomName(callId: string): string {
  return `talkr-${callId}`;
}

/** The room name a conference-status webhook refers to, or null if not ours. */
export function callIdFromRoomName(friendlyName: string): string | null {
  return friendlyName.startsWith('talkr-') ? friendlyName.slice('talkr-'.length) : null;
}

// ---------------------------------------------------------------------------
// Control guards
// ---------------------------------------------------------------------------

export type ControlRefusal =
  | 'call_not_active'
  | 'no_customer'
  | 'no_agent'
  | 'already_held'
  | 'not_held'
  | 'nothing_to_merge'
  | 'already_merged'
  | 'participant_not_found'
  | 'cannot_remove_agent';

export interface ControlContext {
  /** The call is answered and not yet terminal. */
  callActive: boolean;
  participants: ParticipantSnapshot[];
}

function present(ctx: ControlContext, role: ParticipantRole): ParticipantSnapshot[] {
  return ctx.participants.filter((p) => p.role === role && p.state !== 'left');
}

/** Everyone who is on the line and not held — i.e. can hear each other. */
export function liveParticipants(ctx: ControlContext): ParticipantSnapshot[] {
  return ctx.participants.filter((p) => p.state === 'joined');
}

/**
 * True once a third party is in the room *and* nobody is held — the state the
 * UI calls "merged". Holding the customer to consult privately un-merges.
 */
export function isMerged(ctx: ControlContext): boolean {
  const live = liveParticipants(ctx).filter((p) => p.role !== 'supervisor');
  return live.length >= 3 && live.some((p) => p.role === 'customer');
}

export function canHold(ctx: ControlContext): ControlRefusal | null {
  if (!ctx.callActive) return 'call_not_active';
  const customer = present(ctx, 'customer');
  if (customer.length === 0) return 'no_customer';
  if (customer.every((p) => p.state === 'on_hold')) return 'already_held';
  return null;
}

export function canUnhold(ctx: ControlContext): ControlRefusal | null {
  if (!ctx.callActive) return 'call_not_active';
  const customer = present(ctx, 'customer');
  if (customer.length === 0) return 'no_customer';
  if (customer.every((p) => p.state !== 'on_hold')) return 'not_held';
  return null;
}

export function canAddParticipant(ctx: ControlContext): ControlRefusal | null {
  if (!ctx.callActive) return 'call_not_active';
  if (present(ctx, 'agent').length === 0) return 'no_agent';
  return null;
}

/**
 * Merge = un-hold everyone so the added party and the customer hear each
 * other. It needs a third party present and at least one held participant.
 */
export function canMerge(ctx: ControlContext): ControlRefusal | null {
  if (!ctx.callActive) return 'call_not_active';
  const third = [...present(ctx, 'teammate'), ...present(ctx, 'external')];
  if (third.length === 0) return 'nothing_to_merge';
  if (isMerged(ctx)) return 'already_merged';
  return null;
}

export function canTransfer(ctx: ControlContext): ControlRefusal | null {
  if (!ctx.callActive) return 'call_not_active';
  if (present(ctx, 'customer').length === 0) return 'no_customer';
  return null;
}

export function canRemove(ctx: ControlContext, providerParticipantId: string): ControlRefusal | null {
  const target = ctx.participants.find(
    (p) => p.providerParticipantId === providerParticipantId && p.state !== 'left',
  );
  if (!target) return 'participant_not_found';
  // Dropping the agent is "leave the call", a different operation with
  // different consequences for the room; it never happens through remove.
  if (target.role === 'agent') return 'cannot_remove_agent';
  return null;
}

// ---------------------------------------------------------------------------
// Supervision
// ---------------------------------------------------------------------------

export const MONITOR_MODES = ['listen', 'whisper', 'barge'] as const;

/**
 * `listen` hears everyone and is heard by no one; `whisper` is heard by the
 * rep only (provider coaching); `barge` is a normal, unmuted party.
 */
export type MonitorMode = (typeof MONITOR_MODES)[number];

/**
 * The participant fields a mode maps to. `muted` and `coaching` are always
 * set, so one patch both creates the supervisor's leg and switches it in
 * place — whisper → listen must turn coaching *off*, not leave it alone.
 */
export function monitorPatch(mode: MonitorMode, agentParticipantId: string): ParticipantPatch {
  if (mode === 'whisper') return { muted: false, coaching: true, callSidToCoach: agentParticipantId };
  return { muted: mode === 'listen', coaching: false };
}

/** Monitoring someone else's live call. Your own call is not supervision. */
export function canMonitor(
  ctx: ControlContext,
  callUserId: string | null,
  actorUserId: string,
): ControlRefusal | 'own_call' | null {
  if (callUserId === actorUserId) return 'own_call';
  if (!ctx.callActive) return 'call_not_active';
  if (present(ctx, 'agent').length === 0) return 'no_agent';
  return null;
}

// ---------------------------------------------------------------------------
// Participant state reduction
// ---------------------------------------------------------------------------

export type ParticipantEventType =
  | 'conference.participant_joined'
  | 'conference.participant_left'
  | 'conference.participant_hold'
  | 'conference.participant_unhold';

export interface ParticipantStateChange {
  state?: ParticipantState;
  joinedAt?: Date;
  leftAt?: Date;
  /** True when the event told us nothing new (safe no-op duplicate). */
  noop: boolean;
}

const TERMINAL: ParticipantState = 'left';

/**
 * Reduce one conference participant event. `left` is sticky — a late join or
 * hold callback for a participant who already dropped never resurrects them,
 * mirroring the sticky-terminal rule of the call state machine
 * (docs/telephony-events.md §4).
 */
export function reduceParticipantEvent(
  current: ParticipantState,
  type: ParticipantEventType,
  occurredAt: Date,
): ParticipantStateChange {
  const change: ParticipantStateChange = { noop: true };
  if (current === TERMINAL) return change;

  switch (type) {
    case 'conference.participant_joined':
      if (current !== 'joined') {
        change.state = 'joined';
        change.noop = false;
      }
      // First join wins; a rejoin after hold does not move the timestamp.
      if (current === 'ringing') change.joinedAt = occurredAt;
      return change;

    case 'conference.participant_left':
      change.state = 'left';
      change.leftAt = occurredAt;
      change.noop = false;
      return change;

    case 'conference.participant_hold':
      if (current !== 'on_hold') {
        change.state = 'on_hold';
        change.noop = false;
      }
      return change;

    case 'conference.participant_unhold':
      if (current !== 'joined') {
        change.state = 'joined';
        change.noop = false;
      }
      return change;
  }
}

// ---------------------------------------------------------------------------
// Dialing the customer into the room
// ---------------------------------------------------------------------------

/**
 * Call states in which the customer must not be dialed in: the rep hung up, or
 * the call failed, before the dial was attempted. Dialing then would ring a
 * seller into an empty room.
 */
export const CUSTOMER_DIAL_SKIP_STATUSES = ['completed', 'canceled', 'failed'] as const;

export interface CustomerDialCandidate {
  status: string;
  endedAt: Date | null;
}

/** Is this call still worth ringing the customer for? */
export function shouldDialCustomer(call: CustomerDialCandidate): boolean {
  if (call.endedAt !== null) return false;
  return !(CUSTOMER_DIAL_SKIP_STATUSES as readonly string[]).includes(call.status);
}

export interface CustomerDialTarget {
  callId: string;
  /** The org number the seller sees. */
  fromNumber: string;
  toNumber: string;
  /** `PUBLIC_BASE_URL`, without a trailing slash. */
  publicBaseUrl: string;
}

/**
 * The exact participant-add that creates the customer leg.
 *
 * The dial is attempted twice over: inline on the TwiML path (so the seller's
 * phone rings within a second of the rep's leg connecting) and again from the
 * queued fallback job if that inline attempt failed. Both go through this one
 * function so the two paths cannot drift — identical status-callback URL,
 * identical `endConferenceOnExit`, so downstream event handling never has to
 * know which one placed the call.
 *
 * `endConferenceOnExit` is true for the customer because the customer leaving
 * *is* the end of the call; that is the whole point of it.
 */
export function customerParticipantParams(target: CustomerDialTarget): AddParticipantParams {
  return {
    roomName: conferenceRoomName(target.callId),
    callerId: target.fromNumber,
    to: target.toNumber,
    statusCallbackUrl: `${target.publicBaseUrl}/webhooks/telnyx/voice-status?call=${target.callId}&leg=pstn`,
    endConferenceOnExit: true,
  };
}
