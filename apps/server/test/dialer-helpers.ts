/**
 * Shared plumbing for the Phase 5 dialer suites: seed leads with phones and
 * properties, create/activate campaigns through the real API, run sessions,
 * and drive the dialer-watch sweep.
 */

import { randomUUID } from 'node:crypto';
import { eq, and } from 'drizzle-orm';
import { enqueueJob, schema } from '@talkr/db';
import { authHeader, type TestContext } from './helpers.js';

export interface MadeLead {
  leadId: string;
  contactId: string;
  phone: string;
}

let leadSeq = 0;

export async function makeLead(
  ctx: TestContext,
  opts: { name?: string; phone?: string; timezone?: string; source?: string } = {},
): Promise<MadeLead> {
  leadSeq += 1;
  const phone = opts.phone ?? `+1614777${String(1000 + leadSeq).slice(-4)}`;
  const { db } = ctx.dbh;
  const contact = (
    await db
      .insert(schema.contacts)
      .values({ orgId: ctx.seed.orgId, displayName: opts.name ?? `Seller ${leadSeq}` })
      .returning()
  )[0]!;
  await db.insert(schema.contactPhones).values({
    orgId: ctx.seed.orgId,
    contactId: contact.id,
    phoneE164: phone,
    isPrimary: true,
  });
  const property = (
    await db
      .insert(schema.properties)
      .values({
        orgId: ctx.seed.orgId,
        addressLine1: `${leadSeq} Dialer Ave`,
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
        orgId: ctx.seed.orgId,
        source: opts.source ?? 'dialer-test',
        status: 'new',
        primaryContactId: contact.id,
        propertyId: property.id,
        assignedUserId: ctx.seed.repId,
        receivedAt: new Date(),
        raw: opts.timezone ? { timezone: opts.timezone } : {},
      })
      .returning()
  )[0]!;
  return { leadId: lead.id, contactId: contact.id, phone };
}

export async function setPresence(
  ctx: TestContext,
  userId: string,
  status = 'available',
): Promise<void> {
  await ctx.dbh.db
    .insert(schema.agentPresence)
    .values({ userId, orgId: ctx.seed.orgId, status, lastSeenAt: new Date() })
    .onConflictDoUpdate({
      target: schema.agentPresence.userId,
      set: { status, lastSeenAt: new Date() },
    });
}

export async function adminAuth(): Promise<Record<string, string>> {
  return authHeader('auth-admin-test-org');
}

export async function repAuth(): Promise<Record<string, string>> {
  return authHeader('auth-rep-test-org');
}

export interface CampaignSetup {
  campaignId: string;
}

export async function createDialCampaign(
  ctx: TestContext,
  auth: Record<string, string>,
  input: { name: string; mode: string; settings?: Record<string, unknown>; activate?: boolean },
): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/campaigns',
    headers: auth,
    payload: { name: input.name, mode: input.mode, settings: input.settings ?? {} },
  });
  if (res.statusCode !== 201) throw new Error(`campaign create failed: ${res.body}`);
  const id = (res.json() as { campaign: { id: string } }).campaign.id;
  if (input.activate !== false) {
    const act = await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/campaigns/${id}`,
      headers: auth,
      payload: { status: 'active' },
    });
    if (act.statusCode !== 200) throw new Error(`campaign activate failed: ${act.body}`);
  }
  return id;
}

export async function attachByIds(
  ctx: TestContext,
  auth: Record<string, string>,
  campaignId: string,
  leadIds: string[],
): Promise<{ attached: number; revived: number }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/v1/campaigns/${campaignId}/leads`,
    headers: auth,
    payload: { lead_ids: leadIds },
  });
  if (res.statusCode !== 200) throw new Error(`attach failed: ${res.body}`);
  return res.json() as { attached: number; revived: number };
}

export async function startSessionApi(
  ctx: TestContext,
  auth: Record<string, string>,
  campaignId: string,
): Promise<{ statusCode: number; session?: { id: string } }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/dial-sessions',
    headers: auth,
    payload: { campaign_id: campaignId },
  });
  const body = res.json() as { session?: { id: string } };
  return { statusCode: res.statusCode, session: body.session };
}

export interface NextResponse {
  statusCode: number;
  idle?: boolean;
  reason?: string;
  error?: string;
  batch_id?: string | null;
  lines?: Array<{
    call: { id: string; status: string; to_number: string };
    campaign_lead_id: string;
    card: {
      lead: { id: string };
      contact: { display_name: string; phone: string | null } | null;
      property: { address_line1: string | null } | null;
    } | null;
  }>;
}

export async function nextApi(
  ctx: TestContext,
  auth: Record<string, string>,
  sessionId: string,
): Promise<NextResponse> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: `/v1/dial-sessions/${sessionId}/next`,
    headers: auth,
    payload: {},
  });
  return { statusCode: res.statusCode, ...(res.json() as object) } as NextResponse;
}

export async function campaignLeadRow(ctx: TestContext, campaignId: string, leadId: string) {
  const rows = await ctx.dbh.db
    .select()
    .from(schema.campaignLeads)
    .where(
      and(
        eq(schema.campaignLeads.campaignId, campaignId),
        eq(schema.campaignLeads.leadId, leadId),
      ),
    );
  return rows[0]!;
}

export async function getCall(ctx: TestContext, id: string) {
  const rows = await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.id, id));
  return rows[0]!;
}

export async function getSession(ctx: TestContext, id: string) {
  const rows = await ctx.dbh.db
    .select()
    .from(schema.dialSessions)
    .where(eq(schema.dialSessions.id, id));
  return rows[0]!;
}

/** Run the cursor-tailing dialer-watch sweep now (unique key per invocation
 * so back-to-back runs in the same second still sweep). */
export async function runDialerWatch(ctx: TestContext): Promise<void> {
  await enqueueJob(ctx.dbh.db, {
    jobType: 'dialer-watch',
    dedupeKey: `dialer-watch-test:${randomUUID()}`,
  });
  await ctx.runner.drain();
}
