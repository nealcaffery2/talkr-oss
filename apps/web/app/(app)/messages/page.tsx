'use client';

/**
 * SMS inbox (design 1c): conversation list, thread, templates and attachments.
 * The thread is iMessage-accurate — bubbles with tails, delivery receipts,
 * typing dots — because that is the vocabulary every seller already reads.
 *
 * The list is not just a list of numbers any more. Every row carries who the
 * person is (seller, buyer, title, vendor), how hot they are, what the contact
 * status is, their tags and the rep who owns them, in the same colours the
 * Contacts table uses — a rep should be able to tell a hot seller from a title
 * company without opening the thread. The filter bar above it is URL-backed,
 * so a view survives a refresh and can be handed to a teammate.
 *
 * The composer picks which org number the text goes out from, renders merge
 * fields before anything leaves (docs/sms.md §6 merge grammar), counts segments
 * the way a carrier does — an emoji makes it UCS-2 at 70 characters — and can
 * insert emoji without pulling in a picker dependency.
 *
 * Endpoints, SSE stream, suppression and quiet-hours refusals are unchanged.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  ApiError,
  api,
  eventStreamUrl,
  CONTACT_STATUSES,
  CONTACT_TYPES,
  CONVERSATION_SORTS,
  TEMPERATURES,
  type ContactDto,
  type ContactStatus,
  type ContactType,
  type ConversationDto,
  type ConversationListDto,
  type ConversationListQuery,
  type ConversationSort,
  type MeDto,
  type MessageDto,
  type MessagePreviewInput,
  type MessageTemplateDto,
  type TeamMemberDto,
  type Temperature,
} from '@/lib/api';
import { useSoftphone } from '@/lib/softphone';
import { TopBar } from '@/components/TopBar';
import { Icon } from '@/components/Icon';
import { Avatar, Button, Eyebrow, FIELD, Select } from '@/components/ui';
import { AddContactButton, useIsKnownNumber } from '@/components/AddContact';
import { Bubble, TypingBubble } from '@/components/Bubble';
import {
  FilterChip,
  STATUS_LABEL,
  StatusMark,
  TEMP_LABEL,
  TYPE_LABEL,
  TagChip,
  TempDot,
  TemperatureBadge,
  TypeBadge,
  firstNonGsmChar,
  smsSegments,
} from '@/components/contacts';
import {
  MESSAGE_MERGE_FIELDS,
  MergeChips,
  MergePreview,
  TemplateManager,
  canManageTemplates,
  hasMergeFields,
  isActive,
  useMessagePreview,
} from '@/components/MessageTemplates';
import { MergeFieldHelp, MergeTextArea } from '@/components/MergeField';
import { EmojiButton, insertAtCaret } from '@/components/EmojiPicker';
import { formatPhone, toE164, tzTime, zoneForNumber } from '@/lib/time';

const RECEIPT: Record<string, string> = {
  queued: 'Queued',
  sending: 'Sending…',
  sent: 'Sent',
  delivered: 'Delivered',
  undelivered: 'Undelivered',
  failed: 'Failed',
};

/** Nothing reached the handset: the one thing a row must never hide. */
const FAILED_STATUSES = new Set(['failed', 'undelivered']);

/** One screen of threads; "Load more" widens the window rather than paging. */
const PAGE_SIZE = 40;

/**
 * The inbox row's second line: what was last said. An MMS with no text still
 * has to say something, or the row reads as an empty conversation.
 */
function preview(last: ConversationDto['last_message']): string {
  if (!last) return 'No messages yet';
  const body = last.body.trim();
  if (body) return body;
  if (last.media_count > 0) {
    return last.media_count === 1 ? 'Photo' : `${last.media_count} photos`;
  }
  return '';
}

/**
 * An MMS attachment. The design shows the photo, so we show the photo — but a
 * carrier media URL can be short-lived or need credentials we deliberately do
 * not put in the browser, and a broken image icon in a seller thread is worse
 * than no image. So it falls back to the labelled placeholder the moment the
 * load fails, and the thread never renders as damaged.
 */
type AttachmentKind = 'image' | 'video' | 'file';

/** A file the rep picked, already uploaded and waiting on the composer. */
interface PendingAttachment {
  url: string;
  previewUrl: string | null;
  name: string;
  kind: AttachmentKind;
}

/** Carrier MMS ceiling is ~5 MB per message; 3 MB per file matches the API. */
const ATTACHMENT_MAX_BYTES = 3 * 1024 * 1024;
/** Phone photos are 3–12 MB; carriers downscale anyway, so shrink client-side. */
const IMAGE_MAX_EDGE = 1600;

function kindFromType(contentType: string): AttachmentKind {
  if (contentType.startsWith('image/')) return 'image';
  if (contentType.startsWith('video/')) return 'video';
  return 'file';
}

/**
 * Inbound carrier URLs carry no extension and are always images in practice,
 * so only a telling extension moves a URL off the image path.
 */
function kindFromUrl(url: string): AttachmentKind {
  const path = url.split('?')[0]!.toLowerCase();
  if (/\.(mp4|3gp|3gpp|mov|m4v)$/.test(path)) return 'video';
  if (/\.(pdf|vcf|txt|csv|docx?|xlsx?)$/.test(path)) return 'file';
  return 'image';
}

