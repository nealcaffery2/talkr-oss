/**
 * Demo history for product testing.
 *
 * A fresh workspace shows every surface empty, which reads as broken rather
 * than new. This writes the people and history the product designs show
 * into a real org — sellers with properties, a texting thread with a photo,
 * recent calls with dispositions and notes, a voicemail, open tasks, message
 * templates — so the dialer, inbox, lead card and history have something to
 * render before the first real call.
 *
 *   DATABASE_URL=postgres://… DEMO_USER_EMAIL=you@yourorg.com npm run seed:demo -w apps/server
 *
 * Idempotent per seller: a phone number already in the org is left alone, so
 * running it twice adds nothing. Everything it writes is ordinary data — delete
 * the sellers and it is gone.
 */

import { and, eq, sql } from 'drizzle-orm';
import { schema, createDb, migrate, type DbLike } from '@talkr/db';
import { ensureDefaultDispositions } from './seed.js';

const HOUR = 3_600_000;

interface Seller {
  name: string;
  phone: string;
  address: string;
  city: string;
  state: string;
  postalCode: string;
  status: string;
  source: string;
  /** Hours ago the lead arrived. */
  receivedHoursAgo: number;
  calls: Array<{
    direction: 'inbound' | 'outbound';
    hoursAgo: number;
    /** Seconds of talk; 0 means it was not answered. */
    talk: number;
    disposition?: string;
    note?: string;
    voicemailLeft?: boolean;
  }>;
  thread?: Array<{
    direction: 'inbound' | 'outbound';
    hoursAgo: number;
    body: string;
    media?: string[];
  }>;
  unread?: number;
  tasks?: Array<{ title: string; note?: string; dueHoursFromNow: number }>;
}

/** The cast of the designs, with the history their screens show. */
const SELLERS: Seller[] = [
  {
    name: 'Marisol Reyes',
    phone: '+15125550198',
    address: '100 Sample Way',
    city: 'Austin',
    state: 'TX',
    postalCode: '78704',
    status: 'follow_up',
    source: 'ppc',
    receivedHoursAgo: 4 * 24 + 3,
    calls: [
      { direction: 'outbound', hoursAgo: 3, talk: 252, disposition: 'follow_up', note: 'Talked roof, timeline, wants a number' },
      { direction: 'outbound', hoursAgo: 2 * 24 + 5, talk: 0, voicemailLeft: true },
      { direction: 'inbound', hoursAgo: 3 * 24 + 2, talk: 139, disposition: 'follow_up', note: 'Warm transfer to dispo · asked for comps' },
    ],
    thread: [
      { direction: 'outbound', hoursAgo: 2.7, body: 'Hi Marisol, this is Your Company following up on 100 Sample Way. Are you still thinking about selling?' },
      { direction: 'inbound', hoursAgo: 2.6, body: 'Maybe. It needs a new roof and I do not want to deal with it.' },
      { direction: 'outbound', hoursAgo: 2.5, body: 'Understood. Here is the comp sheet I pulled for your street — three sold in the last 90 days.', media: ['https://demo.example.com/comps-sample.png'] },
      { direction: 'inbound', hoursAgo: 2.4, body: 'Ok. Can you call me after 5?' },
    ],
    unread: 2,
    tasks: [{ title: 'Call Marisol after 5pm local', note: 'She asked for a call back after work.', dueHoursFromNow: 6 }],
  },
  {
    name: 'Darnell Rowe',
    phone: '+12165550143',
    address: '200 Example Ave',
    city: 'Cleveland',
    state: 'OH',
    postalCode: '44113',
    status: 'offer_made',
    source: 'inbound',
    receivedHoursAgo: 7,
    calls: [
      { direction: 'inbound', hoursAgo: 6.5, talk: 383, disposition: 'offer_made', note: 'Wants a number by Friday. Roof 2019, furnace original.' },
    ],
    thread: [
      { direction: 'inbound', hoursAgo: 6.6, body: 'Saw your sign on Example Ave. What would you give for 200?' },
      { direction: 'outbound', hoursAgo: 6.55, body: 'Thanks for reaching out, Darnell — calling you now.' },
    ],
    tasks: [{ title: 'Send Darnell the offer', note: 'Comps + repair estimate, by Friday.', dueHoursFromNow: 48 }],
  },
  {
    name: 'Curtis Hale',
    phone: '+19135550122',
    address: '300 Test Blvd',
    city: 'Overland Park',
    state: 'KS',
    postalCode: '66212',
    status: 'new',
    source: 'direct_mail',
    receivedHoursAgo: 2 * 24 + 8,
    calls: [
      { direction: 'inbound', hoursAgo: 2 * 24 + 7, talk: 0 },
      { direction: 'outbound', hoursAgo: 2 * 24 + 6, talk: 0, voicemailLeft: true },
    ],
  },
  {
    name: 'Yvette Brooks',
    phone: '+13035550177',
    address: '400 Placeholder St',
    city: 'Denver',
    state: 'CO',
    postalCode: '80210',
    status: 'appointment',
    source: 'ppc',
    receivedHoursAgo: 6 * 24,
    calls: [
      { direction: 'outbound', hoursAgo: 3 * 24 + 1, talk: 611, disposition: 'appointment', note: 'Walkthrough Thursday 10am. Husband will be there.' },
      { direction: 'outbound', hoursAgo: 5 * 24 + 4, talk: 0 },
    ],
    tasks: [{ title: 'Walkthrough at 400 Placeholder St', dueHoursFromNow: 3 * 24 }],
  },
];

