/**
 * Campaign CRUD + lead attachment + stats (docs/dialers.md §2).
 * Sessions and dialing live in dial-sessions.ts.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  CAMPAIGN_MODES,
  CAMPAIGN_STATUSES,
  resolveCampaignSettings,
  abandonmentRate,
  type CampaignMode,
  type CampaignSettings,
  type CampaignStatus,
  ABANDONMENT_WINDOW_DAYS,
} from '@talkr/core';
import { schema, type DbHandle } from '@talkr/db';
import type { AuthContext } from '../auth.js';
import type { Config } from '../config.js';
import { writeAudit } from './audit.js';

export class CampaignServiceError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'invalid_mode'
      | 'invalid_status'
      | 'name_taken'
      | 'predictive_disabled',
    message: string,
  ) {
    super(message);
  }
}

export type CampaignRow = typeof schema.campaigns.$inferSelect;

export async function loadCampaign(
  dbh: DbHandle,
  orgId: string,
  campaignId: string,
): Promise<CampaignRow | undefined> {
  return (
    await dbh.db
      .select()
      .from(schema.campaigns)
      .where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.orgId, orgId)))
      .limit(1)
  )[0];
}

export interface CreateCampaignInput {
  name: string;
  mode?: string;
  settings?: CampaignSettings;
}

export async function createCampaign(
  dbh: DbHandle,
  ctx: AuthContext,
  input: CreateCampaignInput,
): Promise<CampaignRow> {
  const mode = (input.mode ?? 'power') as CampaignMode;
  if (!CAMPAIGN_MODES.includes(mode)) {
    throw new CampaignServiceError('invalid_mode', `unknown campaign mode ${input.mode}`);
  }
  try {
    const campaign = (
      await dbh.db
        .insert(schema.campaigns)
        .values({
          orgId: ctx.orgId,
          name: input.name,
          mode,
          settings: input.settings ?? {},
          createdBy: ctx.userId,
        })
        .returning()
    )[0]!;
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'campaign.create',
      objectType: 'campaign',
      objectId: campaign.id,
      metadata: { name: campaign.name, mode: campaign.mode },
    });
    return campaign;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new CampaignServiceError('name_taken', `campaign named "${input.name}" already exists`);
    }
    throw err;
  }
}

export function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === '23505' || e?.cause?.code === '23505';
}

export interface UpdateCampaignInput {
  name?: string;
  mode?: string;
  settings?: CampaignSettings;
  status?: string;
}

export async function updateCampaign(
  dbh: DbHandle,
  config: Config,
  ctx: AuthContext,
  campaignId: string,
  input: UpdateCampaignInput,
): Promise<CampaignRow> {
  const campaign = await loadCampaign(dbh, ctx.orgId, campaignId);
  if (!campaign) throw new CampaignServiceError('not_found', 'campaign not found');

  const patch: Partial<typeof schema.campaigns.$inferInsert> = { updatedAt: new Date() };
  if (input.name != null) patch.name = input.name;
  if (input.mode != null) {
    if (!CAMPAIGN_MODES.includes(input.mode as CampaignMode)) {
      throw new CampaignServiceError('invalid_mode', `unknown campaign mode ${input.mode}`);
    }
    patch.mode = input.mode;
  }
  if (input.settings != null) patch.settings = input.settings;
  if (input.status != null) {
    if (!CAMPAIGN_STATUSES.includes(input.status as CampaignStatus)) {
      throw new CampaignServiceError('invalid_status', `unknown campaign status ${input.status}`);
    }
    patch.status = input.status;
  }

  // Predictive is designed-but-disabled (docs/dialers.md §6): a predictive
  // campaign can exist as a draft, but can never be ACTIVE without the flag.
  const nextMode = (patch.mode ?? campaign.mode) as CampaignMode;
  const nextStatus = (patch.status ?? campaign.status) as CampaignStatus;
  if (nextMode === 'predictive' && nextStatus === 'active' && !config.DIALER_PREDICTIVE_ENABLED) {
    throw new CampaignServiceError(
      'predictive_disabled',
      'predictive dialing is disabled: pacing requires real-world answer/abandon statistics that do not exist yet',
    );
  }

  try {
    const updated = (
      await dbh.db
        .update(schema.campaigns)
        .set(patch)
        .where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.orgId, ctx.orgId)))
        .returning()
    )[0]!;
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'campaign.update',
      objectType: 'campaign',
      objectId: campaignId,
      metadata: { status: updated.status, mode: updated.mode },
    });
    return updated;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw new CampaignServiceError('name_taken', `campaign named "${input.name}" already exists`);
    }
    throw err;
  }
}

export interface CampaignListEntry {
  campaign: CampaignRow;
  leadCounts: Record<string, number>;
}

export async function listCampaigns(dbh: DbHandle, ctx: AuthContext): Promise<CampaignListEntry[]> {
  const rows = await dbh.db
    .select()
    .from(schema.campaigns)
    .where(eq(schema.campaigns.orgId, ctx.orgId))
    .orderBy(desc(schema.campaigns.createdAt))
    .limit(200);
  if (rows.length === 0) return [];
  const counts = await dbh.db
    .select({
      campaignId: schema.campaignLeads.campaignId,
      status: schema.campaignLeads.status,
      n: sql<number>`count(*)::int`,
    })
    .from(schema.campaignLeads)
    .where(inArray(schema.campaignLeads.campaignId, rows.map((r) => r.id)))
    .groupBy(schema.campaignLeads.campaignId, schema.campaignLeads.status);
  const byCampaign = new Map<string, Record<string, number>>();
  for (const c of counts) {
    const entry = byCampaign.get(c.campaignId) ?? {};
    entry[c.status] = c.n;
    byCampaign.set(c.campaignId, entry);
  }
  return rows.map((campaign) => ({ campaign, leadCounts: byCampaign.get(campaign.id) ?? {} }));
}

export interface AttachLeadsInput {
  leadIds?: string[];
  filter?: { status?: string; source?: string; assignedUserId?: string; limit?: number };
}

export interface AttachResult {
  attached: number;
  revived: number;
  requested: number;
}

/**
 * Attach leads by explicit ids and/or a simple filter. Re-attaching a
 * `removed` lead revives it to `pending`; other existing memberships are
 * left untouched (attempt history is data, not something re-attach resets).
 */
