/**
 * MV3 background. It owns three things on purpose and nothing else:
 *
 *   1. the offscreen document — the call lives there, and the worker makes
 *      sure it exists before any surface addresses it;
 *   2. the session — tokens live in chrome.storage here, and only here,
 *      because the offscreen document has no storage API and because refresh
 *      tokens are single-use: one owner means no two contexts ever race to
 *      redeem the same one. A session adopted from an open CLOZR tab is
 *      renewed by re-reading that tab rather than by a refresh token, because
 *      the tab's own Supabase client is the thing that renews it;
 *      The rep's presence (Available, Do not disturb, Away) is kept here
 *      for the same reason and handed to the document whenever it is made;
 *   3. dial requests from a page — click-to-call. A content script has no
 *      session and no carrier client, so it asks here, and here is also where
 *      the refusals with a next step come from (signed out, no microphone,
 *      already on a call).
 *
 * The worker is evictable, so every entry point re-ensures the document and
 * re-reads storage rather than assuming a previous run did.
 */

import {
  DEFAULT_API_URL,
  isSessionRequest,
  type Session,
  type SessionBroadcast,
  type SessionRequest,
} from '@/shared/session';
import { DIAL_REQUEST, isDialRequest, type DialRequest, type DialResult } from '@/shared/dial';
import { envelope, type CallSnapshot, type Command } from '@/shared/messages';
import type { LiveBadge, LiveNotice } from '@/offscreen/live';
import { PRESENCE_KEY, SET_PRESENCE, asPresence, type Presence } from '@/shared/presence';
import {
  CLOZR_APP_URL,
  CLOZR_BRIDGE,
  isClozrSessionOffer,
  jwtExpiry,
  type ClozrSessionOffer,
  type ClozrTokenReply,
} from '@/shared/clozr';
import { findPhoneNumbers, formatE164, telHrefToE164 } from '@/content/phone-numbers';

const OFFSCREEN_PATH = 'offscreen.html';
const STORAGE = {
  session: 'talkr_session',
  apiUrl: 'talkr_api_url',
  clozrSync: 'talkr_clozr_sync',
  /** The popup tab a clicked notification asked for; the popup reads and clears it. */
  pendingView: 'talkr_pending_view',
} as const;
/** Refresh this close to expiry so a request in flight never uses a dead token. */
const REFRESH_SKEW_SECONDS = 90;

// ── Offscreen document ─────────────────────────────────────────────────────

let ensuring: Promise<void> | null = null;

async function hasOffscreen(): Promise<boolean> {
  // getContexts is the supported check from Chrome 116 on.
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT' as chrome.runtime.ContextType],
  });
  return contexts.length > 0;
}

/**
 * Create the offscreen document if it is not already there. Concurrent callers
 * share one attempt — creating twice throws, and two half-open Devices would
 * both try to register the same identity.
 */
async function ensureOffscreen(): Promise<void> {
  if (ensuring) return ensuring;
  let created = false;
  ensuring = (async () => {
    try {
      if (await hasOffscreen()) return;
      // A fresh document starts Available; tell it what the rep picked once it answers.
      created = true;
      await chrome.offscreen.createDocument({
        url: OFFSCREEN_PATH,
        // USER_MEDIA: getUserMedia for the mic on answer. AUDIO_PLAYBACK: the
        // far end's audio through the offscreen <audio> element.
        reasons: [
          'USER_MEDIA' as chrome.offscreen.Reason,
          'AUDIO_PLAYBACK' as chrome.offscreen.Reason,
        ],
        justification:
          'Holds the WebRTC softphone so an in-progress call survives the popup closing.',
      });
    } catch (err) {
      // A parallel creation won the race; that is the state we wanted anyway.
      if (!String(err).includes('Only a single offscreen')) throw err;
    } finally {
      ensuring = null;
      if (created) void pushPresence();
    }
  })();
  return ensuring;
}

