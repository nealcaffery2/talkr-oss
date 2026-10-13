/**
 * Contacts API (docs/contacts.md): the CRM surface over `contacts` +
 * `contact_phones`, with the property/lead linkage read through the newest
 * lead. List/search, create with duplicate-phone detection, activity,
 * edits, soft delete, bulk actions, bulk SMS through the normal send path,
 * "make a dial list" (a power-mode campaign), spreadsheet import, CSV export
 * and temperature rescoring. Auth is provided by the /v1 preHandler hook
 * registered in registerV1Routes; register this module after it in app.ts.
 */

import { and, desc, eq, inArray, isNotNull, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  CONTACT_STATUSES,
  CONTACT_TYPES,
  TEMPERATURES,
  isContactStatus,
  isContactType,
  type Permission,
} from '@talkr/core';
import { enqueueJob, schema, type DbLike } from '@talkr/db';
import type { AppDeps } from '../app.js';
import { hasPermission, type AuthContext } from '../auth.js';
import { writeAudit } from '../services/audit.js';
import { CampaignServiceError, attachLeads, createCampaign, updateCampaign } from '../services/campaigns.js';
import {
  IMPORT_MAPPING_KEYS,
  firstNameOf,
  mapImportRow,
  normalizeEmail,
  normalizePhoneList,
  normalizeTags,
  renderMergeFields,
  toCsv,
  type ImportMapping,
  type NormalizedPhone,
} from '../services/contact-import.js';
import { rescoreContact } from '../services/contact-temperature.js';
import {
  ensureLeadForContact,
  findPhoneOwners,
  hasAddress,
  insertContact,
  likeContains,
  loadContactDto,
  loadContactDtos,
  mergeIntoContact,
  searchDigits,
  setContactAddress,
  usersInOrg,
  type ContactAddressInput,
  type ContactDto,
} from '../services/contacts.js';
import { MessageServiceError, sendMessage } from '../services/messages.js';

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

const c = schema.contacts;

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const listQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  type: z.enum(CONTACT_TYPES).optional(),
  status: z.enum(CONTACT_STATUSES).optional(),
  temperature: z.enum(TEMPERATURES).optional(),
  tag: z.string().trim().min(1).max(60).optional(),
  user_id: z.string().uuid().optional(),
  has_phone: z.enum(['true', 'false']).optional(),
  include_deleted: z.enum(['true', 'false']).optional(),
  sort: z.enum(['recent', 'name', 'temperature', 'created']).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});
type ListQuery = z.infer<typeof listQuerySchema>;

/** Query params arrive as strings; an empty one (`?type=`) means "not set". */
function parseListQuery(query: unknown) {
  const cleaned = Object.fromEntries(
    Object.entries((query ?? {}) as Record<string, unknown>).filter(([, v]) => v !== '' && v != null),
  );
  return listQuerySchema.safeParse(cleaned);
}

const addressSchema = z.object({
  line1: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  state: z.string().trim().max(40).nullable().optional(),
  postal_code: z.string().trim().max(20).nullable().optional(),
});

const phoneSchema = z.object({
  phone: z.string().trim().min(3).max(40),
  label: z.string().trim().max(40).nullable().optional(),
  is_primary: z.boolean().optional(),
});

const contactFieldsSchema = z.object({
  display_name: z.string().trim().min(1).max(160),
  type: z.enum(CONTACT_TYPES).default('seller'),
  status: z.enum(CONTACT_STATUSES).optional(),
  phone: z.string().trim().min(3).max(40).optional(),
  phones: z.array(phoneSchema).max(10).optional(),
  email: z.string().trim().max(254).nullable().optional(),
  company: z.string().trim().max(160).nullable().optional(),
  tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
  source: z.string().trim().max(80).nullable().optional(),
  notes: z.string().max(10_000).nullable().optional(),
  assigned_user_id: z.string().uuid().nullable().optional(),
  address: addressSchema.nullable().optional(),
});

const createSchema = contactFieldsSchema.extend({ merge: z.boolean().optional() });

const patchSchema = contactFieldsSchema.partial().extend({
  temperature: z.enum(TEMPERATURES).optional(),
  temperature_locked: z.boolean().optional(),
});

const bulkSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  action: z.enum(['delete', 'restore', 'set_status', 'set_type', 'add_tag', 'remove_tag', 'assign']),
  value: z.string().trim().max(200).nullable().optional(),
});

const bulkMessageSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  body: z.string().max(1600).optional(),
  template_id: z.string().uuid().optional(),
  media_urls: z.array(z.string().url().max(2048)).max(10).optional(),
});

const dialListSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(500),
  name: z.string().trim().min(1).max(200).optional(),
});

const mappingSchema = z.object(
  Object.fromEntries(IMPORT_MAPPING_KEYS.map((k) => [k, z.string().min(1).max(200).optional()])) as Record<
    (typeof IMPORT_MAPPING_KEYS)[number],
    z.ZodOptional<z.ZodString>
  >,
);

