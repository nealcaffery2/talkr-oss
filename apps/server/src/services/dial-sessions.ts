/**
 * Dial sessions (docs/dialers.md §3–§5): start/pause/resume/end, the `next`
 * dial path with its two-stage suppression gate, parallel batches, and the
 * shared bookkeeping (counters, abandonment cap, SSE) used by the routes,
 * the TwiML answer path, and the worker handlers.
 */

import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  PRESENCE_FRESHNESS_MS,
  computeRetrySchedule,
  effectiveLineCount,
  isAbandonmentCapBreached,
  pickNextCampaignLead,
  resolveCampaignSettings,
  abandonmentRate,
  type CampaignLeadCandidate,
  type CampaignSettings,
  type ResolvedCampaignSettings,
  type SelectionIdleReason,
} from '@talkr/core';
import { publishBusEvent, schema, type DbHandle, type DbLike } from '@talkr/db';
import type { AuthContext } from '../auth.js';
import type { AppDeps } from '../app.js';
import { CallServiceError, createOutboundCall } from './calls.js';
import { writeAudit } from './audit.js';
import {
  campaignAbandonmentStats,
  isUniqueViolation,
  loadCampaign,
  type CampaignRow,
} from './campaigns.js';

export class DialSessionError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'session_exists'
      | 'campaign_not_active'
      | 'presence_required'
      | 'session_not_active'
      | 'call_in_flight'
      | 'predictive_disabled'
      | 'invalid_state',
    message: string,
  ) {
    super(message);
  }
}

export type DialSessionRow = typeof schema.dialSessions.$inferSelect;
export type CampaignLeadRow = typeof schema.campaignLeads.$inferSelect;

const CANDIDATE_BATCH = 25;
const MAX_PICKS_PER_LINE = 5;

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

export async function startSession(
  deps: Pick<AppDeps, 'dbh' | 'config'>,
  ctx: AuthContext,
  campaignId: string,
): Promise<DialSessionRow> {
  const { dbh, config } = deps;
  const campaign = await loadCampaign(dbh, ctx.orgId, campaignId);
  if (!campaign) throw new DialSessionError('not_found', 'campaign not found');
  if (campaign.status !== 'active') {
    throw new DialSessionError('campaign_not_active', `campaign is ${campaign.status}`);
  }
  if (campaign.mode === 'predictive' && !config.DIALER_PREDICTIVE_ENABLED) {
    // Designed-but-disabled (docs/dialers.md §6): no predictive sessions.
    throw new DialSessionError('predictive_disabled', 'predictive dialing is disabled');
  }
  const presence = (
    await dbh.db
      .select()
      .from(schema.agentPresence)
      .where(eq(schema.agentPresence.userId, ctx.userId))
      .limit(1)
  )[0];
  const fresh =
    presence &&
    presence.status === 'available' &&
    Date.now() - presence.lastSeenAt.getTime() <= PRESENCE_FRESHNESS_MS;
  if (!fresh) {
    throw new DialSessionError('presence_required', 'softphone must be online and available');
  }

  try {
    const session = (
      await dbh.db
        .insert(schema.dialSessions)
        .values({
          orgId: ctx.orgId,
          campaignId,
          userId: ctx.userId,
          mode: campaign.mode,
          state: 'active',
        })
        .returning()
    )[0]!;
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'dial_session.start',
      objectType: 'dial_session',
      objectId: session.id,
      metadata: { campaignId, mode: campaign.mode },
    });
    await publishSessionEvent(dbh, session, { event: 'started' });
    return session;
  } catch (err) {
    if (isUniqueViolation(err)) {
      // dial_sessions_one_active_uq: one active session per rep, DB-enforced.
      throw new DialSessionError('session_exists', 'an active dial session already exists');
    }
    throw err;
  }
}

export async function loadSession(
  dbh: DbHandle,
  orgId: string,
  sessionId: string,
): Promise<DialSessionRow | undefined> {
  return (
    await dbh.db
      .select()
      .from(schema.dialSessions)
      .where(and(eq(schema.dialSessions.id, sessionId), eq(schema.dialSessions.orgId, orgId)))
      .limit(1)
  )[0];
}

