/**
 * Telnyx AI Assistants outbound calls for Clozr.
 *
 *   POST /v1/ai-calls — start an AI outbound call (suppression + DNC gated)
 *   GET  /v1/ai-calls/config — read ai_agent org setting (any rep who can place calls)
 */

import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { readAiAgent, type Permission } from '@talkr/core';
import { schema } from '@talkr/db';
import type { AppDeps } from '../app.js';
import { hasPermission } from '../auth.js';
import { AiCallError, createOutboundAiCall } from '../services/ai-calls.js';

function requirePermission(permission: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = req.authCtx;
    if (!ctx) return reply.code(401).send({ error: 'unauthenticated' });
    if (!hasPermission(ctx, permission)) {
      return reply.code(403).send({ error: 'forbidden', permission });
    }
  };
}

const createSchema = z.object({
  to_number: z.string().optional(),
  contact_id: z.string().uuid().optional(),
  from_phone_number_id: z.string().uuid().optional(),
  variables: z.record(z.string()).optional(),
});

function serializeCall(call: typeof schema.calls.$inferSelect) {
  return {
    id: call.id,
    direction: call.direction,
    status: call.status,
    from_number: call.fromNumber,
    to_number: call.toNumber,
    contact_id: call.contactId,
    provider: call.provider,
    provider_call_id: call.providerCallId,
    created_at: call.createdAt,
    raw: call.raw,
  };
}

export function registerAiCallRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { dbh, config } = deps;

  app.get(
    '/v1/ai-calls/config',
    { preHandler: requirePermission('calls.place') },
    async (req) => {
      const ctx = req.authCtx!;
      const org = (
        await dbh.db
          .select({ settings: schema.organizations.settings })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, ctx.orgId))
          .limit(1)
      )[0];
      const agent = readAiAgent(org?.settings);
      return {
        enabled: agent.enabled && Boolean(agent.assistant_id),
        assistant_id: agent.assistant_id || null,
        elevenlabs_voice_id: agent.elevenlabs_voice_id ?? null,
        consent_intro: agent.consent_intro ?? null,
        takeover_e164: agent.takeover_e164 ?? null,
        telnyx_configured: Boolean(config.TELNYX_API_KEY?.trim() && config.TELNYX_TEXML_APP_ID?.trim()),
      };
    },
  );

  app.post(
    '/v1/ai-calls',
    { preHandler: requirePermission('calls.place') },
    async (req, reply) => {
      const ctx = req.authCtx!;
      const parsed = createSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', details: parsed.error.flatten() });
      }
      if (!parsed.data.to_number && !parsed.data.contact_id) {
        return reply.code(400).send({ error: 'to_number_or_contact_required' });
      }
      try {
        const result = await createOutboundAiCall(
          dbh,
          ctx,
          config,
          {
            toNumber: parsed.data.to_number,
            contactId: parsed.data.contact_id,
            fromPhoneNumberId: parsed.data.from_phone_number_id,
            variables: parsed.data.variables,
          },
          { fetchImpl: deps.fetchImpl },
        );
        return {
          call: serializeCall(result.call),
          assistant_id: result.assistant_id,
          provider_call_id: result.provider_call_id,
          takeover_e164: result.takeover_e164,
          human_takeover: result.takeover_e164
            ? { mode: 'dial', to_number: result.takeover_e164 }
            : { mode: 'softphone', hint: 'Open the dialer and join or call the seller if the AI transfers to you.' },
        };
      } catch (err) {
        if (err instanceof AiCallError) {
          const status =
            err.code === 'not_configured' || err.code === 'disabled'
              ? 503
              : err.code === 'suppressed'
                ? 403
                : err.code === 'telnyx_failed'
                  ? 502
                  : 400;
          return reply.code(status).send({ error: err.code, message: err.message });
        }
        throw err;
      }
    },
  );
}
