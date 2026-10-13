/**
 * Phase 10 public API (docs/public-api.md): key lifecycle (hash-only storage,
 * shown-once secret, revocation), scope enforcement, per-key fixed-window
 * rate limiting, org isolation, stable cursor pagination, and click-to-call
 * through the existing service (suppression + audit).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, desc, eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app.js';
import { hashApiKey, resetLastUsedThrottle } from '../src/public-api/keys.js';
import { seedDemoOrg, type SeedResult } from '../src/seed.js';
import { authHeader, createTestContext, testConfig, type TestContext } from './helpers.js';

let ctx: TestContext;
let adminAuth: Record<string, string>;
let repAuth: Record<string, string>;
let otherOrgAdminAuth: Record<string, string>;
let otherSeed: SeedResult;

/** Mint a key through the real admin endpoint; returns the shown-once secret. */
async function createKey(
  name: string,
  scopes: string[],
  auth: Record<string, string> = adminAuth,
): Promise<{ id: string; secret: string; keyPrefix: string }> {
  const res = await ctx.app.inject({
    method: 'POST',
    url: '/v1/admin/api-keys',
    headers: auth,
    payload: { name, scopes },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json() as { api_key: { id: string; key_prefix: string }; secret: string };
  return { id: body.api_key.id, secret: body.secret, keyPrefix: body.api_key.key_prefix };
}

function bearer(secret: string): Record<string, string> {
  return { authorization: `Bearer ${secret}` };
}

beforeAll(async () => {
  ctx = await createTestContext();
  adminAuth = await authHeader('auth-admin-test-org');
  repAuth = await authHeader('auth-rep-test-org');
  otherSeed = await seedDemoOrg(ctx.dbh.db, {
    slug: 'other-org',
    phoneE164: '+15005550777',
    contactPhone: '+15005550888',
  });
  otherOrgAdminAuth = await authHeader('auth-admin-other-org');
  resetLastUsedThrottle();
});
afterAll(async () => {
  await ctx.close();
});

describe('API key lifecycle', () => {
  it('mints a tk_live_ key, returns the secret exactly once, stores only the hash', async () => {
    const { id, secret, keyPrefix } = await createKey('lifecycle-key', ['users:read']);
    expect(secret).toMatch(/^tk_live_[A-Za-z0-9]{43}$/);
    expect(keyPrefix).toBe(secret.slice('tk_live_'.length, 'tk_live_'.length + 8));

    const row = (
      await ctx.dbh.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id))
    )[0]!;
    expect(row.keyHash).toBe(hashApiKey(secret));
    expect(row.keyHash).not.toContain(secret);
    // The secret appears nowhere in the row.
    expect(JSON.stringify(row)).not.toContain(secret);

    // Listing never exposes hash or secret.
    const list = await ctx.app.inject({ method: 'GET', url: '/v1/admin/api-keys', headers: adminAuth });
    expect(list.statusCode).toBe(200);
    const listBody = list.body;
    expect(listBody).not.toContain(secret);
    expect(listBody).not.toContain(row.keyHash);

    // Creation is audited with the key id, never the key.
    const audit = await ctx.dbh.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'api_key.create'), eq(schema.auditLog.objectId, id)));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit[0]!.metadata)).not.toContain(secret);
  });

  it('rejects unknown scopes at creation', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/api-keys',
      headers: adminAuth,
      payload: { name: 'bad', scopes: ['calls:read', 'root:everything'] },
    });
    expect(res.statusCode).toBe(400);
    expect((res.json() as { unknown: string[] }).unknown).toEqual(['root:everything']);
  });

  it('key management requires admin RBAC (rep gets 403)', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/admin/api-keys',
      headers: repAuth,
      payload: { name: 'nope', scopes: ['calls:read'] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a valid key authenticates; garbage and wrong keys get 401', async () => {
    const { secret } = await createKey('auth-key', ['users:read']);
    const ok = await ctx.app.inject({ method: 'GET', url: '/api/v1/users', headers: bearer(secret) });
    expect(ok.statusCode).toBe(200);

    for (const bad of [
      undefined,
      'Bearer nonsense',
      'Bearer tk_live_0000000000000000000000000000000000000000000',
      // Flip the last char deterministically — appending a fixed 'X' collides
      // with the real key whenever the random secret happens to end in 'X'.
      `Bearer ${secret.slice(0, -1)}${secret.endsWith('X') ? 'Y' : 'X'}`,
    ]) {
      const res = await ctx.app.inject({
        method: 'GET',
        url: '/api/v1/users',
        headers: bad ? { authorization: bad } : {},
      });
      expect(res.statusCode).toBe(401);
      expect((res.json() as { error: { code: string } }).error.code).toBe('unauthenticated');
    }
  });

  it('a revoked key gets 401 immediately', async () => {
    const { id, secret } = await createKey('revoke-key', ['users:read']);
    expect(
      (await ctx.app.inject({ method: 'GET', url: '/api/v1/users', headers: bearer(secret) })).statusCode,
    ).toBe(200);
    const revoke = await ctx.app.inject({
      method: 'POST',
      url: `/v1/admin/api-keys/${id}/revoke`,
      headers: adminAuth,
    });
    expect(revoke.statusCode).toBe(200);
    const after = await ctx.app.inject({ method: 'GET', url: '/api/v1/users', headers: bearer(secret) });
    expect(after.statusCode).toBe(401);

    const audit = await ctx.dbh.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'api_key.revoke'), eq(schema.auditLog.objectId, id)));
    expect(audit).toHaveLength(1);
  });

  it('a key without the required scope gets 403 missing_scope', async () => {
    const { secret } = await createKey('narrow-key', ['users:read']);
    const res = await ctx.app.inject({ method: 'GET', url: '/api/v1/calls', headers: bearer(secret) });
    expect(res.statusCode).toBe(403);
    const body = res.json() as { error: { code: string; message: string } };
    expect(body.error.code).toBe('missing_scope');
    expect(body.error.message).toContain('calls:read');
  });

  it('every authenticated request is audit-logged with the key id, never the key', async () => {
    const { id, secret } = await createKey('audit-key', ['users:read']);
    await ctx.app.inject({ method: 'GET', url: '/api/v1/users', headers: bearer(secret) });
    const rows = await ctx.dbh.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'api.request'), eq(schema.auditLog.actorId, id)));
    expect(rows.length).toBeGreaterThan(0);
    expect(rows[0]!.actorType).toBe('api_key');
    expect((rows[0]!.metadata as { path: string }).path).toBe('/api/v1/users');
    expect(JSON.stringify(rows)).not.toContain(secret);
  });

  it('stamps last_used_at (throttled)', async () => {
    resetLastUsedThrottle();
    const { id, secret } = await createKey('stamp-key', ['users:read']);
    await ctx.app.inject({ method: 'GET', url: '/api/v1/users', headers: bearer(secret) });
    // The stamp is fire-and-forget; give it a moment.
    let row: { lastUsedAt: Date | null } | undefined;
    for (let i = 0; i < 20; i++) {
      row = (await ctx.dbh.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id)))[0];
      if (row?.lastUsedAt) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(row?.lastUsedAt).not.toBeNull();
  });
});