export async function activeSessionForUser(
  dbh: DbHandle,
  ctx: AuthContext,
): Promise<DialSessionRow | undefined> {
  return (
    await dbh.db
      .select()
      .from(schema.dialSessions)
      .where(
        and(
          eq(schema.dialSessions.userId, ctx.userId),
          eq(schema.dialSessions.orgId, ctx.orgId),
          inArray(schema.dialSessions.state, ['active', 'paused']),
        ),
      )
      .orderBy(desc(schema.dialSessions.startedAt))
      .limit(1)
  )[0];
}

export async function setSessionState(
  dbh: DbHandle,
  ctx: AuthContext,
  sessionId: string,
  action: 'pause' | 'resume' | 'end',
): Promise<DialSessionRow> {
  const session = await loadSession(dbh, ctx.orgId, sessionId);
  if (!session || session.userId !== ctx.userId) {
    throw new DialSessionError('not_found', 'dial session not found');
  }
  if (session.state === 'ended') {
    throw new DialSessionError('invalid_state', 'session already ended');
  }
  if (action === 'resume' && session.state !== 'paused') {
    throw new DialSessionError('invalid_state', 'session is not paused');
  }

  const patch: Partial<typeof schema.dialSessions.$inferInsert> =
    action === 'pause'
      ? { state: 'paused' }
      : action === 'resume'
        ? { state: 'active' }
        : { state: 'ended', endedAt: new Date() };
  const updated = (
    await dbh.db
      .update(schema.dialSessions)
      .set(patch)
      .where(eq(schema.dialSessions.id, sessionId))
      .returning()
  )[0]!;

  if (action === 'end') {
    // A queued session call the browser never connected has no provider-side
    // existence; cancel it directly (queued→canceled is a legal transition)
    // and journal it so the lead can release below.
    const canceled = await dbh.db.execute(sql`
      UPDATE calls SET status = 'canceled', ended_at = now(), failure_class = 'canceled'
      WHERE raw->>'dialSessionId' = ${sessionId} AND status = 'queued'
      RETURNING id, org_id`);
    for (const row of canceled.rows as Array<{ id: string; org_id: string }>) {
      await dbh.db
        .insert(schema.callEvents)
        .values({
          orgId: row.org_id,
          callId: row.id,
          eventType: 'call.canceled',
          occurredAt: new Date(),
          source: 'system',
          dedupeToken: `${row.id}:session-end-cancel:x`,
          payload: { reason: 'session_ended_before_dial' },
        })
        .onConflictDoNothing();
    }
    await recomputeSessionCounters(dbh.db, sessionId);
    await releaseStuckLeads(dbh.db, updated);
  }
  await writeAudit(dbh.db, {
    orgId: ctx.orgId,
    actorType: 'user',
    actorId: ctx.userId,
    action: `dial_session.${action}`,
    objectType: 'dial_session',
    objectId: sessionId,
  });
  const fresh = (await loadSession(dbh, ctx.orgId, sessionId))!;
  await publishSessionEvent(dbh, fresh, { event: action });
  return fresh;
}

/**
 * End-of-session hygiene: campaign_leads stuck in_progress whose dial has
 * already reached a terminal state (or never produced a call) go back to
 * pending so the next session can work them.
 */
async function releaseStuckLeads(db: DbLike, session: DialSessionRow): Promise<void> {
  await db.execute(sql`
    UPDATE campaign_leads cl SET status = 'pending'
    WHERE cl.campaign_id = ${session.campaignId}
      AND cl.status = 'in_progress'
      AND NOT EXISTS (
        SELECT 1 FROM calls c
        WHERE c.raw->>'campaignLeadId' = cl.id::text
          AND c.status IN ('queued','initiated','ringing','in_progress')
      )`);
}

// ---------------------------------------------------------------------------
// Shared bookkeeping
// ---------------------------------------------------------------------------

/**
 * Counters are recomputed from the calls table, never incremented — cursor
 * rescans and at-least-once processing cannot drift them (docs/dialers.md §1).
 */
