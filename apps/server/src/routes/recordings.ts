/**
 * Recordings + transcripts API (docs/transcription.md).
 *
 *   GET  /v1/recordings/:id/audio      — the MP3, proxied from the carrier
 *                                        with our credentials so the browser
 *                                        never holds them (docs/security.md).
 *   GET  /v1/calls/:id/transcript      — transcript + AI notes for a call.
 *   POST /v1/recordings/:id/transcribe — (re)queue transcription.
 *
 * Auth comes from the /v1 preHandler in registerV1Routes; register after it.
 * Visibility: recordings.listen.own covers the caller's own calls,
 * recordings.listen.org any call in the org.
 */

import { and, desc, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Permission, RecordingMedia } from '@talkr/core';
import { enqueueJob, schema, type Db } from '@talkr/db';
import type { AppDeps } from '../app.js';
import { hasPermission, type AuthContext } from '../auth.js';
import { writeAudit } from '../services/audit.js';
import { ownsCall } from '../services/call-owner.js';
import type { TranscriptSegment } from '../services/transcription.js';
import { makeRecordingMediaFetcher, type RecordingMediaFetcher } from '../services/recording-media.js';

type RecordingRow = typeof schema.recordings.$inferSelect;
type CallRow = typeof schema.calls.$inferSelect;
type TranscriptRow = typeof schema.transcripts.$inferSelect;

const uuid = z.string().uuid();
const transcribeSchema = z.object({
  /** Re-run even when a completed transcript exists (new model, bad labels). */
  force: z.boolean().optional(),
});

function requirePermission(permission: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = req.authCtx;
    if (!ctx) return reply.code(401).send({ error: 'unauthenticated' });
    if (!hasPermission(ctx, permission)) {
      req.log.info({ userId: ctx.userId, permission }, 'permission denied');
      return reply.code(403).send({ error: 'forbidden', permission });
    }
  };
}

async function canSee(db: Db, ctx: AuthContext, call: CallRow): Promise<boolean> {
  return hasPermission(ctx, 'recordings.listen.org') || (await ownsCall(db, call, ctx.userId));
}

/**
 * A conference call can leave more than one recording; the longest completed
 * one is the conversation, anything else a fragment. Falls back to whatever
 * is newest so the page can say "still processing" instead of "none".
 */
function pickRecording(rows: RecordingRow[]): RecordingRow | null {
  const completed = rows
    .filter((r) => r.status === 'completed')
    .sort((a, b) => (b.durationSeconds ?? 0) - (a.durationSeconds ?? 0));
  if (completed[0]) return completed[0];
  return [...rows].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0] ?? null;
}

function serializeRecording(r: RecordingRow) {
  return { id: r.id, status: r.status, duration_seconds: r.durationSeconds, channels: r.channels };
}

function serializeTranscript(t: TranscriptRow) {
  return {
    id: t.id,
    recording_id: t.recordingId,
    status: t.status,
    provider: t.provider,
    model: t.model,
    language: t.language,
    duration_seconds: t.durationSeconds,
    segments: t.segments as TranscriptSegment[],
    full_text: t.fullText,
    summary: t.summary,
    ai: t.ai as Record<string, unknown>,
    ai_model: t.aiModel,
    error: t.error,
    created_at: t.createdAt,
    completed_at: t.completedAt,
  };
}

type Loaded =
  | { ok: true; recording: RecordingRow; call: CallRow }
  | { ok: false; code: 404 | 403 };

