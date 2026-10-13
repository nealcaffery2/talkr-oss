/**
 * The merge-field catalogue and the two pure string helpers the inline `/`
 * picker is built on (components/MergeField.tsx re-exports all of it, so a
 * caller only ever imports the component module).
 *
 * Kept DOM-free on purpose: the caret maths is the part worth unit-testing,
 * and apps/web/test runs it under the repo's root vitest.
 *
 * The `{field}` grammar is packages/core's — single or double braces, optional
 * inner whitespace — but the picker only ever *writes* `{field}`.
 */

export interface MergeFieldSpec {
  /** The token name, without braces. */
  field: string;
  /** Human label shown in the dropdown and the guide. */
  label: string;
  /** One line on where the value comes from. */
  hint: string;
  /** Stand-in shown when the caller has no real value for this recipient. */
  example: string;
  /** Extra words the picker matches on, so `/seller` finds `first_name`. */
  aliases: string[];
}

/**
 * Every field the platform renders today. Sequences accept a narrower set
 * (lib/sequences.ts MERGE_FIELDS) and scripts a wider one
 * (lib/callContext.ts SCRIPT_MERGE_FIELDS) — pass `fields` to narrow the
 * picker to whatever the surface's server will actually accept.
 */
export const MERGE_FIELD_GUIDE: readonly MergeFieldSpec[] = [
  {
    field: 'first_name',
    label: 'Seller first name',
    hint: 'Their first name, from the contact.',
    example: 'Marisol',
    aliases: ['seller', 'seller_name', 'sellerfirst', 'seller_first_name', 'fname', 'firstname', 'first', 'given', 'owner'],
  },
  {
    field: 'name',
    label: 'Seller full name',
    hint: "The contact's full display name.",
    example: 'Marisol Vega',
    aliases: ['fullname', 'full_name', 'contact', 'contact_name', 'display_name', 'owner_name', 'them'],
  },
  {
    field: 'contact_name',
    label: 'Seller full name (legacy)',
    hint: 'The same value as {name}. Messages only — older templates were written with it.',
    example: 'Marisol Vega',
    aliases: ['legacy_name', 'old_name'],
  },
  {
    field: 'address',
    label: 'Property address',
    hint: 'Street line of the property on the lead.',
    example: '1207 Elm St',
    aliases: ['street', 'addr', 'property', 'property_address', 'house', 'line1', 'situs'],
  },
  {
    field: 'city',
    label: 'Property city',
    hint: 'City of the property on the lead.',
    example: 'San Antonio',
    aliases: ['town', 'municipality', 'locality'],
  },
  {
    field: 'state',
    label: 'Property state',
    hint: 'Two-letter state of the property.',
    example: 'TX',
    aliases: ['province', 'region', 'st'],
  },
  {
    field: 'postal_code',
    label: 'Property ZIP',
    hint: 'ZIP of the property. Scripts only — SMS steps reject it.',
    example: '78201',
    aliases: ['zip', 'zipcode', 'zip_code', 'postcode', 'postal'],
  },
  {
    field: 'company',
    label: 'Your company',
    hint: 'The company name a rep introduces themselves with.',
    example: 'Your Company',
    aliases: ['brand', 'business', 'dba', 'companyname', 'us'],
  },
  {
    field: 'rep_name',
    label: 'Your full name',
    hint: "The signed-in rep's display name.",
    example: 'Riley Ruiz',
    aliases: ['rep', 'me', 'my_name', 'myname', 'your_name', 'agent', 'caller', 'sender', 'signature'],
  },
  {
    field: 'rep_first_name',
    label: 'Your first name',
    hint: "The signed-in rep's first name. Scripts only — SMS steps reject it.",
    example: 'Riley',
    aliases: ['repfirst', 'rep_first', 'my_first_name', 'myfirstname', 'agentfirst', 'yourfirstname'],
  },
  {
    field: 'org_name',
    label: 'Workspace name',
    hint: 'Your Talkr workspace name. Message templates only.',
    example: 'Your Company Acquisitions',
    aliases: ['org', 'organization', 'organisation', 'team', 'account', 'workspace', 'tenant'],
  },
  {
    field: 'phone',
    label: 'Seller phone',
    hint: 'The number being dialled, formatted for speech.',
    example: '(210) 555-0134',
    aliases: ['number', 'mobile', 'cell', 'tel', 'telephone', 'phonenumber', 'sellerphone'],
  },
] as const;

/** Lookup by token name — the guide is small enough that a scan is fine. */
export function mergeFieldSpec(field: string): MergeFieldSpec | null {
  return MERGE_FIELD_GUIDE.find((s) => s.field === field.toLowerCase()) ?? null;
}

