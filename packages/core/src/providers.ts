/**
 * Provider abstraction interfaces (docs/architecture.md §4).
 * Telnyx is the implementation (packages/provider-telnyx). Business logic
 * depends on these shapes only — never on provider SDK types.
 */

import type { CanonicalEvent, ProviderName } from './events.js';

/** A webhook request as seen at the HTTP boundary, provider-agnostic. */
export interface WebhookRequest {
  /** Full public URL the provider signed (scheme + host + path + query). */
  url: string;
  method: string;
  headers: Record<string, string | string[] | undefined>;
  /** Parsed form/JSON params. */
  params: Record<string, string>;
  rawBody: string;
}

/**
 * One rep's browser as a dial target. The pair, rather than a finished string,
 * because the dial noun and the REST address differ per provider.
 */
export interface ClientTarget {
  userId: string;
  sipUsername?: string | null;
}

export interface ClientAddressParams {
  /** Platform user id. */
  userId: string;
  /** Provider-generated SIP username, when the provider issues one. */
  sipUsername?: string | null;
}

export interface ClientToken {
  token: string;
  identity: string;
  ttlSeconds: number;
}

export interface ProviderCallSnapshot {
  providerCallId: string;
  status: string;
  direction?: string;
  from?: string;
  to?: string;
  durationSeconds?: number;
  priceCents?: number;
  priceCurrency?: string;
  startedAt?: Date;
  endedAt?: Date;
  raw: Record<string, unknown>;
}

/** What a call-control (TwiML) endpoint should respond with. */
export interface CallControlResponse {
  contentType: string;
  body: string;
}

export interface OutboundDialParams {
  callerId: string;
  to: string;
  /** Absolute URL for child-leg status callbacks (may carry our query params). */
  statusCallbackUrl: string;
  /** Absolute URL Twilio requests when the dial finishes (DialCallStatus). */
  dialActionUrl: string;
  record: boolean;
  recordingStatusCallbackUrl?: string;
  timeoutSeconds?: number;
}

/** Server-initiated PSTN dial (Phase 5 dialers — docs/dialers.md §4/§8). */
export interface CreatePstnCallParams {
  from: string;
  to: string;
  /** Call-control URL the provider requests when the callee answers. */
  answerUrl: string;
  /** Status-callback URL for the call's lifecycle events. */
  statusCallbackUrl: string;
  /**
   * Inline TeXML executed on answer instead of (or before) fetching
   * `answerUrl`. Telnyx often skips the Answer URL for SIP→WebRTC legs;
   * conference XML here keeps the browser in the room without that fetch.
   */
  answerTexml?: string;
  /** HTTP method Telnyx uses when fetching `answerUrl`. Defaults to POST. */
  answerUrlMethod?: 'GET' | 'POST';
  /** Answering machine detection: 'enable' (report at answer) or
   * 'detect_message_end' (report after the greeting, for voicemail drops). */
  machineDetection?: 'enable' | 'detect_message_end';
  timeoutSeconds?: number;
}

/**
 * Put the calling leg into a named conference room instead of bridging it
 * straight to the callee. Everything hold/merge/transfer needs follows from
 * the parties being participants of a room (docs/telephony-events.md §9).
 */
export interface ConferenceDialParams {
  /** Room name — deterministic per call (`conferenceRoomName`). */
  roomName: string;
  /** False for parties who must not tear the room down when they hang up. */
  endConferenceOnExit: boolean;
  /** True for the first party in; later parties wait for it. */
  startConferenceOnEnter: boolean;
  /** Absolute URL for conference lifecycle + participant callbacks. */
  statusCallbackUrl: string;
  record: boolean;
  recordingStatusCallbackUrl?: string;
  /** Held parties hear this instead of silence. */
  waitUrl?: string;
}

export interface AddParticipantParams {
  roomName: string;
  /** Caller ID the added party sees. */
  callerId: string;
  /** PSTN number, or `client:identity` for another platform user's browser. */
  to: string;
  /**
   * Call status callbacks for the added leg. Omitted for a supervisor: their
   * leg hanging up must never be read as the call ending.
   */
  statusCallbackUrl?: string;
  /**
   * False for a party who must outlive the rep leaving — a transfer target,
   * for instance, keeps talking to the customer after the rep drops.
   */
  endConferenceOnExit?: boolean;
  timeoutSeconds?: number;
  /** Supervision (listen/whisper/barge): see `monitorPatch`. */
  muted?: boolean;
  coaching?: boolean;
  callSidToCoach?: string;
  /** False joins silently — a supervisor listening in must not announce themselves. */
  beep?: boolean;
  /**
   * The platform call this leg joins, handed to a browser target the way an
   * inbound ring hands it (`talkr_call_id`), so the softphone can tell the leg
   * belongs to that call. Ignored for a PSTN target.
   */
  talkrCallId?: string;
}

export interface ProviderParticipant {
  providerParticipantId: string;
  hold: boolean;
  muted: boolean;
  raw: Record<string, unknown>;
}

