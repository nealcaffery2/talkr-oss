/**
 * Pure helpers for the contacts module (docs/contacts.md §5–6): turning an
 * import row into a contact, rendering bulk-message merge fields, and
 * writing CSV. No I/O here — the route composes these with the database so
 * the mapping rules are unit-tested on their own.
 */

import {
  CONTACT_STATUSES,
  CONTACT_TYPES,
  isContactStatus,
  isContactType,
  normalizePhone,
  type ContactStatus,
  type ContactType,
} from '@talkr/core';

// ---------------------------------------------------------------------------
// Phones and emails
// ---------------------------------------------------------------------------

/** E.164 or null; Twilio client identities are not contact phones. */
export function normalizeContactPhone(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  const n = normalizePhone(trimmed);
  if (!n.ok || n.e164.startsWith('client:')) return null;
  return n.e164;
}

/** Lowercased email or null when the value is blank or not shaped like one. */
export function normalizeEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  if (!value) return null;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || value.length > 254) return null;
  return value;
}

export interface PhoneInput {
  phone: string;
  label?: string | null;
  is_primary?: boolean;
}

export interface NormalizedPhone {
  phoneE164: string;
  label: string | null;
  isPrimary: boolean;
}

export type PhoneListResult =
  | { ok: true; phones: NormalizedPhone[] }
  | { ok: false; invalid: string };

/**
 * Normalize a phone list, drop duplicates, and make exactly one primary
 * (the first flagged, else the first). Any un-normalizable entry fails the
 * whole list — the API answers 400 rather than silently keeping fewer numbers.
 */
export function normalizePhoneList(inputs: PhoneInput[]): PhoneListResult {
  const seen = new Set<string>();
  const phones: NormalizedPhone[] = [];
  for (const input of inputs) {
    const e164 = normalizeContactPhone(input.phone);
    if (!e164) return { ok: false, invalid: input.phone };
    if (seen.has(e164)) continue;
    seen.add(e164);
    phones.push({
      phoneE164: e164,
      label: input.label?.trim() ? input.label.trim() : null,
      isPrimary: input.is_primary === true,
    });
  }
  const primaryIndex = Math.max(
    0,
    phones.findIndex((p) => p.isPrimary),
  );
  phones.forEach((p, i) => {
    p.isPrimary = i === primaryIndex;
  });
  return { ok: true, phones };
}

// ---------------------------------------------------------------------------
// Tags
// ---------------------------------------------------------------------------

