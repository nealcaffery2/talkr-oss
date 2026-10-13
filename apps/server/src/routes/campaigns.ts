/**
 * Campaign + dial-session API (docs/dialers.md §2–§3). Registered after
 * registerV1Routes so the /v1 auth preHandler hook covers these routes.
 * RBAC: campaigns.manage = manager/admin; campaigns.run = rep and up.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Permission } from '@talkr/core';
import type { AppDeps } from '../app.js';
import { hasPermission } from '../auth.js';
import {
  CampaignServiceError,
  attachLeads,
  campaignStats,
  createCampaign,
  detachLeads,
  listCampaigns,
  updateCampaign,
} from '../services/campaigns.js';
import {
  DialSessionError,
  activeSessionForUser,
  sessionDetail,
  sessionNext,
  setSessionState,
  startSession,
} from '../services/dial-sessions.js';
import { CallServiceError } from '../services/calls.js';

function requirePermission(permission: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = req.authCtx;
    if (!ctx) return reply.code(401).send({ error: 'unauthenticated' });
    if (!hasPermission(ctx, permission)) {
      return reply.code(403).send({ error: 'forbidden', permission });
    }
  };
}

const settingsSchema = z
  .object({
    callerIdPhoneNumberId: z.string().uuid().optional(),
    callingWindowStart: z.string().optional(),
    callingWindowEnd: z.string().optional(),
    timezonePolicy: z.enum(['lead', 'org']).optional(),
    maxAttemptsPerDay: z.number().int().optional(),
    maxAttemptsTotal: z.number().int().optional(),
    retryBackoffHours: z.number().int().optional(),
    parallelLines: z.number().int().optional(),
    abandonmentCapPercent: z.number().optional(),
    amdEnabled: z.boolean().optional(),
    amdAction: z.enum(['hangup', 'voicemail_drop']).optional(),
    amdVoicemailText: z.string().max(500).optional(),
  })
  .strict();

const createCampaignSchema = z.object({
  name: z.string().min(1).max(200),
  mode: z.enum(['power', 'progressive', 'parallel', 'predictive']).optional(),
  settings: settingsSchema.optional(),
});

const updateCampaignSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  mode: z.enum(['power', 'progressive', 'parallel', 'predictive']).optional(),
  settings: settingsSchema.optional(),
  status: z.enum(['draft', 'active', 'paused', 'archived']).optional(),
});

const attachSchema = z
  .object({
    lead_ids: z.array(z.string().uuid()).max(5000).optional(),
    filter: z
      .object({
        status: z.string().optional(),
        source: z.string().optional(),
        assigned_user_id: z.string().uuid().optional(),
        limit: z.number().int().positive().optional(),
      })
      .strict()
      .optional(),
  })
  .refine((v) => (v.lead_ids?.length ?? 0) > 0 || v.filter != null, {
    message: 'lead_ids or filter required',
  });

function mapError(err: unknown, reply: FastifyReply): FastifyReply | null {
  if (err instanceof CampaignServiceError) {
    const status: Record<CampaignServiceError['code'], number> = {
      not_found: 404,
      invalid_mode: 400,
      invalid_status: 400,
      name_taken: 409,
      predictive_disabled: 422,
    };
    return reply.code(status[err.code]).send({ error: err.code, message: err.message });
  }
  if (err instanceof DialSessionError) {
    const status: Record<DialSessionError['code'], number> = {
      not_found: 404,
      session_exists: 409,
      campaign_not_active: 422,
      presence_required: 409,
      session_not_active: 409,
      call_in_flight: 409,
      predictive_disabled: 422,
      invalid_state: 409,
    };
    return reply.code(status[err.code]).send({ error: err.code, message: err.message });
  }
  if (err instanceof CallServiceError) {
    // Bubbled from the click-to-call service inside `next`.
    const status: Record<CallServiceError['code'], number> = {
      suppressed: 422,
      invalid_number: 400,
      no_caller_id: 409,
      not_found: 404,
      invalid_disposition: 400,
      lead_mismatch: 400,
      forbidden: 403,
      call_not_active: 409,
      already_bound: 409,
      browser_leg_is_client: 409,
      number_protected: 429,
    };
    return reply.code(status[err.code]).send({ error: err.code, message: err.message });
  }
  return null;
}

function serializeCampaign(c: {
  id: string;
  name: string;
  status: string;
  mode: string;
  settings: unknown;
  createdAt: Date;
}) {
  return {
    id: c.id,
    name: c.name,
    status: c.status,
    mode: c.mode,
    settings: c.settings,
    created_at: c.createdAt,
  };
}

function serializeSession(s: {
  id: string;
  campaignId: string;
  userId: string;
  mode: string;
  state: string;
  startedAt: Date;
  endedAt: Date | null;
  dialedCount: number;
  connectedCount: number;
  abandonedCount: number;
  currentLineLimit: number | null;
}) {
  return {
    id: s.id,
    campaign_id: s.campaignId,
    user_id: s.userId,
    mode: s.mode,
    state: s.state,
    started_at: s.startedAt,
    ended_at: s.endedAt,
    dialed: s.dialedCount,
    connected: s.connectedCount,
    abandoned: s.abandonedCount,
    line_limit: s.currentLineLimit,
  };
}

function serializeCall(call: {
  id: string;
  status: string;
  fromNumber: string;
  toNumber: string;
  leadId: string | null;
  contactId: string | null;
  createdAt: Date;
}) {
  return {
    id: call.id,
    status: call.status,
    from_number: call.fromNumber,
    to_number: call.toNumber,
    lead_id: call.leadId,
    contact_id: call.contactId,
    created_at: call.createdAt,
  };
}

export function registerCampaignRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { dbh, config } = deps;

  // -------------------------------------------------------------------------
  // Campaigns
  // -------------------------------------------------------------------------
  app.get('/v1/campaigns', { preHandler: requirePermission('campaigns.run') }, async (req) => {
    const ctx = req.authCtx!;
    const entries = await listCampaigns(dbh, ctx);
    return {
      campaigns: entries.map((e) => ({
        ...serializeCampaign(e.campaign),
        lead_counts: e.leadCounts,
      })),
    };
  });

  app.post('/v1/campaigns', { preHandler: requirePermission('campaigns.manage') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = createCampaignSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    try {
      const campaign = await createCampaign(dbh, ctx, {
        name: parsed.data.name,
        mode: parsed.data.mode,
        settings: parsed.data.settings,
      });
      return reply.code(201).send({ campaign: serializeCampaign(campaign) });
    } catch (err) {
      return mapError(err, reply) ?? Promise.reject(err);
    }
  });

  app.patch(
    '/v1/campaigns/:id',
    { preHandler: requirePermission('campaigns.manage') },
    async (req, reply) => {
      const ctx = req.authCtx!;
      const { id } = req.params as { id: string };
      const parsed = updateCampaignSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      try {
        const campaign = await updateCampaign(dbh, config, ctx, id, parsed.data);
        return { campaign: serializeCampaign(campaign) };
      } catch (err) {
        return mapError(err, reply) ?? Promise.reject(err);
      }
    },
  );

  app.post(
    '/v1/campaigns/:id/leads',
    { preHandler: requirePermission('campaigns.manage') },
    async (req, reply) => {
      const ctx = req.authCtx!;
      const { id } = req.params as { id: string };
      const parsed = attachSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      try {
        const result = await attachLeads(dbh, ctx, id, {
          leadIds: parsed.data.lead_ids,
          filter: parsed.data.filter
            ? {
                status: parsed.data.filter.status,
                source: parsed.data.filter.source,
                assignedUserId: parsed.data.filter.assigned_user_id,
                limit: parsed.data.filter.limit,
              }
            : undefined,
        });
        return result;
      } catch (err) {
        return mapError(err, reply) ?? Promise.reject(err);
      }
    },
  );

  app.delete(
    '/v1/campaigns/:id/leads',
    { preHandler: requirePermission('campaigns.manage') },
    async (req, reply) => {
      const ctx = req.authCtx!;
      const { id } = req.params as { id: string };
      const parsed = z
        .object({ lead_ids: z.array(z.string().uuid()).min(1).max(5000) })
        .safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      try {
        const detached = await detachLeads(dbh, ctx, id, parsed.data.lead_ids);
        return { detached };
      } catch (err) {
        return mapError(err, reply) ?? Promise.reject(err);
      }
    },
  );

  app.get(
    '/v1/campaigns/:id/stats',
    { preHandler: requirePermission('campaigns.run') },
    async (req, reply) => {
      const ctx = req.authCtx!;
      const { id } = req.params as { id: string };
      try {
        const stats = await campaignStats(dbh, ctx, id);
        return {
          campaign: serializeCampaign(stats.campaign),
          lead_counts: stats.lead_counts,
          calls: stats.calls,
          abandonment: stats.abandonment,
        };
      } catch (err) {
        return mapError(err, reply) ?? Promise.reject(err);
      }
    },
  );

  // -------------------------------------------------------------------------
  // Dial sessions
  // -------------------------------------------------------------------------
  app.post('/v1/dial-sessions', { preHandler: requirePermission('campaigns.run') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = z.object({ campaign_id: z.string().uuid() }).safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    try {
      const session = await startSession(deps, ctx, parsed.data.campaign_id);
      return reply.code(201).send({ session: serializeSession(session) });
    } catch (err) {
      return mapError(err, reply) ?? Promise.reject(err);
    }
  });

  app.get(
    '/v1/dial-sessions/active',
    { preHandler: requirePermission('campaigns.run') },
    async (req) => {
      const ctx = req.authCtx!;
      const session = await activeSessionForUser(dbh, ctx);
      return { session: session ? serializeSession(session) : null };
    },
  );

  app.get(
    '/v1/dial-sessions/:id',
    { preHandler: requirePermission('campaigns.run') },
    async (req, reply) => {
      const ctx = req.authCtx!;
      const { id } = req.params as { id: string };
      try {
        const detail = await sessionDetail(dbh, ctx, id);
        return {
          session: serializeSession(detail.session),
          campaign: detail.campaign ? serializeCampaign(detail.campaign) : null,
          latest_call: detail.latestCall ? serializeCall(detail.latestCall) : null,
          card: detail.card,
        };
      } catch (err) {
        return mapError(err, reply) ?? Promise.reject(err);
      }
    },
  );

  for (const action of ['pause', 'resume', 'end'] as const) {
    app.post(
      `/v1/dial-sessions/:id/${action}`,
      { preHandler: requirePermission('campaigns.run') },
      async (req, reply) => {
        const ctx = req.authCtx!;
        const { id } = req.params as { id: string };
        try {
          const session = await setSessionState(dbh, ctx, id, action);
          return { session: serializeSession(session) };
        } catch (err) {
          return mapError(err, reply) ?? Promise.reject(err);
        }
      },
    );
  }

  /** The heart: pick, re-check suppression, dial, return the lead card. */
  app.post(
    '/v1/dial-sessions/:id/next',
    { preHandler: requirePermission('campaigns.run') },
    async (req, reply) => {
      const ctx = req.authCtx!;
      const { id } = req.params as { id: string };
      try {
        const result = await sessionNext(deps, ctx, id);
        if (result.idle) return { idle: true, reason: result.reason };
        return {
          idle: false,
          batch_id: result.batchId,
          lines: result.lines.map((l) => ({
            call: serializeCall(l.call),
            campaign_lead_id: l.campaignLeadId,
            card: l.card,
          })),
        };
      } catch (err) {
        return mapError(err, reply) ?? Promise.reject(err);
      }
    },
  );
}