export interface ParticipantPatch {
  hold?: boolean;
  muted?: boolean;
  /**
   * Whether this party hanging up tears down the room. Flipped to false on the
   * agent before a transfer, so the customer and the transfer target keep
   * talking after the agent drops.
   */
  endConferenceOnExit?: boolean;
  /** Whisper: only `callSidToCoach` (the rep) hears this participant. */
  coaching?: boolean;
  callSidToCoach?: string;
}

/**
 * Who opens the rep's browser leg on an outbound call.
 *
 *  - `client`: the browser dials the provider itself, carrying the call id,
 *    and the provider then requests our call-control URL. No current carrier
 *    works this way.
 *  - `server`: the browser cannot address our call-control URL itself (a Telnyx
 *    WebRTC endpoint dials PSTN, not TeXML), so the server REST-dials the rep's
 *    SIP address with the call id on the answer URL and the browser answers.
 */
export type BrowserLegMode = 'client' | 'server';

export interface VoiceProvider {
  readonly name: ProviderName;
  /** How the rep's browser joins an outbound call. Absent means `client`. */
  readonly browserLeg?: BrowserLegMode;
  /** Verify a webhook's authenticity. Must be constant-time on secrets. */
  validateWebhook(req: WebhookRequest): boolean;
  /** Stable idempotency key for this delivery (docs/telephony-events.md §3). */
  idempotencyKey(endpoint: string, params: Record<string, string>): string;
  /** Translate one webhook delivery into canonical events. */
  normalizeWebhook(endpoint: string, params: Record<string, string>): CanonicalEvent[];
  /** Mint a browser-SDK token for an authenticated platform user. */
  /**
   * A browser credential for one platform user. Sync for providers that sign
   * locally; a promise for providers that must round-trip to mint (Telnyx).
   * Callers await either way.
   */
  mintClientToken(identity: string, ttlSeconds?: number): ClientToken | Promise<ClientToken>;

  /**
   * How this provider addresses a rep's browser in a dial.
   *
   * Telnyx generates a SIP username at credential-creation time, so the
   * caller supplies the stored one (`telephony_credentials`) and
   * this only formats it. Splitting it this way keeps the persistence in the
   * server, which owns the database, and the wire format in the adapter,
   * which owns the provider's vocabulary.
   */
  formatClientAddress(params: ClientAddressParams): string;
  /** Build the call-control response that dials a PSTN number from a client leg. */
  buildOutboundDialResponse(params: OutboundDialParams): CallControlResponse;
  /** Build the call-control response acknowledging a finished dial. */
  buildHangupResponse(): CallControlResponse;
  /** Fetch provider truth for reconciliation. */
  fetchCall(providerCallId: string): Promise<ProviderCallSnapshot | null>;
  /** Hang up an in-flight call server-side. */
  hangupCall(providerCallId: string): Promise<void>;
  /** Point a live call at a new call-control URL (a fresh TeXML/TwiML fetch). */
  redirectCall(providerCallId: string, url: string): Promise<void>;
  /** REST-dial a PSTN number server-side (Phase 5 parallel dialing). */
  createCall(params: CreatePstnCallParams): Promise<{ providerCallId: string }>;
  /** Cancel a not-yet-answered call server-side (losing parallel legs). */
  cancelCall(providerCallId: string): Promise<void>;

  // ── Conference call control (hold / add call / merge / transfer) ───────────

  /** Call-control response that puts the requesting leg into a room. */
  buildConferenceResponse(params: ConferenceDialParams): CallControlResponse;
  /** Dial a new party into an existing room. */
  addParticipant(params: AddParticipantParams): Promise<ProviderParticipant>;
  /** Change one participant in place (hold, mute, exit semantics). Idempotent. */
  updateParticipant(
    roomName: string,
    participantId: string,
    patch: ParticipantPatch,
  ): Promise<void>;
  /** Drop one participant, leaving the room and the others intact. */
  removeParticipant(roomName: string, participantId: string): Promise<void>;
  /** Current participants, for reconciling our view against the provider. */
  listParticipants(roomName: string): Promise<ProviderParticipant[]>;
  /**
   * Seed the room-name → provider-conference-id map from a conference callback
   * (which carries both), so the next participant operation on that room needs
   * no lookup. Optional: Twilio addresses rooms by name and has nothing to
   * remember; Telnyx only accepts the conference's own id in REST paths.
   */
  rememberConferenceSid?(friendlyName: string, providerConferenceId: string): void;

  /**
   * Download one recording's media, in whatever way this carrier requires:
   * the adapter owns the auth scheme, the format suffix (or lack of one) and
   * any lookup needed when the stored URL has expired. Optional, because a
   * carrier-less deployment has no media to serve.
   */
  fetchRecordingMedia?(ref: RecordingMediaRef): Promise<RecordingMedia>;
}

