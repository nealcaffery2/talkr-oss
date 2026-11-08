/**
 * Sendblue adapter (docs/messaging-channels.md): iMessage with Sendblue's own
 * SMS fallback, the iMessage capability lookup, and webhook normalization into
 * the same canonical message events the Telnyx adapter emits. REST only, no
 * SDK, same as provider-telnyx.
 *
 * API facts used here, from docs.sendblue.com (read 2026-10-21):
 *   - base https://api.sendblue.com, headers `sb-api-key-id` + `sb-api-secret-key`
 *   - POST /api/send-message {number, from_number, content, media_url?,
 *     status_callback?} → {message_handle, status, ...}
 *   - GET /api/evaluate-service?number=… → 200 {service: "iMessage" | "SMS"};
 *     502 EVALUATE_SERVICE_INDETERMINATE means unknown, never "SMS"
 *   - status callbacks and the `receive` webhook carry {message_handle, status,
 *     is_outbound, from_number, to_number, number, content, media_url, service,
 *     was_downgraded, error_code, error_key, date_sent, date_updated, group_id}
 *   - statuses REGISTERED, PENDING, DECLINED, QUEUED, ACCEPTED, SENT,
 *     DELIVERED, ERROR (outbound) and RECEIVED (inbound)
 *   - a configured webhook secret arrives verbatim in the `sb-signing-secret`
 *     header (a shared secret, not an HMAC)
 * LIVE-CHECK: Sendblue's docs list no READ status for outbound messages. This
 * adapter maps `READ` (and a `date_read` field) to `read` should a line report
 * one; until a live account shows it, iMessage read receipts are unconfirmed.
 */

import { timingSafeEqual } from 'node:crypto';
import type { CanonicalMessageEvent, MessageStatus } from '@talkr/core';

export const SENDBLUE_API_BASE = 'https://api.sendblue.com';
/** Header Sendblue puts a configured webhook secret in. */
export const SENDBLUE_SECRET_HEADER = 'sb-signing-secret';

export interface SendblueConfig {
  apiKeyId: string;
  apiSecret: string;
  /** SENDBLUE_FROM_NUMBER: the line used when a Talkr number names none of its own. */
  defaultFromNumber?: string;
  /** SENDBLUE_WEBHOOK_SECRET: what Sendblue sends in `sb-signing-secret`. */
  webhookSecret?: string;
  /** Overridable for tests and for a dedicated-instance host. */
  apiBase?: string;
}

/** Thrown for a refused send so the job queue retries (or dead-letters) it. */
export class SendblueApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = 'SendblueApiError';
  }
}

export interface SendblueSendResult {
  providerMessageId: string;
  /** Sendblue's status at accept time (usually QUEUED), mapped. */
  status: MessageStatus | null;
}

export class SendblueClient {
  readonly name = 'sendblue' as const;
  private readonly base: string;

  constructor(
    readonly config: SendblueConfig,
    private readonly http: typeof fetch = fetch,
  ) {
    this.base = (config.apiBase ?? SENDBLUE_API_BASE).replace(/\/+$/, '');
  }

  private headers(json: boolean): Record<string, string> {
    return {
      'sb-api-key-id': this.config.apiKeyId,
      'sb-api-secret-key': this.config.apiSecret,
      accept: 'application/json',
      ...(json ? { 'content-type': 'application/json' } : {}),
    };
  }

