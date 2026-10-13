'use client';

/**
 * One contact (design 1c): who they are, how to reach them, and everything
 * that has happened between them and the org. Every field saves in place —
 * a rep on a call cannot be sent to a form — and the temperature sits in the
 * header because it is the first thing the next rep needs to know.
 */

import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useParams, useRouter } from 'next/navigation';
import {
  ApiError,
  api,
  CONTACT_STATUSES,
  CONTACT_TYPES,
  TEMPERATURES,
  type ContactActivityDto,
  type ContactDto,
  type ContactPhoneDto,
  type ContactPhoneInput,
  type TeamMemberDto,
  type UpdateContactInput,
} from '@/lib/api';
import { useSoftphone } from '@/lib/softphone';
import { TopBar } from '@/components/TopBar';
import { Icon } from '@/components/Icon';
import { Avatar, Button, Card, EmptyState, Eyebrow, FIELD, Input, Labeled, Modal, Notice, SectionTitle, Select, StatusMarker } from '@/components/ui';
import {
  BAND_COLOR,
  IconButton,
  STATUS_COLOR,
  STATUS_LABEL,
  TEMP_LABEL,
  TYPE_LABEL,
  TagsField,
  TempDot,
  TypeBadge,
  degrees,
  errorMessage,
  isForbidden,
  oneLineAddress,
  tempBand,
} from '@/components/contacts';
import { PhoneText } from '@/components/CopyPhone';
import { duration, formatPhone, timeAgo, toE164 } from '@/lib/time';

function toPhoneInputs(phones: ContactPhoneDto[]): ContactPhoneInput[] {
  return phones.map((p) => ({
    phone: p.phone_e164,
    ...(p.label ? { label: p.label } : {}),
    is_primary: p.is_primary,
  }));
}

function pick<T extends string>(list: readonly T[], value: string): T | null {
  return list.find((x) => x === value) ?? null;
}

