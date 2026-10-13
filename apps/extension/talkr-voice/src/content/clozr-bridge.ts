/**
 * The CLOZR half of the bridge, living in the page.
 *
 * Why a content script and not a host permission: CLOZR keeps the rep's
 * Supabase session in its own tab, and the only way to read what that tab has
 * renewed is to be in it. See `@/shared/clozr` for the rules this obeys —
 * credentials only ever travel page → extension, an offered token is verified
 * before it is stored, and a rep already signed in by hand is never replaced.
 *
 * The page opts in by setting `data-talkr-bridge="clozr"` on `<html>`, which
 * is why this can run on every site without a list of CLOZR origins to keep up
 * to date: a preview deployment, a custom domain and a laptop on
 * localhost:3000 all work the moment CLOZR itself says so.
 */

import {
  CLOZR_BRIDGE,
  CLOZR_MARKER_ATTR,
  PAGE_FROM_CLOZR,
  PAGE_FROM_EXTENSION,
  isPageToExtension,
  type ClozrSessionOffer,
  type ClozrTokenReply,
  type ExtensionToPage,
} from '@/shared/clozr';
import { DIAL_REQUEST, type DialRequest } from '@/shared/dial';
import { toE164 } from './phone-numbers';

const VERSION = '1';
/** How long we wait for the page to answer a token request before giving up. */
const REPLY_TIMEOUT_MS = 2500;

function pageSpeaksBridge(): boolean {
  return document.documentElement.getAttribute(CLOZR_MARKER_ATTR) === 'clozr';
}

function post(message: ExtensionToPage): void {
  window.postMessage(message, location.origin);
}

/** Resolvers waiting on the page's next `clozr.session`. */
let pending: Array<(reply: ClozrTokenReply) => void> = [];

function resolvePending(reply: ClozrTokenReply): void {
  const waiting = pending;
  pending = [];
  for (const fn of waiting) fn(reply);
}

function askPageForToken(): Promise<ClozrTokenReply> {
  return new Promise((resolve) => {
    const empty: ClozrTokenReply = { token: null, email: null, expiresAt: null, apiUrl: null };
    if (!pageSpeaksBridge()) {
      resolve(empty);
      return;
    }
    let settled = false;
    const done = (reply: ClozrTokenReply) => {
      if (settled) return;
      settled = true;
      resolve(reply);
    };
    pending.push(done);
    post({ source: PAGE_FROM_EXTENSION, type: 'talkr.token-request' });
    // A page that has signed out simply never answers; do not hang the worker.
    setTimeout(() => done(empty), REPLY_TIMEOUT_MS);
  });
}

function offerToWorker(reply: ClozrTokenReply): void {
  if (!reply.token) return;
  const offer: ClozrSessionOffer = {
    type: CLOZR_BRIDGE.offer,
    token: reply.token,
    email: reply.email,
    expiresAt: reply.expiresAt,
    apiUrl: reply.apiUrl,
  };
  void chrome.runtime.sendMessage(offer).catch(() => undefined);
}

function onPageMessage(event: MessageEvent): void {
  // Only this window, only this origin, only messages that say they are CLOZR.
  // Anything else on the page can post whatever it likes; none of it is read.
  if (event.source !== window || event.origin !== location.origin) return;
  if (!isPageToExtension(event.data)) return;
  const data = event.data;
  if (data.type === 'clozr.session') {
    const reply: ClozrTokenReply = {
      token: data.token,
      email: data.email,
      expiresAt: data.expiresAt,
      apiUrl: data.apiUrl,
    };
    resolvePending(reply);
    offerToWorker(reply);
    return;
  }
  if (data.type === 'clozr.dial') {
    const e164 = toE164(data.e164);
    if (!e164) return;
    // Re-register this tab first: the worker may have been evicted since the
    // handshake, and it only reports `talkr.call` to tabs it knows about. CLOZR
    // dials in its own tab if no report arrives soon after it asks.
    void chrome.runtime
      .sendMessage({ type: CLOZR_BRIDGE.present })
      .catch(() => undefined)
      .then(() => chrome.runtime.sendMessage({ type: DIAL_REQUEST, e164, source: 'link' } satisfies DialRequest))
      .catch(() => undefined);
    return;
  }
  if (data.type === 'clozr.ping') {
    // Pong only when the worker answers and says the softphone is registered.
    // An invalidated context or a dead worker throws, and says nothing.
    try {
      void chrome.runtime
        .sendMessage({ type: CLOZR_BRIDGE.alive })
        .then((res: { holding?: boolean } | undefined) => {
          if (res?.holding) post({ source: PAGE_FROM_EXTENSION, type: 'talkr.pong' });
        })
        .catch(() => undefined);
    } catch {
      // `chrome.runtime` is gone once the extension reloads under this page.
    }
  }
}

/** Say hello, so the page hands over whatever session it already has. */
function handshake(): void {
  if (!pageSpeaksBridge()) return;
  post({ source: PAGE_FROM_EXTENSION, type: 'talkr.hello', version: VERSION });
  void chrome.runtime
    .sendMessage({ type: CLOZR_BRIDGE.present })
    .then((res: { holding?: boolean } | undefined) => {
      // Tell the page straight away whether we are holding the softphone, so
      // it does not register a second one under the same identity.
      post({ source: PAGE_FROM_EXTENSION, type: 'talkr.softphone', holding: Boolean(res?.holding) });
    })
    .catch(() => undefined);
}

export function installClozrBridge(): void {
  window.addEventListener('message', onPageMessage);

  // The app boots after the document does, so the marker may not be there yet.
  // Watch for it rather than guessing at a delay.
  if (pageSpeaksBridge()) handshake();
  else {
    const observer = new MutationObserver(() => {
      if (!pageSpeaksBridge()) return;
      observer.disconnect();
      handshake();
    });
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [CLOZR_MARKER_ATTR],
    });
  }

  // A tab that comes back to the foreground may have renewed while it was
  // away; re-offering is free and keeps the extension from going stale.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && pageSpeaksBridge()) {
      void askPageForToken().then(offerToWorker);
    }
  });

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    const type = (message as { type?: string })?.type;
    if (type === CLOZR_BRIDGE.tokenRequest) {
      void askPageForToken().then(sendResponse);
      return true;
    }
    if (type === 'clozr.softphone') {
      const holding = Boolean((message as { holding?: boolean }).holding);
      post({ source: PAGE_FROM_EXTENSION, type: 'talkr.softphone', holding });
      sendResponse({ ok: true });
      return true;
    }
    if (type === CLOZR_BRIDGE.openRecord) {
      const e164 = (message as { e164?: unknown }).e164;
      if (typeof e164 !== 'string' || !pageSpeaksBridge()) return false;
      post({ source: PAGE_FROM_EXTENSION, type: 'talkr.open-record', e164 });
      sendResponse({ ok: true });
      return true;
    }
    if (type === 'talkr.call.state') {
      // Mirror a call the extension is running onto the record the rep has
      // open, so the CRM is not the last to know what its own phone did.
      const m = message as {
        phase: 'ringing' | 'connected' | 'ended';
        direction: 'inbound' | 'outbound' | null;
        e164: string | null;
        callId: string | null;
      };
      post({
        source: PAGE_FROM_EXTENSION,
        type: 'talkr.call',
        phase: m.phase,
        direction: m.direction,
        e164: m.e164,
        callId: m.callId,
      });
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });
}

export { PAGE_FROM_CLOZR };
