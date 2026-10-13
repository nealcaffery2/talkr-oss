/**
 * Job handlers. Each handler is idempotent — jobs are at-least-once.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { eq } from 'drizzle-orm';
import type { CanonicalEvent, MessagingProvider, VoiceProvider } from '@talkr/core';
import { enqueueJob, schema, type DbHandle, type JobRow } from '@talkr/db';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { applyCanonicalEvent } from '../services/apply-events.js';
import { formatDuration, type PodioClient } from '../services/podio.js';
import { writeAudit } from '../services/audit.js';
import { podioSyncMessageActivity, processSmsWebhook, sendQueuedMessage } from './sms-handlers.js';
import { webhookDeliver, webhookFanout } from './webhook-fanout.js';
import { extractProviderCosts } from './costs.js';
import { workflowFanout, workflowTimeSweep } from './workflow-fanout.js';
import { workflowRun } from './workflow-engine.js';
import { campaignAdvance, cancelSiblingDials, dialerWatch } from './dialer-handlers.js';
import { conferenceDialCustomer } from './conference-handlers.js';
import { transcribeRecording } from './transcribe-handlers.js';
import { scoreCallJob } from './score-handlers.js';
import { contactTemperatureSweep } from './contact-temperature-sweep.js';
import { missedCallText } from '../services/call-flows.js';
import { retryFailedTranscripts } from './transcribe-handlers.js';
import type { RecordingMediaFetcher } from '../services/recording-media.js';

export interface HandlerDeps {
  dbh: DbHandle;
  provider: VoiceProvider & MessagingProvider;
  podio: PodioClient;
  config: Config;
  logger: Logger;
  /**
   * Recording media, by the adapter for the carrier that made the recording
   * (services/recording-media.ts). Injectable so tests avoid the network.
   */
  fetchRecordingMedia?: RecordingMediaFetcher;
  /** Outbound HTTP for the AI agent step and the completion router; tests inject a fake. */
  fetchImpl?: typeof fetch;
}

export type JobHandler = (deps: HandlerDeps, job: JobRow) => Promise<void>;

// ---------------------------------------------------------------------------
// process-webhook: raw delivery → canonical events → state
// ---------------------------------------------------------------------------
export const processWebhook: JobHandler = async (deps, job) => {
  const { dbh, provider, logger } = deps;
  const { webhookEventId } = job.payload as { webhookEventId: string };
  const row = (
    await dbh.db
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.id, webhookEventId))
      .limit(1)
  )[0];
  if (!row) throw new Error(`webhook event ${webhookEventId} not found`);
  if (row.status === 'processed') return; // idempotent re-run

  await dbh.db
    .update(schema.webhookEvents)
    .set({ status: 'processing', attempts: row.attempts + 1 })
    .where(eq(schema.webhookEvents.id, row.id));

  try {
    let events: CanonicalEvent[] = [];
    // 'twilio' is how rows were labelled before the carrier name was recorded.
    if (row.provider === provider.name || row.provider === 'twilio') {
      events = provider.normalizeWebhook(row.endpoint, row.parsed as Record<string, string>);
    }
    for (const event of events) {
      const result = await applyCanonicalEvent(dbh, event, {
        webhookEventId: row.id,
        source: 'webhook',
        logger,
        reconcileDelayMs: deps.config.RECONCILE_DELAY_MS,
      });
      logger.info(
        { webhookEventId: row.id, eventType: event.type, outcome: result.outcome, callId: result.callId },
        'canonical event applied',
      );
    }
    await dbh.db
      .update(schema.webhookEvents)
      .set({ status: 'processed', processedAt: new Date(), lastError: null })
      .where(eq(schema.webhookEvents.id, row.id));
  } catch (err) {
    await dbh.db
      .update(schema.webhookEvents)
      .set({ status: 'failed', lastError: (err as Error).message })
      .where(eq(schema.webhookEvents.id, row.id));
    throw err;
  }
};

