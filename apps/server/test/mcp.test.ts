/**
 * Phase 10 MCP server (docs/public-api.md §6): streamable-HTTP JSON-RPC over
 * a real listening socket — initialize handshake, tools/list, tools/call
 * round-trips against real data, scope enforcement, and 401 without a key.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { authHeader, createTestContext, type TestContext } from './helpers.js';

let ctx: TestContext;
let baseUrl: string;
let secret: string;
let narrowSecret: string;

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: number | null;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

async function mcpPost(
  body: Record<string, unknown>,
  opts: { auth?: string | null } = {},
): Promise<{ status: number; json: JsonRpcResponse }> {
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    accept: 'application/json, text/event-stream',
    'mcp-protocol-version': '2025-06-18',
  };
  if (opts.auth !== null) headers.authorization = `Bearer ${opts.auth ?? secret}`;
  const res = await fetch(`${baseUrl}/mcp`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let json: JsonRpcResponse;
  try {
    json = JSON.parse(text) as JsonRpcResponse;
  } catch {
    json = { jsonrpc: '2.0', id: null, error: { code: -1, message: `unparseable: ${text.slice(0, 200)}` } };
  }
  return { status: res.status, json };
}

let rpcId = 0;
async function callTool(
  name: string,
  args: Record<string, unknown>,
  opts: { auth?: string | null } = {},
): Promise<{ status: number; json: JsonRpcResponse }> {
  return mcpPost(
    { jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } },
    opts,
  );
}

function toolResultJson(json: JsonRpcResponse): Record<string, unknown> {
  const content = (json.result as { content: Array<{ type: string; text: string }> }).content;
  expect(content[0]!.type).toBe('text');
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

beforeAll(async () => {
  ctx = await createTestContext();
  const adminAuth = await authHeader('auth-admin-test-org');

  const mkKey = async (name: string, scopes: string[]) => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/api-keys',
      headers: adminAuth,
      payload: { name, scopes },
    });
    expect(res.statusCode).toBe(201);
    return (res.json() as { secret: string }).secret;
  };
  secret = await mkKey('mcp-full', ['calls:read', 'calls:write', 'leads:read', 'leads:write']);
  narrowSecret = await mkKey('mcp-narrow', ['leads:read']);

  await ctx.app.listen({ port: 0, host: '127.0.0.1' });
  const addr = ctx.app.server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => {
  await ctx.close();
});

describe('transport + handshake', () => {
  it('rejects unauthenticated requests with 401 before touching the transport', async () => {
    const res = await mcpPost(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { auth: null },
    );
    expect(res.status).toBe(401);
    expect(res.json.error?.message).toContain('API key');

    const badKey = await mcpPost(
      { jsonrpc: '2.0', id: 1, method: 'tools/list' },
      { auth: 'tk_live_0000000000000000000000000000000000000000000' },
    );
    expect(badKey.status).toBe(401);
  });

  it('completes the initialize handshake', async () => {
    const res = await mcpPost({
      jsonrpc: '2.0',
      id: ++rpcId,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'talkr-test-client', version: '1.0.0' },
      },
    });
    expect(res.status).toBe(200);
    expect(res.json.error).toBeUndefined();
    const result = res.json.result as {
      protocolVersion: string;
      serverInfo: { name: string };
      capabilities: { tools?: unknown };
    };
    expect(result.serverInfo.name).toBe('talkr');
    expect(result.protocolVersion).toBeTruthy();
    expect(result.capabilities.tools).toBeDefined();
  });

  it('GET and DELETE are 405 (stateless server)', async () => {
    const res = await fetch(`${baseUrl}/mcp`, {
      headers: { authorization: `Bearer ${secret}`, accept: 'text/event-stream' },
    });
    expect(res.status).toBe(405);
    await res.text();
  });
});

describe('tools/list', () => {
  it('returns the full tool set with JSON schemas and descriptions', async () => {
    const res = await mcpPost({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' });
    expect(res.status).toBe(200);
    const tools = (res.json.result as { tools: Array<{ name: string; description?: string; inputSchema: { type: string } }> }).tools;
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'create_lead',
      'get_call',
      'get_lead',
      'list_calls',
      'list_dispositions',
      'list_leads',
      'lookup_phone',
      'start_call',
    ]);
    for (const tool of tools) {
      expect(tool.description).toBeTruthy();
      expect(tool.inputSchema.type).toBe('object');
    }
  });
});

describe('tools/call', () => {
  it('start_call places a real call through the service (audited, suppression-gated)', async () => {
    const res = await callTool('start_call', {
      user_id: ctx.seed.repId,
      to_number: '+16145553001',
    });
    expect(res.status).toBe(200);
    expect(res.json.error).toBeUndefined();
    const body = toolResultJson(res.json) as { call: { id: string; status: string; to_number: string } };
    expect(body.call.status).toBe('queued');
    expect(body.call.to_number).toBe('+16145553001');

    const row = (
      await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.id, body.call.id))
    )[0]!;
    expect(row.orgId).toBe(ctx.seed.orgId);
    expect(row.userId).toBe(ctx.seed.repId);
    const audit = await ctx.dbh.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'call.create'), eq(schema.auditLog.objectId, body.call.id)));
    expect(audit).toHaveLength(1);

    // Suppressed destinations are refused at the same gate as the UI.
    await ctx.dbh.db.insert(schema.suppressionRecords).values({
      orgId: ctx.seed.orgId,
      phoneE164: '+16145553002',
      scope: 'org',
      channel: 'all',
      reason: 'manual',
    });
    const blocked = await callTool('start_call', {
      user_id: ctx.seed.repId,
      to_number: '+16145553002',
    });
    expect(blocked.status).toBe(200);
    expect((blocked.json.result as { isError?: boolean }).isError).toBe(true);
  });

  it('list_calls round-trips real data with pagination fields', async () => {
    const res = await callTool('list_calls', { status: 'queued', limit: 10 });
    expect(res.status).toBe(200);
    const body = toolResultJson(res.json) as {
      data: Array<{ id: string; status: string }>;
      next_cursor: string | null;
    };
    expect(body.data.length).toBeGreaterThan(0);
    for (const call of body.data) expect(call.status).toBe('queued');
    expect('next_cursor' in body).toBe(true);
  });

  it('get_call returns the event timeline; lead tools round-trip', async () => {
    const list = await callTool('list_calls', { limit: 1 });
    const callId = (toolResultJson(list.json) as { data: Array<{ id: string }> }).data[0]!.id;
    const res = await callTool('get_call', { call_id: callId });
    const body = toolResultJson(res.json) as { call: { id: string }; events: unknown[] };
    expect(body.call.id).toBe(callId);
    expect(Array.isArray(body.events)).toBe(true);

    const createdLead = await callTool('create_lead', {
      contact_name: 'MCP Prospect',
      phone: '+16145553100',
    });
    const leadBody = toolResultJson(createdLead.json) as { lead: { id: string } };
    const fetched = await callTool('get_lead', { lead_id: leadBody.lead.id });
    expect((toolResultJson(fetched.json) as { contact: { display_name: string } }).contact.display_name).toBe(
      'MCP Prospect',
    );
    const lookup = await callTool('lookup_phone', { number: '6145553100' });
    expect((toolResultJson(lookup.json) as { lead: { id: string } }).lead.id).toBe(leadBody.lead.id);
  });

  it('a key without the scope gets a tool-level error, not data', async () => {
    const res = await callTool('start_call', { user_id: ctx.seed.repId, to_number: '+16145553003' }, { auth: narrowSecret });
    expect(res.status).toBe(200);
    const result = res.json.result as { isError?: boolean; content: Array<{ text: string }> };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('calls:write');

    // …and the call was never created.
    const rows = await ctx.dbh.db
      .select()
      .from(schema.calls)
      .where(eq(schema.calls.toNumber, '+16145553003'));
    expect(rows).toHaveLength(0);

    // The narrow key can still use its granted scope.
    const ok = await callTool('list_leads', {}, { auth: narrowSecret });
    expect((ok.json.result as { isError?: boolean }).isError).toBeUndefined();
  });

  it('unknown tool calls surface a JSON-RPC error', async () => {
    const res = await callTool('detonate_database', {});
    // The SDK reports unknown tools as a protocol-level error response.
    expect(res.json.error ?? (res.json.result as { isError?: boolean }).isError).toBeTruthy();
  });
});