function whenFull(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export default function ContactDetailPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id ?? '';
  const router = useRouter();
  const { authed, placeCall } = useSoftphone();

  const [contact, setContact] = useState<ContactDto | null>(null);
  const [activity, setActivity] = useState<ContactActivityDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [saveErr, setSaveErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [team, setTeam] = useState<TeamMemberDto[] | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => {
    if (!authed || !id) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .getContact(id)
      .then((r) => {
        if (cancelled) return;
        setContact(r.contact);
        setActivity(r.activity);
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
  }, [authed, id]);

  useEffect(() => {
    if (!authed) return;
    api.listTeam().then((r) => setTeam(r.members)).catch(() => setTeam(null));
  }, [authed]);

  const save = useCallback(
    async (input: UpdateContactInput): Promise<boolean> => {
      setBusy(true);
      setSaveErr(null);
      try {
        const r = await api.updateContact(id, input);
        setContact(r.contact);
        return true;
      } catch (e) {
        setSaveErr(errorMessage(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [id],
  );

  const rescore = async () => {
    setBusy(true);
    setSaveErr(null);
    try {
      const r = await api.rescoreContact(id);
      setContact(r.contact);
    } catch (e) {
      setSaveErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    try {
      await api.deleteContact(id);
      router.push('/contacts');
    } catch (e) {
      setSaveErr(errorMessage(e));
      setBusy(false);
      setConfirmDelete(false);
    }
  };

  const call = (number: string) => {
    placeCall({ to_number: number, contact_id: id }).catch((e: unknown) => setSaveErr(errorMessage(e)));
  };
  const text = (number: string) => router.push(`/messages?to=${encodeURIComponent(number)}`);

  const timeline = useMemo(
    () => [...activity].sort((a, b) => new Date(b.at).getTime() - new Date(a.at).getTime()),
    [activity],
  );

  if (!authed) {
    return (
      <p className="p-6" style={{ font: '400 13px/1.5 Inter', color: 'var(--muted)' }}>
        Not signed in — open <a href="/login" style={{ color: 'var(--accent)' }}>Account</a>.
      </p>
    );
  }

  const back = (
    <Link href="/contacts" className="inline-flex items-center gap-1 self-start" style={{ font: '600 12px/1 Inter', color: 'var(--accent)' }}>
      <Icon name="chevron-left" size={14} />
      Contacts
    </Link>
  );

  if (!contact) {
    const notFound = error instanceof ApiError && error.status === 404;
    return (
      <>
        <TopBar title="Contact" subtitle={loading ? 'Loading…' : ''} />
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-auto p-5">
          {back}
          {loading && <p style={{ font: '400 12.5px/1.5 Inter', color: 'var(--muted)' }}>Loading contact…</p>}
          {!loading && isForbidden(error) && <Notice tone="error">You don’t have access to contacts.</Notice>}
          {!loading && notFound && <Notice tone="error">This contact no longer exists, or was deleted.</Notice>}
          {!loading && error !== null && !isForbidden(error) && !notFound && <Notice tone="error">{errorMessage(error)}</Notice>}
        </div>
      </>
    );
  }

  const c = contact;
  const primary = c.phones.find((p) => p.is_primary) ?? c.phones[0] ?? null;
  const dnc = c.status === 'dnc';
  // The select shows the three temperatures the server knows; the colour and
  // the reading beside it are banded, so a scalding lead is visible here too.
  const tempColor = BAND_COLOR[tempBand(c.temperature, c.temperature_score)];

  return (
    <>
      <TopBar title={c.display_name} subtitle={`${TYPE_LABEL[c.type]} · ${STATUS_LABEL[c.status]}${c.assigned_user_name ? ` · ${c.assigned_user_name}` : ''}`} />

      <div className="flex min-h-0 flex-1 flex-col gap-3.5 overflow-auto p-3 md:p-5">
        {back}

        {saveErr && (
          <Notice
            tone="error"
            action={
              <Button tone="quiet" onClick={() => setSaveErr(null)}>
                Dismiss
              </Button>
            }
          >
            {saveErr}
          </Notice>
        )}

        {/* ── Header ──────────────────────────────────────────────────── */}
        <Card className="flex flex-col gap-4">
          <div className="flex flex-wrap items-start gap-4">
            <Avatar name={c.display_name} size={52} />
            <div className="flex min-w-0 flex-1 flex-col gap-1.5" style={{ minWidth: 220 }}>
              <NameEditor value={c.display_name} disabled={busy} onSave={(v) => void save({ display_name: v })} />
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1" style={{ font: '500 11.5px/1.3 Inter', color: 'var(--muted)' }}>
                <TypeBadge type={c.type} />
                {/* The number the Call button would dial, in the header, copyable —
                    it is what a rep is asked for on every hand-off. */}
                {primary && <PhoneText e164={primary.phone_e164} size={20} style={{ color: 'var(--text)' }} />}
                {c.company && <span>{c.company}</span>}
                {c.email && <span>{c.email}</span>}
                {c.source && <span>via {c.source}</span>}
                <span style={{ color: 'var(--muted-2)' }}>added {now === null ? '—' : timeAgo(c.created_at, now)}</span>
              </span>
            </div>

            <div className="flex flex-wrap items-end gap-2.5">
              <Labeled label="Type">
                <Select
                  value={c.type}
                  disabled={busy}
                  onChange={(e) => {
                    const next = pick(CONTACT_TYPES, e.target.value);
                    if (next && next !== c.type) void save({ type: next });
                  }}
                >
                  {CONTACT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {TYPE_LABEL[t]}
                    </option>
                  ))}
                </Select>
              </Labeled>
              <Labeled label="Status">
                <span className="inline-flex items-center gap-2" style={{ ...FIELD, padding: '0 0 0 11px' }}>
                  <span style={{ width: 6, height: 6, background: STATUS_COLOR[c.status], flexShrink: 0 }} aria-hidden />
                  <select
                    value={c.status}
                    disabled={busy}
                    onChange={(e) => {
                      const next = pick(CONTACT_STATUSES, e.target.value);
                      if (next && next !== c.status) void save({ status: next });
                    }}
                    style={{ border: 'none', background: 'transparent', padding: '9px 8px 9px 0', font: '500 12.5px/1 Inter', color: 'var(--text)', outline: 'none' }}
                  >
                    {CONTACT_STATUSES.map((s) => (
                      <option key={s} value={s}>
                        {STATUS_LABEL[s]}
                      </option>
                    ))}
                  </select>
                </span>
              </Labeled>
              <Labeled label={c.temperature_locked ? 'Temperature · set by hand' : 'Temperature'}>
                <span className="inline-flex items-center gap-2" style={{ ...FIELD, padding: '0 6px 0 11px' }}>
                  <TempDot temperature={c.temperature} score={c.temperature_score} />
                  <select
                    value={c.temperature}
                    disabled={busy}
                    title="Choosing a temperature locks it; the score stops moving it until you unlock."
                    onChange={(e) => {
                      const next = pick(TEMPERATURES, e.target.value);
                      if (next && next !== c.temperature) void save({ temperature: next });
                    }}
                    style={{ border: 'none', background: 'transparent', padding: '9px 4px 9px 0', font: `600 12.5px/1 Inter`, color: tempColor, outline: 'none' }}
                  >
                    {TEMPERATURES.map((t) => (
                      <option key={t} value={t}>
                        {TEMP_LABEL[t]}
                      </option>
                    ))}
                  </select>
                  <span
                    className="inline-flex items-center gap-1 pl-2"
                    style={{ borderLeft: '1px solid var(--line)', font: '600 11px/1 Inter', color: 'var(--muted)' }}
                    title="Engagement score, 0–100°"
                  >
                    {degrees(c.temperature_score)}
                    {c.temperature_locked && (
                      <span style={{ font: '600 8.5px/1 Inter', letterSpacing: '0.08em', color: 'var(--muted-2)' }} title="Locked by a manual override">
                        LOCK
                      </span>
                    )}
                  </span>
                  {c.temperature_locked ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void save({ temperature_locked: false })}
                      title="Let the score set the temperature again"
                      style={{ font: '600 11px/1 Inter', color: 'var(--accent)', cursor: 'pointer', padding: '6px 6px' }}
                    >
                      Unlock
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => void rescore()}
                      title="Recompute the score from recent activity"
                      style={{ font: '600 11px/1 Inter', color: 'var(--accent)', cursor: 'pointer', padding: '6px 6px' }}
                    >
                      Rescore
                    </button>
                  )}
                </span>
              </Labeled>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-1.5" style={{ borderTop: '1px solid var(--line)', paddingTop: 12 }}>
            <Button
              tone="accent"
              disabled={!primary || dnc}
              title={dnc ? 'Do not call' : primary ? `Call ${formatPhone(primary.phone_e164)}` : 'No phone on file'}
              onClick={() => primary && call(primary.phone_e164)}
            >
              <Icon name="phone" size={14} />
              Call
            </Button>
            <Button tone="ghost" disabled={!primary} title={primary ? 'Open a text thread' : 'No phone on file'} onClick={() => primary && text(primary.phone_e164)}>
              <Icon name="msg" size={14} />
              Text
            </Button>
            {c.lead_id && (
              <StatusMarker className="ml-2" color="var(--accent)" label={`Lead · ${(c.lead_status ?? 'open').replace(/_/g, ' ')}`} />
            )}
            <Button tone="quiet" className="ml-auto" style={{ color: 'var(--red)' }} disabled={busy} onClick={() => setConfirmDelete(true)}>
              <Icon name="x" size={13} />
              Delete
            </Button>
          </div>
        </Card>

        <div className="grid gap-3.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(min(340px, 100%), 1fr))' }}>
          {/* ── Phones ─────────────────────────────────────────────────── */}
          <Card className="flex flex-col gap-3">
            <SectionTitle icon={<Icon name="phone" size={15} />}>Phones</SectionTitle>
            {c.phones.length === 0 && (
              <p style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>No number yet — add one below to call or text.</p>
            )}
            {c.phones.map((p) => (
              <div key={p.id} className="flex flex-wrap items-center gap-2">
                <span className="flex min-w-0 flex-1 flex-col gap-1" style={{ minWidth: 140 }}>
                  <PhoneText e164={p.phone_e164} style={{ font: '600 13px/1 Inter' }} />
                  <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted)' }}>
                    {[p.label, p.is_primary ? 'Primary' : null].filter(Boolean).join(' · ') || 'Phone'}
                  </span>
                </span>
                <IconButton label="Call" icon="phone" accent disabled={dnc || busy} title={dnc ? 'Do not call' : 'Call'} onClick={() => call(p.phone_e164)} />
                <IconButton label="Text" icon="msg" disabled={busy} onClick={() => text(p.phone_e164)} />
                {!p.is_primary && (
                  <Button
                    tone="ghost"
                    disabled={busy}
                    style={{ padding: '6px 9px', font: '600 11px/1 Inter' }}
                    onClick={() => void save({ phones: toPhoneInputs(c.phones).map((x) => ({ ...x, is_primary: x.phone === p.phone_e164 })) })}
                  >
                    Make primary
                  </Button>
                )}
                <IconButton
                  label="Remove"
                  icon="x"
                  danger
                  disabled={busy}
                  onClick={() => {
                    const rest = toPhoneInputs(c.phones.filter((x) => x.id !== p.id));
                    if (rest.length > 0 && !rest.some((x) => x.is_primary)) rest[0]!.is_primary = true;
                    void save({ phones: rest });
                  }}
                />
              </div>
            ))}
            <AddPhone disabled={busy} onAdd={(phone, label) => save({ phones: [...toPhoneInputs(c.phones), { phone, ...(label ? { label } : {}), is_primary: c.phones.length === 0 }] })} />
          </Card>

          {/* ── Details ────────────────────────────────────────────────── */}
          <Card className="flex flex-col gap-3">
            <SectionTitle icon={<Icon name="user" size={15} />}>Details</SectionTitle>
            <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))' }}>
              <Labeled label="Email">
                <BlurInput type="email" value={c.email} placeholder="none" disabled={busy} onSave={(v) => void save({ email: v })} />
              </Labeled>
              <Labeled label="Company">
                <BlurInput value={c.company} placeholder="none" disabled={busy} onSave={(v) => void save({ company: v })} />
              </Labeled>
              <Labeled label="Source">
                <BlurInput value={c.source} placeholder="none" disabled={busy} onSave={(v) => void save({ source: v })} />
              </Labeled>
              <Labeled label="Rep">
                {team && team.length > 0 ? (
                  <Select value={c.assigned_user_id ?? ''} disabled={busy} onChange={(e) => void save({ assigned_user_id: e.target.value || null })}>
                    <option value="">Unassigned</option>
                    {c.assigned_user_id && !team.some((m) => m.id === c.assigned_user_id) && (
                      <option value={c.assigned_user_id}>{c.assigned_user_name ?? 'Former teammate'}</option>
                    )}
                    {team.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.display_name}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <span style={{ ...FIELD, color: 'var(--muted)' }}>{c.assigned_user_name ?? 'Unassigned'}</span>
                )}
              </Labeled>
            </div>
            <Labeled label="Tags">
              <TagsField tags={c.tags} disabled={busy} onChange={(tags) => void save({ tags })} />
            </Labeled>
            <Labeled label="Notes">
              <BlurTextArea value={c.notes} placeholder="Anything the next rep should know" disabled={busy} onSave={(v) => void save({ notes: v })} />
            </Labeled>
          </Card>

          {/* ── Address + lead ─────────────────────────────────────────── */}
          <Card className="flex flex-col gap-3">
            <SectionTitle icon={<Icon name="pin" size={15} />} right={c.address && <span style={{ font: '500 11px/1.3 Inter', color: 'var(--muted)' }}>{oneLineAddress(c.address)}</span>}>
              {c.type === 'seller' || c.type === 'buyer' ? 'Property' : 'Address'}
            </SectionTitle>
            <AddressFields contact={c} disabled={busy} onSave={(address) => void save({ address })} />
            <div className="flex flex-col gap-1.5 pt-1" style={{ borderTop: '1px solid var(--line)' }}>
              <Eyebrow>Lead</Eyebrow>
              {c.lead_id ? (
                <span style={{ font: '500 12px/1.4 Inter' }}>
                  {(c.lead_status ?? 'open').replace(/_/g, ' ')}
                  <span style={{ color: 'var(--muted-2)' }}> · {c.lead_id.slice(0, 8)}</span>
                </span>
              ) : (
                <span style={{ font: '400 12px/1.4 Inter', color: 'var(--muted)' }}>No lead yet — one is opened by the first call or text.</span>
              )}
            </div>
          </Card>

          {/* ── Activity ───────────────────────────────────────────────── */}
          <Card className="col-span-full flex flex-col gap-3">
            <SectionTitle icon={<Icon name="clock" size={15} />}>
              Activity
              <span style={{ font: '500 11px/1 Inter', color: 'var(--muted-2)' }}>
                {' '}
                · {timeline.length} event{timeline.length === 1 ? '' : 's'}
              </span>
            </SectionTitle>
            {timeline.length === 0 && (
              <EmptyState compact icon="clock" title="Nothing yet" hint="Calls and texts with this contact show up here." />
            )}
            <ol className="flex flex-col">
              {timeline.map((a) => (
                <ActivityRow key={`${a.kind}-${a.id}`} a={a} now={now} />
              ))}
            </ol>
          </Card>
        </div>
      </div>

      {confirmDelete && (
        <Modal title="Delete contact" onClose={() => setConfirmDelete(false)} width={440}>
          <div className="flex flex-col gap-3">
            <p style={{ font: '400 12.5px/1.5 Inter', color: 'var(--muted)' }}>
              {c.display_name} will be removed from every list and search. Their calls and texts stay in history, and an admin can restore them.
            </p>
            <div className="flex flex-wrap items-center gap-1.5">
              <Button tone="red" disabled={busy} onClick={() => void remove()}>
                {busy ? 'Deleting…' : 'Delete'}
              </Button>
              <Button tone="ghost" onClick={() => setConfirmDelete(false)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        </Modal>
      )}
    </>
  );
}

