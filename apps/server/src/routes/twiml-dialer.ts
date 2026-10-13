/**
 * Parallel-dial call control (docs/dialers.md §4, §8):
 *   /twiml/campaign-answer          REST-dialed seller answered — AMD check,
 *                                   first-answer-wins bridge, or abandon
 *   /twiml/campaign-bridge-complete winner's <Dial> finished — hangup
 * Fast-ack discipline: indexed lookups + small writes only; sibling cancels
 * go through a job (provider REST calls never run on this path).
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import {
  computeRetrySchedule,
  isMachineAnsweredBy,
  resolveCampaignSettings,
  type CampaignSettings,
} from '@talkr/core';
import { enqueueJob, schema } from '@talkr/db';
import type { TelnyxVoiceProvider } from '@talkr/provider-telnyx';
import type { AppDeps } from '../app.js';
import { clientTargetsFor } from '../services/client-address.js';
import { receiveTwilioWebhook } from './webhooks.js';
import {
  evaluateAbandonmentCap,
  loadSessionById,
  publishSessionEvent,
  recomputeSessionCounters,
} from '../services/dial-sessions.js';

function sendTwiml(reply: FastifyReply, response: { contentType: string; body: string }): void {
  void reply.header('content-type', response.contentType).send(response.body);
}

type CallRow = typeof schema.calls.$inferSelect;

export function registerDialerTwimlRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config, dbh, logger } = deps;
  const provider = deps.provider as TelnyxVoiceProvider;

  async function journal(call: CallRow, eventType: string, dedupe: string, payload: unknown) {
    return dbh.db
      .insert(schema.callEvents)
      .values({
        orgId: call.orgId,
        callId: call.id,
        eventType,
        occurredAt: new Date(),
        source: 'system',
        dedupeToken: dedupe,
        payload: payload as Record<string, unknown>,
      })
      .onConflictDoNothing()
      .returning({ id: schema.callEvents.id });
  }

  /** Retry-schedule a campaign_lead still in_progress (guarded — idempotent). */
  async function retryScheduleLead(call: CallRow, outcome: string): Promise<void> {
    const raw = call.raw as Record<string, unknown>;
    const campaignLeadId = raw.campaignLeadId as string | undefined;
    const campaignId = raw.campaignId as string | undefined;
    if (!campaignLeadId || !campaignId) return;
    const [cl, campaign] = await Promise.all([
      dbh.db
        .select()
        .from(schema.campaignLeads)
        .where(eq(schema.campaignLeads.id, campaignLeadId))
        .limit(1)
        .then((r) => r[0]),
      dbh.db
        .select()
        .from(schema.campaigns)
        .where(eq(schema.campaigns.id, campaignId))
        .limit(1)
        .then((r) => r[0]),
    ]);
    if (!cl || cl.status !== 'in_progress' || !campaign) return;
    const settings = resolveCampaignSettings(campaign.settings as CampaignSettings);
    const retry = computeRetrySchedule(cl.attempts, settings, new Date());
    await dbh.db
      .update(schema.campaignLeads)
      .set({
        status: retry.status,
        nextAttemptAt: retry.nextAttemptAt,
        lastOutcome: retry.status === 'completed' ? 'max_attempts' : outcome,
      })
      .where(and(eq(schema.campaignLeads.id, cl.id), eq(schema.campaignLeads.status, 'in_progress')));
  }

  // -------------------------------------------------------------------------
  // /twiml/campaign-answer — the REST-dialed seller picked up
  // -------------------------------------------------------------------------
  app.post('/twiml/campaign-answer', async (req, reply) => {
    const handled = await receiveTwilioWebhook(deps, req, 'campaign-answer', {
      enqueueProcessing: false,
    });
    if (!handled.valid) return reply.code(403).send('invalid signature');

    const callId = handled.merged.call;
    const callSid = handled.params.CallSid;
    const call = callId
      ? (await dbh.db.select().from(schema.calls).where(eq(schema.calls.id, callId)).limit(1))[0]
      : undefined;
    const raw = (call?.raw ?? {}) as Record<string, unknown>;
    const sessionId = raw.dialSessionId as string | undefined;
    if (!call || !sessionId) {
      logger.warn({ callId, callSid }, 'campaign-answer for unknown session call');
      sendTwiml(reply, provider.buildHangupResponse());
      return reply;
    }
    const session = await loadSessionById(dbh.db, sessionId);
    const campaign = session
      ? (
          await dbh.db
            .select()
            .from(schema.campaigns)
            .where(eq(schema.campaigns.id, session.campaignId))
            .limit(1)
        )[0]
      : undefined;
    if (!session || !campaign) {
      sendTwiml(reply, provider.buildHangupResponse());
      return reply;
    }
    const settings = resolveCampaignSettings(campaign.settings as CampaignSettings);
    const q = `call=${call.id}`;

    // AMD (docs/dialers.md §8): a machine answered — configured action, never
    // a bridge. Journaled; lead retry-scheduled; excluded from connected and
    // from the abandonment denominator via raw.amdResult.
    const answeredBy = handled.params.AnsweredBy;
    if (settings.amdEnabled && isMachineAnsweredBy(answeredBy)) {
      const inserted = await journal(call, 'call.amd', `${callSid}:amd:x`, {
        answeredBy,
        action: settings.amdAction,
      });
      if (inserted.length > 0) {
        await dbh.db.execute(sql`
          UPDATE calls SET raw = raw || jsonb_build_object('amdResult', ${answeredBy}::text)
          WHERE id = ${call.id}`);
        await retryScheduleLead(
          call,
          settings.amdAction === 'voicemail_drop' ? 'voicemail_dropped' : 'machine_hangup',
        );
        await recomputeSessionCounters(dbh.db, session.id);
        const fresh = await loadSessionById(dbh.db, session.id);
        if (fresh) await publishSessionEvent(dbh, fresh, { event: 'amd', callId: call.id });
      }
      sendTwiml(
        reply,
        settings.amdAction === 'voicemail_drop'
          ? provider.buildVoicemailDropResponse(settings.amdVoicemailText)
          : provider.buildHangupResponse(),
      );
      return reply;
    }

    // First answer wins: claim under the session row lock so two legs
    // answering in the same instant cannot both bridge.
    const batchId = raw.dialBatchId as string | undefined;
    const claim = await dbh.db.transaction(async (tx) => {
      await tx.execute(sql`SELECT id FROM dial_sessions WHERE id = ${session.id} FOR UPDATE`);
      if (session.state === 'ended') return { won: false as const, reason: 'session_ended' };
      const alreadyMarked = (call.raw as Record<string, unknown>).parallelWinner === true;
      if (alreadyMarked) return { won: true as const, alreadyWon: true };
      if (batchId) {
        const winner = await tx.execute(sql`
          SELECT id FROM calls
          WHERE raw->>'dialBatchId' = ${batchId} AND raw->>'parallelWinner' = 'true'
          LIMIT 1`);
        if (winner.rows.length > 0) return { won: false as const, reason: 'rep_busy' };
      }
      await tx.execute(sql`
        UPDATE calls SET raw = raw || '{"parallelWinner": true}'::jsonb WHERE id = ${call.id}`);
      return { won: true as const, alreadyWon: false };
    });

    if (claim.won) {
      // Cancel the losing legs asynchronously (provider REST never runs on
      // the call-control path). Exactly one job per batch.
      if (batchId && !claim.alreadyWon) {
        await enqueueJob(dbh.db, {
          jobType: 'cancel-sibling-dials',
          payload: { dialBatchId: batchId, winnerCallId: call.id },
          dedupeKey: `cancel-siblings:${batchId}`,
          correlationId: call.correlationId,
        });
      }
      // The rep's browser is a SIP endpoint: ring the address their credential names.
      const { targets } = await clientTargetsFor(dbh, provider, [session.userId]);
      sendTwiml(
        reply,
        provider.buildCampaignBridgeResponse({
          callerId: call.fromNumber,
          client: targets[0] ?? { userId: session.userId, sipUsername: null },
          talkrCallId: call.id,
          dialActionUrl: `${config.PUBLIC_BASE_URL}/twiml/campaign-bridge-complete?${q}`,
          statusCallbackUrl: `${config.PUBLIC_BASE_URL}/webhooks/telnyx/voice-status?${q}&leg=client`,
          recordingStatusCallbackUrl: `${config.PUBLIC_BASE_URL}/webhooks/telnyx/recording-status?${q}`,
        }),
      );
      logger.info({ callId: call.id, sessionId: session.id }, 'parallel winner bridged');
      return reply;
    }

    // ABANDONED (docs/dialers.md §7 C6): a human answered and no rep can
    // bridge. Journaled, counted, retry-scheduled, cap evaluated — and the
    // caller hears an identification message, never silent dead air.
    const inserted = await journal(call, 'call.abandoned', `${callSid}:abandoned:x`, {
      reason: claim.reason,
      batchId: batchId ?? null,
    });
    if (inserted.length > 0) {
      await dbh.db.execute(sql`
        UPDATE calls SET raw = raw || '{"abandoned": true}'::jsonb WHERE id = ${call.id}`);
      await retryScheduleLead(call, 'abandoned');
      await recomputeSessionCounters(dbh.db, session.id);
      const fresh = await loadSessionById(dbh.db, session.id);
      if (fresh) {
        await publishSessionEvent(dbh, fresh, { event: 'abandoned', callId: call.id });
        await evaluateAbandonmentCap(dbh, fresh, settings);
      }
    }
    const org = (
      await dbh.db
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.id, call.orgId))
        .limit(1)
    )[0];
    const orgSettings = (org?.settings ?? {}) as { dialerAbandonMessage?: string };
    const message =
      orgSettings.dialerAbandonMessage ??
      `You were called by ${org?.name ?? 'our office'} at ${call.fromNumber}. We are sorry we missed you and will try to reach you again. Goodbye.`;
    sendTwiml(reply, provider.buildRejectResponse(message));
    return reply;
  });

  // -------------------------------------------------------------------------
  // /twiml/campaign-bridge-complete — winner's <Dial> finished
  // -------------------------------------------------------------------------
  app.post('/twiml/campaign-bridge-complete', async (req, reply) => {
    const handled = await receiveTwilioWebhook(deps, req, 'campaign-bridge-complete', {
      enqueueProcessing: false,
    });
    if (!handled.valid) return reply.code(403).send('invalid signature');
    // The parent (seller) leg's terminal status callback carries the truth;
    // nothing to decide here — close the call politely.
    sendTwiml(reply, provider.buildHangupResponse());
    return reply;
  });
}