export async function recomputeSessionCounters(db: DbLike, sessionId: string): Promise<void> {
  await db.execute(sql`
    UPDATE dial_sessions SET
      dialed_count = (
        SELECT count(*)::int FROM calls WHERE raw->>'dialSessionId' = ${sessionId}),
      connected_count = (
        SELECT count(*)::int FROM calls
        WHERE raw->>'dialSessionId' = ${sessionId}
          AND answered_at IS NOT NULL
          AND COALESCE(raw->>'abandoned', '') <> 'true'
          AND (raw->>'amdResult' IS NULL OR raw->>'amdResult' = 'human')),
      abandoned_count = (
        SELECT count(*)::int FROM calls
        WHERE raw->>'dialSessionId' = ${sessionId} AND raw->>'abandoned' = 'true')
    WHERE id = ${sessionId}`);
}

export async function publishSessionEvent(
  dbh: DbHandle,
  session: DialSessionRow,
  data: Record<string, unknown>,
): Promise<void> {
  await publishBusEvent(dbh.pool, {
    type: 'session.updated',
    orgId: session.orgId,
    userId: session.userId,
    data: {
      sessionId: session.id,
      campaignId: session.campaignId,
      state: session.state,
      mode: session.mode,
      dialed: session.dialedCount,
      connected: session.connectedCount,
      abandoned: session.abandonedCount,
      lineLimit: session.currentLineLimit,
      ...data,
    },
  }).catch(() => undefined);
}

/**
 * Abandonment-cap evaluation (docs/dialers.md §7 C4): campaign-scope rolling
 * window, hard ≤3% cap. A breach drops the session to one line — sticky for
 * the session — and is journaled in the audit log.
 */
export async function evaluateAbandonmentCap(
  dbh: DbHandle,
  session: DialSessionRow,
  settings: ResolvedCampaignSettings,
): Promise<void> {
  if (session.currentLineLimit === 1) return; // already reduced
  const stats = await campaignAbandonmentStats(dbh, session.campaignId);
  if (!isAbandonmentCapBreached(stats, settings.abandonmentCapPercent)) return;
  await dbh.db
    .update(schema.dialSessions)
    .set({ currentLineLimit: 1 })
    .where(eq(schema.dialSessions.id, session.id));
  await writeAudit(dbh.db, {
    orgId: session.orgId,
    actorType: 'system',
    action: 'dial_session.lines_reduced',
    objectType: 'dial_session',
    objectId: session.id,
    metadata: {
      reason: 'abandonment_cap_breached',
      answered: stats.answered,
      abandoned: stats.abandoned,
      rate: abandonmentRate(stats),
      cap_percent: settings.abandonmentCapPercent,
    },
  });
  const fresh = await loadSessionById(dbh.db, session.id);
  if (fresh) await publishSessionEvent(dbh, fresh, { event: 'lines_reduced' });
}

export async function loadSessionById(
  db: DbLike,
  sessionId: string,
): Promise<DialSessionRow | undefined> {
  return (
    await db.select().from(schema.dialSessions).where(eq(schema.dialSessions.id, sessionId)).limit(1)
  )[0];
}

/** Build the AuthContext a system-initiated advance acts under. */
export async function systemCtxForSession(
  db: DbLike,
  session: DialSessionRow,
): Promise<AuthContext | null> {
  const user = (
    await db.select().from(schema.users).where(eq(schema.users.id, session.userId)).limit(1)
  )[0];
  if (!user) return null;
  return {
    userId: user.id,
    orgId: user.orgId,
    role: user.role,
    email: user.email,
    displayName: user.displayName,
  };
}

// ---------------------------------------------------------------------------
// Lead card (what the rep sees before the seller answers)
// ---------------------------------------------------------------------------

export interface LeadCard {
  lead: { id: string; status: string; source: string | null };
  contact: { id: string; display_name: string; phone: string | null } | null;
  property: {
    id: string;
    address_line1: string | null;
    city: string | null;
    state: string | null;
    postal_code: string | null;
  } | null;
}