// ---------------------------------------------------------------------------
// podio-sync-call-activity: exactly one clean activity comment per call
// ---------------------------------------------------------------------------
export const podioSyncCallActivity: JobHandler = async (deps, job) => {
  const { dbh, podio, logger } = deps;
  const { callId } = job.payload as { callId: string };
  const call = (
    await dbh.db.select().from(schema.calls).where(eq(schema.calls.id, callId)).limit(1)
  )[0];
  if (!call) throw new Error(`call ${callId} not found`);
  if (!call.leadId) return;
  if (call.crmSyncStatus === 'synced') return; // idempotent re-run

  const lead = (
    await dbh.db.select().from(schema.leads).where(eq(schema.leads.id, call.leadId)).limit(1)
  )[0];
  if (!lead?.externalItemId) {
    // Lead isn't CRM-linked; nothing to sync, and that's a valid state.
    await dbh.db
      .update(schema.calls)
      .set({ crmSyncStatus: 'none' })
      .where(eq(schema.calls.id, call.id));
    return;
  }

  const [user, disposition, recording] = await Promise.all([
    call.userId
      ? dbh.db.select().from(schema.users).where(eq(schema.users.id, call.userId)).limit(1)
      : Promise.resolve([]),
    call.dispositionId
      ? dbh.db
          .select()
          .from(schema.callDispositions)
          .where(eq(schema.callDispositions.id, call.dispositionId))
          .limit(1)
      : Promise.resolve([]),
    dbh.db.select().from(schema.recordings).where(eq(schema.recordings.callId, call.id)).limit(1),
  ]);

  const lines = [
    `📞 ${call.direction === 'outbound' ? 'Outbound' : 'Inbound'} call — ${formatDuration(call.durationSeconds)}`,
    `Rep: ${user[0]?.displayName ?? 'Unknown'} · Disposition: ${disposition[0]?.name ?? '—'}`,
  ];
  if (call.followUpAt) lines.push(`Follow-up: ${call.followUpAt.toISOString().slice(0, 10)}`);
  if (call.dispositionNote) lines.push(`Notes: ${call.dispositionNote}`);
  if (recording[0]?.status === 'completed') {
    lines.push(`Recording: ${deps.config.PUBLIC_BASE_URL}/calls/${call.id}/recording`);
  }
  lines.push(`[talkr:${call.correlationId}]`); // loop-prevention marker

  try {
    const { commentId } = await podio.addCommentToItem(lead.externalItemId, lines.join('\n'));
    await dbh.db
      .update(schema.calls)
      .set({
        crmSyncStatus: 'synced',
        raw: { ...(call.raw as Record<string, unknown>), podioCommentId: commentId },
      })
      .where(eq(schema.calls.id, call.id));
    await writeAudit(dbh.db, {
      orgId: call.orgId,
      actorType: 'system',
      action: 'podio.activity_posted',
      objectType: 'call',
      objectId: call.id,
      metadata: { itemId: lead.externalItemId, commentId },
      correlationId: call.correlationId,
    });
  } catch (err) {
    await dbh.db
      .update(schema.calls)
      .set({ crmSyncStatus: 'failed' })
      .where(eq(schema.calls.id, call.id));
    logger.warn({ callId: call.id, err: (err as Error).message }, 'podio sync failed');
    throw err; // let the queue retry / dead-letter
  }
};

// ---------------------------------------------------------------------------
// reconcile-call: provider truth vs our record (docs/telephony-events.md §6)
// ---------------------------------------------------------------------------
export const reconcileCall: JobHandler = async (deps, job) => {
  const { dbh, provider } = deps;
  const { callId } = job.payload as { callId: string };
  const call = (
    await dbh.db.select().from(schema.calls).where(eq(schema.calls.id, callId)).limit(1)
  )[0];
  if (!call) throw new Error(`call ${callId} not found`);

  // Reconcile against the leg that carries the call's truth: pstn if present.
  const legs = await dbh.db
    .select()
    .from(schema.callLegs)
    .where(eq(schema.callLegs.callId, call.id));
  const truthLeg =
    legs.find((l) => l.legRole === 'pstn') ?? legs.find((l) => l.legRole === 'client') ?? legs[0];
  const providerCallId = truthLeg?.providerCallId ?? call.providerCallId;
  if (!providerCallId) return;

  const snapshot = await provider.fetchCall(providerCallId);
  if (!snapshot) {
    await dbh.db.insert(schema.reconciliationMismatches).values({
      orgId: call.orgId,
      objectType: 'call',
      objectId: call.id,
      provider: call.provider,
      providerObjectId: providerCallId,
      field: 'existence',
      internalValue: call.status,
      providerValue: 'not_found',
    });
    return;
  }

  const mismatches: Array<{ field: string; internal: string; provider: string }> = [];
  const providerStatus = normalizeProviderStatus(snapshot.status);
  if (providerStatus && providerStatus !== call.status) {
    mismatches.push({ field: 'status', internal: call.status, provider: providerStatus });
  }
  if (
    snapshot.durationSeconds != null &&
    call.durationSeconds != null &&
    Math.abs(snapshot.durationSeconds - call.durationSeconds) > 2
  ) {
    mismatches.push({
      field: 'duration_seconds',
      internal: String(call.durationSeconds),
      provider: String(snapshot.durationSeconds),
    });
  }
  for (const m of mismatches) {
    await dbh.db.insert(schema.reconciliationMismatches).values({
      orgId: call.orgId,
      objectType: 'call',
      objectId: call.id,
      provider: call.provider,
      providerObjectId: providerCallId,
      field: m.field,
      internalValue: m.internal,
      providerValue: m.provider,
    });
  }

  // Backfill price + missing duration from provider truth (provider is
  // authoritative for billing-class fields).
  const update: Partial<typeof schema.calls.$inferInsert> = {};
  if (snapshot.priceCents != null && call.priceCents == null) {
    update.priceCents = snapshot.priceCents;
    update.priceCurrency = snapshot.priceCurrency ?? 'USD';
  }
  if (snapshot.durationSeconds != null && call.durationSeconds == null) {
    update.durationSeconds = snapshot.durationSeconds;
  }
  if (Object.keys(update).length > 0) {
    await dbh.db.update(schema.calls).set(update).where(eq(schema.calls.id, call.id));
  }

  // A call still non-terminal at reconciliation time but terminal at the
  // provider gets corrected through the normal (audited) event path.
  if (providerStatus && !isTerminalStatus(call.status) && isTerminalStatus(providerStatus)) {
    await applyCanonicalEvent(
      dbh,
      {
        type: `call.${providerStatus === 'in_progress' ? 'answered' : providerStatus}` as never,
        provider: deps.provider.name,
        providerObjectId: providerCallId,
        occurredAt: snapshot.endedAt ?? new Date(),
        data: { durationSeconds: snapshot.durationSeconds },
        raw: snapshot.raw as Record<string, unknown>,
      },
      { source: 'reconciliation', logger: deps.logger, reconcileDelayMs: deps.config.RECONCILE_DELAY_MS },
    );
  }
};

