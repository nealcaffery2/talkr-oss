/**
 * Contacts service (docs/contacts.md): the read model the API returns
 * (`ContactDto`), and the write helpers the create / merge / import paths
 * share so "a phone already belongs to someone" means the same thing on
 * every path. Every query is org-scoped; callers pass the org from the
 * request's AuthContext, never from the body.
 */

import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type DbLike } from '@talkr/db';
import { normalizeTags, type NormalizedPhone } from './contact-import.js';

export type ContactRow = typeof schema.contacts.$inferSelect;

export interface ContactPhoneDto {
  id: string;
  phone_e164: string;
  label: string | null;
  is_primary: boolean;
}

export interface ContactAddressDto {
  line1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
}

export interface ContactDto {
  id: string;
  display_name: string;
  type: string;
  status: string;
  email: string | null;
  company: string | null;
  tags: string[];
  source: string | null;
  notes: string | null;
  temperature: string;
  temperature_score: number;
  temperature_locked: boolean;
  last_activity_at: Date | null;
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  phones: ContactPhoneDto[];
  primary_phone: string | null;
  address: ContactAddressDto | null;
  lead_id: string | null;
  lead_status: string | null;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface ContactAddressInput {
  line1?: string | null;
  city?: string | null;
  state?: string | null;
  postal_code?: string | null;
}

export function hasAddress(a: ContactAddressInput | null | undefined): a is ContactAddressInput {
  return Boolean(a && (a.line1 || a.city || a.state || a.postal_code));
}

// ---------------------------------------------------------------------------
// Read model
// ---------------------------------------------------------------------------

/**
 * DTOs for a set of ids, in the order given. Five queries whatever the batch
 * size: contacts, phones, the contacts' leads (newest first), those leads'
 * properties, and the assigned reps' names. Ids outside the org are dropped.
 */
export async function loadContactDtos(db: DbLike, orgId: string, ids: string[]): Promise<ContactDto[]> {
  if (ids.length === 0) return [];
  const rows = await db
    .select()
    .from(schema.contacts)
    .where(and(eq(schema.contacts.orgId, orgId), inArray(schema.contacts.id, ids)));
  if (rows.length === 0) return [];
  const found = rows.map((r) => r.id);

  const [phones, leads] = await Promise.all([
    db
      .select()
      .from(schema.contactPhones)
      .where(and(eq(schema.contactPhones.orgId, orgId), inArray(schema.contactPhones.contactId, found)))
      .orderBy(desc(schema.contactPhones.isPrimary), schema.contactPhones.id),
    db
      .select({
        id: schema.leads.id,
        status: schema.leads.status,
        contactId: schema.leads.primaryContactId,
        propertyId: schema.leads.propertyId,
      })
      .from(schema.leads)
      .where(and(eq(schema.leads.orgId, orgId), inArray(schema.leads.primaryContactId, found)))
      .orderBy(desc(schema.leads.createdAt)),
  ]);

  // Newest lead per contact: the list is newest-first, so first seen wins.
  const leadByContact = new Map<string, (typeof leads)[number]>();
  for (const l of leads) if (l.contactId && !leadByContact.has(l.contactId)) leadByContact.set(l.contactId, l);

  const propertyIds = [...new Set([...leadByContact.values()].map((l) => l.propertyId).filter((v): v is string => Boolean(v)))];
  const userIds = [...new Set(rows.map((r) => r.assignedUserId).filter((v): v is string => Boolean(v)))];
  const [properties, users] = await Promise.all([
    propertyIds.length
      ? db.select().from(schema.properties).where(inArray(schema.properties.id, propertyIds))
      : Promise.resolve([]),
    userIds.length
      ? db
          .select({ id: schema.users.id, displayName: schema.users.displayName })
          .from(schema.users)
          .where(and(eq(schema.users.orgId, orgId), inArray(schema.users.id, userIds)))
      : Promise.resolve([]),
  ]);
  const propertyById = new Map(properties.map((p) => [p.id, p]));
  const userName = new Map(users.map((u) => [u.id, u.displayName]));
  const phonesByContact = new Map<string, ContactPhoneDto[]>();
  for (const p of phones) {
    const list = phonesByContact.get(p.contactId) ?? [];
    list.push({ id: p.id, phone_e164: p.phoneE164, label: p.label, is_primary: p.isPrimary });
    phonesByContact.set(p.contactId, list);
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  const out: ContactDto[] = [];
  for (const id of ids) {
    const c = byId.get(id);
    if (!c) continue;
    const contactPhones = phonesByContact.get(c.id) ?? [];
    const lead = leadByContact.get(c.id) ?? null;
    const property = lead?.propertyId ? propertyById.get(lead.propertyId) ?? null : null;
    out.push({
      id: c.id,
      display_name: c.displayName,
      type: c.type,
      status: c.status,
      email: c.email,
      company: c.company,
      tags: c.tags ?? [],
      source: c.source,
      notes: c.notes,
      temperature: c.temperature,
      temperature_score: c.temperatureScore,
      temperature_locked: c.temperatureLocked,
      last_activity_at: c.lastActivityAt,
      assigned_user_id: c.assignedUserId,
      assigned_user_name: c.assignedUserId ? userName.get(c.assignedUserId) ?? null : null,
      phones: contactPhones,
      primary_phone: (contactPhones.find((p) => p.is_primary) ?? contactPhones[0])?.phone_e164 ?? null,
      address: property
        ? {
            line1: property.addressLine1,
            city: property.city,
            state: property.state,
            postal_code: property.postalCode,
          }
        : null,
      lead_id: lead?.id ?? null,
      lead_status: lead?.status ?? null,
      created_at: c.createdAt,
      updated_at: c.updatedAt,
      deleted_at: c.deletedAt,
    });
  }
  return out;
}

export async function loadContactDto(db: DbLike, orgId: string, id: string): Promise<ContactDto | null> {
  const [dto] = await loadContactDtos(db, orgId, [id]);
  return dto ?? null;
}

// ---------------------------------------------------------------------------
// Duplicate detection
// ---------------------------------------------------------------------------

/**
 * Which live (not soft-deleted) contact in the org already owns each of these
 * numbers. Returns phone → contact id; a number nobody owns is absent.
 */
export async function findPhoneOwners(
  db: DbLike,
  orgId: string,
  phones: string[],
  opts: { excludeContactId?: string } = {},
): Promise<Map<string, string>> {
  const owners = new Map<string, string>();
  if (phones.length === 0) return owners;
  const rows = await db
    .select({ phoneE164: schema.contactPhones.phoneE164, contactId: schema.contactPhones.contactId })
    .from(schema.contactPhones)
    .innerJoin(schema.contacts, eq(schema.contacts.id, schema.contactPhones.contactId))
    .where(
      and(
        eq(schema.contactPhones.orgId, orgId),
        inArray(schema.contactPhones.phoneE164, phones),
        isNull(schema.contacts.deletedAt),
      ),
    )
    .orderBy(schema.contacts.createdAt);
  for (const r of rows) {
    if (opts.excludeContactId && r.contactId === opts.excludeContactId) continue;
    if (!owners.has(r.phoneE164)) owners.set(r.phoneE164, r.contactId);
  }
  return owners;
}

/** Every one of these user ids is an active-or-invited member of the org. */
export async function usersInOrg(db: DbLike, orgId: string, userIds: string[]): Promise<Set<string>> {
  if (userIds.length === 0) return new Set();
  const rows = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(and(eq(schema.users.orgId, orgId), inArray(schema.users.id, userIds)));
  return new Set(rows.map((r) => r.id));
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface NewContactInput {
  displayName: string;
  type: string;
  status: string;
  email: string | null;
  company: string | null;
  tags: string[];
  source: string | null;
  notes: string | null;
  assignedUserId: string | null;
  createdBy: string | null;
  phones: NormalizedPhone[];
  address: ContactAddressInput | null;
}

/** Insert the contact, its phones and — when an address came with it — a property + lead. */
export async function insertContact(tx: DbLike, orgId: string, input: NewContactInput): Promise<ContactRow> {
  const contact = (
    await tx
      .insert(schema.contacts)
      .values({
        orgId,
        displayName: input.displayName,
        type: input.type,
        status: input.status,
        email: input.email,
        company: input.company,
        tags: normalizeTags(input.tags),
        source: input.source,
        notes: input.notes,
        assignedUserId: input.assignedUserId,
        createdBy: input.createdBy,
      })
      .returning()
  )[0]!;
  if (input.phones.length > 0) {
    await tx.insert(schema.contactPhones).values(
      input.phones.map((p) => ({
        orgId,
        contactId: contact.id,
        phoneE164: p.phoneE164,
        label: p.label,
        isPrimary: p.isPrimary,
      })),
    );
  }
  if (hasAddress(input.address)) {
    await createLeadWithProperty(tx, orgId, contact, input.source ?? 'contacts', input.address);
  }
  return contact;
}

async function createLeadWithProperty(
  tx: DbLike,
  orgId: string,
  contact: { id: string; assignedUserId: string | null },
  source: string,
  address: ContactAddressInput | null,
): Promise<string> {
  const property = hasAddress(address)
    ? (
        await tx
          .insert(schema.properties)
          .values({
            orgId,
            addressLine1: address.line1 ?? null,
            city: address.city ?? null,
            state: address.state ?? null,
            postalCode: address.postal_code ?? null,
          })
          .returning({ id: schema.properties.id })
      )[0]
    : undefined;
  const lead = (
    await tx
      .insert(schema.leads)
      .values({
        orgId,
        status: 'new',
        source,
        primaryContactId: contact.id,
        propertyId: property?.id ?? null,
        assignedUserId: contact.assignedUserId,
        receivedAt: new Date(),
      })
      .returning({ id: schema.leads.id })
  )[0]!;
  return lead.id;
}

async function newestLead(tx: DbLike, orgId: string, contactId: string) {
  return (
    await tx
      .select({ id: schema.leads.id, propertyId: schema.leads.propertyId })
      .from(schema.leads)
      .where(and(eq(schema.leads.orgId, orgId), eq(schema.leads.primaryContactId, contactId)))
      .orderBy(desc(schema.leads.createdAt))
      .limit(1)
  )[0];
}

/**
 * The lead the dialer will work for this contact: the newest one, or a fresh
 * `new` lead (source given) when the contact has none.
 */
export async function ensureLeadForContact(
  tx: DbLike,
  orgId: string,
  contact: { id: string; assignedUserId: string | null },
  source: string,
): Promise<{ leadId: string; created: boolean }> {
  const existing = await newestLead(tx, orgId, contact.id);
  if (existing) return { leadId: existing.id, created: false };
  return { leadId: await createLeadWithProperty(tx, orgId, contact, source, null), created: true };
}

/**
 * Write an address for a contact: onto the newest lead's property when there
 * is one, else a new property attached to the newest lead, else a new
 * property + lead. Blank fields clear (this is a replace, not a merge).
 */
export async function setContactAddress(
  tx: DbLike,
  orgId: string,
  contact: { id: string; assignedUserId: string | null },
  address: ContactAddressInput,
  source: string,
): Promise<void> {
  const lead = await newestLead(tx, orgId, contact.id);
  const values = {
    addressLine1: address.line1 ?? null,
    city: address.city ?? null,
    state: address.state ?? null,
    postalCode: address.postal_code ?? null,
  };
  if (!lead) {
    await createLeadWithProperty(tx, orgId, contact, source, address);
    return;
  }
  if (lead.propertyId) {
    await tx
      .update(schema.properties)
      .set(values)
      .where(and(eq(schema.properties.id, lead.propertyId), eq(schema.properties.orgId, orgId)));
    return;
  }
  const property = (
    await tx.insert(schema.properties).values({ orgId, ...values }).returning({ id: schema.properties.id })
  )[0]!;
  await tx.update(schema.leads).set({ propertyId: property.id }).where(eq(schema.leads.id, lead.id));
}

export interface MergeContactInput {
  email?: string | null;
  company?: string | null;
  source?: string | null;
  notes?: string | null;
  assignedUserId?: string | null;
  tags?: string[];
  phones?: NormalizedPhone[];
  address?: ContactAddressInput | null;
}

/**
 * Fold new information into an existing contact without overwriting what a
 * person already typed: empty fields are filled, tags are unioned, missing
 * phones are added (never made primary if one exists), and an address only
 * lands when the contact has no lead yet. Returns the keys that changed.
 */
export async function mergeIntoContact(
  tx: DbLike,
  orgId: string,
  contactId: string,
  input: MergeContactInput,
): Promise<{ contact: ContactRow; changed: string[] }> {
  const current = (
    await tx
      .select()
      .from(schema.contacts)
      .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.orgId, orgId)))
      .limit(1)
  )[0];
  if (!current) throw new Error(`contact ${contactId} not found in org`);