// ── Presence ───────────────────────────────────────────────────────────────

async function readPresence(): Promise<Presence> {
  const stored = await chrome.storage.local.get([PRESENCE_KEY]);
  return asPresence(stored[PRESENCE_KEY]);
}

/** Hand the document the rep's presence, once it is up to hear it. */
async function pushPresence(): Promise<void> {
  const presence = await readPresence();
  if (!(await offscreenReady())) return;
  await chrome.runtime
    .sendMessage(envelope<Command>({ type: 'setPresence', presence }))
    .catch(() => undefined);
}

async function savePresence(presence: Presence): Promise<void> {
  await chrome.storage.local.set({ [PRESENCE_KEY]: presence });
  if (await hasOffscreen()) await pushPresence();
  else await ensureOffscreen();
}

// ── Session ────────────────────────────────────────────────────────────────

async function readSession(): Promise<Session | null> {
  const stored = await chrome.storage.local.get([STORAGE.session]);
  return (stored[STORAGE.session] as Session | undefined) ?? null;
}

async function readApiUrl(): Promise<string> {
  const stored = await chrome.storage.local.get([STORAGE.apiUrl]);
  return (stored[STORAGE.apiUrl] as string | undefined) ?? DEFAULT_API_URL;
}

async function writeSession(next: Session | null): Promise<void> {
  if (next) await chrome.storage.local.set({ [STORAGE.session]: next });
  else await chrome.storage.local.remove(STORAGE.session);
  const msg: SessionBroadcast = { type: 'session.changed', session: next };
  // Nobody listening (no surface open) is not an error.
  void chrome.runtime.sendMessage(msg).catch(() => undefined);
}

function isStale(s: Session): boolean {
  return s.expiresAt !== null && s.expiresAt - REFRESH_SKEW_SECONDS <= Date.now() / 1000;
}

let refreshing: Promise<Session | null> | null = null;

/**
 * Renew the session, by whichever route its origin calls for. Shared across
 * concurrent callers for the same reason ensureOffscreen is. A refresh the
 * server rejects clears the session: it has said this one is over, and keeping
 * a token that will 401 on every request only hides that from the rep. A
 * server that cannot be reached keeps it — signing someone out for a network
 * blip is worse.
 */
function refreshSession(): Promise<Session | null> {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const current = await readSession();
      if (!current) return null;
      if (current.origin === 'clozr') {
        // The CLOZR tab holds the only refresh token, and it is single-use:
        // redeeming it here would sign the rep out of the CRM they are
        // working in. Ask the tab for what it already has instead.
        const renewed = await clozrRenew();
        if (renewed) return renewed;
        if (isStale(current)) await writeSession(null);
        return isStale(current) ? null : current;
      }
      if (!current.refreshToken) {
        // A pasted token cannot be renewed; once it is stale it is gone.
        if (isStale(current)) await writeSession(null);
        return isStale(current) ? null : current;
      }
      let res: Response;
      try {
        res = await fetch(`${await readApiUrl()}/v1/auth/refresh`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ refresh_token: current.refreshToken }),
        });
      } catch {
        return current;
      }
      if (res.status === 401 || res.status === 403) {
        await writeSession(null);
        return null;
      }
      if (!res.ok) return current;
      const body = (await res.json()) as {
        access_token: string;
        refresh_token: string;
        expires_at: number;
        user: Session['user'];
      };
      const next: Session = {
        accessToken: body.access_token,
        refreshToken: body.refresh_token,
        expiresAt: body.expires_at,
        user: body.user,
      };
      await writeSession(next);
      return next;
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

