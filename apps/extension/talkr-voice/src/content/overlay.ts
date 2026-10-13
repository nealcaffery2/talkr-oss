/**
 * The bits of Talkr that appear on somebody else's page.
 *
 * Two of them, and both are deliberately small: a toast that says what the
 * click did, and a button that offers to dial the number the rep has just
 * selected. Everything lives in a closed shadow root on a fixed-position host,
 * so no page stylesheet can restyle it and no page script can reach into it.
 * The host is only created when there is something to show.
 */

const HOST_ID = 'talkr-click-to-call-root';
const ACCENT = '#ff233b'; // Talkr Red — brand/README.md
const INK = '#111111';

let root: ShadowRoot | null = null;

/** The phone glyph, drawn small enough to sit on a line of body text. */
const PHONE_SVG = `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="currentColor"><path d="M6.6 10.8a15.1 15.1 0 0 0 6.6 6.6l2.2-2.2a1 1 0 0 1 1-.24c1.1.37 2.3.57 3.6.57a1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1c0 1.2.2 2.4.57 3.5a1 1 0 0 1-.25 1l-2.2 2.3Z"/></svg>`;

function ensureRoot(): ShadowRoot {
  if (root?.host.isConnected) return root;
  const host = document.createElement('div');
  host.id = HOST_ID;
  // The host must not participate in the page's layout at all; only the
  // children inside it are positioned, and they are fixed.
  host.style.cssText = 'all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;';
  (document.body ?? document.documentElement).appendChild(host);
  const shadow = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    :host, * { box-sizing: border-box; }
    .card {
      position: fixed;
      font: 600 13px/1.35 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #fff;
      background: ${INK};
      border-radius: 10px;
      padding: 10px 13px;
      box-shadow: 0 8px 28px -8px rgba(0,0,0,.5), 0 2px 6px rgba(0,0,0,.25);
      display: flex; align-items: center; gap: 8px;
      max-width: min(360px, calc(100vw - 32px));
      opacity: 0; transform: translateY(6px);
      transition: opacity .14s ease, transform .14s ease;
      pointer-events: auto;
    }
    .card.in { opacity: 1; transform: translateY(0); }
    .card.bad { background: #7f1d1d; }
    .mark { color: ${ACCENT}; display: inline-flex; flex: none; }
    .text { min-width: 0; overflow-wrap: anywhere; }
    .toast { right: 16px; bottom: 16px; }
    button.call {
      all: unset;
      position: fixed;
      cursor: pointer;
      font: 600 13px/1 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      color: #fff; background: ${ACCENT};
      border-radius: 999px; padding: 9px 14px;
      box-shadow: 0 6px 20px -6px rgba(255,35,59,.7), 0 1px 3px rgba(0,0,0,.3);
      display: inline-flex; align-items: center; gap: 7px;
      pointer-events: auto;
    }
    button.call:hover { background: #e6142e; }
    button.call:focus-visible { outline: 2px solid #fff; outline-offset: 2px; }
    @media (prefers-reduced-motion: reduce) {
      .card { transition: none; opacity: 1; transform: none; }
    }
  `;
  shadow.appendChild(style);
  root = shadow;
  return shadow;
}

let toastEl: HTMLElement | null = null;
let toastTimer: ReturnType<typeof setTimeout> | null = null;

/** One line, bottom-right, gone in a few seconds. Replaces any earlier one. */
export function toast(text: string, tone: 'ok' | 'bad' = 'ok'): void {
  const shadow = ensureRoot();
  if (toastTimer) clearTimeout(toastTimer);
  toastEl?.remove();
  const el = document.createElement('div');
  el.className = `card toast${tone === 'bad' ? ' bad' : ''}`;
  el.setAttribute('role', 'status');
  el.innerHTML = `<span class="mark">${PHONE_SVG}</span><span class="text"></span>`;
  // The message can come from a server; it is text, never markup.
  el.querySelector('.text')!.textContent = text;
  shadow.appendChild(el);
  toastEl = el;
  requestAnimationFrame(() => el.classList.add('in'));
  toastTimer = setTimeout(() => {
    el.classList.remove('in');
    setTimeout(() => el.remove(), 200);
    if (toastEl === el) toastEl = null;
  }, tone === 'bad' ? 6000 : 3200);
}

let selectionEl: HTMLElement | null = null;

/** Drop the floating "Call …" button, if one is up. */
export function hideSelectionButton(): void {
  selectionEl?.remove();
  selectionEl = null;
}

/**
 * Offer to dial `label` near a page rectangle. This is the fallback that makes
 * click-to-call work where rewriting text cannot reach: inside an `<input>`, a
 * canvas-drawn table, or a number the detector was too careful to mark up.
 */
export function showSelectionButton(rect: DOMRect, label: string, onCall: () => void): void {
  const shadow = ensureRoot();
  hideSelectionButton();
  const btn = document.createElement('button');
  btn.className = 'call';
  btn.type = 'button';
  btn.innerHTML = `${PHONE_SVG}<span class="text"></span>`;
  btn.querySelector('.text')!.textContent = `Call ${label}`;
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the selection
  btn.addEventListener('click', () => {
    hideSelectionButton();
    onCall();
  });
  shadow.appendChild(btn);
  selectionEl = btn;

  // Above the selection by preference, below it when there is no room, and
  // never off the side of the window.
  const { width, height } = btn.getBoundingClientRect();
  const gap = 8;
  const top = rect.top - height - gap >= 0 ? rect.top - height - gap : rect.bottom + gap;
  const left = Math.min(Math.max(8, rect.left + rect.width / 2 - width / 2), window.innerWidth - width - 8);
  btn.style.top = `${Math.round(top)}px`;
  btn.style.left = `${Math.round(left)}px`;
}

/** Torn down when click-to-call is switched off for this site. */
export function destroyOverlay(): void {
  hideSelectionButton();
  toastEl?.remove();
  toastEl = null;
  root?.host.remove();
  root = null;
}