export function registerRecordingsRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  opts: { fetchRecordingMedia?: RecordingMediaFetcher } = {},
): void {
  const { dbh, config } = deps;
  // The same fetcher the transcription job uses: carrier media needs the
  // carrier's own auth (and, on Telnyx, a link that has not expired), and the
  // API process is what proxies it to the browser (docs/security.md).
  const fetchRecordingMedia =
    opts.fetchRecordingMedia ?? makeRecordingMediaFetcher(config, deps.provider, dbh);

  /** The recording and its call, org-scoped and checked for own/org visibility. */
  async function loadRecording(ctx: AuthContext, id: string): Promise<Loaded> {
    if (!uuid.safeParse(id).success) return { ok: false, code: 404 };
    const row = (
      await dbh.db
        .select({ recording: schema.recordings, call: schema.calls })
        .from(schema.recordings)
        .innerJoin(schema.calls, eq(schema.calls.id, schema.recordings.callId))
        .where(and(eq(schema.recordings.id, id), eq(schema.recordings.orgId, ctx.orgId)))
        .limit(1)
    )[0];
    if (!row) return { ok: false, code: 404 };
    if (!(await canSee(dbh.db, ctx, row.call))) return { ok: false, code: 403 };
    return { ok: true, recording: row.recording, call: row.call };
  }

  function deny(reply: FastifyReply, code: 404 | 403) {
    return reply.code(code).send({ error: code === 404 ? 'not_found' : 'forbidden' });
  }

  // -------------------------------------------------------------------------
  // Audio
  // -------------------------------------------------------------------------
  app.get(
    '/v1/recordings/:id/audio',
    { preHandler: requirePermission('recordings.listen.own') },
    async (req, reply) => {
      const ctx = req.authCtx!;
      const { id } = req.params as { id: string };
      const loaded = await loadRecording(ctx, id);
      if (!loaded.ok) return deny(reply, loaded.code);
      const { recording, call } = loaded;
      // A recording with neither a URL nor a carrier id has no media to serve;
      // one with either can be fetched, because an expired link is re-minted
      // from the id (services/recording-media.ts).
      if (recording.status !== 'completed' || (!recording.providerUrl && !recording.providerRecordingId)) {
        return reply.code(404).send({ error: 'not_found' });
      }

      let media: RecordingMedia;
      try {
        // .mp3 is ~10x smaller than the .wav the mirror job pulls; the adapter
        // falls back to whatever container its carrier actually holds.
        media = await fetchRecordingMedia(recording, { format: 'mp3' });
      } catch (err) {
        // The carrier owns the bytes; when it is down or has purged the file
        // that is its problem to report, not a 500 of ours.
        req.log.warn({ recordingId: recording.id, err: (err as Error).message }, 'recording media fetch failed');
        return reply.code(503).send({ error: 'media_unavailable' });
      }
      const bytes = media.bytes;

      // Who listened to what: call recordings are regulated data.
      await writeAudit(dbh.db, {
        orgId: ctx.orgId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'recording.played',
        objectType: 'recording',
        objectId: recording.id,
        correlationId: call.correlationId,
      });

      return reply
        .header('content-type', media.contentType)
        .header('content-length', String(bytes.byteLength))
        .header('cache-control', 'private, max-age=3600')
        .header('content-disposition', `inline; filename="call-${call.id}.${media.format}"`)
        .header('x-content-type-options', 'nosniff')
        .send(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength));
    },
  );

  // -------------------------------------------------------------------------
  // Transcript
  // -------------------------------------------------------------------------
  app.get(
    '/v1/calls/:id/transcript',
    { preHandler: requirePermission('recordings.listen.own') },
    async (req, reply) => {
      const ctx = req.authCtx!;
      const { id } = req.params as { id: string };
      if (!uuid.safeParse(id).success) return deny(reply, 404);
      const call = (
        await dbh.db
          .select()
          .from(schema.calls)
          .where(and(eq(schema.calls.id, id), eq(schema.calls.orgId, ctx.orgId)))
          .limit(1)
      )[0];
      if (!call) return deny(reply, 404);
      if (!(await canSee(dbh.db, ctx, call))) return deny(reply, 403);

      const [recs, transcripts, disposition] = await Promise.all([
        dbh.db.select().from(schema.recordings).where(eq(schema.recordings.callId, call.id)),
        dbh.db
          .select()
          .from(schema.transcripts)
          .where(eq(schema.transcripts.callId, call.id))
          .orderBy(desc(schema.transcripts.createdAt)),
        call.dispositionId
          ? dbh.db
              .select({ name: schema.callDispositions.name })
              .from(schema.callDispositions)
              .where(eq(schema.callDispositions.id, call.dispositionId))
              .limit(1)
          : Promise.resolve([]),
      ]);
      const recording = pickRecording(recs);
      const transcript =
        (recording ? transcripts.find((t) => t.recordingId === recording.id) : undefined) ??
        transcripts[0] ??
        null;

      return {
        transcript: transcript ? serializeTranscript(transcript) : null,
        recording: recording ? serializeRecording(recording) : null,
        // The wrap-up the rep wrote, beside what the AI heard.
        call: {
          disposition: disposition[0]?.name ?? null,
          disposition_note: call.dispositionNote,
          follow_up_at: call.followUpAt,
        },
        configured: Boolean(config.DEEPGRAM_API_KEY),
        summary_configured: Boolean(config.ANTHROPIC_API_KEY),
      };
    },
  );

  app.post(
    '/v1/recordings/:id/transcribe',
    { preHandler: requirePermission('recordings.listen.org') },
    async (req, reply) => {
      const ctx = req.authCtx!;
      const { id } = req.params as { id: string };
      const parsed = transcribeSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const loaded = await loadRecording(ctx, id);
      if (!loaded.ok) return deny(reply, loaded.code);
      const { recording, call } = loaded;
      if (recording.status !== 'completed') {
        return reply.code(409).send({ error: 'recording_not_ready', status: recording.status });
      }

      const existing = (
        await dbh.db
          .select({ id: schema.transcripts.id, status: schema.transcripts.status })
          .from(schema.transcripts)
          .where(eq(schema.transcripts.recordingId, recording.id))
          .limit(1)
      )[0];
      if (existing?.status === 'completed' && !parsed.data.force) {
        return reply.code(200).send({ status: 'completed' });
      }
      if (existing) {
        // Back to queued: the handler skips completed rows, and the page
        // should show the wait rather than the stale result. A person asking
        // for this also resets the automatic media-retry budget — they may
        // well be asking *because* the carrier has just been fixed.
        await dbh.db
          .update(schema.transcripts)
          .set({ status: 'queued', error: null, retryCount: 0 })
          .where(eq(schema.transcripts.id, existing.id));
      }

      // dedupe_key is unique for the life of the jobs table, so the automatic
      // `transcribe:<id>` key cannot be reused; a per-minute key still
      // collapses a double click into one job.
      await enqueueJob(dbh.db, {
        jobType: 'transcribe-recording',
        payload: { recordingId: recording.id },
        dedupeKey: `transcribe:${recording.id}:m${Math.floor(Date.now() / 60_000)}`,
        correlationId: call.correlationId,
        maxAttempts: 5,
      });
      await writeAudit(dbh.db, {
        orgId: ctx.orgId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'transcript.requested',
        objectType: 'recording',
        objectId: recording.id,
        metadata: { force: parsed.data.force ?? false },
        correlationId: call.correlationId,
      });
      return reply.code(202).send({ status: config.DEEPGRAM_API_KEY ? 'queued' : 'not_configured' });
    },
  );
}
