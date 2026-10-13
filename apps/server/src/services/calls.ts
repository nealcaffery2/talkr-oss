/**
 * Click-to-call and wrap-up (docs/architecture.md §6 steps 1 and 5).
 */

import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { normalizePhone } from '@talkr/core';
import { enqueueJob, publishBusEvent, schema, type DbHandle } from '@talkr/db';
import type { AuthContext } from '../auth.js';
import { writeAudit } from './audit.js';
import { chooseCallerId } from './caller-id.js';
import { callRefusal } from './reputation.js';

export class CallServiceError extends Error {
  constructor(
    public readonly code:
      | 'suppressed'
      | 'invalid_number'
      | 'no_caller_id'
      | 'not_found'
      | 'invalid_disposition'
      | 'lead_mismatch'
      | 'forbidden'
      | 'call_not_active'
      | 'already_bound'
      | 'browser_leg_is_client'
      | 'number_protected',
    message: string,
  ) {
    super(message);
  }
}

export interface CreateCallInput {
  toNumber?: string;
  contactId?: string;
  leadId?: string;
  /** Per-call caller-ID pick from the dialer; validated by the route. */
  fromPhoneNumberId?: string;
  /**
   * Dialer session context (Phase 5, docs/dialers.md §1): stamped into
   * calls.raw (the queueId precedent). Optional and additive — plain
   * click-to-call behavior is unchanged when absent.
   */
  campaignContext?: {
    campaignId: string;
    dialSessionId: string;
    campaignLeadId: string;
    dialMode: string;
    dialBatchId?: string;
    /** Campaign-configured caller ID (falls back to the v1 selection rule). */
    callerIdPhoneNumberId?: string;
  };
}

export async function createOutboundCall(
  dbh: DbHandle,
  ctx: AuthContext,
  input: CreateCallInput,
) {
  const { db } = dbh;

  // Resolve destination + linkage.
  let toNumber = input.toNumber;
  let contactId = input.contactId ?? null;
  let leadId = input.leadId ?? null;

  if (leadId) {
    const lead = (
      await db
        .select()
        .from(schema.leads)
        .where(and(eq(schema.leads.id, leadId), eq(schema.leads.orgId, ctx.orgId)))
        .limit(1)
    )[0];
    if (!lead) throw new CallServiceError('not_found', 'lead not found');
    contactId = contactId ?? lead.primaryContactId;
  }
  if (!toNumber && contactId) {
    const phone = (
      await db
        .select()
        .from(schema.contactPhones)
        .where(
          and(eq(schema.contactPhones.contactId, contactId), eq(schema.contactPhones.orgId, ctx.orgId)),
        )
        .orderBy(sql`${schema.contactPhones.isPrimary} DESC`)
        .limit(1)
    )[0];
    toNumber = phone?.phoneE164;
  }
  if (!toNumber) throw new CallServiceError('invalid_number', 'no destination number');
  const normalized = normalizePhone(toNumber);
  if (!normalized.ok) throw new CallServiceError('invalid_number', `cannot normalize ${toNumber}`);
  toNumber = normalized.e164;

  // Compliance gate: org-scope suppression on the voice channel.
  const suppressed = (
    await db
      .select({ id: schema.suppressionRecords.id })
      .from(schema.suppressionRecords)
      .where(
        and(
          eq(schema.suppressionRecords.orgId, ctx.orgId),
          eq(schema.suppressionRecords.phoneE164, toNumber),
          eq(schema.suppressionRecords.scope, 'org'),
          or(
            eq(schema.suppressionRecords.channel, 'voice'),
            eq(schema.suppressionRecords.channel, 'all'),
          ),
          or(
            isNull(schema.suppressionRecords.expiresAt),
            sql`${schema.suppressionRecords.expiresAt} > now()`,
          ),
        ),
      )
      .limit(1)
  )[0];
  if (suppressed) {
    throw new CallServiceError('suppressed', 'number is on the suppression list (DNC)');
  }

  // Caller ID: campaign → dialer pick → local presence → default → assigned →
  // any active (services/caller-id.ts).
  const user = (
    await db.select().from(schema.users).where(eq(schema.users.id, ctx.userId)).limit(1)
  )[0];
  const fromNumber = await chooseCallerId(db, ctx, {
    toNumber,
    overridePhoneNumberId: input.fromPhoneNumberId ?? null,
    campaignPhoneNumberId: input.campaignContext?.callerIdPhoneNumberId ?? null,
    user: user ?? null,
  });
  if (!fromNumber) throw new CallServiceError('no_caller_id', 'org has no active phone number');

  // Reputation protection (services/reputation.ts): a line over its daily cap,
  // or resting on a spam-label warning, does not dial. No query unless set.
  const refusal = await callRefusal(db, ctx.orgId, fromNumber);
  if (refusal) throw new CallServiceError('number_protected', refusal);

  // Auto-link a lead by destination phone when the caller didn't specify one.
  if (!leadId && contactId) {
    const lead = (
      await db
        .select({ id: schema.leads.id })
        .from(schema.leads)
        .where(and(eq(schema.leads.orgId, ctx.orgId), eq(schema.leads.primaryContactId, contactId)))
        .limit(1)
    )[0];
    leadId = lead?.id ?? null;
  }

  const call = (
    await db
      .insert(schema.calls)
      .values({
        orgId: ctx.orgId,
        direction: 'outbound',
        status: 'queued',
        userId: ctx.userId,
        leadId,
        contactId,
        phoneNumberId: fromNumber.id,
        fromNumber: fromNumber.phoneE164,
        toNumber,
        // Stamp the number's carrier (schema default is still 'twilio').
        provider: fromNumber.provider,
        // Dialer linkage rides raw (docs/dialers.md §1) — no calls columns.
        ...(input.campaignContext
          ? {
              raw: {
                campaignId: input.campaignContext.campaignId,
                dialSessionId: input.campaignContext.dialSessionId,
                campaignLeadId: input.campaignContext.campaignLeadId,
                dialMode: input.campaignContext.dialMode,
                ...(input.campaignContext.dialBatchId
                  ? { dialBatchId: input.campaignContext.dialBatchId }
                  : {}),
              },
            }
          : {}),
      })
      .returning()
  )[0]!;

  await writeAudit(db, {
    orgId: ctx.orgId,
    actorType: 'user',
    actorId: ctx.userId,
    action: 'call.create',
    objectType: 'call',
    objectId: call.id,
    metadata: { to_last4: toNumber.slice(-4), from: fromNumber.phoneE164 },
    correlationId: call.correlationId,
  });

  return call;
}

