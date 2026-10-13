// Spike A service worker.
// Bridges the popup (which holds the user gesture) and the offscreen document
// (which actually captures and encodes audio). MV3 service workers cannot hold
// MediaStreams, so the offscreen document is mandatory.
//
// All cross-context messages use a `target` field for routing:
//   target: 'sw'       -> handled here
//   target: 'offscreen'-> handled in offscreen.js
// This avoids the listener-collision bugs that plagued v0.1.

const OFFSCREEN_PATH = 'offscreen.html';
const STATE_KEY = 'talkrSpikeSession';

async function hasOffscreenDoc() {
  // Authoritative MV3 way to check for an existing offscreen document.
  // chrome.offscreen.hasDocument is unreliable / unavailable in older Chrome.
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDoc()) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_PATH,
    reasons: ['USER_MEDIA'],
    justification: 'Capture tab and microphone audio for diarization spike.',
  });
  // createDocument resolves before the document's scripts finish parsing.
  // A short wait avoids "no listener" errors on the first sendMessage.
  await new Promise((r) => setTimeout(r, 150));
}

async function startCapture(targetTabId) {
  await ensureOffscreenDocument();

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId });

  const reply = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'START_CAPTURE',
    streamId,
    targetTabId,
  });

  if (!reply?.ok) {
    throw new Error(reply?.error || 'offscreen returned no ok flag');
  }

  await chrome.storage.session.set({
    [STATE_KEY]: {
      status: 'recording',
      startedAt: Date.now(),
      tabId: targetTabId,
      micGranted: !!reply.mic,
    },
  });
  return reply;
}

async function stopCapture() {
  if (!(await hasOffscreenDoc())) {
    throw new Error('No active capture (offscreen document missing).');
  }
  const reply = await chrome.runtime.sendMessage({
    target: 'offscreen',
    type: 'STOP_CAPTURE',
  });
  await chrome.storage.session.remove(STATE_KEY);
  // Free the offscreen document. We re-create it on next start.
  await chrome.offscreen.closeDocument().catch(() => {});
  return reply;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.target !== 'sw') return false;

  if (msg.type === 'POPUP_START') {
    startCapture(msg.tabId)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg.type === 'POPUP_STOP') {
    stopCapture()
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((err) => sendResponse({ ok: false, error: String(err?.message || err) }));
    return true;
  }
  if (msg.type === 'POPUP_GET_STATE') {
    chrome.storage.session.get(STATE_KEY).then((s) => {
      sendResponse({ ok: true, state: s[STATE_KEY] || null });
    });
    return true;
  }
  return false;
});
