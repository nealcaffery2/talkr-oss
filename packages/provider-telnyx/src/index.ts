/**
 * Telnyx implementation of the VoiceProvider / MessagingProvider interfaces
 * (docs/architecture.md §4). All Telnyx-specific knowledge lives in this
 * package; business logic never sees a Telnyx field name.
 *
 * Two deliberate choices:
 *
 *  - **TeXML, not the Call Control API.** Call Control acknowledges a webhook
 *    and then issues REST commands. That breaks the invariant in
 *    docs/telephony-events.md §1 that call-control paths make no provider REST
 *    calls, and would mean rebuilding Phases 2–5. TeXML answers the request
 *    with a document, exactly as the existing routes already do.
 *  - **No vendor SDK.** The REST surface used here is a handful of endpoints;
 *    `fetch` against them keeps this package dependency-free and immune to SDK
 *    version churn.
 *
 * Shapes marked LIVE-CHECK are mirrored from Telnyx's documented TwiML
 * compatibility but have not been exercised against a live account. They are
 * isolated in `paths` below so a single correction fixes every call site.
 */

import type {
  AddParticipantParams,
  AvailableNumber,
  CallControlResponse,
  CanonicalEvent,
  CarrierNumber,
  ClientToken,
  ConferenceDialParams,
  CreatePstnCallParams,
  MessagingProvider,
  NumberProvider,
  OutboundDialParams,
  ParticipantPatch,
  ProviderCallSnapshot,
  ProviderParticipant,
  PurchaseNumberParams,
  PurchasedNumber,
  RecordingFormat,
  RecordingMedia,
  RecordingMediaRef,
  SearchNumbersParams,
  VoiceProvider,
  WebhookRequest,
} from '@talkr/core';
import { idempotencyKeyFor, normalizeTelnyxWebhook, type TelnyxEndpoint } from './normalize.js';
import {
  publicKeyFromBase64,
  verifyTelnyxSignature,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from './signature.js';
import { CONTENT_TYPE, el, eventList, texml } from './texml.js';

export { idempotencyKeyFor, normalizeTelnyxWebhook } from './normalize.js';
export type { TelnyxEndpoint } from './normalize.js';
export {
  publicKeyFromBase64,
  verifyTelnyxSignature,
  SIGNATURE_HEADER,
  TIMESTAMP_HEADER,
} from './signature.js';

const API_BASE = 'https://api.telnyx.com/v2';
/**
 * TeXML's REST resources (calls, conferences, participants) live on the v2
 * host under `/v2/texml/Accounts/{account_id}/…`: the same Bearer key as the
 * rest of v2, but Twilio-shaped form bodies with PascalCase parameters. The
 * Twilio-style `/2010-04-01` path this adapter first used answered 404 for
 * conference participants on the live account, which is why no seller was
 * dialed after the cutover. Conferences are also addressed by their own id
 * here, never by friendly name (see `conferenceSid()`).
 */
const TEXML_BASE = `${API_BASE}/texml`;

export interface TelnyxConfig {
  /** V2 API key (Bearer) used for every REST call. */
  apiKey: string;
  /**
   * Base64 Ed25519 public key from the portal, used only to verify inbound
   * webhooks. Deliberately a different credential from `apiKey` — a common
   * operator mix-up, so the names here stay explicit.
   */
  publicKey: string;
  /** Account id that owns the TeXML application (path segment in TeXML REST). */
  accountId: string;
  /** TeXML Application id whose Voice URL points at /texml/outbound-dial. */
  texmlApplicationId: string;
  /** SIP Connection id that browser credentials are minted against. */
  sipConnectionId: string;
  /** Messaging profile used for outbound SMS/MMS. */
  messagingProfileId?: string;
  /**
   * SIP domain browser credentials are reachable at. Telnyx's shared domain by
   * default; a connection with its own subdomain overrides it.
   */
  sipDomain?: string;
}

/**
 * Where a rep's provider credential is remembered between requests.
 *
 * Telnyx generates the SIP username, so without persistence the address a rep
 * is reachable at would change on every cold start and orphan a credential
 * each time. The adapter does not know about the database, so the server hands
 * it this.
 */
export interface TelnyxCredentialStore {
  get(userId: string): Promise<{ credentialId: string; sipUsername: string } | null>;
  put(userId: string, cred: { credentialId: string; sipUsername: string }): Promise<void>;
}

export interface TelnyxRestOverrides {
  fetchCall?: (providerCallId: string) => Promise<ProviderCallSnapshot | null>;
  hangupCall?: (providerCallId: string) => Promise<void>;
  redirectCall?: (providerCallId: string, url: string) => Promise<void>;
  sendMessage?: (params: {
    from: string;
    to: string;
    body: string;
    mediaUrls?: string[];
    statusCallbackUrl?: string;
  }) => Promise<{ providerMessageId: string }>;
  createCall?: (params: CreatePstnCallParams) => Promise<{ providerCallId: string }>;
  cancelCall?: (providerCallId: string) => Promise<void>;
  addParticipant?: (params: AddParticipantParams) => Promise<ProviderParticipant>;
  updateParticipant?: (
    roomName: string,
    participantId: string,
    patch: ParticipantPatch,
  ) => Promise<void>;
  removeParticipant?: (roomName: string, participantId: string) => Promise<void>;
  listParticipants?: (roomName: string) => Promise<ProviderParticipant[]>;
  mintClientToken?: (identity: string, ttlSeconds: number) => Promise<ClientToken>;
  searchAvailableNumbers?: (params: SearchNumbersParams) => Promise<AvailableNumber[]>;
  purchaseNumber?: (params: PurchaseNumberParams) => Promise<PurchasedNumber>;
  releaseNumber?: (providerNumberId: string) => Promise<void>;
  listCarrierNumbers?: () => Promise<CarrierNumber[]>;
  importNumber?: (phoneE164: string) => Promise<PurchasedNumber | null>;
  /** Persistence for generated SIP credentials; in-memory when omitted. */
  credentialStore?: TelnyxCredentialStore;
  /** Injected transport, for tests and for tracing. */
  fetchImpl?: typeof fetch;
  /** How the adapter waits between polls of an asynchronous order; tests make it instant. */
  wait?: (ms: number) => Promise<void>;
}

/** Thrown for non-2xx REST responses so callers can branch on status. */
export class TelnyxApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
    message: string,
  ) {
    super(message);
    this.name = 'TelnyxApiError';
  }
}