/* ── Field helpers ────────────────────────────────────────────────────────── */

/** The name as display text until clicked, then a field; Enter or blur saves. */
function NameEditor({ value, disabled, onSave }: { value: string; disabled: boolean; onSave: (next: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);

  if (!editing) {
    return (
      <button
        type="button"
        onClick={() => setEditing(true)}
        title="Rename"
        className="display self-start text-left"
        style={{ font: '700 22px/1.1 Inter', letterSpacing: '-0.02em', cursor: 'text', background: 'transparent', border: 'none', padding: 0 }}
      >
        {value}
      </button>
    );
  }
  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== value) onSave(next);
    else setDraft(value);
  };
  return (
    <input
      value={draft}
      autoFocus
      disabled={disabled}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
        if (e.key === 'Escape') {
          setDraft(value);
          setEditing(false);
        }
      }}
      aria-label="Name"
      className="display min-w-0"
      style={{ ...FIELD, font: '700 20px/1.1 Inter', letterSpacing: '-0.02em', padding: '6px 10px', maxWidth: 420 }}
    />
  );
}

/** Saves on blur when changed; empty means null. */
function BlurInput({
  value,
  placeholder,
  disabled,
  type = 'text',
  onSave,
}: {
  value: string | null;
  placeholder?: string;
  disabled?: boolean;
  type?: string;
  onSave: (next: string | null) => void;
}) {
  return (
    <Input
      key={value ?? ''}
      type={type}
      defaultValue={value ?? ''}
      placeholder={placeholder}
      disabled={disabled}
      onBlur={(e) => {
        const next = e.target.value.trim() || null;
        if (next !== value) onSave(next);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
    />
  );
}

function BlurTextArea({
  value,
  placeholder,
  disabled,
  onSave,
}: {
  value: string | null;
  placeholder?: string;
  disabled?: boolean;
  onSave: (next: string | null) => void;
}) {
  return (
    <textarea
      key={value ?? ''}
      defaultValue={value ?? ''}
      placeholder={placeholder}
      disabled={disabled}
      rows={4}
      onBlur={(e) => {
        const next = e.target.value.trim() || null;
        if (next !== value) onSave(next);
      }}
      className="min-w-0"
      style={{ ...FIELD, lineHeight: 1.45, resize: 'vertical' }}
    />
  );
}

function AddPhone({ disabled, onAdd }: { disabled: boolean; onAdd: (phone: string, label: string) => Promise<boolean> }) {
  const [phone, setPhone] = useState('');
  const [label, setLabel] = useState('');
  const digits = phone.replace(/\D/g, '');
  const ok = digits.length === 10 || (digits.length === 11 && digits.startsWith('1'));
  return (
    <form
      className="flex flex-wrap items-end gap-2 pt-1"
      style={{ borderTop: '1px solid var(--line)' }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok || disabled) return;
        void onAdd(toE164(phone), label.trim()).then((saved) => {
          if (saved) {
            setPhone('');
            setLabel('');
          }
        });
      }}
    >
      <Labeled label="Add a number" className="flex-1" >
        <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="(512) 555-0134" inputMode="tel" autoComplete="off" style={{ minWidth: 150 }} />
      </Labeled>
      <Labeled label="Label">
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="mobile" style={{ width: 110 }} />
      </Labeled>
      <Button type="submit" tone="ghost" disabled={!ok || disabled}>
        <Icon name="plus" size={13} />
        Add
      </Button>
    </form>
  );
}

