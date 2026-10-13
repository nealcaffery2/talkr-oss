'use client';

/**
 * Contacts (design 1c): everyone the org talks to — sellers, buyers, title,
 * vendors — in one filterable table. The filters live in the URL so a view
 * survives a refresh and can be handed to a teammate; selecting rows raises a
 * bar of bulk actions, and the two that matter most (a dial list, a text
 * blast) hand off to the campaigns and messaging the platform already has.
 */

import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import {
  ApiError,
  api,
  CONTACT_STATUSES,
  CONTACT_TYPES,
  TEMPERATURES,
  type ContactBulkAction,
  type ContactBulkMessageDto,
  type ContactDialListDto,
  type ContactDto,
  type ContactImportDedupe,
  type ContactImportMapping,
  type ContactListDto,
  type ContactListQuery,
  type ContactSort,
  type ContactStatus,
  type ContactType,
  type CreateContactInput,
  type MessageTemplateDto,
  type TeamMemberDto,
  type Temperature,
} from '@/lib/api';
import { useSoftphone } from '@/lib/softphone';
import { TopBar } from '@/components/TopBar';
import { Icon, type IconName } from '@/components/Icon';
import { Avatar, Button, Card, EmptyState, Eyebrow, FIELD, Input, Labeled, Modal, Notice, Segmented, Select, TextArea } from '@/components/ui';
import {
  FilterChip,
  IconButton,
  MERGE_FIELDS,
  STATUS_LABEL,
  StatusMark,
  TEMP_LABEL,
  TYPE_LABEL,
  TagsField,
  TempDot,
  TemperatureBadge,
  TypeBadge,
  errorMessage,
  isForbidden,
  isOrgType,
  oneLineAddress,
  renderMergeFields,
  smsSegments,
} from '@/components/contacts';
import { PhoneText } from '@/components/CopyPhone';
import { formatPhone, timeAgo, toE164 } from '@/lib/time';
import { downloadFile, parseCsv, readFileText, toCsv, type ParsedCsv } from '@/lib/csv';

const PAGE_SIZE = 50;
/** Server ceilings on one bulk call. */
const BULK_TEXT_MAX = 200;
const DIAL_LIST_MAX = 500;
const IMPORT_BATCH = 500;
/** "Select all matching" pages ids down; past this the rep narrows the filter. */
const SELECT_ALL_CAP = 5000;

// The phone column carries the number *and* its copy button, so it is the one
// fixed column with slack in it — a truncated number is worse than a scrollbar.
const COLS = '32px minmax(190px, 1.6fr) 76px 112px 124px 150px minmax(150px, 1.2fr) 100px 84px 104px';
const TABLE_MIN = 1212;

const SORTS: Array<{ value: ContactSort; label: string }> = [
  { value: 'recent', label: 'Recent activity' },
  { value: 'name', label: 'Name' },
  { value: 'temperature', label: 'Temperature' },
  { value: 'created', label: 'Newest' },
];
const SORT_VALUES = SORTS.map((s) => s.value);

/* ── URL filters ──────────────────────────────────────────────────────────── */

interface Filters {
  q: string;
  type: ContactType | null;
  status: ContactStatus | null;
  temp: Temperature | null;
  tag: string;
  user: string;
  sort: ContactSort;
}

function pick<T extends string>(list: readonly T[], value: string | null): T | null {
  return list.find((x) => x === value) ?? null;
}

function readFilters(p: URLSearchParams): Filters {
  return {
    q: p.get('q')?.trim() ?? '',
    type: pick(CONTACT_TYPES, p.get('type')),
    status: pick(CONTACT_STATUSES, p.get('status')),
    temp: pick(TEMPERATURES, p.get('temp')),
    tag: p.get('tag')?.trim() ?? '',
    user: p.get('user')?.trim() ?? '',
    sort: pick(SORT_VALUES, p.get('sort')) ?? 'recent',
  };
}

function toQuery(f: Filters): ContactListQuery {
  return {
    q: f.q || undefined,
    type: f.type ?? undefined,
    status: f.status ?? undefined,
    temperature: f.temp ?? undefined,
    tag: f.tag || undefined,
    user_id: f.user || undefined,
    sort: f.sort,
  };
}

function hasFilters(f: Filters): boolean {
  return Boolean(f.q || f.type || f.status || f.temp || f.tag || f.user);
}

type ValueAction = Extract<ContactBulkAction, 'set_status' | 'set_type' | 'add_tag' | 'remove_tag' | 'assign'>;

type ModalState =
  | null
  | { kind: 'add' }
  | { kind: 'import' }
  | { kind: 'text' }
  | { kind: 'dial' }
  | { kind: 'delete'; ids: string[] }
  | { kind: 'value'; action: ValueAction };

export default function ContactsPage() {
  // useSearchParams needs a Suspense boundary for the static shell.
  return (
    <Suspense fallback={null}>
      <ContactsScreen />
    </Suspense>
  );
}

