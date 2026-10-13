/**
 * Scripts API + in-call context (docs/scripts.md): CRUD over the org's talk
 * tracks and rebuttals (`scripts.read` for everyone, `scripts.write` for
 * manager and up), the playbook preset import, the "a rep used this" ping
 * that feeds coaching, and `GET /v1/call-context` — the one read the dialer
 * makes when a number is typed, a call rings, or a call connects. Auth is the
 * /v1 preHandler hook registered in registerV1Routes; register this module
 * after it in app.ts.
 */

import { and, asc, eq, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SCRIPT_KINDS, type Permission } from '@talkr/core';
import { schema } from '@talkr/db';
import type { AppDeps } from '../app.js';
import { hasPermission, type AuthContext } from '../auth.js';
import { writeAudit, type AuditInput } from '../services/audit.js';
import { buildCallContext, type CallContextSelector } from '../services/call-context.js';
import { likeContains } from '../services/contacts.js';
import {
  IMPORT_MODES,
  SCRIPT_PRESETS,
  importScripts,
  presetScripts,
  scriptInputSchema,
  scriptInsertValues,
  scriptPatchSchema,
  scriptPatchValues,
  toScriptDto,
  type ScriptInput,
} from '../services/scripts.js';

function requirePermission(permission: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = req.authCtx;
    if (!ctx) return reply.code(401).send({ error: 'unauthenticated' });
    if (!hasPermission(ctx, permission)) {
      req.log.info({ userId: ctx.userId, permission }, 'permission denied');
      return reply.code(403).send({ error: 'forbidden', permission });
    }
  };
}

/** Any one of the permissions opens the door (call-context: leads.read or contacts.read). */
function requireAnyPermission(...permissions: Permission[]) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = req.authCtx;
    if (!ctx) return reply.code(401).send({ error: 'unauthenticated' });
    if (!permissions.some((p) => hasPermission(ctx, p))) {
      req.log.info({ userId: ctx.userId, permissions }, 'permission denied');
      return reply.code(403).send({ error: 'forbidden', permission: permissions[0] });
    }
  };
}

const s = schema.scripts;
const UUID = z.string().uuid();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  kind: z.enum(SCRIPT_KINDS).optional(),
  q: z.string().trim().max(200).optional(),
  include_disabled: z.enum(['true', 'false']).optional(),
});

const reorderSchema = z.object({
  ids: z.array(UUID).min(1).max(500),
});

const importSchema = z
  .object({
    preset: z.enum(SCRIPT_PRESETS).optional(),
    scripts: z.array(scriptInputSchema).min(1).max(500).optional(),
    mode: z.enum(IMPORT_MODES).default('skip'),
  })
  .refine((b) => (b.preset ? 1 : 0) + (b.scripts ? 1 : 0) === 1, {
    message: 'exactly one of preset or scripts is required',
  });

const usedSchema = z.object({
  call_id: UUID.optional(),
  contact_id: UUID.optional(),
});

const callContextQuerySchema = z.object({
  phone: z.string().trim().min(3).max(40).optional(),
  contact_id: UUID.optional(),
  lead_id: UUID.optional(),
  call_id: UUID.optional(),
  /** Optional hint: the campaign the dial session is working (wins over inference). */
  campaign_id: UUID.optional(),
});

/** Query params arrive as strings; an empty one (`?kind=`) means "not set". */
function cleanQuery(query: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries((query ?? {}) as Record<string, unknown>).filter(([, v]) => v !== '' && v != null),
  );
}

function ilikeEscaped(column: SQL | (typeof s)[keyof typeof s], pattern: string): SQL {
  return sql`${column} ILIKE ${pattern} ESCAPE '\\'`;
}