const importSchema = z.object({
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(1000),
  mapping: mappingSchema,
  defaults: z
    .object({
      type: z.enum(CONTACT_TYPES).optional(),
      status: z.enum(CONTACT_STATUSES).optional(),
      tags: z.array(z.string().trim().min(1).max(60)).max(50).optional(),
      source: z.string().trim().max(80).optional(),
    })
    .default({}),
  dedupe: z.enum(['skip', 'merge', 'create']).default('merge'),
});

// ---------------------------------------------------------------------------
// List filters (shared by GET /v1/contacts and the CSV export)
// ---------------------------------------------------------------------------

function buildWhere(orgId: string, f: ListQuery): SQL {
  const clauses: Array<SQL | undefined> = [eq(c.orgId, orgId)];
  if (f.include_deleted !== 'true') clauses.push(isNull(c.deletedAt));
  if (f.type) clauses.push(eq(c.type, f.type));
  if (f.status) clauses.push(eq(c.status, f.status));
  if (f.temperature) clauses.push(eq(c.temperature, f.temperature));
  if (f.tag) clauses.push(sql`${c.tags} @> ARRAY[${f.tag}]::text[]`);
  if (f.user_id) clauses.push(eq(c.assignedUserId, f.user_id));
  if (f.has_phone === 'true') {
    clauses.push(sql`EXISTS (SELECT 1 FROM contact_phones cp WHERE cp.contact_id = ${c.id})`);
  } else if (f.has_phone === 'false') {
    clauses.push(sql`NOT EXISTS (SELECT 1 FROM contact_phones cp WHERE cp.contact_id = ${c.id})`);
  }
  if (f.q) {
    const pattern = likeContains(f.q);
    const digits = searchDigits(f.q);
    clauses.push(
      or(
        sql`${c.displayName} ILIKE ${pattern} ESCAPE '\\'`,
        sql`${c.email} ILIKE ${pattern} ESCAPE '\\'`,
        sql`${c.company} ILIKE ${pattern} ESCAPE '\\'`,
        sql`${c.notes} ILIKE ${pattern} ESCAPE '\\'`,
        sql`array_to_string(${c.tags}, ' ') ILIKE ${pattern} ESCAPE '\\'`,
        digits
          ? sql`EXISTS (SELECT 1 FROM contact_phones cp WHERE cp.contact_id = ${c.id} AND cp.phone_e164 LIKE ${`%${digits}%`})`
          : undefined,
      ),
    );
  }
  return and(...clauses)!;
}

function orderFor(sort: ListQuery['sort']): SQL[] {
  switch (sort) {
    case 'name':
      return [sql`lower(${c.displayName}) ASC`, desc(c.createdAt)];
    case 'temperature':
      return [desc(c.temperatureScore), sql`${c.lastActivityAt} DESC NULLS LAST`, desc(c.createdAt)];
    case 'created':
      return [desc(c.createdAt)];
    default:
      return [sql`${c.lastActivityAt} DESC NULLS LAST`, desc(c.createdAt)];
  }
}

async function countBy(db: DbLike, column: typeof c.type | typeof c.status | typeof c.temperature, where: SQL) {
  const rows = await db
    .select({ key: column, n: sql<number>`count(*)::int` })
    .from(c)
    .where(where)
    .groupBy(column);
  return Object.fromEntries(rows.map((r) => [r.key, r.n])) as Record<string, number>;
}

// ---------------------------------------------------------------------------
// Activity (GET /v1/contacts/:id)
// ---------------------------------------------------------------------------

interface ActivityItem {
  kind: 'call' | 'sms';
  id: string;
  at: Date;
  direction: string;
  status: string;
  duration_seconds: number | null;
  body: string | null;
  disposition_label: string | null;
  user_name: string | null;
}

