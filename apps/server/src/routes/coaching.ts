/**
 * AI call scoring + coaching API (docs/coaching.md).
 *
 *   GET  /v1/calls/:id/score    — the coaching card for one call.
 *   POST /v1/calls/:id/score    — (re)queue scoring; `{ force: true }` re-runs
 *                                 a completed one. Audited.
 *   GET  /v1/coaching/summary   — the per-rep rollup a manager reads.
 *
 * Auth comes from the /v1 preHandler in registerV1Routes; register after it.
 * Visibility mirrors the transcript endpoints exactly, because a score is a
 * derivative of a transcript: `recordings.listen.own` covers the caller's own
 * calls, `recordings.listen.org` any call in the org, and queueing a re-score
 * is `recordings.listen.org` like queueing a re-transcribe. The org rollup is
 * gated on the existing org-wide read, `calls.read.org`.
 */

import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Permission } from '@talkr/core';
import { enqueueJob, schema } from '@talkr/db';
import type { AppDeps } from '../app.js';
import { hasPermission, type AuthContext } from '../auth.js';
import { writeAudit } from '../services/audit.js';
import { coachingSummary } from '../services/coaching.js';
import { orgTimezone, resolveRange, ReportRangeError } from '../services/reports.js';

type CallRow = typeof schema.calls.$inferSelect;
type ScoreRow = typeof schema.callScores.$inferSelect;

const uuid = z.string().uuid();
const scoreRequestSchema = z.object({
  /** Re-run even when a completed score exists (new model, edited transcript). */
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

function canSee(ctx: AuthContext, call: CallRow): boolean {
  return hasPermission(ctx, 'recordings.listen.org') || call.userId === ctx.userId;
}

function serializeScore(s: ScoreRow) {
  return {
    id: s.id,
    call_id: s.callId,
    transcript_id: s.transcriptId,
    status: s.status,
    model: s.model,
    /** 0–100; the model answered 0–10 on the house scale. */
    overall: s.overall,
    /** 0–1, measured from the transcript segments. */
    rep_talk_ratio: s.repTalkRatio != null ? Number(s.repTalkRatio) : null,
    categories: s.categories,
    strengths: s.strengths,
    gaps: s.gaps,
    missed_opportunities: s.missedOpportunities,
    next_action: s.nextAction,
    seller: s.seller,
    error: s.error,
    created_at: s.createdAt,
    completed_at: s.completedAt,
  };
}

export function registerCoachingRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { dbh, config } = deps;

  function deny(reply: FastifyReply, code: 404 | 403) {
    return reply.code(code).send({ error: code === 404 ? 'not_found' : 'forbidden' });
  }

  /** The call, org-scoped and checked for own/org visibility. */
  async function loadCall(ctx: AuthContext, id: string): Promise<CallRow | 404 | 403> {
    if (!uuid.safeParse(id).success) return 404;
    const call = (
      await dbh.db
        .select()
        .from(schema.calls)
        .where(and(eq(schema.calls.id, id), eq(schema.calls.orgId, ctx.orgId)))
        .limit(1)
    )[0];
    if (!call) return 404;
    if (!canSee(ctx, call)) return 403;
    return call;
  }

  // -------------------------------------------------------------------------
  // One call's score
  // -------------------------------------------------------------------------
  app.get(
    '/v1/calls/:id/score',
    { preHandler: requirePermission('recordings.listen.own') },
    async (req, reply) => {
      const ctx = req.authCtx!;
      const { id } = req.params as { id: string };
      const call = await loadCall(ctx, id);
      if (call === 404 || call === 403) return deny(reply, call);

      const score = (
        await dbh.db
          .select()
          .from(schema.callScores)
          .where(eq(schema.callScores.callId, call.id))
          .limit(1)
      )[0];

      return {
        score: score ? serializeScore(score) : null,
        // No key: no row is ever written, and the card says "not configured"
        // rather than pretending the call failed to score.
        configured: Boolean(config.ANTHROPIC_API_KEY),
      };
    },
  );

  app.post(
    '/v1/calls/:id/score',
    { preHandler: requirePermission('recordings.listen.org') },
    async (req, reply) => {
      const ctx = req.authCtx!;
      const { id } = req.params as { id: string };
      const parsed = scoreRequestSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const call = await loadCall(ctx, id);
      if (call === 404 || call === 403) return deny(reply, call);
      const force = parsed.data.force ?? false;

      if (!config.ANTHROPIC_API_KEY) {
        return reply.code(202).send({ status: 'not_configured' });
      }

      // A score needs a finished transcript to read; saying so is more useful
      // than queueing a job that will only write the same sentence.
      const transcript = (
        await dbh.db
          .select({ id: schema.transcripts.id, status: schema.transcripts.status })
          .from(schema.transcripts)
          .where(and(eq(schema.transcripts.callId, call.id), eq(schema.transcripts.status, 'completed')))
          .limit(1)
      )[0];
      if (!transcript) {
        return reply.code(409).send({ error: 'transcript_not_ready' });
      }

      const existing = (
        await dbh.db
          .select({ id: schema.callScores.id, status: schema.callScores.status })
          .from(schema.callScores)
          .where(eq(schema.callScores.callId, call.id))
          .limit(1)
      )[0];
      if (existing?.status === 'completed' && !force) {
        return reply.code(200).send({ status: 'completed' });
      }
      if (existing) {
        // Back to queued: the page should show the wait, not the stale card.
        await dbh.db
          .update(schema.callScores)
          .set({ status: 'queued', error: null })
          .where(eq(schema.callScores.id, existing.id));
      }

      // dedupe_key is unique for the life of the jobs table, so the automatic
      // key cannot be reused; a per-minute key still collapses a double click.
      await enqueueJob(dbh.db, {
        jobType: 'score-call',
        payload: { callId: call.id, force },
        dedupeKey: `score:${call.id}:m${Math.floor(Date.now() / 60_000)}`,
        correlationId: call.correlationId,
        maxAttempts: 5,
      });
      await writeAudit(dbh.db, {
        orgId: ctx.orgId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'call.score_requested',
        objectType: 'call',
        objectId: call.id,
        metadata: { force },
        correlationId: call.correlationId,
      });
      return reply.code(202).send({ status: 'queued' });
    },
  );

  // -------------------------------------------------------------------------
  // The manager rollup
  // -------------------------------------------------------------------------
  app.get(
    '/v1/coaching/summary',
    { preHandler: requirePermission('calls.read.org') },
    async (req, reply) => {
      const ctx = req.authCtx!;
      const { from, to, user_id: userId } = req.query as { from?: string; to?: string; user_id?: string };
      if (userId && !uuid.safeParse(userId).success) {
        return reply.code(400).send({ error: 'invalid_user_id' });
      }
      const timezone = await orgTimezone(dbh.db, ctx.orgId);
      try {
        const range = resolveRange({ from, to }, timezone);
        const summary = await coachingSummary(dbh.db, ctx.orgId, range, { userId });
        return { ...summary, configured: Boolean(config.ANTHROPIC_API_KEY) };
      } catch (err) {
        if (err instanceof ReportRangeError) {
          return reply.code(400).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );
}
