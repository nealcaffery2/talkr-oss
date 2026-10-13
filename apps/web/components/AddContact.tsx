'use client';

/**
 * "Save this number" — the one piece every surface that can show an unknown
 * number reuses: History rows, the SMS inbox, a call's detail page, the
 * wrap-up right after hanging up.
 *
 * The number is never retyped: it arrives prefilled and read-only, so the rep
 * only supplies the name. A duplicate (409 `duplicate_phone`) is not an error
 * the rep has to decode — it offers the existing contact and a merge.
 */

import { useCallback, useEffect, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import Link from 'next/link';
import {
  ApiError,
  api,
  CONTACT_TYPES,
  type ContactDto,
  type ContactType,
  type CreateContactInput,
} from '@/lib/api';
import { Icon } from './Icon';
import { Button, Eyebrow, Input, Labeled, Modal, Notice, TextArea, type ButtonTone } from './ui';
import { TYPE_LABEL, TagsField, errorMessage, isOrgType } from './contacts';
import { formatPhone, toE164 } from '@/lib/time';

/** What every caller gets back; `merged` is true when a duplicate was folded in. */
export type AddContactHandler = (contact: ContactDto, merged: boolean) => void;

/* ── Modal ────────────────────────────────────────────────────────────────── */

/** Wrapping segmented control for the six contact types, sized for a compact modal. */
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

export function AddContactModal({
  phone,
  nameHint,
  onClose,
  onCreated,
}: {
  /** The number to save, in any shape; sent to the API as E.164. */
  phone: string;
  /** A name the surface already knows (a caller-ID label, a lead name). */
  nameHint?: string | null;
  onClose: () => void;
  onCreated: AddContactHandler;
}) {
  const [type, setType] = useState<ContactType>('seller');
  const [name, setName] = useState((nameHint ?? '').trim());
  const [company, setCompany] = useState('');
  const [email, setEmail] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [addrOpen, setAddrOpen] = useState(false);
  const [line1, setLine1] = useState('');
  const [city, setCity] = useState('');
  const [state, setState] = useState('');
  const [zip, setZip] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  /** The existing contact's id after a 409; '' when the server did not say which. */
  const [dupId, setDupId] = useState<string | null>(null);

  const org = isOrgType(type);
  const displayName = name.trim() || (org ? company.trim() : '');
  const ready = displayName.length > 0;
  const pretty = formatPhone(phone) || phone;

  // Escape closes even when focus sits on the modal chrome rather than a field.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  /**
   * While the modal is open it owns the keyboard. The wrap-up screen listens on
   * `window` for digits (pick a disposition) and Enter (save), and typing a name
   * here must never reach it.
   */
  const captureKeys = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') onClose();
    e.stopPropagation();
  };

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
        phone: toE164(phone),
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(company.trim() ? { company: company.trim() } : {}),
        ...(tags.length > 0 ? { tags } : {}),
        ...(notes.trim() ? { notes: notes.trim() } : {}),
        ...(address ? { address } : {}),
        source: 'quick_add',
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
        autoComplete="off"
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
        autoComplete="off"
      />
    </Labeled>
  );

  return (
    <Modal title="Add contact" onClose={onClose} width={560}>
      <div onKeyDown={captureKeys}>
        <form
          className="flex flex-col gap-3.5"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(false);
          }}
        >
          <div
            className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2.5"
            style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-btn)', background: 'var(--panel-2)' }}
          >
            <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>
              <Icon name="phone" size={14} />
            </span>
            <span style={{ font: '700 14px/1 Inter', letterSpacing: '-0.01em' }}>{pretty}</span>
            <span style={{ font: '500 10.5px/1.4 Inter', color: 'var(--muted)' }}>
              Saved as this contact’s primary number.
            </span>
          </div>

          <div className="flex flex-col gap-1.5">
            <Eyebrow>Type</Eyebrow>
            <TypeSegments value={type} onChange={setType} />
          </div>

          <div className="grid gap-3" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))' }}>
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
            <Labeled label="Email">
              <Input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="jordan@example.com"
                autoComplete="off"
              />
            </Labeled>
          </div>

          <Labeled label="Tags">
            <TagsField tags={tags} onChange={setTags} placeholder="probate, absentee…" />
          </Labeled>

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
              <div className="grid gap-2.5" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))' }}>
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

          <Labeled label="Notes">
            <TextArea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Anything the next rep should know"
            />
          </Labeled>

          {dupId !== null && (
            <Notice
              tone="warn"
              action={
                <span className="flex flex-wrap gap-1.5">
                  {dupId && (
                    <Link
                      href={`/contacts/${dupId}`}
                      className="inline-flex items-center justify-center"
                      style={{
                        borderRadius: 'var(--r-btn)',
                        padding: '9px 13px',
                        font: '600 12.5px/1 Inter',
                        background: 'var(--panel)',
                        color: 'var(--text)',
                        border: '1px solid var(--line)',
                      }}
                    >
                      Open contact
                    </Link>
                  )}
                  <Button tone="dark" onClick={() => void submit(true)} disabled={busy}>
                    {busy ? 'Merging…' : 'Merge into it'}
                  </Button>
                </span>
              }
            >
              Already a contact — {pretty} is on file.
            </Notice>
          )}

          <div className="flex flex-wrap items-center gap-1.5">
            <Button type="submit" tone="accent" disabled={!ready || busy}>
              {busy ? 'Saving…' : 'Add contact'}
            </Button>
            <Button tone="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            {err && (
              <span className="ml-auto" style={{ font: '500 12px/1.4 Inter', color: 'var(--red)' }}>
                {err}
              </span>
            )}
          </div>
        </form>
      </div>
    </Modal>
  );
}

