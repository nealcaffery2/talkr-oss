/**
 * Thin client for the platform API (apps/server). The browser holds a user
 * JWT only — never provider credentials (docs/security.md).
 */

import type { VoiceTokenDto } from './softphone-engine';
export interface CallDto {
  id: string;
  correlation_id: string;
  direction: 'outbound' | 'inbound';
  status: string;
  user_id: string | null;
  lead_id: string | null;
  contact_id: string | null;
  from_number: string;
  to_number: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  failure_class: string;
  disposition_id: string | null;
  crm_sync_status: string;
  /** The contact behind the number, when the call is linked to one. */
  contact_name: string | null;
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

// ── Recordings + transcripts (docs/transcription.md) ─────────────────────────

export interface RecordingDto {
  id: string;
  /** processing|completed|failed|absent|deleted */
  status: string;
  duration_seconds: number | null;
  /** 2 = one party per channel; anything else is a mixed mono recording. */
  channels: number | null;
}

export type TranscriptSpeaker = 'rep' | 'contact' | 'unknown';

export interface TranscriptSegmentDto {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  speaker: TranscriptSpeaker;
  text: string;
  confidence: number;
}

/** The structured half of the AI notes; every field is absent until the summary ran. */
export interface CallNotesDto {
  key_points?: string[];
  seller_motivation?: string | null;
  timeline?: string | null;
  asking_price?: string | null;
  property_condition?: string | null;
  objections?: string[];
  next_step?: string | null;
  sentiment?: 'positive' | 'neutral' | 'negative' | 'mixed' | null;
  /** Rep share of speaking time, 0–1. */
  rep_talk_ratio?: number | null;
}

export interface TranscriptDto {
  id: string;
  recording_id: string | null;
  status: 'queued' | 'processing' | 'completed' | 'failed' | 'not_configured';
  provider: string;
  model: string | null;
  language: string | null;
  duration_seconds: number | null;
  segments: TranscriptSegmentDto[];
  full_text: string | null;
  summary: string | null;
  ai: CallNotesDto;
  ai_model: string | null;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface CallTranscriptDto {
  transcript: TranscriptDto | null;
  /** The recording the transcript belongs to (the longest completed one). */
  recording: RecordingDto | null;
  /** The wrap-up the rep wrote, beside what the AI heard. */
  call: { disposition: string | null; disposition_note: string | null; follow_up_at: string | null };
  /** DEEPGRAM_API_KEY is set on the server. */
  configured: boolean;
  /** ANTHROPIC_API_KEY is set on the server. */
  summary_configured: boolean;
}

export interface DispositionDto {
  slug: string;
  name: string;
  requires_follow_up: boolean;
  adds_suppression: boolean;
}

export interface LeadDto {
  id: string;
  status: string;
  source: string | null;
  primaryContactId: string | null;
  createdAt: string;
}

const TOKEN_KEY = 'talkr.jwt';
const API_KEY = 'talkr.apiUrl';
const SESSION_KEY = 'talkr.session';
/** Fired on window when the API rejects the session for good. */
export const SIGNED_OUT_EVENT = 'talkr:signed-out';

export function isSignedIn(): boolean {
  return Boolean(getToken() ?? memoryToken);
}
/** Refresh this close to expiry so a request in flight never uses a dead token. */
const REFRESH_SKEW_SECONDS = 90;

export interface SessionUser {
  id: string;
  display_name: string | null;
  email: string | null;
  role: string | null;
  org: { id: string; name: string; slug: string } | null;
}

/** Everything about the session except the access token, which stays in TOKEN_KEY. */
interface SessionMeta {
  refreshToken: string | null;
  expiresAt: number | null;
  user: SessionUser | null;
}

function readJson<T>(key: string): T | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : null;
  } catch {
    return null;
  }
}

function writeJson<T>(key: string, value: T | null): void {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* private mode */
  }
}

export function getSessionUser(): SessionUser | null {
  return readJson<SessionMeta>(SESSION_KEY)?.user ?? null;
}

export function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setToken(token: string): void {
  try {
    window.localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // private mode: session-only auth still works via in-memory fallback below
    memoryToken = token;
  }
}

export function clearToken(): void {
  try {
    window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  writeJson(SESSION_KEY, null);
  memoryToken = null;
}

let memoryToken: string | null = null;

export function apiUrl(): string {
  if (typeof window !== 'undefined') {
    try {
      const stored = window.localStorage.getItem(API_KEY);
      if (stored) return stored;
    } catch {
      /* ignore */
    }
  }
  if (process.env.NEXT_PUBLIC_API_URL) return process.env.NEXT_PUBLIC_API_URL;
  // No configured URL: a local checkout talks to a local server, and the
  // deployed app talks to the API deployed beside it from apps/server.
  const local = typeof window !== 'undefined' && /^(localhost|127\.0\.0\.1)$/.test(window.location.hostname);
  return local ? 'http://localhost:4000' : 'https://api.talkr.example.com';
}

export function setApiUrl(url: string): void {
  try {
    window.localStorage.setItem(API_KEY, url);
  } catch {
    /* ignore */
  }
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    /** The parsed error body, for endpoints that say more than a code (409 duplicate → contact_id). */
    public readonly body: Record<string, unknown> | null = null,
  ) {
    super(message);
  }
}

interface SessionResponse {
  access_token: string;
  refresh_token: string;
  expires_at: number;
  user: SessionUser;
}

function storeSession(r: SessionResponse): void {
  setToken(r.access_token);
  writeJson<SessionMeta>(SESSION_KEY, {
    refreshToken: r.refresh_token,
    expiresAt: r.expires_at,
    user: r.user,
  });
}

let refreshing: Promise<boolean> | null = null;

/**
 * Redeem the refresh token. Shared across concurrent callers because refresh
 * tokens are single-use: two tabs' requests racing here would sign the rep
 * out. A rejected refresh clears the session; an unreachable server keeps it.
 */