/** Trim, drop blanks, dedupe case-insensitively (first spelling wins), keep order. */
export function normalizeTags(tags: Array<string | null | undefined>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    if (typeof raw !== 'string') continue;
    const tag = raw.trim().slice(0, 60);
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

/** "a, b; c" → ["a", "b", "c"]. */
export function splitTags(cell: string | null | undefined): string[] {
  if (typeof cell !== 'string') return [];
  return normalizeTags(cell.split(/[,;|]/));
}

// ---------------------------------------------------------------------------
// Import mapping
// ---------------------------------------------------------------------------

export interface ImportMapping {
  display_name?: string;
  first_name?: string;
  last_name?: string;
  phone?: string;
  phone2?: string;
  email?: string;
  company?: string;
  address_line1?: string;
  city?: string;
  state?: string;
  postal_code?: string;
  tags?: string;
  notes?: string;
  status?: string;
  type?: string;
}

export interface ImportDefaults {
  type?: string;
  status?: string;
  tags?: string[];
  source?: string;
}

export interface ImportAddress {
  line1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
}

export interface MappedContact {
  displayName: string;
  type: ContactType;
  status: ContactStatus;
  phones: NormalizedPhone[];
  email: string | null;
  company: string | null;
  address: ImportAddress | null;
  tags: string[];
  notes: string | null;
  source: string | null;
}

export type ImportRowResult =
  | { ok: true; contact: MappedContact }
  | { ok: false; reason: 'no_phone_or_email' | 'empty_row' };

export const IMPORT_MAPPING_KEYS = [
  'display_name',
  'first_name',
  'last_name',
  'phone',
  'phone2',
  'email',
  'company',
  'address_line1',
  'city',
  'state',
  'postal_code',
  'tags',
  'notes',
  'status',
  'type',
] as const satisfies ReadonlyArray<keyof ImportMapping>;

function cell(row: Record<string, unknown>, column: string | undefined): string | null {
  if (!column) return null;
  const value = row[column];
  if (value == null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function vocab<T extends string>(
  raw: string | null,
  fallback: T,
  isValid: (v: string) => v is T,
): T {
  if (!raw) return fallback;
  const key = raw.trim().toLowerCase().replace(/[\s-]+/g, '_');
  return isValid(key) ? key : fallback;
}

/**
 * One spreadsheet row → one contact, or a reason it cannot be one. Names fall
 * back through company, email and phone so a row is never nameless; a row
 * with neither a usable phone nor an email is skipped, because a contact
 * nobody can reach is not a contact.
 */
export function mapImportRow(
  row: Record<string, unknown>,
  mapping: ImportMapping,
  defaults: ImportDefaults = {},
): ImportRowResult {
  const values = Object.values(row ?? {});
  if (values.every((v) => v == null || String(v).trim() === '')) {
    return { ok: false, reason: 'empty_row' };
  }

  const phoneInputs: PhoneInput[] = [];
  for (const column of [mapping.phone, mapping.phone2]) {
    const raw = cell(row, column);
    if (raw) phoneInputs.push({ phone: raw });
  }
  // Invalid numbers are dropped, not fatal: a spreadsheet with "N/A" in a
  // phone column still imports the rows that have a real number.
  const phones = normalizePhoneList(phoneInputs.filter((p) => normalizeContactPhone(p.phone)));
  const phoneList = phones.ok ? phones.phones : [];
  const email = normalizeEmail(cell(row, mapping.email));
  if (phoneList.length === 0 && !email) return { ok: false, reason: 'no_phone_or_email' };

  const company = cell(row, mapping.company);
  const first = cell(row, mapping.first_name);
  const last = cell(row, mapping.last_name);
  const joined = [first, last].filter(Boolean).join(' ').trim();
  const name =
    cell(row, mapping.display_name) ??
    (joined.length > 0 ? joined : null) ??
    company ??
    email ??
    phoneList[0]?.phoneE164 ??
    'Unknown';

  const line1 = cell(row, mapping.address_line1);
  const city = cell(row, mapping.city);
  const state = cell(row, mapping.state);
  const postal = cell(row, mapping.postal_code);
  const address: ImportAddress | null =
    line1 || city || state || postal
      ? { line1, city, state: state ? state.toUpperCase().slice(0, 40) : null, postal_code: postal }
      : null;

  const type = vocab<ContactType>(cell(row, mapping.type), vocab<ContactType>(defaults.type ?? null, CONTACT_TYPES[0], isContactType), isContactType);
  const status = vocab<ContactStatus>(
    cell(row, mapping.status),
    vocab<ContactStatus>(defaults.status ?? null, CONTACT_STATUSES[0], isContactStatus),
    isContactStatus,
  );

  return {
    ok: true,
    contact: {
      displayName: name.slice(0, 160),
      type,
      status,
      phones: phoneList,
      email,
      company,
      address,
      tags: normalizeTags([...(defaults.tags ?? []), ...splitTags(cell(row, mapping.tags))]),
      notes: cell(row, mapping.notes),
      source: defaults.source?.trim() ? defaults.source.trim() : 'import',
    },
  };
}

// ---------------------------------------------------------------------------
// Merge fields for bulk messages
// ---------------------------------------------------------------------------

export interface MergeFieldValues {
  first_name?: string | null;
  name?: string | null;
  address?: string | null;
  city?: string | null;
  rep_name?: string | null;
}

/**
 * Replace `{first_name}`, `{name}`, `{address}`, `{city}`, `{rep_name}`.
 * Unknown fields are left as typed (they may be literal braces) and a field
 * with no value becomes empty, with the surrounding double space collapsed.
 */
export function renderMergeFields(body: string, values: MergeFieldValues): string {
  const known: Record<string, string | null | undefined> = {
    first_name: values.first_name,
    name: values.name,
    address: values.address,
    city: values.city,
    rep_name: values.rep_name,
  };
  return body
    .replace(/\{\s*([a-z_]+)\s*\}/gi, (match, key: string) => {
      const k = key.toLowerCase();
      if (!(k in known)) return match;
      return known[k] ?? '';
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/ +([,.!?])/g, '$1')
    .trim();
}

/** First word of a display name; "Your Company LLC" → "Your Company LLC" if it looks like a company. */
export function firstNameOf(displayName: string | null | undefined): string | null {
  if (!displayName) return null;
  const trimmed = displayName.trim();
  if (!trimmed) return null;
  if (/\b(llc|inc|corp|co|ltd|trust|company)\b\.?$/i.test(trimmed)) return trimmed;
  return trimmed.split(/\s+/)[0] ?? null;
}

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

export const CSV_BOM = '﻿';

/**
 * One cell, RFC 4180 quoted, with spreadsheet formula injection neutralized:
 * a value starting with = + - @ or a control character is prefixed with an
 * apostrophe so Excel/Sheets show it as text instead of evaluating it.
 */
export function csvCell(value: unknown): string {
  if (value == null) return '';
  let text = value instanceof Date ? value.toISOString() : Array.isArray(value) ? value.join(', ') : String(value);
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  if (/[",\r\n]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}

export function toCsv(header: string[], rows: unknown[][]): string {
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return CSV_BOM + lines.join('\r\n') + '\r\n';
}
