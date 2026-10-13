/**
 * Scripts service (docs/scripts.md): the input schema every write path
 * shares, the DTO the API returns, the built-in playbook presets, and the
 * import merge (match on kind + title; skip or replace). Every query is
 * org-scoped by the caller — the org comes from the AuthContext, never the
 * body.
 */

import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { CONTACT_TYPES, SCRIPT_KINDS } from '@talkr/core';
import { schema, type DbLike } from '@talkr/db';
import examplePreset from '../playbook/example-scripts.json' with { type: 'json' };

export const SCRIPT_TITLE_MAX = 160;
export const SCRIPT_BODY_MAX = 20_000;

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

export const scriptInputSchema = z.object({
  kind: z.enum(SCRIPT_KINDS),
  title: z.string().trim().min(1).max(SCRIPT_TITLE_MAX),
  category: z.string().trim().min(1).max(60).nullable().optional(),
  /** For a rebuttal: the objection triggers ("not interested", "price too low"). */
  tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  /** Empty = any contact type. */
  contact_types: z.array(z.enum(CONTACT_TYPES)).max(CONTACT_TYPES.length).optional(),
  campaign_id: z.string().uuid().nullable().optional(),
  /** Light markdown with merge fields; never trimmed (indentation is meaning). */
  body: z.string().max(SCRIPT_BODY_MAX).refine((s) => s.trim().length > 0, { message: 'body is required' }),
  sort_order: z.number().int().min(-1_000_000).max(1_000_000).optional(),
  enabled: z.boolean().optional(),
});
export type ScriptInput = z.infer<typeof scriptInputSchema>;

export const scriptPatchSchema = scriptInputSchema.partial();
export type ScriptPatch = z.infer<typeof scriptPatchSchema>;

/** Trim, drop blanks, dedupe case-insensitively (first spelling wins), keep order. */
export function normalizeScriptTags(tags: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags ?? []) {
    const tag = raw.trim();
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}

export function normalizeContactTypes(types: readonly string[] | undefined): string[] {
  return [...new Set(types ?? [])];
}

/** Column values for an insert — everything the input decides; org/creator are the caller's. */
export function scriptInsertValues(input: ScriptInput) {
  return {
    kind: input.kind,
    title: input.title,
    category: input.category ?? null,
    tags: normalizeScriptTags(input.tags),
    contactTypes: normalizeContactTypes(input.contact_types),
    campaignId: input.campaign_id ?? null,
    body: input.body,
    sortOrder: input.sort_order ?? 0,
    enabled: input.enabled ?? true,
  };
}

/** Column values for an update — only the keys the patch carries; returns the API keys touched. */
export function scriptPatchValues(patch: ScriptPatch): {
  values: Partial<typeof schema.scripts.$inferInsert>;
  changed: string[];
} {
  const values: Partial<typeof schema.scripts.$inferInsert> = {};
  const changed: string[] = [];
  if (patch.kind !== undefined) (values.kind = patch.kind), changed.push('kind');
  if (patch.title !== undefined) (values.title = patch.title), changed.push('title');
  if (patch.category !== undefined) (values.category = patch.category), changed.push('category');
  if (patch.tags !== undefined) (values.tags = normalizeScriptTags(patch.tags)), changed.push('tags');
  if (patch.contact_types !== undefined) {
    values.contactTypes = normalizeContactTypes(patch.contact_types);
    changed.push('contact_types');
  }
  if (patch.campaign_id !== undefined) (values.campaignId = patch.campaign_id), changed.push('campaign_id');
  if (patch.body !== undefined) (values.body = patch.body), changed.push('body');
  if (patch.sort_order !== undefined) (values.sortOrder = patch.sort_order), changed.push('sort_order');
  if (patch.enabled !== undefined) (values.enabled = patch.enabled), changed.push('enabled');
  return { values, changed };
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

export type ScriptRow = typeof schema.scripts.$inferSelect;

export interface ScriptDto {
  id: string;
  kind: string;
  title: string;
  category: string | null;
  tags: string[];
  contact_types: string[];
  campaign_id: string | null;
  body: string;
  sort_order: number;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

export function toScriptDto(row: ScriptRow): ScriptDto {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    category: row.category,
    tags: row.tags ?? [],
    contact_types: row.contactTypes ?? [],
    campaign_id: row.campaignId,
    body: row.body,
    sort_order: row.sortOrder,
    enabled: row.enabled,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
}

// ---------------------------------------------------------------------------
// Presets
// ---------------------------------------------------------------------------

export const SCRIPT_PRESETS = ['example'] as const;
export type ScriptPreset = (typeof SCRIPT_PRESETS)[number];

const PRESET_SOURCES: Record<ScriptPreset, unknown> = {
  // apps/server/src/playbook/example-scripts.json — a short, made-up
  // example playbook. Replace it with your own team's scripts.
  example: examplePreset,
};

/**
 * A preset's entries, validated against the same schema as a POST body. A
 * preset that fails to validate is a bug (the unit test catches it), so this
 * throws rather than returning a partial list.
 */
export function presetScripts(name: ScriptPreset): ScriptInput[] {
  return z.array(scriptInputSchema).parse(PRESET_SOURCES[name]);
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

export const IMPORT_MODES = ['skip', 'replace'] as const;
export type ImportMode = (typeof IMPORT_MODES)[number];

export interface ImportResult {
  created: number;
  updated: number;
  skipped: number;
}

function importKey(kind: string, title: string): string {
  return `${kind}\n${title.trim().toLowerCase()}`;
}

/**
 * Import a list of scripts into an org, matching existing rows on
 * (kind, title) case-insensitively. `skip` leaves a match alone; `replace`
 * overwrites its fields (the id survives). A title repeated inside the batch
 * is skipped after its first occurrence. Runs inside the caller's transaction.
 */
export async function importScripts(
  tx: DbLike,
  orgId: string,
  createdBy: string | null,
  inputs: ScriptInput[],
  mode: ImportMode,
): Promise<ImportResult> {
  const existing = await tx
    .select({ id: schema.scripts.id, kind: schema.scripts.kind, title: schema.scripts.title })
    .from(schema.scripts)
    .where(eq(schema.scripts.orgId, orgId));
  const idByKey = new Map<string, string>();
  for (const row of existing) {
    const key = importKey(row.kind, row.title);
    if (!idByKey.has(key)) idByKey.set(key, row.id);
  }

  const toInsert: Array<typeof schema.scripts.$inferInsert> = [];
  const seen = new Set<string>();
  let updated = 0;
  let skipped = 0;
  for (const input of inputs) {
    const key = importKey(input.kind, input.title);
    if (seen.has(key)) {
      skipped += 1;
      continue;
    }
    seen.add(key);
    const id = idByKey.get(key);
    if (!id) {
      toInsert.push({ orgId, createdBy, ...scriptInsertValues(input) });
      continue;
    }
    if (mode === 'skip') {
      skipped += 1;
      continue;
    }
    await tx
      .update(schema.scripts)
      .set({ ...scriptInsertValues(input), updatedAt: new Date() })
      .where(eq(schema.scripts.id, id));
    updated += 1;
  }
  if (toInsert.length > 0) await tx.insert(schema.scripts).values(toInsert);
  return { created: toInsert.length, updated, skipped };
}
