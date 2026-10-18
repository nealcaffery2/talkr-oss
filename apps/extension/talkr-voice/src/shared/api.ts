/**
 * Talkr API client for the extension. Same endpoints the web app uses; the
 * difference is where credentials live. Three separate contexts need them and
 * one of those (the offscreen document) has no storage API, so every request
 * asks the service worker for the session rather than reading storage itself.
 */

import { createNoncePair } from './nonce';
import { ownThreads } from './owner';
import { session as sessionStore, type Session, type SessionUser } from './session';

export interface CallDto {
  id: string;
  direction: 'inbound' | 'outbound';
  status: string;
  from_number: string;
  to_number: string;
  /** The rep the call belongs to. */
  user_id: string | null;
  lead_id: string | null;
  contact_id: string | null;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  created_at: string;
  /**
   * Inbound: why it rang who it rang. reason 'last_contact' means it rang the
   * rep who last reached out, and last_contact says how and when.
   */
  routing?: {
    reason: string | null;
    last_contact: { user_id: string; channel: 'call' | 'sms' | 'rvm' | 'email' | 'other'; occurred_at: string; ref: string | null } | null;
  } | null;
}

export interface ParticipantDto {
  id: string;
  call_id: string;
  provider_participant_id: string;
  role: 'agent' | 'customer' | 'teammate' | 'external';
  state: 'ringing' | 'joined' | 'on_hold' | 'left';
  user_id: string | null;
  address: string | null;
  label: string | null;
  joined_at: string | null;
  left_at: string | null;
}

export interface TeamMemberDto {
  id: string;
  display_name: string;
  role: string;
  /** The job ("Acquisitions"), not the RBAC role. Null when nobody set one. */
  title: string | null;
  timezone: string | null;
  city: string | null;
  presence: string;
  last_seen_at: string | null;
  is_self: boolean;
}

export interface ConversationDto {
  id: string;
  our_number: string;
  their_number: string;
  contact_name: string | null;
  lead_id: string | null;
  lead_status: string | null;
  last_message_at: string | null;
  last_message: { direction: 'inbound' | 'outbound'; body: string; media_count: number } | null;
  unread_count: number;
  /** The org line the thread is on, and who it is assigned to: whose thread it is (shared/owner.ts). */
  phone_number_id?: string | null;
  assigned_user_id?: string | null;
  assigned_user_name?: string | null;
}

export interface MessageDto {
  id: string;
  conversation_id: string;
  direction: 'outbound' | 'inbound';
  status: string;
  body: string;
  media_urls: string[];
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  /** The numbers it travelled between. Absent on servers before the from/to fields. */
  from_number?: string | null;
  to_number?: string | null;
  /** The teammate who sent an outbound text; null for an inbound one or an automatic reply. */
  created_by?: string | null;
  is_auto_reply?: boolean;
  error_code?: string | null;
}

export interface MessageTemplateDto {
  id: string;
  name: string;
  body: string;
}

export interface PhoneLookupDto {
  contact: { id: string; display_name: string } | null;
  lead: { id: string; status: string; source: string | null } | null;
  property: { id: string; address_line1: string | null; city: string | null; state: string | null } | null;
}

export interface LeadCardDto {
  lead: { id: string; status: string; source: string | null };
  contact: { id: string; display_name: string; phone: string | null } | null;
  property: {
    id: string;
    address_line1: string | null;
    city: string | null;
    state: string | null;
    postal_code: string | null;
  } | null;
}

/** One row of a lead's merged history (GET /v1/leads/:id). */
export interface ActivityEventDto {
  id: string;
  kind: 'call' | 'message' | 'task' | 'milestone';
  at: string;
  title: string;
  detail: string | null;
  actor: string | null;
  meta: Record<string, string | number | boolean | null>;
}

export interface LeadActivityDto {
  card: LeadCardDto;
  assigned_user: { id: string; display_name: string } | null;
  received_at: string | null;
  open_tasks: number;
  timeline: ActivityEventDto[];
}

