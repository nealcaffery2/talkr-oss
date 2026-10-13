/**
 * The Lead tab's timeline: one list built from calls, texts, tasks and the
 * speed-to-lead milestones, newest first, scoped to the org.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, ne } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { seedDemoOrg } from '../src/seed.js';
import { leadActivity } from '../src/services/lead-activity.js';
import { authHeader, createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;
let repAuth: Record<string, string>;

const T0 = new Date('2026-09-01T15:00:00Z');
const at = (minutes: number) => new Date(T0.getTime() + minutes * 60_000);

beforeAll(async () => {
  ctx = await createTestContext();
  repAuth = await authHeader('auth-rep-test-org');
  const { db } = ctx.dbh;
  const { orgId, repId, leadId, contactId, phoneNumberId } = ctx.seed;

  // Ladder milestones on the lead itself.
  await db
    .update(schema.leads)
    .set({ receivedAt: at(0), assignedAt: at(2), firstAttemptAt: at(10), firstAnswerAt: at(40) })
    .where(eq(schema.leads.id, leadId));

  const disposition = (
    await db
      .select()
      .from(schema.callDispositions)
      .where(eq(schema.callDispositions.orgId, orgId))
      .limit(1)
  )[0]!;

  await db.insert(schema.calls).values([
    {
      orgId, direction: 'outbound', status: 'no_answer', userId: repId, leadId, contactId,
      phoneNumberId, fromNumber: '+15005550006', toNumber: '+16145550100',
      providerCallId: 'CA_lead_1', initiatedAt: at(10), endedAt: at(11),
    },
    {
      orgId, direction: 'outbound', status: 'completed', userId: repId, leadId, contactId,
      phoneNumberId, fromNumber: '+15005550006', toNumber: '+16145550100',
      providerCallId: 'CA_lead_2', initiatedAt: at(40), answeredAt: at(40), endedAt: at(47),
      durationSeconds: 420, dispositionId: disposition.id,
      raw: { dispositionNote: 'Motivated. Wants to close before the 30th.' },
    },
  ]);

  const conv = (
    await db
      .insert(schema.conversations)
      .values({
        orgId, leadId, contactId, phoneNumberId,
        ourNumber: '+15005550006', theirNumber: '+16145550100',
        assignedUserId: repId, lastMessageAt: at(60),
      })
      .returning()
  )[0]!;
  await db.insert(schema.messages).values([
    {
      orgId, conversationId: conv.id, direction: 'outbound', status: 'delivered',
      body: 'Sending the comp sheet now.', createdBy: repId, createdAt: at(50),
    },
    {
      orgId, conversationId: conv.id, direction: 'inbound', status: 'delivered',
      body: '', mediaUrls: ['https://media.test/x.jpg'], createdAt: at(60),
    },
  ]);

  await db.insert(schema.tasks).values({
    orgId, leadId, assignedUserId: repId, createdBy: repId,
    title: 'Call back after 5pm', dueAt: at(24 * 60), createdAt: at(48),
  });

  // Noise in another org that must never appear.
  const other = await seedDemoOrg(db, {
    slug: 'other-org-lead',
    phoneE164: '+15005550099',
    contactPhone: '+16145550199',
    adminAuthUserId: 'auth-admin-other-lead',
    repAuthUserId: 'auth-rep-other-lead',
  });
  await db.insert(schema.calls).values({
    orgId: other.orgId, direction: 'outbound', status: 'completed', userId: other.repId,
    leadId: other.leadId, fromNumber: '+15005550099', toNumber: '+16145550199',
    providerCallId: 'CA_other', initiatedAt: at(45), answeredAt: at(45), endedAt: at(46),
  });
});

afterAll(async () => {
  await ctx.close();
});

describe('lead activity', () => {
  it('merges every source newest-first with names, dispositions and notes', async () => {
    const a = await leadActivity(ctx.dbh.db, ctx.seed.orgId, ctx.seed.leadId);
    expect(a).not.toBeNull();
    expect(a!.card.property?.city).toBe('Columbus');
    expect(a!.assigned_user?.id).toBe(ctx.seed.repId);
    expect(a!.open_tasks).toBe(1);

    const titles = a!.timeline.map((e) => e.title);
    expect(titles).toEqual([
      'Text received',
      'Text sent',
      'Task created',
      'Outbound call · answered',
      'First answer',
      'Outbound call · no answer',
      'First attempt',
      'Assigned',
      'Lead received',
    ]);

    const answered = a!.timeline.find((e) => e.id.startsWith('call:') && e.meta.duration_seconds === 420)!;
    expect(answered.detail).toBe('Motivated. Wants to close before the 30th.');
    expect(answered.meta.disposition).toBeTruthy();
    expect(answered.actor).toBeTruthy();

    // An MMS with no text still says something.
    const mms = a!.timeline.find((e) => e.title === 'Text received')!;
    expect(mms.detail).toBe('1 photo');
    expect(mms.actor).toBeNull();

    // The other org's call never leaks in.
    expect(a!.timeline.some((e) => e.id === 'call:CA_other')).toBe(false);
    expect(a!.timeline.filter((e) => e.kind === 'call')).toHaveLength(2);
  });

  it('is served at GET /v1/leads/:id and 404s across orgs and on junk ids', async () => {
    const ok = await ctx.app.inject({ method: 'GET', url: `/v1/leads/${ctx.seed.leadId}`, headers: repAuth });
    expect(ok.statusCode).toBe(200);
    const body = ok.json() as { timeline: unknown[]; card: { lead: { id: string } } };
    expect(body.card.lead.id).toBe(ctx.seed.leadId);
    expect(body.timeline.length).toBeGreaterThan(5);

    const limited = await ctx.app.inject({
      method: 'GET', url: `/v1/leads/${ctx.seed.leadId}?limit=3`, headers: repAuth,
    });
    expect((limited.json() as { timeline: unknown[] }).timeline).toHaveLength(3);

    const otherLead = (
      await ctx.dbh.db.select().from(schema.leads).where(ne(schema.leads.orgId, ctx.seed.orgId)).limit(1)
    )[0]!;
    const cross = await ctx.app.inject({ method: 'GET', url: `/v1/leads/${otherLead.id}`, headers: repAuth });
    expect(cross.statusCode).toBe(404);

    const junk = await ctx.app.inject({ method: 'GET', url: '/v1/leads/not-a-uuid', headers: repAuth });
    expect(junk.statusCode).toBe(404);
  });
});