async function handleSession(request: SessionRequest): Promise<unknown> {
  switch (request.type) {
    case 'session.get': {
      const s = await readSession();
      if (!s) return null;
      return isStale(s) ? refreshSession() : s;
    }
    case 'session.refresh':
      return refreshSession();
    case 'session.set':
      await writeSession(request.session);
      return undefined;
    case 'session.clear':
      await writeSession(null);
      return undefined;
    case 'session.apiUrl.get':
      return readApiUrl();
    case 'session.apiUrl.set':
      await chrome.storage.local.set({ [STORAGE.apiUrl]: request.apiUrl.replace(/\/$/, '') });
      return undefined;
  }
}


// ── CLOZR sign-in ──────────────────────────────────────────────────────────

/** Tabs whose page answered the bridge handshake; asked for a fresh token. */
const clozrTabs = new Set<number>();

/**
 * Verify a token the way the API will, and turn it into a session. A page can
 * claim any identity it likes; `/v1/me` is what decides whose it actually is.
 */
async function sessionFromClozrToken(
  token: string,
  expiresAt: number | null,
  apiUrl: string,
): Promise<Session | null> {
  let res: Response;
  try {
    res = await fetch(`${apiUrl}/v1/me`, { headers: { authorization: `Bearer ${token}` } });
  } catch {
    return null;
  }
  if (!res.ok) return null;
  const me = (await res.json()) as {
    id: string;
    display_name: string | null;
    email: string | null;
    role: string | null;
    org: { id: string; name: string; slug: string } | null;
  };
  return {
    accessToken: token,
    // Supabase refresh tokens are single-use and belong to the CLOZR tab: if
    // we redeemed one we would sign the rep out of CLOZR. The tab renews and
    // re-offers instead (see clozrRenew).
    refreshToken: null,
    expiresAt: expiresAt ?? jwtExpiry(token),
    user: { id: me.id, display_name: me.display_name, email: me.email, role: me.role, org: me.org },
    /** Remembered so a renewal knows to ask a tab rather than the refresh route. */
    origin: 'clozr',
  };
}

/**
 * Adopt a session a CLOZR tab offered. Signed out, this signs the rep in.
 * Signed in as the same person, it is a renewal. Signed in as somebody else it
 * does nothing at all — a tab does not get to swap the rep underneath a call.
 */
async function adoptClozrSession(offer: ClozrSessionOffer): Promise<void> {
  if (!(await clozrSyncEnabled())) return;
  const apiUrl = offer.apiUrl?.replace(/\/$/, '') || (await readApiUrl());
  const current = await readSession();
  const next = await sessionFromClozrToken(offer.token, offer.expiresAt, apiUrl);
  if (!next) return;
  if (current?.user?.id && current.user.id !== next.user?.id && current.origin !== 'clozr') {
    // A different rep is signed in here by hand. Leave them alone.
    return;
  }
  if (offer.apiUrl) await chrome.storage.local.set({ [STORAGE.apiUrl]: apiUrl });
  if (current?.accessToken === next.accessToken) return; // nothing changed
  await writeSession(next);
}

/**
 * Ask every CLOZR tab for a fresh token and adopt the first that verifies.
 * This is the renewal path for a CLOZR-originated session: the tab's Supabase
 * client has already renewed, so all we do is re-read it.
 */
async function clozrRenew(): Promise<Session | null> {
  if (!(await clozrSyncEnabled())) return null;
  const tabs = [...clozrTabs];
  for (const tabId of tabs) {
    let reply: ClozrTokenReply | undefined;
    try {
      reply = (await chrome.tabs.sendMessage(tabId, { type: CLOZR_BRIDGE.tokenRequest })) as ClozrTokenReply;
    } catch {
      // The tab closed or navigated away; stop asking it.
      clozrTabs.delete(tabId);
      continue;
    }
    if (!reply?.token) continue;
    await adoptClozrSession({
      type: CLOZR_BRIDGE.offer,
      token: reply.token,
      email: reply.email,
      expiresAt: reply.expiresAt,
      apiUrl: reply.apiUrl,
    });
    const renewed = await readSession();
    if (renewed && !isStale(renewed)) return renewed;
  }
  return null;
}

