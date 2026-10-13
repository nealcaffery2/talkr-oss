/**
 * The content script, injected into every page.
 *
 * Two features share one injection because two would cost every page a second
 * script for no reason: click-to-call, which is the point, and the CLOZR
 * bridge, which does nothing at all unless the page says it is CLOZR.
 *
 * Injected at `document_idle` into all frames. A frame that is not a document
 * — a PDF viewer, a sandboxed frame with no DOM — is left alone.
 */

import { installClickToCall } from './click-to-call';
import { installClozrBridge } from './clozr-bridge';

declare global {
  interface Window {
    __talkrContentInstalled?: true;
  }
}

function install(): void {
  // A page can be injected twice — an extension reload, a same-document
  // navigation Chrome treats as new — and two observers would wrap everything
  // twice over.
  if (window.__talkrContentInstalled) return;
  window.__talkrContentInstalled = true;
  if (!document.documentElement) return;
  installClickToCall();
  installClozrBridge();
}

install();
