/**
 * transcribe-recording: recording audio → Deepgram transcript → Claude call
 * notes (docs/transcription.md). Enqueued when a recording completes
 * (services/apply-events.ts) and by POST /v1/recordings/:id/transcribe.
 *
 * At-least-once like every job: a completed transcript short-circuits, and
 * every other state is safe to redo because the row is upserted by
 * recording id.
 */

import { and, eq, gt, lt, sql } from 'drizzle-orm';
import { enqueueJob, publishBusEvent, schema, type DbLike } from '@talkr/db';
import type { JobHandler } from './handlers.js';
import { repTalkRatio, summarizeTranscript, transcribeAudio } from '../services/transcription.js';

type TranscriptPatch = Partial<typeof schema.transcripts.$inferInsert>;

async function upsertTranscript(
  db: DbLike,
  base: { orgId: string; callId: string; recordingId: string },
  patch: TranscriptPatch,
): Promise<void> {
  await db
    .insert(schema.transcripts)
    .values({ ...base, ...patch })
    .onConflictDoUpdate({ target: schema.transcripts.recordingId, set: patch });
}

export const transcribeRecording: JobHandler = async (deps, job) => {
  const { dbh, config, logger } = deps;
  const { recordingId } = job.payload as { recordingId: string };

  const recording = (
    await dbh.db.select().from(schema.recordings).where(eq(schema.recordings.id, recordingId)).limit(1)
  )[0];
  if (!recording) throw new Error(`recording ${recordingId} not found`);
  const call = (
    await dbh.db.select().from(schema.calls).where(eq(schema.calls.id, recording.callId)).limit(1)
  )[0];
  if (!call) throw new Error(`call ${recording.callId} not found`);

  const existing = (
    await dbh.db
      .select({ status: schema.transcripts.status })
      .from(schema.transcripts)
      .where(eq(schema.transcripts.recordingId, recording.id))
      .limit(1)
  )[0];
  if (existing?.status === 'completed') return; // idempotent re-run

  const base = { orgId: recording.orgId, callId: recording.callId, recordingId: recording.id };
  const notify = async (status?: string): Promise<void> => {
    // The call page refreshes on this; a rep sees their own, managers the org.
    await publishBusEvent(dbh.pool, {
      type: 'transcript.updated',
      orgId: recording.orgId,
      userId: call.userId ?? undefined,
      callId: call.id,
      status,
      data: { recordingId: recording.id },
    }).catch(() => undefined);
  };
  const save = async (patch: TranscriptPatch): Promise<void> => {
    await upsertTranscript(dbh.db, base, patch);
    await notify(patch.status);
  };

  if (!config.DEEPGRAM_API_KEY) {
    // Not a failure: this deployment has not opted into transcription. The
    // row exists so the UI can say exactly that instead of "still working".
    await save({ status: 'not_configured', error: null });
    return;
  }
  if (recording.status !== 'completed' || (!recording.providerUrl && !recording.providerRecordingId)) {
    await save({ status: 'failed', error: `recording is ${recording.status}; nothing to transcribe` });
    return;
  }
  if (!deps.fetchRecordingMedia) {
    await save({ status: 'failed', error: 'no media fetcher wired in this process' });
    return;
  }

  await save({ status: 'processing', error: null });

  try {
    // .mp3 where the carrier offers a choice: it is ~10x smaller than .wav for
    // the same speech, and the download, not the ASR, is what eats a 60s
    // serverless tick on a long call. The adapter knows how its carrier serves
    // media — a suffix and account auth for Twilio, an unsigned (and possibly
    // re-minted) pre-signed link for Telnyx (services/recording-media.ts).
    const media = await deps.fetchRecordingMedia(recording, { format: 'mp3' });
    const result = await transcribeAudio({
      apiKey: config.DEEPGRAM_API_KEY,
      audio: media.bytes,
      contentType: media.contentType,
      channels: recording.channels,
      // Mono heuristic (docs/transcription.md §3): the dialed party answers
      // an outbound call, the rep answers an inbound one.
      firstSpeaker: call.direction === 'outbound' ? 'contact' : 'rep',
    });

    const ai: Record<string, unknown> = { rep_talk_ratio: repTalkRatio(result.segments) };
    let summary: string | null = null;
    let aiModel: string | null = null;
    let error: string | null = null;

    if (config.ANTHROPIC_API_KEY && result.segments.length > 0) {
      try {
        const contactName = call.contactId
          ? ((
              await dbh.db
                .select({ name: schema.contacts.displayName })
                .from(schema.contacts)
                .where(eq(schema.contacts.id, call.contactId))
                .limit(1)
            )[0]?.name ?? null)
          : null;
        const notes = await summarizeTranscript({
          apiKey: config.ANTHROPIC_API_KEY,
          model: config.AI_SUMMARY_MODEL,
          transcriptText: result.fullText,
          context: {
            direction: call.direction,
            durationSeconds: result.durationSeconds ?? call.durationSeconds,
            contactName,
          },
        });
        const { summary: text, model, usage, ...fields } = notes;
        summary = text;
        aiModel = model;
        Object.assign(ai, fields);
        logger.info({ recordingId, model, usage }, 'call notes generated');
      } catch (err) {
        // The transcript is still worth keeping; the notes can be re-run by
        // hand from the call page, so this does not fail the job.
        error = `summary failed: ${(err as Error).message}`;
        logger.warn({ recordingId, err: (err as Error).message }, 'call summary failed');
      }
    }

    // Completing the transcript and enqueuing the coaching score are one
    // transaction — the same rule apply-events applies when a recording
    // completes: a finished transcript can never exist without the job that
    // scores it (docs/coaching.md §1). Without a key there is nothing to
    // enqueue; the score endpoint reports "not configured" instead.
    const completed: TranscriptPatch = {
      status: 'completed',
      model: result.model,
      language: result.language,
      durationSeconds: result.durationSeconds,
      segments: result.segments,
      fullText: result.fullText,
      summary,
      ai,
      aiModel,
      error,
      completedAt: new Date(),
    };
    await dbh.db.transaction(async (tx) => {
      await upsertTranscript(tx, base, completed);
      if (config.ANTHROPIC_API_KEY && result.segments.length > 0) {
        await enqueueJob(tx, {
          jobType: 'score-call',
          // `force`: a transcript reaching `completed` is new evidence — on a
          // re-transcribe the standing score was read from text that no
          // longer exists, so it is replaced rather than kept.
          payload: { callId: call.id, force: true },
          // dedupe_key is unique for the life of the jobs table, so a
          // re-transcribe must not reuse a per-call key; a per-minute key
          // still collapses a double completion into one scoring job.
          dedupeKey: `score:${call.id}:m${Math.floor(Date.now() / 60_000)}`,
          correlationId: call.correlationId,
          maxAttempts: 5,
        });
      }
    });
    await notify('completed');
    logger.info(
      { recordingId, callId: call.id, segments: result.segments.length, durationSeconds: result.durationSeconds },
      'recording transcribed',
    );
  } catch (err) {
    await save({ status: 'failed', error: (err as Error).message });
    throw err; // queue backoff + retry; a persistent failure dead-letters
  }
};