export async function attachLeads(
  dbh: DbHandle,
  ctx: AuthContext,
  campaignId: string,
  input: AttachLeadsInput,
): Promise<AttachResult> {
  const campaign = await loadCampaign(dbh, ctx.orgId, campaignId);
  if (!campaign) throw new CampaignServiceError('not_found', 'campaign not found');

  const ids = new Set<string>();
  if (input.leadIds?.length) {
    const rows = await dbh.db
      .select({ id: schema.leads.id })
      .from(schema.leads)
      .where(and(eq(schema.leads.orgId, ctx.orgId), inArray(schema.leads.id, input.leadIds)));
    for (const r of rows) ids.add(r.id);
  }
  if (input.filter) {
    const clauses = [eq(schema.leads.orgId, ctx.orgId)];
    if (input.filter.status) clauses.push(eq(schema.leads.status, input.filter.status));
    if (input.filter.source) clauses.push(eq(schema.leads.source, input.filter.source));
    if (input.filter.assignedUserId) {
      clauses.push(eq(schema.leads.assignedUserId, input.filter.assignedUserId));
    }
    const rows = await dbh.db
      .select({ id: schema.leads.id })
      .from(schema.leads)
      .where(and(...clauses))
      .limit(Math.min(input.filter.limit ?? 1000, 5000));
    for (const r of rows) ids.add(r.id);
  }
  const leadIds = [...ids];
  if (leadIds.length === 0) return { attached: 0, revived: 0, requested: 0 };

  let revived = 0;
  let attached = 0;
  await dbh.db.transaction(async (tx) => {
    const revivedRows = await tx
      .update(schema.campaignLeads)
      .set({ status: 'pending', nextAttemptAt: null })
      .where(
        and(
          eq(schema.campaignLeads.campaignId, campaignId),
          inArray(schema.campaignLeads.leadId, leadIds),
          eq(schema.campaignLeads.status, 'removed'),
        ),
      )
      .returning({ id: schema.campaignLeads.id });
    revived = revivedRows.length;
    const inserted = await tx
      .insert(schema.campaignLeads)
      .values(leadIds.map((leadId) => ({ orgId: ctx.orgId, campaignId, leadId })))
      .onConflictDoNothing({ target: [schema.campaignLeads.campaignId, schema.campaignLeads.leadId] })
      .returning({ id: schema.campaignLeads.id });
    attached = inserted.length;
    await writeAudit(tx, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'campaign.leads_attached',
      objectType: 'campaign',
      objectId: campaignId,
      metadata: { requested: leadIds.length, attached, revived },
    });
  });
  return { attached, revived, requested: leadIds.length };
}

