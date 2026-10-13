/**
 * Telnyx TeXML webhook payloads → canonical events (docs/telephony-events.md §2).
 *
 * TeXML status callbacks are form-encoded and reuse TwiML's parameter names
 * (`CallSid`, `CallStatus`, `RecordingSid`, …) — that compatibility is the
 * whole point of TeXML, and it is why this file mirrors the Twilio adapter's
 * normalizer so closely rather than inventing a second vocabulary.
 *
 * It is a separate file rather than shared code on purpose: TeXML is a
 * compatibility layer over a different platform, so the two are expected to
 * drift. Where a difference is known it is called out inline; where a shape is
 * unverified against a live account it is marked LIVE-CHECK so the first real
 * call tells us rather than a silent mis-parse.
 */

import { callIdFromRoomName } from '@talkr/core';
import type {
  CanonicalCallEvent,
  CanonicalConferenceEvent,
  CanonicalEvent,
  CanonicalMessageEvent,
  CanonicalRecordingEvent,
} from '@talkr/core';

export type TelnyxEndpoint =
  | 'voice-status'
  | 'dial-complete'
  | 'recording-status'
  | 'inbound-voice'
  | 'twiml-outbound'
  | 'voicemail-complete'
  | 'queue-wait'
  | 'ivr-select'
  | 'inbound-sms'
  | 'sms-status'
  | 'campaign-answer'
  | 'campaign-bridge-complete'
  | 'conference-status'
  | 'conference-join';

type P = Record<string, string>;

const CALL_STATUS_TO_EVENT: Record<string, CanonicalCallEvent['type']> = {
  queued: 'call.initiated',
  initiated: 'call.initiated',
  ringing: 'call.ringing',
  'in-progress': 'call.answered',
  answered: 'call.answered',
  completed: 'call.completed',
  busy: 'call.busy',
  'no-answer': 'call.no_answer',
  failed: 'call.failed',
  canceled: 'call.canceled',
};

const CONFERENCE_EVENT_MAP: Record<string, CanonicalConferenceEvent['type']> = {
  'conference-start': 'conference.started',
  'conference-end': 'conference.ended',
  'participant-join': 'conference.participant_joined',
  'participant-leave': 'conference.participant_left',
  'participant-hold': 'conference.participant_hold',
  'participant-unhold': 'conference.participant_unhold',
};

const MESSAGE_STATUS_MAP: Record<string, string> = {
  accepted: 'queued',
  queued: 'queued',
  sending: 'sending',
  sent: 'sent',
  delivered: 'delivered',
  undelivered: 'undelivered',
  failed: 'failed',
  // Telnyx's messaging vocabulary also surfaces these on TeXML callbacks.
  'delivery_failed': 'failed',
  'delivery_unconfirmed': 'sent',
};

function occurredAt(params: P): Date {
  const t = params.Timestamp ? new Date(params.Timestamp) : new Date();
  return Number.isNaN(t.getTime()) ? new Date() : t;
}

function num(value: string | undefined): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isNaN(n) ? undefined : n;
}

function callData(params: P): CanonicalCallEvent['data'] {
  return {
    talkrCallId: params.call || undefined,
    legRole: params.leg === 'client' || params.leg === 'pstn' ? params.leg : undefined,
    parentProviderCallId: params.ParentCallSid || undefined,
    from: params.From || undefined,
    to: params.To || undefined,
    direction: params.Direction?.startsWith('outbound')
      ? 'outbound'
      : params.Direction === 'inbound'
        ? 'inbound'
        : undefined,
    durationSeconds: num(params.CallDuration),
    errorCode: params.ErrorCode || undefined,
    answeredBy: params.AnsweredBy || undefined,
  };
}

function mediaUrls(params: P): string[] | undefined {
  const n = num(params.NumMedia);
  if (!n || n <= 0) return undefined;
  const urls: string[] = [];
  for (let i = 0; i < n; i++) {
    const url = params[`MediaUrl${i}`];
    if (url) urls.push(url);
  }
  return urls.length > 0 ? urls : undefined;
}

/**
 * Idempotency keys (docs/telephony-events.md §3). Namespaced by provider so a
 * Telnyx delivery can never collide with a Twilio one during a migration where
 * both adapters are live at once.
 */
export function idempotencyKeyFor(endpoint: TelnyxEndpoint, params: P): string {
  switch (endpoint) {
    case 'voice-status':
      return `telnyx:voice-status:${params.CallSid}:${params.CallStatus}:${params.SequenceNumber ?? 'x'}`;
    case 'dial-complete':
      return `telnyx:dial-complete:${params.CallSid}:${params.DialCallSid ?? 'x'}:${params.DialCallStatus ?? 'x'}`;
    case 'recording-status':
      return `telnyx:recording:${params.RecordingSid}:${params.RecordingStatus}`;
    case 'inbound-voice':
      return `telnyx:inbound-voice:${params.CallSid}`;
    case 'twiml-outbound':
      return `telnyx:twiml-outbound:${params.CallSid}`;
    case 'voicemail-complete':
      return `telnyx:voicemail-complete:${params.CallSid}`;
    case 'queue-wait':
      return `telnyx:queue-wait:${params.CallSid}:${params.n ?? 'x'}:${params.DialCallStatus ?? 'x'}`;
    case 'ivr-select':
      return `telnyx:ivr-select:${params.CallSid}:${params.Digits ?? 'none'}`;
    case 'inbound-sms':
      return `telnyx:inbound-sms:${params.MessageSid}`;
    case 'sms-status':
      return `telnyx:sms-status:${params.MessageSid}:${params.MessageStatus}`;
    case 'campaign-answer':
      return `telnyx:campaign-answer:${params.CallSid}`;
    case 'campaign-bridge-complete':
      return `telnyx:campaign-bridge-complete:${params.CallSid}:${params.DialCallStatus ?? 'x'}`;
    case 'conference-status':
      return `telnyx:conference-status:${params.ConferenceSid}:${params.StatusCallbackEvent}:${params.CallSid ?? 'x'}:${params.SequenceNumber ?? 'x'}`;
    case 'conference-join':
      return `telnyx:conference-join:${params.CallSid}`;
  }
}