describe('rate limiting', () => {
  let rlApp: FastifyInstance;
  afterAll(async () => {
    await rlApp.close();
  });

  it('429s over the fixed window with Retry-After, then recovers', async () => {
    rlApp = buildApp({
      ...ctx.deps,
      config: testConfig({ API_RATE_LIMIT_PER_MINUTE: 3, API_RATE_WINDOW_MS: 2000 }),
    });
    const { secret } = await createKey('rl-key', ['users:read']);
    for (let i = 0; i < 3; i++) {
      const res = await rlApp.inject({ method: 'GET', url: '/api/v1/users', headers: bearer(secret) });
      expect(res.statusCode).toBe(200);
    }
    const limited = await rlApp.inject({ method: 'GET', url: '/api/v1/users', headers: bearer(secret) });
    expect(limited.statusCode).toBe(429);
    expect((limited.json() as { error: { code: string } }).error.code).toBe('rate_limited');
    expect(Number(limited.headers['retry-after'])).toBeGreaterThanOrEqual(1);

    // Window resets → requests flow again.
    await new Promise((r) => setTimeout(r, 2100));
    const recovered = await rlApp.inject({ method: 'GET', url: '/api/v1/users', headers: bearer(secret) });
    expect(recovered.statusCode).toBe(200);
  });
});

