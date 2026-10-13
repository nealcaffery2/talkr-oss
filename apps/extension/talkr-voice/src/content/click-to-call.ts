/**
 * Click-to-call, on any page.
 *
 * A rep works a list in whatever the seller's county put on the web. Talkr is
 * only useful there if the number in front of them is the thing they press, so
 * this script makes every phone number on every page dialable and gets out of
 * the way. It reaches a number four ways, cheapest first:
 *
 *  1. **`tel:` links** are intercepted where they are. The page has already
 *     told us it is a phone number, so nothing is rewritten and nothing can
 *     break — we just stop the browser handing the call to some other app.
 *  2. **Numbers in text** are wrapped in a span the rep can click. This is the
 *     only part that touches the page, so it is the part that is careful: see
 *     `phone-numbers.ts` for what counts as a number, and `SKIP` below for
 *     where we will not look at all.
 *  3. **A selection** anywhere — including inside an `<input>`, a `<textarea>`
 *     or a table the page drew itself — offers a floating Call button. This is
 *     what covers everything rewriting cannot reach.
 *  4. **The right-click menu**, handled in the service worker.
 *
 * Two rules keep this from being the extension that ruins the web. Editable
 * content is never rewritten, because rewriting what someone is typing into
 * loses their caret. And the page's own click handlers keep working: the
 * wrapper is a span, not a link, and a click inside an existing anchor is left
 * to the anchor.
 */

import { DIAL_REQUEST, refusalSentence, type DialRequest, type DialResult } from '@/shared/dial';
import { findPhoneNumbers, formatE164, telHrefToE164 } from './phone-numbers';
import { hideSelectionButton, showSelectionButton, toast, destroyOverlay } from './overlay';

const WRAPPER_CLASS = 'talkr-ctc-number';
const E164_ATTR = 'data-talkr-e164';
const STYLE_ID = 'talkr-ctc-style';

/** Storage keys, shared with the popup's site toggle. */
const STORAGE = { enabled: 'talkr_ctc_enabled', offHosts: 'talkr_ctc_off_hosts' } as const;

/**
 * Where a phone number is never a phone number worth marking up. Editable
 * regions are the important ones — rewriting a field someone is typing in
 * destroys their caret and their undo stack — and the rest are places where
 * digits mean something else, or where markup does not survive.
 */
const SKIP = new Set([
  'SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'IFRAME', 'OBJECT', 'EMBED',
  'CANVAS', 'SVG', 'MATH', 'INPUT', 'TEXTAREA', 'SELECT', 'OPTION', 'BUTTON',
  'CODE', 'PRE', 'KBD', 'SAMP', 'TIME', 'A',
]);

/** Pages we must not decorate: our own, and anything already ours. */
function isOurs(node: Node): boolean {
  const el = node instanceof Element ? node : node.parentElement;
  return Boolean(el?.closest(`.${WRAPPER_CLASS}, #talkr-click-to-call-root`));
}

function shouldSkipElement(el: Element): boolean {
  if (SKIP.has(el.tagName)) return true;
  if ((el as HTMLElement).isContentEditable) return true;
  // A page that hid it does not want it read, and a rep cannot click it.
  return el.getAttribute('aria-hidden') === 'true';
}

// ── Dialing ────────────────────────────────────────────────────────────────

let dialing = false;

async function dial(e164: string, source: DialRequest['source']): Promise<void> {
  if (dialing) return;
  dialing = true;
  toast(`Calling ${formatE164(e164)}…`);
  try {
    const result = (await chrome.runtime.sendMessage({
      type: DIAL_REQUEST,
      e164,
      source,
    } satisfies DialRequest)) as DialResult | undefined;
    if (!result) return; // the worker answers through 'talkr.dial.result' too
    if (result.ok) {
      if (result.message) toast(result.message);
    } else {
      toast(refusalSentence(result), 'bad');
    }
  } catch {
    // The worker was evicted mid-message, or the extension was reloaded from
    // under this page. Either way the call did not happen; say so.
    toast('Talkr is not running — reload the page and try again.', 'bad');
  } finally {
    dialing = false;
  }
}

// ── 1. tel: links ──────────────────────────────────────────────────────────

