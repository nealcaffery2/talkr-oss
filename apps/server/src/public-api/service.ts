/**
 * Public API service layer (docs/public-api.md §5) — one org-scoped query
 * layer shared by the REST routes and the MCP tools so the two surfaces
 * cannot drift. Writes go THROUGH the existing internal services
 * (createOutboundCall) — this file wraps, it does not reimplement call flow.
 */

import { and, desc, eq, gte, isNotNull, lte, sql, type Column, type SQL } from 'drizzle-orm';
import { normalizePhone } from '@talkr/core';
import { schema, type Db, type DbHandle, type DbLike } from '@talkr/db';
import type { AuthContext } from '../auth.js';
import { createOutboundCall, CallServiceError } from '../services/calls.js';
import { writeAudit } from '../services/audit.js';
import { callRoutingOf } from '../services/last-contact.js';

export class PublicApiError extends Error {
  constructor(
    public readonly code: 'not_found' | 'invalid_request',
    message: string,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Cursor pagination: keyset over (created_at DESC, id DESC), opaque base64url.
// ---------------------------------------------------------------------------

export interface Page<T> {
  data: T[];
  nextCursor: string | null;
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`, 'utf8').toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8');
    const sep = raw.lastIndexOf('|');
    if (sep < 0) return null;
    const createdAt = new Date(raw.slice(0, sep));
    const id = raw.slice(sep + 1);
    if (Number.isNaN(createdAt.getTime()) || !/^[0-9a-f-]{36}$/i.test(id)) return null;
    return { createdAt, id };
  } catch {
    return null;
  }
}

export function clampLimit(limit: number | undefined): number {
  if (!limit || Number.isNaN(limit)) return 25;
  return Math.min(Math.max(1, Math.floor(limit)), 100);
}

/** `(created_at, id) < (cursor.createdAt, cursor.id)` for DESC keyset paging. */
function cursorWhere(createdAtCol: Column, idCol: Column, cursor: { createdAt: Date; id: string }): SQL {
  return sql`(${createdAtCol}, ${idCol}) < (${cursor.createdAt}, ${cursor.id}::uuid)`;
}

function page<T extends { created_at: Date | string; id: string }>(
  rows: Array<{ createdAt: Date; id: string }>,
  serialized: T[],
  limit: number,
): Page<T> {
  if (rows.length <= limit) return { data: serialized, nextCursor: null };
  const last = rows[limit - 1]!;
  return { data: serialized.slice(0, limit), nextCursor: encodeCursor(last.createdAt, last.id) };
}

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------

export interface ListCallsFilters {
  direction?: 'outbound' | 'inbound';
  status?: string;
  userId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
  cursor?: string;
}

export function serializePublicCall(call: typeof schema.calls.$inferSelect) {
  return {
    id: call.id,
    direction: call.direction,
    status: call.status,
    user_id: call.userId,
    lead_id: call.leadId,
    contact_id: call.contactId,
    from_number: call.fromNumber,
    to_number: call.toNumber,
    initiated_at: call.initiatedAt,
    ringing_at: call.ringingAt,
    answered_at: call.answeredAt,
    ended_at: call.endedAt,
    duration_seconds: call.durationSeconds,
    failure_class: call.failureClass,
    disposition_id: call.dispositionId,
    follow_up_at: call.followUpAt,
    created_at: call.createdAt,
    /** Inbound: why it rang who it rang; `last_contact` carries the touch. Null for outbound. */
    routing: callRoutingOf(call.raw),
  };
}

const CALL_STATUSES = new Set([
  'queued', 'initiated', 'ringing', 'in_progress',
  'completed', 'no_answer', 'busy', 'failed', 'canceled',
]);

export async function listCalls(db: DbLike, orgId: string, filters: ListCallsFilters) {
  const limit = clampLimit(filters.limit);
  const where: SQL[] = [eq(schema.calls.orgId, orgId)];
  if (filters.direction) where.push(eq(schema.calls.direction, filters.direction));
  if (filters.status) {
    if (!CALL_STATUSES.has(filters.status)) {
      throw new PublicApiError('invalid_request', `unknown status ${filters.status}`);
    }
    where.push(eq(schema.calls.status, filters.status as (typeof schema.calls.status.enumValues)[number]));
  }
  if (filters.userId) where.push(eq(schema.calls.userId, filters.userId));
  if (filters.from) where.push(gte(schema.calls.createdAt, filters.from));
  if (filters.to) where.push(lte(schema.calls.createdAt, filters.to));
  if (filters.cursor) {
    const cur = decodeCursor(filters.cursor);
    if (!cur) throw new PublicApiError('invalid_request', 'malformed cursor');
    where.push(cursorWhere(schema.calls.createdAt, schema.calls.id, cur));
  }
  const rows = await db
    .select()
    .from(schema.calls)
    .where(and(...where))
    .orderBy(desc(schema.calls.createdAt), desc(schema.calls.id))
    .limit(limit + 1);
  return page(rows, rows.slice(0, limit).map(serializePublicCall), limit);
}

export async function getCallWithTimeline(db: DbLike, orgId: string, callId: string) {
  const call = (
    await db
      .select()
      .from(schema.calls)
      .where(and(eq(schema.calls.id, callId), eq(schema.calls.orgId, orgId)))
      .limit(1)
  )[0];
  if (!call) return null;
  const [events, recs] = await Promise.all([
    db
      .select()
      .from(schema.callEvents)
      .where(eq(schema.callEvents.callId, call.id))
      .orderBy(schema.callEvents.occurredAt, schema.callEvents.createdAt),
    db.select().from(schema.recordings).where(eq(schema.recordings.callId, call.id)),
  ]);
  return {
    call: serializePublicCall(call),
    events: events.map((e) => ({
      id: e.id,
      type: e.eventType,
      occurred_at: e.occurredAt,
      source: e.source,
      sequence_number: e.sequenceNumber,
    })),
    recordings: recs.map((r) => ({
      id: r.id,
      status: r.status,
      duration_seconds: r.durationSeconds,
      channels: r.channels,
    })),
  };
}

export interface StartCallInput {
  userId: string;
  toNumber?: string;
  leadId?: string;
  contactId?: string;
}

/**
 * Click-to-call for machine callers: resolves the acting rep, then goes
 * through the SAME createOutboundCall service the UI uses (suppression,
 * caller-id selection, audit — nothing bypassed).
 */
export async function startCallForUser(dbh: DbHandle, orgId: string, input: StartCallInput) {
  const user = (
    await dbh.db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.id, input.userId), eq(schema.users.orgId, orgId)))
      .limit(1)
  )[0];
  if (!user || user.status !== 'active') {
    throw new PublicApiError('invalid_request', 'user_id must be an active user in this org');
  }
  const ctx: AuthContext = {
    userId: user.id,
    orgId,
    role: user.role,
    email: user.email,
    displayName: user.displayName,
  };
  const call = await createOutboundCall(dbh, ctx, {
    toNumber: input.toNumber,
    contactId: input.contactId,
    leadId: input.leadId,
  });
  return serializePublicCall(call);
}

export { CallServiceError };

// ---------------------------------------------------------------------------
// Leads
// ---------------------------------------------------------------------------

export interface ListLeadsFilters {
  status?: string;
  limit?: number;
  cursor?: string;
}

function serializePublicLead(lead: typeof schema.leads.$inferSelect) {
  return {
    id: lead.id,
    status: lead.status,
    source: lead.source,
    assigned_user_id: lead.assignedUserId,
    primary_contact_id: lead.primaryContactId,
    property_id: lead.propertyId,
    external_item_id: lead.externalItemId,
    received_at: lead.receivedAt,
    first_attempt_at: lead.firstAttemptAt,
    first_answer_at: lead.firstAnswerAt,
    first_conversation_at: lead.firstConversationAt,
    created_at: lead.createdAt,
  };
}

export async function listLeads(db: DbLike, orgId: string, filters: ListLeadsFilters) {
  const limit = clampLimit(filters.limit);
  const where: SQL[] = [eq(schema.leads.orgId, orgId)];
  if (filters.status) where.push(eq(schema.leads.status, filters.status));
  if (filters.cursor) {
    const cur = decodeCursor(filters.cursor);
    if (!cur) throw new PublicApiError('invalid_request', 'malformed cursor');
    where.push(cursorWhere(schema.leads.createdAt, schema.leads.id, cur));
  }
  const rows = await db
    .select()
    .from(schema.leads)
    .where(and(...where))
    .orderBy(desc(schema.leads.createdAt), desc(schema.leads.id))
    .limit(limit + 1);
  return page(rows, rows.slice(0, limit).map(serializePublicLead), limit);
}

export async function getLeadDetail(db: DbLike, orgId: string, leadId: string) {
  const lead = (
    await db
      .select()
      .from(schema.leads)
      .where(and(eq(schema.leads.id, leadId), eq(schema.leads.orgId, orgId)))
      .limit(1)
  )[0];
  if (!lead) return null;
  const contact = lead.primaryContactId
    ? (
        await db
          .select()
          .from(schema.contacts)
          .where(eq(schema.contacts.id, lead.primaryContactId))
          .limit(1)
      )[0]
    : undefined;
  const phones = contact
    ? await db
        .select()
        .from(schema.contactPhones)
        .where(eq(schema.contactPhones.contactId, contact.id))
    : [];
  const property = lead.propertyId
    ? (
        await db
          .select()
          .from(schema.properties)
          .where(eq(schema.properties.id, lead.propertyId))
          .limit(1)
      )[0]
    : undefined;
  return {
    lead: serializePublicLead(lead),
    contact: contact
      ? {
          id: contact.id,
          display_name: contact.displayName,
          phones: phones.map((p) => ({
            phone_e164: p.phoneE164,
            label: p.label,
            is_primary: p.isPrimary,
          })),
        }
      : null,
    property: property
      ? {
          id: property.id,
          address_line1: property.addressLine1,
          city: property.city,
          state: property.state,
          postal_code: property.postalCode,
        }
      : null,
  };
}

export interface CreateLeadInput {
  contactName: string;
  phone: string;
  source?: string;
  address?: string;
  city?: string;
  state?: string;
  postalCode?: string;
  externalItemId?: string;
}

export interface PublicActor {
  actorType: 'api_key' | 'user';
  actorId: string;
}

/**
 * Create lead + contact + phone (+ property) in one transaction, audited —
 * the same shape the internal /v1/leads route builds (docs/public-api.md §5).
 */
export async function createLeadWithContact(
  db: Db,
  orgId: string,
  actor: PublicActor,
  input: CreateLeadInput,
) {
  const normalized = normalizePhone(input.phone);
  if (!normalized.ok) throw new PublicApiError('invalid_request', `cannot normalize phone ${input.phone}`);
  const lead = await db.transaction(async (tx) => {
    const contact = (
      await tx
        .insert(schema.contacts)
        .values({ orgId, displayName: input.contactName })
        .returning()
    )[0]!;
    await tx.insert(schema.contactPhones).values({
      orgId,
      contactId: contact.id,
      phoneE164: normalized.e164,
      isPrimary: true,
    });
    const property = input.address
      ? (
          await tx
            .insert(schema.properties)
            .values({
              orgId,
              addressLine1: input.address,
              city: input.city,
              state: input.state,
              postalCode: input.postalCode,
            })
            .returning()
        )[0]
      : undefined;
    const row = (
      await tx
        .insert(schema.leads)
        .values({
          orgId,
          source: input.source ?? 'api',
          primaryContactId: contact.id,
          propertyId: property?.id,
          externalItemId: input.externalItemId,
          receivedAt: new Date(),
        })
        .returning()
    )[0]!;
    await writeAudit(tx, {
      orgId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      action: 'lead.create',
      objectType: 'lead',
      objectId: row.id,
    });
    return row;
  });
  return getLeadDetail(db, orgId, lead.id);
}

// ---------------------------------------------------------------------------
// Phone lookup (same resolution chain as the internal /v1/lookup/phone)
// ---------------------------------------------------------------------------

export async function lookupPhone(db: DbLike, orgId: string, rawNumber: string) {
  const normalized = normalizePhone(rawNumber);
  const phone = (
    await db
      .select()
      .from(schema.contactPhones)
      .where(
        and(
          eq(schema.contactPhones.orgId, orgId),
          eq(schema.contactPhones.phoneE164, normalized.e164),
        ),
      )
      .limit(1)
  )[0];
  if (!phone) return { contact: null, lead: null, property: null };
  const contact = (
    await db.select().from(schema.contacts).where(eq(schema.contacts.id, phone.contactId)).limit(1)
  )[0];
  const lead = contact
    ? (
        await db
          .select()
          .from(schema.leads)
          .where(and(eq(schema.leads.orgId, orgId), eq(schema.leads.primaryContactId, contact.id)))
          .orderBy(desc(schema.leads.createdAt))
          .limit(1)
      )[0]
    : undefined;
  const property = lead?.propertyId
    ? (
        await db
          .select()
          .from(schema.properties)
          .where(eq(schema.properties.id, lead.propertyId))
          .limit(1)
      )[0]
    : undefined;
  return {
    contact: contact ? { id: contact.id, display_name: contact.displayName } : null,
    lead: lead
      ? { id: lead.id, status: lead.status, source: lead.source, assigned_user_id: lead.assignedUserId }
      : null,
    property: property
      ? {
          id: property.id,
          address_line1: property.addressLine1,
          city: property.city,
          state: property.state,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Dispositions (wrap-up records by call/date), numbers, users
// ---------------------------------------------------------------------------

export interface ListDispositionsFilters {
  callId?: string;
  from?: Date;
  to?: Date;
  limit?: number;
}

export async function listDispositions(db: DbLike, orgId: string, filters: ListDispositionsFilters) {
  const limit = clampLimit(filters.limit);
  const where: SQL[] = [eq(schema.calls.orgId, orgId), isNotNull(schema.calls.dispositionId)];
  if (filters.callId) where.push(eq(schema.calls.id, filters.callId));
  if (filters.from) where.push(gte(schema.calls.wrapupCompletedAt, filters.from));
  if (filters.to) where.push(lte(schema.calls.wrapupCompletedAt, filters.to));
  const rows = await db
    .select({
      callId: schema.calls.id,
      slug: schema.callDispositions.slug,
      name: schema.callDispositions.name,
      note: schema.calls.dispositionNote,
      followUpAt: schema.calls.followUpAt,
      disposedAt: schema.calls.wrapupCompletedAt,
      userId: schema.calls.userId,
    })
    .from(schema.calls)
    .innerJoin(schema.callDispositions, eq(schema.calls.dispositionId, schema.callDispositions.id))
    .where(and(...where))
    .orderBy(desc(schema.calls.wrapupCompletedAt))
    .limit(limit);
  return {
    data: rows.map((r) => ({
      call_id: r.callId,
      disposition: r.slug,
      name: r.name,
      note: r.note,
      follow_up_at: r.followUpAt,
      disposed_at: r.disposedAt,
      user_id: r.userId,
    })),
  };
}

export async function listNumbers(db: DbLike, orgId: string) {
  const rows = await db
    .select()
    .from(schema.phoneNumbers)
    .where(eq(schema.phoneNumbers.orgId, orgId))
    .orderBy(schema.phoneNumbers.phoneE164);
  return {
    data: rows.map((n) => ({
      id: n.id,
      phone_e164: n.phoneE164,
      status: n.status,
      label: n.label,
      area_code: n.areaCode,
      capabilities: n.capabilities,
      assigned_user_id: n.assignedUserId,
      assigned_team_id: n.assignedTeamId,
    })),
  };
}

/** id / display_name / role only — deliberately narrow (docs/public-api.md §5). */
export async function listUsers(db: DbLike, orgId: string) {
  const rows = await db
    .select({
      id: schema.users.id,
      displayName: schema.users.displayName,
      role: schema.users.role,
    })
    .from(schema.users)
    .where(eq(schema.users.orgId, orgId))
    .orderBy(schema.users.displayName);
  return { data: rows.map((u) => ({ id: u.id, display_name: u.displayName, role: u.role })) };
}
