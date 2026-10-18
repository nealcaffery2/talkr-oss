/**
 * Telnyx Messaging API v2 webhook bodies, shaped from production captures
 * (webhook_events, 2026-10-14; numbers, ids and text sanitized). The messaging
 * profile posts these as signed JSON to the sms-status and inbound-sms URLs.
 */

export function v2Finalized(params: {
  id: string;
  from: string;
  to: string;
  status: 'sent' | 'delivered' | 'delivery_failed' | 'sending_failed' | 'delivery_unconfirmed';
  eventType?: 'message.sent' | 'message.finalized';
  errorCode?: string;
}) {
  return {
    data: {
      id: 'evt-' + params.id,
      event_type: params.eventType ?? 'message.finalized',
      occurred_at: '2026-10-14T19:12:45.407+00:00',
      record_type: 'event',
      payload: {
        cc: [],
        id: params.id,
        to: [{ status: params.status, carrier: 'T-MOBILE USA, INC.', line_type: 'Wireless', phone_number: params.to }],
        cost: { amount: '0.0075', currency: 'USD' },
        from: { carrier: 'Telnyx', line_type: 'Wireless', phone_number: params.from },
        tags: [],
        text: 'Sorry I missed you just now. Is later today better?',
        type: 'SMS',
        media: [],
        parts: 1,
        errors: params.errorCode ? [{ code: params.errorCode, title: 'Delivery failed' }] : [],
        encoding: 'GSM-7',
        direction: 'outbound',
        record_type: 'message',
        webhook_url: 'https://talkr.test/webhooks/telnyx/sms-status',
        messaging_profile_id: '4001a09a-0000-0000-0000-000000000000',
      },
    },
    meta: { attempt: 1, delivered_to: 'https://talkr.test/webhooks/telnyx/sms-status' },
  };
}

export function v2Received(params: { id: string; from: string; to: string; text: string; mediaUrls?: string[] }) {
  return {
    data: {
      id: 'evt-' + params.id,
      event_type: 'message.received',
      occurred_at: '2026-10-14T18:19:40.000+00:00',
      record_type: 'event',
      payload: {
        cc: [],
        id: params.id,
        to: [{ status: 'webhook_delivered', carrier: 'Telnyx', line_type: 'Wireless', phone_number: params.to }],
        from: { carrier: 'T-MOBILE USA, INC.', line_type: 'Wireless', phone_number: params.from },
        text: params.text,
        type: (params.mediaUrls?.length ?? 0) > 0 ? 'MMS' : 'SMS',
        media: (params.mediaUrls ?? []).map((url) => ({ url, content_type: 'image/jpeg', size: 1024 })),
        parts: 1,
        errors: [],
        encoding: 'GSM-7',
        direction: 'inbound',
        record_type: 'message',
        messaging_profile_id: '4001a09a-0000-0000-0000-000000000000',
      },
    },
    meta: { attempt: 1, delivered_to: 'https://talkr.test/webhooks/telnyx/inbound-sms' },
  };
}