export async function buildLeadCard(db: DbLike, orgId: string, leadId: string): Promise<LeadCard | null> {
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
  const phone = contact
    ? (
        await db
          .select()
          .from(schema.contactPhones)
          .where(eq(schema.contactPhones.contactId, contact.id))
          .orderBy(sql`${schema.contactPhones.isPrimary} DESC`)
          .limit(1)
      )[0]
    : undefined;
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
    lead: { id: lead.id, status: lead.status, source: lead.source },
    contact: contact
      ? { id: contact.id, display_name: contact.displayName, phone: phone?.phoneE164 ?? null }
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

// ---------------------------------------------------------------------------
// Candidate loading + the two-stage suppression gate
// ---------------------------------------------------------------------------

interface LoadedCandidates {
  candidates: CampaignLeadCandidate[];
  orgTimezone: string;
}

async function loadCandidates(
  dbh: DbHandle,
  campaign: CampaignRow,
  settings: ResolvedCampaignSettings,
  excludeIds: ReadonlySet<string>,
): Promise<LoadedCandidates> {
  const org = (
    await dbh.db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, campaign.orgId))
      .limit(1)
  )[0];
  const orgTimezone =
    ((org?.settings ?? {}) as { timezone?: string }).timezone ?? 'America/New_York';

  const rows = await dbh.db.execute(sql`
    SELECT
      cl.id,
      cl.lead_id,
      cl.status,
      cl.attempts,
      cl.next_attempt_at,
      cl.priority,
      cl.created_at,
      cl.last_attempt_at,
      l.raw->>'timezone' AS lead_timezone,
      (
        SELECT cp.phone_e164 FROM contact_phones cp
        WHERE cp.contact_id = l.primary_contact_id AND cp.org_id = l.org_id
        ORDER BY cp.is_primary DESC LIMIT 1
      ) AS phone_e164
    FROM campaign_leads cl
    JOIN leads l ON l.id = cl.lead_id
    WHERE cl.campaign_id = ${campaign.id}
      AND cl.status = 'pending'
      AND (cl.next_attempt_at IS NULL OR cl.next_attempt_at <= now())
      AND cl.attempts < ${settings.maxAttemptsTotal}
    ORDER BY cl.priority DESC, cl.next_attempt_at ASC NULLS FIRST, cl.created_at ASC
    LIMIT ${CANDIDATE_BATCH}`);

  const candidates: CampaignLeadCandidate[] = [];
  const leadIds: string[] = [];
  for (const r of rows.rows as Array<Record<string, unknown>>) {
    if (excludeIds.has(r.id as string)) continue;
    leadIds.push(r.lead_id as string);
    candidates.push({
      id: r.id as string,
      leadId: r.lead_id as string,
      status: r.status as CampaignLeadCandidate['status'],
      attempts: Number(r.attempts),
      attemptsToday: 0, // filled below
      nextAttemptAt: r.next_attempt_at ? new Date(r.next_attempt_at as string) : null,
      priority: Number(r.priority),
      createdAt: new Date(r.created_at as string),
      lastAttemptAt: r.last_attempt_at ? new Date(r.last_attempt_at as string) : null,
      phoneE164: (r.phone_e164 as string | null) ?? null,
      timezone: (r.lead_timezone as string | null) ?? null,
    });
  }

  // Per-day attempt counting (C5): ALL outbound dials to the lead today
  // (org-local day), campaign or manual — over-counting is compliance-safe.
  if (leadIds.length > 0) {
    const today = await dbh.db.execute(sql`
      SELECT lead_id, count(*)::int AS n FROM calls
      WHERE lead_id IN (${sql.join(leadIds.map((id) => sql`${id}`), sql`, `)})
        AND direction = 'outbound'
        AND created_at >= (date_trunc('day', now() AT TIME ZONE ${orgTimezone}) AT TIME ZONE ${orgTimezone})
      GROUP BY lead_id`);
    const byLead = new Map(
      (today.rows as Array<{ lead_id: string; n: number }>).map((r) => [r.lead_id, r.n]),
    );
    for (const c of candidates) c.attemptsToday = byLead.get(c.leadId) ?? 0;
  }

  return { candidates, orgTimezone };
}

/**
 * Numbers suppressed for AUTO-dialing: org scope + this campaign's scope,
 * ANY channel. Deliberately stricter than manual click-to-call (which gates
 * on voice|all): a number whose owner just texted STOP is never auto-dialed,
 * even though a rep may still call it manually (docs/dialers.md §7).
 */