function normalizeProviderStatus(status: string): string | null {
  const map: Record<string, string> = {
    queued: 'queued',
    initiated: 'initiated',
    ringing: 'ringing',
    'in-progress': 'in_progress',
    completed: 'completed',
    busy: 'busy',
    'no-answer': 'no_answer',
    failed: 'failed',
    canceled: 'canceled',
  };
  return map[status] ?? null;
}

function isTerminalStatus(status: string): boolean {
  return ['completed', 'busy', 'no_answer', 'failed', 'canceled'].includes(status);
}

// ---------------------------------------------------------------------------
// mirror-recording: copy provider media into our storage
// ---------------------------------------------------------------------------
export const mirrorRecording: JobHandler = async (deps, job) => {
  const { dbh, config } = deps;
  const { recordingId } = job.payload as { recordingId: string };
  const recording = (
    await dbh.db.select().from(schema.recordings).where(eq(schema.recordings.id, recordingId)).limit(1)
  )[0];
  if (!recording) throw new Error(`recording ${recordingId} not found`);
  if (recording.storagePath) return; // idempotent re-run
  if (!recording.providerUrl && !recording.providerRecordingId) return;
  if (!deps.fetchRecordingMedia) return; // mirroring disabled (no fetcher wired)

  // The carrier decides what it can actually serve: Twilio gives the .wav the
  // mirror prefers, Telnyx gives whichever container the recording was made in.
  const media = await deps.fetchRecordingMedia(recording, { format: 'wav' });
  const bytes = media.bytes;
  const rel = join(recording.orgId, `${recording.id}.${media.format}`);
  const abs = join(config.RECORDINGS_DIR, rel);
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, bytes);
  await dbh.db
    .update(schema.recordings)
    .set({ storagePath: rel })
    .where(eq(schema.recordings.id, recording.id));
};

// ---------------------------------------------------------------------------
// wrapup-timeout: auto-disposition unanswered calls so Podio still gets its
// activity even when the rep never opens the wrap-up screen. (Scheduled by
// Phase 2 UI later; handler exists so the contract is testable now.)
// ---------------------------------------------------------------------------

export const HANDLERS: Record<string, JobHandler> = {
  'process-webhook': processWebhook,
  'podio-sync-call-activity': podioSyncCallActivity,
  'reconcile-call': reconcileCall,
  'mirror-recording': mirrorRecording,
  // SMS (Phase 4 — docs/sms.md)
  'process-sms-webhook': processSmsWebhook,
  'send-message': sendQueuedMessage,
  'podio-sync-message-activity': podioSyncMessageActivity,
  // Outbound webhooks (Phase 10 — docs/public-api.md)
  'webhook-fanout': webhookFanout,
  'webhook-deliver': webhookDeliver,
  // Cost ledger (Phase 6 — docs/reporting.md)
  'extract-provider-costs': extractProviderCosts,
  // Workflows (Phase 7 — docs/workflows.md)
  'workflow-fanout': workflowFanout,
  'workflow-time-sweep': workflowTimeSweep,
  'workflow-run': workflowRun,
  // Dialers (Phase 5 — docs/dialers.md)
  'campaign-advance': campaignAdvance,
  'dialer-watch': dialerWatch,
  'cancel-sibling-dials': cancelSiblingDials,
  // Conference call control (docs/telephony-events.md §9)
  'conference-dial-customer': conferenceDialCustomer,
  // Transcription + AI call notes (docs/transcription.md)
  'transcribe-recording': transcribeRecording,
  'retry-failed-transcripts': retryFailedTranscripts,
  // AI call scoring + coaching (docs/coaching.md)
  'score-call': scoreCallJob,
  // Contacts (docs/contacts.md §4)
  'contact-temperature-sweep': contactTemperatureSweep,
  // Call flows: text back a caller nobody answered
  'missed-call-text': missedCallText,
};

export { enqueueJob };
