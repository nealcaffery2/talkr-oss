/**
 * The example playbook preset (docs/scripts.md §6) and the scripts input
 * helpers: every preset entry must be a valid POST body, cover the call in
 * order, and use only merge fields the renderer knows. Pure — no database.
 */

import { describe, expect, it } from 'vitest';
import { SCRIPT_MERGE_FIELDS, renderScriptMergeFields, unknownScriptMergeFields } from '@talkr/core';
import {
  importScripts,
  normalizeScriptTags,
  presetScripts,
  scriptInputSchema,
  scriptInsertValues,
  scriptPatchSchema,
  scriptPatchValues,
} from '../src/services/scripts.js';
import examplePreset from '../src/playbook/example-scripts.json' with { type: 'json' };

describe('example preset', () => {
  const entries = examplePreset as unknown[];

  it('every entry validates against the script input schema', () => {
    for (const [i, entry] of entries.entries()) {
      const parsed = scriptInputSchema.safeParse(entry);
      if (!parsed.success) {
        throw new Error(`preset entry ${i} invalid: ${JSON.stringify(parsed.error.issues)}`);
      }
    }
    expect(presetScripts('example')).toHaveLength(entries.length);
  });

  it('has the sections the call needs, in call order, and enough rebuttals', () => {
    const scripts = presetScripts('example').filter((s) => s.kind === 'script');
    const rebuttals = presetScripts('example').filter((s) => s.kind === 'rebuttal');
    expect(scripts.length).toBeGreaterThanOrEqual(8);
    expect(rebuttals.length).toBeGreaterThanOrEqual(3);

    const categories = scripts.map((s) => s.category);
    for (const c of ['opener', 'rapport', 'qualifying', 'motivation', 'condition', 'timeline', 'price', 'close', 'voicemail']) {
      expect(categories, `missing category ${c}`).toContain(c);
    }
    // Call order: the opener is the primary for an unknown caller.
    const bySort = [...scripts].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
    expect(bySort[0]?.category).toBe('opener');
    expect(bySort.findIndex((s) => s.category === 'close')).toBeGreaterThan(bySort.findIndex((s) => s.category === 'price'));
    // Every rebuttal is an objection with 2-4 trigger tags.
    for (const r of rebuttals) {
      expect(r.category).toBe('objection');
      expect(r.tags?.length ?? 0).toBeGreaterThanOrEqual(2);
      expect(r.tags?.length ?? 0).toBeLessThanOrEqual(4);
    }
    // Nothing is disabled or campaign-pinned out of the box.
    for (const s of presetScripts('example')) {
      expect(s.enabled ?? true).toBe(true);
      expect(s.campaign_id ?? null).toBeNull();
    }
  });

  it('kind + title is unique (the import match key)', () => {
    const keys = presetScripts('example').map((s) => `${s.kind}|${s.title.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('bodies use only known merge fields and render without a brace left behind', () => {
    const vars = Object.fromEntries(SCRIPT_MERGE_FIELDS.map((f) => [f, `<${f}>`]));
    for (const s of presetScripts('example')) {
      expect(unknownScriptMergeFields(s.body), `${s.title} uses an unknown field`).toEqual([]);
      const rendered = renderScriptMergeFields(s.body, vars);
      expect(rendered, `${s.title} left a brace`).not.toMatch(/\{[a-zA-Z0-9_ ]+\}/);
    }
    const opener = presetScripts('example').find((s) => s.category === 'opener')!;
    const rendered = renderScriptMergeFields(opener.body, { first_name: 'Jane', rep_first_name: 'Sam', company: 'Acme', address: '123 Example St' });
    expect(rendered).toContain('Hi Jane, this is Sam with Acme. I’m calling about 123 Example St.');
  });
});

describe('script input helpers', () => {
  it('rejects a contact type outside the vocabulary, an unknown kind, and a blank body', () => {
    expect(scriptInputSchema.safeParse({ kind: 'script', title: 'x', body: 'y', contact_types: ['alien'] }).success).toBe(false);
    expect(scriptInputSchema.safeParse({ kind: 'note', title: 'x', body: 'y' }).success).toBe(false);
    expect(scriptInputSchema.safeParse({ kind: 'script', title: 'x', body: '   ' }).success).toBe(false);
    expect(scriptInputSchema.safeParse({ kind: 'rebuttal', title: 'x', body: 'y' }).success).toBe(true);
  });

  it('normalizes tags (trim, dedupe case-insensitively, keep order) and fills insert defaults', () => {
    expect(normalizeScriptTags([' Not Interested ', 'not interested', '', 'spouse'])).toEqual(['Not Interested', 'spouse']);
    const values = scriptInsertValues({ kind: 'script', title: 'Opener', body: 'Hi', contact_types: ['seller', 'seller'] });
    expect(values).toEqual({
      kind: 'script',
      title: 'Opener',
      category: null,
      tags: [],
      contactTypes: ['seller'],
      campaignId: null,
      body: 'Hi',
      sortOrder: 0,
      enabled: true,
    });
  });

  it('a patch only touches the keys it carries and reports them', () => {
    const parsed = scriptPatchSchema.parse({ enabled: false, tags: ['a', 'A'], campaign_id: null });
    expect(scriptPatchValues(parsed)).toEqual({
      values: { enabled: false, tags: ['a'], campaignId: null },
      changed: ['tags', 'campaign_id', 'enabled'],
    });
    expect(scriptPatchValues(scriptPatchSchema.parse({}))).toEqual({ values: {}, changed: [] });
  });
});

describe('importScripts (in-memory tx)', () => {
  /** Just enough of the drizzle surface for the import: one select, updates, one insert. */
  function fakeTx(existing: Array<{ id: string; kind: string; title: string }>) {
    const updates: Array<{ id: string; set: Record<string, unknown> }> = [];
    const inserted: unknown[][] = [];
    let pendingUpdate: Record<string, unknown> | null = null;
    const tx = {
      select: () => ({ from: () => ({ where: async () => existing }) }),
      update: () => ({
        set: (set: Record<string, unknown>) => {
          pendingUpdate = set;
          return {
            where: async (cond: { queryChunks?: unknown[] }) => {
              // The id is the only param in `eq(scripts.id, id)`.
              const id = String((cond.queryChunks ?? []).find((c) => typeof c === 'object' && c && 'value' in c && typeof (c as { value: unknown }).value === 'string' && /^[0-9a-f-]{36}$/i.test((c as { value: string }).value)) ? ((cond.queryChunks ?? []).find((c) => typeof c === 'object' && c && 'value' in c && /^[0-9a-f-]{36}$/i.test(String((c as { value: unknown }).value))) as { value: string }).value : '?');
              updates.push({ id, set: pendingUpdate! });
            },
          };
        },
      }),
      insert: () => ({ values: async (rows: unknown[]) => void inserted.push(rows) }),
    };
    return { tx: tx as never, updates, inserted };
  }
  const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const inputs = [
    { kind: 'script' as const, title: 'Opener', body: 'v2' },
    { kind: 'script' as const, title: 'opener', body: 'dup in batch' },
    { kind: 'rebuttal' as const, title: 'Not interested', body: 'r' },
  ];

  it('skip mode leaves matches alone and counts them', async () => {
    const f = fakeTx([{ id: A, kind: 'script', title: 'OPENER' }]);
    const r = await importScripts(f.tx, 'org', 'user', inputs, 'skip');
    expect(r).toEqual({ created: 1, updated: 0, skipped: 2 });
    expect(f.updates).toHaveLength(0);
    expect(f.inserted).toHaveLength(1);
    expect((f.inserted[0] as Array<{ title: string; orgId: string; createdBy: string }>)[0]).toMatchObject({
      title: 'Not interested',
      orgId: 'org',
      createdBy: 'user',
    });
  });

  it('replace mode overwrites the match in place', async () => {
    const f = fakeTx([{ id: A, kind: 'script', title: 'OPENER' }]);
    const r = await importScripts(f.tx, 'org', null, inputs, 'replace');
    expect(r).toEqual({ created: 1, updated: 1, skipped: 1 });
    expect(f.updates).toHaveLength(1);
    expect(f.updates[0]?.id).toBe(A);
    expect(f.updates[0]?.set).toMatchObject({ body: 'v2', title: 'Opener' });
  });
});
