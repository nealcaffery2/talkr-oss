/**
 * Product testing without sign-in (AUTH_BYPASS_USER_EMAIL, config.ts).
 *
 * The switch has exactly three jobs: let a bare request through as the named
 * user, keep a real bearer authoritative, and announce itself to clients. And
 * it must do nothing at all when the email matches nobody.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { authHeader, createTestContext, type TestContext } from './helpers.js';

describe('AUTH_BYPASS_USER_EMAIL naming the seeded admin', () => {
  let t: TestContext;

  beforeAll(async () => {
    // Different case from the stored `admin@test-org.test`: the match is on the address, not the spelling.
    t = await createTestContext({ config: { AUTH_BYPASS_USER_EMAIL: 'Admin@Test-Org.test' } });
  });
  afterAll(async () => t.close());

  it('runs a request with no bearer as that user', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: t.seed.adminId, email: 'admin@test-org.test', role: 'admin' });
  });

  it('runs a request with an invalid bearer as that user too', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: 'Bearer not-a-jwt' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(t.seed.adminId);
  });

  it('still honours a valid bearer over the bypass', async () => {
    const res = await t.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: await authHeader('auth-rep-test-org'),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(t.seed.repId);
  });

  it('covers routes registered after the /v1 hook, with the user’s permissions', async () => {
    // Reports need reports.view.org, which the admin has; the point is that
    // the bypass context is a normal one, RBAC included.
    const res = await t.app.inject({ method: 'GET', url: '/v1/reports/overview' });
    expect(res.statusCode).toBe(200);
  });

  it('tells clients sign-in is off', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/auth/config' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ open_access: true });
  });
});

describe('AUTH_BYPASS_USER_EMAIL naming nobody', () => {
  let t: TestContext;

  beforeAll(async () => {
    t = await createTestContext({ config: { AUTH_BYPASS_USER_EMAIL: 'ghost@test-org.test' } });
  });
  afterAll(async () => t.close());

  it('changes nothing: bare requests are still refused', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/me' });
    expect(res.statusCode).toBe(401);
  });
});

describe('without the switch', () => {
  let t: TestContext;

  beforeAll(async () => {
    t = await createTestContext();
  });
  afterAll(async () => t.close());

  it('bare requests are refused and clients are told to sign in', async () => {
    const me = await t.app.inject({ method: 'GET', url: '/v1/me' });
    expect(me.statusCode).toBe(401);
    const cfg = await t.app.inject({ method: 'GET', url: '/v1/auth/config' });
    expect(cfg.json()).toMatchObject({ open_access: false });
  });
});
