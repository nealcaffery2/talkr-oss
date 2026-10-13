/**
 * Cross-track integration (Wave 2): the workflow action `add_to_campaign`,
 * reserved during the parallel build, wired once both Phase 7 (workflows)
 * and Phase 5 (dialers) landed. Pins: a triggered workflow enrolls the lead
 * in a campaign exactly once (re-scan and re-run safe via campaign_leads_uq),
 * an archived campaign is a visible skip, and a cross-org campaign id fails
 * the run rather than leaking enrollment.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { enqueueJob, schema } from '@talkr/db';
import { authHeader, createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;
let adminAuth: Record<string, string>;

let sweepCount = 0;
async function fanoutAndDrain(): Promise<void> {
  await enqueueJob(ctx.dbh.db, {
    jobType: 'workflow-fanout',
    dedupeKey: `workflow-fanout:dialer-test:${++sweepCount}:${Date.now()}`,
  });
  await ctx.runner.drain();
}

async function createWorkflow(payload: Record<string, unknown>): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/workflows',
    headers: adminAuth,
    payload,
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { workflow: { id: string } }).workflow.id;
}

async function createCampaign(status: string, orgId?: string): Promise<string> {
  const row = (
    await ctx.dbh.db
      .insert(schema.campaigns)
      .values({
        orgId: orgId ?? ctx.seed.orgId,
        name: `wf-campaign-${status}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        status,
        mode: 'power',
      })
      .returning({ id: schema.campaigns.id })
  )[0]!;
  return row.id;
}

async function createLead(phone: string, name: string): Promise<string> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/leads',
    headers: adminAuth,
    payload: { contact_name: name, phone, source: 'webform' },
  });
  expect(res.statusCode).toBe(201);
  return (res.json() as { lead: { id: string } }).lead.id;
}

async function runsFor(workflowId: string) {
  return ctx.dbh.db
    .select()
    .from(schema.workflowRuns)
    .where(eq(schema.workflowRuns.workflowId, workflowId))
    .orderBy(schema.workflowRuns.createdAt);
}

async function campaignLeadRows(campaignId: string) {
  return ctx.dbh.db
    .select()
    .from(schema.campaignLeads)
    .where(eq(schema.campaignLeads.campaignId, campaignId));
}

beforeAll(async () => {
  ctx = await createTestContext();
  adminAuth = await authHeader('auth-admin-test-org');
});

afterAll(async () => {
  await ctx.close();
});

describe('add_to_campaign action', () => {
  it('enrolls the triggering lead in the campaign exactly once, re-scan safe', async () => {
    const campaignId = await createCampaign('active');
    const wfId = await createWorkflow({
      name: 'enroll web leads',
      trigger_type: 'lead.created',
      actions: [{ type: 'add_to_campaign', campaign_id: campaignId }],
    });

    const leadId = await createLead('+16145559931', 'Cathy Campaign');
    await fanoutAndDrain();

    const runs = await runsFor(wfId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
    const results = runs[0]!.actionResults as Array<{
      status: string;
      detail?: { attached?: boolean; campaign_id?: string };
    }>;
    expect(results[0]!.status).toBe('succeeded');
    expect(results[0]!.detail?.attached).toBe(true);
    expect(results[0]!.detail?.campaign_id).toBe(campaignId);

    const rows = await campaignLeadRows(campaignId);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.leadId).toBe(leadId);
    expect(rows[0]!.status).toBe('pending');

    // Overlap re-scan: the run's unique trigger key absorbs it; still one row.
    await fanoutAndDrain();
    expect(await runsFor(wfId)).toHaveLength(1);
    expect(await campaignLeadRows(campaignId)).toHaveLength(1);
  });

  it('an already-enrolled lead is a succeeded no-op (attached: false), never a duplicate', async () => {
    const campaignId = await createCampaign('active');
    const wfId = await createWorkflow({
      name: 'enroll again',
      trigger_type: 'lead.created',
      actions: [{ type: 'add_to_campaign', campaign_id: campaignId }],
    });

    const leadId = await createLead('+16145559932', 'Duke Duplicate');
    // Pre-enroll through the dialer's own attach path shape (direct row).
    await ctx.dbh.db
      .insert(schema.campaignLeads)
      .values({ orgId: ctx.seed.orgId, campaignId, leadId });

    await fanoutAndDrain();

    const runs = await runsFor(wfId);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe('succeeded');
    const results = runs[0]!.actionResults as Array<{ status: string; detail?: { attached?: boolean } }>;
    expect(results[0]!.status).toBe('succeeded');
    expect(results[0]!.detail?.attached).toBe(false);
    expect(await campaignLeadRows(campaignId)).toHaveLength(1);
  });

  it('an archived campaign is a visible skip; a cross-org campaign fails the run', async () => {
    const archivedId = await createCampaign('archived');
    const wfArchived = await createWorkflow({
      name: 'enroll into archived',
      trigger_type: 'lead.created',
      actions: [{ type: 'add_to_campaign', campaign_id: archivedId }],
    });
    await createLead('+16145559933', 'Ann Archived');
    await fanoutAndDrain();

    const archivedRuns = await runsFor(wfArchived);
    expect(archivedRuns).toHaveLength(1);
    expect(archivedRuns[0]!.status).toBe('succeeded');
    const archivedResults = archivedRuns[0]!.actionResults as Array<{ status: string }>;
    expect(archivedResults[0]!.status).toBe('skipped_campaign_archived');
    expect(await campaignLeadRows(archivedId)).toHaveLength(0);
    // Keep later lead.created tests isolated from this workflow.
    await ctx.app.inject({
      method: 'PATCH',
      url: `/v1/workflows/${wfArchived}`,
      headers: adminAuth,
      payload: { enabled: false },
    });

    const otherOrg = (
      await ctx.dbh.db
        .insert(schema.organizations)
        .values({ name: 'Other Org', slug: `other-org-${Date.now()}` })
        .returning({ id: schema.organizations.id })
    )[0]!;
    const foreignCampaignId = await createCampaign('active', otherOrg.id);
    const wfForeign = await createWorkflow({
      name: 'enroll cross-org',
      trigger_type: 'lead.created',
      actions: [{ type: 'add_to_campaign', campaign_id: foreignCampaignId }],
    });
    await createLead('+16145559934', 'Fred Foreign');
    await fanoutAndDrain();

    const foreignRuns = await runsFor(wfForeign);
    expect(foreignRuns).toHaveLength(1);
    expect(foreignRuns[0]!.status).toBe('failed');
    expect(foreignRuns[0]!.error).toContain('not found in org');
    expect(await campaignLeadRows(foreignCampaignId)).toHaveLength(0);
  });
});
