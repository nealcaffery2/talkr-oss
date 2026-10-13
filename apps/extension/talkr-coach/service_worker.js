// Talkr Coach service worker.
// Lifecycle orchestrator. The popup arms the session; the content script
// detects call-active; this worker mints capture stream IDs and forwards to
// the offscreen document; the offscreen doc holds the MediaStream + Deepgram
// WebSocket and forwards transcripts to the overlay.
//
// All cross-context messages use a `target` field to disambiguate listeners.

const OFFSCREEN_PATH = 'offscreen.html';
const SESSION_KEY = 'talkrSession';
const SETTINGS_KEY = 'talkrSettings';

async function hasOffscreenDoc() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreen() {
  if (await hasOffscreenDoc()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'Tab + microphone capture and Deepgram streaming for live call coaching.',
  });
  await new Promise((r) => setTimeout(r, 150));
}

async function getSettings() {
  const got = await chrome.storage.local.get(SETTINGS_KEY);
  return got[SETTINGS_KEY] || {};
}

async function startSession(targetTabId) {
  const settings = await getSettings();
  if (!settings.apiBase || !settings.apiKey || !settings.agentId) {
    throw new Error('Open the Talkr Coach popup and fill in API base, API key, and agent ID first.');
  }

  await ensureOffscreen();

  // 1. Create live_session row server-side
  const sessionRes = await fetch(`${settings.apiBase}/api/session?action=start`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${settings.apiKey}`,
      'x-agent-id': settings.agentId,
      'content-type': 'application/json',
    },
    body: JSON.stringify({}),
  });
  if (!sessionRes.ok) {
    const body = await sessionRes.text();
    throw new Error(`session start failed (${sessionRes.status}): ${body}`);
  }
  const { session_id } = await sessionRes.json();

  // 2. Mint Deepgram temp key
  const dgRes = await fetch(`${settings.apiBase}/api/deepgram-token`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${settings.apiKey}`,
      'content-type': 'application/json',
    },
    body: '{}',
  });
  if (!dgRes.ok) {
    const body = await dgRes.text();
    throw new Error(`deepgram-token failed (${dgRes.status}): ${body}`);
  }
  const { key: deepgramKey } = await dgRes.json();

  // 3. Mint tab MediaStream id (must come from the extension context)
  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId });

  // 4. Hand everything to offscreen
  const reply = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'START_SESSION',
    streamId,
    targetTabId,
    sessionId: session_id,
    deepgramKey,
    apiBase: settings.apiBase,
    apiKey: settings.apiKey,
  });
  if (!reply?.ok) throw new Error(reply?.error || 'offscreen returned no ok');

  await chrome.storage.session.set({
    [SESSION_KEY]: {
      status: 'recording',
      sessionId: session_id,
      tabId: targetTabId,
      startedAt: Date.now(),
      micGranted: !!reply.mic,
    },
  });
  return { ok: true, sessionId: session_id, mic: reply.mic };
}

async function stopSession() {
  if (!(await hasOffscreenDoc())) {
    return { ok: true, note: 'no offscreen doc' };
  }
  const reply = await chrome.runtime.sendMessage({ target: 'offscreen', type: 'STOP_SESSION' });
  const settings = await getSettings();
  const stored = await chrome.storage.session.get(SESSION_KEY);
  const sessionId = stored[SESSION_KEY]?.sessionId;
  await chrome.storage.session.remove(SESSION_KEY);
  await chrome.offscreen.closeDocument().catch(() => {});

  if (sessionId && settings.apiBase && settings.apiKey && settings.agentId) {
    await fetch(`${settings.apiBase}/api/session?action=end`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${settings.apiKey}`,
        'x-agent-id': settings.agentId,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ session_id: sessionId }),
    }).catch((err) => console.warn('[talkr] session end failed:', err));
  }
  return reply;
}

async function getState() {
  const got = await chrome.storage.session.get(SESSION_KEY);
  return got[SESSION_KEY] || null;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'sw') return false;

  switch (msg.type) {
    case 'POPUP_START':
    case 'CONTENT_START': {
      // Popup passes tabId; content script doesn't have it, so use sender.tab.id.
      const tabId = msg.tabId ?? sender?.tab?.id;
      if (!tabId) {
        sendResponse({ ok: false, error: 'no tab id (start from popup or smrtPhone tab)' });
        return true;
      }
      startSession(tabId)
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    }
    case 'POPUP_STOP':
    case 'CONTENT_STOP':
      stopSession()
        .then((r) => sendResponse({ ok: true, ...r }))
        .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
      return true;
    case 'POPUP_GET_STATE':
      getState().then((s) => sendResponse({ ok: true, state: s }));
      return true;
    case 'OVERLAY_ACTION':
      // Forward agent_action to most recent live_suggestions row
      (async () => {
        try {
          const settings = await getSettings();
          const stored = await chrome.storage.session.get(SESSION_KEY);
          const sessionId = stored[SESSION_KEY]?.sessionId;
          if (!sessionId || !settings.apiBase || !settings.apiKey) {
            sendResponse({ ok: false, error: 'no active session' });
            return;
          }
          // Lazy: fetch the most recent live_suggestion for this session and update.
          // For v0 we PATCH via a tiny endpoint; until then, console-log so we don't crash.
          console.log('[talkr] overlay action:', msg.action, 'session:', sessionId);
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: String(err?.message || err) });
        }
      })();
      return true;
  }
  return false;
});

// Keepalive: ping offscreen every 25s during a session so service worker
// doesn't terminate mid-call.
chrome.alarms.create('keepalive', { periodInMinutes: 0.4 });
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== 'keepalive') return;
  if (await hasOffscreenDoc()) {
    chrome.runtime.sendMessage({ target: 'offscreen', type: 'PING' }).catch(() => {});
  }
});