function onDocumentClick(event: MouseEvent): void {
  if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey) return;
  const target = event.target;
  if (!(target instanceof Node)) return;
  const el = target instanceof Element ? target : target.parentElement;
  if (!el) return;

  const wrapper = el.closest(`.${WRAPPER_CLASS}`);
  if (wrapper) {
    const e164 = wrapper.getAttribute(E164_ATTR);
    if (e164) {
      event.preventDefault();
      event.stopPropagation();
      void dial(e164, 'text');
    }
    return;
  }

  const link = el.closest('a[href^="tel:"], a[href^="TEL:"]');
  if (link) {
    const e164 = telHrefToE164(link.getAttribute('href') ?? '');
    if (e164) {
      // Without this the OS hands the call to FaceTime, Skype, or nothing.
      event.preventDefault();
      event.stopPropagation();
      void dial(e164, 'link');
    }
  }
}

function onKeyActivate(event: KeyboardEvent): void {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  const el = event.target instanceof Element ? event.target : null;
  const wrapper = el?.closest(`.${WRAPPER_CLASS}`);
  const e164 = wrapper?.getAttribute(E164_ATTR);
  if (!e164) return;
  event.preventDefault();
  void dial(e164, 'text');
}

// ── 2. Numbers in text ─────────────────────────────────────────────────────

/** A ceiling so a pathological page cannot be made slow by us. */
const MAX_WRAPS = 1500;
let wrapped = 0;

function injectStyle(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  // Inherits everything from the surrounding text on purpose: the number must
  // keep its own font, size and colour, or a page's design is wrecked by a
  // feature nobody asked to see. Only the affordance is ours.
  style.textContent = `
    .${WRAPPER_CLASS} {
      cursor: pointer;
      text-decoration: underline dotted currentColor;
      text-underline-offset: 2px;
      border-radius: 3px;
    }
    .${WRAPPER_CLASS}:hover,
    .${WRAPPER_CLASS}:focus-visible {
      background: rgba(255, 35, 59, 0.12);
      box-shadow: 0 0 0 1px rgba(255, 35, 59, 0.45);
      outline: none;
      text-decoration: none;
    }
  `;
  (document.head ?? document.documentElement).appendChild(style);
}

/** Replace one text node with the runs around its numbers, plus the wrappers. */
function wrapTextNode(node: Text): void {
  const text = node.nodeValue ?? '';
  const matches = findPhoneNumbers(text);
  if (matches.length === 0) return;

  const frag = document.createDocumentFragment();
  let cursor = 0;
  for (const match of matches) {
    if (wrapped >= MAX_WRAPS) break;
    if (match.index > cursor) frag.appendChild(document.createTextNode(text.slice(cursor, match.index)));
    const span = document.createElement('span');
    span.className = WRAPPER_CLASS;
    span.setAttribute(E164_ATTR, match.e164);
    span.setAttribute('role', 'button');
    span.setAttribute('tabindex', '0');
    span.title = `Call ${formatE164(match.e164)} with Talkr`;
    span.textContent = match.text;
    frag.appendChild(span);
    cursor = match.index + match.text.length;
    wrapped += 1;
  }
  if (cursor === 0) return;
  if (cursor < text.length) frag.appendChild(document.createTextNode(text.slice(cursor)));
  node.parentNode?.replaceChild(frag, node);
}

/**
 * Collect the text nodes worth looking at under `root`. Collected first and
 * rewritten afterwards, because replacing a node while the walker is standing
 * on it is how a tree walk starts skipping siblings.
 */
function collectTextNodes(root: Node, budget: number): Text[] {
  const out: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const value = node.nodeValue;
      if (!value || value.length < 7 || !/\d/.test(value)) return NodeFilter.FILTER_REJECT;
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      for (let el: Element | null = parent; el; el = el.parentElement) {
        if (shouldSkipElement(el)) return NodeFilter.FILTER_REJECT;
        if (el.classList.contains(WRAPPER_CLASS) || el.id === 'talkr-click-to-call-root') {
          return NodeFilter.FILTER_REJECT;
        }
      }
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  while (out.length < budget && walker.nextNode()) out.push(walker.currentNode as Text);
  return out;
}

function scan(root: Node): void {
  if (wrapped >= MAX_WRAPS) return;
  if (isOurs(root)) return;
  for (const node of collectTextNodes(root, MAX_WRAPS - wrapped)) {
    if (!node.isConnected) continue;
    wrapTextNode(node);
  }
}

/**
 * Pages are not static any more: a CRM renders its table after the fact and an
 * infinite list keeps adding rows. Rescan what arrives, but on the idle
 * callback and in one batch, so a page that mutates constantly costs one pass
 * rather than one pass per mutation.
 */