export function registerScriptRoutes(app: FastifyInstance, deps: AppDeps): void {
  const db = deps.dbh.db;
  const read = { preHandler: requirePermission('scripts.read') };
  const write = { preHandler: requirePermission('scripts.write') };
  const context = { preHandler: requireAnyPermission('leads.read', 'contacts.read') };

  const audit = (
    ctx: AuthContext,
    action: string,
    objectId: string | undefined,
    metadata: Record<string, unknown> = {},
  ): AuditInput => ({
    orgId: ctx.orgId,
    actorType: 'user',
    actorId: ctx.userId,
    action,
    objectType: 'script',
    ...(objectId ? { objectId } : {}),
    metadata,
  });

  async function loadScript(orgId: string, id: string) {
    return (await db.select().from(s).where(and(eq(s.id, id), eq(s.orgId, orgId))).limit(1))[0];
  }

  /** A campaign a script is pinned to must be one of the org's own. */
  async function campaignsInOrg(orgId: string, ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set();
    const rows = await db
      .select({ id: schema.campaigns.id })
      .from(schema.campaigns)
      .where(and(eq(schema.campaigns.orgId, orgId), sql`${schema.campaigns.id} = ANY(${sql.param(ids)}::uuid[])`));
    return new Set(rows.map((r) => r.id));
  }

  async function rejectForeignCampaigns(reply: FastifyReply, orgId: string, inputs: Array<{ campaign_id?: string | null }>) {
    const ids = [...new Set(inputs.map((i) => i.campaign_id).filter((v): v is string => Boolean(v)))];
    if (ids.length === 0) return false;
    const found = await campaignsInOrg(orgId, ids);
    const missing = ids.find((id) => !found.has(id));
    if (!missing) return false;
    await reply.code(400).send({ error: 'invalid_campaign', campaign_id: missing, message: 'not a campaign in this workspace' });
    return true;
  }

  // -------------------------------------------------------------------------
  // List
  // -------------------------------------------------------------------------
  app.get('/v1/scripts', read, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = listQuerySchema.safeParse(cleanQuery(req.query));
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    const q = parsed.data;
    const where: SQL[] = [eq(s.orgId, ctx.orgId)];
    if (q.kind) where.push(eq(s.kind, q.kind));
    if (q.include_disabled !== 'true') where.push(eq(s.enabled, true));
    if (q.q) {
      const pattern = likeContains(q.q);
      where.push(
        or(
          ilikeEscaped(s.title, pattern),
          ilikeEscaped(s.body, pattern),
          ilikeEscaped(s.category, pattern),
          ilikeEscaped(sql`array_to_string(${s.tags}, ' ')`, pattern),
        )!,
      );
    }
    const rows = await db
      .select()
      .from(s)
      .where(and(...where))
      .orderBy(asc(s.kind), asc(s.sortOrder), asc(s.title));
    return { scripts: rows.map(toScriptDto) };
  });

  // -------------------------------------------------------------------------
  // One script — how a client opens an alternative mid-call
  //
  // `GET /v1/call-context` returns the alternatives as {id,title,category}
  // only, so the body is fetched on demand when the rep picks one. Disabled
  // scripts are returned too: an editor deep-linking to one must see it.
  // -------------------------------------------------------------------------
  app.get('/v1/scripts/:id', read, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    if (!UUID.safeParse(id).success) return reply.code(404).send({ error: 'not_found' });
    const row = await loadScript(ctx.orgId, id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { script: toScriptDto(row) };
  });

  // -------------------------------------------------------------------------
  // Create
  // -------------------------------------------------------------------------
  app.post('/v1/scripts', write, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = scriptInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const input = parsed.data;
    if (await rejectForeignCampaigns(reply, ctx.orgId, [input])) return;

    const row = (
      await db
        .insert(s)
        .values({ orgId: ctx.orgId, createdBy: ctx.userId, ...scriptInsertValues(input) })
        .returning()
    )[0]!;
    await writeAudit(
      db,
      audit(ctx, 'script.created', row.id, { kind: row.kind, title: row.title, campaign_id: row.campaignId }),
    );
    return reply.code(201).send({ script: toScriptDto(row) });
  });

  // -------------------------------------------------------------------------
  // Reorder — sort_order becomes the position in the list given
  // -------------------------------------------------------------------------
  app.post('/v1/scripts/reorder', write, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = reorderSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const ids = [...new Set(parsed.data.ids)];
    const now = new Date();
    await db.transaction(async (tx) => {
      for (const [position, id] of ids.entries()) {
        await tx
          .update(s)
          .set({ sortOrder: position, updatedAt: now })
          .where(and(eq(s.id, id), eq(s.orgId, ctx.orgId)));
      }
    });
    await writeAudit(db, audit(ctx, 'scripts.reordered', undefined, { count: ids.length }));
    return { ok: true };
  });

  // -------------------------------------------------------------------------
  // Import — a built-in preset or a list, matched on kind + title
  // -------------------------------------------------------------------------
  app.post('/v1/scripts/import', write, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = importSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const body = parsed.data;
    const inputs: ScriptInput[] = body.preset ? presetScripts(body.preset) : body.scripts!;
    if (await rejectForeignCampaigns(reply, ctx.orgId, inputs)) return;

    const result = await db.transaction(async (tx) => {
      const r = await importScripts(tx, ctx.orgId, ctx.userId, inputs, body.mode);
      await writeAudit(
        tx,
        audit(ctx, 'scripts.imported', undefined, {
          preset: body.preset ?? null,
          count: inputs.length,
          mode: body.mode,
          ...r,
        }),
      );
      return r;
    });
    return result;
  });

  // -------------------------------------------------------------------------
  // Edit
  // -------------------------------------------------------------------------
  app.patch('/v1/scripts/:id', write, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    if (!UUID.safeParse(id).success) return reply.code(404).send({ error: 'not_found' });
    const parsed = scriptPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const { values, changed } = scriptPatchValues(parsed.data);
    if (changed.length === 0) return reply.code(400).send({ error: 'empty_update' });
    const current = await loadScript(ctx.orgId, id);
    if (!current) return reply.code(404).send({ error: 'not_found' });
    if (await rejectForeignCampaigns(reply, ctx.orgId, [parsed.data])) return;

    const row = (
      await db
        .update(s)
        .set({ ...values, updatedAt: new Date() })
        .where(and(eq(s.id, current.id), eq(s.orgId, ctx.orgId)))
        .returning()
    )[0]!;
    await writeAudit(db, audit(ctx, 'script.updated', row.id, { changed, kind: row.kind, title: row.title }));
    return { script: toScriptDto(row) };
  });

  // -------------------------------------------------------------------------
  // Delete (hard)
  // -------------------------------------------------------------------------
  app.delete('/v1/scripts/:id', write, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    if (!UUID.safeParse(id).success) return reply.code(404).send({ error: 'not_found' });
    const deleted = (
      await db
        .delete(s)
        .where(and(eq(s.id, id), eq(s.orgId, ctx.orgId)))
        .returning({ id: s.id, kind: s.kind, title: s.title })
    )[0];
    if (!deleted) return reply.code(404).send({ error: 'not_found' });
    await writeAudit(db, audit(ctx, 'script.deleted', deleted.id, { kind: deleted.kind, title: deleted.title }));
    return reply.code(204).send();
  });

  // -------------------------------------------------------------------------
  // "I read this one" — feeds coaching analytics later
  // -------------------------------------------------------------------------
  app.post('/v1/scripts/:id/used', read, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    if (!UUID.safeParse(id).success) return reply.code(404).send({ error: 'not_found' });
    const parsed = usedSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const script = await loadScript(ctx.orgId, id);
    if (!script) return reply.code(404).send({ error: 'not_found' });
    await writeAudit(
      db,
      audit(ctx, 'script.used', script.id, {
        kind: script.kind,
        title: script.title,
        category: script.category,
        call_id: parsed.data.call_id ?? null,
        contact_id: parsed.data.contact_id ?? null,
      }),
    );
    return reply.code(204).send();
  });

  // -------------------------------------------------------------------------
  // In-call context — exactly one of phone / contact_id / lead_id / call_id
  // -------------------------------------------------------------------------
  app.get('/v1/call-context', context, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = callContextQuerySchema.safeParse(cleanQuery(req.query));
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    const q = parsed.data;
    const selectors: CallContextSelector[] = [];
    if (q.phone) selectors.push({ phone: q.phone });
    if (q.contact_id) selectors.push({ contact_id: q.contact_id });
    if (q.lead_id) selectors.push({ lead_id: q.lead_id });
    if (q.call_id) selectors.push({ call_id: q.call_id });
    if (selectors.length !== 1) {
      return reply.code(400).send({
        error: 'selector_required',
        message: 'exactly one of phone, contact_id, lead_id or call_id is required',
      });
    }
    const result = await buildCallContext(db, ctx, selectors[0]!, { campaignId: q.campaign_id ?? null });
    if (!result.ok) return reply.code(result.status).send({ error: result.error, message: result.message });
    return result.context;
  });
}