export function normalizeTelnyxWebhook(endpoint: TelnyxEndpoint, params: P): CanonicalEvent[] {
  switch (endpoint) {
    case 'voice-status': {
      const type = CALL_STATUS_TO_EVENT[params.CallStatus ?? ''];
      if (!type || !params.CallSid) return [];
      const event: CanonicalCallEvent = {
        type,
        provider: 'telnyx',
        providerObjectId: params.CallSid,
        occurredAt: occurredAt(params),
        sequenceNumber: num(params.SequenceNumber),
        data: callData(params),
        raw: params,
      };
      return [event];
    }

    case 'dial-complete': {
      const type = CALL_STATUS_TO_EVENT[params.DialCallStatus ?? ''];
      if (!type || !params.DialCallSid) return [];
      const event: CanonicalCallEvent = {
        type,
        provider: 'telnyx',
        providerObjectId: params.DialCallSid,
        occurredAt: occurredAt(params),
        data: {
          ...callData(params),
          legRole: 'pstn',
          parentProviderCallId: params.CallSid || undefined,
          durationSeconds: num(params.DialCallDuration),
        },
        raw: params,
      };
      return [event];
    }

    case 'recording-status': {
      if (!params.RecordingSid || !params.CallSid) return [];
      const statusMap: Record<string, CanonicalRecordingEvent['type']> = {
        'in-progress': 'recording.started',
        completed: 'recording.completed',
        failed: 'recording.failed',
        absent: 'recording.failed',
      };
      const type = statusMap[params.RecordingStatus ?? ''];
      if (!type) return [];
      const event: CanonicalRecordingEvent = {
        type,
        provider: 'telnyx',
        providerObjectId: params.RecordingSid,
        occurredAt: params.RecordingStartTime
          ? occurredAt({ Timestamp: params.RecordingStartTime })
          : new Date(),
        data: {
          providerCallId: params.CallSid,
          talkrCallId: params.call || undefined,
          durationSeconds: num(params.RecordingDuration),
          channels: num(params.RecordingChannels),
          providerUrl: params.RecordingUrl || undefined,
          errorCode:
            params.RecordingStatus === 'absent' ? 'absent' : params.ErrorCode || undefined,
          source: params.RecordingSource || undefined,
        },
        raw: params,
      };
      return [event];
    }

    case 'inbound-voice': {
      if (!params.CallSid) return [];
      const event: CanonicalCallEvent = {
        type: 'call.initiated',
        provider: 'telnyx',
        providerObjectId: params.CallSid,
        occurredAt: occurredAt(params),
        data: { ...callData(params), direction: 'inbound' },
        raw: params,
      };
      return [event];
    }

    case 'conference-status': {
      const type = CONFERENCE_EVENT_MAP[params.StatusCallbackEvent ?? ''];
      if (!type || !params.ConferenceSid) return [];
      // The room's friendly name carries our call id; conference callbacks
      // have no query string of ours to read it from.
      const friendlyName = params.FriendlyName || undefined;
      const event: CanonicalConferenceEvent = {
        type,
        provider: 'telnyx',
        providerObjectId: params.ConferenceSid,
        occurredAt: occurredAt(params),
        sequenceNumber: num(params.SequenceNumber),
        data: {
          talkrCallId: friendlyName ? (callIdFromRoomName(friendlyName) ?? undefined) : undefined,
          providerConferenceId: params.ConferenceSid,
          friendlyName,
          providerParticipantId: params.CallSid || undefined,
          endReason: params.ReasonConferenceEnded || undefined,
        },
        raw: params,
      };
      return [event];
    }

    case 'twiml-outbound':
    case 'voicemail-complete':
    case 'queue-wait':
    case 'ivr-select':
    case 'campaign-answer':
    case 'campaign-bridge-complete':
    case 'conference-join':
      // Call-control endpoints do their own synchronous state writes; the
      // async pipeline stores the raw delivery but emits nothing.
      return [];

    case 'inbound-sms': {
      if (!params.MessageSid || !params.From || !params.To) return [];
      const event: CanonicalMessageEvent = {
        type: 'message.received',
        provider: 'telnyx',
        providerObjectId: params.MessageSid,
        occurredAt: new Date(),
        data: {
          from: params.From,
          to: params.To,
          body: params.Body ?? '',
          status: 'received',
          numMedia: num(params.NumMedia),
          mediaUrls: mediaUrls(params),
          numSegments: num(params.NumSegments),
        },
        raw: params,
      };
      return [event];
    }

    case 'sms-status': {
      if (!params.MessageSid) return [];
      const status = MESSAGE_STATUS_MAP[params.MessageStatus ?? ''];
      if (!status) return [];
      const event: CanonicalMessageEvent = {
        type: 'message.status',
        provider: 'telnyx',
        providerObjectId: params.MessageSid,
        occurredAt: new Date(),
        data: {
          from: params.From || undefined,
          to: params.To || undefined,
          status,
          errorCode: params.ErrorCode || undefined,
          numSegments: num(params.NumSegments),
        },
        raw: params,
      };
      return [event];
    }
  }
}