const TEMPLATES: Array<{ name: string; category: string; body: string }> = [
  { name: 'Intro', category: 'cold', body: 'Hi {first_name}, this is Your Company. We buy houses as-is in your area and can close on your timeline. Is {address} something you would consider selling?' },
  { name: 'Follow up', category: 'warm', body: 'Hi {first_name}, following up on {address}. Any questions I can answer? Happy to put a number together whenever you are ready.' },
  { name: 'Comps sent', category: 'hot', body: 'Just sent over the comps for your street. Three sold in the last 90 days — let me know a good time to walk through the numbers.' },
  { name: 'Opt-out', category: 'compliance', body: 'Reply STOP to opt out of texts from Your Company.' },
];

interface Org {
  orgId: string;
  userId: string;
  userName: string;
  ourNumber: { id: string; phoneE164: string };
}

/** The org behind an email, and the number the rep calls from. */
async function resolveOrg(db: DbLike, email: string): Promise<Org> {
  const user = (
    await db
      .select()
      .from(schema.users)
      .where(sql`lower(${schema.users.email}) = ${email.trim().toLowerCase()}`)
      .limit(1)
  )[0];
  if (!user) throw new Error(`No user with email ${email}`);

  let number = (
    await db
      .select({ id: schema.phoneNumbers.id, phoneE164: schema.phoneNumbers.phoneE164 })
      .from(schema.phoneNumbers)
      .where(
        and(eq(schema.phoneNumbers.orgId, user.orgId), eq(schema.phoneNumbers.assignedUserId, user.id)),
      )
      .limit(1)
  )[0];
  number ??= (
    await db
      .select({ id: schema.phoneNumbers.id, phoneE164: schema.phoneNumbers.phoneE164 })
      .from(schema.phoneNumbers)
      .where(eq(schema.phoneNumbers.orgId, user.orgId))
      .limit(1)
  )[0];
  if (!number) {
    // No line yet: a placeholder so "Calling from" and the inbox have a
    // number to show. It is labelled, and is deleted like any other row once
    // a real one is provisioned.
    number = (
      await db
        .insert(schema.phoneNumbers)
        .values({
          orgId: user.orgId,
          phoneE164: '+15125550134',
          providerNumberId: 'PN_demo_seed',
          label: 'Demo',
          capabilities: { voice: true, sms: true, mms: true },
          assignedUserId: user.id,
          areaCode: '512',
          purchasedAt: new Date(),
        })
        .returning({ id: schema.phoneNumbers.id, phoneE164: schema.phoneNumbers.phoneE164 })
    )[0]!;
    await db
      .update(schema.users)
      .set({ defaultPhoneNumberId: number.id })
      .where(and(eq(schema.users.id, user.id), sql`${schema.users.defaultPhoneNumberId} is null`));
  }
  return { orgId: user.orgId, userId: user.id, userName: user.displayName, ourNumber: number };
}