async function suppressedAmong(
  db: DbLike,
  orgId: string,
  campaignId: string,
  numbers: string[],
): Promise<Set<string>> {
  if (numbers.length === 0) return new Set();
  const result = await db.execute(sql`
    SELECT DISTINCT phone_e164 FROM suppression_records
    WHERE org_id = ${orgId}
      AND phone_e164 IN (${sql.join(numbers.map((n) => sql`${n}`), sql`, `)})
      AND (expires_at IS NULL OR expires_at > now())
      AND (scope = 'org' OR (scope = 'campaign' AND campaign_id = ${campaignId}))`);
  return new Set((result.rows as Array<{ phone_e164: string }>).map((r) => r.phone_e164));
}

async function markSuppressed(
  dbh: DbHandle,
  session: DialSessionRow,
  campaignLeadIds: string[],
  stage: 'selection' | 'dial_time',
): Promise<void> {
  if (campaignLeadIds.length === 0) return;
  await dbh.db
    .update(schema.campaignLeads)
    .set({ status: 'suppressed', lastOutcome: 'suppressed', nextAttemptAt: null })
    .where(inArray(schema.campaignLeads.id, campaignLeadIds));
  await writeAudit(dbh.db, {
    orgId: session.orgId,
    actorType: 'system',
    action: 'campaign_lead.suppressed',
    objectType: 'dial_session',
    objectId: session.id,
    metadata: { campaignLeadIds, stage },
  });
}

// ---------------------------------------------------------------------------
// next — the heart (docs/dialers.md §3)
// ---------------------------------------------------------------------------

export interface DialedLine {
  call: typeof schema.calls.$inferSelect;
  campaignLeadId: string;
  card: LeadCard | null;
}

export type NextResult =
  | { idle: true; reason: SelectionIdleReason }
  | { idle: false; lines: DialedLine[]; batchId: string | null };

export interface NextOptions {
  /** Worker-initiated advance (progressive auto-advance). */
  systemInitiated?: boolean;
  /** Test seam: runs between selection and the dial-time re-check, so the
   * C2 race (suppression landing mid-flight) is pinnable by a test. */
  _testBeforeDial?: () => Promise<void>;
}