/* ── Trigger ──────────────────────────────────────────────────────────────── */

export type AddContactSize = 'icon' | 'sm' | 'md';

/**
 * The affordance itself. Renders nothing without a number, so a surface can
 * drop it in beside a name that may or may not be known.
 */
export function AddContactButton({
  phone,
  nameHint,
  size = 'sm',
  tone = 'ghost',
  label = 'Add contact',
  labelClassName,
  className = '',
  onCreated,
}: {
  phone: string | null | undefined;
  nameHint?: string | null;
  size?: AddContactSize;
  tone?: ButtonTone;
  label?: string;
  /**
   * e.g. "max-sm:sr-only" to keep a tight header from wrapping on a phone
   * while the button keeps its name for a screen reader.
   */
  labelClassName?: string;
  className?: string;
  onCreated?: AddContactHandler;
}) {
  const [open, setOpen] = useState(false);
  const pretty = phone ? formatPhone(phone) || phone : '';
  const aria = `${label} ${pretty}`.trim();

  // The wrap-up screen reads keys off `window`; Enter on this button must open
  // the modal, not also save the disposition behind it.
  const stopKeys = (e: ReactKeyboardEvent<HTMLElement>) => e.stopPropagation();

  if (!phone) return null;

  return (
    <>
      {size === 'icon' ? (
        <button
          type="button"
          aria-label={aria}
          title={aria}
          onClick={() => setOpen(true)}
          onKeyDown={stopKeys}
          className={`inline-flex h-7 w-7 shrink-0 items-center justify-center ${className}`}
          style={{
            borderRadius: 8,
            border: '1px solid var(--line)',
            background: 'var(--panel)',
            color: 'var(--accent)',
            cursor: 'pointer',
          }}
        >
          <Icon name="plus" size={13} />
        </button>
      ) : (
        <span onKeyDown={stopKeys} className={`inline-flex ${className}`}>
          <Button
            tone={tone}
            onClick={() => setOpen(true)}
            title={aria}
            style={size === 'sm' ? { padding: '7px 10px', font: '600 11.5px/1 Inter' } : undefined}
          >
            <Icon name="plus" size={size === 'sm' ? 13 : 14} />
            <span className={labelClassName}>{label}</span>
          </Button>
        </span>
      )}

      {open && (
        <AddContactModal
          phone={phone}
          nameHint={nameHint}
          onClose={() => setOpen(false)}
          onCreated={(contact, merged) => {
            setOpen(false);
            onCreated?.(contact, merged);
          }}
        />
      )}
    </>
  );
}

/* ── Lookup helper ────────────────────────────────────────────────────────── */

export interface KnownNumber {
  /** The contact behind the number once the lookup answered; null when nobody owns it. */
  contact: { id: string; display_name: string } | null;
  loading: boolean;
  /** Fold a contact created here in, instead of asking the server again. */
  remember: (contact: ContactDto) => void;
}

/**
 * Is this number already somebody? Only for surfaces that hold a bare number
 * and nothing else — anywhere the page already carries a `contact_name`, use
 * that instead of a round trip.
 */
export function useIsKnownNumber(phone: string | null | undefined): KnownNumber {
  const [contact, setContact] = useState<KnownNumber['contact']>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const raw = (phone ?? '').trim();
    setContact(null);
    if (raw.replace(/\D/g, '').length < 10) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);
    api
      .lookupPhone(toE164(raw))
      .then((r) => {
        if (!cancelled) setContact(r.contact);
      })
      .catch(() => {
        // A failed lookup means "we don't know", never "no contact exists".
        if (!cancelled) setContact(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [phone]);

  const remember = useCallback(
    (c: ContactDto) => setContact({ id: c.id, display_name: c.display_name }),
    [],
  );

  return { contact, loading, remember };
}