describe('org isolation', () => {
  it('key A cannot see or fetch org B calls', async () => {
    const { secret: secretA } = await createKey('iso-a', ['calls:read', 'calls:write']);
    const { secret: secretB } = await createKey('iso-b', ['calls:read'], otherOrgAdminAuth);

    // Org A rep places a call through the public API.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/calls',
      headers: bearer(secretA),
      payload: { user_id: ctx.seed.repId, to_number: '+16145559001' },
    });
    expect(created.statusCode).toBe(201);
    const callId = (created.json() as { call: { id: string } }).call.id;

    // Key B (org B) sees none of org A's calls.
    const listB = await ctx.app.inject({ method: 'GET', url: '/api/v1/calls', headers: bearer(secretB) });
    expect(listB.statusCode).toBe(200);
    const idsB = (listB.json() as { data: Array<{ id: string }> }).data.map((c) => c.id);
    expect(idsB).not.toContain(callId);

    const getB = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/calls/${callId}`,
      headers: bearer(secretB),
    });
    expect(getB.statusCode).toBe(404);

    // Key A sees its own call, with the event timeline shape.
    const getA = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/calls/${callId}`,
      headers: bearer(secretA),
    });
    expect(getA.statusCode).toBe(200);
    const bodyA = getA.json() as { call: { id: string }; events: unknown[]; recordings: unknown[] };
    expect(bodyA.call.id).toBe(callId);
    expect(Array.isArray(bodyA.events)).toBe(true);

    // Admin surfaces are org-scoped too: org B admin cannot revoke org A keys.
    const keysA = await ctx.app.inject({ method: 'GET', url: '/v1/admin/api-keys', headers: adminAuth });
    const keyAId = (keysA.json() as { api_keys: Array<{ id: string; name: string }> }).api_keys.find(
      (k) => k.name === 'iso-a',
    )!.id;
    const crossRevoke = await ctx.app.inject({
      method: 'POST',
      url: `/v1/admin/api-keys/${keyAId}/revoke`,
      headers: otherOrgAdminAuth,
    });
    expect(crossRevoke.statusCode).toBe(404);
  });
});

