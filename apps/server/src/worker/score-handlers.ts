/**
 * score-call: a finished transcript → the house coaching rubric, scored by
 * Claude (docs/coaching.md). Enqueued in the same transaction that completes
 * a transcript (worker/transcribe-handlers.ts) and by
 * POST /v1/calls/:id/score.
 *
 * At-least-once like every job: a completed score short-circuits unless the
 * payload forces a re-run, and every other state is safe to redo because the
 * row is upserted by call id — one current score per call, replaced in place.
 */

import { and, desc, eq } from 'drizzle-orm';
import { publishBusEvent, schema, type DbHandle } from '@talkr/db';
import { overallToHundred } from '@talkr/core';
import { coachingModel } from '../config.js';
import type { JobHandler } from './handlers.js';
import { scoreCall } from '../services/call-scoring.js';
import { repTalkRatio, type TranscriptSegment } from '../services/transcription.js';
import { enqueueContactRescore } from './contact-temperature-sweep.js';

type ScorePatch = Partial<typeof schema.callScores.$inferInsert>;

async function upsertScore(
  dbh: DbHandle,
  base: { orgId: string; callId: string },
  patch: ScorePatch,
): Promise<void> {
  await dbh.db
    .insert(schema.callScores)
    .values({ ...base, ...patch })
    .onConflictDoUpdate({ target: schema.callScores.callId, set: patch });
}

/**
 * Whose temperature this call's seller read belongs to: the contact on the
 * call, or the contact behind its lead when the call was only linked that
 * way. Nothing to do when the call names neither.
 */
async function rescoreSellerContact(dbh: DbHandle, call: typeof schema.calls.$inferSelect): Promise<void> {
  let contactId = call.contactId;
  if (!contactId && call.leadId) {
    contactId =
      (
        await dbh.db
          .select({ id: schema.leads.primaryContactId })
          .from(schema.leads)
          .where(eq(schema.leads.id, call.leadId))
          .limit(1)
      )[0]?.id ?? null;
  }
  if (!contactId) return;
  await enqueueContactRescore(dbh.db, call.orgId, [contactId]);
}

export const scoreCallJob: JobHandler = async (deps, job) => {
  const { dbh, config, logger } = deps;
  const { callId, force } = job.payload as { callId: string; force?: boolean };

  const call = (
    await dbh.db.select().from(schema.calls).where(eq(schema.calls.id, callId)).limit(1)
  )[0];
  if (!call) throw new Error(`call ${callId} not found`);

  if (!config.ANTHROPIC_API_KEY) {
    // Not a failure: this deployment has not opted into scoring. No row is
    // written, and GET /v1/calls/:id/score answers `configured: false` — the
    // page says "not configured" rather than "failed".
    logger.info({ callId }, 'call scoring skipped: no ANTHROPIC_API_KEY');
    return;
  }

  const existing = (
    await dbh.db
      .select({ status: schema.callScores.status })
      .from(schema.callScores)
      .where(eq(schema.callScores.callId, call.id))
      .limit(1)
  )[0];
  if (existing?.status === 'completed' && !force) return; // idempotent re-run

  const base = { orgId: call.orgId, callId: call.id };
  const save = async (patch: ScorePatch): Promise<void> => {
    await upsertScore(dbh, base, patch);
    // The call page refreshes on this; a rep sees their own, managers the org.
    await publishBusEvent(dbh.pool, {
      type: 'score.updated',
      orgId: call.orgId,
      userId: call.userId ?? undefined,
      callId: call.id,
      status: patch.status,
      data: {},
    }).catch(() => undefined);
  };

  // The newest completed transcript of the call: what a manager would read.
  const transcript = (
    await dbh.db
      .select()
      .from(schema.transcripts)
      .where(and(eq(schema.transcripts.callId, call.id), eq(schema.transcripts.status, 'completed')))
      .orderBy(desc(schema.transcripts.createdAt))
      .limit(1)
  )[0];
  const segments = (transcript?.segments ?? []) as TranscriptSegment[];
  if (!transcript || segments.length === 0 || !transcript.fullText) {
    await save({
      status: 'failed',
      transcriptId: transcript?.id ?? null,
      error: transcript
        ? 'the transcript has no speech to score'
        : 'this call has no completed transcript yet',
    });
    return; // nothing to retry: a new transcript re-enqueues scoring itself
  }

  const ratio = repTalkRatio(segments);
  await save({
    status: 'running',
    transcriptId: transcript.id,
    repTalkRatio: ratio != null ? ratio.toFixed(3) : null,
    error: null,
  });

  try {
    const [rep, disposition] = await Promise.all([
      call.userId
        ? dbh.db
            .select({ name: schema.users.displayName })
            .from(schema.users)
            .where(eq(schema.users.id, call.userId))
            .limit(1)
        : Promise.resolve([]),
      call.dispositionId
        ? dbh.db
            .select({ name: schema.callDispositions.name })
            .from(schema.callDispositions)
            .where(eq(schema.callDispositions.id, call.dispositionId))
            .limit(1)
        : Promise.resolve([]),
    ]);
    const contactName = call.contactId
      ? ((
          await dbh.db
            .select({ name: schema.contacts.displayName })
            .from(schema.contacts)
            .where(eq(schema.contacts.id, call.contactId))
            .limit(1)
        )[0]?.name ?? null)
      : null;

    const result = await scoreCall({
      apiKey: config.ANTHROPIC_API_KEY,
      model: coachingModel(config),
      transcriptText: transcript.fullText,
      context: {
        direction: call.direction,
        durationSeconds: transcript.durationSeconds ?? call.durationSeconds,
        contactName,
        repName: rep[0]?.name ?? null,
        disposition: disposition[0]?.name ?? null,
        repTalkRatio: ratio,
      },
    });

    await save({
      status: 'completed',
      transcriptId: transcript.id,
      model: result.model,
      // The model answers on the house 0-10 scale; the column is 0-100.
      overall: overallToHundred(result.overall),
      repTalkRatio: ratio != null ? ratio.toFixed(3) : null,
      categories: result.categories,
      strengths: result.strengths,
      gaps: result.gaps,
      missedOpportunities: result.missed_opportunities,
      nextAction: result.next_action,
      seller: result.seller,
      error: null,
      completedAt: new Date(),
    });
    logger.info(
      { callId: call.id, model: result.model, overall: overallToHundred(result.overall), usage: result.usage },
      'call scored',
    );
    // The seller read is an input to contact temperature (docs/contacts.md
    // §4), so the contact is rescored now rather than waiting on the sweep
    // that would otherwise pick it up within twelve hours. Best effort: a
    // temperature that is a few hours stale is not worth failing a score
    // that succeeded, and the sweep is the backstop either way.
    await rescoreSellerContact(dbh, call).catch((e: Error) =>
      logger.warn({ callId: call.id, err: e.message }, 'temperature rescore after scoring failed'),
    );
  } catch (err) {
    await save({ status: 'failed', transcriptId: transcript.id, error: (err as Error).message });
    throw err; // queue backoff + retry; a persistent failure dead-letters
  }
};