function watch(): MutationObserver {
  let queued: Node[] = [];
  let scheduled = false;
  const flush = () => {
    scheduled = false;
    const batch = queued;
    queued = [];
    for (const node of batch) {
      if (node.isConnected) scan(node);
    }
  };
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      for (const node of record.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE || node.nodeType === Node.TEXT_NODE) {
          if (!isOurs(node)) queued.push(node);
        }
      }
    }
    if (queued.length === 0 || scheduled) return;
    scheduled = true;
    const idle = (window as Window & { requestIdleCallback?: typeof requestIdleCallback })
      .requestIdleCallback;
    if (idle) idle(flush, { timeout: 500 });
    else setTimeout(flush, 200);
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  return observer;
}

// ── 3. Selection ───────────────────────────────────────────────────────────

/**
 * Whatever the rep just highlighted, if exactly one number is in it. A field
 * has its own selection API — `window.getSelection()` says nothing about the
 * inside of an `<input>` — so both are read.
 */
function selectedNumber(): { e164: string; rect: DOMRect } | null {
  const active = document.activeElement;
  if (
    (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) &&
    active.selectionStart !== null &&
    active.selectionEnd !== null &&
    active.selectionEnd > active.selectionStart
  ) {
    const text = active.value.slice(active.selectionStart, active.selectionEnd);
    const match = findPhoneNumbers(text)[0];
    return match ? { e164: match.e164, rect: active.getBoundingClientRect() } : null;
  }
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const text = selection.toString();
  if (text.length > 120) return null;
  const match = findPhoneNumbers(text)[0];
  if (!match) return null;
  const rect = selection.getRangeAt(0).getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;
  return { e164: match.e164, rect };
}

function onSelectionSettled(): void {
  const found = selectedNumber();
  if (!found) {
    hideSelectionButton();
    return;
  }
  showSelectionButton(found.rect, formatE164(found.e164), () => void dial(found.e164, 'selection'));
}

// ── Enablement ─────────────────────────────────────────────────────────────

async function isEnabledHere(): Promise<boolean> {
  try {
    const stored = await chrome.storage.local.get([STORAGE.enabled, STORAGE.offHosts]);
    if ((stored[STORAGE.enabled] as boolean | undefined) === false) return false;
    const off = (stored[STORAGE.offHosts] as string[] | undefined) ?? [];
    return !off.includes(location.hostname);
  } catch {
    // No storage means no extension context; do nothing rather than guess.
    return false;
  }
}

// ── Install ────────────────────────────────────────────────────────────────

let teardown: (() => void) | null = null;

function start(): void {
  if (teardown) return;
  injectStyle();
  scan(document.body ?? document.documentElement);
  const observer = watch();
  // Capture phase: a page that stops click propagation on its own row must not
  // also stop the rep dialling the number inside it.
  document.addEventListener('click', onDocumentClick, true);
  document.addEventListener('keydown', onKeyActivate, true);
  document.addEventListener('mouseup', onSelectionSettled);
  document.addEventListener('selectionchange', onSelectionMaybeGone);
  window.addEventListener('scroll', hideSelectionButton, { passive: true });
  teardown = () => {
    observer.disconnect();
    document.removeEventListener('click', onDocumentClick, true);
    document.removeEventListener('keydown', onKeyActivate, true);
    document.removeEventListener('mouseup', onSelectionSettled);
    document.removeEventListener('selectionchange', onSelectionMaybeGone);
    window.removeEventListener('scroll', hideSelectionButton);
    document.getElementById(STYLE_ID)?.remove();
    unwrapAll();
    destroyOverlay();
  };
}

function onSelectionMaybeGone(): void {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed) hideSelectionButton();
}

/** Put the page back exactly as it was, for a rep who switches us off. */
function unwrapAll(): void {
  for (const span of [...document.querySelectorAll(`.${WRAPPER_CLASS}`)]) {
    span.replaceWith(document.createTextNode(span.textContent ?? ''));
  }
  wrapped = 0;
}

function stop(): void {
  teardown?.();
  teardown = null;
}

export function installClickToCall(): void {
  void isEnabledHere().then((on) => {
    if (on) start();
  });

  // The toolbar's per-site toggle takes effect without a reload.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local') return;
    if (!(STORAGE.enabled in changes) && !(STORAGE.offHosts in changes)) return;
    void isEnabledHere().then((on) => (on ? start() : stop()));
  });

  // The worker answers a context-menu dial here, because that click happened
  // in the menu rather than in the page.
  chrome.runtime.onMessage.addListener((message) => {
    const m = message as { type?: string; result?: DialResult };
    if (m?.type !== 'talkr.dial.result' || !m.result) return;
    if (m.result.ok) {
      if (m.result.message) toast(m.result.message);
    } else {
      toast(refusalSentence(m.result), 'bad');
    }
  });
}