// ── Contacts, scripts and the in-call context (GET /v1/call-context) ───────
// Mirrors apps/web/lib/api.ts; the extension cannot import across app
// boundaries, so the vocabulary is repeated here by hand.

export const CONTACT_TYPES = ['seller', 'buyer', 'title', 'company', 'vendor', 'other'] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

export const CONTACT_STATUSES = [
  'new',
  'attempting',
  'engaged',
  'appointment',
  'offer',
  'under_contract',
  'closed',
  'dead',
  'dnc',
] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const TEMPERATURES = ['hot', 'warm', 'cold'] as const;
export type Temperature = (typeof TEMPERATURES)[number];

export interface ContactPhoneDto {
  id: string;
  phone_e164: string;
  label: string | null;
  is_primary: boolean;
}

export interface ContactAddressDto {
  line1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
}

export interface ContactDto {
  id: string;
  display_name: string;
  type: ContactType;
  status: ContactStatus;
  email: string | null;
  company: string | null;
  tags: string[];
  source: string | null;
  notes: string | null;
  temperature: Temperature;
  temperature_score: number;
  temperature_locked: boolean;
  last_activity_at: string | null;
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  phones: ContactPhoneDto[];
  primary_phone: string | null;
  address: ContactAddressDto | null;
  lead_id: string | null;
  lead_status: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
}

export interface ScriptDto {
  id: string;
  kind: 'script' | 'rebuttal';
  title: string;
  category: string | null;
  tags: string[];
  contact_types: ContactType[];
  campaign_id: string | null;
  /** Light markdown: `## `, `- `, `**bold**`, `> `, with `{first_name}` merge fields. */
  body: string;
  sort_order: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

/** A script with its merge fields already filled in by the server. */
export type RenderedScriptDto = ScriptDto & { rendered_body: string };

export interface CallContextActivityDto {
  kind: 'call' | 'sms' | 'task';
  id: string;
  at: string;
  direction: 'inbound' | 'outbound' | null;
  status: string | null;
  duration_seconds: number | null;
  body: string | null;
  disposition_label: string | null;
  note: string | null;
  user_name: string | null;
}

/**
 * Everything a rep should see the moment a call rings or connects: who it is,
 * what has happened, what to say, and what to say back.
 */
export interface CallContextDto {
  phone_e164: string;
  contact: ContactDto | null;
  lead: {
    id: string;
    status: string;
    source: string | null;
    assigned_user_id: string | null;
    assigned_user_name: string | null;
    external_item_id: string | null;
    crm_url: string | null;
    created_at: string;
  } | null;
  property: {
    id: string;
    line1: string | null;
    city: string | null;
    state: string | null;
    postal_code: string | null;
  } | null;
  activity: CallContextActivityDto[];
  last_call_summary: {
    call_id: string;
    at: string;
    summary: string;
    next_steps: string[];
    objections: string[];
  } | null;
  open_tasks: Array<{ id: string; title: string; due_at: string | null; assigned_user_name: string | null }>;
  sequences: Array<{
    id: string;
    name: string;
    run_status: string;
    step: number;
    step_count: number;
    resume_at: string | null;
  }>;
  campaign: { id: string; name: string } | null;
  scripts: {
    primary: RenderedScriptDto | null;
    alternatives: Array<{ id: string; title: string; category: string | null }>;
    rebuttals: RenderedScriptDto[];
  };
  merge_fields: Record<string, string>;
  /** Set when nothing is on file: offer to create a contact for this number. */
  suggest_create: { phone_e164: string } | null;
}

/** Exactly one of these identifies the call. */
export type CallContextQuery =
  | { phone: string }
  | { contact_id: string }
  | { lead_id: string }
  | { call_id: string };

/** Mirrors the engine's own view of `POST /v1/voice/token`. */
export type { VoiceTokenDto } from '@/offscreen/engine';
import type { VoiceTokenDto } from '@/offscreen/engine';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface OrgNumberDto {
  id: string;
  phone_e164: string;
  label: string | null;
  area_code: string | null;
  assigned_user_id: string | null;
  /** Absent from servers older than the owner-name join. */
  assigned_user_name?: string | null;
}

export interface MeDto extends SessionUser {
  timezone: string | null;
  city: string | null;
  numbers: Array<{ id: string; phone_e164: string; label: string | null }>;
  /** Every active line in the org: the caller-ID picker's options. */
  org_numbers: OrgNumberDto[];
  default_phone_number_id: string | null;
  caller_id_mode: 'dedicated' | 'local_presence';
}

/** One row of GET /v1/history: a call or a text, newest first. */
export interface HistoryItemDto {
  kind: 'call' | 'sms';
  id: string;
  direction: 'inbound' | 'outbound';
  status: string;
  at: string;
  duration_seconds: number | null;
  from_number: string;
  to_number: string;
  contact_name: string | null;
  address: string | null;
  user_id: string | null;
  user_name: string | null;
  disposition_label: string | null;
  note: string | null;
  has_recording: boolean;
  /** Sent to voicemail. Absent on servers older than the flag. */
  voicemail?: boolean;
  body: string | null;
  lead_id: string | null;
  contact_id: string | null;
  conversation_id: string | null;
}

export interface SessionResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user: SessionUser;
}