export async function sessionNext(
  deps: Pick<AppDeps, 'dbh' | 'config' | 'provider' | 'logger'>,
  ctx: AuthContext,
  sessionId: string,
  opts: NextOptions = {},
): Promise<NextResult> {
  const { dbh } = deps;
  const session = await loadSession(dbh, ctx.orgId, sessionId);
  if (!session || session.userId !== ctx.userId) {
    throw new DialSessionError('not_found', 'dial session not found');
  }
  if (session.state !== 'active') {
    throw new DialSessionError('session_not_active', `session is ${session.state}`);
  }
  const campaign = await loadCampaign(dbh, ctx.orgId, session.campaignId);
  if (!campaign || campaign.status !== 'active') {
    throw new DialSessionError('campaign_not_active', 'campaign is no longer active');
  }
  const settings = resolveCampaignSettings(campaign.settings as CampaignSettings);

  // One dial (or batch) at a time per session: refuse while a session call
  // is still in flight.
  const inFlight = await dbh.db.execute(sql`
    SELECT id FROM calls
    WHERE raw->>'dialSessionId' = ${session.id}
      AND status IN ('queued','initiated','ringing','in_progress')
    LIMIT 1`);
  if (inFlight.rows.length > 0) {
    throw new DialSessionError('call_in_flight', 'a session call is still in flight');
  }

  const parallel = session.mode === 'parallel';
  const lines = parallel ? effectiveLineCount(settings, session.currentLineLimit) : 1;
  const batchId = parallel ? randomUUID() : null;
  const now = new Date();
  const picked = new Set<string>();
  const dialed: DialedLine[] = [];
  let idleReason: SelectionIdleReason = 'no_leads';

  for (let line = 0; line < lines; line++) {
    let lineDialed = false;
    for (let attempt = 0; attempt < MAX_PICKS_PER_LINE && !lineDialed; attempt++) {
      const { candidates, orgTimezone } = await loadCandidates(dbh, campaign, settings, picked);
      const numbers = candidates
        .map((c) => c.phoneE164)
        .filter((n): n is string => Boolean(n));
      // Gate 1 — SELECTION-TIME suppression check (C1).
      const suppressedNumbers = await suppressedAmong(dbh.db, ctx.orgId, campaign.id, numbers);
      const selection = pickNextCampaignLead(candidates, {
        settings,
        orgTimezone,
        suppressedNumbers,
        now,
        excludeIds: picked,
      });
      if (selection.suppressed.length > 0) {
        await markSuppressed(dbh, session, selection.suppressed.map((s) => s.id), 'selection');
        for (const s of selection.suppressed) picked.add(s.id);
      }
      if (!selection.pick) {
        idleReason = selection.idleReason ?? 'no_leads';
        break;
      }
      const pick = selection.pick;
      picked.add(pick.id);

      // Reserve: in_progress + attempt counted at dial creation (C5,
      // docs/dialers.md §10.4 — over-counting is compliance-safe).
      await dbh.db
        .update(schema.campaignLeads)
        .set({ status: 'in_progress', attempts: pick.attempts + 1, lastAttemptAt: now })
        .where(eq(schema.campaignLeads.id, pick.id));

      if (opts._testBeforeDial) await opts._testBeforeDial();

      // Gate 2 — DIAL-TIME re-check (C2): suppression is queried again
      // immediately before the call exists; createOutboundCall then runs its
      // own org-scope gate a third time inside the click-to-call service.
      const recheck = await suppressedAmong(dbh.db, ctx.orgId, campaign.id, [pick.phoneE164!]);
      if (recheck.size > 0) {
        await markSuppressed(dbh, session, [pick.id], 'dial_time');
        continue; // the session moves on — never dialed
      }

      try {
        const call = await createOutboundCall(dbh, ctx, {
          toNumber: pick.phoneE164!,
          leadId: pick.leadId,
          campaignContext: {
            campaignId: campaign.id,
            dialSessionId: session.id,
            campaignLeadId: pick.id,
            dialMode: session.mode,
            ...(batchId ? { dialBatchId: batchId } : {}),
            ...(settings.callerIdPhoneNumberId
              ? { callerIdPhoneNumberId: settings.callerIdPhoneNumberId }
              : {}),
          },
        });
        const card = await buildLeadCard(dbh.db, ctx.orgId, pick.leadId);
        dialed.push({ call, campaignLeadId: pick.id, card });
        lineDialed = true;
      } catch (err) {
        if (err instanceof CallServiceError && err.code === 'suppressed') {
          // Gate 3 hit inside the click-to-call service: same treatment.
          await markSuppressed(dbh, session, [pick.id], 'dial_time');
          continue;
        }
        if (err instanceof CallServiceError && err.code === 'invalid_number') {
          await dbh.db
            .update(schema.campaignLeads)
            .set({ status: 'completed', lastOutcome: 'invalid_number' })
            .where(eq(schema.campaignLeads.id, pick.id));
          continue;
        }
        // Unexpected failure: release the reservation, keep the attempt.
        await dbh.db
          .update(schema.campaignLeads)
          .set({ status: 'pending' })
          .where(eq(schema.campaignLeads.id, pick.id));
        throw err;
      }
    }
    if (!lineDialed) break; // nothing dialable — stop asking for more lines
  }

  if (dialed.length === 0) {
    const fresh = (await loadSessionById(dbh.db, session.id))!;
    await publishSessionEvent(dbh, fresh, { event: 'idle', idleReason });
    return { idle: true, reason: idleReason };
  }

  // Parallel: REST-dial each line server-side (docs/dialers.md §4).
  if (parallel) {
    for (const line of dialed) {
      await placeRestDial(deps, settings, line);
    }
  }

  await recomputeSessionCounters(dbh.db, session.id);
  const fresh = (await loadSessionById(dbh.db, session.id))!;
  await publishSessionEvent(dbh, fresh, {
    event: 'dialed',
    callIds: dialed.map((d) => d.call.id),
    batchId,
    systemInitiated: opts.systemInitiated ?? false,
  });
  return { idle: false, lines: dialed, batchId };
}

