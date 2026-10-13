/**
 * In-call scripts (docs/scripts.md): the kind vocabulary, the merge fields a
 * script body may carry, the lenient renderer the call-context endpoint uses
 * (a rep reading mid-call must never see a raw `{brace}`), and the selection
 * rule that picks the primary script for a call. Zero I/O — the server loads
 * rows and hands them here.
 */

export const SCRIPT_KINDS = ['script', 'rebuttal'] as const;
export type ScriptKind = (typeof SCRIPT_KINDS)[number];

export function isScriptKind(value: string): value is ScriptKind {
  return (SCRIPT_KINDS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Merge fields
// ---------------------------------------------------------------------------

/**
 * Everything an SMS body may carry (sequences.ts MERGE_FIELDS) plus the
 * property zip, the rep's first name and the seller's number. Scripts are
 * read aloud, so the renderer below is forgiving where the SMS one is strict.
 */
export const SCRIPT_MERGE_FIELDS = [
  'first_name',
  'name',
  'address',
  'city',
  'state',
  'postal_code',
  'company',
  'rep_name',
  'rep_first_name',
  'phone',
] as const;
export type ScriptMergeField = (typeof SCRIPT_MERGE_FIELDS)[number];
export type ScriptMergeVars = Record<ScriptMergeField, string>;

/** Single braces, double braces, optional inner whitespace: `{name}`, `{{ name }}`. */
const SCRIPT_MERGE_RE = /\{\{?\s*([a-zA-Z0-9_]+)\s*\}?\}/g;

export function emptyScriptMergeVars(): ScriptMergeVars {
  return {
    first_name: '',
    name: '',
    address: '',
    city: '',
    state: '',
    postal_code: '',
    company: '',
    rep_name: '',
    rep_first_name: '',
    phone: '',
  };
}

/** Every distinct field name a body references, in order of appearance. */
export function findScriptMergeFields(body: string): string[] {
  const seen: string[] = [];
  for (const m of body.matchAll(SCRIPT_MERGE_RE)) {
    const name = m[1]!.toLowerCase();
    if (!seen.includes(name)) seen.push(name);
  }
  return seen;
}

export function unknownScriptMergeFields(body: string): string[] {
  return findScriptMergeFields(body).filter((f) => !(SCRIPT_MERGE_FIELDS as readonly string[]).includes(f));
}

/**
 * Substitute merge fields into a script body. A field with no value — and a
 * field nobody knows — renders as an empty string, never as braces; the
 * double space that leaves behind is collapsed (but never at the start of a
 * line, where markdown indentation lives).
 */
export function renderScriptMergeFields(
  body: string,
  vars: Partial<Record<string, string | null | undefined>>,
): string {
  return body
    .replace(SCRIPT_MERGE_RE, (_match, name: string) => vars[name.toLowerCase()] ?? '')
    .replace(/(?<=\S)[ \t]{2,}/g, ' ')
    .replace(/(?<=\S) +([,.!?;:])/g, '$1');
}

/** First word of a display name; a company-looking name stays whole. */
export function firstWordOf(name: string | null | undefined): string {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return '';
  if (/\b(llc|inc|corp|co|ltd|trust|company)\b\.?$/i.test(trimmed)) return trimmed;
  return trimmed.split(/\s+/)[0] ?? '';
}

/** `+16145550134` → `(614) 555-0134` for reading aloud; anything else verbatim. */
export function formatPhoneForSpeech(e164: string | null | undefined): string {
  if (!e164) return '';
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}

// ---------------------------------------------------------------------------
// Selection (docs/scripts.md §4)
// ---------------------------------------------------------------------------

export interface SelectableScript {
  id: string;
  kind: string;
  title: string;
  enabled: boolean;
  campaign_id: string | null;
  contact_types: string[];
  sort_order: number;
}

export interface ScriptSelectionContext {
  /** The campaign the call is being placed for, when known. */
  campaignId: string | null;
  /** The contact's type (seller, buyer, …), when there is a contact. */
  contactType: string | null;
}

export interface ScriptSelection<T> {
  primary: T | null;
  /** The rest of the primary's tier, then every lower tier, in order. */
  alternatives: T[];
  rebuttals: T[];
}

/**
 * Which tier a script lands in for this call, or null when it does not apply:
 * a disabled script, a script pinned to another campaign, or a script typed
 * for contacts this one is not. 0 = pinned to this campaign, 1 = everything
 * else applicable.
 *
 * Contact types only *filter* — they never promote. A script written for
 * sellers (the novation pitch, say) is not what a rep opens a seller call
 * with; the playbook's own order decides that, and the pitch waits in the
 * alternatives until it is wanted. A campaign is the one thing that does
 * jump the queue, because pinning a script to a campaign is an explicit
 * instruction for those calls.
 */
export function scriptTier(script: SelectableScript, ctx: ScriptSelectionContext): 0 | 1 | null {
  if (!script.enabled) return null;
  if (script.campaign_id != null && script.campaign_id !== ctx.campaignId) return null;
  const typed = script.contact_types.length > 0;
  if (typed && (ctx.contactType == null || !script.contact_types.includes(ctx.contactType))) return null;
  return script.campaign_id != null ? 0 : 1;
}

/** Lowest sort_order first; title, then id, break ties so the order is stable. */
export function compareScripts(a: SelectableScript, b: SelectableScript): number {
  return a.sort_order - b.sort_order || a.title.localeCompare(b.title) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Pick the primary script (best tier, lowest sort_order) and line the rest up
 * as alternatives; rebuttals are every applicable one, sorted the same way.
 */
export function selectScripts<T extends SelectableScript>(scripts: T[], ctx: ScriptSelectionContext): ScriptSelection<T> {
  const ranked: Array<{ script: T; tier: 0 | 1 }> = [];
  for (const script of scripts) {
    const tier = scriptTier(script, ctx);
    if (tier != null) ranked.push({ script, tier });
  }
  ranked.sort((a, b) => a.tier - b.tier || compareScripts(a.script, b.script));
  const talk = ranked.filter((r) => r.script.kind === 'script').map((r) => r.script);
  const rebuttals = ranked.filter((r) => r.script.kind === 'rebuttal').map((r) => r.script);
  return { primary: talk[0] ?? null, alternatives: talk.slice(1), rebuttals };
}