/**
 * retry-failed-transcripts: the sweep that keeps a carrier's bad hour from
 * costing a call its transcript for good (docs/transcription.md §1).
 *
 * The media half of this pipeline fails for reasons that heal by themselves —
 * a pre-signed URL that expired before the job ran, media the carrier had not
 * finished writing, a 5xx from object storage. Those rows used to sit at
 * `failed` forever, because the queue job behind them had already
 * dead-lettered and nothing re-read the table. This re-queues them, bounded by
 * `retry_count` so a recording the carrier genuinely lost is tried a few times
 * and then left alone, and scoped to `media fetch`-shaped errors so a Deepgram
 * rejection is not retried in a loop.
 *
 * Idempotent: the re-queue is one UPDATE that both claims the row (by bumping
 * the counter) and moves it back to `queued`, so two workers sweeping at once
 * cannot enqueue the same recording twice.
 */
export const MAX_MEDIA_RETRIES = 5;
/** How far back a failure is still worth retrying. */
const RETRY_WINDOW_MS = 7 * 24 * 60 * 60_000;

export const retryFailedTranscripts: JobHandler = async (deps, job) => {
  const { dbh, logger } = deps;
  const payload = (job.payload ?? {}) as { limit?: number };
  const limit = Math.min(Math.max(payload.limit ?? 25, 1), 200);
  const since = new Date(Date.now() - RETRY_WINDOW_MS);

  const claimed = await dbh.db
    .update(schema.transcripts)
    .set({ status: 'queued', retryCount: sql`${schema.transcripts.retryCount} + 1` })
    .where(
      and(
        eq(schema.transcripts.status, 'failed'),
        // The media-side failures, and only those: the worker writes
        // "media fetch failed: 400" and the adapters' own download errors.
        sql`${schema.transcripts.error} ~* '^(media fetch failed|telnyx recording|twilio recording|no carrier adapter)'`,
        lt(schema.transcripts.retryCount, MAX_MEDIA_RETRIES),
        gt(schema.transcripts.createdAt, since),
        sql`${schema.transcripts.id} in (
          select id from transcripts
          where status = 'failed'
            and error ~* '^(media fetch failed|telnyx recording|twilio recording|no carrier adapter)'
            and retry_count < ${MAX_MEDIA_RETRIES}
            and created_at > ${since.toISOString()}
          order by created_at desc
          limit ${limit}
        )`,
      ),
    )
    .returning({
      id: schema.transcripts.id,
      recordingId: schema.transcripts.recordingId,
      callId: schema.transcripts.callId,
      retryCount: schema.transcripts.retryCount,
    });

  for (const row of claimed) {
    if (!row.recordingId) continue;
    const call = (
      await dbh.db
        .select({ correlationId: schema.calls.correlationId })
        .from(schema.calls)
        .where(eq(schema.calls.id, row.callId))
        .limit(1)
    )[0];
    await enqueueJob(dbh.db, {
      jobType: 'transcribe-recording',
      payload: { recordingId: row.recordingId },
      // `transcribe:<id>` is spent for the life of the jobs table; the attempt
      // number keys each retry to exactly one job.
      dedupeKey: `transcribe:${row.recordingId}:r${row.retryCount}`,
      correlationId: call?.correlationId ?? undefined,
      maxAttempts: 3,
    });
  }
  if (claimed.length > 0) {
    logger.info({ requeued: claimed.length }, 'failed transcripts re-queued after media failures');
  }
};

/**
 * Seed the sweep. Deduped per quarter hour, so every tick and every worker
 * can call it and at most one runs: fast enough that an expired URL is
 * re-minted within minutes, rare enough to cost nothing when nothing failed.
 */
export async function scheduleTranscriptRetrySweep(db: DbLike): Promise<void> {
  const now = new Date();
  const bucket = `${now.toISOString().slice(0, 13)}:${String(Math.floor(now.getUTCMinutes() / 15) * 15).padStart(2, '0')}`;
  await enqueueJob(db, {
    jobType: 'retry-failed-transcripts',
    payload: {},
    dedupeKey: `retry-failed-transcripts:${bucket}`,
  });
}