async function seedSeller(db: DbLike, org: Org, seller: Seller, now: number): Promise<boolean> {
  const existing = await db
    .select({ id: schema.contactPhones.id })
    .from(schema.contactPhones)
    .where(and(eq(schema.contactPhones.orgId, org.orgId), eq(schema.contactPhones.phoneE164, seller.phone)))
    .limit(1);
  if (existing.length > 0) return false;

  const contact = (
    await db.insert(schema.contacts).values({ orgId: org.orgId, displayName: seller.name }).returning()
  )[0]!;
  await db.insert(schema.contactPhones).values({
    orgId: org.orgId,
    contactId: contact.id,
    phoneE164: seller.phone,
    label: 'mobile',
    isPrimary: true,
  });
  const property = (
    await db
      .insert(schema.properties)
      .values({
        orgId: org.orgId,
        addressLine1: seller.address,
        city: seller.city,
        state: seller.state,
        postalCode: seller.postalCode,
      })
      .returning()
  )[0]!;

  const received = new Date(now - seller.receivedHoursAgo * HOUR);
  const answered = seller.calls.filter((c) => c.talk > 0).map((c) => now - c.hoursAgo * HOUR);
  const attempts = seller.calls.filter((c) => c.direction === 'outbound').map((c) => now - c.hoursAgo * HOUR);
  const lead = (
    await db
      .insert(schema.leads)
      .values({
        orgId: org.orgId,
        status: seller.status,
        source: seller.source,
        primaryContactId: contact.id,
        propertyId: property.id,
        assignedUserId: org.userId,
        externalCreatedAt: received,
        receivedAt: received,
        assignedAt: new Date(received.getTime() + 4 * 60_000),
        firstAttemptAt: attempts.length ? new Date(Math.min(...attempts)) : null,
        firstAnswerAt: answered.length ? new Date(Math.min(...answered)) : null,
        firstConversationAt: answered.length ? new Date(Math.min(...answered)) : null,
      })
      .returning()
  )[0]!;

  const dispositions = await db
    .select({ id: schema.callDispositions.id, slug: schema.callDispositions.slug })
    .from(schema.callDispositions)
    .where(eq(schema.callDispositions.orgId, org.orgId));
  const dispositionId = new Map(dispositions.map((d) => [d.slug, d.id]));

  for (const c of seller.calls) {
    const started = new Date(now - c.hoursAgo * HOUR);
    const answeredAt = c.talk > 0 ? new Date(started.getTime() + 9_000) : null;
    const ended = new Date(started.getTime() + (c.talk > 0 ? 9_000 + c.talk * 1000 : 28_000));
    const outbound = c.direction === 'outbound';
    await db.insert(schema.calls).values({
      orgId: org.orgId,
      direction: c.direction,
      status: c.talk > 0 ? 'completed' : 'no_answer',
      userId: org.userId,
      leadId: lead.id,
      contactId: contact.id,
      phoneNumberId: org.ourNumber.id,
      fromNumber: outbound ? org.ourNumber.phoneE164 : seller.phone,
      toNumber: outbound ? seller.phone : org.ourNumber.phoneE164,
      providerCallId: `CA_demo_${lead.id.slice(0, 8)}_${Math.round(c.hoursAgo * 100)}`,
      initiatedAt: started,
      ringingAt: new Date(started.getTime() + 2_000),
      answeredAt,
      endedAt: ended,
      durationSeconds: c.talk > 0 ? c.talk : null,
      failureClass: c.talk > 0 ? 'none' : 'seller_no_answer',
      dispositionId: c.disposition ? dispositionId.get(c.disposition) ?? null : null,
      dispositionNote: c.note ?? null,
      wrapupCompletedAt: c.disposition ? new Date(ended.getTime() + 40_000) : null,
      raw: { demo: true, dispositionNote: c.note ?? null, voicemailLeft: c.voicemailLeft === true },
      createdAt: started,
    });
  }

  if (seller.thread?.length) {
    const last = seller.thread[seller.thread.length - 1]!;
    const conversation = (
      await db
        .insert(schema.conversations)
        .values({
          orgId: org.orgId,
          contactId: contact.id,
          leadId: lead.id,
          phoneNumberId: org.ourNumber.id,
          ourNumber: org.ourNumber.phoneE164,
          theirNumber: seller.phone,
          assignedUserId: org.userId,
          lastMessageAt: new Date(now - last.hoursAgo * HOUR),
          unreadCount: seller.unread ?? 0,
          createdAt: new Date(now - seller.thread[0]!.hoursAgo * HOUR),
        })
        .returning()
    )[0]!;
    for (const m of seller.thread) {
      const at = new Date(now - m.hoursAgo * HOUR);
      const outbound = m.direction === 'outbound';
      await db.insert(schema.messages).values({
        orgId: org.orgId,
        conversationId: conversation.id,
        direction: m.direction,
        status: outbound ? 'delivered' : 'received',
        body: m.body,
        mediaUrls: m.media ?? [],
        numSegments: 1,
        providerMessageSid: `SM_demo_${conversation.id.slice(0, 8)}_${Math.round(m.hoursAgo * 100)}`,
        createdBy: outbound ? org.userId : null,
        sentAt: outbound ? new Date(at.getTime() + 1_500) : null,
        deliveredAt: outbound ? new Date(at.getTime() + 4_000) : null,
        createdAt: at,
      });
    }
  }

  for (const t of seller.tasks ?? []) {
    await db.insert(schema.tasks).values({
      orgId: org.orgId,
      leadId: lead.id,
      assignedUserId: org.userId,
      title: t.title,
      note: t.note ?? null,
      dueAt: new Date(now + t.dueHoursFromNow * HOUR),
      status: 'open',
      source: 'manual',
      createdBy: org.userId,
      createdAt: new Date(now - 2 * HOUR),
    });
  }
  return true;
}