/** REST-dial one parallel line; stamp the SID and the pstn leg. */
async function placeRestDial(
  deps: Pick<AppDeps, 'dbh' | 'config' | 'provider' | 'logger'>,
  settings: ResolvedCampaignSettings,
  line: DialedLine,
): Promise<void> {
  const { dbh, config, provider } = deps;
  const call = line.call;
  const q = `call=${call.id}`;
  try {
    const { providerCallId } = await provider.createCall({
      from: call.fromNumber,
      to: call.toNumber,
      answerUrl: `${config.PUBLIC_BASE_URL}/twiml/campaign-answer?${q}`,
      statusCallbackUrl: `${config.PUBLIC_BASE_URL}/webhooks/telnyx/voice-status?${q}&leg=pstn`,
      ...(settings.amdEnabled
        ? {
            machineDetection:
              settings.amdAction === 'voicemail_drop'
                ? ('detect_message_end' as const)
                : ('enable' as const),
          }
        : {}),
    });
    await dbh.db
      .update(schema.calls)
      .set({ providerCallId })
      .where(and(eq(schema.calls.id, call.id), sql`provider_call_id IS NULL`));
    await dbh.db
      .insert(schema.callLegs)
      .values({
        orgId: call.orgId,
        callId: call.id,
        legRole: 'pstn',
        provider: provider.name,
        providerCallId,
        fromNumber: call.fromNumber,
        toNumber: call.toNumber,
        startedAt: new Date(),
      })
      .onConflictDoNothing({ target: schema.callLegs.providerCallId });
    line.call = { ...call, providerCallId };
  } catch (err) {
    // Provider refused the dial: the call failed before it existed provider-
    // side. Journal + mark failed (queued→failed is a legal transition) and
    // retry-schedule the lead.
    deps.logger.warn({ callId: call.id, err: (err as Error).message }, 'REST dial failed');
    await dbh.db.execute(sql`
      UPDATE calls SET status = 'failed', failure_class = 'platform_failure',
        ended_at = now(), failure_detail = ${(err as Error).message}
      WHERE id = ${call.id} AND status = 'queued'`);
    await dbh.db
      .insert(schema.callEvents)
      .values({
        orgId: call.orgId,
        callId: call.id,
        eventType: 'call.failed',
        occurredAt: new Date(),
        source: 'system',
        dedupeToken: `${call.id}:rest-dial-failed:x`,
        payload: { error: (err as Error).message },
      })
      .onConflictDoNothing();
    const cl = (
      await dbh.db
        .select()
        .from(schema.campaignLeads)
        .where(eq(schema.campaignLeads.id, line.campaignLeadId))
        .limit(1)
    )[0];
    if (cl && cl.status === 'in_progress') {
      const retry = computeRetrySchedule(
        cl.attempts,
        { retryBackoffHours: settings.retryBackoffHours, maxAttemptsTotal: settings.maxAttemptsTotal },
        new Date(),
      );
      await dbh.db
        .update(schema.campaignLeads)
        .set({
          status: retry.status,
          nextAttemptAt: retry.nextAttemptAt,
          lastOutcome: retry.status === 'completed' ? 'max_attempts' : 'dial_failed',
        })
        .where(eq(schema.campaignLeads.id, cl.id));
    }
  }
}

// ---------------------------------------------------------------------------
// Session detail (GET) — state + counters + current call/lead card
// ---------------------------------------------------------------------------

export async function sessionDetail(dbh: DbHandle, ctx: AuthContext, sessionId: string) {
  const session = await loadSession(dbh, ctx.orgId, sessionId);
  if (!session || session.userId !== ctx.userId) {
    throw new DialSessionError('not_found', 'dial session not found');
  }
  const campaign = await loadCampaign(dbh, ctx.orgId, session.campaignId);
  const currentCalls = await dbh.db.execute(sql`
    SELECT id FROM calls
    WHERE raw->>'dialSessionId' = ${session.id}
    ORDER BY created_at DESC LIMIT 3`);
  const callIds = (currentCalls.rows as Array<{ id: string }>).map((r) => r.id);
  const calls = callIds.length
    ? await dbh.db.select().from(schema.calls).where(inArray(schema.calls.id, callIds))
    : [];
  calls.sort((a, b) => callIds.indexOf(a.id) - callIds.indexOf(b.id));
  const latest = calls[0];
  const card = latest?.leadId ? await buildLeadCard(dbh.db, ctx.orgId, latest.leadId) : null;
  return { session, campaign, latestCall: latest ?? null, card };
}