async function contactActivity(db: DbLike, orgId: string, contact: ContactDto, limit = 25): Promise<ActivityItem[]> {
  const phones = contact.phones.map((p) => p.phone_e164);
  const leadIds = (
    await db
      .select({ id: schema.leads.id })
      .from(schema.leads)
      .where(and(eq(schema.leads.orgId, orgId), eq(schema.leads.primaryContactId, contact.id)))
  ).map((l) => l.id);

  const [calls, messages] = await Promise.all([
    db
      .select({
        id: schema.calls.id,
        createdAt: schema.calls.createdAt,
        direction: schema.calls.direction,
        status: schema.calls.status,
        durationSeconds: schema.calls.durationSeconds,
        dispositionNote: schema.calls.dispositionNote,
        userId: schema.calls.userId,
        dispositionName: schema.callDispositions.name,
      })
      .from(schema.calls)
      .leftJoin(schema.callDispositions, eq(schema.callDispositions.id, schema.calls.dispositionId))
      .where(
        and(
          eq(schema.calls.orgId, orgId),
          or(
            eq(schema.calls.contactId, contact.id),
            leadIds.length ? inArray(schema.calls.leadId, leadIds) : undefined,
            phones.length ? inArray(schema.calls.toNumber, phones) : undefined,
            phones.length ? inArray(schema.calls.fromNumber, phones) : undefined,
          ),
        ),
      )
      .orderBy(desc(schema.calls.createdAt))
      .limit(limit),
    db
      .select({
        id: schema.messages.id,
        createdAt: schema.messages.createdAt,
        direction: schema.messages.direction,
        status: schema.messages.status,
        body: schema.messages.body,
        createdBy: schema.messages.createdBy,
        isAutoReply: schema.messages.isAutoReply,
      })
      .from(schema.messages)
      .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
      .where(
        and(
          eq(schema.messages.orgId, orgId),
          or(
            eq(schema.conversations.contactId, contact.id),
            leadIds.length ? inArray(schema.conversations.leadId, leadIds) : undefined,
            phones.length ? inArray(schema.conversations.theirNumber, phones) : undefined,
          ),
        ),
      )
      .orderBy(desc(schema.messages.createdAt))
      .limit(limit),
  ]);

  const userIds = [
    ...new Set([...calls.map((k) => k.userId), ...messages.map((m) => m.createdBy)].filter((v): v is string => Boolean(v))),
  ];
  const users = userIds.length
    ? await db
        .select({ id: schema.users.id, displayName: schema.users.displayName })
        .from(schema.users)
        .where(inArray(schema.users.id, userIds))
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.displayName]));

  const items: ActivityItem[] = [
    ...calls.map((k) => ({
      kind: 'call' as const,
      id: k.id,
      at: k.createdAt,
      direction: k.direction,
      status: k.status,
      duration_seconds: k.durationSeconds,
      body: k.dispositionNote?.trim() || null,
      disposition_label: k.dispositionName ?? null,
      user_name: k.userId ? nameOf.get(k.userId) ?? null : null,
    })),
    ...messages.map((m) => ({
      kind: 'sms' as const,
      id: m.id,
      at: m.createdAt,
      direction: m.direction,
      status: m.status,
      duration_seconds: null,
      body: m.body,
      disposition_label: null,
      user_name: m.createdBy ? nameOf.get(m.createdBy) ?? null : m.isAutoReply ? 'Auto-reply' : null,
    })),
  ];
  items.sort((a, b) => b.at.getTime() - a.at.getTime());
  return items.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Shared input handling
// ---------------------------------------------------------------------------

type Rejection = { status: number; body: Record<string, unknown> };

interface PreparedPhones {
  phones: NormalizedPhone[];
  provided: boolean;
}

function preparePhones(input: { phone?: string; phones?: z.infer<typeof phoneSchema>[] }): PreparedPhones | Rejection {
  const provided = input.phone !== undefined || input.phones !== undefined;
  if (!provided) return { phones: [], provided: false };
  const list = [
    ...(input.phone ? [{ phone: input.phone, is_primary: !(input.phones ?? []).some((p) => p.is_primary) }] : []),
    ...(input.phones ?? []),
  ];
  const normalized = normalizePhoneList(list);
  if (!normalized.ok) {
    return { status: 400, body: { error: 'invalid_phone', phone: normalized.invalid, message: 'not a dialable number' } };
  }
  return { phones: normalized.phones, provided: true };
}

function isRejection(v: unknown): v is Rejection {
  return typeof v === 'object' && v !== null && 'status' in v && 'body' in v;
}

/** `email: ""` clears; a non-empty value must look like an email. */
function prepareEmail(raw: string | null | undefined): { email: string | null; provided: boolean } | Rejection {
  if (raw === undefined) return { email: null, provided: false };
  if (raw === null || raw.trim() === '') return { email: null, provided: true };
  const email = normalizeEmail(raw);
  if (!email) return { status: 400, body: { error: 'invalid_email', message: 'not an email address' } };
  return { email, provided: true };
}

