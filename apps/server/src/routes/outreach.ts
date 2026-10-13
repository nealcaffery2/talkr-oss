/**
 * Outreach Talkr did not carry (docs/inbound-routing.md §10):
 *
 *   POST /v1/outreach        calls.place — one touch
 *   POST /v1/outreach/batch  calls.place — up to 500, each judged on its own
 *
 * A partner (CLOZR) posts the ringless voicemails and emails its reps send so
 * that when the person calls one of the org's numbers back, a number with
 * last-contact routing (or a flow's `last_contact` target) rings the rep who
 * last reached out. Talkr's own outbound calls and texts count without this.
 *
 * Auth is the ordinary /v1 bearer: the partner's per-rep token (iss = the
 * partner issuer, sub = the partner's user id, email) that already signs the
 * rep in for /v1/messages. The org is the token user's org. `user_id` names
 * whose touch it was — the partner's user id (resolved through
 * partner_identities), or a Talkr users.id; absent means the token's user.
 * Recording a touch for someone else takes leads.assign (manager and up).
 * `ref` makes a post idempotent per org.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { OUTREACH_CHANNELS, type Permission } from '@talkr/core';
import type { AppDeps } from '../app.js';
import { hasPermission } from '../auth.js';
import { recordOutreach, type OutreachResult } from '../services/last-contact.js';

export const OUTREACH_BATCH_MAX = 500;

const itemSchema = z
  .object({
    /** E.164 preferred; a 10- or 11-digit US number in any spelling is normalized. */
    phone_e164: z.string().trim().min(7).max(32),
    user_id: z.string().trim().min(1).max(128).optional(),
    channel: z.enum(OUTREACH_CHANNELS),
    occurred_at: z.string().datetime({ offset: true }),
    ref: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .strict();

const batchSchema = z.union([
  z.array(itemSchema).min(1).max(OUTREACH_BATCH_MAX),
  z.object({ events: z.array(itemSchema).min(1).max(OUTREACH_BATCH_MAX) }).strict().transform((v) => v.events),
]);

function requirePermission(permission: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = req.authCtx;
    if (!ctx) return reply.code(401).send({ error: 'unauthenticated' });
    if (!hasPermission(ctx, permission)) return reply.code(403).send({ error: 'forbidden', permission });
  };
}

function serialize(r: OutreachResult) {
  return r.status === 'rejected'
    ? { index: r.index, status: r.status, ref: r.ref, error: r.error, message: r.message }
    : { index: r.index, status: r.status, ref: r.ref, id: r.id };
}

export function registerOutreachRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { dbh } = deps;
  const guard = { preHandler: requirePermission('calls.place') };
  const actor = (req: FastifyRequest) => {
    const ctx = req.authCtx!;
    return { orgId: ctx.orgId, userId: ctx.userId, mayActForOthers: hasPermission(ctx, 'leads.assign') };
  };

  app.post('/v1/outreach', guard, async (req, reply) => {
    const parsed = itemSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const [result] = await recordOutreach(dbh.db, actor(req), [parsed.data]);
    if (result!.status === 'rejected') {
      const code = result!.error === 'forbidden_user' ? 403 : result!.error === 'unknown_user' ? 422 : 400;
      return reply.code(code).send({ error: result!.error, message: result!.message });
    }
    return reply.code(result!.status === 'created' ? 201 : 200).send({ id: result!.id, status: result!.status, ref: result!.ref });
  });

  app.post('/v1/outreach/batch', { ...guard, bodyLimit: 1024 * 1024 }, async (req, reply) => {
    const parsed = batchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', message: `an array of 1-${OUTREACH_BATCH_MAX} events (or {events: [...]})`, issues: parsed.error.issues.slice(0, 20) });
    }
    const results = await recordOutreach(dbh.db, actor(req), parsed.data);
    const count = (s: OutreachResult['status']) => results.filter((r) => r.status === s).length;
    return {
      created: count('created'),
      duplicate: count('duplicate'),
      rejected: count('rejected'),
      results: results.map(serialize),
    };
  });
}
