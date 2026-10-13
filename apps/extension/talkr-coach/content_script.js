// Talkr Coach content script.
// Injected into smrtPhone web app pages. Two jobs:
//   1. Inject the overlay iframe into the page so suggestions render.
//   2. Detect when a smrtPhone call goes active and tell the service worker
//      to start a session.
//
// Call-active detection: a DOM mutation observer watches for class changes
// commonly used by smrtPhone's call panel. The exact selectors will need
// tuning once we verify against the real DOM in Spike A; for now we look
// for any element with class containing 'call-active' or a call-timer
// element appearing.

(function () {
  let overlayFrame = null;
  let lastCallActive = false;
  let stableSinceMs = 0;
  const STABLE_THRESHOLD_MS = 1500;       // require 1.5s of stable state before flipping

  function injectOverlay() {
    if (overlayFrame) return;
    overlayFrame = document.createElement('iframe');
    overlayFrame.id = 'talkr-coach-overlay';
    overlayFrame.src = chrome.runtime.getURL('overlay.html');
    overlayFrame.allow = 'autoplay';
    Object.assign(overlayFrame.style, {
      position: 'fixed',
      bottom: '24px',
      right: '24px',
      width: '380px',
      height: '220px',
      border: '0',
      'z-index': '2147483647',
      'border-radius': '10px',
      'box-shadow': '0 8px 32px rgba(0,0,0,0.45)',
      'background': 'transparent',
    });
    document.documentElement.appendChild(overlayFrame);
  }

  function isCallActive() {
    // Heuristics, tuned generically. Adjust once we confirm smrtPhone's actual DOM.
    if (document.querySelector('[class*="call-active"]')) return true;
    if (document.querySelector('[class*="ongoing-call"]')) return true;
    if (document.querySelector('[class*="active-call"]')) return true;
    if (document.querySelector('[data-call-state="active"]')) return true;
    // Timer pattern: a node showing MM:SS with a parent referencing 'call'
    const allNodes = document.querySelectorAll('div, span');
    for (const n of allNodes) {
      const text = n.textContent || '';
      if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(text.trim())) {
        const parent = n.closest('[class*="call"], [class*="dialer"], [class*="phone"]');
        if (parent) return true;
      }
    }
    return false;
  }

  async function getActiveTabId() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ target: 'sw', type: 'GET_TAB_ID' }, (r) => resolve(r?.tabId));
    });
  }

  async function tick() {
    const active = isCallActive();
    const now = Date.now();
    if (active !== lastCallActive) {
      stableSinceMs = now;
      lastCallActive = active;
    } else if (now - stableSinceMs > STABLE_THRESHOLD_MS) {
      // Stable state for >1.5s. Notify service worker if state changed since last notify.
      if (active && !window.__talkrSessionActive) {
        window.__talkrSessionActive = true;
        chrome.tabs?.query?.({ active: true, currentWindow: true }, (tabs) => {});
        const reply = await chrome.runtime.sendMessage({
          target: 'sw',
          type: 'CONTENT_START',
          // service worker calls chrome.tabs.query itself to find the source tab id;
          // we don't have access to chrome.tabs from a content script.
        }).catch(() => null);
        if (!reply?.ok) {
          console.warn('[talkr] auto-start failed:', reply?.error);
          window.__talkrSessionActive = false;
        }
      } else if (!active && window.__talkrSessionActive) {
        window.__talkrSessionActive = false;
        chrome.runtime.sendMessage({ target: 'sw', type: 'CONTENT_STOP' }).catch(() => {});
      }
    }
  }

  injectOverlay();

  // Poll every 1s. Lighter than a full-page MutationObserver, and good enough.
  setInterval(tick, 1000);

  console.log('[talkr] content script loaded on', location.origin);
})();
