/**
 * Subscribe a UI surface to the call living in the offscreen document.
 *
 * Both the popup and the side panel use this, and both may be open at once —
 * they stay in step because neither holds call state of its own, they only
 * render the snapshot the offscreen document broadcasts.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  COMMAND_TARGET,
  EMPTY_SNAPSHOT,
  envelope,
  type CallSnapshot,
  type Command,
} from './messages';

export async function send(command: Command): Promise<CallSnapshot | null> {
  // The worker may have been evicted; make sure the call's home exists before
  // addressing it.
  await chrome.runtime.sendMessage({ type: 'ensureOffscreen' }).catch(() => undefined);
  try {
    const res = (await chrome.runtime.sendMessage(envelope(command, COMMAND_TARGET))) as
      | { snapshot: CallSnapshot }
      | undefined;
    return res?.snapshot ?? null;
  } catch {
    // Nothing listening yet (the document is still booting). The next
    // broadcast will bring us up to date.
    return null;
  }
}

export function useCall() {
  const [snapshot, setSnapshot] = useState<CallSnapshot>(EMPTY_SNAPSHOT);

  useEffect(() => {
    const onMessage = (message: unknown) => {
      const m = message as { type?: string; snapshot?: CallSnapshot };
      if (m?.type === 'snapshot' && m.snapshot) setSnapshot(m.snapshot);
    };
    chrome.runtime.onMessage.addListener(onMessage);
    // Paint from the real state as soon as the surface opens.
    void send({ type: 'getSnapshot' }).then((s) => s && setSnapshot(s));
    return () => chrome.runtime.onMessage.removeListener(onMessage);
  }, []);

  const dispatch = useCallback(async (command: Command) => {
    const next = await send(command);
    if (next) setSnapshot(next);
  }, []);

  return { snapshot, dispatch };
}