function AddressFields({
  contact: c,
  disabled,
  onSave,
}: {
  contact: ContactDto;
  disabled: boolean;
  onSave: (address: { line1?: string; city?: string; state?: string; postal_code?: string } | null) => void;
}) {
  const a = c.address;
  const commit = (patch: Partial<Record<'line1' | 'city' | 'state' | 'postal_code', string | null>>) => {
    const merged = {
      line1: patch.line1 !== undefined ? patch.line1 : (a?.line1 ?? null),
      city: patch.city !== undefined ? patch.city : (a?.city ?? null),
      state: patch.state !== undefined ? patch.state : (a?.state ?? null),
      postal_code: patch.postal_code !== undefined ? patch.postal_code : (a?.postal_code ?? null),
    };
    const empty = !merged.line1 && !merged.city && !merged.state && !merged.postal_code;
    onSave(
      empty
        ? null
        : {
            ...(merged.line1 ? { line1: merged.line1 } : {}),
            ...(merged.city ? { city: merged.city } : {}),
            ...(merged.state ? { state: merged.state.toUpperCase() } : {}),
            ...(merged.postal_code ? { postal_code: merged.postal_code } : {}),
          },
    );
  };
  return (
    <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))' }}>
      <Labeled label="Street" className="col-span-full">
        <BlurInput value={a?.line1 ?? null} placeholder="1207 Elm St" disabled={disabled} onSave={(v) => commit({ line1: v })} />
      </Labeled>
      <Labeled label="City">
        <BlurInput value={a?.city ?? null} placeholder="Austin" disabled={disabled} onSave={(v) => commit({ city: v })} />
      </Labeled>
      <Labeled label="State">
        <BlurInput value={a?.state ?? null} placeholder="TX" disabled={disabled} onSave={(v) => commit({ state: v })} />
      </Labeled>
      <Labeled label="ZIP">
        <BlurInput value={a?.postal_code ?? null} placeholder="78702" disabled={disabled} onSave={(v) => commit({ postal_code: v })} />
      </Labeled>
    </div>
  );
}