export interface DispositionInput {
  dispositionSlug: string;
  note?: string;
  followUpAt?: Date;
  leadStatus?: string;
}

export async function setDisposition(
  dbh: DbHandle,
  ctx: AuthContext,
  callId: string,
  input: DispositionInput,
) {
  const { db } = dbh;
  const call = (
    await db
      .select()
      .from(schema.calls)
      .where(and(eq(schema.calls.id, callId), eq(schema.calls.orgId, ctx.orgId)))
      .limit(1)
  )[0];
  if (!call) throw new CallServiceError('not_found', 'call not found');

  const disposition = (
    await db
      .select()
      .from(schema.callDispositions)
      .where(
        and(
          eq(schema.callDispositions.orgId, ctx.orgId),
          eq(schema.callDispositions.slug, input.dispositionSlug),
          eq(schema.callDispositions.isActive, true),
        ),
      )
      .limit(1)
  )[0];
  if (!disposition) throw new CallServiceError('invalid_disposition', `unknown disposition ${input.dispositionSlug}`);

  const updated = await db.transaction(async (tx) => {
    const rows = await tx
      .update(schema.calls)
      .set({
        dispositionId: disposition.id,
        dispositionNote: input.note ?? null,
        followUpAt: input.followUpAt ?? null,
        wrapupCompletedAt: new Date(),
        crmSyncStatus: call.leadId ? 'pending' : 'none',
      })
      .where(eq(schema.calls.id, callId))
      .returning();

    // DNC disposition writes suppression immediately (docs/security.md §9).
    if (disposition.addsSuppression) {
      await tx
        .insert(schema.suppressionRecords)
        .values({
          orgId: ctx.orgId,
          phoneE164: call.toNumber,
          scope: 'org',
          channel: 'all',
          reason: 'dnc_disposition',
          source: `call:${call.id}`,
        })
        .onConflictDoNothing();
    }

    if (input.leadStatus && call.leadId) {
      await tx
        .update(schema.leads)
        .set({ status: input.leadStatus })
        .where(and(eq(schema.leads.id, call.leadId), eq(schema.leads.orgId, ctx.orgId)));
    }

    // Conversation stamp from human judgment, not just duration.
    if (disposition.treatAsConversation && call.leadId) {
      await tx.execute(sql`
        UPDATE leads SET first_conversation_at = COALESCE(first_conversation_at, now())
        WHERE id = ${call.leadId}`);
    }

    // Exactly one Podio activity per call (dedupe key), only for linked leads.
    if (call.leadId) {
      await enqueueJob(tx, {
        jobType: 'podio-sync-call-activity',
        payload: { callId: call.id },
        dedupeKey: `podio-activity:${call.id}`,
        correlationId: call.correlationId,
      });
    }

    // Dialer wrap-up (Phase 5, docs/dialers.md §4): session calls enqueue
    // exactly one campaign-advance job — it applies the disposition outcome
    // to the campaign_lead and auto-advances progressive sessions.
    const rawDialSessionId = (call.raw as Record<string, unknown> | null)?.dialSessionId;
    if (typeof rawDialSessionId === 'string') {
      await enqueueJob(tx, {
        jobType: 'campaign-advance',
        payload: { callId: call.id },
        dedupeKey: `campaign-advance:${call.id}`,
        correlationId: call.correlationId,
      });
    }

    await writeAudit(tx, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'call.disposition',
      objectType: 'call',
      objectId: call.id,
      metadata: { disposition: disposition.slug, addsSuppression: disposition.addsSuppression },
      correlationId: call.correlationId,
    });

    return rows[0]!;
  });

  await publishBusEvent(dbh.pool, {
    type: 'call.wrapup',
    orgId: ctx.orgId,
    userId: ctx.userId,
    callId: call.id,
    status: updated.status,
  }).catch(() => undefined);

  return { call: updated, disposition };
}
