/**
 * Seed helpers: default dispositions per org + a demo org for local dev.
 * `npm run seed -w apps/server` seeds the demo org against DATABASE_URL.
 */

import { eq } from 'drizzle-orm';
import { schema, createDb, migrate, type DbLike } from '@talkr/db';

export const DEFAULT_DISPOSITIONS: Array<{
  name: string;
  slug: string;
  requiresFollowUp?: boolean;
  treatAsConversation?: boolean;
  addsSuppression?: boolean;
}> = [
  { name: 'No Answer', slug: 'no_answer' },
  { name: 'Voicemail', slug: 'voicemail' },
  { name: 'Wrong Number', slug: 'wrong_number' },
  { name: 'Follow Up', slug: 'follow_up', requiresFollowUp: true, treatAsConversation: true },
  { name: 'Appointment', slug: 'appointment', requiresFollowUp: true, treatAsConversation: true },
  { name: 'Offer Made', slug: 'offer_made', treatAsConversation: true },
  { name: 'Not Interested', slug: 'not_interested', treatAsConversation: true },
  { name: 'Dead Lead', slug: 'dead_lead', treatAsConversation: true },
  { name: 'Contract Sent', slug: 'contract_sent', treatAsConversation: true },
  { name: 'Contract Signed', slug: 'contract_signed', treatAsConversation: true },
  { name: 'DNC', slug: 'dnc', addsSuppression: true },
  { name: 'Other', slug: 'other' },
];

export async function ensureDefaultDispositions(db: DbLike, orgId: string): Promise<void> {
  await db
    .insert(schema.callDispositions)
    .values(
      DEFAULT_DISPOSITIONS.map((d, i) => ({
        orgId,
        name: d.name,
        slug: d.slug,
        sortOrder: i,
        isSystem: true,
        requiresFollowUp: d.requiresFollowUp ?? false,
        treatAsConversation: d.treatAsConversation ?? false,
        addsSuppression: d.addsSuppression ?? false,
      })),
    )
    .onConflictDoNothing();
}

export interface SeedResult {
  orgId: string;
  adminId: string;
  repId: string;
  phoneNumberId: string;
  contactId: string;
  leadId: string;
}

/** Create a complete demo org. Used by local dev and by the test harness. */
export async function seedDemoOrg(
  db: DbLike,
  opts: {
    slug?: string;
    phoneE164?: string;
    contactPhone?: string;
    adminAuthUserId?: string;
    repAuthUserId?: string;
    externalItemId?: string;
  } = {},
): Promise<SeedResult> {
  const slug = opts.slug ?? `demo-${Date.now()}`;
  const org = (
    await db.insert(schema.organizations).values({ name: 'Your Company', slug }).returning()
  )[0]!;

  const admin = (
    await db
      .insert(schema.users)
      .values({
        orgId: org.id,
        email: `admin@${slug}.test`,
        displayName: 'Alex Admin',
        role: 'admin',
        timezone: 'America/New_York',
        city: 'New York, NY',
        authUserId: opts.adminAuthUserId ?? `auth-admin-${slug}`,
      })
      .returning()
  )[0]!;

  const rep = (
    await db
      .insert(schema.users)
      .values({
        orgId: org.id,
        email: `rep@${slug}.test`,
        displayName: 'Riley Rep',
        role: 'rep',
        timezone: 'America/Chicago',
        city: 'Austin, TX',
        authUserId: opts.repAuthUserId ?? `auth-rep-${slug}`,
      })
      .returning()
  )[0]!;

  const number = (
    await db
      .insert(schema.phoneNumbers)
      .values({
        orgId: org.id,
        phoneE164: opts.phoneE164 ?? '+15005550006',
        providerNumberId: 'PN_demo',
        capabilities: { voice: true, sms: true, mms: false },
        assignedUserId: rep.id,
        areaCode: (opts.phoneE164 ?? '+15005550006').slice(2, 5),
        purchasedAt: new Date(),
      })
      .returning()
  )[0]!;
  await db
    .update(schema.users)
    .set({ defaultPhoneNumberId: number.id })
    .where(eq(schema.users.id, rep.id));

  await ensureDefaultDispositions(db, org.id);

  const contact = (
    await db
      .insert(schema.contacts)
      .values({ orgId: org.id, displayName: 'Sally Seller' })
      .returning()
  )[0]!;
  await db.insert(schema.contactPhones).values({
    orgId: org.id,
    contactId: contact.id,
    phoneE164: opts.contactPhone ?? '+15005550009',
    isPrimary: true,
  });
  const property = (
    await db
      .insert(schema.properties)
      .values({
        orgId: org.id,
        addressLine1: '123 Maple St',
        city: 'Columbus',
        state: 'OH',
        postalCode: '43004',
      })
      .returning()
  )[0]!;
  const lead = (
    await db
      .insert(schema.leads)
      .values({
        orgId: org.id,
        source: 'ppc',
        status: 'new',
        primaryContactId: contact.id,
        propertyId: property.id,
        assignedUserId: rep.id,
        externalItemId: opts.externalItemId ?? null,
        externalCreatedAt: new Date(),
        receivedAt: new Date(),
        assignedAt: new Date(),
      })
      .returning()
  )[0]!;

  return {
    orgId: org.id,
    adminId: admin.id,
    repId: rep.id,
    phoneNumberId: number.id,
    contactId: contact.id,
    leadId: lead.id,
  };
}

// CLI entry: seed the demo org against DATABASE_URL.
if (process.argv[1]?.endsWith('seed.ts')) {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL required');
  const dbh = createDb(url);
  const applied = await migrate(dbh.pool);
  const result = await seedDemoOrg(dbh.db, { slug: 'demo' });
  console.log({ applied, ...result });
  await dbh.close();
}