export class TelnyxVoiceProvider implements VoiceProvider, MessagingProvider, NumberProvider {
  readonly name = 'telnyx' as const;
  /**
   * A Telnyx WebRTC endpoint dials PSTN destinations and SIP URIs, not our
   * TeXML application, so the browser cannot originate a call that lands on
   * `/twiml/outbound-dial` with our call id. The server dials the rep's SIP
   * address instead (`createCall` with the answer URL carrying the id) and the
   * browser answers — the same shape as Telnyx's own TeXML + WebRTC demo.
   */
  readonly browserLeg = 'server' as const;
  private readonly config: TelnyxConfig;
  private readonly overrides: TelnyxRestOverrides;
  private verifyingKey: ReturnType<typeof publicKeyFromBase64> | null = null;
  /**
   * Fallback store for tests and single-process runs. Production passes a
   * database-backed store — a Map does not survive a serverless cold start.
   */
  private readonly memoryStore = new Map<string, { credentialId: string; sipUsername: string }>();

  constructor(config: TelnyxConfig, overrides: TelnyxRestOverrides = {}) {
    this.config = config;
    this.overrides = overrides;
  }

  /**
   * TeXML REST mirrors Twilio's account-scoped paths. LIVE-CHECK: confirm
   * against a real account before the first production call; everything that
   * addresses Telnyx by URL goes through here.
   */
  private paths = {
    /** TeXML REST surface: form bodies; conferences by id, never by name. */
    call: (sid: string) => `${this.texml()}/Calls/${encodeURIComponent(sid)}`,
    conferences: (query: string) => `${this.texml()}/Conferences?${query}`,
    participants: (conferenceSid: string) =>
      `${this.texml()}/Conferences/${encodeURIComponent(conferenceSid)}/Participants`,
    participant: (conferenceSid: string, id: string) =>
      `${this.texml()}/Conferences/${encodeURIComponent(conferenceSid)}/Participants/${encodeURIComponent(id)}`,
    /** v2 surface: Bearer, JSON. Outbound dials are created against the app. */
    createCall: () => `${API_BASE}/texml/calls/${this.config.texmlApplicationId}`,
    credentials: () => `${API_BASE}/telephony_credentials`,
    credentialToken: (id: string) => `${API_BASE}/telephony_credentials/${id}/token`,
    messages: () => `${API_BASE}/messages`,
    /** Number inventory (v2). Search, order, then the owned-number resource. */
    availableNumbers: (query: string) => `${API_BASE}/available_phone_numbers?${query}`,
    numberOrders: () => `${API_BASE}/number_orders`,
    phoneNumbers: (query: string) => `${API_BASE}/phone_numbers?${query}`,
    phoneNumber: (id: string) => `${API_BASE}/phone_numbers/${encodeURIComponent(id)}`,
    /**
     * Recording metadata by id. The v2 resource carries `download_urls`
     * (mp3 + wav) minted fresh on every read; the TeXML resource carries a
     * single `media_url`. Both are read, in that order, because a TeXML
     * recording is addressable either way and only the first gives a choice
     * of container.
     */
    recording: (id: string) => `${API_BASE}/recordings/${encodeURIComponent(id)}`,
    texmlRecording: (sid: string) =>
      `${this.texml()}/Recordings/${encodeURIComponent(sid)}.json`,
  };

  private texml(): string {
    return `${TEXML_BASE}/Accounts/${encodeURIComponent(this.config.accountId)}`;
  }

  private get http(): typeof fetch {
    return this.overrides.fetchImpl ?? globalThis.fetch;
  }