  /**
   * POST /api/send-message. Sendblue sends iMessage when it can and falls back
   * to SMS on its own when the handset has no iMessage; the status callback
   * then says `service: "SMS"` / `was_downgraded: true`.
   */
  async sendMessage(params: {
    from: string;
    to: string;
    body: string;
    mediaUrl?: string;
    statusCallbackUrl?: string;
  }): Promise<SendblueSendResult> {
    const res = await this.http(`${this.base}/api/send-message`, {
      method: 'POST',
      headers: this.headers(true),
      body: JSON.stringify({
        number: params.to,
        from_number: params.from,
        ...(params.body ? { content: params.body } : {}),
        ...(params.mediaUrl ? { media_url: params.mediaUrl } : {}),
        ...(params.statusCallbackUrl ? { status_callback: params.statusCallbackUrl } : {}),
      }),
    });
    const text = await res.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      // A non-JSON body is an error below whatever the status says.
    }
    const handle = typeof parsed.message_handle === 'string' ? parsed.message_handle : '';
    // Capacity declines come back as HTTP 400 with status ERROR; treat any
    // ERROR/DECLINED body, or a missing handle, as a failed send.
    const status = typeof parsed.status === 'string' ? parsed.status.toUpperCase() : '';
    if (!res.ok || !handle || status === 'ERROR' || status === 'DECLINED') {
      const key = parsed.error_key ?? parsed.error_code ?? res.status;
      throw new SendblueApiError(res.status, text, `Sendblue send-message → ${res.status} (${String(key)})`);
    }
    return { providerMessageId: handle, status: mapSendblueStatus(status) };
  }

  /**
   * GET /api/evaluate-service: does this number take iMessage? An inconclusive
   * lookup (502) or any other failure is `unknown`, which the caller must not
   * cache as "SMS only" (Sendblue's own guidance).
   */
  async evaluateService(number: string): Promise<'supported' | 'unsupported' | 'unknown'> {
    try {
      const url = `${this.base}/api/evaluate-service?number=${encodeURIComponent(number)}`;
      const res = await this.http(url, { method: 'GET', headers: this.headers(false) });
      if (res.status !== 200) return 'unknown';
      const body = (await res.json()) as { service?: unknown };
      const service = typeof body.service === 'string' ? body.service.toLowerCase() : '';
      if (service === 'imessage') return 'supported';
      if (service === 'sms') return 'unsupported';
      return 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /** Constant-time check of the `sb-signing-secret` header against SENDBLUE_WEBHOOK_SECRET. */
  verifyWebhookSecret(headers: Record<string, string | string[] | undefined>): boolean {
    const expected = this.config.webhookSecret;
    if (!expected) return false;
    const raw = headers[SENDBLUE_SECRET_HEADER];
    const given = Array.isArray(raw) ? raw[0] : raw;
    if (!given) return false;
    const a = Buffer.from(given, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  }
}

// ---------------------------------------------------------------------------
// Webhook normalization
// ---------------------------------------------------------------------------

/** Which Talkr endpoint received the delivery. */
export type SendblueEndpoint = 'sendblue-status' | 'sendblue-inbound';

/**
 * Sendblue status → ours. Everything before Sendblue hands the message to a
 * device is `queued`; ACCEPTED ("dequeued and being sent") is `sending`.
 * DECLINED (a Sendblue rule refused it, e.g. OPTED_OUT) and ERROR both fail.
 */
export function mapSendblueStatus(status: string | null | undefined): MessageStatus | null {
  switch ((status ?? '').toUpperCase()) {
    case 'REGISTERED':
    case 'PENDING':
    case 'QUEUED':
      return 'queued';
    case 'ACCEPTED':
      return 'sending';
    case 'SENT':
      return 'sent';
    case 'DELIVERED':
      return 'delivered';
    case 'READ':
      return 'read';
    case 'DECLINED':
    case 'ERROR':
      return 'failed';
    case 'RECEIVED':
      return 'received';
    default:
      return null;
  }
}

/** Sendblue's `service` (and the downgrade flag) → our channel. */
export function sendblueChannel(body: Record<string, unknown>): 'imessage' | 'sms' | 'rcs' {
  if (body.was_downgraded === true) return 'sms';
  const service = typeof body.service === 'string' ? body.service.toLowerCase() : '';
  if (service === 'sms') return 'sms';
  if (service === 'rcs') return 'rcs';
  return 'imessage';
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function date(...values: unknown[]): Date {
  for (const v of values) {
    if (typeof v === 'string' && v) {
      const d = new Date(v);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  return new Date();
}

/** A read receipt, by status or by a read timestamp (see LIVE-CHECK above). */
function readAtOf(body: Record<string, unknown>): string | null {
  for (const k of ['date_read', 'read_at', 'dateRead']) {
    const v = body[k];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

/** The error worth recording: the numeric code when non-zero, else the rule key. */
function errorCodeOf(body: Record<string, unknown>): string | undefined {
  const code = body.error_code;
  if (code != null && code !== '' && code !== 0 && code !== '0') return String(code);
  const key = str(body.error_key);
  return key || undefined;
}

/**
 * Sendblue JSON → canonical message events. Group messages are ignored: a
 * Talkr thread is one person on one line. An inbound event's `to` is the
 * Sendblue line it arrived on; the server maps that to the Talkr number the
 * thread lives under before applying it.
 */
export function normalizeSendblueWebhook(endpoint: SendblueEndpoint, body: unknown): CanonicalMessageEvent[] {
  if (!body || typeof body !== 'object') return [];
  const b = body as Record<string, unknown>;
  const handle = str(b.message_handle);
  if (!handle) return [];
  if (str(b.group_id)) return [];

  if (endpoint === 'sendblue-inbound') {
    // The receive webhook only carries inbound messages; an outbound one
    // posted here (a misconfigured `outbound` hook) is a status update.
    if (b.is_outbound === true) return normalizeSendblueWebhook('sendblue-status', body);
    const from = str(b.from_number) || str(b.number);
    const to = str(b.to_number) || str(b.sendblue_number);
    if (!from || !to) return [];
    const media = str(b.media_url);
    return [
      {
        type: 'message.received',
        provider: 'sendblue',
        providerObjectId: handle,
        occurredAt: date(b.date_sent, b.date_updated),
        data: {
          from,
          to,
          body: str(b.content),
          status: 'received',
          numMedia: media ? 1 : 0,
          ...(media ? { mediaUrls: [media] } : {}),
          channel: sendblueChannel(b),
        },
        raw: b,
      },
    ];
  }

  const readAt = readAtOf(b);
  const status = readAt ? 'read' : mapSendblueStatus(str(b.status));
  if (!status || status === 'received') return [];
  return [
    {
      type: 'message.status',
      provider: 'sendblue',
      providerObjectId: handle,
      occurredAt: status === 'read' ? date(readAt, b.date_updated) : date(b.date_updated, b.date_sent),
      data: {
        from: str(b.from_number) || undefined,
        to: str(b.to_number) || str(b.number) || undefined,
        status,
        errorCode: status === 'failed' ? errorCodeOf(b) : undefined,
        channel: sendblueChannel(b),
      },
      raw: b,
    },
  ];
}

/**
 * Dedupe key for the webhook_events ledger. Sendblue retries on 5xx and
 * timeouts; one handle × status is one fact.
 */
export function sendblueIdempotencyKey(endpoint: SendblueEndpoint, body: unknown): string | null {
  const b = (body ?? {}) as Record<string, unknown>;
  const handle = str(b.message_handle);
  if (!handle) return null;
  if (endpoint === 'sendblue-inbound') return `sendblue:inbound:${handle}`;
  const status = readAtOf(b) ? 'READ' : str(b.status).toUpperCase() || 'UNKNOWN';
  return `sendblue:status:${handle}:${status}`;
}