function addressInput(a: z.infer<typeof addressSchema> | null | undefined): ContactAddressInput | null {
  if (!a) return null;
  const out: ContactAddressInput = {
    line1: a.line1 ?? null,
    city: a.city ?? null,
    state: a.state ? a.state.toUpperCase() : null,
    postal_code: a.postal_code ?? null,
  };
  return hasAddress(out) ? out : null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const audit = (ctx: AuthContext, action: string, objectType: string, objectId: string | undefined, metadata: Record<string, unknown>) => ({
  orgId: ctx.orgId,
  actorType: 'user' as const,
  actorId: ctx.userId,
  action,
  objectType,
  objectId,
  metadata,
});

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerContactRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { dbh, config } = deps;
  const db = dbh.db;
  const read = { preHandler: requirePermission('contacts.read') };
  const write = { preHandler: requirePermission('contacts.write') };

  async function requireOrgUser(ctx: AuthContext, userId: string | null | undefined): Promise<Rejection | null> {
    if (!userId) return null;
    const found = await usersInOrg(db, ctx.orgId, [userId]);
    if (!found.has(userId)) {
      return { status: 400, body: { error: 'invalid_user', message: 'assigned_user_id is not a member of this workspace' } };
    }
    return null;
  }

  /** Queue a targeted temperature recompute for contacts whose inputs just changed. */
  async function queueRescore(orgId: string, contactIds: string[]): Promise<void> {
    for (const ids of chunk(contactIds, 500)) {
      await enqueueJob(db, {
        jobType: 'contact-temperature-sweep',
        payload: { orgId, contactIds: ids },
      }).catch((err: Error) => app.log.warn({ err: err.message }, 'contact rescore enqueue failed'));
    }
  }

  // -------------------------------------------------------------------------
  // List / search
  // -------------------------------------------------------------------------
  app.get('/v1/contacts', read, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = parseListQuery(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const q = parsed.data;
    const where = buildWhere(ctx.orgId, q);
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;

    const [page, totalRows, byType, byStatus, byTemperature] = await Promise.all([
      db.select({ id: c.id }).from(c).where(where).orderBy(...orderFor(q.sort)).limit(limit).offset(offset),
      db.select({ n: sql<number>`count(*)::int` }).from(c).where(where),
      countBy(db, c.type, where),
      countBy(db, c.status, where),
      countBy(db, c.temperature, where),
    ]);
    const contacts = await loadContactDtos(db, ctx.orgId, page.map((r) => r.id));
    return {
      contacts,
      total: totalRows[0]?.n ?? 0,
      counts: { by_type: byType, by_status: byStatus, by_temperature: byTemperature },
      limit,
      offset,
    };
  });

  // -------------------------------------------------------------------------
  // Create (with duplicate-phone detection / merge)
  // -------------------------------------------------------------------------
  app.post('/v1/contacts', write, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const input = parsed.data;
    const phones = preparePhones(input);
    if (isRejection(phones)) return reply.code(phones.status).send(phones.body);
    const email = prepareEmail(input.email);
    if (isRejection(email)) return reply.code(email.status).send(email.body);
    if (phones.phones.length === 0 && !email.email) {
      return reply.code(400).send({ error: 'phone_or_email_required', message: 'a contact needs a phone number or an email' });
    }
    const badUser = await requireOrgUser(ctx, input.assigned_user_id);
    if (badUser) return reply.code(badUser.status).send(badUser.body);

    const address = addressInput(input.address);
    const tags = normalizeTags(input.tags ?? []);
    const owners = await findPhoneOwners(db, ctx.orgId, phones.phones.map((p) => p.phoneE164));
    if (owners.size > 0) {
      const [dupPhone, existingId] = [...owners.entries()][0]!;
      if (!input.merge) {
        return reply.code(409).send({ error: 'duplicate_phone', contact_id: existingId, phone: dupPhone });
      }
      const merged = await db.transaction(async (tx) => {
        const result = await mergeIntoContact(tx, ctx.orgId, existingId, {
          email: email.email,
          company: input.company ?? null,
          source: input.source ?? null,
          notes: input.notes ?? null,
          assignedUserId: input.assigned_user_id ?? null,
          tags,
          phones: phones.phones,
          address,
        });
        await writeAudit(tx, audit(ctx, 'contact.merged', 'contact', existingId, { changed: result.changed, via: 'create' }));
        return result;
      });
      if (merged.changed.includes('phones')) await rescoreContact(db, ctx.orgId, existingId);
      return reply.code(200).send({ contact: await loadContactDto(db, ctx.orgId, existingId), merged: true });
    }

    const created = await db.transaction(async (tx) => {
      const contact = await insertContact(tx, ctx.orgId, {
        displayName: input.display_name,
        type: input.type,
        status: input.status ?? 'new',
        email: email.email,
        company: input.company ?? null,
        tags,
        source: input.source ?? null,
        notes: input.notes ?? null,
        assignedUserId: input.assigned_user_id ?? null,
        createdBy: ctx.userId,
        phones: phones.phones,
        address,
      });
      await writeAudit(
        tx,
        audit(ctx, 'contact.created', 'contact', contact.id, {
          type: contact.type,
          status: contact.status,
          phones: phones.phones.length,
          has_address: address != null,
        }),
      );
      return contact;
    });
    // A new contact may match calls and texts that predate it (by number).
    await rescoreContact(db, ctx.orgId, created.id);
    return reply.code(201).send({ contact: await loadContactDto(db, ctx.orgId, created.id) });
  });

  // -------------------------------------------------------------------------
  // One contact + activity
  // -------------------------------------------------------------------------
  app.get('/v1/contacts/:id', read, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return reply.code(404).send({ error: 'not_found' });
    const contact = await loadContactDto(db, ctx.orgId, id);
    if (!contact) return reply.code(404).send({ error: 'not_found' });
    const activity = await contactActivity(db, ctx.orgId, contact);
    return { contact, activity };
  });

  // -------------------------------------------------------------------------
  // Edit
  // -------------------------------------------------------------------------
  app.patch('/v1/contacts/:id', write, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return reply.code(404).send({ error: 'not_found' });
    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const input = parsed.data;
    const current = (
      await db.select().from(c).where(and(eq(c.id, id), eq(c.orgId, ctx.orgId))).limit(1)
    )[0];
    if (!current) return reply.code(404).send({ error: 'not_found' });

    const phones = preparePhones(input);
    if (isRejection(phones)) return reply.code(phones.status).send(phones.body);
    const email = prepareEmail(input.email);
    if (isRejection(email)) return reply.code(email.status).send(email.body);
    const badUser = await requireOrgUser(ctx, input.assigned_user_id);
    if (badUser) return reply.code(badUser.status).send(badUser.body);
    if (phones.provided) {
      const owners = await findPhoneOwners(db, ctx.orgId, phones.phones.map((p) => p.phoneE164), {
        excludeContactId: current.id,
      });
      if (owners.size > 0) {
        const [dupPhone, existingId] = [...owners.entries()][0]!;
        return reply.code(409).send({ error: 'duplicate_phone', contact_id: existingId, phone: dupPhone });
      }
      // The phone list replaces wholesale; losing every number is only fine
      // when an email remains.
      const emailAfter = email.provided ? email.email : current.email;
      if (phones.phones.length === 0 && !emailAfter) {
        return reply.code(400).send({ error: 'phone_or_email_required', message: 'a contact needs a phone number or an email' });
      }
    }

    const patch: Partial<typeof c.$inferInsert> = {};
    const changed: string[] = [];
    const set = <K extends keyof typeof c.$inferInsert>(key: K, apiKey: string, value: (typeof c.$inferInsert)[K]) => {
      patch[key] = value;
      changed.push(apiKey);
    };
    if (input.display_name !== undefined) set('displayName', 'display_name', input.display_name);
    if (input.type !== undefined) set('type', 'type', input.type);
    if (input.status !== undefined) set('status', 'status', input.status);
    if (email.provided) set('email', 'email', email.email);
    if (input.company !== undefined) set('company', 'company', input.company);
    if (input.tags !== undefined) set('tags', 'tags', normalizeTags(input.tags));
    if (input.source !== undefined) set('source', 'source', input.source);
    if (input.notes !== undefined) set('notes', 'notes', input.notes);
    if (input.assigned_user_id !== undefined) set('assignedUserId', 'assigned_user_id', input.assigned_user_id);
    if (input.temperature !== undefined) {
      set('temperature', 'temperature', input.temperature);
      set('temperatureLocked', 'temperature_locked', true);
    }
    if (input.temperature_locked === false) set('temperatureLocked', 'temperature_locked', false);
    const address = input.address === undefined ? undefined : addressInput(input.address);
    if (address) changed.push('address');
    if (phones.provided) changed.push('phones');
    if (changed.length === 0) return reply.code(400).send({ error: 'empty_update' });

    await db.transaction(async (tx) => {
      if (Object.keys(patch).length > 0) {
        await tx.update(c).set({ ...patch, updatedAt: new Date() }).where(eq(c.id, current.id));
      } else {
        await tx.update(c).set({ updatedAt: new Date() }).where(eq(c.id, current.id));
      }
      if (phones.provided) {
        await tx.delete(schema.contactPhones).where(and(eq(schema.contactPhones.contactId, current.id), eq(schema.contactPhones.orgId, ctx.orgId)));
        if (phones.phones.length > 0) {
          await tx.insert(schema.contactPhones).values(
            phones.phones.map((p) => ({
              orgId: ctx.orgId,
              contactId: current.id,
              phoneE164: p.phoneE164,
              label: p.label,
              isPrimary: p.isPrimary,
            })),
          );
        }
      }
      if (address) {
        await setContactAddress(
          tx,
          ctx.orgId,
          { id: current.id, assignedUserId: patch.assignedUserId ?? current.assignedUserId },
          address,
          current.source ?? 'contacts',
        );
      }
      await writeAudit(
        tx,
        audit(ctx, 'contact.updated', 'contact', current.id, {
          changed,
          ...(input.status !== undefined && input.status !== current.status
            ? { status: { from: current.status, to: input.status } }
            : {}),
        }),
      );
    });

    // Status feeds the score, an unlock hands the bucket back to the formula,
    // and a changed phone list changes which calls count.
    const statusChanged = input.status !== undefined && input.status !== current.status;
    if (statusChanged || input.temperature_locked === false || phones.provided) {
      await rescoreContact(db, ctx.orgId, current.id);
    }
    return { contact: await loadContactDto(db, ctx.orgId, current.id) };
  });

  // -------------------------------------------------------------------------
  // Soft delete
  // -------------------------------------------------------------------------
  app.delete('/v1/contacts/:id', { preHandler: requirePermission('contacts.delete') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return reply.code(404).send({ error: 'not_found' });
    const existing = (
      await db.select({ id: c.id, deletedAt: c.deletedAt }).from(c).where(and(eq(c.id, id), eq(c.orgId, ctx.orgId))).limit(1)
    )[0];
    if (!existing) return reply.code(404).send({ error: 'not_found' });
    if (!existing.deletedAt) {
      const now = new Date();
      await db.update(c).set({ deletedAt: now, updatedAt: now }).where(eq(c.id, existing.id));
      await writeAudit(db, audit(ctx, 'contact.deleted', 'contact', existing.id, {}));
    }
    return reply.code(204).send();
  });

  // -------------------------------------------------------------------------
  // Bulk actions
  // -------------------------------------------------------------------------
  app.post('/v1/contacts/bulk', write, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = bulkSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const { ids, action } = parsed.data;
    const value = parsed.data.value ?? null;
    if ((action === 'delete' || action === 'restore') && !hasPermission(ctx, 'contacts.delete')) {
      return reply.code(403).send({ error: 'forbidden', permission: 'contacts.delete' });
    }
    const now = new Date();
    const scope = and(eq(c.orgId, ctx.orgId), inArray(c.id, ids));
    let affected: string[] = [];
    const run = async (values: Parameters<ReturnType<typeof db.update<typeof c>>['set']>[0], extra?: SQL) =>
      (
        await db
          .update(c)
          .set({ ...values, updatedAt: now })
          .where(extra ? and(scope, extra) : scope)
          .returning({ id: c.id })
      ).map((r) => r.id);

    switch (action) {
      case 'delete':
        affected = await run({ deletedAt: now }, isNull(c.deletedAt));
        break;
      case 'restore':
        affected = await run({ deletedAt: null }, isNotNull(c.deletedAt));
        break;
      case 'set_status':
        if (!value || !isContactStatus(value)) {
          return reply.code(400).send({ error: 'invalid_value', message: `status must be one of ${CONTACT_STATUSES.join(', ')}` });
        }
        affected = await run({ status: value });
        break;
      case 'set_type':
        if (!value || !isContactType(value)) {
          return reply.code(400).send({ error: 'invalid_value', message: `type must be one of ${CONTACT_TYPES.join(', ')}` });
        }
        affected = await run({ type: value });
        break;
      case 'add_tag': {
        const tag = normalizeTags([value])[0];
        if (!tag) return reply.code(400).send({ error: 'invalid_value', message: 'tag required' });
        affected = await run({ tags: sql`array_append(${c.tags}, ${tag})` }, sql`NOT (${c.tags} @> ARRAY[${tag}]::text[])`);
        break;
      }
      case 'remove_tag': {
        const tag = normalizeTags([value])[0];
        if (!tag) return reply.code(400).send({ error: 'invalid_value', message: 'tag required' });
        affected = await run({ tags: sql`array_remove(${c.tags}, ${tag})` }, sql`${c.tags} @> ARRAY[${tag}]::text[]`);
        break;
      }
      case 'assign': {
        if (value !== null && !z.string().uuid().safeParse(value).success) {
          return reply.code(400).send({ error: 'invalid_value', message: 'value must be a user id or null' });
        }
        const badUser = await requireOrgUser(ctx, value);
        if (badUser) return reply.code(badUser.status).send(badUser.body);
        affected = await run({ assignedUserId: value });
        break;
      }
    }
    await writeAudit(db, audit(ctx, 'contacts.bulk', 'contact', undefined, { action, value, requested: ids.length, count: affected.length }));
    if (action === 'set_status' && affected.length > 0) await queueRescore(ctx.orgId, affected);
    return { affected: affected.length };
  });

  // -------------------------------------------------------------------------
  // Bulk SMS — every message goes through the normal send path (suppression,
  // quiet hours, from-number choice, audit, queue) exactly like POST /v1/messages.
  // -------------------------------------------------------------------------
  app.post('/v1/contacts/bulk/message', { preHandler: requirePermission('messages.send') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = bulkMessageSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const input = parsed.data;
    if (input.body != null && input.template_id != null) {
      return reply.code(400).send({ error: 'invalid_body', message: 'provide exactly one of body or template_id' });
    }
    if (input.body == null && input.template_id == null && !(input.media_urls?.length)) {
      return reply.code(400).send({ error: 'invalid_body', message: 'provide body, template_id or media_urls' });
    }

    const contacts = await loadContactDtos(db, ctx.orgId, input.ids);
    const byId = new Map(contacts.map((k) => [k.id, k]));
    let sent = 0;
    const skipped: Array<{ id: string; reason: string; message?: string }> = [];
    let quietHours = false;
    for (const id of input.ids) {
      const contact = byId.get(id);
      if (!contact || contact.deleted_at) {
        skipped.push({ id, reason: 'not_found' });
        continue;
      }
      if (!contact.primary_phone) {
        skipped.push({ id, reason: 'no_phone' });
        continue;
      }
      if (contact.status === 'dnc') {
        skipped.push({ id, reason: 'suppressed' });
        continue;
      }
      if (quietHours) {
        // The window is org-wide: once one send is refused for it, all are.
        skipped.push({ id, reason: 'quiet_hours' });
        continue;
      }
      const body =
        input.body != null
          ? renderMergeFields(input.body, {
              first_name: firstNameOf(contact.display_name),
              name: contact.display_name,
              address: contact.address?.line1 ?? null,
              city: contact.address?.city ?? null,
              rep_name: ctx.displayName,
            })
          : undefined;
      try {
        await sendMessage(dbh, ctx, {
          toNumber: contact.primary_phone,
          contactId: contact.id,
          leadId: contact.lead_id ?? undefined,
          body,
          templateId: input.template_id,
          mediaUrls: input.media_urls,
        });
        sent += 1;
      } catch (err) {
        if (err instanceof MessageServiceError) {
          if (err.code === 'quiet_hours') quietHours = true;
          const reason = err.code === 'suppressed' || err.code === 'quiet_hours' ? err.code : 'error';
          skipped.push({ id, reason, message: err.message });
        } else {
          req.log.warn({ err, contactId: id }, 'bulk message send failed');
          skipped.push({ id, reason: 'error', message: (err as Error).message });
        }
      }
    }
    const reasons: Record<string, number> = {};
    for (const s of skipped) reasons[s.reason] = (reasons[s.reason] ?? 0) + 1;
    await writeAudit(
      db,
      audit(ctx, 'contacts.bulk_message', 'contact', undefined, {
        requested: input.ids.length,
        sent,
        skipped: reasons,
        template_id: input.template_id ?? null,
        media_count: input.media_urls?.length ?? 0,
      }),
    );
    return { sent, skipped };
  });

  // -------------------------------------------------------------------------
  // Dial list — a power-mode campaign owned by the caller (docs/dialers.md §4):
  // the rep presses Next, one lead at a time, nothing auto-dials.
  // -------------------------------------------------------------------------
  app.post('/v1/contacts/bulk/dial-list', write, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = dialListSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const input = parsed.data;
    const contacts = await loadContactDtos(db, ctx.orgId, input.ids);
    const byId = new Map(contacts.map((k) => [k.id, k]));
    const skipped: Array<{ id: string; reason: string }> = [];
    const eligible: ContactDto[] = [];
    for (const id of input.ids) {
      const contact = byId.get(id);
      if (!contact || contact.deleted_at) skipped.push({ id, reason: 'not_found' });
      else if (!contact.primary_phone) skipped.push({ id, reason: 'no_phone' });
      else if (contact.status === 'dnc') skipped.push({ id, reason: 'dnc' });
      else eligible.push(contact);
    }
    if (eligible.length === 0) {
      return reply.code(422).send({ error: 'no_dialable_contacts', skipped });
    }

    // Every contact needs a lead — that is what a campaign enrolls.
    const leadIds = await db.transaction(async (tx) => {
      const ids: string[] = [];
      for (const contact of eligible) {
        const { leadId } = await ensureLeadForContact(
          tx,
          ctx.orgId,
          { id: contact.id, assignedUserId: contact.assigned_user_id },
          'contacts',
        );
        ids.push(leadId);
      }
      return ids;
    });

    const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const baseName = input.name ?? `Dial list ${stamp} · ${ctx.displayName}`;
    let campaign: Awaited<ReturnType<typeof createCampaign>> | null = null;
    for (let attempt = 0; attempt < 5 && !campaign; attempt++) {
      const name = attempt === 0 ? baseName : `${baseName} (${attempt + 1})`;
      try {
        campaign = await createCampaign(dbh, ctx, { name, mode: 'power' });
      } catch (err) {
        if (err instanceof CampaignServiceError && err.code === 'name_taken') continue;
        throw err;
      }
    }
    if (!campaign) return reply.code(409).send({ error: 'name_taken', message: 'could not find a free campaign name' });
    await updateCampaign(dbh, config, ctx, campaign.id, { status: 'active' });
    const attached = await attachLeads(dbh, ctx, campaign.id, { leadIds });
    await writeAudit(
      db,
      audit(ctx, 'contacts.dial_list', 'campaign', campaign.id, {
        requested: input.ids.length,
        enrolled: attached.attached + attached.revived,
        skipped: skipped.length,
      }),
    );
    return reply.code(201).send({
      campaign_id: campaign.id,
      campaign_name: campaign.name,
      enrolled: attached.attached + attached.revived,
      skipped,
    });
  });

  // -------------------------------------------------------------------------
  // Import
  // -------------------------------------------------------------------------
  app.post('/v1/contacts/import', { preHandler: requirePermission('contacts.import') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = importSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const { rows, mapping, defaults, dedupe } = parsed.data;
    let created = 0;
    let merged = 0;
    const skipped: Array<{ row: number; reason: string }> = [];
    const createdIds: string[] = [];

    // Rows are processed in transactions of 100: a bad row late in a big file
    // costs at most its own chunk, and the audit row says what landed.
    const indexed = rows.map((row, i) => ({ row, index: i + 1 }));
    for (const batch of chunk(indexed, 100)) {
      const mapped = batch.map((entry) => ({ ...entry, result: mapImportRow(entry.row, mapping as ImportMapping, defaults) }));
      const phones = [
        ...new Set(mapped.flatMap((m) => (m.result.ok ? m.result.contact.phones.map((p) => p.phoneE164) : []))),
      ];
      const owners = await findPhoneOwners(db, ctx.orgId, phones);
      await db.transaction(async (tx) => {
        // Duplicates inside the file: the second row merges into (or skips
        // against) the contact the first row just created.
        const seenInBatch = new Map<string, string>();
        for (const m of mapped) {
          if (!m.result.ok) {
            skipped.push({ row: m.index, reason: m.result.reason });
            continue;
          }
          const contact = m.result.contact;
          const existingId =
            contact.phones.map((p) => owners.get(p.phoneE164) ?? seenInBatch.get(p.phoneE164)).find(Boolean) ?? null;
          if (existingId && dedupe === 'skip') {
            skipped.push({ row: m.index, reason: 'duplicate_phone' });
            continue;
          }
          if (existingId && dedupe === 'merge') {
            await mergeIntoContact(tx, ctx.orgId, existingId, {
              email: contact.email,
              company: contact.company,
              source: contact.source,
              notes: contact.notes,
              tags: contact.tags,
              phones: contact.phones,
              address: contact.address,
            });
            merged += 1;
            for (const p of contact.phones) seenInBatch.set(p.phoneE164, existingId);
            continue;
          }
          const row = await insertContact(tx, ctx.orgId, {
            displayName: contact.displayName,
            type: contact.type,
            status: contact.status,
            email: contact.email,
            company: contact.company,
            tags: contact.tags,
            source: contact.source,
            notes: contact.notes,
            assignedUserId: null,
            createdBy: ctx.userId,
            phones: contact.phones,
            address: contact.address,
          });
          created += 1;
          createdIds.push(row.id);
          for (const p of contact.phones) seenInBatch.set(p.phoneE164, row.id);
        }
      });
    }
    await writeAudit(
      db,
      audit(ctx, 'contacts.import', 'contact', undefined, {
        rows: rows.length,
        created,
        merged,
        skipped: skipped.length,
        dedupe,
        source: defaults.source ?? 'import',
      }),
    );
    // Imported numbers may already have call/text history under them.
    if (createdIds.length > 0) await queueRescore(ctx.orgId, createdIds);
    return { created, merged, skipped };
  });

  // -------------------------------------------------------------------------
  // Export
  // -------------------------------------------------------------------------
  app.get('/v1/contacts/export.csv', { preHandler: requirePermission('contacts.export') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = parseListQuery(req.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const q = parsed.data;
    const where = buildWhere(ctx.orgId, q);
    const ids = (await db.select({ id: c.id }).from(c).where(where).orderBy(...orderFor(q.sort)).limit(10_000)).map((r) => r.id);
    const header = [
      'name', 'type', 'status', 'temperature', 'score', 'primary_phone', 'other_phones', 'email', 'company',
      'address', 'city', 'state', 'postal_code', 'tags', 'assigned_rep', 'last_activity', 'created', 'id',
    ];
    const lines: unknown[][] = [];
    for (const batch of chunk(ids, 500)) {
      for (const k of await loadContactDtos(db, ctx.orgId, batch)) {
        lines.push([
          k.display_name,
          k.type,
          k.status,
          k.temperature,
          k.temperature_score,
          k.primary_phone,
          k.phones.filter((p) => p.phone_e164 !== k.primary_phone).map((p) => p.phone_e164).join(' '),
          k.email,
          k.company,
          k.address?.line1 ?? null,
          k.address?.city ?? null,
          k.address?.state ?? null,
          k.address?.postal_code ?? null,
          k.tags.join(', '),
          k.assigned_user_name,
          k.last_activity_at,
          k.created_at,
          k.id,
        ]);
      }
    }
    await writeAudit(db, audit(ctx, 'contacts.export', 'contact', undefined, { count: lines.length, filters: q }));
    const filename = `contacts-${new Date().toISOString().slice(0, 10)}.csv`;
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${filename}"`)
      .header('cache-control', 'no-store')
      .send(toCsv(header, lines));
  });

  // -------------------------------------------------------------------------
  // Temperature
  // -------------------------------------------------------------------------
  app.post('/v1/contacts/:id/rescore', write, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return reply.code(404).send({ error: 'not_found' });
    const row = await rescoreContact(db, ctx.orgId, id);
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return { contact: await loadContactDto(db, ctx.orgId, id) };
  });
}