  private async request(
    url: string,
    init: { method: string; json?: unknown; form?: Record<string, string> },
  ): Promise<{ status: number; text: string }> {
    // One credential for every surface: the v2 host, TeXML REST included,
    // takes the API key as a Bearer token.
    const headers: Record<string, string> = {
      authorization: `Bearer ${this.config.apiKey}`,
      accept: 'application/json',
    };
    let body: string | undefined;
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.form) {
      // TeXML REST accepts the same form encoding Twilio's REST does.
      headers['content-type'] = 'application/x-www-form-urlencoded';
      body = new URLSearchParams(init.form).toString();
    }
    const res = await this.http(url, { method: init.method, headers, body });
    return { status: res.status, text: await res.text() };
  }

  private async requestJson<T>(
    url: string,
    init: { method: string; json?: unknown; form?: Record<string, string> },
  ): Promise<T> {
    const { status, text } = await this.request(url, init);
    if (status < 200 || status >= 300) {
      throw new TelnyxApiError(status, text, `Telnyx ${init.method} ${url} → ${status}`);
    }
    return (text ? JSON.parse(text) : {}) as T;
  }

  // ── Webhooks ──────────────────────────────────────────────────────────────

  /**
   * Ed25519 over `{timestamp}|{raw_body}`. The raw body is required — a
   * re-serialized parse of the params will not verify.
   */
  validateWebhook(req: WebhookRequest): boolean {
    if (!this.verifyingKey) this.verifyingKey = publicKeyFromBase64(this.config.publicKey);
    const header = (name: string): string | undefined => {
      const v = req.headers[name] ?? req.headers[name.toLowerCase()];
      return Array.isArray(v) ? v[0] : v;
    };
    return verifyTelnyxSignature({
      rawBody: req.rawBody,
      signatureHeader: header(SIGNATURE_HEADER),
      timestampHeader: header(TIMESTAMP_HEADER),
      publicKey: this.verifyingKey,
    });
  }

  idempotencyKey(endpoint: string, params: Record<string, string>): string {
    return idempotencyKeyFor(endpoint as TelnyxEndpoint, params);
  }

  normalizeWebhook(endpoint: string, params: Record<string, string>): CanonicalEvent[] {
    return normalizeTelnyxWebhook(endpoint as TelnyxEndpoint, params);
  }

  // ── Browser credentials ───────────────────────────────────────────────────

  /**
   * Telnyx has no single-call token equivalent to Twilio's AccessToken: a
   * browser logs in with a JWT minted from an on-demand *telephony credential*
   * that belongs to a SIP connection. So one credential is created per platform
   * user (named for their id, which is what inbound routing addresses) and
   * reused, with only the short-lived token reminted per request.
   *
   * Returns a promise where Twilio's returns a value; the interface allows
   * both and every caller awaits.
   */
  async mintClientToken(identity: string, ttlSeconds = 3600): Promise<ClientToken> {
    if (this.overrides.mintClientToken) {
      return this.overrides.mintClientToken(identity, ttlSeconds);
    }
    const cred = await this.ensureCredential(identity);
    // The token endpoint answers with the raw JWT, not a JSON envelope.
    const { status, text } = await this.request(this.paths.credentialToken(cred.credentialId), {
      method: 'POST',
    });
    if (status < 200 || status >= 300) {
      throw new TelnyxApiError(status, text, `Telnyx token mint failed (${status})`);
    }
    // `identity` stays the platform user id so callers key on one thing; the
    // SIP username is what the wire uses, and lives in the store.
    return { token: text.trim(), identity, ttlSeconds };
  }

  /** The rep's credential, created once and remembered thereafter. */
  async ensureCredential(userId: string): Promise<{ credentialId: string; sipUsername: string }> {
    const store = this.overrides.credentialStore;
    const existing = store ? await store.get(userId) : this.memoryStore.get(userId);
    if (existing) return existing;

    const created = await this.requestJson<{
      data: { id: string; sip_username: string };
    }>(this.paths.credentials(), {
      method: 'POST',
      json: {
        connection_id: this.config.sipConnectionId,
        // Named for the platform user so the portal is readable; the SIP
        // username Telnyx generates is unrelated to this name.
        name: `talkr-${userId}`,
      },
    });
    const cred = {
      credentialId: created.data.id,
      sipUsername: created.data.sip_username,
    };
    if (!cred.sipUsername) {
      throw new Error('Telnyx credential response carried no sip_username');
    }
    if (store) await store.put(userId, cred);
    else this.memoryStore.set(userId, cred);
    return cred;
  }

  /**
   * Telnyx reaches a browser over SIP, not a Twilio-style client identity. The
   * SIP username is provider-generated, so it must be supplied by the caller
   * from the stored credential.
   */
  formatClientAddress(params: { userId: string; sipUsername?: string | null }): string {
    if (!params.sipUsername) {
      throw new Error(
        `no Telnyx SIP credential for user ${params.userId} — mint a voice token for them first`,
      );
    }
    return `sip:${params.sipUsername}@${this.config.sipDomain ?? 'sip.telnyx.com'}`;
  }

  // ── TeXML call control ────────────────────────────────────────────────────

  buildOutboundDialResponse(params: OutboundDialParams): CallControlResponse {
    const number = el('Number', {
      statusCallback: params.statusCallbackUrl,
      statusCallbackEvent: eventList(['initiated', 'ringing', 'answered', 'completed']),
    }, escapeInner(params.to));
    const dial = el(
      'Dial',
      {
        callerId: params.callerId,
        answerOnBridge: true,
        timeout: params.timeoutSeconds ?? 30,
        action: params.dialActionUrl,
        ...(params.record
          ? {
              record: 'record-from-answer-dual',
              recordingStatusCallback: params.recordingStatusCallbackUrl,
              recordingStatusCallbackEvent: params.recordingStatusCallbackUrl
                ? eventList(['in-progress', 'completed', 'absent'])
                : undefined,
            }
          : {}),
      },
      number,
    );
    return { contentType: CONTENT_TYPE, body: texml(dial) };
  }

  buildHangupResponse(): CallControlResponse {
    return { contentType: CONTENT_TYPE, body: texml(el('Hangup')) };
  }

  /**
   * Ring one or more reps' browsers (inbound routing "ring_users").
   *
   * TeXML has no <Client> noun — that is Twilio's, paired with its JS SDK.
   * A Telnyx browser is a SIP endpoint, so each rep is dialed at the SIP URI
   * built from their stored credential. Callers pass full addresses.
   */
  buildClientDialResponse(params: {
    callerId: string;
    clientIdentities: Array<{ userId: string; sipUsername?: string | null }>;
    talkrCallId: string;
    timeoutSeconds: number;
    dialActionUrl: string;
    statusCallbackUrl: string;
    record: boolean;
    recordingStatusCallbackUrl?: string;
    /** TeXML the answering rep hears before the bridge (whisper). LIVE-CHECK: `url` on <Sip>. */
    whisperUrl?: string;
  }): CallControlResponse {
    const clients = params.clientIdentities
      .map((target) =>
        el(
          'Sip',
          {
            statusCallback: params.statusCallbackUrl,
            statusCallbackEvent: eventList(['initiated', 'ringing', 'answered', 'completed']),
            url: params.whisperUrl,
          },
          escapeInner(this.formatClientAddress(target)),
        ),
      )
      .join('');
    const dial = el(
      'Dial',
      {
        callerId: params.callerId,
        answerOnBridge: true,
        timeout: params.timeoutSeconds,
        action: params.dialActionUrl,
        ...(params.record
          ? {
              record: 'record-from-answer-dual',
              recordingStatusCallback: params.recordingStatusCallbackUrl,
            }
          : {}),
      },
      clients,
    );
    return { contentType: CONTENT_TYPE, body: texml(dial) };
  }

  buildVoicemailResponse(params: {
    greeting: string;
    /** A recorded greeting; played instead of speaking `greeting`. */
    greetingAudioUrl?: string;
    maxLengthSeconds: number;
    actionUrl: string;
    recordingStatusCallbackUrl: string;
  }): CallControlResponse {
    return {
      contentType: CONTENT_TYPE,
      body: texml(
        greetingEl(params.greeting, params.greetingAudioUrl),
        el('Record', {
          maxLength: params.maxLengthSeconds,
          playBeep: true,
          action: params.actionUrl,
          recordingStatusCallback: params.recordingStatusCallbackUrl,
        }),
        el('Hangup'),
      ),
    };
  }

  /**
   * Inbound call control the Twilio adapter already had and inbound routing
   * (routes/twiml-inbound.ts) calls on whichever carrier is live. Same
   * documents as TwiML; TeXML supports every verb used.
   */

  /** Forward to a PSTN number (a rep's personal phone, any E.164). */
  buildForwardDialResponse(params: {
    callerId: string;
    to: string;
    timeoutSeconds: number;
    dialActionUrl: string;
    statusCallbackUrl: string;
    record: boolean;
    recordingStatusCallbackUrl?: string;
    whisperUrl?: string;
  }): CallControlResponse {
    const number = el(
      'Number',
      {
        statusCallback: params.statusCallbackUrl,
        statusCallbackEvent: eventList(['initiated', 'ringing', 'answered', 'completed']),
        url: params.whisperUrl,
      },
      escapeInner(params.to),
    );
    const dial = el(
      'Dial',
      {
        callerId: params.callerId,
        answerOnBridge: true,
        timeout: params.timeoutSeconds,
        action: params.dialActionUrl,
        ...(params.record
          ? { record: 'record-from-answer-dual', recordingStatusCallback: params.recordingStatusCallbackUrl }
          : {}),
      },
      number,
    );
    return { contentType: CONTENT_TYPE, body: texml(dial) };
  }

  buildVoicemailThanksResponse(): CallControlResponse {
    return { contentType: CONTENT_TYPE, body: texml(el('Say', {}, 'Thank you. We will call you back shortly. Goodbye.'), el('Hangup')) };
  }

  /** A message, an optional pause, then back to `redirectUrl`. */
  buildQueueWaitResponse(params: { message: string; pauseSeconds: number; redirectUrl: string }): CallControlResponse {
    return {
      contentType: CONTENT_TYPE,
      body: texml(
        el('Say', {}, escapeInner(params.message)),
        params.pauseSeconds > 0 ? el('Pause', { length: params.pauseSeconds }) : '',
        el('Redirect', { method: 'POST' }, escapeInner(params.redirectUrl)),
      ),
    };
  }

  /** One-key menu; silence falls through to the same action with no Digits. */
  buildIvrGatherResponse(params: {
    greeting: string;
    greetingAudioUrl?: string;
    actionUrl: string;
    timeoutSeconds?: number;
  }): CallControlResponse {
    const gather = el(
      'Gather',
      { input: 'dtmf', numDigits: 1, timeout: params.timeoutSeconds ?? 6, action: params.actionUrl, method: 'POST' },
      greetingEl(params.greeting, params.greetingAudioUrl),
    );
    return { contentType: CONTENT_TYPE, body: texml(gather, el('Redirect', { method: 'POST' }, escapeInner(params.actionUrl))) };
  }

  /** Spoken to the answering party before the bridge; no hang-up, or the bridge never happens. */
  buildWhisperResponse(message: string): CallControlResponse {
    return { contentType: CONTENT_TYPE, body: texml(message ? el('Say', {}, escapeInner(message)) : '') };
  }

  buildRejectResponse(message?: string): CallControlResponse {
    return { contentType: CONTENT_TYPE, body: texml(message ? el('Say', {}, escapeInner(message)) : '', el('Hangup')) };
  }

  /**
   * Parallel dialer answer path: bridge the seller who picked up to the rep
   * who won the batch. Until this existed the route called a builder only the
   * Twilio adapter had, so on Telnyx every answered parallel-dial leg 500'd.
   */
  buildCampaignBridgeResponse(params: {
    callerId: string;
    client: { userId: string; sipUsername?: string | null };
    talkrCallId: string;
    dialActionUrl: string;
    statusCallbackUrl: string;
    recordingStatusCallbackUrl: string;
  }): CallControlResponse {
    return this.buildClientDialResponse({
      callerId: params.callerId,
      clientIdentities: [params.client],
      talkrCallId: params.talkrCallId,
      timeoutSeconds: 15,
      dialActionUrl: params.dialActionUrl,
      statusCallbackUrl: params.statusCallbackUrl,
      record: true,
      recordingStatusCallbackUrl: params.recordingStatusCallbackUrl,
    });
  }

  /** AMD voicemail drop: say the org-configured message, then hang up. */
  buildVoicemailDropResponse(message: string): CallControlResponse {
    return { contentType: CONTENT_TYPE, body: texml(el('Say', {}, escapeInner(message)), el('Hangup')) };
  }

  buildConferenceResponse(params: ConferenceDialParams): CallControlResponse {
    const conference = el(
      'Conference',
      {
        startConferenceOnEnter: params.startConferenceOnEnter,
        endConferenceOnExit: params.endConferenceOnExit,
        statusCallback: params.statusCallbackUrl,
        statusCallbackMethod: 'POST',
        // 'hold' also delivers participant-unhold; 'join'/'leave' likewise.
        statusCallbackEvent: eventList(['start', 'end', 'join', 'leave', 'hold']),
        ...(params.waitUrl !== undefined ? { waitUrl: params.waitUrl } : {}),
        ...(params.record
          ? {
              record: 'record-from-start',
              recordingStatusCallback: params.recordingStatusCallbackUrl,
            }
          : {}),
      },
      escapeInner(params.roomName),
    );
    return { contentType: CONTENT_TYPE, body: texml(el('Dial', {}, conference)) };
  }

  // ── REST ──────────────────────────────────────────────────────────────────

  async fetchCall(providerCallId: string): Promise<ProviderCallSnapshot | null> {
    if (this.overrides.fetchCall) return this.overrides.fetchCall(providerCallId);
    const { status, text } = await this.request(this.paths.call(providerCallId), { method: 'GET' });
    if (status === 404) return null;
    if (status < 200 || status >= 300) {
      throw new TelnyxApiError(status, text, `Telnyx fetchCall → ${status}`);
    }
    const call = JSON.parse(text) as Record<string, string | null>;
    const started = call.start_time ?? call.StartTime;
    const ended = call.end_time ?? call.EndTime;
    return {
      providerCallId: (call.sid ?? call.call_sid ?? providerCallId) as string,
      status: (call.status ?? '') as string,
      direction: call.direction ?? undefined,
      from: call.from ?? undefined,
      to: call.to ?? undefined,
      durationSeconds: call.duration ? Number(call.duration) : undefined,
      priceCents: call.price ? Math.round(Math.abs(Number(call.price)) * 100) : undefined,
      priceCurrency: call.price_unit ?? undefined,
      startedAt: started ? new Date(started) : undefined,
      endedAt: ended ? new Date(ended) : undefined,
      raw: call,
    };
  }

  async hangupCall(providerCallId: string): Promise<void> {
    if (this.overrides.hangupCall) return this.overrides.hangupCall(providerCallId);
    // Completing a call is the same "update status" verb Twilio uses.
    await this.updateCall(providerCallId, { Status: 'completed' }, 'hangupCall');
  }

  async redirectCall(providerCallId: string, url: string): Promise<void> {
    if (this.overrides.redirectCall) return this.overrides.redirectCall(providerCallId, url);
    // TeXML call update: fetch a fresh set of instructions from `Url`.
    await this.updateCall(providerCallId, { Url: url, Method: 'POST' }, 'redirectCall');
  }

  /** POST to a call resource. A 404 means the leg is already gone, which is the state every caller wanted. */
  private async updateCall(providerCallId: string, form: Record<string, string>, op: string): Promise<void> {
    const { status, text } = await this.request(this.paths.call(providerCallId), { method: 'POST', form });
    if (status === 404) return;
    if (status < 200 || status >= 300) {
      throw new TelnyxApiError(status, text, `Telnyx ${op} → ${status}`);
    }
  }

  async createCall(params: CreatePstnCallParams): Promise<{ providerCallId: string }> {
    if (this.overrides.createCall) return this.overrides.createCall(params);
    const form: Record<string, string> = {
      From: params.from,
      To: params.to,
      Url: params.answerUrl,
      UrlMethod: params.answerUrlMethod ?? 'POST',
      StatusCallback: params.statusCallbackUrl,
      StatusCallbackEvent: eventList(['initiated', 'ringing', 'answered', 'completed']),
      Timeout: String(params.timeoutSeconds ?? 30),
    };
    // Inline TeXML skips the Answer URL fetch. Critical for SIP credential
    // callees where Telnyx connects media without requesting Url.
    if (params.answerTexml) form.Texml = params.answerTexml;
    if (params.machineDetection) {
      form.MachineDetection = params.machineDetection === 'enable' ? 'Enable' : 'DetectMessageEnd';
    }
    // Creating a call is the v2 surface, so JSON against the TeXML app. `To`
    // may be a SIP URI (`sip:gencred…@sip.telnyx.com`) — that is how the
    // server rings a rep's browser (browserLeg = 'server').
    const created = await this.requestJson<{
      sid?: string;
      call_sid?: string;
      data?: { sid?: string; call_sid?: string };
    }>(this.paths.createCall(), { method: 'POST', json: form });
    // LIVE-CHECK: Telnyx documents this response as {from, to, status} with no
    // sid. When none comes back the caller binds the provider id from the
    // first webhook (`CallSid`) instead, so an empty id here is not an error.
    const sid = created.sid ?? created.call_sid ?? created.data?.sid ?? created.data?.call_sid ?? '';
    return { providerCallId: sid };
  }

  async cancelCall(providerCallId: string): Promise<void> {
    if (this.overrides.cancelCall) return this.overrides.cancelCall(providerCallId);
    await this.updateCall(providerCallId, { Status: 'canceled' }, 'cancelCall');
  }

  // ── Conference rooms ──────────────────────────────────────────────────────

  /**
   * Room name → Telnyx conference id. TeXML creates a room when the first
   * `<Conference>` leg joins it, and only from then on does it have an id —
   * and the id is the only thing the REST paths accept, so nothing can be
   * added to a room the rep has not joined yet. Seeded from the
   * conference-status callbacks, which carry both the name and the id; looked
   * up by FriendlyName otherwise. Room names are unique per call, so an entry
   * never goes stale.
   */
  private readonly conferenceSids = new Map<string, string>();

  rememberConferenceSid(friendlyName: string, providerConferenceId: string): void {
    if (!friendlyName || !providerConferenceId) return;
    if (this.conferenceSids.size >= 1000) {
      const oldest = this.conferenceSids.keys().next().value;
      if (oldest !== undefined) this.conferenceSids.delete(oldest);
    }
    this.conferenceSids.set(friendlyName, providerConferenceId);
  }

  /** The room's id, or a 404 `TelnyxApiError` when no room of that name exists yet. */
  private async conferenceSid(roomName: string): Promise<string> {
    const known = this.conferenceSids.get(roomName);
    if (known) return known;
    const query = new URLSearchParams({ FriendlyName: roomName, PageSize: '20' }).toString();
    const body = await this.requestJson<{
      conferences?: Array<{ sid?: string; friendly_name?: string; status?: string }>;
    }>(this.paths.conferences(query), { method: 'GET' });
    const rooms = (body.conferences ?? []).filter(
      (c) => c.sid && (!c.friendly_name || c.friendly_name === roomName),
    );
    // A retried call can leave a finished room of the same name behind: the
    // running one wins, then one still forming, then whatever is newest.
    const live =
      rooms.find((c) => c.status === 'in-progress') ??
      rooms.find((c) => c.status === 'init') ??
      rooms[rooms.length - 1];
    if (!live?.sid) {
      throw new TelnyxApiError(404, '', `Telnyx has no conference named ${roomName} yet`);
    }
    this.rememberConferenceSid(roomName, live.sid);
    return live.sid;
  }

  /** Like `conferenceSid`, but a room that does not exist reads as null: a party in no room needs no update. */
  private async conferenceSidIfLive(roomName: string): Promise<string | null> {
    try {
      return await this.conferenceSid(roomName);
    } catch (err) {
      if (err instanceof TelnyxApiError && err.status === 404) return null;
      throw err;
    }
  }

  // ── Conference participants ───────────────────────────────────────────────

  async addParticipant(params: AddParticipantParams): Promise<ProviderParticipant> {
    if (this.overrides.addParticipant) return this.overrides.addParticipant(params);
    const conferenceSid = await this.conferenceSid(params.roomName);
    const created = await this.requestJson<Record<string, unknown>>(
      this.paths.participants(conferenceSid),
      {
        method: 'POST',
        form: {
          From: params.callerId,
          To: params.to,
          ...(params.statusCallbackUrl
            ? {
                StatusCallback: params.statusCallbackUrl,
                StatusCallbackEvent: eventList(['initiated', 'ringing', 'answered', 'completed']),
              }
            : {}),
          EarlyMedia: 'true',
          StartConferenceOnEnter: 'true',
          EndConferenceOnExit: String(params.endConferenceOnExit ?? false),
          Timeout: String(params.timeoutSeconds ?? 30),
          ...(params.muted !== undefined ? { Muted: String(params.muted) } : {}),
          ...(params.beep !== undefined ? { Beep: String(params.beep) } : {}),
          ...(params.coaching !== undefined ? { Coaching: String(params.coaching) } : {}),
          ...(params.callSidToCoach ? { CallSidToCoach: params.callSidToCoach } : {}),
        },
      },
    );
    const id = (created.call_sid ?? created.CallSid ?? created.sid) as string | undefined;
    if (!id) throw new Error('Telnyx addParticipant returned no participant id');
    return { providerParticipantId: id, hold: false, muted: false, raw: created };
  }

  async updateParticipant(
    roomName: string,
    participantId: string,
    patch: ParticipantPatch,
  ): Promise<void> {
    if (this.overrides.updateParticipant) {
      return this.overrides.updateParticipant(roomName, participantId, patch);
    }
    const form: Record<string, string> = {};
    if (patch.hold !== undefined) form.Hold = String(patch.hold);
    if (patch.muted !== undefined) form.Muted = String(patch.muted);
    if (patch.endConferenceOnExit !== undefined) {
      form.EndConferenceOnExit = String(patch.endConferenceOnExit);
    }
    if (patch.coaching !== undefined) form.Coaching = String(patch.coaching);
    if (patch.callSidToCoach) form.CallSidToCoach = patch.callSidToCoach;
    if (Object.keys(form).length === 0) return;
    const conferenceSid = await this.conferenceSidIfLive(roomName);
    if (!conferenceSid) return;
    const { status, text } = await this.request(this.paths.participant(conferenceSid, participantId), {
      method: 'POST',
      form,
    });
    // A party who already left is the state we wanted; anything else is real.
    if (status === 404) return;
    if (status < 200 || status >= 300) {
      throw new TelnyxApiError(status, text, `Telnyx updateParticipant → ${status}`);
    }
  }

  async removeParticipant(roomName: string, participantId: string): Promise<void> {
    if (this.overrides.removeParticipant) {
      return this.overrides.removeParticipant(roomName, participantId);
    }
    const conferenceSid = await this.conferenceSidIfLive(roomName);
    if (!conferenceSid) return;
    const { status, text } = await this.request(this.paths.participant(conferenceSid, participantId), {
      method: 'DELETE',
    });
    if (status === 404) return;
    if (status < 200 || status >= 300) {
      throw new TelnyxApiError(status, text, `Telnyx removeParticipant → ${status}`);
    }
  }

  async listParticipants(roomName: string): Promise<ProviderParticipant[]> {
    if (this.overrides.listParticipants) return this.overrides.listParticipants(roomName);
    const conferenceSid = await this.conferenceSidIfLive(roomName);
    if (!conferenceSid) return [];
    const { status, text } = await this.request(this.paths.participants(conferenceSid), {
      method: 'GET',
    });
    if (status === 404) return [];
    if (status < 200 || status >= 300) {
      throw new TelnyxApiError(status, text, `Telnyx listParticipants → ${status}`);
    }
    const body = JSON.parse(text) as { participants?: Record<string, unknown>[] };
    return (body.participants ?? []).map((p) => ({
      providerParticipantId: (p.call_sid ?? p.CallSid) as string,
      hold: p.hold === true || p.hold === 'true' || p.Hold === 'true',
      muted: p.muted === true || p.muted === 'true' || p.Muted === 'true',
      raw: p,
    }));
  }

  // ── Numbers (NumberProvider) ──────────────────────────────────────────────
  //
  // All v2. Unlike Twilio, a Telnyx number carries no URLs of its own: inbound
  // voice goes wherever the TeXML application it is attached to points, and
  // inbound SMS wherever its messaging profile points. So a purchase attaches
  // the number to our TeXML app (and messaging profile) and the webhook URLs
  // in `PurchaseNumberParams` are satisfied by that attachment — they must
  // already be configured on the app/profile (docs/telnyx-setup.md §3, §5).

  /** Local US numbers for sale, filtered by area code and/or digit pattern. */
  async searchAvailableNumbers(params: SearchNumbersParams): Promise<AvailableNumber[]> {
    if (this.overrides.searchAvailableNumbers) return this.overrides.searchAvailableNumbers(params);
    const query = (bestEffort: boolean) => {
      const q = new URLSearchParams();
      q.set('filter[country_code]', 'US');
      q.set('filter[phone_number_type]', 'local');
      // Telnyx deepObject: filter[features]=sms. filter[features][]=voice&sms is a 400.
      // SMS-capable locals can voice; requiring both empties some NPAs.
      q.set('filter[features]', 'sms');
      q.set('filter[limit]', String(Math.min(Math.max(params.limit ?? 10, 1), 30)));
      if (params.areaCode) q.set('filter[national_destination_code]', params.areaCode);
      // Telnyx's pattern filters take digits only; the wildcard Twilio accepts is
      // dropped rather than sent as a literal character.
      if (params.contains) q.set('filter[phone_number][contains]', params.contains.replace(/\*/g, ''));
      if (bestEffort) q.set('filter[best_effort]', 'true');
      return q.toString();
    };
    const parse = (text: string) =>
      (text ? JSON.parse(text) : {}) as {
        data?: Array<{
          phone_number: string;
          region_information?: Array<{ region_type: string; region_name: string }>;
          features?: Array<{ name: string }>;
        }>;
        errors?: Array<{ code?: string }>;
      };
    const emptyInventory = (status: number, text: string) =>
      status === 400 && (text.includes('"code":"10031"') || text.includes('"code": "10031"'));

    let { status, text } = await this.request(this.paths.availableNumbers(query(false)), { method: 'GET' });
    // 210 / 214 / 713 often have zero exact inventory. Telnyx answers 400/10031
    // instead of []. Retry nearby (best_effort) so Settings → Buy does not die.
    if (emptyInventory(status, text) && params.areaCode) {
      ({ status, text } = await this.request(this.paths.availableNumbers(query(true)), { method: 'GET' }));
    }
    if (emptyInventory(status, text)) return [];
    if (status < 200 || status >= 300) {
      throw new TelnyxApiError(status, text, `Telnyx GET ${this.paths.availableNumbers(query(false))} → ${status}`);
    }
    const body = parse(text);
    return (body.data ?? []).map((n) => {
      const region = (type: string) =>
        n.region_information?.find((r) => r.region_type === type)?.region_name ?? null;
      const features = new Set((n.features ?? []).map((f) => f.name));
      return {
        phoneE164: n.phone_number,
        locality: region('rate_center') ?? region('location'),
        region: region('state'),
        areaCode: /^\+1(\d{3})/.exec(n.phone_number)?.[1] ?? null,
        capabilities: { voice: features.has('voice'), sms: features.has('sms'), mms: features.has('mms') },
      };
    });
  }

  /**
   * Buy a number attached to our TeXML application (inbound voice) and
   * messaging profile (inbound SMS) in the same order, so a bought number is
   * a working number. Orders are asynchronous at Telnyx; the owned-number
   * record is polled briefly for its id, and the E.164 stands in when it has
   * not appeared yet (the phone-number endpoints accept either).
   */
  async purchaseNumber(params: PurchaseNumberParams): Promise<PurchasedNumber> {
    if (this.overrides.purchaseNumber) return this.overrides.purchaseNumber(params);
    const order = await this.requestJson<{
      data?: {
        id?: string;
        status?: string;
        phone_numbers?: Array<{ phone_number: string; status?: string }>;
      };
    }>(this.paths.numberOrders(), {
      method: 'POST',
      json: {
        phone_numbers: [{ phone_number: params.phoneE164 }],
        connection_id: this.config.texmlApplicationId,
        ...(this.config.messagingProfileId ? { messaging_profile_id: this.config.messagingProfileId } : {}),
        ...(params.friendlyName ? { customer_reference: params.friendlyName.slice(0, 60) } : {}),
      },
    });
    if (order.data?.status === 'failure') {
      throw new TelnyxApiError(422, JSON.stringify(order), `Telnyx number order for ${params.phoneE164} failed`);
    }
    const owned = await this.findOwnedNumber(params.phoneE164);
    return {
      providerNumberId: owned?.id ?? params.phoneE164,
      phoneE164: params.phoneE164,
      capabilities: owned?.capabilities ?? { voice: true, sms: Boolean(this.config.messagingProfileId), mms: false },
    };
  }

  /** The owned-number record, polled a few times because the order settles asynchronously. */
  private async findOwnedNumber(
    phoneE164: string,
    attempts = 5,
  ): Promise<{ id: string; capabilities: PurchasedNumber['capabilities'] } | null> {
    const wait = this.overrides.wait ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    const q = new URLSearchParams({ 'filter[phone_number]': phoneE164 }).toString();
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (attempt > 0) await wait(1000);
      const { status, text } = await this.request(this.paths.phoneNumbers(q), { method: 'GET' });
      if (status < 200 || status >= 300) continue;
      const body = JSON.parse(text) as {
        data?: Array<{ id: string; phone_number: string; status?: string; features?: Array<string | { name: string }> }>;
      };
      const row = (body.data ?? []).find((n) => n.phone_number === phoneE164);
      if (!row) continue;
      const names = new Set((row.features ?? []).map((f) => (typeof f === 'string' ? f : f.name)));
      return {
        id: row.id,
        capabilities: {
          voice: names.size === 0 || names.has('voice'),
          sms: names.has('sms') || Boolean(this.config.messagingProfileId),
          mms: names.has('mms'),
        },
      };
    }
    return null;
  }

  /** Every number on the account, with whether it already points at our TeXML app. */
  async listCarrierNumbers(): Promise<CarrierNumber[]> {
    if (this.overrides.listCarrierNumbers) return this.overrides.listCarrierNumbers();
    const out: CarrierNumber[] = [];
    // ponytail: first 5 pages (1,250 numbers); page on when an account outgrows it.
    for (let page = 1; page <= 5; page++) {
      const q = new URLSearchParams({ 'page[number]': String(page), 'page[size]': '250' }).toString();
      const body = await this.requestJson<{
        data?: Array<{ id: string; phone_number: string; status?: string; connection_id?: string | null }>;
        meta?: { total_pages?: number };
      }>(this.paths.phoneNumbers(q), { method: 'GET' });
      for (const n of body.data ?? []) {
        out.push({
          providerNumberId: n.id,
          phoneE164: n.phone_number,
          status: n.status ?? null,
          attached: n.connection_id === this.config.texmlApplicationId,
        });
      }
      if (!body.meta?.total_pages || page >= body.meta.total_pages) break;
    }
    return out;
  }

  /**
   * Adopt a number the account already owns: the same two attachments a
   * purchase makes in its order (TeXML application for voice, messaging
   * profile for SMS), as updates to the owned-number record. Re-running it is
   * harmless — both are idempotent PATCHes.
   */
  async importNumber(phoneE164: string): Promise<PurchasedNumber | null> {
    if (this.overrides.importNumber) return this.overrides.importNumber(phoneE164);
    const owned = await this.findOwnedNumber(phoneE164, 1);
    if (!owned) return null;
    await this.requestJson(this.paths.phoneNumber(owned.id), {
      method: 'PATCH',
      json: { connection_id: this.config.texmlApplicationId },
    });
    if (this.config.messagingProfileId) {
      await this.requestJson(`${this.paths.phoneNumber(owned.id)}/messaging`, {
        method: 'PATCH',
        json: { messaging_profile_id: this.config.messagingProfileId },
      });
    }
    return { providerNumberId: owned.id, phoneE164, capabilities: owned.capabilities };
  }

  /** Release at the carrier. 404 means it is already gone, which is the state we wanted. */
  async releaseNumber(providerNumberId: string): Promise<void> {
    if (this.overrides.releaseNumber) return this.overrides.releaseNumber(providerNumberId);
    const { status, text } = await this.request(this.paths.phoneNumber(providerNumberId), { method: 'DELETE' });
    if (status === 404) return;
    if (status < 200 || status >= 300) {
      throw new TelnyxApiError(status, text, `Telnyx releaseNumber → ${status}`);
    }
  }

  // ── Media + messaging ─────────────────────────────────────────────────────

  async fetchMedia(providerUrl: string): Promise<Uint8Array> {
    return (await this.fetchRecordingMedia({ providerUrl })).bytes;
  }

  /**
   * Recording media, the way Telnyx actually serves it.
   *
   * The recording webhook's `RecordingUrl` is a **pre-signed S3 link valid for
   * about ten minutes after the call**. Two things break it, and both were
   * shipped here as a Twilio-shaped fetcher: appending `.mp3` to a URL that
   * already ends in `.mp3?X-Amz-…`, and attaching an `Authorization` header to
   * a request S3 signed for `host` alone. Either one is answered 400, which is
   * what every transcript and every audio request saw.
   *
   * So: the stored link is used as-is and unsigned while it is still valid,
   * and once it has expired — or fails for any other reason — a fresh one is
   * minted from the recording id, which never expires. Only a Telnyx-hosted
   * URL is sent the API key.
   */
  async fetchRecordingMedia(ref: RecordingMediaRef): Promise<RecordingMedia> {
    const format = ref.format ?? 'mp3';
    const attempts: string[] = [];

    const stored = ref.providerUrl?.trim();
    if (stored && isDirectMediaUrl(stored) && !isExpiredSignedUrl(stored)) {
      try {
        return await this.downloadMedia(stored, format);
      } catch (err) {
        // The link is the perishable half of the pair; when there is an id to
        // look up we simply mint another one rather than failing the job.
        if (!ref.providerRecordingId) throw err;
        attempts.push(`stored url: ${(err as Error).message}`);
      }
    }

    if (!ref.providerRecordingId) {
      if (stored) return this.downloadMedia(stored, format);
      throw new TelnyxApiError(0, '', 'Telnyx recording has neither a media URL nor a recording id');
    }

    const fresh = await this.lookupRecordingUrl(ref.providerRecordingId, format, attempts);
    if (!fresh) {
      throw new TelnyxApiError(
        404,
        '',
        `Telnyx recording ${ref.providerRecordingId} has no downloadable media (${attempts.join('; ')})`,
      );
    }
    return this.downloadMedia(fresh.url, fresh.format);
  }

  /** A fresh media URL for a recording id, from v2 first and TeXML second. */
  private async lookupRecordingUrl(
    recordingId: string,
    format: RecordingFormat,
    attempts: string[],
  ): Promise<{ url: string; format: RecordingFormat } | null> {
    try {
      const body = await this.requestJson<{
        data?: { download_urls?: Partial<Record<RecordingFormat, string>> };
      }>(this.paths.recording(recordingId), { method: 'GET' });
      const urls = body.data?.download_urls ?? {};
      const picked = urls[format] ?? urls.mp3 ?? urls.wav;
      if (picked) {
        return { url: picked, format: urls[format] ? format : urls.mp3 ? 'mp3' : 'wav' };
      }
      attempts.push('v2 recording has no download_urls');
    } catch (err) {
      attempts.push(`v2 lookup: ${(err as Error).message}`);
    }

    try {
      const body = await this.requestJson<{ media_url?: string }>(
        this.paths.texmlRecording(recordingId),
        { method: 'GET' },
      );
      if (body.media_url) return { url: body.media_url, format: formatOf(body.media_url) ?? format };
      attempts.push('texml recording has no media_url');
    } catch (err) {
      attempts.push(`texml lookup: ${(err as Error).message}`);
    }
    return null;
  }

  /**
   * Download the bytes. A Telnyx-hosted URL takes the API key; a pre-signed
   * object-store URL must be requested with no credentials of ours at all.
   */
  private async downloadMedia(url: string, format: RecordingFormat): Promise<RecordingMedia> {
    const res = await this.http(url, {
      headers: isTelnyxHosted(url) ? { authorization: `Bearer ${this.config.apiKey}` } : {},
    });
    if (!res.ok) {
      throw new TelnyxApiError(res.status, '', `Telnyx recording download → ${res.status}`);
    }
    const resolved = formatOf(url) ?? format;
    return {
      bytes: new Uint8Array(await res.arrayBuffer()),
      contentType: resolved === 'wav' ? 'audio/wav' : 'audio/mpeg',
      format: resolved,
    };
  }

  /**
   * Messaging is the v2 JSON API, not TeXML: POST /v2/messages with
   * {from, to, text}. Verified against Telnyx's documented request shape.
   */
  async sendMessage(params: {
    from: string;
    to: string;
    body: string;
    mediaUrls?: string[];
    statusCallbackUrl?: string;
  }): Promise<{ providerMessageId: string }> {
    if (this.overrides.sendMessage) return this.overrides.sendMessage(params);
    const sent = await this.requestJson<{ data: { id: string } }>(this.paths.messages(), {
      method: 'POST',
      json: {
        from: params.from,
        to: params.to,
        text: params.body,
        ...(params.mediaUrls && params.mediaUrls.length > 0 ? { media_urls: params.mediaUrls } : {}),
        ...(this.config.messagingProfileId
          ? { messaging_profile_id: this.config.messagingProfileId }
          : {}),
        ...(params.statusCallbackUrl ? { webhook_url: params.statusCallbackUrl } : {}),
      },
    });
    return { providerMessageId: sent.data.id };
  }
}