async function shrinkImage(file: File): Promise<Blob> {
  if (file.type === 'image/gif') return file;
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, IMAGE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= 800 * 1024) {
    bitmap.close();
    return file;
  }
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    bitmap.close();
    return file;
  }
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
  return blob ?? file;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error ?? new Error('could not read file'));
    reader.onload = () => {
      const result = String(reader.result ?? '');
      resolve(result.slice(result.indexOf(',') + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function MmsImage({ url, mine }: { url: string; mine: boolean }) {
  const [failed, setFailed] = useState(false);
  const kind = kindFromUrl(url);
  const box = {
    width: 230,
    maxWidth: '100%',
    borderRadius: 14,
    background: mine ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.06)',
  } as const;

  if (kind === 'video') {
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption -- a seller's clip, no track exists
      <video controls preload="metadata" src={url} style={{ ...box, display: 'block', maxHeight: 260 }} />
    );
  }
  if (kind === 'file') {
    const name = decodeURIComponent(url.split('?')[0]!.split('/').pop() ?? 'file');
    return (
      <a
        href={url}
        target="_blank"
        rel="noreferrer"
        className="inline-flex items-center gap-2"
        style={{ ...box, width: 'auto', padding: '8px 12px', font: '600 11px/1 Inter', color: 'inherit', textDecoration: 'none' }}
      >
        <Icon name="image" size={14} />
        {name}
      </a>
    );
  }

  if (failed) {
    return (
      <span
        className="flex items-center justify-center gap-2"
        style={{
          ...box,
          height: 138,
          font: '600 10px/1 Inter',
          letterSpacing: '0.08em',
          textTransform: 'uppercase',
        }}
      >
        <Icon name="image" size={18} />
        Image
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- carrier-hosted, not ours to optimize
    <img
      src={url}
      alt="Attachment"
      onError={() => setFailed(true)}
      style={{ ...box, display: 'block', maxHeight: 260, objectFit: 'cover' }}
    />
  );
}

/** Same number, one key: "+15125550134", "15125550134" and "(512) 555-0134" all match. */
function numberKey(n: string): string {
  return n.replace(/\D/g, '').replace(/^1(?=\d{10}$)/, '');
}

/**
 * Who is the number in the "To" field of a brand-new thread? There is no
 * conversation row to read a name off yet, so it is looked up — and when
 * nobody owns it, saving it is one click away.
 */
function NewNumberIdentity({ number }: { number: string }) {
  const [settled, setSettled] = useState(number);
  useEffect(() => {
    const t = setTimeout(() => setSettled(number), 400);
    return () => clearTimeout(t);
  }, [number]);
  const { contact, loading, remember } = useIsKnownNumber(settled);

  if (settled.replace(/\D/g, '').length < 10 || loading) return null;
  if (contact) {
    return (
      <Link
        href={`/contacts/${contact.id}`}
        className="shrink-0 truncate"
        style={{ font: '600 11.5px/1 Inter', color: 'var(--accent)' }}
      >
        {contact.display_name}
      </Link>
    );
  }
  return (
    <AddContactButton phone={settled} labelClassName="max-sm:sr-only" onCreated={(c) => remember(c)} />
  );
}

function timeShort(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  const today = new Date().toDateString() === d.toDateString();
  return today
    ? d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}

/* ── URL filters ──────────────────────────────────────────────────────────── */

const SORT_LABEL: Record<ConversationSort, string> = {
  recent: 'Newest first',
  oldest: 'Oldest first',
  unread: 'Unread first',
  temperature: 'Hottest first',
};

type RangePreset = 'all' | 'today' | '7d' | '30d' | 'custom';

interface Filters {
  q: string;
  type: ContactType | null;
  temp: Temperature | null;
  status: ContactStatus | null;
  tag: string;
  user: string;
  unread: boolean;
  /**
   * YYYY-MM-DD, inclusive, in the rep's own day. The end of the range rides in
   * the URL as `until`, not `to`: `?to=<E.164>` is how Contacts' "Text" action
   * has always addressed a new thread, and a date filter must not eat it.
   */
  from: string;
  to: string;
  sort: ConversationSort;
}

function pick<T extends string>(list: readonly T[], value: string | null): T | null {
  return list.find((x) => x === value) ?? null;
}

function readFilters(p: URLSearchParams): Filters {
  return {
    q: p.get('q')?.trim() ?? '',
    type: pick(CONTACT_TYPES, p.get('type')),
    temp: pick(TEMPERATURES, p.get('temp')),
    status: pick(CONTACT_STATUSES, p.get('status')),
    tag: p.get('tag')?.trim() ?? '',
    user: p.get('user')?.trim() ?? '',
    unread: p.get('unread') === 'true',
    from: p.get('from')?.trim() ?? '',
    to: p.get('until')?.trim() ?? '',
    sort: pick(CONVERSATION_SORTS, p.get('sort')) ?? 'recent',
  };
}

function toQuery(f: Filters): ConversationListQuery {
  return {
    q: f.q || undefined,
    type: f.type ?? undefined,
    temperature: f.temp ?? undefined,
    status: f.status ?? undefined,
    tag: f.tag || undefined,
    user_id: f.user || undefined,
    unread: f.unread || undefined,
    from: f.from || undefined,
    to: f.to || undefined,
    sort: f.sort,
  };
}

/** How many filters are on — the count on the "Filters" toggle. Sort is not one. */
function filterCount(f: Filters): number {
  return [f.q, f.type, f.temp, f.status, f.tag, f.user, f.unread || null, f.from || f.to ? 'range' : null].filter(
    Boolean,
  ).length;
}

/** YYYY-MM-DD, `back` days ago, in the rep's own zone (not UTC). */
function dayString(back = 0): string {
  const d = new Date();
  d.setDate(d.getDate() - back);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const RANGES: Array<{ value: RangePreset; label: string; back: number | null }> = [
  { value: 'all', label: 'Any time', back: null },
  { value: 'today', label: 'Today', back: 0 },
  { value: '7d', label: 'Last 7 days', back: 6 },
  { value: '30d', label: 'Last 30 days', back: 29 },
];

function presetFor(f: Filters): RangePreset {
  if (!f.from && !f.to) return 'all';
  const today = dayString(0);
  for (const r of RANGES) {
    if (r.back === null) continue;
    if (f.from === dayString(r.back) && f.to === today) return r.value;
  }
  return 'custom';
}

/* ── Page ─────────────────────────────────────────────────────────────────── */

export default function MessagesPage() {
  // useSearchParams needs a Suspense boundary for the static shell.
  return (
    <Suspense fallback={null}>
      <MessagesScreen />
    </Suspense>
  );
}

function MessagesScreen() {
  const { authed, placeCall } = useSoftphone();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const paramsString = searchParams.toString();

  const filters = useMemo(() => readFilters(new URLSearchParams(paramsString)), [paramsString]);
  // Serialized so that selecting a thread (which also lives in the URL) does
  // not look like a new query and re-fetch the whole list.
  const queryKey = useMemo(() => JSON.stringify(toQuery(filters)), [filters]);
  const query = useMemo(() => JSON.parse(queryKey) as ConversationListQuery, [queryKey]);

  const [conversations, setConversations] = useState<ConversationDto[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<ConversationListDto['counts'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [pages, setPages] = useState(1);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [templates, setTemplates] = useState<MessageTemplateDto[]>([]);
  const [templatesLoading, setTemplatesLoading] = useState(true);
  const [templateId, setTemplateId] = useState('');
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [newNumber, setNewNumber] = useState('');
  const [now, setNow] = useState<number | null>(null);
  const [me, setMe] = useState<MeDto | null>(null);
  const [team, setTeam] = useState<TeamMemberDto[]>([]);
  const [fromId, setFromId] = useState('');
  // A phone shows the list or the thread, never both; a desk shows both and
  // ignores this. Opening a thread flips it, the back arrow flips it back.
  const [listOpen, setListOpen] = useState(true);
  // Templates live in a third column on a wide screen; below that, a sheet
  // above the composer.
  const [templatesOpen, setTemplatesOpen] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(() => filterCount(filters) > 0);
  // "Custom…" is a mode, not a range: a hand-picked week can happen to be the
  // last seven days, and the two date fields must not vanish when it does.
  const [customRange, setCustomRange] = useState(false);
  const [attachments, setAttachments] = useState<PendingAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // Numbers saved as contacts from this page, by number. The conversation list
  // is re-fetched on every inbound event and the server may not have re-linked
  // the thread yet, so the name we just gave a number is kept here as well.
  const [namedNumbers, setNamedNumbers] = useState<Record<string, string>>({});

  const selectedId = searchParams.get('conversation');
  const selectedIdRef = useRef<string | null>(selectedId);
  selectedIdRef.current = selectedId;
  // The open thread, cached: a filter (or marking it read under `unread=true`)
  // can drop its row from the list while the rep is still reading it.
  const [openThread, setOpenThread] = useState<ConversationDto | null>(null);

  const queryRef = useRef(query);
  queryRef.current = query;
  const pagesRef = useRef(pages);
  pagesRef.current = pages;

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // ── URL state ───────────────────────────────────────────────────────────
  const setParams = useCallback(
    (patch: Record<string, string | null>) => {
      const next = new URLSearchParams(paramsString);
      for (const [k, v] of Object.entries(patch)) {
        if (v) next.set(k, v);
        else next.delete(k);
      }
      const qs = next.toString();
      router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false });
    },
    [paramsString, pathname, router],
  );

  const openConversation = useCallback(
    (id: string | null) => {
      // `?to=` is a one-shot address from Contacts' "Text" action; the moment a
      // thread is open it is spent, and leaving it in the URL only confuses a
      // link that gets shared.
      setParams({ conversation: id, to: null });
      setListOpen(false);
      setError(null);
    },
    [setParams],
  );

  // Search is typed locally and pushed to the URL 300 ms after the last key.
  // The URL only flows back into the field when it changed elsewhere (back
  // button), so a slow router never clobbers what the rep is still typing.
  const [qInput, setQInput] = useState(filters.q);
  const pushedQ = useRef(filters.q);
  useEffect(() => {
    if (filters.q !== pushedQ.current) {
      pushedQ.current = filters.q;
      setQInput(filters.q);
    }
  }, [filters.q]);
  useEffect(() => {
    const value = qInput.trim();
    if (value === pushedQ.current) return;
    const t = setTimeout(() => {
      pushedQ.current = value;
      setParams({ q: value || null });
    }, 300);
    return () => clearTimeout(t);
  }, [qInput, setParams]);

  // ── Data ────────────────────────────────────────────────────────────────
  /**
   * One loader for both paths. A background refresh (SSE, a send, a read
   * receipt) is `silent`: it keeps the spinner off, keeps whatever the rep has
   * scrolled to, and — because it reads the filters from a ref — never fights
   * the filter state it was queued behind.
   */
  const loadConversations = useCallback((silent = false) => {
    const el = listRef.current;
    const scroll = el?.scrollTop ?? 0;
    if (!silent) setLoading(true);
    return api
      .listConversations({ ...queryRef.current, limit: PAGE_SIZE * pagesRef.current })
      .then((r) => {
        setConversations(r.conversations);
        setTotal(r.total);
        setCounts(r.counts);
        setListError(null);
        if (silent && el) requestAnimationFrame(() => { el.scrollTop = scroll; });
      })
      .catch((e: unknown) => {
        if (!silent) setListError(e instanceof Error ? e.message : 'Could not load conversations');
      })
      .finally(() => {
        if (!silent) setLoading(false);
      });
  }, []);

  const reloadTemplates = useCallback(() => {
    setTemplatesLoading(true);
    // Managers need the retired ones too; a rep only ever sees the live list.
    api
      .listMessageTemplates({ include_inactive: canManageTemplates(me?.role) })
      .then((r) => setTemplates(r.templates))
      .catch(() => undefined)
      .finally(() => setTemplatesLoading(false));
  }, [me?.role]);

  const refreshThread = useCallback((id: string) => {
    api
      .listConversationMessages(id)
      .then((r) => setMessages(r.messages))
      .catch(() => setMessages([]));
  }, []);

  /** The name a thread shows: the server's, else one saved here a moment ago. */
  const contactNameFor = useCallback(
    (c: ConversationDto): string | null => c.contact_name ?? namedNumbers[numberKey(c.their_number)] ?? null,
    [namedNumbers],
  );

  /** A number just became somebody: name it everywhere it appears, immediately. */
  const rememberContact = useCallback(
    (number: string, contact: ContactDto) => {
      setNamedNumbers((prev) => ({ ...prev, [numberKey(number)]: contact.display_name }));
      void loadConversations(true);
    },
    [loadConversations],
  );

  useEffect(() => {
    if (!authed) return;
    void loadConversations(false);
  }, [authed, query, pages, loadConversations]);

  useEffect(() => {
    if (!authed) return;
    api.getMe().then(setMe).catch(() => undefined);
    api.listTeam().then((r) => setTeam(r.members)).catch(() => setTeam([]));
  }, [authed]);

  useEffect(() => {
    if (!authed) return;
    reloadTemplates();
  }, [authed, reloadTemplates]);

  // A new filter view starts at the first page again.
  useEffect(() => setPages(1), [query]);

  // Live updates: the same SSE stream the softphone uses (docs/sms.md §7).
  useEffect(() => {
    if (!authed) return;
    const url = eventStreamUrl();
    if (!url) return;
    const source = new EventSource(url);
    const onMessageEvent = (raw: MessageEvent) => {
      try {
        const event = JSON.parse(raw.data) as { data?: { conversationId?: string } };
        void loadConversations(true);
        const current = selectedIdRef.current;
        if (current && event.data?.conversationId === current) refreshThread(current);
      } catch {
        /* ignore malformed */
      }
    };
    source.addEventListener('message.received', onMessageEvent);
    source.addEventListener('message.updated', onMessageEvent);
    source.addEventListener('conversation.updated', onMessageEvent);
    return () => source.close();
  }, [authed, loadConversations, refreshThread]);

  // The design never shows an empty centre pane — landing on the inbox opens
  // the newest thread. Only on first load, so hitting "New" still clears it.
  const autoSelected = useRef(false);

  // Arriving with ?to=<E.164> (Contacts' "Text" action) opens that number:
  // its thread when one exists, otherwise a fresh composer addressed to it.
  const [pendingTo, setPendingTo] = useState<string | null>(null);
  useEffect(() => {
    const to = new URLSearchParams(window.location.search).get('to')?.trim();
    if (!to) return;
    autoSelected.current = true;
    setPendingTo(to);
    setNewNumber(to);
    setListOpen(false);
  }, []);
  useEffect(() => {
    if (!pendingTo || conversations.length === 0) return;
    const existing = conversations.find((c) => c.their_number === pendingTo);
    if (existing) {
      openConversation(existing.id);
      setNewNumber('');
    } else {
      setParams({ to: null });
    }
    setPendingTo(null);
  }, [pendingTo, conversations, openConversation, setParams]);

  useEffect(() => {
    if (autoSelected.current || selectedId || conversations.length === 0 || filterCount(filters) > 0) return;
    autoSelected.current = true;
    openConversation(conversations[0]!.id);
    setListOpen(true);
  }, [conversations, selectedId, filters, openConversation]);

  useEffect(() => {
    if (selectedId) autoSelected.current = true;
  }, [selectedId]);

  useEffect(() => {
    if (!selectedId) {
      setMessages([]);
      setOpenThread(null);
      return;
    }
    refreshThread(selectedId);
    void api.markConversationRead(selectedId).then(() => loadConversations(true)).catch(() => undefined);
  }, [selectedId, refreshThread, loadConversations]);

  // Keep the open thread's header alive even when its row leaves the filtered
  // list. A deep link (/messages?conversation=…) into a filtered view has
  // nothing to read it off, so that one case asks the server unfiltered.
  useEffect(() => {
    if (!selectedId) return;
    const found = conversations.find((c) => c.id === selectedId);
    if (found) {
      setOpenThread(found);
      return;
    }
    if (openThread?.id === selectedId) return;
    let cancelled = false;
    api
      .listConversations({ limit: 200 })
      .then((r) => {
        const match = r.conversations.find((c) => c.id === selectedId) ?? null;
        if (!cancelled && match) setOpenThread(match);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [selectedId, conversations, openThread?.id]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages.length]);

  // The composer grows with the draft (a template is three lines) and stops at
  // five, so a long one scrolls instead of eating the thread.
  useEffect(() => {
    const el = composerRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [draft]);

  const selected = openThread && openThread.id === selectedId ? openThread : null;
  const selectedName = selected ? contactNameFor(selected) : null;
  const selectedTemplate = templates.find((t) => t.id === templateId) ?? null;
  const theirZone = selected ? zoneForNumber(selected.their_number) : null;
  const canManage = canManageTemplates(me?.role);
  const pickerTemplates = useMemo(
    () => (canManage ? templates : templates.filter(isActive)),
    [templates, canManage],
  );

  // The from-number follows the thread: whichever org line is already carrying
  // it, or the rep's default on a brand-new one. A rep's manual pick stands
  // until they open a different thread.
  const ourNumber = selected?.our_number ?? null;
  useEffect(() => {
    if (!me) return;
    if (ourNumber) {
      const match = me.org_numbers.find((n) => n.phone_e164 === ourNumber);
      setFromId(match?.id ?? '');
    } else {
      setFromId(me.default_phone_number_id ?? me.org_numbers[0]?.id ?? '');
    }
  }, [me, selectedId, ourNumber]);

  const fromNumber = me?.org_numbers.find((n) => n.id === fromId) ?? null;

  // ── Composer ────────────────────────────────────────────────────────────
  // A template chosen and left untouched goes by id, so its use count moves;
  // edit a character and it becomes an ordinary body.
  const templateIntact = selectedTemplate !== null && selectedTemplate.body === draft;
  const previewInput = useMemo<MessagePreviewInput>(() => {
    const target = selectedId
      ? { conversation_id: selectedId }
      : newNumber.replace(/\D/g, '').length >= 10
        ? { to_number: toE164(newNumber) }
        : {};
    return templateIntact && selectedTemplate
      ? { template_id: selectedTemplate.id, ...target }
      : { body: draft, ...target };
  }, [draft, newNumber, selectedId, selectedTemplate, templateIntact]);
  // Only ask when there is something to render: plain prose needs no round trip.
  const previewState = useMessagePreview(previewInput, hasMergeFields(draft));
  const outgoing = previewState.preview?.body ?? draft;
  const seg = smsSegments(outgoing);
  // A GSM message of this length would have fitted in one part, so the extra
  // part is the emoji's doing (or a smart dash's) — worth saying, because it
  // doubles what the carrier charges for the same sentence.
  const split = seg.encoding === 'ucs2' && seg.segments > 1 && seg.chars <= 160;
  const culprit = seg.encoding === 'ucs2' ? firstNonGsmChar(outgoing) : null;
  const culpritLabel = culprit === null ? '' : /\p{Extended_Pictographic}/u.test(culprit) ? 'an emoji' : `“${culprit}”`;

  /**
   * What the `/` picker and the "?" guide show beside each field: the real
   * seller, not a stand-in. The server's own render is the answer wherever it
   * has one — it is the same map the send will use — and until it replies (it
   * is only asked once a body has braces in it) the row and the session fill
   * in what they already know. A field the server returns empty keeps the
   * page's value rather than blanking it, because `rep_name` and `org_name`
   * do not depend on who is being written to.
   */
  const composerValues = useMemo<Record<string, string>>(() => {
    const out: Record<string, string> = {};
    const put = (field: string, value: string | null | undefined) => {
      const v = value?.trim();
      if (v) out[field] = v;
    };
    put('first_name', selectedName?.split(/\s+/)[0]);
    put('name', selectedName);
    put('contact_name', selectedName);
    put('city', selected?.lead_city);
    put('state', selected?.lead_state);
    put('phone', selected ? formatPhone(selected.their_number) : null);
    put('company', me?.org?.name);
    put('org_name', me?.org?.name);
    put('rep_name', me?.display_name);
    put('rep_first_name', me?.display_name?.split(/\s+/)[0]);
    for (const [field, value] of Object.entries(previewState.preview?.merge_fields ?? {})) put(field, value);
    return out;
  }, [selectedName, selected, me, previewState.preview]);

  const insertIntoDraft = (text: string) => {
    const next = insertAtCaret(composerRef.current, draft, text);
    setDraft(next);
    if (selectedTemplate && next !== selectedTemplate.body) setTemplateId('');
  };

  async function send() {
    if (sending) return;
    setError(null);
    setSending(true);
    try {
      const input = selectedId ? { conversation_id: selectedId } : { to_number: newNumber.trim() };
      const mediaUrls = attachments.map((a) => a.url);
      const result = await api.sendMessage({
        ...input,
        ...(templateIntact && selectedTemplate
          ? { template_id: selectedTemplate.id, lead_id: selected?.lead_id ?? undefined }
          : { body: draft }),
        ...(mediaUrls.length > 0 ? { media_urls: mediaUrls } : {}),
        ...(fromId ? { from_phone_number_id: fromId } : {}),
      });
      setDraft('');
      setTemplateId('');
      setNewNumber('');
      clearAttachments();
      openConversation(result.conversation_id);
      refreshThread(result.conversation_id);
      void loadConversations(true);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'suppressed') {
        setError('This number has opted out of SMS. Sending is blocked.');
      } else if (err instanceof ApiError && err.code === 'quiet_hours') {
        setError('Outside your organization’s texting window (quiet hours).');
      } else if (err instanceof ApiError && err.code === 'invalid_caller_id') {
        setError('That number can’t send for this org any more. Pick another line above.');
      } else {
        setError((err as Error).message);
      }
    } finally {
      setSending(false);
    }
  }

  async function addFiles(files: FileList) {
    setError(null);
    setUploading(true);
    try {
      for (const file of Array.from(files).slice(0, Math.max(0, 10 - attachments.length))) {
        const kind = kindFromType(file.type);
        let blob: Blob = file;
        if (kind === 'image') {
          try {
            blob = await shrinkImage(file);
          } catch {
            throw new Error(`Couldn't read ${file.name}. Use a JPEG or PNG (HEIC is not supported here).`);
          }
        }
        if (blob.size > ATTACHMENT_MAX_BYTES) {
          throw new Error(`${file.name} is over 3 MB. Carriers reject larger MMS attachments.`);
        }
        const uploaded = await api.uploadMedia({
          content_type: blob.type || file.type,
          data_base64: await blobToBase64(blob),
          filename: file.name,
        });
        setAttachments((cur) => [
          ...cur,
          {
            url: uploaded.url,
            previewUrl: kind === 'image' ? URL.createObjectURL(blob) : null,
            name: file.name,
            kind,
          },
        ]);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUploading(false);
    }
  }

  function removeAttachment(url: string) {
    setAttachments((cur) => {
      const gone = cur.find((a) => a.url === url);
      if (gone?.previewUrl) URL.revokeObjectURL(gone.previewUrl);
      return cur.filter((a) => a.url !== url);
    });
  }

  function clearAttachments() {
    setAttachments((cur) => {
      for (const a of cur) if (a.previewUrl) URL.revokeObjectURL(a.previewUrl);
      return [];
    });
  }

  if (!authed) {
    return (
      <p className="p-6" style={{ font: '400 13px/1.5 Inter', color: 'var(--muted)' }}>
        Not signed in — open <a href="/login" style={{ color: 'var(--accent)' }}>Account</a>.
      </p>
    );
  }

  const destinationOk = Boolean(selectedId || newNumber.trim());
  const canSend = !uploading && destinationOk && (draft.trim().length > 0 || attachments.length > 0);
  const active = filterCount(filters);
  const rangePreset: RangePreset = customRange && (filters.from || filters.to) ? 'custom' : presetFor(filters);
  const unreadTotal = counts?.unread ?? conversations.reduce((sum, c) => sum + c.unread_count, 0);
  // "All" carries the real row count only while no type is chosen: the type
  // buckets leave out threads with no contact behind them, so summing them
  // would quietly disagree with the list underneath.
  const allCount = filters.type ? undefined : total;
  const clearFilters = () => {
    setQInput('');
    pushedQ.current = '';
    setParams({ q: null, type: null, temp: null, status: null, tag: null, user: null, unread: null, from: null, until: null, sort: null });
  };

  const templatePanel = (
    <TemplateManager
      templates={pickerTemplates}
      loading={templatesLoading}
      canManage={canManage}
      reload={reloadTemplates}
      selectedId={templateId || null}
      target={selectedId ? { conversation_id: selectedId } : undefined}
      onUse={(t) => {
        setTemplateId(t.id);
        setDraft(t.body);
        setTemplatesOpen(false);
        requestAnimationFrame(() => composerRef.current?.focus());
      }}
    />
  );

  return (
    <>
      <TopBar
        title="Messages"
        subtitle={`${total.toLocaleString()} conversation${total === 1 ? '' : 's'}${active ? ' matching' : ''}${unreadTotal ? ` · ${unreadTotal} unread` : ''}`}
      />

      <div className="grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[320px_1fr] xl:grid-cols-[340px_1fr_320px]">
        {/* ── Threads ───────────────────────────────────────────────────── */}
        <div
          className={`${listOpen ? 'flex' : 'hidden'} min-h-0 flex-col md:flex md:border-r md:border-[var(--line)]`}
          style={{ background: 'var(--panel)' }}
        >
          <div className="flex flex-col gap-2 px-3 py-3" style={{ borderBottom: '1px solid var(--line)' }}>
            <div className="flex items-center gap-2">
              <Eyebrow className="mr-auto">Conversations</Eyebrow>
              <Button
                tone="ghost"
                style={{ padding: '6px 10px', font: '600 11px/1 Inter' }}
                onClick={() => {
                  openConversation(null);
                  setMessages([]);
                  setDraft('');
                  setTemplateId('');
                }}
              >
                New
              </Button>
            </div>

            {/* Search + the filter toggle: everything else folds away, because
                this column is 340px on a desk and the whole screen on a phone. */}
            <div className="flex items-center gap-2" style={{ ...FIELD, padding: '0 10px' }}>
              <Icon name="search" size={14} style={{ color: 'var(--muted-2)', flexShrink: 0 }} />
              <input
                value={qInput}
                onChange={(e) => setQInput(e.target.value)}
                placeholder="Search name, number, message"
                aria-label="Search conversations"
                className="min-w-0 flex-1 bg-transparent outline-none"
                style={{ font: '500 12.5px/1 Inter', padding: '8px 0' }}
              />
              {qInput && (
                <button type="button" aria-label="Clear search" onClick={() => setQInput('')} style={{ color: 'var(--muted-2)', cursor: 'pointer' }}>
                  <Icon name="x" size={13} />
                </button>
              )}
            </div>

            <div className="flex flex-wrap items-center gap-1.5">
              <FilterChip active={filtersOpen} onClick={() => setFiltersOpen((v) => !v)} count={active || undefined}>
                <Icon name="filter" size={11} />
                Filters
              </FilterChip>
              <FilterChip active={filters.unread} onClick={() => setParams({ unread: filters.unread ? null : 'true' })} count={counts?.unread}>
                Unread
              </FilterChip>
              {active > 0 && (
                <button
                  type="button"
                  onClick={clearFilters}
                  className="inline-flex items-center gap-1"
                  style={{ font: '600 11px/1 Inter', color: 'var(--accent)', cursor: 'pointer', padding: '6px 4px' }}
                >
                  <Icon name="x" size={11} strokeWidth={2.5} />
                  Clear all
                </button>
              )}
            </div>

            {filtersOpen && (
              <div className="flex flex-col gap-2 pt-0.5">
                <div className="flex flex-wrap items-center gap-1.5">
                  <FilterChip active={!filters.type} onClick={() => setParams({ type: null })} count={allCount}>
                    All
                  </FilterChip>
                  {CONTACT_TYPES.map((t) => (
                    <FilterChip
                      key={t}
                      active={filters.type === t}
                      onClick={() => setParams({ type: filters.type === t ? null : t })}
                      count={counts ? (counts.by_type[t] ?? 0) : undefined}
                    >
                      {TYPE_LABEL[t]}
                    </FilterChip>
                  ))}
                </div>

                <div className="grid gap-1.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))' }}>
                  <span className="inline-flex min-w-0 items-center gap-2" style={{ ...FIELD, padding: '0 0 0 10px' }}>
                    {filters.temp ? (
                      <TempDot temperature={filters.temp} />
                    ) : (
                      <span style={{ width: 8, height: 8, borderRadius: '50%', border: '1.5px solid var(--muted-2)', display: 'inline-block', flexShrink: 0 }} aria-hidden />
                    )}
                    <select
                      value={filters.temp ?? ''}
                      onChange={(e) => setParams({ temp: e.target.value || null })}
                      aria-label="Temperature"
                      className="min-w-0 flex-1"
                      style={{ border: 'none', background: 'transparent', padding: '8px 6px 8px 0', font: '500 12px/1 Inter', color: 'var(--text)', outline: 'none' }}
                    >
                      <option value="">Any temperature</option>
                      {TEMPERATURES.map((t) => (
                        <option key={t} value={t}>
                          {TEMP_LABEL[t]}
                          {counts?.by_temperature[t] ? ` (${counts.by_temperature[t]})` : ''}
                        </option>
                      ))}
                    </select>
                  </span>

                  <Select
                    value={filters.status ?? ''}
                    onChange={(e) => setParams({ status: e.target.value || null })}
                    aria-label="Contact status"
                    style={{ padding: '8px 10px', font: '500 12px/1 Inter' }}
                  >
                    <option value="">Any status</option>
                    {CONTACT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABEL[s]}
                      </option>
                    ))}
                  </Select>

                  <TagFilter value={filters.tag} onChange={(tag) => setParams({ tag: tag || null })} />

                  {team.length > 0 && (
                    <Select
                      value={filters.user}
                      onChange={(e) => setParams({ user: e.target.value || null })}
                      aria-label="Rep"
                      style={{ padding: '8px 10px', font: '500 12px/1 Inter' }}
                    >
                      <option value="">Any rep</option>
                      {team.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.display_name}
                        </option>
                      ))}
                    </Select>
                  )}

                  <Select
                    value={rangePreset}
                    onChange={(e) => {
                      const value = e.target.value as RangePreset;
                      setCustomRange(value === 'custom');
                      if (value === 'custom') {
                        if (!filters.from && !filters.to) setParams({ from: dayString(6), until: dayString(0) });
                        return;
                      }
                      const range = RANGES.find((r) => r.value === value);
                      setParams({
                        from: range && range.back !== null ? dayString(range.back) : null,
                        until: range && range.back !== null ? dayString(0) : null,
                      });
                    }}
                    aria-label="Date range"
                    style={{ padding: '8px 10px', font: '500 12px/1 Inter' }}
                  >
                    {RANGES.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                    <option value="custom">Custom…</option>
                  </Select>

                  <Select
                    value={filters.sort}
                    onChange={(e) => setParams({ sort: e.target.value === 'recent' ? null : e.target.value })}
                    aria-label="Sort"
                    style={{ padding: '8px 10px', font: '500 12px/1 Inter' }}
                  >
                    {CONVERSATION_SORTS.map((s) => (
                      <option key={s} value={s}>
                        {SORT_LABEL[s]}
                      </option>
                    ))}
                  </Select>
                </div>

                {rangePreset === 'custom' && (
                  <div className="flex flex-wrap items-center gap-1.5">
                    <input
                      type="date"
                      value={filters.from}
                      max={filters.to || undefined}
                      onChange={(e) => setParams({ from: e.target.value || null })}
                      aria-label="From date"
                      style={{ ...FIELD, padding: '7px 9px', font: '500 11.5px/1 Inter' }}
                    />
                    <span style={{ font: '500 11px/1 Inter', color: 'var(--muted-2)' }}>to</span>
                    <input
                      type="date"
                      value={filters.to}
                      min={filters.from || undefined}
                      onChange={(e) => setParams({ until: e.target.value || null })}
                      aria-label="To date"
                      style={{ ...FIELD, padding: '7px 9px', font: '500 11.5px/1 Inter' }}
                    />
                  </div>
                )}
              </div>
            )}
          </div>

          <div ref={listRef} className="min-h-0 flex-1 overflow-auto">
            {listError && (
              <p className="p-4" style={{ font: '400 12px/1.5 Inter', color: 'var(--red)' }}>
                {listError}
              </p>
            )}

            {loading && conversations.length === 0 && (
              <p className="p-4" style={{ font: '400 12px/1.5 Inter', color: 'var(--muted-2)' }}>
                Loading conversations…
              </p>
            )}

            {!loading && conversations.length === 0 && (
              <div className="flex flex-col items-start gap-2 p-4">
                <p style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>
                  {active ? 'No conversations match these filters.' : 'No conversations yet.'}
                </p>
                {active > 0 && (
                  <Button tone="ghost" style={{ padding: '7px 10px', font: '600 11.5px/1 Inter' }} onClick={clearFilters}>
                    Clear all filters
                  </Button>
                )}
              </div>
            )}

            {conversations.map((c) => (
              <ConversationRow
                key={c.id}
                c={c}
                now={now}
                name={contactNameFor(c)}
                active={c.id === selectedId}
                onOpen={() => openConversation(c.id)}
                onNamed={(contact) => rememberContact(c.their_number, contact)}
              />
            ))}

            {conversations.length > 0 && conversations.length < total && (
              <div className="p-3">
                <Button
                  tone="ghost"
                  className="w-full"
                  style={{ padding: '8px 10px', font: '600 11.5px/1 Inter' }}
                  onClick={() => setPages((p) => p + 1)}
                  disabled={loading}
                >
                  {loading ? 'Loading…' : `Load ${Math.min(PAGE_SIZE, total - conversations.length)} more`}
                </Button>
              </div>
            )}
          </div>
        </div>

        {/* ── Thread ────────────────────────────────────────────────────── */}
        <div className={`${listOpen ? 'hidden' : 'flex'} min-h-0 flex-col md:flex`} style={{ background: 'var(--panel)' }}>
          <div className="flex flex-col gap-2 px-3 py-3 md:px-5" style={{ borderBottom: '1px solid var(--line)' }}>
            <div className="flex items-center gap-2.5">
              <button
                type="button"
                aria-label="Back to conversations"
                onClick={() => setListOpen(true)}
                className="-ml-1 inline-flex h-8 w-8 shrink-0 items-center justify-center md:hidden"
                style={{ color: 'var(--accent)', cursor: 'pointer' }}
              >
                <Icon name="chevron-left" size={20} strokeWidth={2.4} />
              </button>
              {selected ? (
                <>
                  <Avatar name={selectedName ?? selected.their_number} size={34} />
                  <div className="mr-auto flex min-w-0 flex-col gap-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate" style={{ font: '700 13.5px/1 Inter' }}>
                        {selectedName ?? formatPhone(selected.their_number)}
                      </span>
                      {selected.contact_type && <TypeBadge type={selected.contact_type} />}
                      {selected.temperature && (
                        <TemperatureBadge
                          temperature={selected.temperature}
                          score={selected.temperature_score ?? 0}
                        />
                      )}
                    </div>
                    <div className="truncate" style={{ font: '500 11px/1 Inter', color: 'var(--muted)' }}>
                      {formatPhone(selected.their_number)}
                      {theirZone && now !== null ? ` · ${tzTime(theirZone, now)} local` : ''}
                      {selected.assigned_user_name ? ` · ${selected.assigned_user_name}` : ''}
                    </div>
                  </div>
                  {!selectedName && (
                    <AddContactButton
                      phone={selected.their_number}
                      labelClassName="max-sm:sr-only"
                      onCreated={(contact) => rememberContact(selected.their_number, contact)}
                    />
                  )}
                  <Button tone="ghost" onClick={() => void placeCall({ to_number: selected.their_number })}>
                    <Icon name="phone" size={14} />
                    <span className="hidden sm:inline">Call</span>
                  </Button>
                </>
              ) : (
                <div className="flex flex-1 items-center gap-2">
                  <Eyebrow>To</Eyebrow>
                  <input
                    value={newNumber}
                    onChange={(e) => setNewNumber(e.target.value)}
                    placeholder="+15125550134"
                    inputMode="tel"
                    autoComplete="tel"
                    aria-label="New message recipient"
                    className="min-w-0 flex-1 bg-transparent outline-none"
                    style={{ font: '600 13px/1 Inter' }}
                  />
                  <NewNumberIdentity number={newNumber} />
                </div>
              )}
            </div>

            {/* Which of the org's lines the seller sees. It defaults to the one
                already carrying the thread, because switching mid-conversation
                starts a second thread on the seller's phone. */}
            {me && me.org_numbers.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <Eyebrow>From</Eyebrow>
                <select
                  value={fromId}
                  onChange={(e) => setFromId(e.target.value)}
                  aria-label="Send from"
                  className="min-w-0 outline-none"
                  style={{
                    border: '1px solid var(--line)',
                    borderRadius: 'var(--r-btn)',
                    padding: '6px 8px',
                    font: '500 11.5px/1 Inter',
                    background: 'var(--panel)',
                    maxWidth: '100%',
                  }}
                >
                  {me.org_numbers.map((n) => (
                    <option key={n.id} value={n.id}>
                      {formatPhone(n.phone_e164)}
                      {n.label ? ` · ${n.label}` : ''}
                      {ourNumber === n.phone_e164 ? ' · this thread' : ''}
                    </option>
                  ))}
                </select>
                {/* On a phone the sentence takes the next line rather than a
                    four-word-wide column beside the select. */}
                <span className="basis-full sm:min-w-0 sm:flex-1 sm:basis-auto" style={{ font: '400 10.5px/1.4 Inter', color: 'var(--muted-2)' }}>
                  {fromNumber && ourNumber && fromNumber.phone_e164 !== ourNumber
                    ? `Changing this changes the number the seller sees — the reply lands in a new thread from ${formatPhone(fromNumber.phone_e164)}.`
                    : 'The number the seller sees, and where their reply comes back.'}
                </span>
              </div>
            )}
          </div>

          <div className="flex min-h-0 flex-1 flex-col overflow-auto px-3 pb-2 pt-4 md:px-6">
            {selected && messages.length === 0 && (
              <p className="self-center" style={{ font: '400 11px/1 Inter', color: 'var(--muted-2)' }}>
                No messages in this thread yet.
              </p>
            )}
            {!selected && (
              <p className="self-center" style={{ font: '400 12px/1.6 Inter', color: 'var(--muted)' }}>
                Pick a conversation, or enter a number above to start a new one.
              </p>
            )}

            {messages.map((m, i) => {
              const mine = m.direction === 'outbound';
              const next = messages[i + 1];
              // Only the last message of a run carries the tail, as on iOS.
              const tail = !next || next.direction !== m.direction;
              return (
                <Bubble
                  key={m.id}
                  mine={mine}
                  tail={tail}
                  maxWidth="min(480px, 78%)"
                  receipt={mine ? `${RECEIPT[m.status] ?? m.status} ${timeShort(m.sent_at ?? m.created_at)}` : undefined}
                >
                  {m.media_urls.length > 0 && (
                    <span className="mb-2 flex flex-col gap-1.5">
                      {m.media_urls.map((url) => (
                        <MmsImage key={url} url={url} mine={mine} />
                      ))}
                    </span>
                  )}
                  {m.body}
                </Bubble>
              );
            })}
            {/* Inbound-in-flight indicator; the platform has no typing signal,
                so this shows only while a send of ours is in flight. */}
            {sending && <TypingBubble />}
            <div ref={bottomRef} />
          </div>

          {error && (
            <p className="px-6 pb-2" style={{ font: '400 11.5px/1.4 Inter', color: 'var(--red)' }}>
              {error}
            </p>
          )}

          {templatesOpen && (
            <div
              className="flex max-h-64 flex-col overflow-auto px-3 py-3 xl:hidden"
              style={{ borderTop: '1px solid var(--line)', background: 'var(--bg)' }}
            >
              <div className="flex justify-end">
                <button
                  type="button"
                  onClick={() => setTemplatesOpen(false)}
                  style={{ font: '600 11px/1 Inter', color: 'var(--accent)', cursor: 'pointer' }}
                >
                  Close
                </button>
              </div>
              {templatePanel}
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--line)', background: 'var(--bg)' }}>
            {(attachments.length > 0 || uploading) && (
              <div className="flex flex-wrap items-center gap-2.5 px-3 pt-3 md:px-6">
                {attachments.map((a) => (
                  <span
                    key={a.url}
                    className="relative inline-flex items-center gap-2"
                    style={{
                      border: '1px solid var(--line)',
                      borderRadius: 10,
                      background: 'var(--panel)',
                      padding: a.previewUrl ? 3 : '7px 10px',
                      font: '500 11px/1 Inter',
                    }}
                  >
                    {a.previewUrl ? (
                      // eslint-disable-next-line @next/next/no-img-element -- local object URL
                      <img
                        src={a.previewUrl}
                        alt={a.name}
                        style={{ width: 52, height: 52, objectFit: 'cover', borderRadius: 8, display: 'block' }}
                      />
                    ) : (
                      <span className="inline-flex items-center gap-1.5">
                        <Icon name={a.kind === 'video' ? 'play' : 'image'} size={13} />
                        {a.name}
                      </span>
                    )}
                    <button
                      type="button"
                      aria-label={`Remove ${a.name}`}
                      onClick={() => removeAttachment(a.url)}
                      className="inline-flex h-5 w-5 items-center justify-center rounded-full"
                      style={{ position: 'absolute', top: -6, right: -6, background: '#1c1c1e', color: '#fff', cursor: 'pointer' }}
                    >
                      <Icon name="x" size={11} strokeWidth={2.5} />
                    </button>
                  </span>
                ))}
                {uploading && (
                  <span style={{ font: '500 11px/1 Inter', color: 'var(--muted-2)' }}>Uploading…</span>
                )}
              </div>
            )}

            {/* What the seller will read, when it differs from what is typed. */}
            {(hasMergeFields(draft) || (previewState.preview?.unknown_fields.length ?? 0) > 0) && (
              <div className="px-3 pt-3 md:px-6">
                <MergePreview state={previewState} raw={draft} />
              </div>
            )}

            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 px-3 pt-2 md:px-6">
              <MergeChips onInsert={insertIntoDraft} />
              <MergeFieldHelp fields={MESSAGE_MERGE_FIELDS} values={composerValues} />
              {seg.chars > 0 && (
                <span
                  className="ml-auto"
                  style={{ font: '500 10.5px/1.4 Inter', color: split || seg.segments > 3 ? 'var(--amber)' : 'var(--muted-2)' }}
                >
                  {seg.chars} chars · {seg.segments} segment{seg.segments === 1 ? '' : 's'}
                  {split
                    ? ` · ${culpritLabel} makes it UCS-2 — 70 per segment instead of 160`
                    : seg.encoding === 'ucs2'
                      ? ` · UCS-2 (${culpritLabel}) — 70 per segment`
                      : ''}
                </span>
              )}
            </div>

            <div className="flex items-end gap-2 px-3 pb-3 pt-2 md:gap-2.5 md:px-6 md:pb-4">
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*,video/mp4,video/3gpp,application/pdf,text/vcard"
                multiple
                hidden
                onChange={(e) => {
                  if (e.target.files && e.target.files.length > 0) void addFiles(e.target.files);
                  e.target.value = '';
                }}
              />
              <button
                type="button"
                aria-label="Attach photo or file"
                title="Attach photo, video or file (MMS)"
                disabled={uploading || attachments.length >= 10}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full"
                style={{
                  border: '1px solid var(--line)',
                  background: attachments.length > 0 ? 'var(--accent-soft)' : 'var(--panel)',
                  color: attachments.length > 0 ? 'var(--accent)' : 'var(--muted)',
                  cursor: 'pointer',
                }}
              >
                <Icon name="camera" size={16} />
              </button>

              <EmojiButton onPick={insertIntoDraft} />

              <button
                type="button"
                aria-label="Templates"
                aria-pressed={templatesOpen}
                onClick={() => setTemplatesOpen((v) => !v)}
                className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full xl:hidden"
                style={{
                  border: '1px solid var(--line)',
                  background: templatesOpen ? 'var(--accent-soft)' : 'var(--panel)',
                  color: templatesOpen ? 'var(--accent)' : 'var(--muted)',
                  cursor: 'pointer',
                }}
              >
                <Icon name="template" size={16} />
              </button>

              <div
                className="flex flex-1 items-end gap-2 px-3.5 py-1.5"
                style={{ minHeight: 36, border: '1px solid #d1d1d6', borderRadius: 19, background: 'var(--panel)' }}
              >
                {/* MergeTextArea, not a bare textarea: `/` at a word boundary
                    opens the field picker, and while that list is open it keeps
                    Enter and Tab — so Enter still sends, except when the rep is
                    choosing a field, which is exactly the moment it must not.
                    The chips and the emoji picker keep inserting through
                    composerRef, which it fills. */}
                <div className="min-w-0 flex-1">
                  <MergeTextArea
                    textareaRef={composerRef}
                    value={draft}
                    rows={1}
                    onChange={(next) => {
                      setDraft(next);
                      if (selectedTemplate && next !== selectedTemplate.body) setTemplateId('');
                    }}
                    values={composerValues}
                    fields={MESSAGE_MERGE_FIELDS}
                    onKeyDown={(e) => {
                      // Enter sends, Shift+Enter breaks the line — a text is one
                      // paragraph nine times in ten.
                      if (e.key === 'Enter' && !e.shiftKey && canSend) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                    placeholder={attachments.length > 0 ? 'Add a caption (optional)' : 'Text message'}
                    aria-label="Message"
                    // The composer's own bubble draws the border; the field
                    // inside it is only text.
                    style={{
                      border: 'none',
                      borderRadius: 0,
                      background: 'transparent',
                      font: '400 14px/1.35 Inter',
                      lineHeight: 1.35,
                      resize: 'none',
                      maxHeight: 120,
                      padding: '4px 0',
                    }}
                  />
                </div>
                {selectedTemplate && (
                  <button
                    type="button"
                    onClick={() => {
                      setTemplateId('');
                      setDraft('');
                    }}
                    aria-label="Clear template"
                    style={{ color: 'var(--muted-2)', cursor: 'pointer', paddingBottom: 4 }}
                  >
                    <Icon name="x" size={15} />
                  </button>
                )}
              </div>

              <Button
                tone="accent"
                disabled={!canSend || sending}
                onClick={() => void send()}
                style={{ borderRadius: '50%', width: 36, height: 36, padding: 0 }}
              >
                <Icon name="send" size={18} strokeWidth={2.4} />
              </Button>
            </div>
          </div>
        </div>

        {/* ── Templates ─────────────────────────────────────────────────── */}
        <div
          className="hidden min-h-0 flex-col gap-4 overflow-auto p-4 xl:flex xl:border-l xl:border-[var(--line)]"
          style={{ background: 'var(--panel)' }}
        >
          {templatePanel}
        </div>
      </div>
    </>
  );
}

/* ── Row ──────────────────────────────────────────────────────────────────── */

function ConversationRow({
  c,
  now,
  name,
  active,
  onOpen,
  onNamed,
}: {
  c: ConversationDto;
  now: number | null;
  name: string | null;
  active: boolean;
  onOpen: () => void;
  onNamed: (contact: ContactDto) => void;
}) {
  const zone = zoneForNumber(c.their_number);
  const status = pick(CONTACT_STATUSES, c.contact_status);
  const failed = c.last_message !== null && FAILED_STATUSES.has(c.last_message.status);
  const place = [c.lead_city, c.lead_state].filter(Boolean).join(', ');

  return (
    // The row is a button, so the Add-contact affordance is a sibling rather
    // than a nested button.
    <div
      className="group flex items-start"
      style={{
        borderBottom: '1px solid var(--panel-2)',
        borderLeft: `2px solid ${active ? 'var(--accent)' : 'transparent'}`,
        background: active ? 'var(--accent-soft)' : 'var(--panel)',
      }}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 gap-2.5 py-3 pl-4 pr-2 text-left"
        style={{ background: 'transparent', cursor: 'pointer' }}
      >
        <Avatar name={name ?? c.their_number} size={36} />
        <span className="flex min-w-0 flex-1 flex-col gap-1.5">
          <span className="flex items-center gap-2">
            <span className="mr-auto truncate" style={{ font: `${active ? 700 : 600} 12.5px/1 Inter` }}>
              {name ?? formatPhone(c.their_number)}
            </span>
            <span style={{ font: '500 10px/1 Inter', color: 'var(--muted-2)' }}>{timeShort(c.last_message_at)}</span>
          </span>

          <span className="truncate" style={{ font: '400 11.5px/1.35 Inter', color: 'var(--muted)' }}>
            {c.last_message?.direction === 'outbound' && 'You: '}
            {preview(c.last_message)}
          </span>

          {/* Who this is, at a glance: the Contacts vocabulary, same colours. */}
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            {c.contact_type && <TypeBadge type={c.contact_type} />}
            {c.temperature &&
              (c.temperature_score !== null ? (
                <TemperatureBadge temperature={c.temperature} score={c.temperature_score} />
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  <TempDot temperature={c.temperature} />
                  <span style={{ font: '700 11px/1 Inter' }}>{TEMP_LABEL[c.temperature]}</span>
                </span>
              ))}
            {status && <StatusMark status={status} />}
            {failed && (
              <span className="inline-flex items-center gap-1" style={{ font: '700 8.5px/1 Inter', letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--red)' }}>
                <Icon name="x" size={10} strokeWidth={2.6} />
                Not delivered
              </span>
            )}
          </span>

          {(c.tags.length > 0 || c.assigned_user_name) && (
            <span className="flex flex-wrap items-center gap-1">
              {c.tags.slice(0, 2).map((t) => (
                <TagChip key={t}>{t}</TagChip>
              ))}
              {c.tags.length > 2 && (
                <span style={{ font: '500 10px/1 Inter', color: 'var(--muted-2)' }}>+{c.tags.length - 2}</span>
              )}
              {c.assigned_user_name && (
                <span className="truncate" style={{ font: '500 10px/1 Inter', color: 'var(--muted-2)' }}>
                  {c.assigned_user_name}
                </span>
              )}
            </span>
          )}

          <span
            style={{
              font: '500 9.5px/1 Inter',
              letterSpacing: '0.06em',
              textTransform: 'uppercase',
              color: 'var(--muted-2)',
            }}
          >
            {[place, zone && now !== null ? `${tzTime(zone, now)} local` : c.lead_status].filter(Boolean).join(' · ')}
          </span>
        </span>
      </button>

      <span className="flex shrink-0 items-center gap-1.5 py-3 pr-3">
        {c.unread_count > 0 && (
          <span
            className="text-center"
            style={{
              minWidth: 18,
              height: 18,
              padding: '0 5px',
              borderRadius: 6,
              background: 'var(--accent)',
              color: '#fff',
              font: '700 10px/18px Inter',
            }}
          >
            {c.unread_count}
          </span>
        )}
        {!name && (
          // Always there on a phone; on a desk it appears on hover or when it
          // takes focus from the keyboard.
          <span className="transition-opacity md:opacity-0 md:focus-within:opacity-100 md:group-hover:opacity-100">
            <AddContactButton size="icon" phone={c.their_number} onCreated={onNamed} />
          </span>
        )}
      </span>
    </div>
  );
}

/** Tag filter: typed, committed on Enter or blur, cleared with the ×. */
function TagFilter({ value, onChange }: { value: string; onChange: (tag: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <span className="inline-flex min-w-0 items-center" style={{ ...FIELD, padding: '0 6px 0 10px' }}>
      <input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          if (draft.trim() !== value) onChange(draft.trim());
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
        placeholder="Tag"
        aria-label="Filter by tag"
        className="min-w-0 flex-1 bg-transparent outline-none"
        style={{ font: '500 12px/1 Inter', padding: '8px 0' }}
      />
      {value && (
        <button type="button" aria-label="Clear tag filter" onClick={() => onChange('')} style={{ color: 'var(--muted-2)', cursor: 'pointer' }}>
          <Icon name="x" size={13} />
        </button>
      )}
    </span>
  );
}