describe('cursor pagination', () => {
  it('walks all calls in stable pages with no duplicates or gaps', async () => {
    const { secret } = await createKey('page-key', ['calls:read']);
    // Deterministic set: distinct created_at values, one org.
    const base = Date.now() - 60 * 60_000;
    const inserted: string[] = [];
    for (let i = 0; i < 5; i++) {
      const row = (
        await ctx.dbh.db
          .insert(schema.calls)
          .values({
            orgId: ctx.seed.orgId,
            direction: 'outbound',
            status: 'completed',
            userId: ctx.seed.repId,
            fromNumber: '+15005550006',
            toNumber: `+1614555${String(7000 + i)}`,
            createdAt: new Date(base + i * 1000),
          })
          .returning({ id: schema.calls.id })
      )[0]!;
      inserted.push(row.id);
    }

    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url = `/api/v1/calls?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const res = await ctx.app.inject({ method: 'GET', url, headers: bearer(secret) });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { data: Array<{ id: string; created_at: string }>; next_cursor: string | null };
      expect(body.data.length).toBeLessThanOrEqual(2);
      seen.push(...body.data.map((c) => c.id));
      cursor = body.next_cursor;
      pages += 1;
      expect(pages).toBeLessThan(30); // sanity: terminates
    } while (cursor);

    // No duplicates, and every inserted call appears exactly once, in DESC order.
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of inserted) expect(seen).toContain(id);
    const all = await ctx.dbh.db
      .select({ id: schema.calls.id })
      .from(schema.calls)
      .where(eq(schema.calls.orgId, ctx.seed.orgId))
      .orderBy(desc(schema.calls.createdAt), desc(schema.calls.id));
    expect(seen).toEqual(all.map((r) => r.id));

    // Malformed cursors are a 400, not a 500.
    const bad = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/calls?cursor=%%%garbage',
      headers: bearer(secret),
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('click-to-call through the existing service', () => {
  it('enforces suppression and writes the call.create audit', async () => {
    const { id: keyId, secret } = await createKey('c2c-key', ['calls:write']);
    // DNC the target, org-scope.
    await ctx.dbh.db.insert(schema.suppressionRecords).values({
      orgId: ctx.seed.orgId,
      phoneE164: '+16145558877',
      scope: 'org',
      channel: 'all',
      reason: 'manual',
    });
    const blocked = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/calls',
      headers: bearer(secret),
      payload: { user_id: ctx.seed.repId, to_number: '+16145558877' },
    });
    expect(blocked.statusCode).toBe(422);
    expect((blocked.json() as { error: { code: string } }).error.code).toBe('suppressed');

    // Allowed number goes through and is audited by the service.
    const ok = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/calls',
      headers: bearer(secret),
      payload: { user_id: ctx.seed.repId, to_number: '+16145558878' },
    });
    expect(ok.statusCode).toBe(201);
    const call = (ok.json() as { call: { id: string; status: string; user_id: string } }).call;
    expect(call.status).toBe('queued');
    expect(call.user_id).toBe(ctx.seed.repId);

    const serviceAudit = await ctx.dbh.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'call.create'), eq(schema.auditLog.objectId, call.id)));
    expect(serviceAudit).toHaveLength(1);
    const keyAudit = await ctx.dbh.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'api.request'), eq(schema.auditLog.actorId, keyId)));
    expect(keyAudit.length).toBeGreaterThan(0);
  });

  it('rejects a user_id from another org', async () => {
    const { secret } = await createKey('c2c-cross', ['calls:write']);
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/calls',
      headers: bearer(secret),
      payload: { user_id: otherSeed.repId, to_number: '+16145558879' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('leads, lookup, dispositions, numbers, users', () => {
  it('creates a lead with contact + phone and finds it via lookup', async () => {
    const { secret } = await createKey('leads-key', ['leads:read', 'leads:write']);
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/leads',
      headers: bearer(secret),
      payload: {
        contact_name: 'Paula Prospect',
        phone: '(614) 555-6100',
        address: '77 Elm St',
        city: 'Columbus',
        state: 'OH',
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json() as {
      lead: { id: string };
      contact: { display_name: string; phones: Array<{ phone_e164: string }> };
      property: { city: string };
    };
    expect(body.contact.display_name).toBe('Paula Prospect');
    expect(body.contact.phones[0]!.phone_e164).toBe('+16145556100');
    expect(body.property.city).toBe('Columbus');

    const lookup = await ctx.app.inject({
      method: 'GET',
      url: '/api/v1/lookup/phone?number=6145556100',
      headers: bearer(secret),
    });
    expect(lookup.statusCode).toBe(200);
    const found = lookup.json() as { contact: { display_name: string }; lead: { id: string } };
    expect(found.contact.display_name).toBe('Paula Prospect');
    expect(found.lead.id).toBe(body.lead.id);

    const fetched = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/leads/${body.lead.id}`,
      headers: bearer(secret),
    });
    expect(fetched.statusCode).toBe(200);

    const list = await ctx.app.inject({ method: 'GET', url: '/api/v1/leads', headers: bearer(secret) });
    expect(list.statusCode).toBe(200);
    expect(
      (list.json() as { data: Array<{ id: string }> }).data.some((l) => l.id === body.lead.id),
    ).toBe(true);

    // The lead creation is audited with the api key as the actor.
    const audit = await ctx.dbh.db
      .select()
      .from(schema.auditLog)
      .where(and(eq(schema.auditLog.action, 'lead.create'), eq(schema.auditLog.objectId, body.lead.id)));
    expect(audit).toHaveLength(1);
    expect(audit[0]!.actorType).toBe('api_key');
  });

  it('lists dispositions by call, numbers, and narrow users', async () => {
    const { secret } = await createKey('misc-key', ['calls:read', 'calls:write', 'numbers:read', 'users:read']);

    // Disposition a call through the internal surface, read it via the public one.
    const created = await ctx.app.inject({
      method: 'POST',
      url: '/api/v1/calls',
      headers: bearer(secret),
      payload: { user_id: ctx.seed.repId, to_number: '+16145558899' },
    });
    const callId = (created.json() as { call: { id: string } }).call.id;
    const wrap = await ctx.app.inject({
      method: 'POST',
      url: `/v1/calls/${callId}/disposition`,
      headers: repAuth,
      payload: { disposition: 'follow_up', note: 'call back Tuesday' },
    });
    expect(wrap.statusCode).toBe(200);

    const dispositions = await ctx.app.inject({
      method: 'GET',
      url: `/api/v1/dispositions?call_id=${callId}`,
      headers: bearer(secret),
    });
    expect(dispositions.statusCode).toBe(200);
    const drows = (dispositions.json() as { data: Array<{ call_id: string; disposition: string }> }).data;
    expect(drows).toHaveLength(1);
    expect(drows[0]!.disposition).toBe('follow_up');

    const numbers = await ctx.app.inject({ method: 'GET', url: '/api/v1/numbers', headers: bearer(secret) });
    expect(numbers.statusCode).toBe(200);
    expect(
      (numbers.json() as { data: Array<{ phone_e164: string }> }).data.map((n) => n.phone_e164),
    ).toContain('+15005550006');

    const users = await ctx.app.inject({ method: 'GET', url: '/api/v1/users', headers: bearer(secret) });
    expect(users.statusCode).toBe(200);
    const urows = (users.json() as { data: Array<Record<string, unknown>> }).data;
    expect(urows.length).toBeGreaterThan(0);
    for (const u of urows) {
      expect(Object.keys(u).sort()).toEqual(['display_name', 'id', 'role']);
    }
  });
});
