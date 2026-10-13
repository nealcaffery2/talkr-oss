/**
 * The non-React half of the in-call panel: a short-lived cache in front of
 * GET /v1/call-context (the ringing banner and the dialer ask for the same
 * number within the same second), the merge-field fill for scripts rendered
 * in the browser, and the markdown-lite parser script bodies are written in.
 *
 * Script bodies use four constructs and nothing else: `## ` section
 * headings, `- ` bullets, `**bold**`, and `> ` notes to the rep. No
 * dependency: the dialer must never wait on a markdown library to show a
 * script.
 */

import { api, type CallContextDto, type CallContextParams } from './api';

// ── Cached fetch ─────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 20_000;
const cache = new Map<string, { at: number; promise: Promise<CallContextDto> }>();

/** One stable key per party — the server accepts exactly one identifier, in this priority. */
export function callContextKey(p: CallContextParams | null): string | null {
  if (!p) return null;
  if (p.call_id) return `call:${p.call_id}`;
  if (p.lead_id) return `lead:${p.lead_id}`;
  if (p.contact_id) return `contact:${p.contact_id}`;
  if (p.phone) return `phone:${p.phone}`;
  return null;
}

/**
 * Same party within 20 seconds → the same in-flight or settled promise.
 * `force` bypasses the cache after an edit. A failed fetch is forgotten at
 * once so a retry actually retries.
 */
export function fetchCallContext(params: CallContextParams, force = false): Promise<CallContextDto> {
  const key = callContextKey(params) ?? JSON.stringify(params);
  const hit = cache.get(key);
  if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.promise;
  const promise = api.getCallContext(params);
  cache.set(key, { at: Date.now(), promise });
  promise.catch(() => cache.delete(key));
  return promise;
}

/** After a contact is created or edited, every cached view of it is stale. */
export function invalidateCallContext(): void {
  cache.clear();
}

// ── Merge fields ─────────────────────────────────────────────────────────────

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

/**
 * Fill `{field}` tokens from the server's merge map. A field with no value
 * keeps its token, so a rep sees `{first_name}` and says a name — rather than
 * reading "Hi , this is" off the screen mid-call.
 */
export function renderScriptMerge(body: string, values: Record<string, string>): string {
  return body.replace(/\{([a-z_]+)\}/g, (token, key: string) => {
    const v = values[key];
    return v && v.trim() ? v : token;
  });
}

/** Stand-in values for the editor's live preview; the rep's own name when signed in. */
export function sampleMergeFields(repName: string | null): Record<string, string> {
  const rep = repName?.trim() || 'Alex Reed';
  return {
    first_name: 'Marisol',
    name: 'Marisol Lopez',
    address: '1207 Elm St',
    city: 'San Antonio',
    state: 'TX',
    postal_code: '78201',
    company: 'Your Company',
    rep_name: rep,
    rep_first_name: rep.split(/\s+/)[0] ?? rep,
    phone: '(210) 555-0134',
  };
}

// ── Markdown-lite ────────────────────────────────────────────────────────────

export type ScriptBlock =
  | { type: 'p'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'note'; text: string };

export interface ScriptSection {
  /** Null for text above the first `## ` heading. */
  title: string | null;
  blocks: ScriptBlock[];
}

/**
 * Body → sections → blocks. Every non-empty line is its own paragraph (a
 * talk track is read line by line, so line breaks are meaning, not layout);
 * consecutive bullets and consecutive `> ` lines fold into one block.
 */
export function parseScript(body: string): ScriptSection[] {
  const sections: ScriptSection[] = [];
  let current: ScriptSection = { title: null, blocks: [] };
  const close = () => {
    if (current.title !== null || current.blocks.length > 0) sections.push(current);
  };
  for (const raw of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const heading = /^#{1,3}\s+(.+)$/.exec(line);
    if (heading) {
      close();
      current = { title: heading[1]!.trim(), blocks: [] };
      continue;
    }
    const last = current.blocks[current.blocks.length - 1];
    const bullet = /^[-*•]\s+(.+)$/.exec(line);
    if (bullet) {
      if (last?.type === 'ul') last.items.push(bullet[1]!);
      else current.blocks.push({ type: 'ul', items: [bullet[1]!] });
      continue;
    }
    const note = /^>\s?(.*)$/.exec(line);
    if (note) {
      if (last?.type === 'note') last.text = `${last.text} ${note[1]!}`.trim();
      else current.blocks.push({ type: 'note', text: note[1]!.trim() });
      continue;
    }
    current.blocks.push({ type: 'p', text: line });
  }
  close();
  return sections;
}

/** Split a line on `**bold**` runs and `{merge}` tokens; the renderer styles each kind. */
export type InlineRun = { kind: 'text' | 'bold' | 'token'; text: string };

export function inlineRuns(text: string): InlineRun[] {
  const runs: InlineRun[] = [];
  for (const part of text.split(/(\*\*[^*]+\*\*|\{[a-z_]+\})/g)) {
    if (!part) continue;
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) runs.push({ kind: 'bold', text: part.slice(2, -2) });
    else if (/^\{[a-z_]+\}$/.test(part)) runs.push({ kind: 'token', text: part });
    else runs.push({ kind: 'text', text: part });
  }
  return runs;
}
