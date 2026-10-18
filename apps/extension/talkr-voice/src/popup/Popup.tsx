/**
 * Extension popup — 400×600, laid out like the iPhone Phone app.
 *
 * A bottom tab bar: Inbox (texts and calls, CLOZR's inbox minus email, with
 * the iPhone-style thread), Recents, Keypad (dialpad → ringing → active call
 * layout A) and Voicemail. Any row pushes the Lead screen (context, the
 * safe-to-call window, Open in CLOZR). The popup renders the offscreen
 * document's snapshot; closing it never touches the call.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Icon, HangupIcon, type IconName } from '@/shared/Icon';
import { Avatar, Button, Chip, ControlTile, Eyebrow, StatusMarker } from '@/shared/ui';
import { AudioSheet } from '@/shared/AudioSheet';
import { useCall } from '@/shared/useCall';
import { useSession } from '@/shared/useSession';
import { useCallContext } from '@/shared/callContext';
import { TEMP_LABEL, TemperatureBadge, TempDot, oneLineAddress } from '@/shared/contacts';
import { Account, SignIn } from './Account';
import { CallerIdSheet, InboxList, RecentsList, VoicemailList, callerIdLabel, isMissed } from './Lists';
import { CLOZR_BRIDGE } from '@/shared/clozr';
import { ownCalls } from '@/shared/owner';
import { PRESENCE_OPTIONS, setPresence } from '@/shared/presence';
import { fromLineOptions, lineLabel, replyLine, threadLineId } from '@/shared/lines';
import {
  api,
  type ActivityEventDto,
  type CallContextDto,
  type ConversationDto,
  type HistoryItemDto,
  type LeadActivityDto,
  type MeDto,
  type MessageDto,
  type MessageTemplateDto,
  type PhoneLookupDto,
  type TeamMemberDto,
} from '@/shared/api';
import {
  callWindow,
  duration,
  formatPhone,
  localZone,
  stamp,
  toE164,
  tzAbbr,
  tzTime,
  zoneForNumber,
} from '@/shared/time';

/** The four in the bottom bar, plus the lead screen they push. */
type Tab = 'inbox' | 'recents' | 'dial' | 'voicemail' | 'lead';

/** Show this number's record in CLOZR; the worker finds or opens the tab. */
function openInClozr(e164: string): void {
  void chrome.runtime.sendMessage({ type: CLOZR_BRIDGE.openRecord, e164 }).catch(() => undefined);
}

/**
 * What the keypad keeps of a typed, pasted or tapped number: digits, and a
 * leading +. CLOZR's dialDigits, so both dialers read input the same way.
 */
function dialDigits(raw: string): string {
  const t = raw.trim();
  const plus = t.startsWith('+');
  return ((plus ? '+' : '') + t.replace(/\D/g, '')).slice(0, plus ? 16 : 11);
}

/** Grouped for a North American number, as typed otherwise (CLOZR's `shown`). */
function shownDigits(d: string): string {
  return d.startsWith('+') ? d : formatPhone(d);
}

const KEYS: Array<[string, string]> = [
  ['1', ''], ['2', 'ABC'], ['3', 'DEF'],
  ['4', 'GHI'], ['5', 'JKL'], ['6', 'MNO'],
  ['7', 'PQRS'], ['8', 'TUV'], ['9', 'WXYZ'],
  ['*', ''], ['0', '+'], ['#', ''],
];

/** What the header calls each softphone state. Raw enum names are not copy. */
const DEVICE_STATUS: Record<string, string> = {
  ready: 'Available',
  initializing: 'Connecting',
  uninitialized: 'Softphone off',
  error: 'Softphone off',
};

const HEADER_BTN: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: 30,
  height: 30,
  borderRadius: 9,
  border: '1px solid var(--line)',
  background: 'var(--panel)',
  color: 'var(--muted)',
};

/**
 * Who sent an outbound run and from which line ("You · (512) 555-0101"), over
 * its first bubble. A teammate can text from a shared thread, so "outbound"
 * alone does not say it was you. Repeated only when the sender or line changes.
 */
function senderLine(m: MessageDto, prev: MessageDto | undefined, me: MeDto | null, team: TeamMemberDto[]): string | null {
  if (m.from_number === undefined && m.created_by === undefined) return null; // an older server
  const same =
    prev &&
    prev.direction === 'outbound' &&
    prev.created_by === m.created_by &&
    prev.from_number === m.from_number &&
    prev.is_auto_reply === m.is_auto_reply;
  if (same) return null;
  const who = m.is_auto_reply
    ? 'Auto-reply'
    : !m.created_by
      ? null
      : m.created_by === me?.id
        ? 'You'
        : (team.find((t) => t.id === m.created_by)?.display_name ?? 'A teammate');
  const line = m.from_number ? formatPhone(m.from_number) : null;
  const text = [who, line].filter(Boolean).join(' · ');
  return text || null;
}

/** How long "Sending…" may sit before it is called what it is: unconfirmed. */
const UNCONFIRMED_AFTER_MS = 10 * 60_000;

/** "Delivered 9:44 AM" under the last bubble of a run, the way the design stamps it. */
function deliveryStamp(m: MessageDto, now: number): string {
  if ((m.status === 'queued' || m.status === 'sending') && now - Date.parse(m.created_at) > UNCONFIRMED_AFTER_MS) {
    return `Not confirmed ${stamp(m.created_at, now)}`;
  }
  if (m.status === 'failed' || m.status === 'undelivered') {
    return `Not delivered${m.error_code ? ` (${m.error_code})` : ''} ${stamp(m.created_at, now)}`;
  }
  const label = m.status.charAt(0).toUpperCase() + m.status.slice(1);
  return `${label} ${stamp(m.delivered_at ?? m.sent_at ?? m.created_at, now)}`;
}

/** The attachment's own name, which says more than "1 image". */
function fileName(url: string): string {
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop() ?? '';
    return decodeURIComponent(last) || 'image';
  } catch {
    return url.split('/').filter(Boolean).pop() ?? 'image';
  }
}

/** "follow_up" → "Follow up", for a chip. */
function humanize(value: string): string {
  const s = value.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function activityIcon(e: ActivityEventDto): IconName {
  if (e.kind === 'call') return e.meta.voicemail_left ? 'voicemail' : 'phone';
  if (e.kind === 'message') return e.meta.media_count ? 'image' : 'msg';
  if (e.kind === 'task') return 'check';
  return 'clock';
}

function activityColor(e: ActivityEventDto): string {
  if (e.kind === 'call') {
    if (e.meta.voicemail_left) return 'var(--amber)';
    return e.meta.duration_seconds ? 'var(--green)' : 'var(--red)';
  }
  if (e.kind === 'message') return 'var(--accent)';
  if (e.kind === 'task') return 'var(--amber)';
  return 'var(--muted-2)';
}

/** One line per row: what happened and how long it took, not the raw status. */
function activityTitle(e: ActivityEventDto): string {
  if (e.kind === 'call') {
    const dir = e.meta.direction === 'inbound' ? 'Inbound' : 'Outbound';
    if (e.meta.voicemail_left) return 'Voicemail left';
    const secs = typeof e.meta.duration_seconds === 'number' ? e.meta.duration_seconds : 0;
    if (secs > 0) return `${dir} call · ${duration(secs)}`;
    if (e.meta.status === 'no_answer' || e.meta.status === 'busy') return `${dir} call · ${humanize(String(e.meta.status)).toLowerCase()}`;
    return e.title;
  }
  if (e.kind === 'message' && e.meta.media_count) {
    return e.meta.direction === 'inbound' ? 'Photo received' : 'Photo sent';
  }
  return e.title;
}

function activityDetail(e: ActivityEventDto): string | null {
  if (e.kind === 'call') {
    if (e.detail) return e.detail;
    if (typeof e.meta.disposition === 'string' && e.meta.disposition) return e.meta.disposition;
    return null;
  }
  return e.detail;
}

/** Bring the side panel up beside the CRM. Needs a user gesture, so only ever from a click. */
function openSidePanel(): void {
  void chrome.windows.getCurrent().then((w) => {
    if (w.id != null) void chrome.sidePanel.open({ windowId: w.id });
  });
}

/**
 * One line of who this is — name · address · temperature — over the dark
 * call surface, with a way to the side panel, where the full lead, the
 * script and the rebuttals live. Same fetch as the panel, so the two agree.
 */
function ContextStrip({
  ctx,
  loading,
  panelOpen,
}: {
  ctx: CallContextDto | null;
  loading: boolean;
  panelOpen: boolean;
}) {
  const contact = ctx?.contact ?? null;
  const address = oneLineAddress(contact?.address) || oneLineAddress(ctx?.property);
  const parts = contact
    ? [contact.display_name, address || null, TEMP_LABEL[contact.temperature]].filter((p): p is string => Boolean(p))
    : ctx
      ? ['Unknown number', address || null].filter((p): p is string => Boolean(p))
      : [loading ? 'Looking up…' : ''];
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        margin: '0 16px 10px',
        padding: '7px 10px',
        borderRadius: 10,
        border: '1px solid var(--dark-2)',
        background: 'rgba(255,255,255,.04)',
        minWidth: 0,
      }}
    >
      {contact ? (
        <TempDot temperature={contact.temperature} size={7} />
      ) : (
        <Icon name="user" size={12} style={{ color: 'var(--muted)', flexShrink: 0 }} />
      )}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          font: '500 11px/1.3 Inter',
          color: '#e4e4e7',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
        }}
        title={parts.join(' · ')}
      >
        {parts.join(' · ')}
      </span>
      {!panelOpen && (
        <button
          type="button"
          onClick={openSidePanel}
          style={{
            flexShrink: 0,
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            height: 24,
            padding: '0 8px',
            borderRadius: 7,
            border: '1px solid var(--dark-3)',
            background: 'transparent',
            color: '#fff',
            font: '600 10px/1 Inter',
          }}
        >
          <Icon name="grid" size={11} />
          Open side panel
        </button>
      )}
    </div>
  );
}