function toSession(r: SessionResponse): Session {
  return {
    accessToken: r.access_token,
    refreshToken: r.refresh_token,
    expiresAt: r.expires_at,
    user: r.user,
  };
}

async function parseError(res: Response): Promise<ApiError> {
  let code = 'error';
  let message = res.statusText;
  try {
    const body = (await res.json()) as { error?: string; message?: string; detail?: string };
    code = body.error ?? code;
    message = body.message ?? message;
    // Some failures carry the upstream reason. A rep cannot act on it, but a
    // message they can read out is the difference between a fixed config and
    // an afternoon of guessing.
    if (body.detail && body.detail !== message) message = `${message} (${body.detail})`;
  } catch {
    /* non-JSON error */
  }
  return new ApiError(res.status, code, message);
}

async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  const apiUrl = await sessionStore.apiUrl();
  const current = await sessionStore.get();
  if (!current) throw new ApiError(401, 'unauthenticated', 'Sign in to continue.');
  let res: Response;
  try {
    res = await fetch(`${apiUrl}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        authorization: `Bearer ${current.accessToken}`,
        ...init.headers,
      },
    });
  } catch {
    // Say the server is unreachable rather than leaking "Failed to fetch".
    // The extension also needs the API's origin in host_permissions.
    throw new ApiError(0, 'backend_unreachable', `Can't reach the Talkr API at ${apiUrl}.`);
  }
  if (res.status === 401 && !retried) {
    // The token died between the worker's staleness check and the server's:
    // renew once and retry. A second 401 is a real sign-out.
    const renewed = await sessionStore.refresh();
    if (renewed) return request<T>(path, init, true);
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  if (new Headers(init.headers).get('accept') === 'audio/*') return (await res.blob()) as T;
  return (await res.json()) as T;
}

/**
 * Sign-in calls go out without a bearer, so they bypass `request`. Each one
 * hands the resulting session to the service worker, which is the only place
 * tokens are stored.
 */
export interface AuthConfigDto {
  password_signin: boolean;
  token_signin: boolean;
  google_signin: boolean;
  /** The public OAuth client id; null unless the server enables Google. */
  google_client_id: string | null;
}

/**
 * Ask Google for an id_token in a popup window Chrome owns.
 *
 * The extension has nowhere to host a redirect, so it uses the identity API's
 * `https://<extension id>.chromiumapp.org/` loopback and reads the fragment
 * Google leaves on it. The nonce binds the token to this one attempt: Google
 * embeds it, GoTrue re-checks it, so a token captured elsewhere cannot be
 * replayed at our API. The extension id is pinned by the manifest's `key`, so
 * this URI is the same on every rep's machine and needs registering once.
 *
 * Google gets the hashed half of the nonce and the caller the raw half; see
 * ./nonce for why they differ.
 */
async function googleIdToken(clientId: string): Promise<{ idToken: string; nonce: string }> {
  const nonce = await createNoncePair();
  const url = new URL('https://accounts.google.com/o/oauth2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'id_token');
  url.searchParams.set('redirect_uri', `https://${chrome.runtime.id}.chromiumapp.org/`);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('nonce', nonce.hashed);
  // Always show the chooser: a shared machine must not silently reuse whoever
  // signed in last, and a rep with two Google accounts has to pick the work one.
  url.searchParams.set('prompt', 'select_account');

  let redirectedTo: string | undefined;
  try {
    redirectedTo = await chrome.identity.launchWebAuthFlow({ url: url.href, interactive: true });
  } catch (err) {
    // Closing the window is the ordinary way to change your mind, not a fault.
    const message = (err as Error).message ?? '';
    if (/closed|cancel/i.test(message)) throw new ApiError(0, 'google_cancelled', 'Sign-in cancelled.');
    throw new ApiError(0, 'google_failed', message || 'Google sign-in failed.');
  }
  if (!redirectedTo) throw new ApiError(0, 'google_cancelled', 'Sign-in cancelled.');

  // Google answers on the fragment; an error comes back on the query string.
  const back = new URL(redirectedTo);
  const params = new URLSearchParams(back.hash.replace(/^#/, ''));
  const idToken = params.get('id_token');
  if (!idToken) {
    const reason = params.get('error') ?? back.searchParams.get('error') ?? 'no id_token returned';
    throw new ApiError(0, 'google_failed', `Google sign-in failed: ${reason}`);
  }
  return { idToken, nonce: nonce.raw };
}

export const auth = {
  config: async (): Promise<AuthConfigDto> => {
    const res = await fetch(`${await sessionStore.apiUrl()}/v1/auth/config`);
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as AuthConfigDto;
  },
  /**
   * "Continue with Google". Google vouches for the rep, our API trades that
   * for a Supabase session, and a rep who was only ever invited by email is
   * claimed and activated by that first sign-in — no password to set.
   */
  signInWithGoogle: async (clientId: string): Promise<Session> => {
    const { idToken, nonce } = await googleIdToken(clientId);
    const apiUrl = await sessionStore.apiUrl();
    let res: Response;
    try {
      res = await fetch(`${apiUrl}/v1/auth/google`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id_token: idToken, nonce }),
      });
    } catch {
      throw new ApiError(0, 'backend_unreachable', `Can't reach the Talkr API at ${apiUrl}.`);
    }
    if (!res.ok) throw await parseError(res);
    const s = toSession((await res.json()) as SessionResponse);
    await sessionStore.set(s);
    return s;
  },
  signIn: async (email: string, password: string): Promise<Session> => {
    let res: Response;
    try {
      res = await fetch(`${await sessionStore.apiUrl()}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    } catch {
      throw new ApiError(0, 'backend_unreachable', "Can't reach the Talkr API.");
    }
    if (!res.ok) throw await parseError(res);
    const s = toSession((await res.json()) as SessionResponse);
    await sessionStore.set(s);
    return s;
  },
  /** A JWT minted elsewhere (dev, or an org without password sign-in). */
  signInWithToken: async (token: string): Promise<Session> => {
    const apiUrl = await sessionStore.apiUrl();
    let res: Response;
    try {
      res = await fetch(`${apiUrl}/v1/me`, { headers: { authorization: `Bearer ${token}` } });
    } catch {
      throw new ApiError(0, 'backend_unreachable', `Can't reach the Talkr API at ${apiUrl}.`);
    }
    if (!res.ok) throw await parseError(res);
    const me = (await res.json()) as MeDto;
    const s: Session = {
      accessToken: token,
      refreshToken: null,
      expiresAt: jwtExpiry(token),
      user: { id: me.id, display_name: me.display_name, email: me.email, role: me.role, org: me.org },
    };
    await sessionStore.set(s);
    return s;
  },
  signOut: async (): Promise<void> => {
    const current = await sessionStore.get().catch(() => null);
    if (current) {
      // Best effort: the session is gone locally whatever the server says.
      void fetch(`${await sessionStore.apiUrl()}/v1/auth/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${current.accessToken}` },
      }).catch(() => undefined);
    }
    await sessionStore.clear();
  },
};