async function clozrSyncEnabled(): Promise<boolean> {
  const stored = await chrome.storage.local.get([STORAGE.clozrSync]);
  return (stored[STORAGE.clozrSync] as boolean | undefined) ?? true;
}

/** Tell every CLOZR tab whether this extension is holding the softphone. */
async function announceSoftphone(holding: boolean): Promise<void> {
  for (const tabId of [...clozrTabs]) {
    try {
      await chrome.tabs.sendMessage(tabId, { type: 'clozr.softphone', holding });
    } catch {
      clozrTabs.delete(tabId);
    }
  }
}

// ── Open in CLOZR ──────────────────────────────────────────────────────────

/** A number waiting on a CLOZR tab whose page has not said hello yet. */
let pendingOpen: { tabId: number; e164: string } | null = null;

async function sendOpenRecord(tabId: number, e164: string): Promise<boolean> {
  const res = (await chrome.tabs
    .sendMessage(tabId, { type: CLOZR_BRIDGE.openRecord, e164 })
    .catch(() => undefined)) as { ok?: boolean } | undefined;
  return Boolean(res?.ok);
}

/**
 * Put the rep on this number's record in CLOZR: the CLOZR tab they already
 * have if there is one, a new one if not. CLOZR has no URL per record, so the
 * page is told over the bridge; a tab that is still loading gets it when its
 * handshake arrives, and CLOZR itself waits for its workspace to load.
 */
async function openInClozr(e164: string): Promise<void> {
  const origin = new URL(CLOZR_APP_URL).origin;
  const open = await chrome.tabs.query({ url: `${origin}/*` });
  const tabId = open[0]?.id ?? [...clozrTabs][0];
  if (tabId === undefined) {
    const tab = await chrome.tabs.create({ url: CLOZR_APP_URL });
    if (tab.id !== undefined) pendingOpen = { tabId: tab.id, e164 };
    return;
  }
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab?.windowId !== undefined) await chrome.windows.update(tab.windowId, { focused: true });
  if (!(await sendOpenRecord(tabId, e164))) pendingOpen = { tabId, e164 };
}

// ── Click-to-call ──────────────────────────────────────────────────────────

/** Ask the offscreen document for its current view of the call. */
async function snapshotNow(): Promise<CallSnapshot | null> {
  try {
    const res = (await chrome.runtime.sendMessage(
      envelope<Command>({ type: 'getSnapshot' }),
    )) as { snapshot?: CallSnapshot } | undefined;
    return res?.snapshot ?? null;
  } catch {
    return null;
  }
}

/**
 * `createDocument` resolves before the document's own script has run, so the
 * first message after it can land on nobody and reject. Wait for the document
 * to answer rather than losing the rep's first click of the day.
 */
async function offscreenReady(): Promise<CallSnapshot | null> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const snapshot = await snapshotNow();
    if (snapshot) return snapshot;
    await new Promise((r) => setTimeout(r, 100));
  }
  return null;
}

/**
 * Place a call on behalf of a page.
 *
 * Every refusal here is one the rep can act on, which is the whole point of
 * answering the content script rather than failing quietly: a number clicked
 * on a page that does nothing at all is worse than no feature.
 */
