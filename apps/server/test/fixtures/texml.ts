/**
 * Realistic-shape Twilio webhook payload factories (field names and value
 * formats match production captures; values sanitized). When Twilio's
 * payloads change, update these from captured events — never hand-invent.
 */

export function voiceStatus(params: {
  callSid: string;
  status: 'initiated' | 'ringing' | 'in-progress' | 'completed' | 'busy' | 'no-answer' | 'failed' | 'canceled';
  sequence: number;
  from?: string;
  to?: string;
  parentCallSid?: string;
  duration?: number;
  errorCode?: string;
  timestamp?: Date;
  direction?: 'outbound-dial' | 'inbound';
}): Record<string, string> {
  const p: Record<string, string> = {
    AccountSid: 'ACtest00000000000000000000000000',
    CallSid: params.callSid,
    CallStatus: params.status,
    SequenceNumber: String(params.sequence),
    From: params.from ?? '+15005550006',
    To: params.to ?? '+15005550009',
    Direction: params.direction ?? 'outbound-dial',
    ApiVersion: '2010-04-01',
    Timestamp: (params.timestamp ?? new Date()).toUTCString(),
    CallbackSource: 'call-progress-events',
  };
  if (params.parentCallSid) p.ParentCallSid = params.parentCallSid;
  if (params.duration != null) {
    p.CallDuration = String(params.duration);
    p.Duration = String(Math.ceil(params.duration / 60));
  }
  if (params.errorCode) p.ErrorCode = params.errorCode;
  return p;
}

export function twimlOutbound(params: {
  clientCallSid: string;
  talkrCallId: string;
  identity: string;
}): Record<string, string> {
  return {
    AccountSid: 'ACtest00000000000000000000000000',
    CallSid: params.clientCallSid,
    CallStatus: 'ringing',
    From: `client:${params.identity}`,
    To: '',
    Direction: 'inbound',
    ApiVersion: '2010-04-01',
    ApplicationSid: 'APtest00000000000000000000000000',
    talkr_call_id: params.talkrCallId,
  };
}

export function dialComplete(params: {
  parentCallSid: string;
  dialCallSid: string;
  dialStatus: 'completed' | 'busy' | 'no-answer' | 'failed' | 'canceled' | 'answered';
  dialDuration?: number;
}): Record<string, string> {
  const p: Record<string, string> = {
    AccountSid: 'ACtest00000000000000000000000000',
    CallSid: params.parentCallSid,
    CallStatus: 'in-progress',
    DialCallSid: params.dialCallSid,
    DialCallStatus: params.dialStatus,
    From: 'client:user',
    To: '',
    Direction: 'inbound',
    ApiVersion: '2010-04-01',
  };
  if (params.dialDuration != null) p.DialCallDuration = String(params.dialDuration);
  return p;
}

export function recordingStatus(params: {
  recordingSid: string;
  callSid: string;
  status: 'in-progress' | 'completed' | 'failed' | 'absent';
  duration?: number;
  channels?: number;
}): Record<string, string> {
  const p: Record<string, string> = {
    AccountSid: 'ACtest00000000000000000000000000',
    CallSid: params.callSid,
    RecordingSid: params.recordingSid,
    RecordingStatus: params.status,
    RecordingChannels: String(params.channels ?? 2),
    RecordingSource: 'DialVerb',
    RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/ACtest/Recordings/${params.recordingSid}`,
    RecordingStartTime: new Date().toUTCString(),
  };
  if (params.duration != null) p.RecordingDuration = String(params.duration);
  return p;
}

export function inboundVoice(params: {
  callSid: string;
  from: string;
  to: string;
}): Record<string, string> {
  return {
    AccountSid: 'ACtest00000000000000000000000000',
    CallSid: params.callSid,
    CallStatus: 'ringing',
    From: params.from,
    To: params.to,
    Direction: 'inbound',
    ApiVersion: '2010-04-01',
  };
}

/**
 * Conference status callback (docs/telephony-events.md §9). The room's
 * FriendlyName is the only place our call id appears — conference callbacks
 * carry no query string of ours.
 */
export function conferenceStatus(params: {
  event:
    | 'conference-start'
    | 'conference-end'
    | 'participant-join'
    | 'participant-leave'
    | 'participant-hold'
    | 'participant-unhold';
  conferenceSid: string;
  friendlyName: string;
  callSid?: string;
  sequence?: number;
  reasonConferenceEnded?: string;
}): Record<string, string> {
  const p: Record<string, string> = {
    AccountSid: 'ACtest00000000000000000000000000',
    ConferenceSid: params.conferenceSid,
    FriendlyName: params.friendlyName,
    StatusCallbackEvent: params.event,
    Timestamp: new Date().toUTCString(),
    SequenceNumber: String(params.sequence ?? 1),
  };
  if (params.callSid) p.CallSid = params.callSid;
  if (params.reasonConferenceEnded) p.ReasonConferenceEnded = params.reasonConferenceEnded;
  return p;
}