/** The guide, narrowed to a surface's allowed tokens (order preserved). */
export function mergeFieldsFor(allowed?: readonly string[]): MergeFieldSpec[] {
  if (!allowed) return [...MERGE_FIELD_GUIDE];
  const want = new Set(allowed.map((f) => f.toLowerCase()));
  return MERGE_FIELD_GUIDE.filter((s) => want.has(s.field));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** `Seller first name` / `seller_name` / `Seller-Name` all collapse to the same key. */
function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/**
 * How well one field answers `q` (already normalized). Higher wins; 0 means
 * "not a match", which is what closes the dropdown on a stray slash.
 */
function score(spec: MergeFieldSpec, q: string): number {
  const field = normalize(spec.field);
  if (field === q) return 100;
  if (field.startsWith(q)) return 80;

  const aliases = spec.aliases.map(normalize);
  if (aliases.includes(q)) return 70;
  if (aliases.some((a) => a.startsWith(q))) return 60;

  const label = normalize(spec.label);
  if (label.startsWith(q)) return 50;
  if (spec.label.toLowerCase().split(/\s+/).some((w) => normalize(w).startsWith(q))) return 40;

  if (field.includes(q)) return 20;
  if (aliases.some((a) => a.includes(q)) || label.includes(q)) return 10;
  return 0;
}

/**
 * Fields matching a typed `/query`, best first. An empty query lists
 * everything (the moment `/` is typed, before any letters).
 */
export function matchMergeFields(query: string, allowed?: readonly string[]): MergeFieldSpec[] {
  const pool = mergeFieldsFor(allowed);
  const q = normalize(query);
  if (!q) return pool;
  return pool
    .map((spec, index) => ({ spec, index, points: score(spec, q) }))
    .filter((row) => row.points > 0)
    .sort((a, b) => b.points - a.points || a.index - b.index)
    .map((row) => row.spec);
}

// ---------------------------------------------------------------------------
// Caret maths — pure, no DOM
// ---------------------------------------------------------------------------

export interface SlashQuery {
  /** Index of the `/` that opened the query. */
  start: number;
  /** What has been typed after it; '' right after the slash. */
  query: string;
}

/** Characters a merge-field query may contain — anything else ends it. */
const QUERY_CHAR = /[A-Za-z0-9_]/;
/** Past this the user is writing prose, not picking a field. */
const MAX_QUERY = 24;

/**
 * The `/query` the caret currently sits in, or null.
 *
 * The slash only counts at a word boundary — start of input, or straight
 * after whitespace — so `https://x/y`, `and/or` and `24/7` never open the
 * picker. Whitespace after the slash ends the query, so ordinary prose with a
 * slash in it is left alone.
 */
export function slashQueryAt(value: string, caret: number): SlashQuery | null {
  if (caret < 1 || caret > value.length) return null;
  let i = caret - 1;
  let seen = 0;
  while (i >= 0 && value[i] !== '/') {
    if (!QUERY_CHAR.test(value[i]!)) return null;
    if (++seen > MAX_QUERY) return null;
    i--;
  }
  if (i < 0) return null;
  const before = i === 0 ? '' : value[i - 1]!;
  if (before !== '' && !/\s/.test(before)) return null;
  return { start: i, query: value.slice(i + 1, caret) };
}

/**
 * Replace the `/query` ending at `caret` with `{field}`, and say where the
 * caret lands (straight after the token). When the text at `caret` is not the
 * query we were told about — a stale event, a caret that moved — the token is
 * inserted at the caret instead of eating characters it should not.
 */
export function insertMergeField(
  value: string,
  caret: number,
  field: string,
  query: string,
): { value: string; caret: number } {
  const at = Math.max(0, Math.min(caret, value.length));
  const token = `{${field}}`;
  const start = at - query.length - 1;
  const replacing = start >= 0 && value[start] === '/' && value.slice(start + 1, at) === query;
  const from = replacing ? start : at;
  return { value: value.slice(0, from) + token + value.slice(at), caret: from + token.length };
}

// ---------------------------------------------------------------------------
// Preview
// ---------------------------------------------------------------------------

/** packages/core's grammar: `{name}`, `{{name}}`, inner whitespace allowed. */
export const MERGE_TOKEN_RE = /\{\{?\s*([a-zA-Z0-9_]+)\s*\}?\}/g;

export type MergeSegment =
  | { kind: 'text'; text: string }
  | { kind: 'value'; text: string; field: string }
  | { kind: 'empty'; text: string; field: string; known: boolean };

/**
 * Split a body into what a recipient would read. A token with a value becomes
 * that value; a token with none stays visible — as itself — so the rep can
 * see the hole rather than a sentence with a gap in it.
 */
export function mergeSegments(body: string, values: Record<string, string> = {}, allowed?: readonly string[]): MergeSegment[] {
  const known = new Set(mergeFieldsFor(allowed).map((s) => s.field));
  const out: MergeSegment[] = [];
  let last = 0;
  for (const m of body.matchAll(MERGE_TOKEN_RE)) {
    const at = m.index;
    if (at > last) out.push({ kind: 'text', text: body.slice(last, at) });
    const field = m[1]!.toLowerCase();
    const value = values[field]?.trim();
    if (value) out.push({ kind: 'value', text: value, field });
    else out.push({ kind: 'empty', text: `{${field}}`, field, known: known.has(field) });
    last = at + m[0].length;
  }
  if (last < body.length) out.push({ kind: 'text', text: body.slice(last) });
  return out;
}

/** Field names a body uses that this surface does not know, in order. */
export function unknownFieldsIn(body: string, allowed?: readonly string[]): string[] {
  const known = new Set(mergeFieldsFor(allowed).map((s) => s.field));
  const out: string[] = [];
  for (const m of body.matchAll(MERGE_TOKEN_RE)) {
    const field = m[1]!.toLowerCase();
    if (!known.has(field) && !out.includes(field)) out.push(field);
  }
  return out;
}