function refreshSession(): Promise<boolean> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const meta = readJson<SessionMeta>(SESSION_KEY);
      if (!meta?.refreshToken) return false;
      let res: Response;
      try {
        res = await fetch(`${apiUrl()}/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refresh_token: meta.refreshToken }),
        });
      } catch {
        return false;
      }
      if (res.status === 401 || res.status === 403) {
        clearToken();
        return false;
      }
      if (!res.ok) return false;
      storeSession((await res.json()) as SessionResponse);
      return true;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

function sessionIsStale(): boolean {
  const meta = readJson<SessionMeta>(SESSION_KEY);
  return Boolean(
    meta?.refreshToken && meta.expiresAt && meta.expiresAt - REFRESH_SKEW_SECONDS <= Date.now() / 1000,
  );
}

async function parseError(res: Response): Promise<ApiError> {
  let code = 'error';
  let message = res.statusText;
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
    if (typeof body.error === 'string') code = body.error;
    if (typeof body.message === 'string') message = body.message;
  } catch {
    /* non-JSON error */
  }
  return new ApiError(res.status, code, message, body);
}

export interface AuthConfigDto {
  password_signin: boolean;
  token_signin: boolean;
  /** The server runs unauthenticated requests as a fixed user: no sign-in needed. */
  open_access: boolean;
}

/** Sign-in calls carry no bearer, so they bypass `request`. */
export const auth = {
  config: async (): Promise<AuthConfigDto> => {
    const res = await fetch(`${apiUrl()}/v1/auth/config`);
    if (!res.ok) throw await parseError(res);
    return (await res.json()) as AuthConfigDto;
  },
  signIn: async (email: string, password: string): Promise<SessionUser> => {
    let res: Response;
    try {
      res = await fetch(`${apiUrl()}/v1/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
    } catch {
      throw new ApiError(0, 'backend_unreachable', `Can't reach the Talkr API at ${apiUrl()}.`);
    }
    if (!res.ok) throw await parseError(res);
    const body = (await res.json()) as SessionResponse;
    storeSession(body);
    return body.user;
  },
  /** Email a reset link that lands on /login/reset. Silent about unknown emails. */
  recover: async (email: string): Promise<void> => {
    const res = await fetch(`${apiUrl()}/v1/auth/recover`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email, redirect_to: `${window.location.origin}/login/reset` }),
    });
    if (!res.ok) throw await parseError(res);
  },
  /** Set a new password with the recovery token from the emailed link. */
  resetPassword: async (accessToken: string, password: string): Promise<void> => {
    const res = await fetch(`${apiUrl()}/v1/auth/reset`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ access_token: accessToken, password }),
    });
    if (!res.ok) throw await parseError(res);
  },
  /** A JWT minted elsewhere (dev, or a server without password sign-in). */
  signInWithToken: async (token: string): Promise<SessionUser> => {
    let res: Response;
    try {
      res = await fetch(`${apiUrl()}/v1/me`, { headers: { authorization: `Bearer ${token}` } });
    } catch {
      throw new ApiError(0, 'backend_unreachable', `Can't reach the Talkr API at ${apiUrl()}.`);
    }
    if (!res.ok) throw await parseError(res);
    const me = (await res.json()) as MeDto;
    const user: SessionUser = { id: me.id, display_name: me.display_name, email: me.email, role: me.role, org: me.org };
    setToken(token);
    writeJson<SessionMeta>(SESSION_KEY, { refreshToken: null, expiresAt: null, user });
    return user;
  },
  signOut: async (): Promise<void> => {
    const token = getToken() ?? memoryToken;
    if (token) {
      // Best effort: the session is gone locally whatever the server says.
      void fetch(`${apiUrl()}/v1/auth/logout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      }).catch(() => undefined);
    }
    clearToken();
  },
};

/**
 * Whether the server lets requests in without a session (AUTH_BYPASS_USER_EMAIL
 * on the server, for product testing). Asked once per page load and remembered,
 * so the gate decides instantly on every navigation after the first. An
 * unreachable server counts as closed — the gate then shows sign-in, which is
 * where the connection problem gets explained — and is asked again next time.
 */
let openAccessPromise: Promise<boolean> | null = null;
export function openAccess(): Promise<boolean> {
  openAccessPromise ??= auth
    .config()
    .then((c) => Boolean(c.open_access))
    .catch(() => {
      openAccessPromise = null;
      return false;
    });
  return openAccessPromise;
}

async function request<T>(path: string, init: RequestInit = {}, retried = false): Promise<T> {
  if (sessionIsStale()) await refreshSession();
  const token = getToken() ?? memoryToken;
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'content-type': 'application/json' } : {}),
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    // The API server is unreachable (not deployed yet, or the wrong URL). Say
    // that plainly instead of leaking the browser's "Failed to fetch".
    throw new ApiError(
      0,
      'backend_unreachable',
      `Can't reach the Talkr API at ${apiUrl()}. Set the API URL under Account once the server is deployed.`,
    );
  }
  if (res.status === 401 && !retried && (await refreshSession())) {
    // The token died between our staleness check and the server's: one retry.
    return request<T>(path, init, true);
  }
  if (res.status === 401) {
    // Nothing left to renew with: the session is over. Drop it and tell the
    // shell, so the rep lands on sign-in instead of on silently empty pages.
    clearToken();
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  }
  if (!res.ok) throw await parseError(res);
  // A 204 (DELETE) has nothing to parse; the caller's T is void.
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * `request` for endpoints that answer with a file (CSV exports): the same
 * session handling, but the body comes back as a Blob with the filename the
 * server suggested in Content-Disposition, when it did.
 */
async function requestBlob(
  path: string,
  init: RequestInit = {},
  retried = false,
): Promise<{ blob: Blob; filename: string | null }> {
  if (sessionIsStale()) await refreshSession();
  const token = getToken() ?? memoryToken;
  let res: Response;
  try {
    res = await fetch(`${apiUrl()}${path}`, {
      ...init,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(
      0,
      'backend_unreachable',
      `Can't reach the Talkr API at ${apiUrl()}. Set the API URL under Account once the server is deployed.`,
    );
  }
  if (res.status === 401 && !retried && (await refreshSession())) {
    return requestBlob(path, init, true);
  }
  if (res.status === 401) {
    clearToken();
    if (typeof window !== 'undefined') window.dispatchEvent(new Event(SIGNED_OUT_EVENT));
  }
  if (!res.ok) throw await parseError(res);
  const disposition = res.headers.get('content-disposition') ?? '';
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  let filename: string | null = null;
  if (match) {
    try {
      filename = decodeURIComponent(match[1]!);
    } catch {
      filename = match[1]!;
    }
  }
  return { blob: await res.blob(), filename };
}

export interface PhoneLookupDto {
  contact: { id: string; display_name: string } | null;
  lead: { id: string; status: string; source: string | null } | null;
  property: { id: string; address_line1: string | null; city: string | null; state: string | null } | null;
}

// ── Reporting + floor (Phase 6) ────────────────────────────────────────────

export interface ReportRangeDto {
  from: string;
  to: string;
  timezone: string;
}

export interface OverviewReportDto {
  range: ReportRangeDto;
  totals: {
    total: number;
    outbound: number;
    inbound: number;
    answered: number;
    answered_outbound: number;
    answered_inbound: number;
    missed: number;
    voicemails_left: number;
    undispositioned: number;
  };
  answer_rate: { outbound: number | null; inbound: number | null };
  talk: { total_seconds: number; avg_seconds: number | null; calls_with_talk: number };
  speed_to_lead: {
    avg_seconds: number | null;
    leads_received: number;
    leads_awaiting_first_attempt: number;
  };
  dispositions: Array<{ slug: string; name: string; count: number }>;
}

export interface ByRepReportDto {
  range: ReportRangeDto;
  reps: Array<{
    user_id: string;
    display_name: string;
    role: string;
    calls_made: number;
    calls_received: number;
    answered: number;
    talk_seconds: number;
    avg_wrapup_seconds: number | null;
    dispositions: Record<string, number>;
    cost: Record<string, string> | null;
  }>;
}

export interface ByDayReportDto {
  range: ReportRangeDto;
  days: Array<{ day: string; total: number; outbound: number; inbound: number; answered: number; missed: number }>;
}

export interface QueuesReportDto {
  range: ReportRangeDto;
  queues: Array<{
    queue_id: string;
    name: string;
    strategy: string;
    offered: number;
    answered: number;
    overflowed: number;
    avg_wait_to_answer_seconds: number | null;
    avg_wait_to_overflow_seconds: number | null;
  }>;
}

export interface QualityReportDto {
  range: ReportRangeDto;
  failure_classes: Record<string, number>;
  carrier_failure_trend: Array<{ day: string; carrier_failures: number; terminal_calls: number }>;
  mismatches: { open: number; resolved: number };
  recordings: { missing: number; failed: number };
}

// ── Activity history (calls + texts, docs/reporting.md §8) ─────────────────

export type HistoryType = 'all' | 'calls' | 'sms';

/** GET /v1/history query. `from`/`to` are YYYY-MM-DD (org-zone days) or ISO instants. */
export interface HistoryQuery {
  type?: HistoryType;
  from?: string;
  to?: string;
  direction?: 'inbound' | 'outbound';
  status?: string;
  user_id?: string;
  disposition?: string;
  min_duration?: number;
  max_duration?: number;
  has_recording?: boolean;
  has_note?: boolean;
  q?: string;
  limit?: number;
  offset?: number;
}

export interface HistoryItemDto {
  kind: 'call' | 'sms';
  id: string;
  direction: 'inbound' | 'outbound';
  status: string;
  at: string;
  /** Talk time (answered→ended) for calls; null for texts and unanswered calls. */
  duration_seconds: number | null;
  from_number: string;
  to_number: string;
  contact_name: string | null;
  /** "line1, city, state" from the lead's CRM property, when known. */
  address: string | null;
  user_id: string | null;
  user_name: string | null;
  disposition_slug: string | null;
  disposition_label: string | null;
  note: string | null;
  has_recording: boolean;
  body: string | null;
  media_count: number;
  lead_id: string | null;
  contact_id: string | null;
  conversation_id: string | null;
}

export interface HistoryKpisDto {
  calls: number;
  answered: number;
  connect_rate: number | null;
  avg_duration_seconds: number | null;
  talk_time_seconds: number;
  inbound: number;
  outbound: number;
  sms_sent: number;
  sms_received: number;
  by_disposition: Array<{ slug: string; label: string; count: number }>;
  by_rep: Array<{
    user_id: string;
    name: string;
    calls: number;
    answered: number;
    talk_time_seconds: number;
    sms: number;
  }>;
}

export interface HistoryResponseDto {
  range: ReportRangeDto;
  /** Whether the viewer sees the whole org or only their own rows. */
  scope: 'own' | 'org';
  items: HistoryItemDto[];
  total: number;
  kpis: HistoryKpisDto;
}

export function historyQuery(q: HistoryQuery): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(q)) {
    if (value === undefined || value === '' || value === null) continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export interface CostsReportDto {
  range: ReportRangeDto;
  has_data: boolean;
  total: Array<{ currency: string; amount: string; items: number }>;
  by_day: Array<{ day: string; currency: string; amount: string }>;
  by_type: Array<{ item_type: string; currency: string; amount: string; items: number }>;
  by_rep: Array<{ user_id: string | null; display_name: string | null; currency: string; amount: string }>;
}

export interface FloorStateDto {
  generated_at: string;
  today: string;
  timezone: string;
  reps: Array<{
    user_id: string;
    display_name: string;
    role: string;
    presence: { status: string; last_seen_at: string | null; fresh: boolean };
    on_call: {
      call_id: string;
      direction: string;
      status: string;
      from_number: string;
      to_number: string;
      initiated_at: string | null;
      answered_at: string | null;
    } | null;
    today: { calls: number; answered: number; talk_seconds: number };
  }>;
  queues: Array<{ queue_id: string; name: string; waiting: number }>;
  totals: {
    calls: number;
    inbound: number;
    outbound: number;
    answered: number;
    missed: number;
    voicemails_left: number;
    talk_seconds: number;
  };
}

function rangeQuery(range?: { from?: string; to?: string }): string {
  const params = new URLSearchParams();
  if (range?.from) params.set('from', range.from);
  if (range?.to) params.set('to', range.to);
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

export type CallerIdMode = 'dedicated' | 'local_presence';

export interface MeDto extends SessionUser {
  timezone: string | null;
  city: string | null;
  title: string | null;
  /** Lines assigned to me. */
  numbers: Array<{ id: string; phone_e164: string; label: string | null }>;
  /** Every active line in the org: the caller-ID picker's options. */
  org_numbers: Array<{
    id: string;
    phone_e164: string;
    label: string | null;
    area_code: string | null;
    assigned_user_id: string | null;
  }>;
  default_phone_number_id: string | null;
  caller_id_mode: CallerIdMode;
}

export interface PhoneNumberDto {
  id: string;
  phone_e164: string;
  label: string | null;
  status: string;
  area_code: string | null;
  assigned_user_id: string | null;
  forward_to_e164: string | null;
  /** Default routing rings the rep who last reached out to the caller first. */
  route_callbacks_to_last_contact?: boolean;
  capabilities: { voice?: boolean; sms?: boolean; mms?: boolean };
}

/** A teammate, with the zone they actually work in. */
export interface TeamMemberDto {
  id: string;
  display_name: string;
  role: string;
  /** The job ("Acquisitions"), not the RBAC role. Null when nobody set one. */
  title: string | null;
  timezone: string | null;
  city: string | null;
  presence: 'available' | 'away' | 'offline' | string;
  last_seen_at: string | null;
  is_self: boolean;
}

// ── Team management (admin.users; routes/team.ts) ──────────────────────────

/** A teammate as an admin sees them: every status, plus what an admin can change. */
export interface TeamMemberAdminDto extends TeamMemberDto {
  email: string;
  status: 'active' | 'invited' | 'disabled' | string;
  default_phone_number_id: string | null;
  /** False until their first sign-in claims the row — while false, "resend invite" still means something. */
  auth_linked: boolean;
  created_at: string;
}

export type TeamRole = 'owner' | 'admin' | 'manager' | 'rep';

/** What became of the invite email; the member row exists either way. */
export type AuthInviteOutcome = 'sent' | 'failed' | 'not_configured';

export interface CreateTeamMemberInput {
  email: string;
  display_name: string;
  role: TeamRole;
  title?: string | null;
  default_phone_number_id?: string | null;
}

export interface UpdateTeamMemberInput {
  display_name?: string;
  role?: TeamRole;
  title?: string | null;
  status?: 'active' | 'disabled';
  default_phone_number_id?: string | null;
  timezone?: string | null;
  city?: string | null;
}

// ── Contacts (routes/contacts.ts) ──────────────────────────────────────────

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

export type ContactSort = 'recent' | 'name' | 'temperature' | 'created';

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
  /** 0–100; the temperature is a band of this unless an override locked it. */
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

/** One row of a contact's merged call + text history (GET /v1/contacts/:id). */
export interface ContactActivityDto {
  kind: 'call' | 'sms';
  id: string;
  at: string;
  direction: 'outbound' | 'inbound' | string;
  status: string;
  duration_seconds: number | null;
  body: string | null;
  disposition_label: string | null;
  user_name: string | null;
}

export interface ContactListQuery {
  q?: string;
  type?: ContactType;
  status?: ContactStatus;
  temperature?: Temperature;
  tag?: string;
  user_id?: string;
  has_phone?: boolean;
  include_deleted?: boolean;
  sort?: ContactSort;
  limit?: number;
  offset?: number;
}

export interface ContactListDto {
  contacts: ContactDto[];
  total: number;
  counts: {
    by_type: Record<string, number>;
    by_status: Record<string, number>;
    by_temperature: Record<string, number>;
  };
}

export interface ContactPhoneInput {
  phone: string;
  label?: string;
  is_primary?: boolean;
}

export interface ContactAddressInput {
  line1?: string;
  city?: string;
  state?: string;
  postal_code?: string;
}

export interface CreateContactInput {
  display_name: string;
  type: ContactType;
  status?: ContactStatus;
  phone?: string;
  phones?: ContactPhoneInput[];
  email?: string;
  company?: string;
  tags?: string[];
  source?: string;
  notes?: string;
  assigned_user_id?: string | null;
  address?: ContactAddressInput;
  /** On a duplicate phone, fold these fields into the existing contact instead of 409. */
  merge?: boolean;
}

export interface UpdateContactInput {
  display_name?: string;
  type?: ContactType;
  status?: ContactStatus;
  phone?: string;
  /** The full set; the server replaces what it has. */
  phones?: ContactPhoneInput[];
  email?: string | null;
  company?: string | null;
  tags?: string[];
  source?: string | null;
  notes?: string | null;
  assigned_user_id?: string | null;
  address?: ContactAddressInput | null;
  /** A manual override; locks the band until `temperature_locked: false`. */
  temperature?: Temperature;
  temperature_locked?: boolean;
}

export type ContactBulkAction =
  | 'delete'
  | 'restore'
  | 'set_status'
  | 'set_type'
  | 'add_tag'
  | 'remove_tag'
  | 'assign';

export interface ContactBulkInput {
  ids: string[];
  action: ContactBulkAction;
  value?: string | null;
}

export interface ContactBulkMessageInput {
  ids: string[];
  body?: string;
  template_id?: string;
  media_urls?: string[];
}

export interface ContactBulkMessageDto {
  sent: number;
  skipped: Array<{ id: string; reason: string }>;
}

/** A campaign when the server built one; bare lead ids when it could only enrol. */
export type ContactDialListDto =
  | { campaign_id: string; enrolled: number; skipped: number }
  | { lead_ids: string[] };

/** Target field → the CSV column that feeds it. */
export interface ContactImportMapping {
  display_name?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  phone2?: string;
  email?: string;
  company?: string;
  address_line1?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  tags?: string;
  notes?: string;
  status?: string;
  type?: string;
}

export type ContactImportDedupe = 'skip' | 'merge' | 'create';

export interface ContactImportInput {
  /** At most 1000 per call. */
  rows: Record<string, string>[];
  mapping: ContactImportMapping;
  defaults: { type: ContactType; status?: ContactStatus; tags?: string[]; source?: string };
  dedupe: ContactImportDedupe;
}

export interface ContactImportResultDto {
  created: number;
  merged: number;
  skipped: Array<{ row: number; reason: string }>;
}

function contactsQuery(q: ContactListQuery = {}): string {
  const params = new URLSearchParams();
  if (q.q) params.set('q', q.q);
  if (q.type) params.set('type', q.type);
  if (q.status) params.set('status', q.status);
  if (q.temperature) params.set('temperature', q.temperature);
  if (q.tag) params.set('tag', q.tag);
  if (q.user_id) params.set('user_id', q.user_id);
  if (q.has_phone !== undefined) params.set('has_phone', q.has_phone ? 'true' : 'false');
  if (q.include_deleted) params.set('include_deleted', 'true');
  if (q.sort) params.set('sort', q.sort);
  if (q.limit !== undefined) params.set('limit', String(q.limit));
  if (q.offset !== undefined) params.set('offset', String(q.offset));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** One party in a call's conference room (docs/telephony-events.md §9). */
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

export const api = {
  /** A browser credential plus which carrier SDK to load and who opens the outbound leg (lib/softphone-engine.ts). */
  voiceToken: () => request<VoiceTokenDto>('/v1/voice/token', { method: 'POST' }),
  /** Server-leg carriers (Telnyx): have the carrier ring this browser for a call the server created. */
  ringBrowserLeg: (callId: string) =>
    request<{ mode: 'client' | 'server'; provider_call_id: string | null }>(`/v1/calls/${callId}/browser-leg`, { method: 'POST' }),
  heartbeat: (status: 'available' | 'away' | 'offline') =>
    request<{ ok: boolean }>('/v1/presence', { method: 'POST', body: JSON.stringify({ status }) }),
  lookupPhone: (number: string) =>
    request<PhoneLookupDto>(`/v1/lookup/phone?number=${encodeURIComponent(number)}`),
  createCall: (input: { to_number?: string; lead_id?: string; contact_id?: string; from_phone_number_id?: string }) =>
    request<{ call: CallDto }>('/v1/calls', { method: 'POST', body: JSON.stringify(input) }),
  listCalls: () => request<{ calls: CallDto[] }>('/v1/calls'),
  getCall: (id: string) =>
    request<{
      call: CallDto;
      events: Array<{ type: string; occurred_at: string; source: string }>;
      recordings: RecordingDto[];
    }>(`/v1/calls/${id}`),
  /** The inbound call ringing this browser from `from`; a Telnyx invite carries no call id. */
  ringingCall: (from: string) =>
    request<{ call: CallDto }>(`/v1/calls/ringing?from=${encodeURIComponent(from)}`),
  // Recordings + transcripts (docs/transcription.md)
  getCallTranscript: (id: string) => request<CallTranscriptDto>(`/v1/calls/${id}/transcript`),
  requestTranscript: (recordingId: string, force = false) =>
    request<{ status: string }>(`/v1/recordings/${recordingId}/transcribe`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),
  /**
   * The MP3 as a Blob. `request` parses JSON, and an <audio> tag cannot send
   * a bearer header, so this is the one call that reads a raw body — over the
   * same token, refresh and error path as everything else.
   */
  getRecordingAudio: async (recordingId: string): Promise<Blob> => {
    if (sessionIsStale()) await refreshSession();
    const token = getToken() ?? memoryToken;
    let res: Response;
    try {
      res = await fetch(`${apiUrl()}/v1/recordings/${recordingId}/audio`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
    } catch {
      throw new ApiError(0, 'backend_unreachable', `Can't reach the Talkr API at ${apiUrl()}.`);
    }
    if (!res.ok) throw await parseError(res);
    return res.blob();
  },
  setDisposition: (
    id: string,
    input: { disposition: string; note?: string; follow_up_at?: string; lead_status?: string },
  ) => request<{ call: CallDto }>(`/v1/calls/${id}/disposition`, { method: 'POST', body: JSON.stringify(input) }),
  listTeam: () => request<{ members: TeamMemberDto[] }>('/v1/team'),
  // Team management (admin.users). The roster above stays what reps see.
  listTeamMembers: () => request<{ members: TeamMemberAdminDto[] }>('/v1/team/members'),
  createTeamMember: (input: CreateTeamMemberInput) =>
    request<{ member: TeamMemberAdminDto; auth_invite: AuthInviteOutcome; auth_invite_error: string | null }>(
      '/v1/team/members',
      { method: 'POST', body: JSON.stringify(input) },
    ),
  updateTeamMember: (id: string, input: UpdateTeamMemberInput) =>
    request<{ member: TeamMemberAdminDto }>(`/v1/team/members/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  resendTeamInvite: (id: string) =>
    request<{ auth_invite: AuthInviteOutcome; auth_invite_error: string | null }>(`/v1/team/members/${id}/resend-invite`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  // Contacts (routes/contacts.ts)
  listContacts: (query?: ContactListQuery) => request<ContactListDto>(`/v1/contacts${contactsQuery(query)}`),
  getContact: (id: string) =>
    request<{ contact: ContactDto; activity: ContactActivityDto[] }>(`/v1/contacts/${encodeURIComponent(id)}`),
  createContact: (input: CreateContactInput) =>
    request<{ contact: ContactDto }>('/v1/contacts', { method: 'POST', body: JSON.stringify(input) }),
  updateContact: (id: string, input: UpdateContactInput) =>
    request<{ contact: ContactDto }>(`/v1/contacts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteContact: (id: string) => request<void>(`/v1/contacts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  bulkContacts: (input: ContactBulkInput) =>
    request<{ affected: number }>('/v1/contacts/bulk', { method: 'POST', body: JSON.stringify(input) }),
  bulkMessageContacts: (input: ContactBulkMessageInput) =>
    request<ContactBulkMessageDto>('/v1/contacts/bulk/message', { method: 'POST', body: JSON.stringify(input) }),
  bulkDialList: (input: { ids: string[]; name?: string }) =>
    request<ContactDialListDto>('/v1/contacts/bulk/dial-list', { method: 'POST', body: JSON.stringify(input) }),
  importContacts: (input: ContactImportInput) =>
    request<ContactImportResultDto>('/v1/contacts/import', { method: 'POST', body: JSON.stringify(input) }),
  exportContactsCsv: (query?: ContactListQuery) => requestBlob(`/v1/contacts/export.csv${contactsQuery(query)}`),
  rescoreContact: (id: string) =>
    request<{ contact: ContactDto }>(`/v1/contacts/${encodeURIComponent(id)}/rescore`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  getMe: () => request<MeDto>('/v1/me'),
  updateMe: (input: {
    timezone?: string | null;
    city?: string | null;
    title?: string | null;
    default_phone_number_id?: string | null;
    caller_id_mode?: CallerIdMode;
  }) =>
    request<{
      id: string;
      timezone: string | null;
      city: string | null;
      title: string | null;
      default_phone_number_id: string | null;
      caller_id_mode: CallerIdMode;
    }>('/v1/me', {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  listNumbers: () => request<{ numbers: PhoneNumberDto[] }>('/v1/numbers'),
  updateNumber: (id: string, input: { forward_to_e164?: string; route_callbacks_to_last_contact?: boolean }) =>
    request<{ number: PhoneNumberDto; forward_to_e164: string | null }>(`/v1/numbers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
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
  transferCall: (
    callId: string,
    input: { mode: 'warm' | 'blind'; user_id?: string; to_number?: string },
  ) =>
    request<{ participant: ParticipantDto; mode: 'warm' | 'blind' }>(`/v1/calls/${callId}/transfer`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  completeTransfer: (callId: string) =>
    request<{ ok: boolean }>(`/v1/calls/${callId}/transfer/complete`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  listDispositions: () => request<{ dispositions: DispositionDto[] }>('/v1/dispositions'),
  listLeads: () => request<{ leads: Array<Record<string, unknown>> }>('/v1/leads'),
  getLead: (id: string) => request<LeadActivityDto>(`/v1/leads/${encodeURIComponent(id)}`),
  // SMS (Phase 4 — docs/sms.md)
  listConversations: (query?: ConversationListQuery) =>
    request<ConversationListDto>(`/v1/conversations${conversationsQuery(query)}`),
  listConversationMessages: (id: string) =>
    request<{ conversation_id: string; messages: MessageDto[] }>(`/v1/conversations/${id}/messages`),
  markConversationRead: (id: string) =>
    request<{ ok: boolean }>(`/v1/conversations/${id}/read`, { method: 'POST', body: JSON.stringify({}) }),
  /** Upload one MMS attachment; the returned url goes in sendMessage.media_urls. */
  uploadMedia: (input: { content_type: string; data_base64: string; filename?: string }) =>
    request<{ id: string; url: string; content_type: string; byte_size: number }>('/v1/media', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  sendMessage: (input: {
    conversation_id?: string;
    to_number?: string;
    lead_id?: string;
    body?: string;
    template_id?: string;
    media_urls?: string[];
    /** Which org line the seller sees. 400 `invalid_caller_id` when it is not one. */
    from_phone_number_id?: string;
  }) =>
    request<{ message: MessageDto; conversation_id: string }>('/v1/messages', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  listMessageTemplates: (opts: { include_inactive?: boolean } = {}) =>
    request<{ templates: MessageTemplateDto[] }>(
      `/v1/message-templates${opts.include_inactive ? '?include_inactive=true' : ''}`,
    ),
  reportOverview: (range?: { from?: string; to?: string }) =>
    request<OverviewReportDto>(`/v1/reports/overview${rangeQuery(range)}`),
  // Activity history (calls + texts — docs/reporting.md §8)
  history: (query: HistoryQuery = {}) => request<HistoryResponseDto>(`/v1/history${historyQuery(query)}`),
  historyExportCsv: (query: HistoryQuery = {}) => requestBlob(`/v1/history/export.csv${historyQuery(query)}`),
  reportByRep: (range?: { from?: string; to?: string }) =>
    request<ByRepReportDto>(`/v1/reports/by-rep${rangeQuery(range)}`),
  reportByDay: (range?: { from?: string; to?: string }) =>
    request<ByDayReportDto>(`/v1/reports/by-day${rangeQuery(range)}`),
  reportQueues: (range?: { from?: string; to?: string }) =>
    request<QueuesReportDto>(`/v1/reports/queues${rangeQuery(range)}`),
  reportQuality: (range?: { from?: string; to?: string }) =>
    request<QualityReportDto>(`/v1/reports/quality${rangeQuery(range)}`),
  reportCosts: (range?: { from?: string; to?: string }) =>
    request<CostsReportDto>(`/v1/reports/costs${rangeQuery(range)}`),
  floorState: () => request<FloorStateDto>('/v1/floor/state'),
  // Workflows + tasks (Phase 7 — docs/workflows.md)
  listWorkflows: () => request<{ workflows: WorkflowDto[] }>('/v1/workflows'),
  createWorkflow: (input: WorkflowInput) =>
    request<{ workflow: WorkflowDto }>('/v1/workflows', { method: 'POST', body: JSON.stringify(input) }),
  updateWorkflow: (id: string, input: Partial<WorkflowInput>) =>
    request<{ workflow: WorkflowDto }>(`/v1/workflows/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  listWorkflowRuns: (id: string) =>
    request<{ runs: WorkflowRunDto[]; next_cursor: string | null }>(`/v1/workflows/${id}/runs`),
  listTasks: (opts: { leadId?: string } = {}) =>
    request<{ tasks: TaskDto[] }>(`/v1/tasks${opts.leadId ? `?lead_id=${opts.leadId}` : ''}`),
  createTask: (input: { title: string; note?: string; lead_id?: string; due_at?: string }) =>
    request<{ task: TaskDto }>('/v1/tasks', { method: 'POST', body: JSON.stringify(input) }),
  completeTask: (id: string) =>
    request<{ task: TaskDto }>(`/v1/tasks/${id}/complete`, { method: 'POST', body: JSON.stringify({}) }),
  cancelTask: (id: string) =>
    request<{ task: TaskDto }>(`/v1/tasks/${id}/cancel`, { method: 'POST', body: JSON.stringify({}) }),
  // Dialers (Phase 5 — docs/dialers.md)
  listCampaigns: () => request<{ campaigns: CampaignDto[] }>('/v1/campaigns'),
  createCampaign: (input: { name: string; mode: string; settings?: CampaignSettingsDto }) =>
    request<{ campaign: CampaignDto }>('/v1/campaigns', { method: 'POST', body: JSON.stringify(input) }),
  updateCampaign: (
    id: string,
    input: { name?: string; mode?: string; settings?: CampaignSettingsDto; status?: string },
  ) => request<{ campaign: CampaignDto }>(`/v1/campaigns/${id}`, { method: 'PATCH', body: JSON.stringify(input) }),
  attachCampaignLeads: (
    id: string,
    input: { lead_ids?: string[]; filter?: { status?: string; source?: string; assigned_user_id?: string } },
  ) =>
    request<{ attached: number; revived: number; requested: number }>(`/v1/campaigns/${id}/leads`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  campaignStats: (id: string) => request<CampaignStatsDto>(`/v1/campaigns/${id}/stats`),
  startDialSession: (campaignId: string) =>
    request<{ session: DialSessionDto }>('/v1/dial-sessions', {
      method: 'POST',
      body: JSON.stringify({ campaign_id: campaignId }),
    }),
  activeDialSession: () => request<{ session: DialSessionDto | null }>('/v1/dial-sessions/active'),
  getDialSession: (id: string) =>
    request<{
      session: DialSessionDto;
      campaign: CampaignDto | null;
      latest_call: DialSessionCallDto | null;
      card: LeadCardDto | null;
    }>(`/v1/dial-sessions/${id}`),
  dialSessionAction: (id: string, action: 'pause' | 'resume' | 'end') =>
    request<{ session: DialSessionDto }>(`/v1/dial-sessions/${id}/${action}`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
  dialSessionNext: (id: string) =>
    request<DialNextDto>(`/v1/dial-sessions/${id}/next`, { method: 'POST', body: JSON.stringify({}) }),
  // Sequences (docs/sequences.md) — DTOs at the end of this file.
  listSequences: () => request<{ sequences: SequenceDto[] }>('/v1/sequences'),
  getSequence: (id: string) =>
    request<{ sequence: SequenceDto; runs: SequenceRunDto[] }>(`/v1/sequences/${encodeURIComponent(id)}`),
  createSequence: (input: SequenceInput) =>
    request<{ sequence: SequenceDto }>('/v1/sequences', { method: 'POST', body: JSON.stringify(input) }),
  updateSequence: (id: string, input: Partial<SequenceInput>) =>
    request<{ sequence: SequenceDto }>(`/v1/sequences/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  archiveSequence: (id: string) =>
    request<{ ok: boolean; runs_stopped: number }>(`/v1/sequences/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  enrollInSequence: (id: string, input: { lead_ids?: string[]; contact_ids?: string[]; phones?: string[] }) =>
    request<SequenceEnrollResultDto>(`/v1/sequences/${encodeURIComponent(id)}/enroll`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  unenrollFromSequence: (id: string, leadIds: string[]) =>
    request<{ stopped: number }>(`/v1/sequences/${encodeURIComponent(id)}/unenroll`, {
      method: 'POST',
      body: JSON.stringify({ lead_ids: leadIds }),
    }),
  /** 503 `ai_not_configured` when the server has no ANTHROPIC_API_KEY. */
  draftSequenceWithAi: (input: SequenceDraftInput) =>
    request<SequenceDraftResultDto>('/v1/ai/sequence-draft', { method: 'POST', body: JSON.stringify(input) }),
  // Scripts + call context (the dialer's in-call panel) — DTOs at the end of this file.
  /** Everything the panel shows for one party; exactly one identifier is sent (see callContextQuery). */
  getCallContext: (params: CallContextParams) => request<CallContextDto>(`/v1/call-context${callContextQuery(params)}`),
  listScripts: (query?: ScriptListQuery) => request<{ scripts: ScriptDto[] }>(`/v1/scripts${scriptsQuery(query)}`),
  /**
   * One script by id (scripts.read). The in-call panel's alternatives arrive
   * as id + title only; this is how their body is fetched when a rep picks one.
   */
  getScript: (id: string) => request<{ script: ScriptDto }>(`/v1/scripts/${encodeURIComponent(id)}`),
  createScript: (input: ScriptInput) =>
    request<{ script: ScriptDto }>('/v1/scripts', { method: 'POST', body: JSON.stringify(input) }),
  updateScript: (id: string, input: Partial<ScriptInput>) =>
    request<{ script: ScriptDto }>(`/v1/scripts/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteScript: (id: string) => request<void>(`/v1/scripts/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** The ids of one kind in their new order; the server renumbers sort_order by position. */
  reorderScripts: (ids: string[]) =>
    request<{ ok: boolean }>('/v1/scripts/reorder', { method: 'POST', body: JSON.stringify({ ids }) }),
  importScripts: (input: ScriptImportInput) =>
    request<ScriptImportResultDto>('/v1/scripts/import', { method: 'POST', body: JSON.stringify(input) }),
  /** Tally one read of a script or rebuttal, against the call when there is one. */
  scriptUsed: (id: string, input: { call_id?: string; contact_id?: string } = {}) =>
    request<void>(`/v1/scripts/${encodeURIComponent(id)}/used`, { method: 'POST', body: JSON.stringify(input) }),
  // ── Org settings (hold music) — see the DTOs at the foot of this file ────
  /** Admin-only (`admin.users`): 403 for managers and reps. */
  getOrgSettings: () => request<OrgSettingsDto>('/v1/org/settings'),
  updateOrgSettings: (input: OrgSettingsPatch) =>
    request<OrgSettingsDto>('/v1/org/settings', { method: 'PATCH', body: JSON.stringify(input) }),
  // ── end org settings ────────────────────────────────────────────────────

  // ── SMS previews + template management (DTOs at the foot of this file) ──
  /**
   * What the seller will actually read: the server renders the merge fields
   * and reports what it could not resolve, so the composer never sends raw
   * braces. Send a body or a template id, plus whichever target is known.
   */
  previewMessage: (input: MessagePreviewInput) =>
    request<MessagePreviewDto>('/v1/messages/preview', { method: 'POST', body: JSON.stringify(input) }),
  /** Writing a template is manager+; a 403 is the read-only state, not a crash. */
  createMessageTemplate: (input: MessageTemplateInput) =>
    request<{ template: MessageTemplateDto }>('/v1/message-templates', {
      method: 'POST',
      body: JSON.stringify(input),
    }),
  updateMessageTemplate: (id: string, input: Partial<MessageTemplateInput>) =>
    request<{ template: MessageTemplateDto }>(`/v1/message-templates/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }),
  deleteMessageTemplate: (id: string) =>
    request<void>(`/v1/message-templates/${encodeURIComponent(id)}`, { method: 'DELETE' }),
  /** A saved template rendered against one party — the picker's "sends as". */
  previewTemplate: (id: string, target: MessagePreviewTarget = {}) =>
    request<MessagePreviewDto>(`/v1/message-templates/${encodeURIComponent(id)}/preview`, {
      method: 'POST',
      body: JSON.stringify(target),
    }),
  // ── end SMS previews + template management ──────────────────────────────

  // ── AI call scoring + coaching (DTOs at the foot of this file) ──────────
  /**
   * The coaching card for one call. Visible to whoever can hear the call:
   * a rep sees their own, a manager any in the org. `configured: false`
   * means the server has no ANTHROPIC_API_KEY, not that scoring failed.
   */
  getCallScore: (callId: string) => request<CallScoreResponseDto>(`/v1/calls/${callId}/score`),
  /**
   * (Re)queue scoring — manager+, like queueing a re-transcribe. `force`
   * re-runs a completed score; without it a finished one is left alone.
   * 409 `transcript_not_ready` when the call has no completed transcript.
   */
  requestCallScore: (callId: string, force = false) =>
    request<{ status: 'queued' | 'completed' | 'not_configured' }>(`/v1/calls/${callId}/score`, {
      method: 'POST',
      body: JSON.stringify({ force }),
    }),
  /** The per-rep rollup behind /coaching. Org-wide read (`calls.read.org`). */
  coachingSummary: (query: CoachingSummaryQuery = {}) => {
    const params = new URLSearchParams();
    if (query.from) params.set('from', query.from);
    if (query.to) params.set('to', query.to);
    if (query.user_id) params.set('user_id', query.user_id);
    const qs = params.toString();
    return request<CoachingSummaryDto>(`/v1/coaching/summary${qs ? `?${qs}` : ''}`);
  },
  // ── end AI call scoring + coaching ──────────────────────────────────────
};

export interface ConversationDto {
  id: string;
  our_number: string;
  their_number: string;
  contact_id: string | null;
  lead_id: string | null;
  contact_name: string | null;
  lead_status: string | null;
  lead_city: string | null;
  lead_state: string | null;
  assigned_user_id: string | null;
  last_message_at: string | null;
  last_message: {
    direction: 'outbound' | 'inbound';
    body: string;
    media_count: number;
    /** queued|sending|sent|delivered|undelivered|failed — a row marks the last two. */
    status: string;
  } | null;
  unread_count: number;
  created_at: string;
  // Who this is, in Contacts' vocabulary, so the inbox reads like the rest of
  // the app: seller or title company, how hot, which rep owns it.
  contact_type: ContactType | null;
  /** The contact's status; a value outside CONTACT_STATUSES still renders. */
  contact_status: string | null;
  temperature: Temperature | null;
  /** 0–100 behind the band; null when nothing has scored the contact yet. */
  temperature_score: number | null;
  tags: string[];
  assigned_user_name: string | null;
}

export interface MessageDto {
  id: string;
  conversation_id: string;
  direction: 'outbound' | 'inbound';
  status: string;
  body: string;
  media_urls: string[];
  error_code: string | null;
  failure_class: string;
  is_auto_reply: boolean;
  created_at: string;
  sent_at: string | null;
  delivered_at: string | null;
  failed_at: string | null;
}

export interface MessageTemplateDto {
  id: string;
  name: string;
  body: string;
  /** cold|warm|hot|compliance today; unknown values still render. */
  category: string | null;
  use_count: number;
  /**
   * Retired templates stay on file so old sends still name them; only
   * `?include_inactive=true` returns them. Absent on a server that has not
   * shipped template management yet, which reads as active.
   */
  is_active?: boolean;
}

// ── Workflows + tasks (Phase 7) ────────────────────────────────────────────

export interface WorkflowConditionRow {
  field: string;
  op: string;
  value?: unknown;
}

export interface WorkflowActionDto {
  type: string;
  [key: string]: unknown;
}

export interface WorkflowInput {
  name: string;
  enabled?: boolean;
  trigger_type: string;
  trigger_config?: { days?: number };
  conditions?: { all: WorkflowConditionRow[] } | null;
  actions: WorkflowActionDto[];
}

export interface WorkflowDto {
  id: string;
  name: string;
  enabled: boolean;
  trigger_type: string;
  trigger_config: { days?: number };
  conditions: { all?: WorkflowConditionRow[]; any?: WorkflowConditionRow[] } | null;
  actions: WorkflowActionDto[];
  max_runs_per_lead_per_day: number;
  max_runs_per_day: number;
  created_at: string;
  run_counts?: { total: number; last_24h: number };
}

export interface WorkflowRunDto {
  id: string;
  workflow_id: string;
  trigger_source: string;
  trigger_event_id: string;
  lead_id: string | null;
  status: string;
  matched: boolean | null;
  skip_reason: string | null;
  action_results: Array<{ index: number; type: string; status: string; error?: string }>;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export interface TaskDto {
  id: string;
  lead_id: string | null;
  assigned_user_id: string | null;
  title: string;
  note: string | null;
  due_at: string | null;
  status: string;
  source: string;
  workflow_id: string | null;
  created_at: string;
  completed_at: string | null;
}

// ── Dialers (Phase 5 — docs/dialers.md) ────────────────────────────────────

export interface CampaignSettingsDto {
  callerIdPhoneNumberId?: string;
  callingWindowStart?: string;
  callingWindowEnd?: string;
  timezonePolicy?: 'lead' | 'org';
  maxAttemptsPerDay?: number;
  maxAttemptsTotal?: number;
  retryBackoffHours?: number;
  parallelLines?: number;
  abandonmentCapPercent?: number;
  amdEnabled?: boolean;
  amdAction?: 'hangup' | 'voicemail_drop';
  amdVoicemailText?: string;
}

export interface CampaignDto {
  id: string;
  name: string;
  status: 'draft' | 'active' | 'paused' | 'archived' | string;
  mode: 'power' | 'progressive' | 'parallel' | 'predictive' | string;
  settings: CampaignSettingsDto;
  created_at: string;
  lead_counts?: Record<string, number>;
}

export interface DialSessionDto {
  id: string;
  campaign_id: string;
  user_id: string;
  mode: string;
  state: 'active' | 'paused' | 'ended' | string;
  started_at: string;
  ended_at: string | null;
  dialed: number;
  connected: number;
  abandoned: number;
  line_limit: number | null;
}

export interface DialSessionCallDto {
  id: string;
  status: string;
  from_number: string;
  to_number: string;
  lead_id: string | null;
  contact_id: string | null;
  created_at: string;
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

export interface DialNextDto {
  idle: boolean;
  reason?: string;
  batch_id?: string | null;
  lines?: Array<{ call: DialSessionCallDto; campaign_lead_id: string; card: LeadCardDto | null }>;
}

export interface CampaignStatsDto {
  campaign: CampaignDto;
  lead_counts: Record<string, number>;
  calls: { total: number; connected: number; abandoned: number; machine: number };
  abandonment: {
    window_days: number;
    answered: number;
    abandoned: number;
    rate: number;
    cap_percent: number;
  };
}

export function eventStreamUrl(): string {
  const token = getToken() ?? memoryToken;
  // EventSource cannot set headers; the server accepts the token as a query
  // param on this one endpoint only. Without a token the stream is still
  // opened: a server running without sign-in accepts it, and any other
  // answers 401, which makes the browser give up without retrying.
  const base = `${apiUrl()}/v1/events/stream`;
  return token ? `${base}?access_token=${encodeURIComponent(token)}` : base;
}

// ── Sequences (docs/sequences.md) ──────────────────────────────────────────

/** One builder step; the server translates these to workflow actions. */
export type AgentCapabilityDto = 'send_sms' | 'create_task' | 'update_lead_status';

export type SequenceStepDto =
  | { type: 'sms'; body?: string; template_id?: string }
  | { type: 'wait'; days?: number; hours?: number; minutes?: number }
  | { type: 'task'; title: string; due_in_days: number }
  | { type: 'status'; status: string }
  /** An AI agent decides, inside `allowed`, what to do for this lead right now (docs/sequences.md §11). */
  | { type: 'agent'; goal: string; allowed: AgentCapabilityDto[] };

export interface SequenceExitRulesDto {
  stop_on_reply: boolean;
  stop_on_statuses: string[];
  stop_on_call_answered: boolean;
}

/** Where a lead goes when a run finishes (docs/sequences.md §12). */
export interface SequenceOnCompleteDto {
  mode: 'none' | 'fixed' | 'smart';
  sequence_id: string | null;
  candidate_ids: string[];
  also_when_stopped: boolean;
}

export interface SequenceInput {
  name: string;
  description?: string | null;
  steps: SequenceStepDto[];
  exit_rules?: SequenceExitRulesDto | null;
  on_complete?: SequenceOnCompleteDto | null;
  enabled?: boolean;
}

export interface SequenceStatsDto {
  enrolled: number;
  /** In flight: pending, running or waiting. */
  active: number;
  waiting: number;
  completed: number;
  stopped: number;
  failed: number;
  replied: number;
}

export interface SequenceDto {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  steps: SequenceStepDto[];
  exit_rules: SequenceExitRulesDto | null;
  on_complete: SequenceOnCompleteDto | null;
  /** Non-wait steps with the day (after enrollment) they fire on. */
  timeline: Array<{ index: number; day: number; type: SequenceStepDto['type'] }>;
  duration_minutes: number;
  sms_count: number;
  agent_count: number;
  stats: SequenceStatsDto;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface SequenceRunDto {
  id: string;
  lead_id: string | null;
  lead_name: string | null;
  phone: string | null;
  lead_status: string | null;
  /** pending | running | waiting | succeeded | failed | skipped | stopped */
  status: string;
  /** 1-based step the run is on (or finished at). */
  step: number;
  step_count: number;
  current_action_index: number;
  resume_at: string | null;
  stopped_reason: string | null;
  /** The run this lead was routed into when this one finished, and why. */
  routed_run_id: string | null;
  routed_reason: string | null;
  skip_reason: string | null;
  error: string | null;
  action_results: Array<{ index: number; type: string; status: string; error?: string; detail?: Record<string, unknown> }>;
  started_at: string | null;
  finished_at: string | null;
  created_at: string;
}

export interface SequenceEnrollResultDto {
  enrolled: number;
  already_enrolled: number;
  skipped: number;
  skipped_details: Array<{ ref: string; reason: string }>;
}

export interface SequenceDraftInput {
  goal: string;
  audience?: string | null;
  tone?: 'friendly' | 'direct' | 'professional';
  channel?: 'sms';
  steps: number;
  days: number;
  company_name?: string | null;
}

export interface SequenceDraftResultDto {
  draft: {
    name: string;
    description: string;
    steps: SequenceStepDto[];
    exit_rules: SequenceExitRulesDto;
    timeline: Array<{ index: number; day: number }>;
    duration_minutes: number;
  };
  warnings: string[];
  model: string;
  usage: { input_tokens: number; output_tokens: number; attempts: number };
}

// ── Scripts + call context (the dialer's in-call panel) ────────────────────

export type ScriptKind = 'script' | 'rebuttal';

/** A talk track (`script`) or an objection rebuttal. Bodies are light markdown: `## `, `- `, `**bold**`, `> `. */
export interface ScriptDto {
  id: string;
  kind: ScriptKind;
  title: string;
  category: string | null;
  tags: string[];
  /** Contact types the script is for; empty means every type. */
  contact_types: string[];
  campaign_id: string | null;
  body: string;
  sort_order: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

export interface ScriptInput {
  kind: ScriptKind;
  title: string;
  category?: string | null;
  tags?: string[];
  contact_types?: string[];
  campaign_id?: string | null;
  body: string;
  sort_order?: number;
  enabled?: boolean;
}

export interface ScriptListQuery {
  kind?: ScriptKind;
  q?: string;
  include_disabled?: boolean;
}

export type ScriptImportMode = 'skip' | 'replace';

export type ScriptImportInput =
  | { preset: 'example'; mode?: ScriptImportMode }
  | { scripts: ScriptInput[]; mode?: ScriptImportMode };

export interface ScriptImportResultDto {
  created: number;
  updated: number;
  skipped: number;
}

/** Who to look up. Exactly one is sent — call_id, then lead_id, contact_id, phone. */
export interface CallContextParams {
  call_id?: string;
  lead_id?: string;
  contact_id?: string;
  phone?: string;
}

export interface RenderedScriptDto extends ScriptDto {
  /** The body with this party's merge fields filled in. */
  rendered_body: string;
}

export interface CallContextLeadDto {
  id: string;
  status: string;
  source: string | null;
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  external_item_id: string | null;
  crm_url: string | null;
  created_at: string;
}

export interface CallContextPropertyDto {
  id: string;
  line1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
}

/** One row of the party's recent history, newest first. */
export interface CallContextActivityDto {
  kind: 'call' | 'sms' | 'task';
  id: string;
  at: string;
  direction: 'inbound' | 'outbound' | string | null;
  status: string | null;
  duration_seconds: number | null;
  body: string | null;
  disposition_label: string | null;
  note: string | null;
  user_name: string | null;
}

export interface CallContextSummaryDto {
  call_id: string;
  at: string;
  summary: string;
  next_steps: string[];
  objections: string[];
}

export interface CallContextTaskDto {
  id: string;
  title: string;
  due_at: string | null;
  assigned_user_name: string | null;
}

export interface CallContextSequenceDto {
  id: string;
  name: string;
  run_status: string;
  step: number;
  step_count: number;
  resume_at: string | null;
}

export interface CallContextScriptsDto {
  primary: RenderedScriptDto | null;
  alternatives: Array<{ id: string; title: string; category: string | null }>;
  rebuttals: RenderedScriptDto[];
}

export interface CallContextDto {
  phone_e164: string | null;
  contact: ContactDto | null;
  lead: CallContextLeadDto | null;
  property: CallContextPropertyDto | null;
  activity: CallContextActivityDto[];
  last_call_summary: CallContextSummaryDto | null;
  open_tasks: CallContextTaskDto[];
  sequences: CallContextSequenceDto[];
  campaign: { id: string; name: string } | null;
  scripts: CallContextScriptsDto;
  merge_fields: Record<string, string>;
  /** Set when no contact owns the number: the quick-add offers to create one. */
  suggest_create: { phone_e164: string } | null;
}

function callContextQuery(p: CallContextParams): string {
  const params = new URLSearchParams();
  if (p.call_id) params.set('call_id', p.call_id);
  else if (p.lead_id) params.set('lead_id', p.lead_id);
  else if (p.contact_id) params.set('contact_id', p.contact_id);
  else if (p.phone) params.set('phone', p.phone);
  return `?${params.toString()}`;
}

function scriptsQuery(q: ScriptListQuery = {}): string {
  const params = new URLSearchParams();
  if (q.kind) params.set('kind', q.kind);
  if (q.q) params.set('q', q.q);
  if (q.include_disabled) params.set('include_disabled', 'true');
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

// ─── Org settings (hold music) ──────────────────────────────────────────────
// Org-wide configuration an admin owns, as opposed to the per-rep settings in
// MeDto. Read and written through api.getOrgSettings / api.updateOrgSettings
// above; both are `admin.users`-gated server-side.

/**
 * What a party alone in a call's conference room hears.
 *
 * `default` is the carrier's own hold music, `silence` is nothing at all, and
 * `url` plays the org's own audio file or TwiML. The url is validated when it
 * is saved (public http(s), 500 chars max), never when a call is placed.
 */
export interface HoldMusicDto {
  mode: 'default' | 'silence' | 'url';
  url?: string;
}

export interface OrgSettingsDto {
  hold_music: HoldMusicDto;
}

/** Keys left out are untouched; the server merges into the existing blob. */
export interface OrgSettingsPatch {
  hold_music?: HoldMusicDto;
}

// ─── SMS inbox: filters, previews, template management ──────────────────────
// The inbox is filtered the way Contacts is (same vocabulary, same colours),
// the composer previews merge fields before anything leaves, and templates are
// managed rather than merely read. Read and written through api.listConversations,
// api.previewMessage and the api.*MessageTemplate methods above.

export const CONVERSATION_SORTS = ['recent', 'oldest', 'unread', 'temperature'] as const;
export type ConversationSort = (typeof CONVERSATION_SORTS)[number];

/** GET /v1/conversations. `from`/`to` are YYYY-MM-DD (org-zone days) or ISO instants. */
export interface ConversationListQuery {
  q?: string;
  type?: ContactType;
  temperature?: Temperature;
  /** A contact status; the server accepts anything CONTACT_STATUSES holds. */
  status?: string;
  tag?: string;
  user_id?: string;
  /** Only threads with something unread. */
  unread?: boolean;
  /** Whose message was last. */
  direction?: 'inbound' | 'outbound';
  has_lead?: boolean;
  from?: string;
  to?: string;
  /** Only threads carried by this org number. */
  number_id?: string;
  sort?: ConversationSort;
  limit?: number;
  offset?: number;
}

export interface ConversationListDto {
  conversations: ConversationDto[];
  total: number;
  /** Counts for the whole filtered set, so the chips can carry numbers. */
  counts: {
    unread: number;
    by_type: Record<string, number>;
    by_temperature: Record<string, number>;
  };
}

/** Who a preview is rendered for; exactly one is normally sent. */
export interface MessagePreviewTarget {
  conversation_id?: string;
  contact_id?: string;
  lead_id?: string;
  to_number?: string;
}

export interface MessagePreviewInput extends MessagePreviewTarget {
  body?: string;
  template_id?: string;
}

export interface MessagePreviewDto {
  /** The body as the seller reads it — every merge field filled in. */
  body: string;
  merge_fields: Record<string, string>;
  segments: number;
  characters: number;
  /** Braces the server did not recognise; they would send literally. */
  unknown_fields: string[];
}

export interface MessageTemplateInput {
  name: string;
  body: string;
  category?: string | null;
  is_active?: boolean;
}

function conversationsQuery(q: ConversationListQuery = {}): string {
  const params = new URLSearchParams();
  if (q.q) params.set('q', q.q);
  if (q.type) params.set('type', q.type);
  if (q.temperature) params.set('temperature', q.temperature);
  if (q.status) params.set('status', q.status);
  if (q.tag) params.set('tag', q.tag);
  if (q.user_id) params.set('user_id', q.user_id);
  if (q.unread) params.set('unread', 'true');
  if (q.direction) params.set('direction', q.direction);
  if (q.has_lead !== undefined) params.set('has_lead', q.has_lead ? 'true' : 'false');
  if (q.from) params.set('from', q.from);
  if (q.to) params.set('to', q.to);
  if (q.number_id) params.set('number_id', q.number_id);
  if (q.sort) params.set('sort', q.sort);
  if (q.limit !== undefined) params.set('limit', String(q.limit));
  if (q.offset !== undefined) params.set('offset', String(q.offset));
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

// ─── AI call scoring + coaching (docs/coaching.md) ──────────────────────────
// The coaching card under a call's transcript and the per-rep rollup on
// /coaching. The rubric — the ten categories, the seller bucket grid, the
// plays — is server-owned (@talkr/core `coaching.ts`); the labels and bands
// the pages need are mirrored in lib/coaching.ts. Read and written through
// api.getCallScore, api.requestCallScore and api.coachingSummary above.

/** One rubric category. `score` is null when the call never reached that stage. */
export interface CategoryScoreDto {
  score: number | null;
  reason: string;
}

export interface MissedOpportunityDto {
  moment: string;
  /** The seller's words; null when the opening was a silence. */
  quote: string | null;
  instead: string;
}

/** The Price × Motivation read-out. Fields are absent until scoring ran. */
export interface SellerReadDto {
  bucket?: string;
  motivation_score?: number | null;
  price_alignment_score?: number | null;
  bucket_confidence?: number;
  bucket_rationale?: string;
  recommended_play?: string;
  motivation?: string | null;
  timeline?: string | null;
  condition?: string | null;
  price_expectation?: string | null;
  emotions?: string[];
}

export interface CallScoreDto {
  id: string;
  call_id: string;
  transcript_id: string | null;
  status: 'queued' | 'running' | 'completed' | 'failed';
  /** The Claude model that graded it. */
  model: string | null;
  /** 0–100; the model answers 0–10 on the house scale and the server multiplies. */
  overall: number | null;
  /** Rep share of speaking time, 0–1. Measured from the transcript, not guessed. */
  rep_talk_ratio: number | null;
  /** Keyed by category id; a server that has added a category still renders. */
  categories: Record<string, CategoryScoreDto>;
  strengths: string[];
  gaps: string[];
  missed_opportunities: MissedOpportunityDto[];
  next_action: string | null;
  seller: SellerReadDto;
  error: string | null;
  created_at: string;
  completed_at: string | null;
}

export interface CallScoreResponseDto {
  score: CallScoreDto | null;
  /** ANTHROPIC_API_KEY is set on the server; without it no score is ever written. */
  configured: boolean;
}

export interface CategoryAverageDto {
  category: string;
  label: string;
  /** 0–10, or null when nobody was scored on it in the range. */
  average: number | null;
  scored: number;
}

export interface CoachingRepDto {
  user_id: string | null;
  user_name: string;
  calls_scored: number;
  /** 0–100. */
  avg_overall: number | null;
  avg_talk_ratio: number | null;
  categories: CategoryAverageDto[];
  /** Lowest first, at most three. */
  weakest: CategoryAverageDto[];
  previous_calls_scored: number;
  previous_avg_overall: number | null;
  /** avg_overall minus the previous period's; null when either side is empty. */
  trend: number | null;
  /** The rep's weakest scored call in the range — where a manager listens first. */
  example_call_id: string | null;
  example_overall: number | null;
}

export interface CoachingSummaryDto {
  range: { from: string; to: string; timezone: string };
  previous_range: { from: string; to: string };
  totals: {
    calls_scored: number;
    avg_overall: number | null;
    previous_calls_scored: number;
    previous_avg_overall: number | null;
    trend: number | null;
    categories: CategoryAverageDto[];
    weakest: CategoryAverageDto[];
  };
  reps: CoachingRepDto[];
  configured: boolean;
}

/** `from`/`to` are YYYY-MM-DD org-local days, the same vocabulary Reports uses. */
export interface CoachingSummaryQuery {
  from?: string;
  to?: string;
  user_id?: string;
}
// ─── end AI call scoring + coaching ─────────────────────────────────────────
