/**
 * Talkr's live event stream, held by the offscreen document.
 *
 * The popup and side panel come and go; the offscreen document stays, so it
 * keeps the one EventSource open (GET /v1/events/stream, the same stream
 * CLOZR reads) and turns what arrives into three things:
 *
 * - `onTick`: something in the rep's inbox, calls or voicemail moved, so an
 *   open popup re-reads its lists instead of waiting for the next call to end.
 * - a `talkr.notify` to the service worker for a new text or voicemail that is
 *   the rep's own (offscreen documents cannot raise notifications themselves).
 * - a `talkr.badge` with the rep's unread thread count, for the toolbar icon.
 *
 * Talkr's text events name only the thread (`{ conversationId, messageId }`),
 * not a rep, and an admin's stream carries the whole org's. So a text is
 * announced only when re-reading the rep's own threads (shared/owner.ts) finds
 * it there with an inbound last message.
 */

import { api, type ConversationDto, type MeDto } from '@/shared/api';
import { session } from '@/shared/session';
import { formatPhone } from '@/shared/time';
import { callOwner, lineOwners } from '@/shared/owner';

/** The bus events that can change what the popup lists. */
const LIST_EVENTS = [
  'message.received',
  'message.updated',
  'conversation.updated',
  'call.initiated',
  'call.updated',
  'call.wrapup',
  'voicemail.left',
] as const;

export interface LiveNotice {
  type: 'talkr.notify';
  kind: 'text' | 'voicemail';
  /** Stable per thread or call, so a repeat replaces rather than stacks. */
  key: string;
  title: string;
  body: string;
  e164: string | null;
}

export interface LiveBadge {
  type: 'talkr.badge';
  count: number;
}

interface BusEvent {
  type: string;
  userId?: string;
  callId?: string;
  data?: { conversationId?: string; messageId?: string };
}

let source: EventSource | null = null;
let retry: ReturnType<typeof setTimeout> | null = null;
let tickTimer: ReturnType<typeof setTimeout> | null = null;
let stopped = true;
let me: MeDto | null = null;
let onTick: () => void = () => undefined;
/** Messages already announced, so a replayed event never notifies twice. */
const announced = new Set<string>();

function send(message: LiveNotice | LiveBadge): void {
  chrome.runtime.sendMessage(message).catch(() => undefined);
}

function tickSoon(): void {
  if (tickTimer) return;
  tickTimer = setTimeout(() => {
    tickTimer = null;
    onTick();
  }, 400);
}

async function ownThreads(): Promise<ConversationDto[] | null> {
  if (!me) return null;
  try {
    const threads = await api.listMyConversations(me);
    send({ type: 'talkr.badge', count: threads.filter((c) => c.unread_count > 0).length });
    return threads;
  } catch {
    return null;
  }
}

async function onText(e: BusEvent): Promise<void> {
  const id = e.data?.conversationId;
  const messageId = e.data?.messageId;
  if (!id || !messageId || announced.has(messageId)) return;
  const threads = await ownThreads();
  const thread = threads?.find((c) => c.id === id);
  if (!thread || thread.last_message?.direction !== 'inbound') return;
  announced.add(messageId);
  const who = thread.contact_name ?? formatPhone(thread.their_number);
  const body = thread.last_message.body || (thread.last_message.media_count ? 'Picture message' : 'New text');
  send({ type: 'talkr.notify', kind: 'text', key: `text:${id}`, title: who, body, e164: thread.their_number });
}

async function onVoicemail(e: BusEvent): Promise<void> {
  // The server names who the voicemail is for when its flow knew
  // (raw.voicemailFor); an admin also hears about everyone else's, which are
  // not theirs to be alerted to. The plain no-answer path names nobody, so
  // then the call decides: the rep's if they handled it or it rang their line.
  if (!me || !e.callId || announced.has(e.callId)) return;
  if (e.userId && e.userId !== me.id) return;
  let from: string | null = null;
  try {
    const { call } = await api.getCall(e.callId);
    if (!e.userId) {
      const owner = callOwner(call, lineOwners(me));
      if (owner !== me.id) return;
    }
    from = call.from_number;
  } catch {
    // Unreadable: announce only one the server said was ours.
    if (!e.userId) return;
  }
  announced.add(e.callId);
  const name = from ? ((await api.lookupPhone(from).catch(() => null))?.contact?.display_name ?? null) : null;
  send({
    type: 'talkr.notify',
    kind: 'voicemail',
    key: `voicemail:${e.callId}`,
    title: 'New voicemail',
    body: name ?? (from ? formatPhone(from) : 'Someone left you a voicemail'),
    e164: from,
  });
}

function handle(type: string, raw: string): void {
  let e: BusEvent;
  try {
    e = { ...(JSON.parse(raw) as BusEvent), type };
  } catch {
    return;
  }
  tickSoon();
  if (type === 'message.received') void onText(e);
  else if (type === 'voicemail.left') void onVoicemail(e);
  else if (type === 'message.updated' || type === 'conversation.updated') void ownThreads();
}

async function open(): Promise<void> {
  if (stopped) return;
  close();
  // A fresh token each time: EventSource reconnects with the URL it was opened
  // with, and the token in it expires, so a reconnect goes through here.
  const s = await session.get().catch(() => null);
  if (!s || stopped) return;
  const apiUrl = await session.apiUrl().catch(() => null);
  if (!apiUrl || stopped) return;
  if (!me) me = await api.getMe().catch(() => null);
  void ownThreads();
  const es = new EventSource(`${apiUrl}/v1/events/stream?access_token=${encodeURIComponent(s.accessToken)}`);
  source = es;
  for (const type of LIST_EVENTS) {
    es.addEventListener(type, (ev) => handle(type, (ev as MessageEvent<string>).data));
  }
  es.onerror = () => {
    // Let EventSource's own retry handle a blip; a closed stream (401 on an
    // expired token, the server restarting) is reopened with a new token.
    if (es.readyState !== EventSource.CLOSED) return;
    scheduleReopen();
  };
}

function scheduleReopen(): void {
  if (retry || stopped) return;
  retry = setTimeout(() => {
    retry = null;
    void open();
  }, 5_000);
}

function close(): void {
  source?.close();
  source = null;
}

/** Start (or restart, after a sign-in) the stream. */
export function startLive(tick: () => void): void {
  onTick = tick;
  stopped = false;
  me = null;
  void open();
}

/** Stop on sign-out, and clear the badge so a shared machine shows nothing. */
export function stopLive(): void {
  stopped = true;
  if (retry) clearTimeout(retry);
  retry = null;
  close();
  me = null;
  announced.clear();
  send({ type: 'talkr.badge', count: 0 });
}

/** Re-read unread counts now (after the popup marks a thread read). */
export function refreshBadge(): void {
  void ownThreads();
}