async function dial(request: DialRequest, tabId: number | undefined): Promise<DialResult> {
  const session = await handleSession({ type: 'session.get' }) as Session | null;
  if (!session) return { ok: false, refusal: 'signed-out' };

  await ensureOffscreen();
  // The document may have just been created, so wait for it to answer before
  // asking about the call it is not yet running.
  let snapshot = await offscreenReady();
  if (snapshot && snapshot.phase !== 'idle' && snapshot.phase !== 'wrapup') {
    return { ok: false, refusal: 'busy' };
  }
  if (snapshot && snapshot.device !== 'ready') {
    // The microphone can only be granted from a visible extension page, so an
    // offscreen document alone can never get there (see the README).
    await chrome.runtime.sendMessage(envelope<Command>({ type: 'init' })).catch(() => undefined);
    snapshot = await snapshotNow();
    if (snapshot && snapshot.device !== 'ready') {
      return {
        ok: false,
        refusal: 'no-softphone',
        message:
          snapshot.deviceError ??
          'Enable the softphone once from the Talkr toolbar button, then try again.',
      };
    }
  }

  const res = (await chrome.runtime
    .sendMessage(envelope<Command>({ type: 'call', toNumber: request.e164 }))
    .catch(() => undefined)) as { snapshot?: CallSnapshot } | undefined;
  const after = res?.snapshot;
  if (after?.error) return { ok: false, refusal: 'refused', message: after.error };

  // The call is up; put the console in front of the rep. `sidePanel.open`
  // wants a user gesture and the click that got us here may not still count,
  // so a refusal is not a failed call.
  if (tabId !== undefined) {
    await chrome.sidePanel.open({ tabId }).catch(() => undefined);
  }
  return { ok: true, message: `Calling ${formatE164(request.e164)}` };
}

// ── Context menu ───────────────────────────────────────────────────────────

const MENU_SELECTION = 'talkr-call-selection';
const MENU_LINK = 'talkr-call-link';

function installMenus(): void {
  // Rebuild rather than update: onInstalled fires on every update too, and
  // creating an id that already exists throws.
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_SELECTION,
      title: 'Call "%s" with Talkr',
      contexts: ['selection'],
    });
    chrome.contextMenus.create({
      id: MENU_LINK,
      title: 'Call this number with Talkr',
      contexts: ['link'],
      targetUrlPatterns: ['tel:*'],
    });
    // A creation failure here is a menu we do without, not a broken worker.
    void chrome.runtime.lastError;
  });
}

// ── Wiring ─────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  void ensureOffscreen();
  installMenus();
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => undefined);
});

chrome.runtime.onStartup.addListener(() => {
  void ensureOffscreen();
  installMenus();
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  const raw =
    info.menuItemId === MENU_LINK
      ? telHrefToE164(info.linkUrl ?? '')
      : (findPhoneNumbers(info.selectionText ?? '')[0]?.e164 ?? null);
  if (!raw) {
    void notifyTab(tab?.id, { ok: false, refusal: 'refused', message: 'No phone number in that.' });
    return;
  }
  void dial({ type: DIAL_REQUEST, e164: raw, source: 'context-menu' }, tab?.id).then((result) =>
    notifyTab(tab?.id, result),
  );
});

/** Hand a result back to the page so the toast comes from where the click was. */
async function notifyTab(tabId: number | undefined, result: DialResult): Promise<void> {
  if (tabId === undefined) return;
  await chrome.tabs.sendMessage(tabId, { type: 'talkr.dial.result', result }).catch(() => undefined);
}

