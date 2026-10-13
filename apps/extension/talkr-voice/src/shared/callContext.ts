/**
 * The in-call context: who is on the line, what has happened with them, what
 * to say, and what to say back. One read of GET /v1/call-context per call.
 *
 * Cached in this module so tab switches, re-renders and the popup/side panel
 * pair never re-read it. Two keys point at the same call on purpose: an
 * inbound call rings with a number only and gains a platform call id when it
 * is accepted, and the rep should not watch the panel blank and reload
 * between those two moments.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError, api, type CallContextDto } from './api';

interface Entry {
  data: CallContextDto;
  at: number;
  /** Keyed by call id: valid for the life of the call. Phone keys go stale. */
  byCall: boolean;
}

const cache = new Map<string, Entry>();
/** A number's context can change between calls (a note, a status); re-read after this. */
const PHONE_TTL_MS = 60_000;
const MAX_ENTRIES = 40;

function read(key: string): CallContextDto | null {
  const e = cache.get(key);
  if (!e) return null;
  if (!e.byCall && Date.now() - e.at > PHONE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return e.data;
}

function write(key: string, data: CallContextDto, byCall: boolean): void {
  if (!cache.has(key) && cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, { data, at: Date.now(), byCall });
}

/** How a surface names the call it is showing. */
export function contextKey(callId: string | null, phone: string | null): string | null {
  if (callId) return `call:${callId}`;
  if (phone) return `phone:${phone}`;
  return null;
}

export interface UseCallContextOptions {
  /** The platform call id from the snapshot, once the server has one. */
  callId: string | null;
  /** The other party's number, E.164 — the fallback identity. */
  phone: string | null;
  enabled: boolean;
  /** Hold the read this long after the key settles: for a number being typed. */
  debounceMs?: number;
}

export interface CallContextState {
  context: CallContextDto | null;
  loading: boolean;
  error: string | null;
  /** Apply a local change (a PATCHed status, saved notes) without a re-read. */
  update: (patch: Partial<CallContextDto>) => void;
  /** Drop this call's entry and read again — after creating the contact. */
  refresh: () => void;
}

interface State {
  key: string | null;
  context: CallContextDto | null;
  loading: boolean;
  error: string | null;
}

/**
 * Prefer the call id: the server can attach the call's own lead and campaign
 * to it. Fall back to the number when there is no id yet (an inbound call
 * still ringing) or when the id read fails — a call the server has not
 * indexed yet still has a number, and a number beats an empty panel.
 */
async function fetchContext(callId: string | null, phone: string | null): Promise<CallContextDto> {
  if (callId) {
    try {
      return await api.getCallContext({ call_id: callId });
    } catch (err) {
      const recoverable = err instanceof ApiError && err.status !== 401 && err.status !== 403;
      if (!phone || !recoverable) throw err;
    }
  }
  if (!phone) throw new Error('no call to look up');
  return api.getCallContext({ phone });
}

export function useCallContext({ callId, phone, enabled, debounceMs = 0 }: UseCallContextOptions): CallContextState {
  const key = enabled ? contextKey(callId, phone) : null;
  const [state, setState] = useState<State>({ key: null, context: null, loading: false, error: null });
  const [generation, setGeneration] = useState(0);
  // The effect keys on `key` alone; these are read inside it.
  const ids = useRef({ callId, phone });
  ids.current = { callId, phone };

  useEffect(() => {
    if (!key) {
      setState({ key: null, context: null, loading: false, error: null });
      return;
    }
    const hit = read(key);
    if (hit) {
      setState({ key, context: hit, loading: false, error: null });
      return;
    }
    // Ringing-by-number becoming accepted-by-id: keep the number's entry on
    // screen while the id read runs, rather than flashing empty.
    const { callId: id, phone: number } = ids.current;
    const carried = number ? read(`phone:${number}`) : null;
    setState({ key, context: carried, loading: true, error: null });

    let alive = true;
    const timer = setTimeout(() => {
      fetchContext(id, number)
        .then((ctx) => {
          write(key, ctx, Boolean(id));
          if (ctx.phone_e164) write(`phone:${ctx.phone_e164}`, ctx, false);
          if (alive) setState({ key, context: ctx, loading: false, error: null });
        })
        .catch((err: Error) => {
          if (alive) setState((s) => ({ ...s, loading: false, error: err.message }));
        });
    }, debounceMs);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [key, debounceMs, generation]);

  const update = useCallback((patch: Partial<CallContextDto>) => {
    setState((s) => {
      if (!s.context || !s.key) return s;
      const next = { ...s.context, ...patch };
      write(s.key, next, s.key.startsWith('call:'));
      if (next.phone_e164) write(`phone:${next.phone_e164}`, next, false);
      return { ...s, context: next };
    });
  }, []);

  const refresh = useCallback(() => {
    const { callId: id, phone: number } = ids.current;
    const k = contextKey(id, number);
    if (k) cache.delete(k);
    if (number) cache.delete(`phone:${number}`);
    setGeneration((g) => g + 1);
  }, []);

  // Between a key change and the effect that follows it, `state` still
  // describes the previous call: never show one caller's notes under another
  // caller's name.
  const current = state.key === key;
  return {
    context: current ? state.context : null,
    loading: current ? state.loading : Boolean(key),
    error: current ? state.error : null,
    update,
    refresh,
  };
}

/**
 * Fill `{first_name}` / `{{first_name}}` fields from the map the server sent
 * with the context. Same token grammar as packages/core sequences. A field the
 * server did not send is left as written: this is a reader, not a validator.
 */
const MERGE_RE = /\{\{?\s*([a-zA-Z0-9_]+)\s*\}?\}/g;

export function renderMergeFields(body: string, fields: Record<string, string>): string {
  return body.replace(MERGE_RE, (match, name: string) =>
    Object.prototype.hasOwnProperty.call(fields, name) ? (fields[name] ?? '') : match,
  );
}
