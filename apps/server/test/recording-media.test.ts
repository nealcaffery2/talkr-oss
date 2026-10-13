/**
 * The recording → transcript → score pipeline's media half, end to end through
 * the real app and the real worker (docs/transcription.md).
 *
 * What broke in production and is pinned here: a Telnyx recording's stored URL
 * is a pre-signed link, not a REST resource with a suffix, so the audio
 * endpoint and the transcription job must hand the carrier's own adapter the
 * whole recording row — and a row that failed on media must come back on its
 * own rather than sitting at `failed` once its queue job has dead-lettered.
 */

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { enqueueJob, schema } from '@talkr/db';
import type { RecordingMedia } from '@talkr/core';
import { JobRunner } from '../src/worker/runner.js';
import { HANDLERS } from '../src/worker/handlers.js';
import { scheduleTranscriptRetrySweep, MAX_MEDIA_RETRIES } from '../src/worker/transcribe-handlers.js';
import type { RecordingMediaFetcher, RecordingMediaRow } from '../src/services/recording-media.js';
import { authHeader, createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;
let managerAuth: Record<string, string>;

/** A Telnyx recording as the webhook stores it: pre-signed, already suffixed. */
const PRESIGNED =
  'https://s3.amazonaws.com/telephony-recorder-prod/acct/2026-09-21/leg-179.mp3' +
  '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Expires=600&X-Amz-Signature=abc';
const AUDIO = new Uint8Array([0xff, 0xfb, 0x90, 0x44, 0x00, 0x01]);

/** Records what the route/job asked for, and can be made to fail. */
function recorder() {
  const asked: Array<{ row: RecordingMediaRow; format?: string }> = [];
  const state = { failures: 0, error: 'media fetch failed: 400' };
  const fetcher: RecordingMediaFetcher = async (row, opts) => {
    asked.push({ row, format: opts?.format });
    if (state.failures > 0) {
      state.failures -= 1;
      throw new Error(state.error);
    }
    return { bytes: AUDIO, contentType: 'audio/mpeg', format: 'mp3' } satisfies RecordingMedia;
  };
  return { asked, state, fetcher };
}

const media = recorder();

async function seedRecording(opts: { id?: string } = {}) {
  const [call] = await ctx.dbh.db
    .insert(schema.calls)
    .values({
      orgId: ctx.seed.orgId,
      userId: ctx.seed.repId,
      direction: 'outbound',
      status: 'completed',
      fromNumber: '+15005550006',
      toNumber: '+15005550009',
      durationSeconds: 133,
      correlationId: randomUUID(),
    })
    .returning();
  const [recording] = await ctx.dbh.db
    .insert(schema.recordings)
    .values({
      orgId: ctx.seed.orgId,
      callId: call!.id,
      provider: 'telnyx',
      providerRecordingId: `tx-rec-${opts.id ?? 'media'}`,
      status: 'completed',
      durationSeconds: 133,
      channels: 1,
      providerUrl: PRESIGNED,
    })
    .returning();
  return { call: call!, recording: recording! };
}

beforeAll(async () => {
  // No Deepgram or Anthropic key: this file is about the media half, and the
  // vendor halves have their own tests (test/transcription.test.ts).
  ctx = await createTestContext();
  managerAuth = await authHeader('auth-admin-test-org');
});
afterAll(async () => {
  await ctx.close();
});

describe('GET /v1/recordings/:id/audio', () => {
  it('hands the carrier adapter the whole row, and streams what comes back', async () => {
    const { recording } = await seedRecording({ id: 'audio' });
    const app = (await import('../src/app.js')).buildApp({
      ...ctx.deps,
      recordingMedia: media.fetcher,
    });
    await app.ready();

    const res = await app.inject({
      method: 'GET',
      url: `/v1/recordings/${recording.id}/audio`,
      headers: managerAuth,
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('audio/mpeg');
    expect(res.rawPayload.equals(Buffer.from(AUDIO))).toBe(true);
    // The pre-signed URL is passed through untouched, with the recording id
    // beside it so an expired link can be re-minted.
    const asked = media.asked.at(-1)!;
    expect(asked.row.providerUrl).toBe(PRESIGNED);
    expect(asked.row.providerRecordingId).toBe('tx-rec-audio');
    expect(asked.row.provider).toBe('telnyx');
    expect(asked.format).toBe('mp3');
    await app.close();
  });

  it('answers 503 media_unavailable when the carrier will not serve it', async () => {
    const { recording } = await seedRecording({ id: 'audio-fail' });
    const app = (await import('../src/app.js')).buildApp({
      ...ctx.deps,
      recordingMedia: media.fetcher,
    });
    await app.ready();
    media.state.failures = 1;

    const res = await app.inject({
      method: 'GET',
      url: `/v1/recordings/${recording.id}/audio`,
      headers: managerAuth,
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'media_unavailable' });
    await app.close();
  });
});

describe('retrying a transcript that failed on media', () => {
  it('POST /v1/recordings/:id/transcribe re-queues a failed row and clears its retry budget', async () => {
    const { call, recording } = await seedRecording({ id: 'manual' });
    await ctx.dbh.db.insert(schema.transcripts).values({
      orgId: ctx.seed.orgId,
      callId: call.id,
      recordingId: recording.id,
      status: 'failed',
      error: 'media fetch failed: 400',
      retryCount: 3,
    });

    const res = await ctx.app.inject({
      method: 'POST',
      url: `/v1/recordings/${recording.id}/transcribe`,
      headers: managerAuth,
      payload: {},
    });

    expect(res.statusCode).toBe(202);
    const row = (
      await ctx.dbh.db
        .select()
        .from(schema.transcripts)
        .where(eq(schema.transcripts.recordingId, recording.id))
    )[0]!;
    expect(row.status).toBe('queued');
    expect(row.error).toBeNull();
    expect(row.retryCount).toBe(0);
    const jobs = await ctx.dbh.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.jobType, 'transcribe-recording'));
    expect(jobs.some((j) => (j.payload as { recordingId: string }).recordingId === recording.id)).toBe(true);
  });

  it('the sweep re-queues media failures, bounded, and leaves other failures alone', async () => {
    const failed = await seedRecording({ id: 'sweep' });
    await ctx.dbh.db.insert(schema.transcripts).values({
      orgId: ctx.seed.orgId,
      callId: failed.call.id,
      recordingId: failed.recording.id,
      status: 'failed',
      error: 'media fetch failed: 400',
    });
    // A Deepgram rejection is not a media failure: retrying it just burns key.
    const other = await seedRecording({ id: 'sweep-other' });
    await ctx.dbh.db.insert(schema.transcripts).values({
      orgId: ctx.seed.orgId,
      callId: other.call.id,
      recordingId: other.recording.id,
      status: 'failed',
      error: 'Deepgram 401: bad key',
    });
    // One that has already used its budget.
    const spent = await seedRecording({ id: 'sweep-spent' });
    await ctx.dbh.db.insert(schema.transcripts).values({
      orgId: ctx.seed.orgId,
      callId: spent.call.id,
      recordingId: spent.recording.id,
      status: 'failed',
      error: 'media fetch failed: 400',
      retryCount: MAX_MEDIA_RETRIES,
    });

    await scheduleTranscriptRetrySweep(ctx.dbh.db);
    const runner = new JobRunner(
      { ...ctx.deps, podio: ctx.podio, fetchRecordingMedia: media.fetcher },
      HANDLERS,
      { backoffBaseMs: 0 },
    );
    await runner.runOnce();

    const statusOf = async (recordingId: string) =>
      (
        await ctx.dbh.db
          .select()
          .from(schema.transcripts)
          .where(eq(schema.transcripts.recordingId, recordingId))
      )[0]!;

    const retried = await statusOf(failed.recording.id);
    expect(retried.status).toBe('queued');
    expect(retried.retryCount).toBe(1);
    expect((await statusOf(other.recording.id)).status).toBe('failed');
    expect((await statusOf(spent.recording.id)).retryCount).toBe(MAX_MEDIA_RETRIES);

    // …and the re-queued row has a job of its own, keyed by the attempt so it
    // does not collide with the spent `transcribe:<id>` key.
    const jobs = await ctx.dbh.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.jobType, 'transcribe-recording'));
    expect(
      jobs.some((j) => j.dedupeKey === `transcribe:${failed.recording.id}:r1`),
    ).toBe(true);
  });

  it('a re-queued transcript reaches the carrier again through the worker', async () => {
    const { recording } = await seedRecording({ id: 'worker' });
    await enqueueJob(ctx.dbh.db, {
      jobType: 'transcribe-recording',
      payload: { recordingId: recording.id },
      dedupeKey: `transcribe:${recording.id}:worker`,
    });
    const runner = new JobRunner(
      { ...ctx.deps, podio: ctx.podio, fetchRecordingMedia: media.fetcher },
      HANDLERS,
      { backoffBaseMs: 0 },
    );
    await runner.runOnce();

    // No Deepgram key in this harness, so the row stops at not_configured —
    // what matters is that the job got that far without a media failure.
    const row = (
      await ctx.dbh.db
        .select()
        .from(schema.transcripts)
        .where(eq(schema.transcripts.recordingId, recording.id))
    )[0]!;
    expect(row.status).toBe('not_configured');
  });
});