export async function seedDemo(db: DbLike, email: string, now = Date.now()): Promise<{ sellers: string[]; templates: number }> {
  const org = await resolveOrg(db, email);
  await ensureDefaultDispositions(db, org.orgId);

  const sellers: string[] = [];
  for (const seller of SELLERS) {
    if (await seedSeller(db, org, seller, now)) sellers.push(seller.name);
  }

  const existingTemplates = (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.messageTemplates)
      .where(eq(schema.messageTemplates.orgId, org.orgId))
  )[0]?.n ?? 0;
  let templates = 0;
  if (existingTemplates === 0) {
    await db.insert(schema.messageTemplates).values(
      TEMPLATES.map((t) => ({ orgId: org.orgId, name: t.name, body: t.body, category: t.category, createdBy: org.userId })),
    );
    templates = TEMPLATES.length;
  }
  return { sellers, templates };
}

if (process.argv[1]?.endsWith('seed-demo.ts')) {
  const url = process.env.DATABASE_URL;
  const email = process.env.DEMO_USER_EMAIL;
  if (!url) throw new Error('DATABASE_URL required');
  if (!email) throw new Error('DEMO_USER_EMAIL required: the rep whose workspace gets the demo history');
  const dbh = createDb(url);
  await migrate(dbh.pool);
  const result = await seedDemo(dbh.db, email);
  console.log(result);
  await dbh.close();
}