  const patch: Partial<typeof schema.contacts.$inferInsert> = {};
  const changed: string[] = [];
  const fill = (key: 'email' | 'company' | 'source' | 'notes', value: string | null | undefined) => {
    if (value && !current[key]) {
      patch[key] = value;
      changed.push(key);
    }
  };
  fill('email', input.email);
  fill('company', input.company);
  fill('source', input.source);
  fill('notes', input.notes);
  if (input.assignedUserId && !current.assignedUserId) {
    patch.assignedUserId = input.assignedUserId;
    changed.push('assigned_user_id');
  }
  if (input.tags?.length) {
    const union = normalizeTags([...(current.tags ?? []), ...input.tags]);
    if (union.length !== (current.tags ?? []).length) {
      patch.tags = union;
      changed.push('tags');
    }
  }

  if (input.phones?.length) {
    const existing = await tx
      .select({ id: schema.contactPhones.id })
      .from(schema.contactPhones)
      .where(and(eq(schema.contactPhones.orgId, orgId), eq(schema.contactPhones.contactId, contactId)))
      .limit(1);
    const hasPrimary = existing.length > 0;
    const inserted = await tx
      .insert(schema.contactPhones)
      .values(
        input.phones.map((p, i) => ({
          orgId,
          contactId,
          phoneE164: p.phoneE164,
          label: p.label,
          isPrimary: hasPrimary ? false : i === 0,
        })),
      )
      .onConflictDoNothing({
        target: [schema.contactPhones.orgId, schema.contactPhones.contactId, schema.contactPhones.phoneE164],
      })
      .returning({ id: schema.contactPhones.id });
    if (inserted.length > 0) changed.push('phones');
  }

  if (hasAddress(input.address)) {
    const lead = await newestLead(tx, orgId, contactId);
    if (!lead) {
      await createLeadWithProperty(tx, orgId, current, current.source ?? input.source ?? 'contacts', input.address);
      changed.push('address');
    }
  }

  let contact = current;
  if (changed.length > 0) {
    contact = (
      await tx
        .update(schema.contacts)
        .set({ ...patch, updatedAt: new Date() })
        .where(eq(schema.contacts.id, contactId))
        .returning()
    )[0]!;
  }
  return { contact, changed };
}

/** Escape LIKE metacharacters so user input matches literally under ESCAPE '\'. */
export function likeContains(value: string): string {
  return `%${value.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
}

/** The digits of a search string, for a phone match; empty when fewer than 3. */
export function searchDigits(q: string): string {
  const digits = q.replace(/\D/g, '');
  return digits.length >= 3 ? digits : '';
}

