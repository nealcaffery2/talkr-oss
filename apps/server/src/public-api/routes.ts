/**
 * Public REST API `/api/v1/*` (docs/public-api.md). Key-authed, org-scoped,
 * scope-gated, rate-limited; consistent {error:{code,message}} envelope and
 * cursor pagination. Thin wrappers over public-api/service.ts.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { writeAudit } from '../services/audit.js';
import { authenticateApiKey, stampLastUsed, type ApiKeyContext, type ApiScope } from './keys.js';
import { FixedWindowRateLimiter, type ApiRateLimiter } from './rate-limit.js';
import {
  CallServiceError,
  PublicApiError,
  createLeadWithContact,
  getCallWithTimeline,
  getLeadDetail,
  listCalls,
  listDispositions,
  listLeads,
  listNumbers,
  listUsers,
  lookupPhone,
  startCallForUser,
} from './service.js';

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyCtx: ApiKeyContext | null;
  }
}

export function errorEnvelope(code: string, message: string) {
  return { error: { code, message } };
}

export function sendError(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send(errorEnvelope(code, message));
}

/** Map service errors to the public envelope; null if not a service error. */
export function mapPublicError(err: unknown, reply: FastifyReply): FastifyReply | null {
  if (err instanceof PublicApiError) {
    return sendError(reply, err.code === 'not_found' ? 404 : 400, err.code, err.message);
  }
  if (err instanceof CallServiceError) {
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
    return sendError(reply, status[err.code], err.code, err.message);
  }
  return null;
}

export function requireScope(scope: ApiScope) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = req.apiKeyCtx;
    if (!ctx) return sendError(reply, 401, 'unauthenticated', 'valid API key required');
    if (!ctx.scopes.has(scope)) {
      req.log.info({ apiKeyId: ctx.keyId, scope }, 'api key missing scope');
      return sendError(reply, 403, 'missing_scope', `this key does not have the ${scope} scope`);
    }
  };
}

const listCallsQuery = z.object({
  direction: z.enum(['outbound', 'inbound']).optional(),
  status: z.string().optional(),
  user_id: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().optional(),
  cursor: z.string().optional(),
});

const createCallBody = z.object({
  user_id: z.string().uuid(),
  to_number: z.string().optional(),
  lead_id: z.string().uuid().optional(),
  contact_id: z.string().uuid().optional(),
});

const listLeadsQuery = z.object({
  status: z.string().optional(),
  limit: z.coerce.number().int().optional(),
  cursor: z.string().optional(),
});

const createLeadBody = z.object({
  contact_name: z.string().min(1),
  phone: z.string().min(3),
  source: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postal_code: z.string().optional(),
  external_item_id: z.string().optional(),
});

const listDispositionsQuery = z.object({
  call_id: z.string().uuid().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().optional(),
});

export interface PublicApiOptions {
  /** Swap point for a shared-store limiter (docs/public-api.md §3). */
  rateLimiter?: ApiRateLimiter;
}

export function registerPublicApiRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  options: PublicApiOptions = {},
): void {
  const { dbh, config } = deps;
  const limiter =
    options.rateLimiter ??
    new FixedWindowRateLimiter(
      config.API_RATE_LIMIT_PER_MINUTE ?? 120,
      config.API_RATE_WINDOW_MS ?? 60_000,
    );

  app.decorateRequest('apiKeyCtx', null);

  // Auth + rate limit + audit for every /api/v1 request. Registered at the
  // root (no encapsulation), so it filters on the URL prefix.
  app.addHook('preHandler', async (req, reply) => {
    if (!req.url.startsWith('/api/v1/')) return;
    const ctx = await authenticateApiKey(dbh.db, req.headers.authorization);
    if (!ctx) return sendError(reply, 401, 'unauthenticated', 'valid API key required');
    req.apiKeyCtx = ctx;

    const decision = limiter.check(ctx.keyId);
    if (!decision.allowed) {
      void reply.header('retry-after', String(decision.retryAfterSeconds));
      return sendError(reply, 429, 'rate_limited', 'rate limit exceeded; retry after the window resets');
    }

    stampLastUsed(dbh.db, ctx.keyId);
    // Key id only — never the key itself; path only — never query strings.
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'api_key',
      actorId: ctx.keyId,
      action: 'api.request',
      objectType: 'http_request',
      metadata: { method: req.method, path: req.url.split('?')[0] },
    });
  });

  // Routes live in an encapsulated scope so the public error envelope applies
  // to /api/v1 without touching the app-wide error handler.
  void app.register(async (scope) => {
    scope.setErrorHandler((err, req, reply) => {
      req.log.error({ err }, 'public api request failed');
      void reply.code(500).send(errorEnvelope('internal_error', 'internal error'));
    });
    registerRoutes(scope, deps);
  });
}

function registerRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { dbh } = deps;

  // -------------------------------------------------------------------------
  // Calls
  // -------------------------------------------------------------------------
  app.get('/api/v1/calls', { preHandler: requireScope('calls:read') }, async (req, reply) => {
    const ctx = req.apiKeyCtx!;
    const parsed = listCallsQuery.safeParse(req.query ?? {});
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', formatZodError(parsed.error));
    try {
      const result = await listCalls(dbh.db, ctx.orgId, {
        direction: parsed.data.direction,
        status: parsed.data.status,
        userId: parsed.data.user_id,
        from: parsed.data.from,
        to: parsed.data.to,
        limit: parsed.data.limit,
        cursor: parsed.data.cursor,
      });
      return { data: result.data, next_cursor: result.nextCursor };
    } catch (err) {
      return mapPublicError(err, reply) ?? raise(err);
    }
  });

  app.get('/api/v1/calls/:id', { preHandler: requireScope('calls:read') }, async (req, reply) => {
    const ctx = req.apiKeyCtx!;
    const { id } = req.params as { id: string };
    if (!isUuid(id)) return sendError(reply, 404, 'not_found', 'call not found');
    const result = await getCallWithTimeline(dbh.db, ctx.orgId, id);
    if (!result) return sendError(reply, 404, 'not_found', 'call not found');
    return result;
  });

  app.post('/api/v1/calls', { preHandler: requireScope('calls:write') }, async (req, reply) => {
    const ctx = req.apiKeyCtx!;
    const parsed = createCallBody.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', formatZodError(parsed.error));
    try {
      const call = await startCallForUser(dbh, ctx.orgId, {
        userId: parsed.data.user_id,
        toNumber: parsed.data.to_number,
        leadId: parsed.data.lead_id,
        contactId: parsed.data.contact_id,
      });
      return reply.code(201).send({ call });
    } catch (err) {
      return mapPublicError(err, reply) ?? raise(err);
    }
  });

  // -------------------------------------------------------------------------
  // Leads + lookup
  // -------------------------------------------------------------------------
  app.get('/api/v1/leads', { preHandler: requireScope('leads:read') }, async (req, reply) => {
    const ctx = req.apiKeyCtx!;
    const parsed = listLeadsQuery.safeParse(req.query ?? {});
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', formatZodError(parsed.error));
    try {
      const result = await listLeads(dbh.db, ctx.orgId, {
        status: parsed.data.status,
        limit: parsed.data.limit,
        cursor: parsed.data.cursor,
      });
      return { data: result.data, next_cursor: result.nextCursor };
    } catch (err) {
      return mapPublicError(err, reply) ?? raise(err);
    }
  });

  app.get('/api/v1/leads/:id', { preHandler: requireScope('leads:read') }, async (req, reply) => {
    const ctx = req.apiKeyCtx!;
    const { id } = req.params as { id: string };
    if (!isUuid(id)) return sendError(reply, 404, 'not_found', 'lead not found');
    const result = await getLeadDetail(dbh.db, ctx.orgId, id);
    if (!result) return sendError(reply, 404, 'not_found', 'lead not found');
    return result;
  });

  app.post('/api/v1/leads', { preHandler: requireScope('leads:write') }, async (req, reply) => {
    const ctx = req.apiKeyCtx!;
    const parsed = createLeadBody.safeParse(req.body ?? {});
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', formatZodError(parsed.error));
    try {
      const result = await createLeadWithContact(
        dbh.db,
        ctx.orgId,
        { actorType: 'api_key', actorId: ctx.keyId },
        {
          contactName: parsed.data.contact_name,
          phone: parsed.data.phone,
          source: parsed.data.source,
          address: parsed.data.address,
          city: parsed.data.city,
          state: parsed.data.state,
          postalCode: parsed.data.postal_code,
          externalItemId: parsed.data.external_item_id,
        },
      );
      return reply.code(201).send(result);
    } catch (err) {
      return mapPublicError(err, reply) ?? raise(err);
    }
  });

  app.get('/api/v1/lookup/phone', { preHandler: requireScope('leads:read') }, async (req, reply) => {
    const ctx = req.apiKeyCtx!;
    const { number } = req.query as { number?: string };
    if (!number) return sendError(reply, 400, 'invalid_request', 'number query parameter required');
    return lookupPhone(dbh.db, ctx.orgId, number);
  });

  // -------------------------------------------------------------------------
  // Dispositions, numbers, users
  // -------------------------------------------------------------------------
  app.get('/api/v1/dispositions', { preHandler: requireScope('calls:read') }, async (req, reply) => {
    const ctx = req.apiKeyCtx!;
    const parsed = listDispositionsQuery.safeParse(req.query ?? {});
    if (!parsed.success) return sendError(reply, 400, 'invalid_request', formatZodError(parsed.error));
    return listDispositions(dbh.db, ctx.orgId, {
      callId: parsed.data.call_id,
      from: parsed.data.from,
      to: parsed.data.to,
      limit: parsed.data.limit,
    });
  });

  app.get('/api/v1/numbers', { preHandler: requireScope('numbers:read') }, async (req) => {
    return listNumbers(dbh.db, req.apiKeyCtx!.orgId);
  });

  app.get('/api/v1/users', { preHandler: requireScope('users:read') }, async (req) => {
    return listUsers(dbh.db, req.apiKeyCtx!.orgId);
  });
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

function formatZodError(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
}

/** Rethrow non-service errors so the global 500 handler owns them. */
function raise(err: unknown): never {
  throw err;
}
