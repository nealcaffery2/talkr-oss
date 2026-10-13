/**
 * Realistic-shape Twilio SMS webhook payload factories (field names and value
 * formats match production captures; values sanitized). When Twilio's
 * payloads change, update these from captured events — never hand-invent.
 */

export function inboundSms(params: {
  sid: string;
  from: string;
  to: string;
  body?: string;
  numMedia?: number;
  mediaUrls?: string[];
}): Record<string, string> {
  const p: Record<string, string> = {
    AccountSid: 'ACtest00000000000000000000000000',
    MessageSid: params.sid,
    SmsSid: params.sid,
    SmsMessageSid: params.sid,
    From: params.from,
    To: params.to,
    Body: params.body ?? '',
    NumMedia: String(params.numMedia ?? params.mediaUrls?.length ?? 0),
    NumSegments: '1',
    SmsStatus: 'received',
    ApiVersion: '2010-04-01',
  };
  (params.mediaUrls ?? []).forEach((url, i) => {
    p[`MediaUrl${i}`] = url;
    p[`MediaContentType${i}`] = 'image/jpeg';
  });
  return p;
}

export function smsStatus(params: {
  sid: string;
  status: 'queued' | 'sending' | 'sent' | 'delivered' | 'undelivered' | 'failed';
  errorCode?: string;
  from?: string;
  to?: string;
}): Record<string, string> {
  const p: Record<string, string> = {
    AccountSid: 'ACtest00000000000000000000000000',
    MessageSid: params.sid,
    SmsSid: params.sid,
    MessageStatus: params.status,
    SmsStatus: params.status,
    From: params.from ?? '+15005550006',
    To: params.to ?? '+15005550009',
    ApiVersion: '2010-04-01',
  };
  if (params.errorCode) p.ErrorCode = params.errorCode;
  return p;
}