function ContactsScreen() {
  const { authed, placeCall } = useSoftphone();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const paramsString = searchParams.toString();
  const filters = useMemo(() => readFilters(new URLSearchParams(paramsString)), [paramsString]);
  const query = useMemo(() => toQuery(filters), [filters]);

  const [contacts, setContacts] = useState<ContactDto[]>([]);
  const [total, setTotal] = useState(0);
  const [counts, setCounts] = useState<ContactListDto['counts'] | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [reloadKey, setReloadKey] = useState(0);
  // null until the roster answers; the rep filter and "assign" need it.
  const [team, setTeam] = useState<TeamMemberDto[] | null>(null);
  const [repName, setRepName] = useState<string | null>(null);
  const [templates, setTemplates] = useState<MessageTemplateDto[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [selectingAll, setSelectingAll] = useState(false);
  const [modal, setModal] = useState<ModalState>(null);
  const [flash, setFlash] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  // ── URL state ─────────────────────────────────────────────────────────────
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

  // ── Data ──────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!authed) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .listContacts({ ...query, limit: PAGE_SIZE, offset: 0 })
      .then((r) => {
        if (cancelled) return;
        setContacts(r.contacts);
        setTotal(r.total);
        setCounts(r.counts);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [authed, query, reloadKey]);

  // A new view is a new selection.
  useEffect(() => setSelected(new Set()), [query]);

  useEffect(() => {
    if (!authed) return;
    api.listTeam().then((r) => setTeam(r.members)).catch(() => setTeam(null));
    api.getMe().then((m) => setRepName(m.display_name)).catch(() => undefined);
    api.listMessageTemplates().then((r) => setTemplates(r.templates)).catch(() => undefined);
  }, [authed]);

  const reload = () => setReloadKey((k) => k + 1);

  const loadMore = async () => {
    if (loadingMore) return;
    setLoadingMore(true);
    try {
      const r = await api.listContacts({ ...query, limit: PAGE_SIZE, offset: contacts.length });
      setContacts((prev) => {
        const seen = new Set(prev.map((c) => c.id));
        return [...prev, ...r.contacts.filter((c) => !seen.has(c.id))];
      });
      setTotal(r.total);
    } catch (e) {
      setFlash(errorMessage(e));
    } finally {
      setLoadingMore(false);
    }
  };

  // ── Selection ─────────────────────────────────────────────────────────────
  const pageIds = useMemo(() => contacts.map((c) => c.id), [contacts]);
  const pageSelectedCount = pageIds.filter((id) => selected.has(id)).length;
  const allPageSelected = pageIds.length > 0 && pageSelectedCount === pageIds.length;
  const headerCheck = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (headerCheck.current) headerCheck.current.indeterminate = pageSelectedCount > 0 && !allPageSelected;
  }, [pageSelectedCount, allPageSelected]);

  const toggleOne = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const togglePage = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (allPageSelected) pageIds.forEach((id) => next.delete(id));
      else pageIds.forEach((id) => next.add(id));
      return next;
    });

  const selectAllMatching = async () => {
    if (selectingAll) return;
    setSelectingAll(true);
    try {
      const ids = new Set(selected);
      const cap = Math.min(total, SELECT_ALL_CAP);
      let offset = 0;
      while (offset < cap) {
        const r = await api.listContacts({ ...query, limit: 500, offset });
        if (r.contacts.length === 0) break;
        r.contacts.forEach((c) => ids.add(c.id));
        offset += r.contacts.length;
      }
      setSelected(ids);
      if (total > SELECT_ALL_CAP) {
        setFlash(`Selected the first ${SELECT_ALL_CAP.toLocaleString()} of ${total.toLocaleString()} — narrow the filters to reach the rest.`);
      }
    } catch (e) {
      setFlash(errorMessage(e));
    } finally {
      setSelectingAll(false);
    }
  };

  // ── Actions ───────────────────────────────────────────────────────────────
  const callContact = (c: ContactDto) => {
    if (!c.primary_phone) return;
    placeCall({ to_number: c.primary_phone, contact_id: c.id }).catch((e: unknown) => setFlash(errorMessage(e)));
  };

  const textContact = (c: ContactDto) => {
    if (!c.primary_phone) return;
    router.push(`/messages?to=${encodeURIComponent(c.primary_phone)}`);
  };

  const runBulk = async (action: ContactBulkAction, value: string | null | undefined, label: string) => {
    const ids = [...selected];
    setBusy(true);
    try {
      const r = await api.bulkContacts({ ids, action, ...(value !== undefined ? { value } : {}) });
      setFlash(`${label} · ${r.affected.toLocaleString()} contact${r.affected === 1 ? '' : 's'}`);
      setSelected(new Set());
      setModal(null);
      reload();
    } catch (e) {
      setFlash(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const deleteIds = async (ids: string[]) => {
    setBusy(true);
    try {
      if (ids.length === 1) {
        await api.deleteContact(ids[0]!);
        setFlash('Contact deleted');
      } else {
        const r = await api.bulkContacts({ ids, action: 'delete' });
        setFlash(`Deleted ${r.affected.toLocaleString()} contact${r.affected === 1 ? '' : 's'}`);
      }
      setSelected((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
      setModal(null);
      reload();
    } catch (e) {
      setFlash(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const exportCsv = async () => {
    setBusy(true);
    try {
      const { blob, filename } = await api.exportContactsCsv(query);
      downloadFile(blob, filename ?? `contacts-${new Date().toISOString().slice(0, 10)}.csv`);
    } catch (e) {
      setFlash(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!authed) {
    return (
      <p className="p-6" style={{ font: '400 13px/1.5 Inter', color: 'var(--muted)' }}>
        Not signed in — open <a href="/login" style={{ color: 'var(--accent)' }}>Account</a>.
      </p>
    );
  }

  const forbidden = isForbidden(error);
  const filtered = hasFilters(filters);
  const hot = counts?.by_temperature.hot ?? 0;
  const allCount = counts ? Object.values(counts.by_type).reduce((a, b) => a + b, 0) : undefined;
  const subtitle =
    loading && contacts.length === 0
      ? 'Loading…'
      : `${total.toLocaleString()} contact${total === 1 ? '' : 's'}${filtered ? ' matching' : ''}${hot ? ` · ${hot.toLocaleString()} hot` : ''}`;
  const byId = new Map(contacts.map((c) => [c.id, c]));
  const firstSelected = [...selected].map((id) => byId.get(id)).find((c): c is ContactDto => Boolean(c)) ?? null;

  return (
    <>
      <TopBar title="Contacts" subtitle={subtitle} />

      <div className="min-h-0 flex-1 overflow-auto p-3 md:p-5">
        {/* ── Toolbar ─────────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-2 pb-3">
          <div className="flex min-w-[200px] flex-1 items-center gap-2" style={{ ...FIELD, padding: '0 11px', maxWidth: 380 }}>
            <Icon name="search" size={14} style={{ color: 'var(--muted-2)', flexShrink: 0 }} />
            <input
              value={qInput}
              onChange={(e) => setQInput(e.target.value)}
              placeholder="Search name, phone, email, address"
              aria-label="Search contacts"
              className="min-w-0 flex-1 bg-transparent outline-none"
              style={{ font: '500 12.5px/1 Inter', padding: '9px 0' }}
            />
            {qInput && (
              <button type="button" aria-label="Clear search" onClick={() => setQInput('')} style={{ color: 'var(--muted-2)', cursor: 'pointer' }}>
                <Icon name="x" size={13} />
              </button>
            )}
          </div>

          <Select value={filters.status ?? ''} onChange={(e) => setParams({ status: e.target.value || null })} aria-label="Status">
            <option value="">Any status</option>
            {CONTACT_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </Select>

          <span className="inline-flex items-center gap-2" style={{ ...FIELD, padding: '0 0 0 11px' }}>
            {filters.temp ? (
              <TempDot temperature={filters.temp} />
            ) : (
              <span style={{ width: 8, height: 8, borderRadius: '50%', border: '1.5px solid var(--muted-2)', display: 'inline-block' }} aria-hidden />
            )}
            <select
              value={filters.temp ?? ''}
              onChange={(e) => setParams({ temp: e.target.value || null })}
              aria-label="Temperature"
              style={{ border: 'none', background: 'transparent', padding: '9px 8px 9px 0', font: '500 12.5px/1 Inter', color: 'var(--text)', outline: 'none' }}
            >
              <option value="">Any temperature</option>
              {TEMPERATURES.map((t) => (
                <option key={t} value={t}>
                  {TEMP_LABEL[t]}
                </option>
              ))}
            </select>
          </span>

          <TagFilter value={filters.tag} onChange={(tag) => setParams({ tag: tag || null })} />

          {team && team.length > 0 && (
            <Select value={filters.user} onChange={(e) => setParams({ user: e.target.value || null })} aria-label="Rep">
              <option value="">Any rep</option>
              {team.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
            </Select>
          )}

          <Select value={filters.sort} onChange={(e) => setParams({ sort: e.target.value === 'recent' ? null : e.target.value })} aria-label="Sort">
            {SORTS.map((s) => (
              <option key={s.value} value={s.value}>
                Sort: {s.label}
              </option>
            ))}
          </Select>

          {filtered && (
            <Button tone="quiet" onClick={() => router.replace(pathname, { scroll: false })}>
              Clear filters
            </Button>
          )}

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button tone="ghost" onClick={() => void exportCsv()} disabled={busy || total === 0} title="Download the current view as CSV">
              <Icon name="forward" size={14} />
              <span className="hidden sm:inline">Export CSV</span>
            </Button>
            <Button tone="ghost" onClick={() => setModal({ kind: 'import' })}>
              <Icon name="template" size={14} />
              <span className="hidden sm:inline">Import CSV</span>
            </Button>
            <Button tone="dark" onClick={() => setModal({ kind: 'add' })}>
              <Icon name="plus" size={14} />
              Add contact
            </Button>
          </div>
        </div>

        {/* ── Type chips ──────────────────────────────────────────────── */}
        <div className="flex flex-wrap items-center gap-1.5 pb-3">
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

        {flash && (
          <Notice
            className="mb-3"
            action={
              <Button tone="quiet" onClick={() => setFlash(null)}>
                Dismiss
              </Button>
            }
          >
            {flash}
          </Notice>
        )}

        {forbidden ? (
          <Notice tone="error">You don’t have access to contacts. Ask an owner or admin to grant it.</Notice>
        ) : error ? (
          <Notice
            tone="error"
            action={
              <Button tone="ghost" onClick={reload}>
                Retry
              </Button>
            }
          >
            {errorMessage(error)}
          </Notice>
        ) : (
          <Card padded={false} className="overflow-x-auto">
            <div
              className="grid items-center gap-3.5 px-4 py-3"
              style={{ gridTemplateColumns: COLS, minWidth: TABLE_MIN, borderBottom: '1px solid var(--line)', background: 'var(--bg)' }}
            >
              <input
                ref={headerCheck}
                type="checkbox"
                aria-label="Select all on this page"
                checked={allPageSelected}
                onChange={togglePage}
                disabled={contacts.length === 0}
                style={{ accentColor: 'var(--accent)', width: 15, height: 15 }}
              />
              <Eyebrow>Name</Eyebrow>
              <Eyebrow>Type</Eyebrow>
              <Eyebrow>Status</Eyebrow>
              <Eyebrow>Temperature</Eyebrow>
              <Eyebrow>Phone</Eyebrow>
              <Eyebrow>Address</Eyebrow>
              <Eyebrow>Rep</Eyebrow>
              <Eyebrow>Last activity</Eyebrow>
              <Eyebrow className="text-right">Actions</Eyebrow>
            </div>

            {(allPageSelected || selected.size > contacts.length) && total > contacts.length && (
              <div
                className="flex flex-wrap items-center gap-2 px-4 py-2"
                style={{ minWidth: TABLE_MIN, borderBottom: '1px solid var(--line)', background: 'var(--accent-soft)', font: '500 12px/1.4 Inter' }}
              >
                {selected.size >= total ? (
                  <>
                    All {total.toLocaleString()} matching contacts are selected.
                    <button type="button" onClick={() => setSelected(new Set())} style={{ font: '600 12px/1 Inter', color: 'var(--accent)', cursor: 'pointer' }}>
                      Clear selection
                    </button>
                  </>
                ) : (
                  <>
                    {selected.size.toLocaleString()} selected on this page.
                    <button
                      type="button"
                      disabled={selectingAll}
                      onClick={() => void selectAllMatching()}
                      style={{ font: '600 12px/1 Inter', color: 'var(--accent)', cursor: 'pointer' }}
                    >
                      {selectingAll ? 'Selecting…' : `Select all ${total.toLocaleString()} matching`}
                    </button>
                  </>
                )}
              </div>
            )}

            {loading && contacts.length === 0 && (
              <p className="p-5" style={{ font: '400 12.5px/1.5 Inter', color: 'var(--muted)' }}>
                Loading contacts…
              </p>
            )}

            {!loading && contacts.length === 0 && (
              <EmptyState
                title={filtered ? 'No contacts match' : 'No contacts yet'}
                hint={
                  filtered
                    ? 'Try a broader search or clear a filter.'
                    : 'Add your first seller or buyer, or import a list from your last CRM.'
                }
                action={
                  filtered ? (
                    <Button tone="ghost" onClick={() => router.replace(pathname, { scroll: false })}>
                      Clear filters
                    </Button>
                  ) : (
                    <div className="flex gap-2">
                      <Button tone="dark" onClick={() => setModal({ kind: 'add' })}>
                        <Icon name="plus" size={14} />
                        Add contact
                      </Button>
                      <Button tone="ghost" onClick={() => setModal({ kind: 'import' })}>
                        Import CSV
                      </Button>
                    </div>
                  )
                }
              />
            )}

            {contacts.map((c) => (
              <ContactRow
                key={c.id}
                c={c}
                now={now}
                checked={selected.has(c.id)}
                onToggle={() => toggleOne(c.id)}
                onCall={() => callContact(c)}
                onText={() => textContact(c)}
                onDelete={() => setModal({ kind: 'delete', ids: [c.id] })}
              />
            ))}

            {contacts.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3" style={{ minWidth: TABLE_MIN }}>
                <span style={{ font: '500 11px/1 Inter', color: 'var(--muted)' }}>
                  Showing {contacts.length.toLocaleString()} of {total.toLocaleString()}
                </span>
                {contacts.length < total && (
                  <Button tone="ghost" onClick={() => void loadMore()} disabled={loadingMore}>
                    {loadingMore ? 'Loading…' : `Load ${Math.min(PAGE_SIZE, total - contacts.length)} more`}
                  </Button>
                )}
              </div>
            )}
          </Card>
        )}

        {/* ── Bulk bar ────────────────────────────────────────────────── */}
        {selected.size > 0 && (
          <div className="sticky bottom-2 z-20 mt-3 flex justify-center">
            <div
              className="flex max-w-full flex-wrap items-center gap-1.5 px-3 py-2"
              style={{
                background: 'var(--ink)',
                color: '#fff',
                borderRadius: 14,
                boxShadow: 'var(--shadow-lift)',
              }}
            >
              <span className="mr-1 inline-flex items-center gap-2 px-1" style={{ font: '700 12px/1 Inter' }}>
                {selected.size.toLocaleString()} selected
                <button
                  type="button"
                  aria-label="Clear selection"
                  onClick={() => setSelected(new Set())}
                  className="inline-flex h-5 w-5 items-center justify-center rounded-full"
                  style={{ background: 'var(--dark-3)', color: '#fff', cursor: 'pointer' }}
                >
                  <Icon name="x" size={11} strokeWidth={2.5} />
                </button>
              </span>
              <BarButton icon="phone" onClick={() => setModal({ kind: 'dial' })} disabled={busy}>
                Call
              </BarButton>
              <BarButton icon="msg" onClick={() => setModal({ kind: 'text' })} disabled={busy}>
                Text
              </BarButton>
              <BarButton onClick={() => setModal({ kind: 'value', action: 'set_status' })} disabled={busy}>
                Set status
              </BarButton>
              <BarButton onClick={() => setModal({ kind: 'value', action: 'set_type' })} disabled={busy}>
                Set type
              </BarButton>
              <BarButton onClick={() => setModal({ kind: 'value', action: 'add_tag' })} disabled={busy}>
                Add tag
              </BarButton>
              {team && team.length > 0 && (
                <BarButton icon="user" onClick={() => setModal({ kind: 'value', action: 'assign' })} disabled={busy}>
                  Assign
                </BarButton>
              )}
              <BarButton icon="forward" onClick={() => void exportCsv()} disabled={busy} title="Download the current view as CSV">
                Export CSV
              </BarButton>
              <BarButton icon="x" danger onClick={() => setModal({ kind: 'delete', ids: [...selected] })} disabled={busy}>
                Delete
              </BarButton>
            </div>
          </div>
        )}
      </div>

      {/* ── Modals ──────────────────────────────────────────────────────── */}
      {modal?.kind === 'add' && (
        <AddContactModal
          team={team}
          onClose={() => setModal(null)}
          onCreated={(c, merged) => {
            setModal(null);
            setFlash(merged ? `Merged into ${c.display_name}` : `Added ${c.display_name}`);
            reload();
          }}
        />
      )}
      {modal?.kind === 'import' && (
        <ImportModal
          onClose={(imported) => {
            setModal(null);
            if (imported) reload();
          }}
        />
      )}
      {modal?.kind === 'text' && (
        <BulkTextModal
          ids={[...selected]}
          sample={firstSelected}
          nameOf={(id) => byId.get(id)?.display_name ?? id}
          templates={templates}
          repName={repName}
          onClose={() => setModal(null)}
          onSent={() => setSelected(new Set())}
        />
      )}
      {modal?.kind === 'dial' && (
        <DialListModal
          ids={[...selected]}
          onClose={() => setModal(null)}
          onDone={(message) => {
            setSelected(new Set());
            setModal(null);
            if (message) setFlash(message);
          }}
        />
      )}
      {modal?.kind === 'delete' && (
        <Modal title={modal.ids.length === 1 ? 'Delete contact' : `Delete ${modal.ids.length.toLocaleString()} contacts`} onClose={() => setModal(null)} width={440}>
          <div className="flex flex-col gap-3">
            <p style={{ font: '400 12.5px/1.5 Inter', color: 'var(--muted)' }}>
              {modal.ids.length === 1
                ? `${byId.get(modal.ids[0]!)?.display_name ?? 'This contact'} will be removed from every list and search.`
                : 'They will be removed from every list and search.'}{' '}
              Their calls and texts stay in history, and an admin can restore them.
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button tone="red" disabled={busy} onClick={() => void deleteIds(modal.ids)}>
                {busy ? 'Deleting…' : 'Delete'}
              </Button>
              <Button tone="ghost" onClick={() => setModal(null)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        </Modal>
      )}
      {modal?.kind === 'value' && (
        <BulkValueModal
          action={modal.action}
          count={selected.size}
          team={team ?? []}
          busy={busy}
          onClose={() => setModal(null)}
          onApply={(value, label) => void runBulk(modal.action, value, label)}
        />
      )}
    </>
  );
}

/* ── Row ──────────────────────────────────────────────────────────────────── */

function ContactRow({
  c,
  now,
  checked,
  onToggle,
  onCall,
  onText,
  onDelete,
}: {
  c: ContactDto;
  now: number | null;
  checked: boolean;
  onToggle: () => void;
  onCall: () => void;
  onText: () => void;
  onDelete: () => void;
}) {
  const address = oneLineAddress(c.address);
  const phone = c.primary_phone ? formatPhone(c.primary_phone) || c.primary_phone : '';
  const extraPhones = c.phones.length - 1;
  return (
    <div
      className="grid items-center gap-3.5 px-4 py-2.5"
      style={{
        gridTemplateColumns: COLS,
        minWidth: TABLE_MIN,
        borderBottom: '1px solid var(--panel-2)',
        background: checked ? 'var(--accent-soft)' : undefined,
      }}
    >
      <input
        type="checkbox"
        aria-label={`Select ${c.display_name}`}
        checked={checked}
        onChange={onToggle}
        style={{ accentColor: 'var(--accent)', width: 15, height: 15 }}
      />

      <span className="flex min-w-0 items-center gap-2.5">
        <Avatar name={c.display_name} size={30} />
        <span className="flex min-w-0 flex-col gap-1">
          <Link href={`/contacts/${c.id}`} className="truncate" style={{ font: '600 12.5px/1 Inter', color: 'var(--text)' }}>
            {c.display_name}
          </Link>
          <span className="truncate" style={{ font: '500 10.5px/1 Inter', color: 'var(--muted)' }}>
            {[c.company, c.email].filter(Boolean).join(' · ') || (c.tags.length > 0 ? c.tags.slice(0, 3).join(', ') : c.source ?? '')}
          </span>
        </span>
      </span>

      <span>
        <TypeBadge type={c.type} />
      </span>

      <StatusMark status={c.status} />

      <TemperatureBadge temperature={c.temperature} score={c.temperature_score} locked={c.temperature_locked} />

      <span className="flex min-w-0 flex-col gap-1">
        {c.primary_phone ? (
          <PhoneText
            e164={c.primary_phone}
            display={phone}
            size={20}
            style={{ font: '500 12px/1 Inter', color: 'var(--text)' }}
          />
        ) : (
          <span className="truncate" style={{ font: '500 12px/1 Inter', color: 'var(--muted-2)' }}>
            No phone
          </span>
        )}
        {extraPhones > 0 && (
          <span style={{ font: '500 10px/1 Inter', color: 'var(--muted-2)' }}>
            +{extraPhones} more
          </span>
        )}
      </span>

      <span className="truncate" title={address} style={{ font: '400 11.5px/1.3 Inter', color: address ? 'var(--text)' : 'var(--muted-2)' }}>
        {address || '—'}
      </span>

      <span className="truncate" style={{ font: '500 11.5px/1 Inter', color: c.assigned_user_name ? 'var(--text)' : 'var(--muted-2)' }}>
        {c.assigned_user_name ?? 'Unassigned'}
      </span>

      <span title={c.last_activity_at ?? undefined} style={{ font: '500 11px/1 Inter', color: 'var(--muted)' }}>
        {now === null ? '—' : timeAgo(c.last_activity_at, now)}
      </span>

      <span className="flex items-center justify-end gap-1.5">
        <IconButton
          label={`Call ${c.display_name}`}
          icon="phone"
          accent
          disabled={!c.primary_phone || c.status === 'dnc'}
          title={c.status === 'dnc' ? 'Do not call' : c.primary_phone ? 'Call' : 'No phone on file'}
          onClick={onCall}
        />
        <IconButton
          label={`Text ${c.display_name}`}
          icon="msg"
          disabled={!c.primary_phone}
          title={c.primary_phone ? 'Text' : 'No phone on file'}
          onClick={onText}
        />
        <RowMenu contactId={c.id} onDelete={onDelete} />
      </span>
    </div>
  );
}

/**
 * The row's overflow. Rendered fixed rather than absolute so the table's
 * horizontal scroll container cannot clip it on the last rows.
 */
function RowMenu({ contactId, onDelete }: { contactId: string; onDelete: () => void }) {
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const btn = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const onDoc = (e: MouseEvent) => {
      if (btn.current && e.target instanceof Node && btn.current.contains(e.target)) return;
      close();
    };
    document.addEventListener('mousedown', onDoc);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [pos]);

  const item = (label: string, onClick: () => void, danger = false) => (
    <button
      type="button"
      onClick={() => {
        setPos(null);
        onClick();
      }}
      className="px-3 py-2 text-left"
      style={{ font: '500 12px/1 Inter', color: danger ? 'var(--red)' : 'var(--text)', cursor: 'pointer', background: 'transparent', border: 'none' }}
    >
      {label}
    </button>
  );

  return (
    <span ref={btn} className="inline-flex">
      <IconButton
        label="More"
        icon="more"
        onClick={() => {
          if (pos) return setPos(null);
          const r = btn.current?.getBoundingClientRect();
          if (r) setPos({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
        }}
      />
      {pos && (
        <div
          role="menu"
          className="fixed z-50 flex min-w-[150px] flex-col py-1"
          style={{
            top: pos.top,
            right: pos.right,
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 10,
            boxShadow: 'var(--shadow-lift)',
          }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <Link
            href={`/contacts/${contactId}`}
            className="px-3 py-2"
            style={{ font: '500 12px/1 Inter', color: 'var(--text)' }}
            onClick={() => setPos(null)}
          >
            Open
          </Link>
          {item('Delete', onDelete, true)}
        </div>
      )}
    </span>
  );
}

/* ── Small pieces ─────────────────────────────────────────────────────────── */

function BarButton({
  children,
  icon,
  onClick,
  disabled,
  danger,
  title,
}: {
  children: ReactNode;
  icon?: IconName;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="inline-flex items-center gap-1.5 disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        padding: '7px 10px',
        borderRadius: 9,
        border: '1px solid var(--dark-3)',
        background: 'var(--dark-2)',
        color: danger ? '#fca5a5' : '#fff',
        font: '600 11.5px/1 Inter',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {icon && <Icon name={icon} size={13} />}
      {children}
    </button>
  );
}

/** Tag filter: typed, committed on Enter or blur, cleared with the ×. */
function TagFilter({ value, onChange }: { value: string; onChange: (tag: string) => void }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <span className="inline-flex items-center" style={{ ...FIELD, padding: '0 6px 0 11px', width: 150 }}>
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
        style={{ font: '500 12.5px/1 Inter', padding: '9px 0' }}
      />
      {value && (
        <button type="button" aria-label="Clear tag filter" onClick={() => onChange('')} style={{ color: 'var(--muted-2)', cursor: 'pointer' }}>
          <Icon name="x" size={13} />
        </button>
      )}
    </span>
  );
}

/** Wrapping segmented control for the six contact types. */
function TypeSegments({ value, onChange }: { value: ContactType; onChange: (t: ContactType) => void }) {
  return (
    <div className="flex flex-wrap gap-1 p-0.5" style={{ borderRadius: 8, background: 'var(--panel-2)' }}>
      {CONTACT_TYPES.map((t) => (
        <button
          key={t}
          type="button"
          onClick={() => onChange(t)}
          aria-pressed={value === t}
          style={{
            padding: '6px 11px',
            borderRadius: 6,
            border: 'none',
            cursor: 'pointer',
            font: '600 11px/1 Inter',
            background: value === t ? 'var(--dark-1)' : 'transparent',
            color: value === t ? '#fff' : 'var(--muted)',
          }}
        >
          {TYPE_LABEL[t]}
        </button>
      ))}
    </div>
  );
}

function phoneDigitsOk(raw: string): boolean {
  const digits = raw.replace(/\D/g, '');
  return digits.length === 0 || digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
}

/* ── Add contact ──────────────────────────────────────────────────────────── */

function AddContactModal({
  team,
  onClose,
  onCreated,
}: {
  team: TeamMemberDto[] | null;
  onClose: () => void;
  onCreated: (contact: ContactDto, merged: boolean) => void;
}) {
  const router = useRouter();
  const [type, setType] = useState<ContactType>('seller');
  const [name, setName] = useState('');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState('');
  const [company, setCompany] = useState('');
  const [status, setStatus] = useState<ContactStatus>('new');
  const [assigned, setAssigned] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [addrOpen, setAddrOpen] = useState(false);
  const [line1, setLine1] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // The existing contact's id after a 409; '' when the server did not say which.
  const [dupId, setDupId] = useState<string | null>(null);

  const org = isOrgType(type);
  const displayName = name.trim() || (org ? company.trim() : '');
  const phoneOk = phoneDigitsOk(phone);
  const ready = displayName.length > 0 && phoneOk;

  const submit = async (merge: boolean) => {
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    setDupId(null);
    try {
      const address = [line1, city, state, zip].some((v) => v.trim())
        ? {
            ...(line1.trim() ? { line1: line1.trim() } : {}),
            ...(city.trim() ? { city: city.trim() } : {}),
            ...(state.trim() ? { state: state.trim().toUpperCase() } : {}),
            ...(zip.trim() ? { postal_code: zip.trim() } : {}),
          }
        : null;
      const input: CreateContactInput = {
        display_name: displayName,
        type,
        status,
        ...(phone.replace(/\D/g, '') ? { phone: toE164(phone) } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(company.trim() ? { company: company.trim() } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(assigned ? { assigned_user_id: assigned } : {}),
        ...(address ? { address } : {}),
        source: 'manual',
        ...(merge ? { merge: true } : {}),
      };
      const r = await api.createContact(input);
      onCreated(r.contact, merge);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && e.code === 'duplicate_phone') {
        const id = e.body?.contact_id;
        setDupId(typeof id === 'string' ? id : '');
      } else {
        setErr(errorMessage(e));
      }
    } finally {
      setBusy(false);
    }
  };

  const nameField = (
    <Labeled label={org ? 'Contact name' : 'Name'}>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={org ? 'Who you talk to there (optional)' : 'Jordan Lee'}
        autoFocus={!org}
      />
    </Labeled>
  );
  const companyField = (
    <Labeled label={org ? (type === 'title' ? 'Title company' : 'Company') : 'Company'}>
      <Input
        value={company}
        onChange={(e) => setCompany(e.target.value)}
        placeholder={type === 'title' ? 'Capital Title of Texas' : org ? 'Acme Roofing' : 'Optional'}
        autoFocus={org}
      />
    </Labeled>
  );

  return (
    <Modal title="Add contact" onClose={onClose} width={600}>
      <form
        className="flex flex-col gap-3.5"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
      >
        <div className="flex flex-col gap-1.5">
          <Eyebrow>Type</Eyebrow>
          <TypeSegments value={type} onChange={setType} />
        </div>

        <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))' }}>
          {org ? (
            <>
              {companyField}
              {nameField}
            </>
          ) : (
            <>
              {nameField}
              {companyField}
            </>
          )}
          <Labeled label="Phone">
            <Input
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="(512) 555-0134"
              inputMode="tel"
              autoComplete="off"
              style={!phoneOk ? { borderColor: 'var(--red)' } : undefined}
            />
          </Labeled>
          <Labeled label="Email">
            <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jordan@example.com" autoComplete="off" />
          </Labeled>
          <Labeled label="Status">
            <Select value={status} onChange={(e) => setStatus(pick(CONTACT_STATUSES, e.target.value) ?? 'new')}>
              {CONTACT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </Labeled>
          {team && team.length > 0 && (
            <Labeled label="Rep">
              <Select value={assigned} onChange={(e) => setAssigned(e.target.value)}>
                <option value="">Unassigned</option>
                {team.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.display_name}
                  </option>
                ))}
              </Select>
            </Labeled>
          )}
        </div>

        <div className="flex flex-col gap-2">
          <button
            type="button"
            onClick={() => setAddrOpen((v) => !v)}
            aria-expanded={addrOpen}
            className="inline-flex items-center gap-1.5 self-start"
            style={{ font: '600 11.5px/1 Inter', color: 'var(--accent)', cursor: 'pointer' }}
          >
            <Icon name={addrOpen ? 'chevron-down' : 'chevron-right'} size={13} />
            {org ? 'Add address' : 'Add property address'}
          </button>
          {addrOpen && (
            <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))' }}>
              <Labeled label="Street" className="col-span-full">
                <Input value={line1} onChange={(e) => setLine1(e.target.value)} placeholder="1207 Elm St" />
              </Labeled>
              <Labeled label="City">
                <Input value={city} onChange={(e) => setCity(e.target.value)} placeholder="Austin" />
              </Labeled>
              <Labeled label="State">
                <Input value={state} onChange={(e) => setState(e.target.value)} placeholder="TX" maxLength={2} />
              </Labeled>
              <Labeled label="ZIP">
                <Input value={zip} onChange={(e) => setZip(e.target.value)} placeholder="78702" inputMode="numeric" />
              </Labeled>
            </div>
          )}
        </div>

        <Labeled label="Tags">
          <TagsField tags={tags} onChange={setTags} placeholder="probate, absentee…" />
        </Labeled>

        <Labeled label="Notes">
          <TextArea value={notes} onChange={(e) => setNotes(e.target.value)} rows={3} placeholder="Anything the next rep should know" />
        </Labeled>

        {dupId !== null && (
          <Notice
            tone="warn"
            action={
              <span className="flex flex-wrap gap-1.5">
                {dupId && (
                  <Button tone="ghost" onClick={() => router.push(`/contacts/${dupId}`)} disabled={busy}>
                    Open existing
                  </Button>
                )}
                <Button tone="dark" onClick={() => void submit(true)} disabled={busy}>
                  Merge into existing
                </Button>
              </span>
            }
          >
            That phone number already belongs to a contact.
          </Notice>
        )}

        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="submit" tone="accent" disabled={!ready || busy}>
            {busy ? 'Saving…' : 'Add contact'}
          </Button>
          <Button tone="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          {err ? (
            <span className="ml-auto" style={{ font: '500 12px/1.4 Inter', color: 'var(--red)' }}>
              {err}
            </span>
          ) : !phoneOk ? (
            <span className="ml-auto" style={{ font: '500 11px/1.4 Inter', color: 'var(--red)' }}>
              Enter a 10-digit US number.
            </span>
          ) : null}
        </div>
      </form>
    </Modal>
  );
}

/* ── Bulk: set a value ────────────────────────────────────────────────────── */

function BulkValueModal({
  action,
  count,
  team,
  busy,
  onClose,
  onApply,
}: {
  action: ValueAction;
  count: number;
  team: TeamMemberDto[];
  busy: boolean;
  onClose: () => void;
  onApply: (value: string | null, label: string) => void;
}) {
  const [value, setValue] = useState('');
  const title: Record<ValueAction, string> = {
    set_status: 'Set status',
    set_type: 'Set type',
    add_tag: 'Add tag',
    remove_tag: 'Remove tag',
    assign: 'Assign rep',
  };
  const noun = `${count.toLocaleString()} contact${count === 1 ? '' : 's'}`;
  const ready = action === 'assign' ? true : value.trim().length > 0;

  const apply = () => {
    if (!ready || busy) return;
    if (action === 'set_status') onApply(value, `Status → ${STATUS_LABEL[pick(CONTACT_STATUSES, value) ?? 'new']}`);
    else if (action === 'set_type') onApply(value, `Type → ${TYPE_LABEL[pick(CONTACT_TYPES, value) ?? 'other']}`);
    else if (action === 'assign') {
      const rep = team.find((m) => m.id === value);
      onApply(value || null, rep ? `Assigned to ${rep.display_name}` : 'Unassigned');
    } else onApply(value.trim(), `${action === 'add_tag' ? 'Tagged' : 'Untagged'} “${value.trim()}”`);
  };

  return (
    <Modal title={`${title[action]} · ${noun}`} onClose={onClose} width={440}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          apply();
        }}
      >
        {action === 'set_status' && (
          <Labeled label="Status">
            <Select value={value} onChange={(e) => setValue(e.target.value)} autoFocus>
              <option value="">Choose…</option>
              {CONTACT_STATUSES.map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
            </Select>
          </Labeled>
        )}
        {action === 'set_type' && (
          <Labeled label="Type">
            <Select value={value} onChange={(e) => setValue(e.target.value)} autoFocus>
              <option value="">Choose…</option>
              {CONTACT_TYPES.map((t) => (
                <option key={t} value={t}>
                  {TYPE_LABEL[t]}
                </option>
              ))}
            </Select>
          </Labeled>
        )}
        {(action === 'add_tag' || action === 'remove_tag') && (
          <Labeled label="Tag">
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="probate" autoFocus />
          </Labeled>
        )}
        {action === 'assign' && (
          <Labeled label="Rep">
            <Select value={value} onChange={(e) => setValue(e.target.value)} autoFocus>
              <option value="">Unassigned</option>
              {team.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.display_name}
                </option>
              ))}
            </Select>
          </Labeled>
        )}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="submit" tone="accent" disabled={!ready || busy}>
            {busy ? 'Applying…' : `Apply to ${noun}`}
          </Button>
          <Button tone="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ── Bulk: dial list ──────────────────────────────────────────────────────── */

function DialListModal({
  ids,
  onClose,
  onDone,
}: {
  ids: string[];
  onClose: () => void;
  onDone: (message: string | null) => void;
}) {
  const router = useRouter();
  const [name, setName] = useState(`Contacts ${new Date().toLocaleDateString([], { month: 'short', day: 'numeric' })}`);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<ContactDialListDto | null>(null);
  const tooMany = ids.length > DIAL_LIST_MAX;

  const confirm = async () => {
    if (busy || tooMany) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api.bulkDialList({ ids, ...(name.trim() ? { name: name.trim() } : {}) });
      setResult(r);
      if ('lead_ids' in r) {
        onDone(`${r.lead_ids.length.toLocaleString()} lead${r.lead_ids.length === 1 ? '' : 's'} ready — attach them to a campaign from Campaigns.`);
      }
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (result && 'campaign_id' in result) {
    return (
      <Modal title="Dial list ready" onClose={() => onDone(null)} width={440}>
        <div className="flex flex-col gap-3">
          <p style={{ font: '400 12.5px/1.5 Inter', color: 'var(--muted)' }}>
            <strong style={{ color: 'var(--text)' }}>{result.enrolled.toLocaleString()}</strong> enrolled
            {result.skipped > 0 && (
              <>
                {' · '}
                <strong style={{ color: 'var(--text)' }}>{result.skipped.toLocaleString()}</strong> skipped (no callable number)
              </>
            )}
            . Start a session from Campaigns when you are ready.
          </p>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button
              tone="accent"
              onClick={() => {
                onDone(null);
                router.push('/campaigns');
              }}
            >
              <Icon name="phone" size={14} />
              Open Campaigns
            </Button>
            <Button tone="ghost" onClick={() => onDone(null)}>
              Stay here
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Call ${ids.length.toLocaleString()} contact${ids.length === 1 ? '' : 's'}`} onClose={onClose} width={440}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void confirm();
        }}
      >
        <p style={{ font: '400 12.5px/1.5 Inter', color: 'var(--muted)' }}>
          Builds a dial list you can power through from Campaigns. Contacts without a phone, or marked do-not-call, are left out.
        </p>
        <Labeled label="List name">
          <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
        </Labeled>
        {tooMany && (
          <Notice tone="warn">A dial list takes up to {DIAL_LIST_MAX} contacts at once. Narrow the selection.</Notice>
        )}
        {err && <span style={{ font: '500 12px/1.4 Inter', color: 'var(--red)' }}>{err}</span>}
        <div className="flex flex-wrap items-center gap-1.5">
          <Button type="submit" tone="accent" disabled={busy || tooMany}>
            <Icon name="phone" size={14} />
            {busy ? 'Building…' : 'Create dial list'}
          </Button>
          <Button tone="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/* ── Bulk: text ───────────────────────────────────────────────────────────── */

function BulkTextModal({
  ids,
  sample,
  nameOf,
  templates,
  repName,
  onClose,
  onSent,
}: {
  ids: string[];
  sample: ContactDto | null;
  nameOf: (id: string) => string;
  templates: MessageTemplateDto[];
  repName: string | null;
  onClose: () => void;
  onSent: (result: ContactBulkMessageDto) => void;
}) {
  const [templateId, setTemplateId] = useState('');
  const [body, setBody] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [result, setResult] = useState<ContactBulkMessageDto | null>(null);
  const area = useRef<HTMLTextAreaElement | null>(null);

  const template = templates.find((t) => t.id === templateId) ?? null;
  const tooMany = ids.length > BULK_TEXT_MAX;
  const { chars, segments } = smsSegments(body);
  const preview = renderMergeFields(body, sample, repName);
  const ready = body.trim().length > 0 && !tooMany;

  const insert = (token: string) => {
    const el = area.current;
    const start = el?.selectionStart ?? body.length;
    const end = el?.selectionEnd ?? body.length;
    const next = `${body.slice(0, start)}${token}${body.slice(end)}`;
    setBody(next);
    // Editing the body by hand means the template no longer applies verbatim.
    if (template && next !== template.body) setTemplateId('');
    requestAnimationFrame(() => {
      if (!el) return;
      el.focus();
      const pos = start + token.length;
      el.setSelectionRange(pos, pos);
    });
  };

  const send = async () => {
    if (!ready || busy) return;
    setBusy(true);
    setErr(null);
    try {
      // A template chosen and left untouched goes by id so its use count moves.
      const useTemplate = template !== null && template.body === body;
      const r = await api.bulkMessageContacts({ ids, ...(useTemplate ? { template_id: template.id } : { body: body.trim() }) });
      setResult(r);
      onSent(r);
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (result) {
    const reasons = new Map<string, string[]>();
    for (const s of result.skipped) {
      const list = reasons.get(s.reason) ?? [];
      list.push(nameOf(s.id));
      reasons.set(s.reason, list);
    }
    return (
      <Modal title="Texts sent" onClose={onClose} width={480}>
        <div className="flex flex-col gap-3">
          <p style={{ font: '400 12.5px/1.5 Inter', color: 'var(--muted)' }}>
            <strong style={{ color: 'var(--text)' }}>{result.sent.toLocaleString()}</strong> sent
            {result.skipped.length > 0 && (
              <>
                {' · '}
                <strong style={{ color: 'var(--text)' }}>{result.skipped.length.toLocaleString()}</strong> skipped
              </>
            )}
          </p>
          {[...reasons.entries()].map(([reason, names]) => (
            <div key={reason} className="flex flex-col gap-1">
              <Eyebrow>{reason.replace(/_/g, ' ')}</Eyebrow>
              <span style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>
                {names.slice(0, 8).join(', ')}
                {names.length > 8 ? ` and ${names.length - 8} more` : ''}
              </span>
            </div>
          ))}
          <div>
            <Button tone="dark" onClick={onClose}>
              Done
            </Button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal title={`Text ${ids.length.toLocaleString()} contact${ids.length === 1 ? '' : 's'}`} onClose={onClose} width={620}>
      <div className="flex flex-col gap-3">
        {templates.length > 0 && (
          <Labeled label="Template">
            <Select
              value={templateId}
              onChange={(e) => {
                const t = templates.find((x) => x.id === e.target.value) ?? null;
                setTemplateId(t?.id ?? '');
                if (t) setBody(t.body);
              }}
            >
              <option value="">Write your own…</option>
              {templates.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {t.category ? ` · ${t.category}` : ''}
                </option>
              ))}
            </Select>
          </Labeled>
        )}

        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-1.5">
            <Eyebrow>Message</Eyebrow>
            <span className="ml-auto flex flex-wrap gap-1">
              {MERGE_FIELDS.map((f) => (
                <button
                  key={f.token}
                  type="button"
                  onClick={() => insert(f.token)}
                  title={`Insert ${f.token}`}
                  style={{
                    padding: '3px 7px',
                    borderRadius: 6,
                    border: '1px solid var(--line)',
                    background: 'var(--panel)',
                    font: '600 10px/1 Inter',
                    color: 'var(--accent)',
                    cursor: 'pointer',
                  }}
                >
                  {f.label}
                </button>
              ))}
            </span>
          </div>
          {/* A bare textarea: the shared TextArea does not forward a ref, and
              inserting a merge field needs the caret. */}
          <textarea
            ref={area}
            value={body}
            onChange={(e) => {
              setBody(e.target.value);
              if (template && e.target.value !== template.body) setTemplateId('');
            }}
            rows={5}
            placeholder="Hi {first_name}, this is {rep_name}…"
            aria-label="Message"
            autoFocus
            className="min-w-0"
            style={{ ...FIELD, lineHeight: 1.45, resize: 'vertical' }}
          />
          <span className="flex flex-wrap justify-between gap-2" style={{ font: '500 10.5px/1 Inter', color: segments > 3 ? 'var(--amber)' : 'var(--muted-2)' }}>
            <span>
              {chars} chars · {segments} SMS segment{segments === 1 ? '' : 's'}
            </span>
            <span>Opted-out and do-not-call numbers are skipped automatically.</span>
          </span>
        </div>

        <div className="flex flex-col gap-1.5">
          <Eyebrow>Preview{sample ? ` · ${sample.display_name}` : ''}</Eyebrow>
          <div
            style={{
              padding: '10px 14px',
              borderRadius: 16,
              background: 'var(--panel-2)',
              font: '400 13px/1.4 Inter',
              color: preview.trim() ? 'var(--text)' : 'var(--muted-2)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {preview.trim() || 'Your message, with merge fields filled in for the first contact.'}
          </div>
        </div>

        {tooMany && <Notice tone="warn">A text blast goes to at most {BULK_TEXT_MAX} contacts at once. Narrow the selection.</Notice>}
        {err && <span style={{ font: '500 12px/1.4 Inter', color: 'var(--red)' }}>{err}</span>}

        <div className="flex flex-wrap items-center gap-1.5">
          <Button tone="accent" disabled={!ready || busy} onClick={() => void send()}>
            <Icon name="send" size={14} />
            {busy ? 'Sending…' : `Send to ${ids.length.toLocaleString()}`}
          </Button>
          <Button tone="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
        </div>
      </div>
    </Modal>
  );
}

/* ── Import CSV ───────────────────────────────────────────────────────────── */

const IMPORT_FIELDS: Array<{ key: keyof ContactImportMapping; label: string; synonyms: string[] }> = [
  { key: 'display_name', label: 'Full name', synonyms: ['name', 'fullname', 'contactname', 'contact', 'ownername', 'owner', 'sellername', 'seller', 'displayname', 'buyername'] },
  { key: 'first_name', label: 'First name', synonyms: ['firstname', 'first', 'fname', 'givenname', 'ownerfirstname', 'firstname1'] },
  { key: 'last_name', label: 'Last name', synonyms: ['lastname', 'last', 'lname', 'surname', 'familyname', 'ownerlastname', 'lastname1'] },
  { key: 'phone', label: 'Phone', synonyms: ['phone', 'phonenumber', 'mobile', 'cell', 'cellphone', 'mobilephone', 'telephone', 'tel', 'phone1', 'primaryphone', 'number', 'mobile1'] },
  { key: 'phone2', label: 'Phone 2', synonyms: ['phone2', 'altphone', 'alternatephone', 'secondaryphone', 'otherphone', 'homephone', 'workphone', 'landline', 'phonenumber2', 'mobile2'] },
  { key: 'email', label: 'Email', synonyms: ['email', 'emailaddress', 'mail', 'email1'] },
  { key: 'company', label: 'Company', synonyms: ['company', 'companyname', 'business', 'organization', 'organisation', 'org', 'entity'] },
  { key: 'address_line1', label: 'Address', synonyms: ['address', 'street', 'streetaddress', 'address1', 'addressline1', 'propertyaddress', 'mailingaddress', 'situsaddress', 'propertystreet'] },
  { key: 'city', label: 'City', synonyms: ['city', 'town', 'propertycity', 'mailingcity'] },
  { key: 'state', label: 'State', synonyms: ['state', 'st', 'province', 'region', 'propertystate', 'mailingstate'] },
  { key: 'postal_code', label: 'ZIP', synonyms: ['zip', 'zipcode', 'postal', 'postalcode', 'postcode', 'propertyzip', 'mailingzip'] },
  { key: 'tags', label: 'Tags', synonyms: ['tags', 'tag', 'labels', 'label', 'list', 'listname'] },
  { key: 'notes', label: 'Notes', synonyms: ['notes', 'note', 'comments', 'comment', 'memo', 'remarks'] },
  { key: 'status', label: 'Status', synonyms: ['status', 'stage', 'leadstatus', 'contactstatus'] },
  { key: 'type', label: 'Type', synonyms: ['type', 'contacttype', 'role', 'category', 'kind'] },
];

function normalizeHeader(h: string): string {
  return h.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** First header that reads like each field wins; a second phone-like column becomes Phone 2. */
function autoMap(headers: string[]): ContactImportMapping {
  const mapping: ContactImportMapping = {};
  const phoneSynonyms = IMPORT_FIELDS.find((f) => f.key === 'phone')!.synonyms;
  for (const h of headers) {
    const n = normalizeHeader(h);
    const field = IMPORT_FIELDS.find((f) => f.synonyms.includes(n) && mapping[f.key] === undefined);
    if (field) mapping[field.key] = h;
    else if (phoneSynonyms.includes(n) && mapping.phone !== undefined && mapping.phone2 === undefined) mapping.phone2 = h;
  }
  return mapping;
}

type ImportStep = 'pick' | 'map' | 'run' | 'done';

interface ImportTally {
  created: number;
  merged: number;
  skipped: Array<{ row: number; reason: string }>;
}

function ImportModal({ onClose }: { onClose: (imported: boolean) => void }) {
  const [step, setStep] = useState<ImportStep>('pick');
  const [fileName, setFileName] = useState('');
  const [parsed, setParsed] = useState<ParsedCsv | null>(null);
  const [mapping, setMapping] = useState<ContactImportMapping>({});
  const [defType, setDefType] = useState<ContactType>('seller');
  const [defStatus, setDefStatus] = useState<ContactStatus | ''>('');
  const [defTags, setDefTags] = useState<string[]>([]);
  const [defSource, setDefSource] = useState('');
  const [dedupe, setDedupe] = useState<ContactImportDedupe>('merge');
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [nextBatch, setNextBatch] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const tally = useRef<ImportTally>({ created: 0, merged: 0, skipped: [] });
  const [, bump] = useState(0);
  const fileInput = useRef<HTMLInputElement | null>(null);

  const rows = parsed?.rows ?? [];
  const batches = Math.ceil(rows.length / IMPORT_BATCH);
  const imported = tally.current.created + tally.current.merged > 0;

  const pickFile = async (file: File) => {
    setErr(null);
    try {
      const text = await readFileText(file);
      const result = parseCsv(text);
      if (result.headers.length === 0 || result.rows.length === 0) {
        setErr('That file has no rows. Export it again with a header row and at least one contact.');
        return;
      }
      setParsed(result);
      setFileName(file.name);
      setMapping(autoMap(result.headers));
      setDefSource(file.name.replace(/\.[^.]+$/, ''));
      setStep('map');
    } catch (e) {
      setErr(errorMessage(e));
    }
  };

  const nameMapped = Boolean(mapping.display_name || mapping.first_name || mapping.last_name || mapping.company);
  const mappedFields = IMPORT_FIELDS.filter((f) => mapping[f.key]);

  const run = async (from: number) => {
    if (!parsed) return;
    setStep('run');
    setErr(null);
    setProgress({ done: Math.min(from * IMPORT_BATCH, rows.length), total: rows.length });
    for (let b = from; b < batches; b++) {
      const offset = b * IMPORT_BATCH;
      try {
        const r = await api.importContacts({
          rows: rows.slice(offset, offset + IMPORT_BATCH),
          mapping,
          defaults: {
            type: defType,
            ...(defStatus ? { status: defStatus } : {}),
            ...(defTags.length > 0 ? { tags: defTags } : {}),
            ...(defSource.trim() ? { source: defSource.trim() } : {}),
          },
          dedupe,
        });
        tally.current.created += r.created;
        tally.current.merged += r.merged;
        // The server numbers rows within the batch; re-key to the file.
        // Server rows are 1-based within the batch; keep 0-based file indexes here.
        tally.current.skipped.push(...r.skipped.map((s) => ({ row: offset + s.row - 1, reason: s.reason })));
        setProgress({ done: Math.min(offset + IMPORT_BATCH, rows.length), total: rows.length });
        bump((n) => n + 1);
      } catch (e) {
        setErr(errorMessage(e));
        setNextBatch(b);
        return;
      }
    }
    setStep('done');
  };

  const downloadSkipped = () => {
    if (!parsed) return;
    const headers = ['row', 'reason', ...parsed.headers];
    const body = tally.current.skipped.map((s) => [s.row + 1, s.reason, ...parsed.headers.map((h) => rows[s.row]?.[h] ?? '')]);
    downloadFile(new Blob([toCsv(headers, body)], { type: 'text/csv;charset=utf-8' }), `skipped-${fileName || 'contacts.csv'}`);
  };

  const title =
    step === 'pick' ? 'Import CSV' : step === 'map' ? `Import ${fileName}` : step === 'run' ? 'Importing…' : 'Import finished';

  return (
    <Modal title={title} onClose={() => onClose(imported)} width={720}>
      {step === 'pick' && (
        <div className="flex flex-col gap-3">
          <input
            ref={fileInput}
            type="file"
            accept=".csv,text/csv,text/plain"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pickFile(f);
              e.target.value = '';
            }}
          />
          <button
            type="button"
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) void pickFile(f);
            }}
            className="lift flex flex-col items-center justify-center gap-2 p-8 text-center"
            style={{ border: '1px dashed var(--line)', borderRadius: 12, background: 'var(--bg)', color: 'var(--muted)', cursor: 'pointer' }}
          >
            <Icon name="template" size={22} />
            <span style={{ font: '600 12.5px/1 Inter', color: 'var(--text)' }}>Choose a CSV, or drop it here</span>
            <span style={{ font: '400 11px/1.5 Inter' }}>
              A header row, then one contact per line. Names, phones, emails and addresses are matched automatically; you confirm the rest.
            </span>
          </button>
          {err && <span style={{ font: '500 12px/1.4 Inter', color: 'var(--red)' }}>{err}</span>}
        </div>
      )}

      {step === 'map' && parsed && (
        <div className="flex flex-col gap-4">
          <span style={{ font: '500 12px/1.4 Inter', color: 'var(--muted)' }}>
            {rows.length.toLocaleString()} row{rows.length === 1 ? '' : 's'} · {parsed.headers.length} columns
            {rows.length > IMPORT_BATCH ? ` · uploads in ${batches} batches` : ''}
          </span>

          <div className="flex flex-col gap-2">
            <Eyebrow>Columns</Eyebrow>
            <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
              {IMPORT_FIELDS.map((f) => (
                <Labeled key={f.key} label={f.label}>
                  <Select
                    value={mapping[f.key] ?? ''}
                    onChange={(e) => {
                      const col = e.target.value;
                      setMapping((m) => {
                        const next = { ...m };
                        if (col) next[f.key] = col;
                        else delete next[f.key];
                        return next;
                      });
                    }}
                    style={{ color: mapping[f.key] ? 'var(--text)' : 'var(--muted-2)' }}
                  >
                    <option value="">— skip —</option>
                    {parsed.headers.map((h) => (
                      <option key={h} value={h}>
                        {h}
                      </option>
                    ))}
                  </Select>
                </Labeled>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Eyebrow>Defaults for every row</Eyebrow>
            <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))' }}>
              <Labeled label={mapping.type ? 'Type when the column is blank' : 'Type'}>
                <Select value={defType} onChange={(e) => setDefType(pick(CONTACT_TYPES, e.target.value) ?? 'seller')}>
                  {CONTACT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABEL[t]}
                    </option>
                  ))}
                </Select>
              </Labeled>
              <Labeled label={mapping.status ? 'Status when the column is blank' : 'Status'}>
                <Select value={defStatus} onChange={(e) => setDefStatus(pick(CONTACT_STATUSES, e.target.value) ?? '')}>
                  <option value="">Server default (New)</option>
                  {CONTACT_STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABEL[s]}
                    </option>
                  ))}
                </Select>
              </Labeled>
              <Labeled label="Source">
                <Input value={defSource} onChange={(e) => setDefSource(e.target.value)} placeholder="propstream-march" />
              </Labeled>
              <Labeled label="Tags added to all">
                <TagsField tags={defTags} onChange={setDefTags} placeholder="list-name" />
              </Labeled>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Eyebrow>When a phone number already exists</Eyebrow>
            <div className="flex flex-wrap items-center gap-3">
              <Segmented
                value={dedupe}
                onChange={setDedupe}
                options={[
                  { value: 'skip', label: 'Skip row' },
                  { value: 'merge', label: 'Merge into existing' },
                  { value: 'create', label: 'Create anyway' },
                ]}
              />
              <span style={{ font: '400 11px/1.4 Inter', color: 'var(--muted)' }}>
                {dedupe === 'skip'
                  ? 'Existing contacts are left exactly as they are.'
                  : dedupe === 'merge'
                    ? 'Blank fields on the existing contact are filled from the file; tags are added.'
                    : 'Duplicates are allowed — use only for a list you know is clean.'}
              </span>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Eyebrow>Preview · first {Math.min(5, rows.length)} rows</Eyebrow>
            {mappedFields.length === 0 ? (
              <span style={{ font: '400 12px/1.4 Inter', color: 'var(--muted)' }}>Map at least one column to see a preview.</span>
            ) : (
              <div className="overflow-x-auto" style={{ border: '1px solid var(--line)', borderRadius: 10 }}>
                <table style={{ borderCollapse: 'collapse', width: '100%', minWidth: mappedFields.length * 130 }}>
                  <thead>
                    <tr style={{ background: 'var(--bg)' }}>
                      {mappedFields.map((f) => (
                        <th key={f.key} className="px-3 py-2 text-left" style={{ borderBottom: '1px solid var(--line)' }}>
                          <Eyebrow>{f.label}</Eyebrow>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 5).map((r, i) => (
                      <tr key={i}>
                        {mappedFields.map((f) => (
                          <td
                            key={f.key}
                            className="truncate px-3 py-2"
                            style={{ maxWidth: 200, borderBottom: '1px solid var(--panel-2)', font: '400 11.5px/1.3 Inter' }}
                            title={r[mapping[f.key]!] ?? ''}
                          >
                            {r[mapping[f.key]!] || <span style={{ color: 'var(--muted-2)' }}>—</span>}
                          </td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {!nameMapped && <Notice tone="warn">Map a name (full, first/last) or a company column so each row has something to call the contact.</Notice>}
          {!mapping.phone && nameMapped && (
            <Notice tone="warn">No phone column is mapped. Contacts import without a number, so they cannot be called or texted.</Notice>
          )}
          {err && <span style={{ font: '500 12px/1.4 Inter', color: 'var(--red)' }}>{err}</span>}

          <div className="flex flex-wrap items-center gap-1.5">
            <Button tone="accent" disabled={!nameMapped} onClick={() => void run(0)}>
              Import {rows.length.toLocaleString()} contact{rows.length === 1 ? '' : 's'}
            </Button>
            <Button
              tone="ghost"
              onClick={() => {
                setParsed(null);
                setStep('pick');
              }}
            >
              Choose another file
            </Button>
          </div>
        </div>
      )}

      {step === 'run' && (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <span style={{ font: '600 12.5px/1 Inter' }}>
              {progress.done.toLocaleString()} of {progress.total.toLocaleString()} rows
            </span>
            <span style={{ font: '500 11px/1 Inter', color: 'var(--muted)' }}>
              {tally.current.created.toLocaleString()} created · {tally.current.merged.toLocaleString()} merged · {tally.current.skipped.length.toLocaleString()} skipped
            </span>
          </div>
          <div style={{ height: 6, borderRadius: 3, background: 'var(--panel-2)', overflow: 'hidden' }}>
            <div
              style={{
                height: '100%',
                width: progress.total > 0 ? `${(progress.done / progress.total) * 100}%` : '0%',
                background: err ? 'var(--red)' : 'var(--accent)',
                transition: 'width .2s',
              }}
            />
          </div>
          {err ? (
            <Notice
              tone="error"
              action={
                <span className="flex gap-1.5">
                  <Button tone="dark" onClick={() => void run(nextBatch)}>
                    Retry from batch {nextBatch + 1}
                  </Button>
                  <Button tone="ghost" onClick={() => setStep('done')}>
                    Stop here
                  </Button>
                </span>
              }
            >
              {err}
            </Notice>
          ) : (
            <span style={{ font: '400 11.5px/1.4 Inter', color: 'var(--muted)' }}>Keep this window open until it finishes.</span>
          )}
        </div>
      )}

      {step === 'done' && (
        <div className="flex flex-col gap-4">
          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }}>
            {[
              { label: 'Created', value: tally.current.created, color: 'var(--green)' },
              { label: 'Merged', value: tally.current.merged, color: 'var(--text)' },
              { label: 'Skipped', value: tally.current.skipped.length, color: tally.current.skipped.length > 0 ? 'var(--amber)' : 'var(--text)' },
            ].map((k) => (
              <Card key={k.label} className="flex flex-col gap-2">
                <Eyebrow>{k.label}</Eyebrow>
                <span className="display" style={{ font: '700 22px/1 Inter', color: k.color }}>
                  {k.value.toLocaleString()}
                </span>
              </Card>
            ))}
          </div>

          {tally.current.skipped.length > 0 && (
            <div className="flex flex-col gap-2">
              <div className="flex items-center gap-2">
                <Eyebrow>Skipped rows</Eyebrow>
                <Button tone="ghost" className="ml-auto" onClick={downloadSkipped} style={{ padding: '6px 10px', font: '600 11px/1 Inter' }}>
                  <Icon name="forward" size={12} />
                  Download as CSV
                </Button>
              </div>
              <div className="flex max-h-48 flex-col overflow-auto" style={{ border: '1px solid var(--line)', borderRadius: 10 }}>
                {tally.current.skipped.slice(0, 50).map((s, i) => (
                  <span key={i} className="flex gap-3 px-3 py-1.5" style={{ borderBottom: '1px solid var(--panel-2)', font: '400 11.5px/1.4 Inter' }}>
                    <span style={{ color: 'var(--muted-2)', minWidth: 60 }}>Row {s.row + 1}</span>
                    <span className="truncate" style={{ color: 'var(--muted)' }}>
                      {rows[s.row] ? Object.values(rows[s.row]!).find(Boolean) ?? '' : ''}
                    </span>
                    <span className="ml-auto" style={{ color: 'var(--amber)' }}>{s.reason.replace(/_/g, ' ')}</span>
                  </span>
                ))}
                {tally.current.skipped.length > 50 && (
                  <span className="px-3 py-1.5" style={{ font: '400 11px/1.4 Inter', color: 'var(--muted-2)' }}>
                    and {(tally.current.skipped.length - 50).toLocaleString()} more — download the CSV for the full list.
                  </span>
                )}
              </div>
            </div>
          )}

          <div>
            <Button tone="dark" onClick={() => onClose(imported)}>
              Done
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