/** A recorded greeting plays; otherwise the text is spoken. */
function greetingEl(text: string, audioUrl?: string): string {
  return audioUrl ? el('Play', {}, escapeInner(audioUrl)) : el('Say', {}, escapeInner(text));
}

/** Element bodies are text; reuse the same escaping the attribute path uses. */
function escapeInner(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export {
  TelnyxReputation,
  isApprovedCampaign,
  numberAssignedToApprovedCampaign,
  type CnamListing,
  type NumberReputationResult,
  type TenDlcAssignment,
  type TenDlcBrand,
  type TenDlcCampaign,
  type TenDlcSnapshot,
} from './reputation.js';

// ── Recording media helpers ─────────────────────────────────────────────────

/** `https://…/x.mp3?X-Amz-…` → the container it names, when it names one. */
function formatOf(url: string): RecordingFormat | null {
  const path = (() => {
    try {
      return new URL(url).pathname.toLowerCase();
    } catch {
      return url.toLowerCase().split('?')[0] ?? '';
    }
  })();
  if (path.endsWith('.mp3')) return 'mp3';
  if (path.endsWith('.wav')) return 'wav';
  return null;
}

/** Media we can GET directly, rather than an API resource to read JSON from. */
function isDirectMediaUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  if (formatOf(url)) return true;
  // A pre-signed link whose path has no extension is still media.
  return /[?&]X-Amz-Signature=/i.test(url);
}

function isTelnyxHosted(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'telnyx.com' || host.endsWith('.telnyx.com');
  } catch {
    return false;
  }
}

/**
 * Whether a pre-signed URL's own validity window has already closed, read
 * from `X-Amz-Date` + `X-Amz-Expires`. Unsigned or unreadable URLs are treated
 * as live: the request itself is the better test, and a 403 falls back to a
 * fresh lookup anyway. A minute of slack covers clock skew.
 */
function isExpiredSignedUrl(url: string, nowMs: number = Date.now()): boolean {
  let params: URLSearchParams;
  try {
    params = new URL(url).searchParams;
  } catch {
    return false;
  }
  const date = params.get('X-Amz-Date');
  const expires = Number(params.get('X-Amz-Expires'));
  if (!date || !Number.isFinite(expires) || expires <= 0) return false;
  // Compact ISO 8601: 20260921T153000Z.
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(date);
  if (!m) return false;
  const signedAt = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  return nowMs > signedAt + expires * 1000 - 60_000;
}
