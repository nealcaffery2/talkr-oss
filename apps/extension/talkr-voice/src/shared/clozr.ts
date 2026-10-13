/**
 * The CLOZR bridge: one rep, one sign-in, one softphone.
 *
 * CLOZR and this extension are two front ends over the same Talkr account, and
 * before this bridge existed a rep had to sign in twice — once in CLOZR with
 * their Supabase account, once here with a Talkr password — and then had two
 * softphones registered under the same identity, which is how an inbound call
 * ends up ringing in a tab the rep is not looking at.
 *
 * CLOZR already signs its Talkr requests with the rep's own Supabase access
 * token, which Talkr verifies as a partner identity and links by email
 * (apps/server/src/auth.ts). That token is all the extension needs, so the
 * bridge carries it from an open CLOZR tab to the service worker and nothing
 * else in that direction. Three rules keep that safe:
 *
 *  - **Credentials only travel page → extension.** The extension never posts a
 *    session, a Talkr token or a rep's data back onto the page. A page that
 *    speaks this protocol can offer an identity; it can never read one.
 *  - **An offer is a claim, not a fact.** The worker verifies every offered
 *    token against `GET /v1/me` before storing it, so a page can only ever get
 *    the extension signed in as whoever Talkr says that token is.
 *  - **An existing sign-in is never silently replaced.** If the rep is already
 *    signed in as somebody else, the offer is ignored rather than swapped in
 *    underneath them.
 *
 * Renewal works the same way round. A Supabase access token lasts about an
 * hour and has no refresh token we may use — redeeming it would sign the rep
 * out of CLOZR, since refresh tokens are single-use. So the tab renews, as it
 * always did, and re-offers; the worker asks an open tab for a fresh one when
 * the stored token goes stale.
 */

/** `chrome.runtime` message names, kept apart from the page protocol below. */
export const CLOZR_BRIDGE = {
  /** Content script → worker: a tab is offering a session. */
  offer: 'clozr.session.offer',
  /** Worker → content script: please ask your page for a fresh token. */
  tokenRequest: 'clozr.session.request',
  /** Content script → worker: whether this tab speaks the page protocol. */
  present: 'clozr.present',
  /**
   * Content script → worker: CLOZR asked whether we are still alive. Answered
   * with the offscreen softphone's live state, never a cached one.
   */
  alive: 'clozr.alive',
  /** Popup → worker → content script: show this number's record in CLOZR. */
  openRecord: 'talkr.open-record',
} as const;

/** Where "Open in CLOZR" goes when no CLOZR tab is open. */
export const CLOZR_APP_URL = 'https://clozr.example.com/app';

/** What a CLOZR tab tells us about the rep it has signed in. */
export interface ClozrSessionOffer {
  type: typeof CLOZR_BRIDGE.offer;
  /** The rep's Supabase access token. Verified before it is ever stored. */
  token: string;
  /** Only ever used to label the offer in a log; identity comes from `/v1/me`. */
  email: string | null;
  /** Unix seconds, read from the token by the page. Null means "ask the JWT". */
  expiresAt: number | null;
  /** The Talkr API this workspace points at, when CLOZR overrides the default. */
  apiUrl: string | null;
}

export interface ClozrTokenReply {
  token: string | null;
  email: string | null;
  expiresAt: number | null;
  apiUrl: string | null;
}

export function isClozrSessionOffer(value: unknown): value is ClozrSessionOffer {
  const v = value as Partial<ClozrSessionOffer> | null;
  return v?.type === CLOZR_BRIDGE.offer && typeof v.token === 'string' && v.token.length > 0;
}

// ── The page protocol ──────────────────────────────────────────────────────
// `window.postMessage` between the CLOZR page and this extension's content
// script. Both sides check `source` and the window, because every extension
// and every script in the page sees these messages.

/** Set by CLOZR on `<html>` so the bridge knows the page speaks this protocol. */
export const CLOZR_MARKER_ATTR = 'data-talkr-bridge';

export const PAGE_FROM_EXTENSION = 'talkr-extension' as const;
export const PAGE_FROM_CLOZR = 'clozr' as const;

/** Extension → page. */
export type ExtensionToPage =
  /** "I am here": the page answers with its session, if it has one. */
  | { source: typeof PAGE_FROM_EXTENSION; type: 'talkr.hello'; version: string }
  /** The stored token went stale; the page's client has a fresh one. */
  | { source: typeof PAGE_FROM_EXTENSION; type: 'talkr.token-request' }
  /**
   * The extension's softphone is registered, so the page should not register a
   * second one under the same identity. Sent on every hello and whenever the
   * softphone comes up or goes down.
   */
  | { source: typeof PAGE_FROM_EXTENSION; type: 'talkr.softphone'; holding: boolean }
  /**
   * Answer to `clozr.ping`, sent only while the softphone is actually
   * registered. Silence is the signal: a page that stops hearing this takes
   * the phone back.
   */
  | { source: typeof PAGE_FROM_EXTENSION; type: 'talkr.pong' }
  /** "Open in CLOZR" from the popup: bring up the record on this number. */
  | { source: typeof PAGE_FROM_EXTENSION; type: 'talkr.open-record'; e164: string }
  /** A call the extension is running, so the record can follow it live. */
  | {
      source: typeof PAGE_FROM_EXTENSION;
      type: 'talkr.call';
      phase: 'ringing' | 'connected' | 'ended';
      direction: 'inbound' | 'outbound' | null;
      e164: string | null;
      callId: string | null;
    };

/** Page → extension. */
export type PageToExtension =
  | {
      source: typeof PAGE_FROM_CLOZR;
      type: 'clozr.session';
      token: string | null;
      email: string | null;
      expiresAt: number | null;
      apiUrl: string | null;
    }
  /** A CLOZR button asking the extension to place the call. */
  | { source: typeof PAGE_FROM_CLOZR; type: 'clozr.dial'; e164: string }
  /** Sent every so often while we say we hold the softphone; see `talkr.pong`. */
  | { source: typeof PAGE_FROM_CLOZR; type: 'clozr.ping' };

export function isPageToExtension(value: unknown): value is PageToExtension {
  const v = value as Partial<PageToExtension> | null;
  return v?.source === PAGE_FROM_CLOZR && typeof v.type === 'string';
}

/** Unix seconds from a JWT's `exp`, or null when it has none we can read. */
export function jwtExpiry(token: string): number | null {
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    const payload = JSON.parse(atob(part.replace(/-/g, '+').replace(/_/g, '/'))) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp : null;
  } catch {
    return null;
  }
}
