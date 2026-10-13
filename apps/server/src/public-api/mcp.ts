/**
 * MCP server (docs/public-api.md §6): Talkr as MCP tools over the official
 * SDK's streamable HTTP transport, mounted in Fastify at /mcp.
 *
 * - Stateless mode: a fresh McpServer + transport per POST, JSON responses.
 *   No sessions, no server-push stream (GET/DELETE → 405).
 * - Auth: the same API keys as /api/v1 (Bearer tk_live_…); 401 otherwise.
 * - Tools are thin wrappers over public-api/service.ts — the exact same
 *   org-scoped service layer as the REST surface, same scope enforcement
 *   (a missing scope is a tool-level error, not a protocol error).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { writeAudit } from '../services/audit.js';
import { authenticateApiKey, stampLastUsed, type ApiKeyContext, type ApiScope } from './keys.js';
import {
  CallServiceError,
  PublicApiError,
  createLeadWithContact,
  getCallWithTimeline,
  getLeadDetail,
  listCalls,
  listDispositions,
  listLeads,
  lookupPhone,
  startCallForUser,
} from './service.js';

type ToolResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

function jsonResult(value: unknown): ToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function errorResult(message: string): ToolResult {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** Run a tool body with scope enforcement + service-error mapping. */
async function runTool(
  ctx: ApiKeyContext,
  scope: ApiScope,
  body: () => Promise<unknown>,
): Promise<ToolResult> {
  if (!ctx.scopes.has(scope)) {
    return errorResult(`this API key does not have the ${scope} scope`);
  }
  try {
    return jsonResult(await body());
  } catch (err) {
    if (err instanceof PublicApiError || err instanceof CallServiceError) {
      return errorResult(`${err.code}: ${err.message}`);
    }
    throw err;
  }
}

function buildMcpServer(deps: AppDeps, ctx: ApiKeyContext): McpServer {
  const { dbh } = deps;
  const server = new McpServer({ name: 'talkr', version: '1.0.0' });

  server.registerTool(
    'list_calls',
    {
      description:
        'List calls in the organization, newest first. Optional filters: direction, status, ' +
        'user_id, from/to (ISO dates on created_at). Cursor-paginated: pass next_cursor back ' +
        'as cursor to fetch the next page.',
      inputSchema: {
        direction: z.enum(['outbound', 'inbound']).optional().describe('Call direction filter'),
        status: z
          .string()
          .optional()
          .describe(
            'Call status filter: queued|initiated|ringing|in_progress|completed|no_answer|busy|failed|canceled',
          ),
        user_id: z.string().uuid().optional().describe('Only calls handled by this user'),
        from: z.string().optional().describe('ISO date-time lower bound on created_at'),
        to: z.string().optional().describe('ISO date-time upper bound on created_at'),
        limit: z.number().int().min(1).max(100).optional().describe('Page size (default 25)'),
        cursor: z.string().optional().describe('Opaque pagination cursor from a previous page'),
      },
    },
    async (args) =>
      runTool(ctx, 'calls:read', async () => {
        const result = await listCalls(dbh.db, ctx.orgId, {
          direction: args.direction,
          status: args.status,
          userId: args.user_id,
          from: args.from ? new Date(args.from) : undefined,
          to: args.to ? new Date(args.to) : undefined,
          limit: args.limit,
          cursor: args.cursor,
        });
        return { data: result.data, next_cursor: result.nextCursor };
      }),
  );

  server.registerTool(
    'get_call',
    {
      description:
        'Fetch one call by id, including its full canonical event timeline and recording summaries.',
      inputSchema: { call_id: z.string().uuid().describe('The call id') },
    },
    async (args) =>
      runTool(ctx, 'calls:read', async () => {
        const result = await getCallWithTimeline(dbh.db, ctx.orgId, args.call_id);
        if (!result) throw new PublicApiError('not_found', 'call not found');
        return result;
      }),
  );

  server.registerTool(
    'start_call',
    {
      description:
        'Start an outbound click-to-call for a rep. Provide user_id (the rep placing the call) ' +
        'and one of to_number, lead_id, or contact_id. Suppression (DNC) is enforced; the call ' +
        'is audited. The rep answers in their browser dialer.',
      inputSchema: {
        user_id: z.string().uuid().describe('Active user (rep) the call is placed for'),
        to_number: z.string().optional().describe('Destination number (E.164 preferred)'),
        lead_id: z.string().uuid().optional().describe('Lead to call (uses its primary contact)'),
        contact_id: z.string().uuid().optional().describe('Contact to call (primary phone)'),
      },
    },
    async (args) =>
      runTool(ctx, 'calls:write', async () => {
        const call = await startCallForUser(dbh, ctx.orgId, {
          userId: args.user_id,
          toNumber: args.to_number,
          leadId: args.lead_id,
          contactId: args.contact_id,
        });
        return { call };
      }),
  );

  server.registerTool(
    'lookup_phone',
    {
      description:
        'Resolve a phone number to the contact, most recent lead, and property it belongs to ' +
        '(caller recognition). Returns nulls when unknown.',
      inputSchema: { number: z.string().describe('Phone number, any common format') },
    },
    async (args) => runTool(ctx, 'leads:read', () => lookupPhone(dbh.db, ctx.orgId, args.number)),
  );

  server.registerTool(
    'list_leads',
    {
      description:
        'List leads in the organization, newest first. Optional status filter; cursor-paginated.',
      inputSchema: {
        status: z.string().optional().describe('Lead status filter (e.g. new)'),
        limit: z.number().int().min(1).max(100).optional().describe('Page size (default 25)'),
        cursor: z.string().optional().describe('Opaque pagination cursor from a previous page'),
      },
    },
    async (args) =>
      runTool(ctx, 'leads:read', async () => {
        const result = await listLeads(dbh.db, ctx.orgId, {
          status: args.status,
          limit: args.limit,
          cursor: args.cursor,
        });
        return { data: result.data, next_cursor: result.nextCursor };
      }),
  );

  server.registerTool(
    'get_lead',
    {
      description: 'Fetch one lead by id, including its primary contact (with phones) and property.',
      inputSchema: { lead_id: z.string().uuid().describe('The lead id') },
    },
    async (args) =>
      runTool(ctx, 'leads:read', async () => {
        const result = await getLeadDetail(dbh.db, ctx.orgId, args.lead_id);
        if (!result) throw new PublicApiError('not_found', 'lead not found');
        return result;
      }),
  );

  server.registerTool(
    'create_lead',
    {
      description:
        'Create a lead with its contact and primary phone (and optionally a property address). ' +
        'The creation is audited.',
      inputSchema: {
        contact_name: z.string().min(1).describe('Contact display name'),
        phone: z.string().min(3).describe('Primary phone number'),
        source: z.string().optional().describe("Lead source (default 'api')"),
        address: z.string().optional().describe('Property street address'),
        city: z.string().optional(),
        state: z.string().optional(),
        postal_code: z.string().optional(),
      },
    },
    async (args) =>
      runTool(ctx, 'leads:write', () =>
        createLeadWithContact(
          dbh.db,
          ctx.orgId,
          { actorType: 'api_key', actorId: ctx.keyId },
          {
            contactName: args.contact_name,
            phone: args.phone,
            source: args.source,
            address: args.address,
            city: args.city,
            state: args.state,
            postalCode: args.postal_code,
          },
        ),
      ),
  );

  server.registerTool(
    'list_dispositions',
    {
      description:
        'List call dispositions (wrap-up outcomes), newest first. Filter by call_id or ' +
        'from/to (ISO dates on wrap-up time).',
      inputSchema: {
        call_id: z.string().uuid().optional().describe('Only this call'),
        from: z.string().optional().describe('ISO date-time lower bound on wrap-up time'),
        to: z.string().optional().describe('ISO date-time upper bound on wrap-up time'),
        limit: z.number().int().min(1).max(100).optional().describe('Max rows (default 25)'),
      },
    },
    async (args) =>
      runTool(ctx, 'calls:read', () =>
        listDispositions(dbh.db, ctx.orgId, {
          callId: args.call_id,
          from: args.from ? new Date(args.from) : undefined,
          to: args.to ? new Date(args.to) : undefined,
          limit: args.limit,
        }),
      ),
  );

  return server;
}

