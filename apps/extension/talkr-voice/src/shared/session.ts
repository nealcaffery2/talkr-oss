/**
 * The signed-in session, as seen from any extension context.
 *
 * The service worker is the only owner: it holds the tokens in
 * chrome.storage, refreshes them, and broadcasts changes. Everything else —
 * popup, side panel and above all the offscreen document, which has no
 * chrome.storage at all — asks it. That is also what makes refresh safe: one
 * place decides when a token is stale, so two surfaces never race to redeem
 * the same single-use refresh token.
 */

export interface SessionUser {
  id: string;
  display_name: string | null;
  email: string | null;
  role: string | null;
  org: { id: string; name: string; slug: string } | null;
}

export interface Session {
  accessToken: string;
  /** Null when the session came from a pasted token: nothing to refresh with. */
  refreshToken: string | null;
  /** Unix seconds; null for a pasted token whose expiry we do not parse. */
  expiresAt: number | null;
  user: SessionUser | null;
  /**
   * Where the credential came from, because it decides how it is renewed.
   * 'clozr' is a Supabase access token an open CLOZR tab handed over: it has no
   * refresh token we may redeem — that one belongs to the tab and is
   * single-use — so renewal is re-reading the tab. Absent means this
   * extension's own sign-in, renewed against /v1/auth/refresh.
   */
  origin?: 'clozr';
}

export const DEFAULT_API_URL = 'https://api.talkr.example.com';

/** Popup/side panel/offscreen → service worker. */
export type SessionRequest =
  | { type: 'session.get' }
  | { type: 'session.refresh' }
  | { type: 'session.set'; session: Session }
  | { type: 'session.clear' }
  | { type: 'session.apiUrl.get' }
  | { type: 'session.apiUrl.set'; apiUrl: string };

/** Service worker → everyone, whenever the session changes. */
export interface SessionBroadcast {
  type: 'session.changed';
  session: Session | null;
}

export function isSessionRequest(value: unknown): value is SessionRequest {
  const t = (value as { type?: unknown })?.type;
  return typeof t === 'string' && t.startsWith('session.') && t !== 'session.changed';
}

async function ask<T>(request: SessionRequest): Promise<T> {
  const res = (await chrome.runtime.sendMessage(request)) as { ok: boolean; value?: T; error?: string };
  if (!res?.ok) throw new Error(res?.error ?? 'session request failed');
  return res.value as T;
}

export const session = {
  /** The current session, refreshed first if it is about to expire. */
  get: () => ask<Session | null>({ type: 'session.get' }),
  /** Force a refresh (after a 401). Null if the session cannot be renewed. */
  refresh: () => ask<Session | null>({ type: 'session.refresh' }),
  set: (s: Session) => ask<void>({ type: 'session.set', session: s }),
  clear: () => ask<void>({ type: 'session.clear' }),
  apiUrl: () => ask<string>({ type: 'session.apiUrl.get' }),
  setApiUrl: (apiUrl: string) => ask<void>({ type: 'session.apiUrl.set', apiUrl }),
};

/** Subscribe to session changes from any surface. Returns the unsubscriber. */
export function onSessionChanged(cb: (s: Session | null) => void): () => void {
  const listener = (message: unknown) => {
    const m = message as Partial<SessionBroadcast>;
    if (m?.type === 'session.changed') cb(m.session ?? null);
  };
  chrome.runtime.onMessage.addListener(listener);
  return () => chrome.runtime.onMessage.removeListener(listener);
}