/** The toolbar badge: the rep's threads with something unread. */
function syncBadge(threads: ConversationDto[]): void {
  const count = threads.filter((c) => c.unread_count > 0).length;
  chrome.runtime.sendMessage({ type: 'talkr.badge', count }).catch(() => undefined);
}

export function Popup() {
  const { snapshot, dispatch } = useCall();
  const [tab, setTab] = useState<Tab>('dial');
  // A clicked notification names the tab to land on (service worker, openPopupOn).
  useEffect(() => {
    void chrome.storage.local
      .get('talkr_pending_view')
      .then((stored) => {
        const view = stored.talkr_pending_view as Tab | undefined;
        if (!view) return;
        void chrome.storage.local.remove('talkr_pending_view');
        if (view === 'inbox' || view === 'voicemail' || view === 'dial') setTab(view);
      })
      .catch(() => undefined);
  }, []);
  // Where the lead screen goes back to, and the number it was opened for.
  const [backTo, setBackTo] = useState<Tab>('dial');
  const [leadNumber, setLeadNumber] = useState<string | null>(null);
  const [calls, setCalls] = useState<HistoryItemDto[]>([]);
  const [pickCallerId, setPickCallerId] = useState(false);
  const [digits, setDigits] = useState('');
  const [now, setNow] = useState(Date.now());
  const [elapsed, setElapsed] = useState(0);
  const [sheet, setSheet] = useState<null | 'transfer' | 'keypad' | 'audio'>(null);
  const [mode, setMode] = useState<'warm' | 'blind'>('warm');
  const [team, setTeam] = useState<TeamMemberDto[]>([]);
  const [dtmf, setDtmf] = useState('');
  const sessionState = useSession();
  const [screen, setScreen] = useState<'main' | 'account'>('main');
  const [me, setMe] = useState<MeDto | null>(null);
  const [micDenied, setMicDenied] = useState(false);
  const [presenceOpen, setPresenceOpen] = useState(false);
  const presenceNow = PRESENCE_OPTIONS.find((o) => o.value === snapshot.presence) ?? PRESENCE_OPTIONS[0]!;
  // Who is on the other end of the number in play: the contact, their lead,
  // and what has happened with them. Looked up by number, so it works the
  // same for a typed number, a thread, an incoming call and a live one.
  const [lookup, setLookup] = useState<PhoneLookupDto | null>(null);
  const [activity, setActivity] = useState<LeadActivityDto | null>(null);

  // SMS
  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [threadId, setThreadId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [templates, setTemplates] = useState<MessageTemplateDto[]>([]);
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [draft, setDraft] = useState('');
  const [smsError, setSmsError] = useState<string | null>(null);
  // A new text to a number with no thread yet.
  const [composeTo, setComposeTo] = useState<string | null>(null);

  // Softphone can be registered while Chrome still blocks the mic — then every
  // dial dies on answer(). Mirror that into the Enable bar so the grant is one
  // click away even when device === 'ready'.
  useEffect(() => {
    if (/microphone|MEDIA_MICROPHONE/i.test(snapshot.error ?? '')) setMicDenied(true);
  }, [snapshot.error]);

  useEffect(() => {
    let alive = true;
    void navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((status) => {
        if (!alive) return;
        if (status.state === 'denied') setMicDenied(true);
        status.onchange = () => {
          if (status.state === 'denied') setMicDenied(true);
          else if (status.state === 'granted') setMicDenied(false);
        };
      })
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  useEffect(() => {
    const t = setInterval(() => {
      setNow(Date.now());
      if (snapshot.startedAt) setElapsed(Math.floor((Date.now() - snapshot.startedAt) / 1000));
    }, 1000);
    return () => clearInterval(t);
  }, [snapshot.startedAt]);

  // Everything here needs a session; re-run after a sign-in, not just on mount.
  const signedInAs = sessionState?.user?.id ?? null;
  useEffect(() => {
    if (!sessionState) return;
    api.getMe().then(setMe).catch(() => undefined);
    api.listTeam().then((r) => setTeam(r.members)).catch(() => undefined);
    api.listMessageTemplates().then((r) => setTemplates(r.templates)).catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signedInAs]);

  // Inbox, Recents and Voicemail: the rep's own only (shared/owner.ts), read
  // on sign-in, once a call is over, and whenever the live stream says a text,
  // call or voicemail moved (`inboxTick`, bumped by the offscreen document).
  const callOver = snapshot.phase === 'idle' || snapshot.phase === 'wrapup';
  const refreshLists = useCallback(() => {
    if (!me) return;
    api
      .listMyConversations(me)
      .then((threads) => {
        setConversations(threads);
        syncBadge(threads);
      })
      .catch(() => undefined);
    api.callHistory(me.id).then((r) => setCalls(ownCalls(r.items, me))).catch(() => undefined);
  }, [me]);
  useEffect(() => {
    if (!sessionState || !callOver) return;
    refreshLists();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshLists, callOver, snapshot.inboxTick]);

  function go(next: Tab) {
    setTab(next);
    setLeadNumber(null);
  }

  function openLead(e164: string) {
    setBackTo(tab === 'lead' ? backTo : tab);
    setLeadNumber(e164);
    setTab('lead');
  }

  function callNumber(e164: string) {
    void dispatch({ type: 'call', toNumber: e164 });
    go('dial');
  }

  /** The thread with this number if there is one, a fresh one if not. */
  function textNumber(e164: string) {
    const existing = conversations.find((c) => c.their_number === e164);
    // The thread already open keeps its messages: its effect will not re-run to refetch them.
    if (existing?.id !== threadId) setMessages([]);
    setThreadId(existing?.id ?? null);
    setComposeTo(existing ? null : e164);
    go('inbox');
  }

  useEffect(() => {
    if (!threadId) return;
    let alive = true;
    api
      .listConversationMessages(threadId)
      .then((r) => alive && setMessages(r.messages))
      .catch(() => alive && setMessages([]));
    void api.markConversationRead(threadId).catch(() => undefined);
    setConversations((cs) => {
      const next = cs.map((c) => (c.id === threadId ? { ...c, unread_count: 0 } : c));
      syncBadge(next);
      return next;
    });
    return () => {
      alive = false;
    };
    // inboxTick: a reply that lands while the thread is open shows up in it.
  }, [threadId, snapshot.inboxTick]);

  // A ringing or live call pulls the popup to the Dial tab: that is what the
  // rep opened it for. An incoming call too, or Accept is on a tab they are not on.
  const ringingIn = snapshot.incoming !== null;
  useEffect(() => {
    if (snapshot.phase !== 'idle' || ringingIn) go('dial');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot.phase, ringingIn]);

  const thread = conversations.find((c) => c.id === threadId) ?? null;

  // The line a text goes out on follows the thread: whichever line already
  // carries it, or the rep's default on a new one (shared/lines.ts). A manual
  // pick stands until they open a different thread.
  const [fromId, setFromId] = useState('');
  const threadLineKey = `${thread?.phone_number_id ?? ''}|${thread?.our_number ?? ''}`;
  useEffect(() => {
    if (!me) return;
    setFromId(replyLine(me, thread) ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [me, threadId, composeTo, threadLineKey]);
  const fromOptions = me ? fromLineOptions(me, thread ? threadLineId(thread, me) : null, fromId || null) : [];
  const threadNumber = thread?.their_number ?? composeTo ?? '';
  const unreadCount = conversations.reduce((s, c) => s + c.unread_count, 0);
  // ponytail: "missed today" stands in for "missed since you last looked"; add a seen marker if reps ask.
  const missedCount = calls.filter((c) => isMissed(c) && now - Date.parse(c.at) < 86_400_000).length;
  // A full number on the keypad counts too: the Lead tab answers "who is
  // this?" before the call, which is when the answer is worth the most.
  const typed = digits.replace(/\D/g, '').length >= 10 ? toE164(digits) : null;
  // Whose number the screen is about. The Lead screen shows the row it was
  // opened from even mid-call; the keypad shows what is typed, not the last thread.
  const counterparty =
    (tab === 'lead' ? leadNumber : null) ??
    snapshot.counterparty ??
    snapshot.incoming?.from ??
    (tab === 'dial' ? typed : null) ??
    (thread?.their_number || composeTo) ??
    typed;
  const counterZone = counterparty ? zoneForNumber(counterparty) : null;
  const live = snapshot.participants.filter((p) => p.state !== 'left');
  const guests = live.filter((p) => p.role === 'teammate' || p.role === 'external');

  const window24 = useMemo(
    () => (counterZone ? callWindow(counterZone, now) : null),
    [counterZone, now],
  );

  // The same lead/script context the side panel shows, for the strip on a
  // ringing or live call and for the name under a number as it is typed.
  // Typing is debounced so a rep entering ten digits triggers one read.
  const preDial = snapshot.phase === 'idle' && !snapshot.incoming;
  const context = useCallContext({
    callId: snapshot.callId,
    phone: counterparty,
    enabled: Boolean(signedInAs && counterparty),
    debounceMs: preDial ? 350 : 0,
  });

  // Whether the side panel is already up in this window: the strip offers to
  // open it only when it is not.
  const [panelOpen, setPanelOpen] = useState(false);
  useEffect(() => {
    let alive = true;
    chrome.runtime
      .getContexts({ contextTypes: ['SIDE_PANEL' as chrome.runtime.ContextType] })
      .then((contexts) => alive && setPanelOpen(contexts.length > 0))
      .catch(() => alive && setPanelOpen(false));
    return () => {
      alive = false;
    };
  }, [snapshot.phase, snapshot.incoming]);

  useEffect(() => {
    if (!counterparty || !signedInAs) {
      setLookup(null);
      setActivity(null);
      return;
    }
    let alive = true;
    api
      .lookupPhone(counterparty)
      .then(async (r) => {
        if (!alive) return;
        setLookup(r);
        setActivity(r.lead ? await api.getLead(r.lead.id) : null);
      })
      .catch(() => {
        if (!alive) return;
        setLookup(null);
        setActivity(null);
      });
    return () => {
      alive = false;
    };
    // Re-read after a call ends: the call it just made belongs in the history.
  }, [counterparty, signedInAs, snapshot.phase]);

  const contactName = lookup?.contact?.display_name ?? thread?.contact_name ?? snapshot.incoming?.contactName ?? null;
  const displayName = contactName ?? (counterparty ? formatPhone(counterparty) : '');
  const place = lookup?.property?.city
    ? `${lookup.property.city}${lookup.property.state ? `, ${lookup.property.state}` : ''}`
    : null;
  const chips = [
    lookup?.lead ? 'Seller lead' : null,
    lookup?.lead && lookup.lead.status !== 'new' ? humanize(lookup.lead.status) : null,
    lookup?.property?.address_line1 ?? null,
    lookup?.lead?.source ? `via ${lookup.lead.source.toUpperCase()}` : null,
  ].filter((c): c is string => Boolean(c));

  /**
   * Turn the softphone on.
   *
   * The microphone cannot be asked for here: Chrome shows no permission prompt
   * in an action popup (getUserMedia is "dismissed" unseen, and a few of those
   * become a hard block), and offscreen has no UI. So without a grant this
   * opens src/mic in a tab, which can prompt, or point at Chrome's settings
   * when it is already blocked. Once granted it sticks for the extension's
   * origin, and the offscreen Device opens the mic on every later call.
   */
  async function enableSoftphone() {
    const mic = await navigator.permissions
      ?.query({ name: 'microphone' as PermissionName })
      .then((s) => s.state)
      .catch(() => 'prompt');
    if (mic !== 'granted') {
      await chrome.tabs.create({ url: chrome.runtime.getURL('mic.html') });
      window.close();
      return;
    }
    setMicDenied(false);
    await dispatch({ type: 'init' });
  }

  async function sendSms() {
    if (!draft.trim()) return;
    setSmsError(null);
    try {
      const result = await api.sendMessage(
        {
          ...(threadId ? { conversation_id: threadId } : { to_number: composeTo ?? toE164(digits) }),
          body: draft,
          ...(fromId ? { from_phone_number_id: fromId } : {}),
        },
      );
      setDraft('');
      setComposeTo(null);
      setThreadId(result.conversation_id);
      const r = await api.listConversationMessages(result.conversation_id);
      setMessages(r.messages);
      refreshLists();
    } catch (err) {
      setSmsError((err as Error).message);
    }
  }

  // Undefined = storage not read yet: paint nothing rather than flash the
  // sign-in form at a rep who is already signed in.
  if (sessionState === undefined) return null;
  if (sessionState === null) return <SignIn />;
  if (screen === 'account') {
    return (
      <Account
        session={sessionState}
        me={me}
        snapshot={snapshot}
        onBack={() => setScreen('main')}
        onEnableSoftphone={() => void enableSoftphone()}
      />
    );
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', background: 'var(--panel)' }}>
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '12px 14px',
          borderBottom: '1px solid var(--line-soft)',
        }}
      >
        <img src="icons/48.png" alt="" width={26} height={26} />
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2, marginRight: 'auto', position: 'relative' }}>
          <div style={{ font: '700 13px/1 Inter' }}>Talkr</div>
          <button
            type="button"
            onClick={() => setPresenceOpen((v) => !v)}
            aria-haspopup="menu"
            aria-expanded={presenceOpen}
            title="Set your status"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 5,
              padding: 0,
              border: 'none',
              background: 'transparent',
              font: '500 11px/1 Inter',
              color: 'var(--muted)',
              textAlign: 'left',
            }}
          >
            <span
              style={{
                width: 6,
                height: 6,
                background: snapshot.device === 'ready' ? presenceNow.color : 'var(--amber)',
              }}
              aria-hidden
            />
            {snapshot.device === 'ready' ? presenceNow.label : DEVICE_STATUS[snapshot.device]} · {tzTime(localZone(), now)}{' '}
            {tzAbbr(localZone(), now)}
            <Icon name="chevron-down" size={11} />
          </button>
          {presenceOpen && (
            <div
              role="menu"
              style={{
                position: 'absolute',
                top: 'calc(100% + 6px)',
                left: 0,
                zIndex: 20,
                width: 250,
                padding: 4,
                borderRadius: 10,
                border: '1px solid var(--line)',
                background: 'var(--panel)',
                boxShadow: '0 8px 24px rgba(0,0,0,.14)',
              }}
            >
              {PRESENCE_OPTIONS.map((o) => (
                <button
                  key={o.value}
                  type="button"
                  role="menuitemradio"
                  aria-checked={snapshot.presence === o.value}
                  onClick={() => {
                    setPresenceOpen(false);
                    void setPresence(o.value);
                  }}
                  style={{
                    display: 'flex',
                    alignItems: 'flex-start',
                    gap: 8,
                    width: '100%',
                    padding: '7px 8px',
                    border: 'none',
                    borderRadius: 7,
                    background: snapshot.presence === o.value ? 'var(--panel-2)' : 'transparent',
                    color: 'inherit',
                    textAlign: 'left',
                  }}
                >
                  <span style={{ width: 7, height: 7, marginTop: 3, borderRadius: '50%', background: o.color, flexShrink: 0 }} aria-hidden />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                    <span style={{ font: '600 12px/1 Inter' }}>{o.label}</span>
                    <span style={{ font: '400 10.5px/1.3 Inter', color: 'var(--muted)' }}>{o.hint}</span>
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
        <button
          type="button"
          style={HEADER_BTN}
          title="Open side panel"
          aria-label="Open side panel"
          onClick={openSidePanel}
        >
          <Icon name="grid" size={15} />
        </button>
        <button
          type="button"
          style={HEADER_BTN}
          title="Account"
          aria-label="Account"
          onClick={() => setScreen('account')}
        >
          <Icon name="settings" size={15} />
        </button>
      </header>

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', position: 'relative' }}>
        {pickCallerId && me && (
          <CallerIdSheet
            me={me}
            onClose={() => setPickCallerId(false)}
            onSaved={() => void api.getMe().then(setMe).catch(() => undefined)}
          />
        )}

        {/* ── INBOX / RECENTS / VOICEMAIL ──────────────────────────────── */}
        {tab === 'inbox' && !threadId && !composeTo && (
          <InboxList
            conversations={conversations}
            calls={calls}
            now={now}
            me={me}
            onOpenThread={(id) => setThreadId(id)}
            onOpenLead={openLead}
            onCall={callNumber}
          />
        )}
        {tab === 'recents' && <RecentsList calls={calls} now={now} onOpenLead={openLead} onCall={callNumber} />}
        {tab === 'voicemail' && <VoicemailList calls={calls} now={now} onOpenLead={openLead} onCall={callNumber} />}

        {/* ── DIAL: idle ───────────────────────────────────────────────── */}
        {tab === 'dial' && snapshot.phase === 'idle' && !snapshot.incoming && (
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', padding: '10px 18px 10px' }}>
            {snapshot.device === 'ready' && !micDenied && (
            <button
              type="button"
              onClick={() => setPickCallerId(true)}
              disabled={!me}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '8px 11px',
                border: '1px solid var(--line)',
                borderRadius: 10,
                background: 'var(--panel)',
                textAlign: 'left',
                color: 'inherit',
              }}
            >
              <Icon name="pin" size={14} style={{ color: 'var(--accent)' }} />
              <span style={{ display: 'flex', flexDirection: 'column', gap: 2, marginRight: 'auto', minWidth: 0 }}>
                <Eyebrow>Calling from</Eyebrow>
                <span style={{ font: '600 12px/1.1 Inter', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {callerIdLabel(me)}
                </span>
              </span>
              <span style={{ font: '600 11px/1 Inter', color: 'var(--accent)' }}>Change</span>
            </button>
            )}

            {/* In the caller-ID row's place: no call can go out until this is fixed.
                Also shown when Telnyx is registered but Chrome still blocks the mic. */}
            {(snapshot.device !== 'ready' || micDenied) && (
              <button
                type="button"
                onClick={() => void enableSoftphone()}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 7,
                  minHeight: 40,
                  padding: '7px 11px',
                  border: '1px solid var(--line)',
                  borderRadius: 10,
                  background: 'var(--bg)',
                  font: '500 11.5px/1 Inter',
                  color: 'var(--text)',
                  textAlign: 'left',
                }}
                title={snapshot.deviceError ?? snapshot.error ?? undefined}
              >
                <span
                  aria-hidden
                  style={{
                    width: 6,
                    height: 6,
                    flexShrink: 0,
                    background:
                      micDenied || snapshot.device === 'error'
                        ? 'var(--red)'
                        : snapshot.device === 'initializing'
                          ? 'var(--amber)'
                          : 'var(--red)',
                  }}
                />
                <span style={{ marginRight: 'auto' }}>
                  {micDenied
                    ? 'Microphone blocked — allow it to place calls'
                    : snapshot.device === 'initializing'
                      ? 'Connecting the softphone…'
                      : 'Softphone is off'}
                </span>
                <span style={{ font: '600 11.5px/1 Inter', color: 'var(--accent)' }}>
                  {micDenied ? 'Allow mic' : snapshot.device === 'initializing' ? '' : 'Enable'}
                </span>
              </button>
            )}

            {/* CLOZR's keypad (components/talkr/DialerParts.tsx), scaled to the popup:
                a big centred number you can type or paste into, an ⓧ that clears it,
                round grey keys, then text · the round green call · backspace. */}
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center', minHeight: 44, marginTop: 6 }}>
              <input
                autoFocus
                value={shownDigits(digits)}
                onChange={(e) => setDigits(dialDigits(e.target.value))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && digits && snapshot.device === 'ready' && !micDenied) {
                    void dispatch({ type: 'call', toNumber: toE164(digits) });
                  }
                }}
                placeholder="Enter a number"
                aria-label="Number to dial"
                inputMode="tel"
                autoComplete="off"
                enterKeyHint="go"
                style={{
                  width: '100%',
                  minWidth: 0,
                  border: 'none',
                  outline: 'none',
                  background: 'transparent',
                  textAlign: 'center',
                  padding: '0 30px',
                  font: `500 ${digits.length > 10 ? 24 : 30}px/1.15 Inter`,
                  letterSpacing: '-0.01em',
                  color: 'var(--text)',
                }}
              />
              {digits && (
                <button
                  type="button"
                  onClick={() => setDigits('')}
                  aria-label="Clear number"
                  title="Clear number"
                  style={{
                    position: 'absolute',
                    right: 4,
                    display: 'inline-flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 22,
                    height: 22,
                    borderRadius: '50%',
                    border: 'none',
                    background: 'rgba(118,118,128,.32)',
                    color: '#fff',
                  }}
                >
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>

            {/* One line under the number: who it is and their time, or why the call failed. */}
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 6,
                minHeight: 16,
                margin: '2px 0 10px',
                font: '500 11.5px/1.3 Inter',
                color: snapshot.error ? 'var(--red)' : 'var(--muted)',
                textAlign: 'center',
              }}
            >
              {snapshot.error ? (
                snapshot.error
              ) : (
                <>
                  {typed && context.context?.contact && (
                    <>
                      <TempDot temperature={context.context.contact.temperature} size={7} />
                      <span
                        style={{
                          maxWidth: 170,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                          color: 'var(--text)',
                          fontWeight: 600,
                        }}
                      >
                        {context.context.contact.display_name}
                      </span>
                      <span>· {TEMP_LABEL[context.context.contact.temperature]}</span>
                    </>
                  )}
                  {typed && context.context && !context.context.contact && <span>No contact on file</span>}
                  {digits.length > 3 && zoneForNumber(toE164(digits)) && (
                    <span>
                      {typed && context.context ? '· ' : ''}
                      {tzTime(zoneForNumber(toE164(digits))!, now)} their time
                    </span>
                  )}
                </>
              )}
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 62px)', justifyContent: 'center', columnGap: 18, rowGap: 9 }}>
              {KEYS.map(([d, letters]) => (
                <button
                  key={d}
                  type="button"
                  className="ios-key"
                  aria-label={letters ? `${d} ${letters}` : d}
                  onClick={() => setDigits((v) => dialDigits(v + d))}
                >
                  <span style={{ font: '400 27px/1 Inter' }}>{d}</span>
                  <span style={{ font: '600 8px/1 Inter', letterSpacing: '0.16em', color: 'var(--muted)', minHeight: 8 }}>
                    {letters}
                  </span>
                </button>
              ))}
            </div>

            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(3, 62px)',
                justifyContent: 'center',
                justifyItems: 'center',
                alignItems: 'center',
                columnGap: 18,
                marginTop: 10,
              }}
            >
              <button
                type="button"
                aria-label={typed ? 'Text this number' : 'Text from the inbox'}
                title={typed ? 'Text this number' : 'Text from the inbox'}
                onClick={() => (typed ? textNumber(typed) : go('inbox'))}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 62,
                  height: 44,
                  border: 'none',
                  background: 'none',
                  color: 'var(--accent)',
                }}
              >
                <Icon name="msg" size={22} />
              </button>
              <button
                type="button"
                className="ios-round"
                aria-label="Call"
                title="Call"
                style={{ background: 'var(--green)' }}
                disabled={!digits || snapshot.device !== 'ready' || micDenied}
                onClick={() => void dispatch({ type: 'call', toNumber: toE164(digits) })}
              >
                <Icon name="phone" size={26} />
              </button>
              <button
                type="button"
                aria-label="Backspace"
                title="Backspace"
                onClick={() => setDigits((v) => v.slice(0, -1))}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  width: 62,
                  height: 44,
                  border: 'none',
                  background: 'none',
                  color: 'var(--muted)',
                  visibility: digits ? 'visible' : 'hidden',
                }}
              >
                <Icon name="backspace" size={24} />
              </button>
            </div>
          </div>
        )}

        {/* ── DIAL: ringing ────────────────────────────────────────────── */}
        {tab === 'dial' && (snapshot.phase === 'connecting' || snapshot.phase === 'ringing' || snapshot.incoming) && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: '24px 18px 22px',
              background: 'var(--ink)',
            }}
          >
            <div
              style={{
                position: 'relative',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                width: 96,
                height: 96,
                marginBottom: 6,
              }}
            >
              <span
                style={{
                  position: 'absolute',
                  inset: 0,
                  borderRadius: '50%',
                  background: 'var(--accent)',
                  animation: 'ringpulse 1.6s ease-out infinite',
                }}
                aria-hidden
              />
              <Avatar name={displayName} size={72} dark />
            </div>
            <div style={{ font: '600 20px/1.2 Inter', color: '#fff' }}>{displayName}</div>
            <div style={{ font: '500 13px/1 Inter', color: 'var(--muted-2)' }}>
              {contactName ? formatPhone(counterparty ?? '') : place ?? ''}
              {contactName && place ? ` · ${place}` : ''}
            </div>
            <div
              style={{
                font: '600 11px/1 Inter',
                letterSpacing: '0.12em',
                textTransform: 'uppercase',
                color: 'var(--accent-light)',
                paddingTop: 4,
              }}
            >
              {snapshot.incoming ? 'Incoming…' : 'Ringing…'}
            </div>

            <div style={{ alignSelf: 'stretch', marginTop: 10 }}>
              <ContextStrip ctx={context.context} loading={context.loading} panelOpen={panelOpen} />
            </div>

            <div style={{ display: 'flex', gap: 14, marginTop: 8 }}>
              {snapshot.incoming && (
                <button
                  type="button"
                  aria-label="Accept"
                  onClick={() => void dispatch({ type: 'acceptIncoming' })}
                  style={{
                    width: 62,
                    height: 62,
                    borderRadius: '50%',
                    border: 'none',
                    background: 'var(--green)',
                    color: '#fff',
                  }}
                >
                  <Icon name="phone" size={24} />
                </button>
              )}
              <button
                type="button"
                aria-label={snapshot.incoming ? 'Decline' : 'Cancel'}
                onClick={() =>
                  void dispatch({ type: snapshot.incoming ? 'rejectIncoming' : 'hangup' })
                }
                style={{
                  width: 62,
                  height: 62,
                  borderRadius: '50%',
                  border: 'none',
                  background: 'var(--red)',
                  color: '#fff',
                }}
              >
                <HangupIcon size={24} />
              </button>
            </div>
          </div>
        )}

        {/* ── DIAL: active, layout A ───────────────────────────────────── */}
        {tab === 'dial' && snapshot.phase === 'in_call' && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              background: 'var(--ink)',
              position: 'relative',
              overflow: 'hidden',
            }}
          >
            <div
              aria-hidden
              style={{
                position: 'absolute',
                top: -70,
                right: -60,
                width: 240,
                height: 240,
                borderRadius: '50%',
                background: 'radial-gradient(circle, rgba(255,35,59,.42), rgba(255,35,59,0) 70%)',
              }}
            />
            <div
              style={{
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 7,
                padding: '20px 18px 14px',
              }}
            >
              <Avatar name={displayName} size={60} dark />
              <div style={{ font: '600 19px/1.2 Inter', color: '#fff' }}>{displayName}</div>
              {(contactName || counterZone) && (
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    font: '500 11px/1 Inter',
                    color: 'var(--muted-2)',
                  }}
                >
                  {contactName && <span>{formatPhone(counterparty ?? '')}</span>}
                  {contactName && counterZone && <span style={{ color: 'var(--dark-3)' }}>·</span>}
                  {counterZone && (
                    <>
                      <Icon name="clock" size={11} style={{ color: 'var(--accent-light)' }} />
                      {tzTime(counterZone, now)} {place ?? 'their time'}
                    </>
                  )}
                </div>
              )}
              <div style={{ font: '600 26px/1 Inter', letterSpacing: '-0.02em', color: '#fff', paddingTop: 6 }}>
                {duration(elapsed)}
              </div>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 6,
                  font: '600 9px/1 Inter',
                  letterSpacing: '0.12em',
                  textTransform: 'uppercase',
                  color: 'var(--accent-light)',
                }}
              >
                <span
                  style={{ width: 5, height: 5, background: snapshot.onHold ? 'var(--amber)' : 'var(--green)' }}
                  aria-hidden
                />
                {snapshot.onHold ? 'On hold' : 'Connected'}
              </div>
            </div>

            <ContextStrip ctx={context.context} loading={context.loading} panelOpen={panelOpen} />

            {guests.length > 0 && (
              <div
                style={{
                  margin: '0 16px 10px',
                  border: '1px solid var(--dark-2)',
                  borderRadius: 12,
                  overflow: 'hidden',
                }}
              >
                <div
                  style={{
                    padding: '8px 12px',
                    borderBottom: '1px solid var(--dark-2)',
                    font: '600 9px/1 Inter',
                    letterSpacing: '0.12em',
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                  }}
                >
                  Conference · {live.length} on the line
                </div>
                {live.map((p) => (
                  <div
                    key={p.id}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      padding: '8px 12px',
                      borderBottom: '1px solid #1f1f23',
                    }}
                  >
                    <Avatar name={p.role === 'customer' ? displayName : (p.label ?? p.address ?? '?')} size={24} dark />
                    <span style={{ display: 'flex', flexDirection: 'column', gap: 2, marginRight: 'auto' }}>
                      <span style={{ font: '600 12px/1 Inter', color: '#fff' }}>
                        {p.role === 'customer' ? displayName : (p.label ?? p.address)}
                      </span>
                      <span style={{ font: '500 10px/1 Inter', color: 'var(--muted)' }}>
                        {p.state === 'on_hold' ? 'On hold' : p.state}
                      </span>
                    </span>
                    {p.role !== 'agent' && (
                      <button
                        type="button"
                        aria-label="Drop"
                        onClick={() =>
                          void dispatch({
                            type: 'dropParticipant',
                            providerParticipantId: p.provider_participant_id,
                          })
                        }
                        style={{
                          width: 24,
                          height: 24,
                          borderRadius: 7,
                          border: '1px solid var(--dark-3)',
                          background: 'transparent',
                          color: 'var(--muted-2)',
                        }}
                      >
                        <Icon name="x" size={12} />
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}

            <div
              style={{
                marginTop: 'auto',
                padding: '0 18px 16px',
                display: 'flex',
                flexDirection: 'column',
                gap: 10,
              }}
            >
              {snapshot.error && (
                <p style={{ font: '500 11px/1.35 Inter', color: '#fca5a5' }}>{snapshot.error}</p>
              )}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
                <ControlTile
                  icon={<Icon name={snapshot.muted ? 'mic-off' : 'mic'} size={19} />}
                  label={snapshot.muted ? 'Unmute' : 'Mute'}
                  active={snapshot.muted}
                  onClick={() => void dispatch({ type: 'toggleMute' })}
                />
                <ControlTile
                  icon={<Icon name="grid" size={19} />}
                  label="Keypad"
                  active={sheet === 'keypad'}
                  onClick={() => {
                    setSheet(sheet === 'keypad' ? null : 'keypad');
                    setDtmf('');
                  }}
                />
                <ControlTile
                  icon={<Icon name="pause" size={19} />}
                  label={snapshot.onHold ? 'Resume' : 'Hold'}
                  active={snapshot.onHold}
                  onClick={() => void dispatch({ type: 'setHold', hold: !snapshot.onHold })}
                />
                <ControlTile
                  icon={<Icon name="plus" size={19} />}
                  label="Add call"
                  onClick={() => setSheet('transfer')}
                />
                <ControlTile
                  icon={<Icon name="transfer" size={19} />}
                  label="Transfer"
                  active={sheet === 'transfer'}
                  onClick={() => setSheet(sheet === 'transfer' ? null : 'transfer')}
                />
                <ControlTile
                  icon={<Icon name="users" size={19} />}
                  label={snapshot.merged ? 'Merged' : 'Merge'}
                  active={snapshot.merged}
                  disabled={guests.length === 0}
                  onClick={() => void dispatch({ type: 'merge' })}
                />
                <ControlTile
                  icon={<Icon name="speaker" size={19} />}
                  label="Audio"
                  active={sheet === 'audio'}
                  onClick={() => setSheet(sheet === 'audio' ? null : 'audio')}
                />
                <ControlTile
                  icon={<Icon name="msg" size={19} />}
                  label="Text"
                  onClick={() => counterparty && textNumber(counterparty)}
                />
                <ControlTile
                  icon={<Icon name="user" size={19} />}
                  label="Lead"
                  onClick={() => counterparty && openLead(counterparty)}
                />
              </div>
              <button
                type="button"
                onClick={() => void dispatch({ type: 'hangup' })}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 8,
                  height: 46,
                  borderRadius: 12,
                  border: 'none',
                  background: 'var(--red)',
                  color: '#fff',
                  font: '700 13.5px/1 Inter',
                }}
              >
                <HangupIcon size={18} />
                End call
              </button>
            </div>

            {sheet === 'audio' && (
              <AudioSheet snapshot={snapshot} dispatch={dispatch} onClose={() => setSheet(null)} />
            )}

            {/* Tone dial overlay */}
            {sheet === 'keypad' && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(10,10,12,.92)',
                  backdropFilter: 'blur(6px)',
                  display: 'flex',
                  flexDirection: 'column',
                  padding: 18,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: 10 }}>
                  <Eyebrow>Tone dial</Eyebrow>
                  <button
                    type="button"
                    aria-label="Close"
                    onClick={() => setSheet(null)}
                    style={{
                      width: 26,
                      height: 26,
                      borderRadius: 8,
                      border: '1px solid var(--dark-3)',
                      background: 'transparent',
                      color: '#e4e4e7',
                    }}
                  >
                    <Icon name="x" size={13} />
                  </button>
                </div>
                <div
                  style={{
                    minHeight: 30,
                    font: '600 22px/1 Inter',
                    letterSpacing: '0.12em',
                    color: '#fff',
                    textAlign: 'center',
                    paddingBottom: 12,
                  }}
                >
                  {dtmf}
                </div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3,1fr)', gap: 8 }}>
                  {KEYS.map(([d]) => (
                    <button
                      key={d}
                      type="button"
                      onClick={() => {
                        void dispatch({ type: 'digit', digit: d });
                        setDtmf((v) => (v + d).slice(-8));
                      }}
                      style={{
                        height: 48,
                        borderRadius: 12,
                        border: '1px solid var(--dark-2)',
                        background: 'rgba(255,255,255,.05)',
                        color: '#fff',
                        font: '500 19px/1 Inter',
                      }}
                    >
                      {d}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {/* Transfer sheet */}
            {sheet === 'transfer' && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  background: 'rgba(10,10,12,.86)',
                  backdropFilter: 'blur(6px)',
                  display: 'flex',
                  flexDirection: 'column',
                  justifyContent: 'flex-end',
                }}
              >
                <div
                  style={{
                    background: 'var(--dark-1)',
                    borderTop: '1px solid var(--dark-2)',
                    borderRadius: '16px 16px 0 0',
                    padding: '14px 16px 16px',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 10,
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <span style={{ font: '700 13px/1 Inter', color: '#fff' }}>Transfer call</span>
                    <button
                      type="button"
                      aria-label="Close"
                      onClick={() => setSheet(null)}
                      style={{
                        width: 26,
                        height: 26,
                        borderRadius: 8,
                        border: '1px solid var(--dark-3)',
                        background: 'transparent',
                        color: '#e4e4e7',
                      }}
                    >
                      <Icon name="x" size={13} />
                    </button>
                  </div>

                  <div style={{ display: 'flex', gap: 6, padding: 3, borderRadius: 10, background: 'var(--dark-2)' }}>
                    {(['warm', 'blind'] as const).map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setMode(m)}
                        style={{
                          flex: 1,
                          height: 30,
                          borderRadius: 8,
                          border: 'none',
                          background: mode === m ? 'var(--accent)' : 'transparent',
                          color: mode === m ? '#fff' : 'var(--muted-2)',
                          font: '600 11px/1 Inter',
                        }}
                      >
                        {m === 'warm' ? 'Warm — announce first' : 'Blind — send now'}
                      </button>
                    ))}
                  </div>

                  <div className="scroll" style={{ maxHeight: 236, display: 'flex', flexDirection: 'column' }}>
                    {team.filter((m) => !m.is_self).length === 0 && (
                      <p style={{ font: '400 11px/1.5 Inter', color: 'var(--muted)' }}>
                        No teammates available.
                      </p>
                    )}
                    {team
                      .filter((m) => !m.is_self)
                      .map((m) => (
                        <div
                          key={m.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 9,
                            padding: '9px 4px',
                            borderBottom: '1px solid var(--dark-2)',
                          }}
                        >
                          <Avatar name={m.display_name} size={28} dark />
                          <span style={{ display: 'flex', flexDirection: 'column', gap: 3, marginRight: 'auto' }}>
                            <span style={{ font: '600 12px/1 Inter', color: '#fff' }}>{m.display_name}</span>
                            <span style={{ font: '500 10px/1 Inter', color: 'var(--muted)' }}>
                              {m.title ?? humanize(m.role)}
                              {m.city ? ` · ${m.city}` : ''}
                            </span>
                          </span>
                          <span style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                            <span style={{ font: '600 11px/1 Inter', color: '#e4e4e7' }}>
                              {m.timezone ? tzTime(m.timezone, now) : '—'}
                            </span>
                            <StatusMarker
                              onDark
                              color={
                                m.presence === 'available'
                                  ? 'var(--green)'
                                  : m.presence === 'away'
                                    ? 'var(--amber)'
                                    : 'var(--muted-2)'
                              }
                              label={m.presence}
                            />
                          </span>
                          <Button
                            tone="dark"
                            style={{ padding: '6px 9px', font: '600 10px/1 Inter' }}
                            onClick={() =>
                              void dispatch({ type: 'addParticipant', userId: m.id, consult: true })
                            }
                          >
                            Add
                          </Button>
                          <Button
                            tone="accent"
                            style={{ padding: '6px 9px', font: '600 10px/1 Inter' }}
                            onClick={() => {
                              void dispatch({ type: 'transfer', mode, userId: m.id });
                              setSheet(null);
                            }}
                          >
                            Send
                          </Button>
                        </div>
                      ))}
                  </div>

                  {mode === 'warm' && guests.length > 0 && (
                    <Button
                      tone="accent"
                      onClick={() => {
                        void dispatch({ type: 'completeTransfer' });
                        setSheet(null);
                      }}
                    >
                      <Icon name="check" size={14} />
                      Complete transfer and leave
                    </Button>
                  )}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── DIAL: wrap-up ────────────────────────────────────────────── */}
        {tab === 'dial' && snapshot.phase === 'wrapup' && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 10,
              padding: 24,
              textAlign: 'center',
            }}
          >
            <Icon name="check" size={22} style={{ color: 'var(--green)' }} />
            <div style={{ font: '600 15px/1 Inter' }}>Call ended</div>
            <p style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>
              {duration(elapsed)} with {formatPhone(counterparty ?? '')}. Disposition is set in the
              web app.
            </p>
            <Button tone="accent" onClick={() => void dispatch({ type: 'finishWrapup' })}>
              Done
            </Button>
          </div>
        )}

        {/* ── MESSAGES ─────────────────────────────────────────────────── */}
        {tab === 'inbox' && (threadId || composeTo) && (
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', background: 'var(--panel)' }}>
            {(
              <>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 9,
                    padding: '9px 12px',
                    borderBottom: '1px solid var(--line)',
                    background: 'var(--bg)',
                  }}
                >
                  <button
                    type="button"
                    aria-label="Back"
                    onClick={() => {
                      setThreadId(null);
                      setComposeTo(null);
                    }}
                    style={{ border: 'none', background: 'transparent', color: 'var(--accent)' }}
                  >
                    <Icon name="chevron-left" size={18} strokeWidth={2.4} />
                  </button>
                  <Avatar name={contactName ?? threadNumber} size={30} />
                  <span style={{ display: 'flex', flexDirection: 'column', gap: 2, marginRight: 'auto', minWidth: 0 }}>
                    <span style={{ font: '600 13px/1 Inter', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {contactName ?? formatPhone(threadNumber)}
                    </span>
                    <span style={{ font: '500 10px/1 Inter', color: 'var(--muted)' }}>
                      {[
                        place,
                        threadNumber && zoneForNumber(threadNumber)
                          ? `${tzTime(zoneForNumber(threadNumber)!, now)} local`
                          : null,
                      ]
                        .filter(Boolean)
                        .join(' · ') || formatPhone(threadNumber)}
                    </span>
                  </span>
                  <button
                    type="button"
                    aria-label="Call"
                    title="Call"
                    onClick={() => threadNumber && callNumber(threadNumber)}
                    style={{ ...HEADER_BTN, color: 'var(--green)' }}
                  >
                    <Icon name="phone" size={15} />
                  </button>
                  <button
                    type="button"
                    aria-label="Lead"
                    title="Lead"
                    onClick={() => threadNumber && openLead(threadNumber)}
                    style={HEADER_BTN}
                  >
                    <Icon name="user" size={15} />
                  </button>
                  <button
                    type="button"
                    aria-label="Open in CLOZR"
                    title="Open in CLOZR"
                    onClick={() => threadNumber && openInClozr(threadNumber)}
                    style={HEADER_BTN}
                  >
                    <Icon name="external-link" size={14} />
                  </button>
                </div>

                <div
                  className="scroll"
                  style={{ flex: 1, padding: '12px 12px 6px', display: 'flex', flexDirection: 'column', gap: 3 }}
                >
                  {messages.map((m, i) => {
                    const mine = m.direction === 'outbound';
                    const next = messages[i + 1];
                    const tail = !next || next.direction !== m.direction;
                    const sender = mine ? senderLine(m, messages[i - 1], me, team) : null;
                    return (
                      <div
                        key={m.id}
                        style={{
                          alignSelf: mine ? 'flex-end' : 'flex-start',
                          maxWidth: '74%',
                          marginBottom: 6,
                          display: 'flex',
                          flexDirection: 'column',
                          alignItems: mine ? 'flex-end' : 'flex-start',
                          gap: 3,
                        }}
                      >
                        {sender && (
                          <span style={{ font: '500 10px/1.2 Inter', color: 'var(--muted)', marginTop: 4 }}>{sender}</span>
                        )}
                        <div
                          style={{
                            position: 'relative',
                            padding: '8px 13px',
                            borderRadius: 19,
                            background: mine ? 'var(--accent)' : '#e9e9eb',
                            color: mine ? '#fff' : 'var(--text)',
                            font: '400 13.5px/1.35 Inter',
                          }}
                        >
                          {m.media_urls.length > 0 && (
                            <span
                              style={{
                                display: 'flex',
                                flexDirection: 'column',
                                alignItems: 'flex-start',
                                gap: 8,
                                width: 186,
                                minHeight: 96,
                                margin: '-2px 0 8px',
                                padding: 12,
                                borderRadius: 13,
                                background: mine ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.06)',
                                font: '700 10.5px/1.3 Inter',
                                letterSpacing: '0.06em',
                                textTransform: 'uppercase',
                                wordBreak: 'break-word',
                              }}
                            >
                              <Icon name="image" size={16} />
                              <span>
                                {fileName(m.media_urls[0]!)}
                                {m.media_urls.length > 1 ? ` +${m.media_urls.length - 1}` : ''}
                              </span>
                            </span>
                          )}
                          {m.body}
                          {tail && (
                            <>
                              <span
                                aria-hidden
                                style={{
                                  position: 'absolute',
                                  [mine ? 'right' : 'left']: -6,
                                  bottom: 0,
                                  width: 18,
                                  height: 18,
                                  background: mine ? 'var(--accent)' : '#e9e9eb',
                                  [`borderBottom${mine ? 'Left' : 'Right'}Radius`]: 15,
                                } as React.CSSProperties}
                              />
                              <span
                                aria-hidden
                                style={{
                                  position: 'absolute',
                                  [mine ? 'right' : 'left']: -9,
                                  bottom: 0,
                                  width: 11,
                                  height: 18,
                                  background: 'var(--panel)',
                                  [`borderBottom${mine ? 'Left' : 'Right'}Radius`]: 11,
                                } as React.CSSProperties}
                              />
                            </>
                          )}
                        </div>
                        {mine && tail && (
                          <span style={{ font: '500 9.5px/1 Inter', color: 'var(--muted-2)' }}>
                            {deliveryStamp(m, now)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>

                {templatesOpen && (
                  <div
                    className="scroll"
                    style={{ borderTop: '1px solid var(--line)', background: 'var(--bg)', maxHeight: 214 }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', padding: '9px 12px 6px' }}>
                      <Eyebrow>Templates</Eyebrow>
                      <button
                        type="button"
                        onClick={() => setTemplatesOpen(false)}
                        style={{ border: 'none', background: 'transparent', color: 'var(--accent)', font: '600 11px/1 Inter' }}
                      >
                        Close
                      </button>
                    </div>
                    {templates.map((t) => (
                      <button
                        key={t.id}
                        type="button"
                        onClick={() => {
                          setDraft(t.body);
                          setTemplatesOpen(false);
                        }}
                        style={{
                          display: 'flex',
                          flexDirection: 'column',
                          gap: 4,
                          width: '100%',
                          padding: '9px 12px',
                          border: 'none',
                          borderTop: '1px solid var(--line-soft)',
                          background: 'transparent',
                          textAlign: 'left',
                        }}
                      >
                        <span style={{ font: '600 11.5px/1 Inter' }}>{t.name}</span>
                        <span style={{ font: '400 11px/1.35 Inter', color: 'var(--muted)' }}>
                          {t.body.length > 90 ? `${t.body.slice(0, 90)}…` : t.body}
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {fromOptions.length > 0 && (
                  <label
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      padding: '6px 12px',
                      borderTop: '1px solid var(--line-soft)',
                      font: '500 11px/1 Inter',
                      color: 'var(--muted)',
                    }}
                  >
                    From
                    <select
                      value={fromId}
                      onChange={(e) => setFromId(e.target.value)}
                      disabled={fromOptions.length < 2}
                      aria-label="Send from"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        height: 24,
                        border: '1px solid var(--line)',
                        borderRadius: 7,
                        background: 'var(--panel)',
                        color: 'var(--text)',
                        font: '500 11.5px/1 Inter',
                      }}
                    >
                      {fromOptions.map((n) => (
                        <option key={n.id} value={n.id}>
                          {lineLabel(n, formatPhone)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}

                {smsError && (
                  <p style={{ padding: '0 12px 6px', font: '400 11px/1.4 Inter', color: 'var(--red)' }}>
                    {smsError}
                  </p>
                )}

                <div
                  style={{
                    display: 'flex',
                    alignItems: 'flex-end',
                    gap: 8,
                    padding: '9px 11px 12px',
                    borderTop: '1px solid var(--line)',
                    background: 'var(--bg)',
                  }}
                >
                  <button
                    type="button"
                    aria-label="Templates"
                    title="Templates"
                    aria-pressed={templatesOpen}
                    onClick={() => setTemplatesOpen((v) => !v)}
                    style={{
                      display: 'inline-flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      border: '1px solid var(--line)',
                      background: templatesOpen ? 'var(--accent-soft)' : 'var(--panel)',
                      color: templatesOpen ? 'var(--accent)' : 'var(--muted)',
                    }}
                  >
                    <Icon name="plus" size={16} />
                  </button>
                  <div
                    style={{
                      flex: 1,
                      display: 'flex',
                      alignItems: 'center',
                      gap: 6,
                      minHeight: 32,
                      padding: '5px 6px 5px 12px',
                      border: '1px solid #d1d1d6',
                      borderRadius: 17,
                      background: 'var(--panel)',
                    }}
                  >
                    <input
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          void sendSms();
                        }
                      }}
                      placeholder="Text message"
                      aria-label="Message"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        border: 'none',
                        outline: 'none',
                        background: 'transparent',
                        font: '400 13.5px/1.3 Inter',
                      }}
                    />
                    <button
                      type="button"
                      aria-label="Templates"
                      onClick={() => setTemplatesOpen((v) => !v)}
                      style={{ border: 'none', background: 'transparent', color: '#8e8e93' }}
                    >
                      <Icon name="template" size={16} />
                    </button>
                  </div>
                  <button
                    type="button"
                    aria-label="Send"
                    onClick={() => void sendSms()}
                    disabled={!draft.trim()}
                    style={{
                      width: 32,
                      height: 32,
                      borderRadius: '50%',
                      border: 'none',
                      background: 'var(--accent)',
                      color: '#fff',
                      opacity: draft.trim() ? 1 : 0.45,
                    }}
                  >
                    <Icon name="send" size={17} strokeWidth={2.4} />
                  </button>
                </div>
              </>
            )}
          </div>
        )}

        {/* ── LEAD ─────────────────────────────────────────────────────── */}
        {tab === 'lead' && (
          <div className="scroll" style={{ flex: 1, padding: '10px 16px 18px', display: 'flex', flexDirection: 'column', gap: 12 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <button
                type="button"
                onClick={() => go(backTo)}
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 2,
                  border: 'none',
                  background: 'transparent',
                  padding: 0,
                  color: 'var(--accent)',
                  font: '600 12.5px/1 Inter',
                }}
              >
                <Icon name="chevron-left" size={17} strokeWidth={2.4} />
                Back
              </button>
              {counterparty && (
                <button
                  type="button"
                  onClick={() => openInClozr(counterparty)}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 5,
                    height: 28,
                    padding: '0 10px',
                    borderRadius: 8,
                    border: '1px solid var(--line)',
                    background: 'var(--panel)',
                    color: 'var(--text)',
                    font: '600 11.5px/1 Inter',
                  }}
                >
                  <Icon name="external-link" size={12} />
                  Open in CLOZR
                </button>
              )}
            </div>
            {!counterparty ? (
              <p style={{ margin: 0, font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>
                Dial a number or open a conversation to see the lead here.
              </p>
            ) : (
              <>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <Avatar name={displayName} size={44} dark />
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginRight: 'auto', minWidth: 0 }}>
                    <div
                      style={{
                        font: '700 15px/1 Inter',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                      }}
                    >
                      {displayName}
                    </div>
                    <div style={{ font: '500 11.5px/1 Inter', color: 'var(--accent)' }}>
                      {contactName
                        ? formatPhone(counterparty)
                        : place ?? (counterZone ? counterZone.split('/')[1]?.replace('_', ' ') : 'Zone unknown')}
                    </div>
                  </div>
                  <button
                    type="button"
                    aria-label="Call"
                    disabled={snapshot.phase !== 'idle' || snapshot.device !== 'ready' || micDenied}
                    onClick={() => callNumber(counterparty)}
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 10,
                      border: 'none',
                      background: 'var(--green)',
                      color: '#fff',
                      opacity: snapshot.phase !== 'idle' || snapshot.device !== 'ready' || micDenied ? 0.45 : 1,
                    }}
                  >
                    <Icon name="phone" size={16} />
                  </button>
                  <button
                    type="button"
                    aria-label="Text"
                    onClick={() => textNumber(counterparty)}
                    style={{
                      width: 34,
                      height: 34,
                      borderRadius: 10,
                      border: '1px solid var(--line)',
                      background: 'var(--panel)',
                      color: 'var(--text)',
                    }}
                  >
                    <Icon name="msg" size={16} />
                  </button>
                </div>

                {(chips.length > 0 || context.context?.contact) && (
                  <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                    {context.context?.contact && (
                      <TemperatureBadge
                        temperature={context.context.contact.temperature}
                        score={context.context.contact.temperature_score}
                        locked={context.context.contact.temperature_locked}
                      />
                    )}
                    {chips.map((c) => (
                      <Chip key={c}>{c}</Chip>
                    ))}
                  </div>
                )}

                {window24 && counterZone && (
                  <div
                    style={{
                      border: '1px solid var(--line)',
                      borderRadius: 12,
                      padding: 12,
                      display: 'flex',
                      flexDirection: 'column',
                      gap: 9,
                    }}
                  >
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <Icon name="globe" size={12} style={{ color: 'var(--accent)' }} />
                        <Eyebrow>Local time</Eyebrow>
                      </span>
                      <span style={{ font: '600 13px/1 Inter' }}>{tzTime(counterZone, now)}</span>
                    </div>

                    {/* 24h bar: the green band is the 9a–8p window, the blue
                        rule is where the lead's day actually is right now. */}
                    <div
                      style={{
                        position: 'relative',
                        height: 8,
                        borderRadius: 4,
                        background: 'var(--panel-2)',
                        overflow: 'hidden',
                      }}
                    >
                      <span
                        style={{ position: 'absolute', left: '37.5%', width: '45.8%', top: 0, bottom: 0, background: '#dcfce7' }}
                        aria-hidden
                      />
                      <span
                        style={{
                          position: 'absolute',
                          top: -3,
                          bottom: -3,
                          width: 2,
                          background: 'var(--accent)',
                          left: `${window24.nowPercent.toFixed(1)}%`,
                        }}
                        aria-hidden
                      />
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        font: '500 10px/1 Inter',
                        color: 'var(--muted-2)',
                      }}
                    >
                      <span>12a</span>
                      <span>9a — safe window — 8p</span>
                      <span>12a</span>
                    </div>
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        font: '600 11px/1 Inter',
                        color: window24.color,
                      }}
                    >
                      <span style={{ width: 6, height: 6, background: window24.color }} aria-hidden />
                      {window24.label}
                    </div>
                  </div>
                )}

                <div>
                  <Eyebrow>Recent activity</Eyebrow>
                  {!activity || activity.timeline.length === 0 ? (
                    <p style={{ margin: '8px 0 0', font: '400 11.5px/1.5 Inter', color: 'var(--muted)' }}>
                      {lookup && !lookup.lead
                        ? 'No lead on file for this number yet.'
                        : 'Nothing yet — the first call or text will show up here.'}
                    </p>
                  ) : (
                    <div style={{ marginTop: 4 }}>
                      {activity.timeline.slice(0, 8).map((e) => {
                        const detail = activityDetail(e);
                        return (
                          <div
                            key={e.id}
                            style={{
                              display: 'flex',
                              alignItems: 'flex-start',
                              gap: 10,
                              padding: '10px 0',
                              borderBottom: '1px solid var(--line-soft)',
                            }}
                          >
                            <span
                              aria-hidden
                              style={{
                                display: 'inline-flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                flexShrink: 0,
                                width: 26,
                                height: 26,
                                borderRadius: 8,
                                background: 'var(--panel-2)',
                                color: activityColor(e),
                              }}
                            >
                              <Icon name={activityIcon(e)} size={13} />
                            </span>
                            <span style={{ display: 'flex', flexDirection: 'column', gap: 3, minWidth: 0, flex: 1 }}>
                              <span style={{ font: '600 12px/1.2 Inter' }}>{activityTitle(e)}</span>
                              {detail && (
                                <span
                                  style={{
                                    font: '400 11px/1.35 Inter',
                                    color: 'var(--muted)',
                                    overflow: 'hidden',
                                    textOverflow: 'ellipsis',
                                    whiteSpace: 'nowrap',
                                  }}
                                >
                                  {detail}
                                </span>
                              )}
                            </span>
                            <span
                              style={{ flexShrink: 0, paddingTop: 2, font: '500 10.5px/1 Inter', color: 'var(--muted-2)' }}
                            >
                              {stamp(e.at, now)}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* ── Tab bar, iPhone-style ──────────────────────────────────────── */}
      <nav
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4,1fr)',
          borderTop: '1px solid var(--line)',
          background: 'var(--bg)',
          paddingBottom: 2,
        }}
      >
        {(
          [
            ['inbox', 'Inbox', 'msg', unreadCount],
            ['recents', 'Recents', 'clock', missedCount],
            ['dial', 'Keypad', 'grid', 0],
            ['voicemail', 'Voicemail', 'voicemail', 0],
          ] as const
        ).map(([id, label, icon, badge]) => {
          const on = tab === id || (tab === 'lead' && backTo === id);
          return (
            <button
              key={id}
              type="button"
              onClick={() => {
                // Tapping Inbox again from a thread goes back to the list, like iOS.
                if (id === 'inbox' && tab === 'inbox') {
                  setThreadId(null);
                  setComposeTo(null);
                }
                go(id);
              }}
              style={{
                position: 'relative',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 3,
                height: 50,
                border: 'none',
                background: 'transparent',
                color: on ? 'var(--accent)' : 'var(--muted-2)',
                font: '600 10px/1 Inter',
              }}
            >
              <Icon name={icon} size={20} />
              {label}
              {badge > 0 && (
                <span
                  style={{
                    position: 'absolute',
                    top: 5,
                    left: '54%',
                    minWidth: 16,
                    height: 16,
                    padding: '0 4px',
                    borderRadius: 8,
                    background: 'var(--red)',
                    color: '#fff',
                    font: '700 9.5px/16px Inter',
                    textAlign: 'center',
                  }}
                >
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
            </button>
          );
        })}
      </nav>
    </div>
  );
}