export function registerMcpRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { dbh } = deps;

  app.post('/mcp', async (req, reply) => {
    const ctx = await authenticateApiKey(dbh.db, req.headers.authorization);
    if (!ctx) {
      return reply.code(401).send({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'valid API key required' },
        id: null,
      });
    }
    stampLastUsed(dbh.db, ctx.keyId);
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'api_key',
      actorId: ctx.keyId,
      action: 'api.request',
      objectType: 'http_request',
      metadata: { method: 'POST', path: '/mcp' },
    });

    // Stateless: fresh server + transport per request; the SDK writes the
    // response to the raw socket, so hand Fastify's reply over to it.
    const server = buildMcpServer(deps, ctx);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    reply.hijack();
    try {
      await server.connect(transport);
      await transport.handleRequest(req.raw, reply.raw, req.body);
    } catch (err) {
      req.log.error({ err }, 'mcp request failed');
      if (!reply.raw.headersSent) {
        reply.raw.writeHead(500, { 'content-type': 'application/json' });
        reply.raw.end(
          JSON.stringify({
            jsonrpc: '2.0',
            error: { code: -32603, message: 'internal error' },
            id: null,
          }),
        );
      } else {
        reply.raw.end();
      }
    } finally {
      reply.raw.on('close', () => {
        void transport.close();
        void server.close();
      });
      if (reply.raw.writableEnded) {
        void transport.close();
        void server.close();
      }
    }
  });

  // Stateless server: no server-push stream, no sessions to delete.
  const methodNotAllowed = async (_req: unknown, reply: import('fastify').FastifyReply) =>
    reply
      .code(405)
      .header('allow', 'POST')
      .send({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'method not allowed; POST JSON-RPC to /mcp' },
        id: null,
      });
  app.get('/mcp', methodNotAllowed);
  app.delete('/mcp', methodNotAllowed);
}