function jwtExpiry(token: string): number | null {
  try {
    const payload = JSON.parse(atob(token.split('.')[1]!.replace(/-/g, '+').replace(/_/g, '/'))) as {
      exp?: number;
    };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}

export const api = {
  /**
   * A browser credential plus which carrier minted it. `provider` and
   * `browser_leg` decide which SDK the offscreen document loads and who opens
   * the rep's leg on an outbound call; see src/offscreen/engine.ts.
   */
  voiceToken: () => request<VoiceTokenDto>('/v1/voice/token', { method: 'POST' }),
  /**
   * Ask the server to ring this browser for a call it already created. The
   * invite arrives on the Telnyx socket and the engine answers it.
   */
  ringBrowserLeg: (callId: string) =>
    request<{ mode: string; provider_call_id: string | null }>(
      `/v1/calls/${encodeURIComponent(callId)}/browser-leg`,
      { method: 'POST', body: JSON.stringify({}) },
    ),
  heartbeat: (status: 'available' | 'away' | 'offline') =>
    request<{ ok: boolean }>('/v1/presence', { method: 'POST', body: JSON.stringify({ status }) }),
  lookupPhone: (number: string) =>
    request<PhoneLookupDto>(`/v1/lookup/phone?number=${encodeURIComponent(number)}`),
  createCall: (input: { to_number?: string; lead_id?: string }) =>
    request<{ call: CallDto }>('/v1/calls', { method: 'POST', body: JSON.stringify(input) }),
  getCall: (id: string) => request<{ call: CallDto }>(`/v1/calls/${id}`),
  /** The inbound call ringing this browser from `from`; the invite itself carries no call id. */
  ringingCall: (from: string) =>
    request<{ call: CallDto }>(`/v1/calls/ringing?from=${encodeURIComponent(from)}`),
  listCalls: () => request<{ calls: CallDto[] }>('/v1/calls'),
  listTeam: () => request<{ members: TeamMemberDto[] }>('/v1/team'),
  getMe: () => request<MeDto>('/v1/me'),
  /** Caller ID is the rep's saved default, the same one CLOZR and the web app use. */
  updateMe: (input: { default_phone_number_id?: string | null; caller_id_mode?: 'dedicated' | 'local_presence' }) =>
    request<unknown>('/v1/me', { method: 'PATCH', body: JSON.stringify(input) }),
  /** Calls, newest first: Recents, Voicemail and the calls in the Inbox. */
  /** Only this rep's calls: an admin's history would otherwise be the whole org's. */
  callHistory: (userId: string, limit = 200) => {
    // History defaults to 30 days; a voicemail nobody played is still worth showing after that.
    const from = new Date(Date.now() - 90 * 86_400_000).toISOString();
    return request<{ items: HistoryItemDto[] }>(
      `/v1/history?type=calls&limit=${limit}&user_id=${encodeURIComponent(userId)}&from=${encodeURIComponent(from)}`,
    );
  },
  callRecordings: (id: string) =>
    request<{ recordings: Array<{ id: string; status: string }> }>(`/v1/calls/${encodeURIComponent(id)}`),
  /** The MP3, fetched with the bearer since an <audio src> cannot send one. */
  recordingAudio: (id: string) =>
    request<Blob>(`/v1/recordings/${encodeURIComponent(id)}/audio`, { headers: { accept: 'audio/*' } }),
  /** The lead's card and its recent history, for the Lead tab. */
  getLead: (id: string) => request<LeadActivityDto>(`/v1/leads/${encodeURIComponent(id)}`),

  // Conference call control (docs/telephony-events.md §9)
  listParticipants: (callId: string) =>
    request<{ participants: ParticipantDto[] }>(`/v1/calls/${callId}/participants`),
  setHold: (callId: string, hold: boolean) =>
    request<{ participants: ParticipantDto[] }>(`/v1/calls/${callId}/hold`, {
      method: 'POST',
      body: JSON.stringify({ hold }),
    }),
  addParticipant: (callId: string, input: { user_id?: string; to_number?: string; consult?: boolean }) =>
    request<{ participant: ParticipantDto }>(`/v1/calls/${callId}/participants`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  mergeCall: (callId: string) =>
    request<{ participants: ParticipantDto[] }>(`/v1/calls/${callId}/merge`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  removeParticipant: (callId: string, providerParticipantId: string) =>
    request<{ ok: boolean }>(`/v1/calls/${callId}/participants/${providerParticipantId}/remove`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  transferCall: (callId: string, input: { mode: 'warm' | 'blind'; user_id?: string; to_number?: string }) =>
    request<{ participant: ParticipantDto }>(`/v1/calls/${callId}/transfer`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  completeTransfer: (callId: string) =>
    request<{ ok: boolean }>(`/v1/calls/${callId}/transfer/complete`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),

  // SMS
  listConversations: () => request<{ conversations: ConversationDto[] }>('/v1/conversations'),
  /**
   * The rep's own threads. An owner or admin's plain list is the whole
   * office's, newest 50; this reads the threads assigned to the rep and the
   * threads on each of their lines, then keeps the ones that are theirs.
   */
  listMyConversations: async (me: MeDto): Promise<ConversationDto[]> => {
    const lines = (me.org_numbers ?? []).filter((n) => n.assigned_user_id === me.id);
    const paths = [
      `/v1/conversations?user_id=${encodeURIComponent(me.id)}&limit=100`,
      ...lines.map((n) => `/v1/conversations?number_id=${encodeURIComponent(n.id)}&limit=100`),
    ];
    const lists = await Promise.all(
      paths.map((p) =>
        request<{ conversations: ConversationDto[] }>(p)
          .then((r) => r.conversations)
          .catch((err: unknown) => err as Error),
      ),
    );
    const ok = lists.filter((l): l is ConversationDto[] => Array.isArray(l));
    if (!ok.length) throw lists[0] as Error;
    return ownThreads(ok, me);
  },
  listConversationMessages: (id: string) =>
    request<{ messages: MessageDto[] }>(`/v1/conversations/${id}/messages`),
  markConversationRead: (id: string) =>
    request<{ ok: boolean }>(`/v1/conversations/${id}/read`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  sendMessage: (input: {
    conversation_id?: string;
    /** The line to send from; without it the server picks the thread's line or the rep's default. */
    from_phone_number_id?: string;
    to_number?: string;
    body?: string;
    template_id?: string;
    lead_id?: string;
  }) =>
    request<{ message: MessageDto; conversation_id: string }>('/v1/messages', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  listMessageTemplates: () => request<{ templates: MessageTemplateDto[] }>('/v1/message-templates'),

  // In-call context: lead, scripts and rebuttals for the number on the line
  getCallContext: (query: CallContextQuery) => {
    const [key, value] = Object.entries(query)[0]!;
    return request<CallContextDto>(`/v1/call-context?${key}=${encodeURIComponent(value)}`);
  },
  /**
   * One alternative script by id. The context endpoint lists alternatives as
   * titles only; the body is fetched when the rep picks one and rendered here
   * from `merge_fields`. Accepts either `{ script }` or a bare ScriptDto.
   */
  getScript: async (id: string): Promise<ScriptDto> => {
    const r = await request<{ script?: ScriptDto } & Partial<ScriptDto>>(
      `/v1/scripts/${encodeURIComponent(id)}`,
    );
    return (r.script ?? r) as ScriptDto;
  },
  markScriptUsed: (id: string, input: { call_id?: string; contact_id?: string }) =>
    request<void>(`/v1/scripts/${encodeURIComponent(id)}/used`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateContact: (id: string, input: { notes?: string; status?: ContactStatus; temperature?: Temperature }) =>
    request<{ contact: ContactDto }>(`/v1/contacts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  createContact: (input: { display_name: string; type: ContactType; phone: string }) =>
    request<{ contact: ContactDto }>('/v1/contacts', { method: 'POST', body: JSON.stringify(input) }),
};