/** Audio container a recording can be served in. */
export type RecordingFormat = 'mp3' | 'wav';

/**
 * What the platform knows about one recording's media, as the `recordings`
 * row stores it. Carriers differ in which half is usable:
 *
 * - Twilio's `providerUrl` is a stable REST resource; the format is a suffix
 *   and the account credentials are the auth.
 * - Telnyx's `providerUrl` is a **pre-signed S3 link that expires minutes
 *   after the call** and already carries the extension in its path. Appending
 *   a suffix to it, or sending it an `Authorization` header, makes S3 answer
 *   400 — which is why the recording id is here too: it is the only durable
 *   handle, and a fresh link is looked up from it.
 */
export interface RecordingMediaRef {
  /** The URL the recording webhook carried, if any. */
  providerUrl?: string | null;
  /** The carrier's own id for the recording (Telnyx `RecordingSid`). */
  providerRecordingId?: string | null;
  /** Preferred container; the carrier may only have the other one. */
  format?: RecordingFormat;
}

export interface RecordingMedia {
  bytes: Uint8Array;
  /** What to send the browser: `audio/mpeg` or `audio/wav`. */
  contentType: string;
  format: RecordingFormat;
}

export interface RecordingMediaFetcher {
  /** Download recording media bytes (mirror job). */
  fetchMedia(providerUrl: string): Promise<Uint8Array>;
}

// ── Numbers ─────────────────────────────────────────────────────────────────

/** One number the carrier will sell, as the settings page lists it. */
export interface AvailableNumber {
  phoneE164: string;
  /** City / region the carrier reports, when it does. */
  locality: string | null;
  region: string | null;
  areaCode: string | null;
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
}

export interface SearchNumbersParams {
  /** NANP area code; the usual way a rep asks ("something in 210"). */
  areaCode?: string;
  /** Digits the number should contain (vanity search). */
  contains?: string;
  limit?: number;
}

export interface PurchaseNumberParams {
  phoneE164: string;
  /** Call-control URL for inbound calls to this number. */
  voiceUrl: string;
  /** Lifecycle status callbacks for those calls. */
  statusCallbackUrl: string;
  /** Inbound SMS webhook. */
  smsUrl: string;
  friendlyName?: string;
}

export interface PurchasedNumber {
  providerNumberId: string;
  phoneE164: string;
  capabilities: { voice: boolean; sms: boolean; mms: boolean };
}

/**
 * Buying and releasing numbers at the carrier. Separate from VoiceProvider so
 * a carrier adapter can ship calling before it ships inventory; the routes
 * check for it with `supportsNumbers()` and answer 501 when it is absent.
 */
export interface NumberProvider {
  searchAvailableNumbers(params: SearchNumbersParams): Promise<AvailableNumber[]>;
  purchaseNumber(params: PurchaseNumberParams): Promise<PurchasedNumber>;
  releaseNumber(providerNumberId: string): Promise<void>;
  /** Numbers the carrier account already owns (bought in the portal, ported in). */
  listCarrierNumbers?(): Promise<CarrierNumber[]>;
  /**
   * Point a number the account already owns at this server, exactly as a
   * purchase would. Null when the account does not own it.
   */
  importNumber?(phoneE164: string): Promise<PurchasedNumber | null>;
}

export interface CarrierNumber {
  providerNumberId: string;
  phoneE164: string;
  status: string | null;
  /** Already attached to our call-control application. */
  attached: boolean;
}

export function supportsNumbers(provider: unknown): provider is NumberProvider {
  const p = provider as Partial<NumberProvider> | null;
  return Boolean(
    p &&
      typeof p.searchAvailableNumbers === 'function' &&
      typeof p.purchaseNumber === 'function' &&
      typeof p.releaseNumber === 'function',
  );
}

/** Messaging/Number/Transcription provider interfaces land with Phases 3-4/8. */
export interface MessagingProvider {
  readonly name: ProviderName;
  sendMessage(params: {
    from: string;
    to: string;
    body: string;
    /** Public HTTPS URLs the carrier fetches; present = MMS. */
    mediaUrls?: string[];
    statusCallbackUrl?: string;
  }): Promise<{ providerMessageId: string }>;
  /**
   * Confirm an unsigned messaging webhook against the carrier's own record of
   * the message it names. Telnyx sends 2010-04-01 (Twilio-format) SMS webhooks
   * without a signature header. Returns the params to ingest, with the
   * numbers and body taken from the carrier rather than the request, or null
   * when the carrier has no matching message.
   */
  confirmMessageWebhook?(
    endpoint: 'inbound-sms' | 'sms-status',
    params: Record<string, string>,
  ): Promise<Record<string, string> | null>;
  /**
   * A messaging webhook posted as JSON (Telnyx Messaging API v2) as the flat
   * params the normalizer reads. Null when the body is already flat params or
   * not a message event.
   */
  flattenMessageWebhook?(endpoint: string, body: unknown): Record<string, string> | null;
}
