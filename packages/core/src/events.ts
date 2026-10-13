/**
 * Canonical event model. Provider adapters translate webhook payloads into
 * these; nothing downstream of an adapter ever sees a provider field name.
 * See docs/telephony-events.md.
 */

/** `none` is a deployment with no carrier yet (VOICE_PROVIDER=none): boots, cannot call. */
export type ProviderName = 'telnyx' | 'podio' | 'test' | 'none';

export const CANONICAL_EVENT_TYPES = [
  'call.initiated',
  'call.ringing',
  'call.answered',
  'call.completed',
  'call.no_answer',
  'call.busy',
  'call.failed',
  'call.canceled',
  'recording.started',
  'recording.completed',
  'recording.failed',
  'message.received',
  'message.status',
  // Conference call control (hold / add call / merge / transfer)
  'conference.started',
  'conference.ended',
  'conference.participant_joined',
  'conference.participant_left',
  'conference.participant_hold',
  'conference.participant_unhold',
] as const;

export type CanonicalEventType = (typeof CANONICAL_EVENT_TYPES)[number];

export type CallTerminalEventType =
  | 'call.completed'
  | 'call.no_answer'
  | 'call.busy'
  | 'call.failed'
  | 'call.canceled';

export interface CanonicalEventBase {
  type: CanonicalEventType;
  provider: ProviderName;
  /** Provider-side object id (Twilio CallSid / RecordingSid / MessageSid). */
  providerObjectId: string;
  /** Best-known time the event occurred at the provider. */
  occurredAt: Date;
  /** Provider delivery sequence when available (Twilio SequenceNumber). */
  sequenceNumber?: number;
  /** Raw provider params, kept for call_events.payload. */
  raw: Record<string, unknown>;
}

export interface CanonicalCallEvent extends CanonicalEventBase {
  type:
    | 'call.initiated'
    | 'call.ringing'
    | 'call.answered'
    | CallTerminalEventType;
  data: {
    /** Our call id when the webhook URL carried it (statusCallback query param). */
    talkrCallId?: string;
    /** Which leg this event describes, when the URL carried it. */
    legRole?: 'client' | 'pstn';
    /** Parent provider call id (Twilio ParentCallSid) when present. */
    parentProviderCallId?: string;
    from?: string;
    to?: string;
    direction?: 'outbound' | 'inbound';
    durationSeconds?: number;
    /** Provider error code on failures (e.g. Twilio ErrorCode). */
    errorCode?: string;
    /** AMD result when machine detection ran (Twilio AnsweredBy). (Phase 5) */
    answeredBy?: string;
  };
}

export interface CanonicalRecordingEvent extends CanonicalEventBase {
  type: 'recording.started' | 'recording.completed' | 'recording.failed';
  data: {
    providerCallId: string;
    talkrCallId?: string;
    durationSeconds?: number;
    channels?: number;
    /** Provider-hosted media URL (mirrored to our storage by a job). */
    providerUrl?: string;
    errorCode?: string;
    source?: string;
  };
}

export interface CanonicalMessageEvent extends CanonicalEventBase {
  type: 'message.received' | 'message.status';
  data: {
    from?: string;
    to?: string;
    body?: string;
    status?: string;
    numMedia?: number;
    errorCode?: string;
    /** MMS media URLs (MediaUrl0..N), adapter-collected. (Phase 4) */
    mediaUrls?: string[];
    /** Provider-reported segment count. (Phase 4) */
    numSegments?: number;
  };
}

export interface CanonicalConferenceEvent extends CanonicalEventBase {
  type:
    | 'conference.started'
    | 'conference.ended'
    | 'conference.participant_joined'
    | 'conference.participant_left'
    | 'conference.participant_hold'
    | 'conference.participant_unhold';
  data: {
    /** Our call id, decoded from the room's friendly name. */
    talkrCallId?: string;
    /** Provider conference id (Twilio ConferenceSid). */
    providerConferenceId: string;
    /** Room name as the provider knows it (Twilio FriendlyName). */
    friendlyName?: string;
    /** The participant this event is about; absent on start/end. */
    providerParticipantId?: string;
    /** Why the room ended, when the provider says (Twilio ReasonConferenceEnded). */
    endReason?: string;
  };
}

export type CanonicalEvent =
  | CanonicalCallEvent
  | CanonicalRecordingEvent
  | CanonicalMessageEvent
  | CanonicalConferenceEvent;

export function isCallEvent(e: CanonicalEvent): e is CanonicalCallEvent {
  return e.type.startsWith('call.');
}

export function isRecordingEvent(e: CanonicalEvent): e is CanonicalRecordingEvent {
  return e.type.startsWith('recording.');
}

export function isMessageEvent(e: CanonicalEvent): e is CanonicalMessageEvent {
  return e.type.startsWith('message.');
}

export function isConferenceEvent(e: CanonicalEvent): e is CanonicalConferenceEvent {
  return e.type.startsWith('conference.');
}
