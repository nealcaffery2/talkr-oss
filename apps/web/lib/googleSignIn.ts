/**
 * "Continue with Google" for the web app, the browser half.
 *
 * The extension does the same dance through chrome.identity; a web page has a
 * real origin, so it uses a plain redirect instead. The page leaves for
 * Google's authorize URL, Google comes back to /login/google with an id_token
 * on the fragment, and that page hands the token to POST /v1/auth/google,
 * which trades it with Supabase for a session. No secret is involved anywhere
 * in the browser: the client id is public (/v1/auth/config serves it).
 *
 * The nonce has two forms and the halves want different ones. Google embeds
 * whatever `nonce` the URL carries in the token's claim; GoTrue hashes the
 * nonce our API forwards and compares that to the claim. So Google gets the
 * SHA-256 hex and the API gets the raw value. The extension's nonce.ts tells
 * the same story.
 *
 * `state` ties the answer to the attempt this tab started, so an id_token
 * pushed at /login/google by another site is ignored. Both live in
 * sessionStorage: per tab, and gone when the tab closes.
 */

/** sessionStorage key for the attempt in flight. */
export const GOOGLE_ATTEMPT_KEY = 'talkr.google.attempt';

/** Where Google sends the browser back to. Register it per origin in Google Cloud. */
export const GOOGLE_CALLBACK_PATH = '/login/google';

/** What the tab remembers between leaving for Google and coming back. */
export interface GoogleAttempt {
  /** Forwarded to the API, which GoTrue hashes. Never sent to Google. */
  nonce: string;
  state: string;
  /** In-app path to land on once signed in. */
  returnTo: string;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of `value`, lowercase hex: the encoding GoTrue compares against. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

function randomHex(bytes: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** Only an in-app path survives; anything else lands on the dialer. */
export function safeReturnTo(next: string | null | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/dialer';
}

/** A fresh attempt and the Google URL that starts it. */
export async function buildGoogleAuthorize(
  clientId: string,
  origin: string,
  returnTo: string,
): Promise<{ url: string; attempt: GoogleAttempt }> {
  const attempt: GoogleAttempt = { nonce: randomHex(16), state: randomHex(16), returnTo: safeReturnTo(returnTo) };
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('response_type', 'id_token');
  url.searchParams.set('redirect_uri', `${origin}${GOOGLE_CALLBACK_PATH}`);
  url.searchParams.set('scope', 'openid email profile');
  url.searchParams.set('nonce', await sha256Hex(attempt.nonce));
  url.searchParams.set('state', attempt.state);
  // Always show the chooser: a shared machine must not reuse whoever signed in
  // last, and a rep with two Google accounts has to pick the work one.
  url.searchParams.set('prompt', 'select_account');
  return { url: url.href, attempt };
}

export type GoogleCallback =
  | { ok: true; idToken: string; nonce: string; returnTo: string }
  | { ok: false; reason: 'cancelled' | 'no_attempt' | 'state_mismatch' | 'failed'; message: string };

/**
 * Read what Google left on the callback URL against the attempt this tab
 * started. Google answers on the fragment, and puts an error there or on the
 * query string.
 */
export function readGoogleCallback(href: string, attempt: GoogleAttempt | null): GoogleCallback {
  const back = new URL(href);
  const params = new URLSearchParams(back.hash.replace(/^#/, ''));
  const error = params.get('error') ?? back.searchParams.get('error');
  if (error === 'access_denied') return { ok: false, reason: 'cancelled', message: 'Google sign-in was cancelled.' };
  if (error) return { ok: false, reason: 'failed', message: `Google sign-in failed: ${error}.` };
  if (!attempt) {
    return { ok: false, reason: 'no_attempt', message: 'This sign-in was not started from this tab. Try again.' };
  }
  if (params.get('state') !== attempt.state) {
    return { ok: false, reason: 'state_mismatch', message: 'This sign-in did not match the one this tab started. Try again.' };
  }
  const idToken = params.get('id_token');
  if (!idToken) return { ok: false, reason: 'failed', message: 'Google sign-in failed: no token came back.' };
  return { ok: true, idToken, nonce: attempt.nonce, returnTo: attempt.returnTo };
}

export function saveGoogleAttempt(attempt: GoogleAttempt): void {
  try {
    window.sessionStorage.setItem(GOOGLE_ATTEMPT_KEY, JSON.stringify(attempt));
  } catch {
    /* storage blocked: the callback reports no_attempt and the rep retries */
  }
}

/** Read and forget: an attempt answers exactly one callback. */
export function takeGoogleAttempt(): GoogleAttempt | null {
  try {
    const raw = window.sessionStorage.getItem(GOOGLE_ATTEMPT_KEY);
    window.sessionStorage.removeItem(GOOGLE_ATTEMPT_KEY);
    if (!raw) return null;
    const a = JSON.parse(raw) as Partial<GoogleAttempt>;
    if (typeof a.nonce !== 'string' || typeof a.state !== 'string') return null;
    return { nonce: a.nonce, state: a.state, returnTo: safeReturnTo(a.returnTo) };
  } catch {
    return null;
  }
}