chrome.tabs.onRemoved.addListener((tabId) => clozrTabs.delete(tabId));

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const type = (message as { type?: string })?.type;
  if (type === 'ensureOffscreen') {
    // The popup and the side panel both ask for the document before sending
    // their first command, because the worker may have been evicted since.
    void ensureOffscreen()
      .then(() => sendResponse({ ok: true }))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (type === SET_PRESENCE) {
    void savePresence(asPresence((message as { presence?: unknown }).presence))
      .then(() => sendResponse({ ok: true }))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (isSessionRequest(message)) {
    void handleSession(message)
      .then((value) => sendResponse({ ok: true, value }))
      .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
    return true;
  }
  if (isDialRequest(message)) {
    void dial(message, sender.tab?.id)
      .then(sendResponse)
      .catch((err: Error) => sendResponse({ ok: false, refusal: 'refused', message: err.message }));
    return true;
  }
  if (isClozrSessionOffer(message)) {
    void adoptClozrSession(message)
      .then(() => sendResponse({ ok: true }))
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (type === CLOZR_BRIDGE.openRecord) {
    const e164 = (message as { e164?: unknown }).e164;
    if (typeof e164 === 'string') {
      void openInClozr(e164)
        .then(() => sendResponse({ ok: true }))
        .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
      return true;
    }
    return false;
  }
  if (type === CLOZR_BRIDGE.present) {
    if (sender.tab?.id !== undefined) clozrTabs.add(sender.tab.id);
    if (pendingOpen && pendingOpen.tabId === sender.tab?.id) {
      const { tabId, e164 } = pendingOpen;
      pendingOpen = null;
      void sendOpenRecord(tabId, e164);
    }
    sendResponse({ ok: true, holding: softphoneHolding });
    return true;
  }
  if (type === CLOZR_BRIDGE.alive) {
    // Ask the offscreen document rather than trusting `softphoneHolding`: that
    // flag is only as fresh as the last broadcast, and CLOZR uses the answer
    // to decide whether to take the phone back.
    if (sender.tab?.id !== undefined) clozrTabs.add(sender.tab.id);
    void snapshotNow().then((snapshot) => {
      if (snapshot) void onSnapshot(snapshot);
      sendResponse({ ok: true, holding: snapshot?.device === 'ready' });
    });
    return true;
  }
  if (type === 'talkr.notify') {
    void showLiveNotice(message as LiveNotice);
    return false;
  }
  if (type === 'talkr.badge') {
    void setBadge(Number((message as LiveBadge).count) || 0);
    return false;
  }
  if (type === 'snapshot') {
    // The offscreen document broadcasts to everyone. The worker listens for
    // two things: whether CLOZR should stand its own softphone down while this
    // one is registered under the same identity, and where the call has got
    // to, so an open record can follow it.
    const snapshot = (message as { snapshot?: CallSnapshot }).snapshot;
    if (snapshot) void onSnapshot(snapshot);
    return false;
  }
  return false;
});

let softphoneHolding = false;
let lastCallPhase: CallSnapshot['phase'] = 'idle';

// ── Notifications ──────────────────────────────────────────────────────────
//
// The popup is only there while it is open, so a call, text or voicemail that
// arrives with it shut needs a Chrome notification to be noticed at all. The
// offscreen document rings (offscreen/ringtone.ts) and finds the texts and
// voicemails that are the rep's own (offscreen/live.ts); this raises them.
//
// With a CLOZR tab open, CLOZR already chimes for the rep's texts and
// voicemail from the same stream, so these arrive silent: one sound, not two.
// The incoming-call card is always silent; the ringtone is its sound, and
// CLOZR stands its own softphone down while this one holds the line.

const INCOMING_ID = 'talkr-incoming';

/** chrome.notifications, promised; a failure (permission revoked, OS blocked) is not the caller's problem. */
const notices = {
  create: (id: string, o: chrome.notifications.NotificationOptions<true>) =>
    new Promise<void>((done) => chrome.notifications.create(id, o, () => (void chrome.runtime.lastError, done()))),
  update: (id: string, o: chrome.notifications.NotificationOptions<true>) =>
    new Promise<void>((done) => chrome.notifications.update(id, o, () => (void chrome.runtime.lastError, done()))),
  clear: (id: string) =>
    new Promise<void>((done) => chrome.notifications.clear(id, () => (void chrome.runtime.lastError, done()))),
};
let incomingShown: string | null = null;
const ICON = 'icons/128.png';

async function syncIncomingNotice(snapshot: CallSnapshot): Promise<void> {
  const from = snapshot.incoming?.from ?? null;
  const label = snapshot.incoming ? (snapshot.incoming.contactName ?? formatE164(from ?? '')) : null;
  if (!label) {
    if (incomingShown) {
      incomingShown = null;
      await notices.clear(INCOMING_ID);
    }
    return;
  }
  if (label === incomingShown) return;
  const first = incomingShown === null;
  incomingShown = label;
  const options: chrome.notifications.NotificationOptions<true> = {
    type: 'basic',
    iconUrl: ICON,
    title: 'Incoming call',
    message: label,
    contextMessage: snapshot.incoming?.contactName && from ? formatE164(from) : 'Talkr',
    buttons: [{ title: 'Answer' }, { title: 'Decline' }],
    requireInteraction: true,
    silent: true,
    priority: 2,
  };
  // The contact name lands a moment after the ring; update the card in place.
  if (first) await notices.create(INCOMING_ID, options);
  else await notices.update(INCOMING_ID, options);
}

/** Which popup tab each open text/voicemail notification lands on when clicked. */
const noticeViews = new Map<string, 'inbox' | 'voicemail'>();

async function showLiveNotice(n: LiveNotice): Promise<void> {
  noticeViews.set(n.key, n.kind === 'voicemail' ? 'voicemail' : 'inbox');
  await notices.create(n.key, {
    type: 'basic',
    iconUrl: ICON,
    title: n.title,
    message: n.body,
    contextMessage: n.kind === 'voicemail' ? 'Talkr voicemail' : 'Talkr text',
    silent: clozrTabs.size > 0,
    priority: 1,
  });
}

async function setBadge(count: number): Promise<void> {
  await chrome.action.setBadgeBackgroundColor({ color: '#e5484d' }).catch(() => undefined);
  await chrome.action.setBadgeText({ text: count > 0 ? (count > 99 ? '99+' : String(count)) : '' }).catch(() => undefined);
}

/** Open the popup on a tab. openPopup needs Chrome 127 and a focused window; failing that the view waits for the next open. */
async function openPopupOn(view: 'inbox' | 'voicemail' | 'dial'): Promise<void> {
  await chrome.storage.local.set({ [STORAGE.pendingView]: view });
  await chrome.action.openPopup().catch(() => undefined);
}

chrome.notifications.onButtonClicked.addListener((id, index) => {
  if (id !== INCOMING_ID) return;
  void notices.clear(id);
  incomingShown = null;
  const command: Command = index === 0 ? { type: 'acceptIncoming' } : { type: 'rejectIncoming' };
  void chrome.runtime.sendMessage(envelope<Command>(command)).catch(() => undefined);
  if (index === 0) void openPopupOn('dial');
});

chrome.notifications.onClicked.addListener((id) => {
  void notices.clear(id);
  if (id === INCOMING_ID) {
    incomingShown = null;
    void openPopupOn('dial');
    return;
  }
  void openPopupOn(noticeViews.get(id) ?? 'inbox');
  noticeViews.delete(id);
});

/**
 * React to the call's state, once per change. Chrome delivers a broadcast on
 * every patch — a roster poll is one every two seconds — so anything here has
 * to be idempotent or gated on an actual transition, or a two-minute call
 * posts sixty identical events at the CRM.
 */
async function onSnapshot(snapshot: CallSnapshot): Promise<void> {
  void syncIncomingNotice(snapshot);
  const holding = snapshot.device === 'ready';
  if (holding !== softphoneHolding) {
    softphoneHolding = holding;
    await announceSoftphone(holding);
  }

  const phase = snapshot.phase;
  if (phase === lastCallPhase) return;
  const previous = lastCallPhase;
  lastCallPhase = phase;
  const reported =
    phase === 'ringing' || phase === 'connecting'
      ? 'ringing'
      : phase === 'in_call'
        ? 'connected'
        : previous === 'idle'
          ? null // idle → wrapup with nothing before it is not a call ending
          : 'ended';
  if (!reported) return;
  for (const tabId of [...clozrTabs]) {
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: 'talkr.call.state',
        phase: reported,
        direction: snapshot.direction,
        e164: snapshot.counterparty,
        callId: snapshot.callId,
      });
    } catch {
      clozrTabs.delete(tabId);
    }
  }
}

export {};
