/**
 * Telnyx self-provisioning at boot: two rows in, a working carrier out.
 * The fake Telnyx answers as the v2 API does; the assertions are on what we
 * asked it for and what ended up in runtime_settings.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pino } from 'pino';
import { schema } from '@talkr/db';
import { applyRuntimeSettings } from '../src/services/runtime-settings.js';
import { bootstrapTelnyxIfNeeded, telnyxNeedsBootstrap } from '../src/services/telnyx-bootstrap.js';
import { createTestContext, testConfig, type TestContext } from './helpers.js';

const PUBLIC_KEY = Buffer.alloc(32, 7).toString('base64');

function fakeTelnyx(opts: { existing?: Record<string, Array<{ id: string; [k: string]: unknown }>>; publicKey?: boolean } = {}) {
  const calls: Array<{ method: string; path: string; body?: Record<string, unknown> }> = [];
  const created: Record<string, Array<{ id: string; [k: string]: unknown }>> = { ...(opts.existing ?? {}) };
  const byId = new Map<string, { id: string; [k: string]: unknown }>();
  for (const rows of Object.values(created)) {
    for (const row of rows) byId.set(String(row.id), row);
  }
  const http = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const path = u.pathname.replace('/v2', '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : undefined;
    calls.push({ method, path, body });
    if (method === 'GET' && path === '/public_key') {
      return opts.publicKey === false
        ? new Response('{"errors":[{"code":"10005"}]}', { status: 404 })
        : new Response(JSON.stringify({ data: { public: PUBLIC_KEY } }), { status: 200 });
    }
    if (method === 'GET' && path === '/whoami') {
      return new Response(JSON.stringify({ data: { organization_id: 'org-42', user_id: 'user-1' } }), { status: 200 });
    }
    const idMatch = /^\/(?:credential_connections|texml_applications|messaging_profiles)\/([^/]+)$/.exec(path);
    if (idMatch && method === 'GET') {
      const row = byId.get(idMatch[1]!);
      return row
        ? new Response(JSON.stringify({ data: row }), { status: 200 })
        : new Response('{"errors":[{"code":"10005"}]}', { status: 404 });
    }
    if (idMatch && method === 'PATCH') {
      const row = byId.get(idMatch[1]!);
      if (!row) return new Response('{"errors":[{"code":"10005"}]}', { status: 404 });
      Object.assign(row, body ?? {});
      return new Response(JSON.stringify({ data: row }), { status: 200 });
    }
    if (method === 'GET') return new Response(JSON.stringify({ data: created[path] ?? [] }), { status: 200 });
    const id = `${path.slice(1, 4)}-${(created[path]?.length ?? 0) + 1}`;
    const row = { id, ...body };
    created[path] = [...(created[path] ?? []), row];
    byId.set(id, row);
    return new Response(JSON.stringify({ data: row }), { status: 201 });
  }) as typeof fetch;
  return { http, calls, byId };
}

const TELNYX_ROWS = { VOICE_PROVIDER: 'telnyx', TELNYX_API_KEY: 'KEYtest' } as const;

describe('telnyx bootstrap', () => {
  let t: TestContext;
  const logger = pino({ level: 'silent' });
  beforeAll(async () => {
    t = await createTestContext();
  });
  afterAll(async () => t.close());

  it('does nothing unless the rows call for Telnyx with only an API key', () => {
    expect(telnyxNeedsBootstrap(testConfig())).toBe(false);
    expect(telnyxNeedsBootstrap(testConfig({ VOICE_PROVIDER: 'telnyx' }))).toBe(false);
    expect(telnyxNeedsBootstrap(testConfig({ ...TELNYX_ROWS }))).toBe(true);
    expect(
      telnyxNeedsBootstrap(
        testConfig({ ...TELNYX_ROWS, TELNYX_TEXML_APP_ID: 'a', TELNYX_SIP_CONNECTION_ID: 's', TELNYX_PUBLIC_KEY: 'p', TELNYX_ACCOUNT_ID: 'o' }),
      ),
    ).toBe(false);
  });

  it('creates what is missing, reuses what exists by name, and writes the rows', async () => {
    await t.dbh.db.insert(schema.runtimeSettings).values(Object.entries(TELNYX_ROWS).map(([key, value]) => ({ key, value })));
    const env = { ...process.env, VOICE_PROVIDER: undefined, TELNYX_API_KEY: undefined } as NodeJS.ProcessEnv;
    const before = (await applyRuntimeSettings(t.dbh, { ...env, ...testEnv() })).config;
    expect(before.VOICE_PROVIDER).toBe('telnyx');

    const fake = fakeTelnyx({ existing: { '/messaging_profiles': [{ id: 'msg-existing', name: 'talkr-messaging' }] } });
    const after = await bootstrapTelnyxIfNeeded(t.dbh, before, logger, fake.http);

    expect(after.VOICE_PROVIDER).toBe('telnyx');
    expect(after.TELNYX_TEXML_APP_ID).toBe('tex-1');
    expect(after.TELNYX_SIP_CONNECTION_ID).toBe('cre-1');
    expect(after.TELNYX_MESSAGING_PROFILE_ID).toBe('msg-existing');
    expect(after.TELNYX_PUBLIC_KEY).toBe(PUBLIC_KEY);
    expect(after.TELNYX_ACCOUNT_ID).toBe('org-42');

    const posts = fake.calls.filter((c) => c.method === 'POST');
    expect(posts.map((c) => c.path)).toEqual(['/outbound_voice_profiles', '/texml_applications', '/credential_connections']);
    expect(posts[0]!.body).toMatchObject({ traffic_type: 'conversational', service_plan: 'global', usage_payment_method: 'rate-deck' });
    const texml = posts[1]!.body!;
    expect(texml.voice_url).toBe('https://talkr.test/twiml/outbound-dial');
    expect(texml.status_callback).toBe('https://talkr.test/webhooks/telnyx/voice-status');
    const sip = posts[2]!.body!;
    expect((sip.inbound as { dnis_number_format: string }).dnis_number_format).toBe('sip_username');
    expect((sip.outbound as { outbound_voice_profile_id: string }).outbound_voice_profile_id).toBe('out-1');
    expect(sip.sip_uri_calling_preference).toBe('internal');

    // The rows are there for the next boot, which then has nothing to provision:
    // it only re-reads the SIP preference and the webhook URLs, and writes nothing.
    const rows = await t.dbh.db.select().from(schema.runtimeSettings);
    const byKey = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(byKey.TELNYX_TEXML_APP_ID).toBe('tex-1');
    expect(byKey.TELNYX_BOOTSTRAP_ERROR).toBeUndefined();
    expect(telnyxNeedsBootstrap(after)).toBe(false);
    const again = fakeTelnyx({
      existing: {
        '/credential_connections': [
          { id: 'cre-1', connection_name: 'talkr-browsers', sip_uri_calling_preference: 'internal' },
        ],
      },
    });
    await bootstrapTelnyxIfNeeded(t.dbh, after, logger, again.http);
    expect(again.calls.every((c) => c.method === 'GET')).toBe(true);
    expect(again.calls[0]).toEqual({ method: 'GET', path: '/credential_connections/cre-1', body: undefined });
  });

  it('PATCHes an existing talkr-browsers connection when sip_uri_calling_preference is wrong', async () => {
    const config = testConfig({
      ...TELNYX_ROWS,
      TELNYX_TEXML_APP_ID: 'tex-1',
      TELNYX_SIP_CONNECTION_ID: 'cre-old',
      TELNYX_PUBLIC_KEY: PUBLIC_KEY,
      TELNYX_ACCOUNT_ID: 'org-42',
    });
    const fake = fakeTelnyx({
      existing: {
        '/credential_connections': [
          { id: 'cre-old', connection_name: 'talkr-browsers', sip_uri_calling_preference: 'disabled' },
        ],
      },
    });
    const after = await bootstrapTelnyxIfNeeded(t.dbh, config, logger, fake.http);
    expect(after.VOICE_PROVIDER).toBe('telnyx');
    expect(fake.calls.slice(0, 2)).toEqual([
      { method: 'GET', path: '/credential_connections/cre-old', body: undefined },
      { method: 'PATCH', path: '/credential_connections/cre-old', body: { sip_uri_calling_preference: 'internal' } },
    ]);
    expect(fake.byId.get('cre-old')?.sip_uri_calling_preference).toBe('internal');
  });

  it('PATCHes during provision when talkr-browsers already exists without internal preference', async () => {
    await t.dbh.db.delete(schema.runtimeSettings);
    await t.dbh.db.insert(schema.runtimeSettings).values(Object.entries(TELNYX_ROWS).map(([key, value]) => ({ key, value })));
    const env = { ...process.env, VOICE_PROVIDER: undefined, TELNYX_API_KEY: undefined } as NodeJS.ProcessEnv;
    const before = (await applyRuntimeSettings(t.dbh, { ...env, ...testEnv() })).config;
    const fake = fakeTelnyx({
      existing: {
        '/outbound_voice_profiles': [{ id: 'out-existing', name: 'talkr-outbound' }],
        '/texml_applications': [{ id: 'tex-existing', friendly_name: 'talkr-texml' }],
        '/credential_connections': [
          { id: 'cre-existing', connection_name: 'talkr-browsers', sip_uri_calling_preference: 'disabled' },
        ],
        '/messaging_profiles': [{ id: 'msg-existing', name: 'talkr-messaging' }],
      },
    });
    const after = await bootstrapTelnyxIfNeeded(t.dbh, before, logger, fake.http);
    expect(after.TELNYX_SIP_CONNECTION_ID).toBe('cre-existing');
    const patch = fake.calls.find((c) => c.method === 'PATCH');
    expect(patch).toEqual({
      method: 'PATCH',
      path: '/credential_connections/cre-existing',
      body: { sip_uri_calling_preference: 'internal' },
    });
    expect(fake.calls.some((c) => c.method === 'POST' && c.path === '/credential_connections')).toBe(false);
  });

  it('moves webhooks still on the legacy /webhooks/twilio/ path, and leaves moved ones alone', async () => {
    const config = testConfig({
      ...TELNYX_ROWS,
      TELNYX_TEXML_APP_ID: 'tex-legacy',
      TELNYX_SIP_CONNECTION_ID: 'cre-ok',
      TELNYX_MESSAGING_PROFILE_ID: 'msg-new',
      TELNYX_PUBLIC_KEY: PUBLIC_KEY,
      TELNYX_ACCOUNT_ID: 'org-42',
    });
    const fake = fakeTelnyx({
      existing: {
        '/credential_connections': [{ id: 'cre-ok', connection_name: 'talkr-browsers', sip_uri_calling_preference: 'internal' }],
        '/texml_applications': [{ id: 'tex-legacy', status_callback: 'https://talkr.test/webhooks/twilio/voice-status' }],
        '/messaging_profiles': [{ id: 'msg-new', webhook_url: 'https://talkr.test/webhooks/telnyx/inbound-sms' }],
      },
    });
    await bootstrapTelnyxIfNeeded(t.dbh, config, logger, fake.http);
    expect(fake.byId.get('tex-legacy')?.status_callback).toBe('https://talkr.test/webhooks/telnyx/voice-status');
    expect(fake.calls.filter((c) => c.method === 'PATCH').map((c) => c.path)).toEqual(['/texml_applications/tex-legacy']);
  });

  it('boots with no carrier and records why when Telnyx cannot be completed', async () => {
    const config = testConfig({ ...TELNYX_ROWS });
    const fake = fakeTelnyx({ publicKey: false });
    const after = await bootstrapTelnyxIfNeeded(t.dbh, config, logger, fake.http);
    expect(after.VOICE_PROVIDER).toBe('none');
    const rows = await t.dbh.db.select().from(schema.runtimeSettings);
    expect(rows.find((r) => r.key === 'TELNYX_BOOTSTRAP_ERROR')?.value).toMatch(/public_key/);
  });
});

/** The env the test config is built from, so runtime settings have gaps to fill. */
function testEnv(): NodeJS.ProcessEnv {
  const c = testConfig();
  return {
    NODE_ENV: 'test',
    DATABASE_URL: c.DATABASE_URL,
    PUBLIC_BASE_URL: c.PUBLIC_BASE_URL,
    AUTH_JWT_SECRET: c.AUTH_JWT_SECRET,
  };
}
