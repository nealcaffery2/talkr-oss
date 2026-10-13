/**
 * A deployment with no carrier (VOICE_PROVIDER=none) must be usable for
 * everything that is not a phone call, and must refuse the calls plainly.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { NullProvider } from '../src/services/null-provider.js';
import { authHeader, createTestContext, type TestContext } from './helpers.js';

describe('VOICE_PROVIDER=none', () => {
  let t: TestContext;
  let app: ReturnType<typeof buildApp>;

  beforeAll(async () => {
    t = await createTestContext();
    app = buildApp({ ...t.deps, provider: new NullProvider() });
  });
  afterAll(async () => {
    await app.close();
    await t.close();
  });

  it('serves the workspace', async () => {
    const headers = await authHeader('auth-rep-test-org');
    for (const url of ['/v1/me', '/v1/team', '/v1/leads', '/v1/conversations', '/v1/tasks']) {
      const res = await app.inject({ method: 'GET', url, headers });
      expect(res.statusCode, url).toBe(200);
    }
  });

  it('refuses a softphone token with one message naming the switch', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/voice/token',
      headers: await authHeader('auth-rep-test-org'),
    });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toMatchObject({ error: 'no_carrier' });
    expect(res.json().message).toMatch(/VOICE_PROVIDER=none/);
  });

  it('accepts no carrier webhooks', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/telnyx/voice-status',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'CallSid=CA123&CallStatus=completed',
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it('reports the missing carrier on the deep health check', async () => {
    const res = await app.inject({ method: 'GET', url: '/health/deep' });
    expect(res.json()).toMatchObject({ ok: true, provider: 'none', provider_configured: false });
  });
});