export async function detachLeads(
  dbh: DbHandle,
  ctx: AuthContext,
  campaignId: string,
  leadIds: string[],
): Promise<number> {
  const campaign = await loadCampaign(dbh, ctx.orgId, campaignId);
  if (!campaign) throw new CampaignServiceError('not_found', 'campaign not found');
  const rows = await dbh.db
    .update(schema.campaignLeads)
    .set({ status: 'removed' })
    .where(
      and(
        eq(schema.campaignLeads.campaignId, campaignId),
        inArray(schema.campaignLeads.leadId, leadIds),
      ),
    )
    .returning({ id: schema.campaignLeads.id });
  await writeAudit(dbh.db, {
    orgId: ctx.orgId,
    actorType: 'user',
    actorId: ctx.userId,
    action: 'campaign.leads_detached',
    objectType: 'campaign',
    objectId: campaignId,
    metadata: { detached: rows.length },
  });
  return rows.length;
}

export interface CampaignAbandonmentStats {
  answered: number;
  abandoned: number;
}

/**
 * Rolling-window abandonment inputs (docs/dialers.md §7 C4): denominator =
 * human-answered campaign calls (machine-answered excluded), trailing 30 days.
 */
export async function campaignAbandonmentStats(
  dbh: DbHandle,
  campaignId: string,
): Promise<CampaignAbandonmentStats> {
  const result = await dbh.db.execute(sql`
    SELECT
      count(*) FILTER (
        WHERE answered_at IS NOT NULL
          AND (raw->>'amdResult' IS NULL OR raw->>'amdResult' = 'human')
      )::int AS answered,
      count(*) FILTER (WHERE raw->>'abandoned' = 'true')::int AS abandoned
    FROM calls
    WHERE raw->>'campaignId' = ${campaignId}
      AND created_at > now() - (${ABANDONMENT_WINDOW_DAYS} || ' days')::interval`);
  const row = result.rows[0] as { answered: number; abandoned: number } | undefined;
  return { answered: row?.answered ?? 0, abandoned: row?.abandoned ?? 0 };
}

export async function campaignStats(dbh: DbHandle, ctx: AuthContext, campaignId: string) {
  const campaign = await loadCampaign(dbh, ctx.orgId, campaignId);
  if (!campaign) throw new CampaignServiceError('not_found', 'campaign not found');
  const settings = resolveCampaignSettings(campaign.settings as CampaignSettings);

  const leadCounts = await dbh.db
    .select({ status: schema.campaignLeads.status, n: sql<number>`count(*)::int` })
    .from(schema.campaignLeads)
    .where(eq(schema.campaignLeads.campaignId, campaignId))
    .groupBy(schema.campaignLeads.status);

  const callStats = await dbh.db.execute(sql`
    SELECT
      count(*)::int AS total,
      count(*) FILTER (
        WHERE answered_at IS NOT NULL
          AND (raw->>'amdResult' IS NULL OR raw->>'amdResult' = 'human')
          AND COALESCE(raw->>'abandoned', '') <> 'true'
      )::int AS connected,
      count(*) FILTER (WHERE raw->>'abandoned' = 'true')::int AS abandoned,
      count(*) FILTER (WHERE raw->>'amdResult' IS NOT NULL AND raw->>'amdResult' <> 'human')::int AS machine
    FROM calls WHERE raw->>'campaignId' = ${campaignId}`);
  const calls = callStats.rows[0] as {
    total: number;
    connected: number;
    abandoned: number;
    machine: number;
  };

  const window = await campaignAbandonmentStats(dbh, campaignId);
  return {
    campaign,
    settings,
    lead_counts: Object.fromEntries(leadCounts.map((r) => [r.status, r.n])),
    calls: {
      total: calls?.total ?? 0,
      connected: calls?.connected ?? 0,
      abandoned: calls?.abandoned ?? 0,
      machine: calls?.machine ?? 0,
    },
    abandonment: {
      window_days: ABANDONMENT_WINDOW_DAYS,
      answered: window.answered,
      abandoned: window.abandoned,
      rate: abandonmentRate(window),
      cap_percent: settings.abandonmentCapPercent,
    },
  };
}