/* ── Activity ─────────────────────────────────────────────────────────────── */

const CALL_STATUS_COLOR: Record<string, string> = {
  completed: 'var(--green)',
  in_progress: 'var(--accent)',
  no_answer: 'var(--amber)',
  busy: 'var(--amber)',
  failed: 'var(--red)',
  canceled: 'var(--muted)',
  delivered: 'var(--green)',
  sent: 'var(--green)',
  undelivered: 'var(--red)',
  received: 'var(--green)',
};

function ActivityRow({ a, now }: { a: ContactActivityDto; now: number | null }) {
  const inbound = a.direction === 'inbound';
  const isCall = a.kind === 'call';
  const color = CALL_STATUS_COLOR[a.status] ?? 'var(--muted)';
  const facts: ReactNode[] = [];
  if (isCall && a.duration_seconds !== null && a.duration_seconds > 0) facts.push(<span key="d">{duration(a.duration_seconds)}</span>);
  if (a.disposition_label) {
    facts.push(
      <span key="disp" style={{ padding: '2px 6px', borderRadius: 5, background: 'var(--panel-2)', font: '700 8.5px/1 Inter', letterSpacing: '0.07em', textTransform: 'uppercase', color: 'var(--muted)' }}>
        {a.disposition_label}
      </span>,
    );
  }
  if (a.user_name) facts.push(<span key="u">{a.user_name}</span>);

  return (
    <li className="flex gap-3 py-2.5" style={{ borderBottom: '1px solid var(--panel-2)' }}>
      <span
        className="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center"
        style={{ borderRadius: 8, background: 'var(--panel-2)', color: inbound ? 'var(--green)' : 'var(--accent)' }}
        aria-hidden
      >
        <Icon name={isCall ? 'phone' : 'msg'} size={13} />
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span style={{ font: '600 12.5px/1 Inter' }}>
            {inbound ? 'Inbound' : 'Outbound'} {isCall ? 'call' : 'text'}
          </span>
          <span className="inline-flex items-center gap-1.5" style={{ font: '600 10px/1 Inter', color }}>
            <span style={{ width: 6, height: 6, background: color }} aria-hidden />
            {a.status.replace(/_/g, ' ')}
          </span>
          <span className="ml-auto" title={whenFull(a.at)} style={{ font: '500 10.5px/1 Inter', color: 'var(--muted-2)' }}>
            {now === null ? '' : timeAgo(a.at, now)}
          </span>
        </span>
        {facts.length > 0 && (
          <span className="flex flex-wrap items-center gap-2" style={{ font: '500 11px/1 Inter', color: 'var(--muted)' }}>
            {facts}
          </span>
        )}
        {a.body && (
          <span style={{ font: '400 12px/1.45 Inter', color: 'var(--text)', whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{a.body}</span>
        )}
      </span>
    </li>
  );
}
