/**
 * Email + password sign-in (/v1/auth/*).
 *
 * GoTrue is faked at the fetch boundary: the routes' job is translating its
 * answers and checking the resulting user against our own table, and that is
 * what these tests pin down. The access token the fake issues is signed with
 * the test JWT secret, exactly as a real Supabase project's would be.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signTestToken } from '../src/auth.js';
import { TEST_JWT_SECRET, createTestContext, type TestContext } from './helpers.js';

const SUPABASE_URL = 'https://fake-project.supabase.co';

interface FakeAuthUser {
  password: string;
  sub: string;
}

function fakeGoTrue(users: Record<string, FakeAuthUser>, log: string[]): typeof fetch {
  const refreshTokens = new Map<string, string>(); // refresh -> sub
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    log.push(`${init?.method ?? 'GET'} ${url.replace(SUPABASE_URL, '')}`);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers.apikey !== 'anon-key') return Response.json({ msg: 'no api key' }, { status: 401 });
    const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, string>) : {};

    async function session(sub: string) {
      const refresh = `rt_${Math.random().toString(36).slice(2)}`;
      refreshTokens.set(refresh, sub);
      return {
        access_token: await signTestToken(TEST_JWT_SECRET, sub),
        refresh_token: refresh,
        expires_in: 3600,
        token_type: 'bearer',
      };
    }

    if (url.endsWith('/auth/v1/token?grant_type=password')) {
      const u = users[body.email ?? ''];
      if (!u || u.password !== body.password) {
        return Response.json(
          { error: 'invalid_grant', error_description: 'Invalid login credentials' },
          { status: 400 },
        );
      }
      return Response.json(await session(u.sub));
    }
    if (url.endsWith('/auth/v1/token?grant_type=refresh_token')) {
      const sub = refreshTokens.get(body.refresh_token ?? '');
      if (!sub) return Response.json({ error: 'invalid_grant' }, { status: 400 });
      refreshTokens.delete(body.refresh_token!); // single use, as GoTrue rotates
      return Response.json(await session(sub));
    }
    if (url.endsWith('/auth/v1/logout')) return new Response(null, { status: 204 });
    if (url.includes('/auth/v1/recover')) return Response.json({});
    if (url.endsWith('/auth/v1/user') && init?.method === 'PUT') {
      return headers.authorization === 'Bearer recovery-token'
        ? Response.json({ id: 'auth-rep-test-org' })
        : Response.json({ msg: 'invalid JWT' }, { status: 401 });
    }
    return Response.json({ msg: 'not found' }, { status: 404 });
  }) as typeof fetch;
}

describe('sign-in proxy', () => {
  let t: TestContext;
  const calls: string[] = [];

  beforeAll(async () => {
    t = await createTestContext({
      config: { SUPABASE_URL, SUPABASE_ANON_KEY: 'anon-key' },
      fetchImpl: fakeGoTrue(
        {
          // The seeded rep's auth_user_id is `auth-rep-test-org`.
          'rep@test-org.test': { password: 'correct horse', sub: 'auth-rep-test-org' },
          // A real Supabase user nobody has added to the workspace.
          'stranger@example.com': { password: 'pw', sub: 'auth-stranger' },
        },
        calls,
      ),
    });
  });
  afterAll(async () => t.close());

  it('advertises password sign-in when configured', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/auth/config' });
    expect(res.json()).toEqual({
      password_signin: true,
      token_signin: true,
      google_signin: false,
      google_client_id: null,
      open_access: false,
    });
  });

  it('signs a rep in and returns their platform profile with the session', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'rep@test-org.test', password: 'correct horse' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.access_token).toMatch(/^eyJ/);
    expect(body.refresh_token).toMatch(/^rt_/);
    expect(body.expires_at).toBeGreaterThan(Date.now() / 1000);
    expect(body.user).toMatchObject({
      id: t.seed.repId,
      email: 'rep@test-org.test',
      role: 'rep',
      org: { slug: 'test-org' },
    });

    // The token it returned is accepted by the ordinary API.
    const me = await t.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().org.slug).toBe('test-org');
    expect(me.json().numbers.length).toBeGreaterThan(0);
  });

  it('does not reveal whether an email exists', async () => {
    const wrongPw = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'rep@test-org.test', password: 'nope' },
    });
    const noUser = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'nobody@test-org.test', password: 'nope' },
    });
    expect(wrongPw.statusCode).toBe(401);
    expect(noUser.statusCode).toBe(401);
    expect(wrongPw.json()).toEqual(noUser.json());
  });

  it('refuses an auth user who is not a workspace member, with a distinct error', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'stranger@example.com', password: 'pw' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('no_platform_user');
  });

  it('validates the body', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'not-an-email', password: '' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_body');
  });

  it('refreshes a session once and treats a reused refresh token as expired', async () => {
    const login = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'rep@test-org.test', password: 'correct horse' },
    });
    const { refresh_token } = login.json();

    const first = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refresh_token },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().refresh_token).not.toBe(refresh_token);
    expect(first.json().user.id).toBe(t.seed.repId);

    const reused = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      payload: { refresh_token },
    });
    expect(reused.statusCode).toBe(401);
    expect(reused.json().error).toBe('session_expired');
  });

  it('sends a recovery email and answers 204 whether or not the email exists', async () => {
    const before = calls.length;
    for (const email of ['rep@test-org.test', 'nobody@test-org.test']) {
      const res = await t.app.inject({
        method: 'POST',
        url: '/v1/auth/recover',
        payload: { email, redirect_to: 'https://talkr.example.com/login/reset' },
      });
      expect(res.statusCode).toBe(204);
    }
    expect(calls.slice(before)[0]).toBe(
      'POST /auth/v1/recover?redirect_to=https%3A%2F%2Ftalkr.example.com%2Flogin%2Freset',
    );
  });

  it('sets a new password with a recovery token and refuses an expired one', async () => {
    const ok = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/reset',
      payload: { access_token: 'recovery-token', password: 'new password 1' },
    });
    expect(ok.statusCode).toBe(204);
    const expired = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/reset',
      payload: { access_token: 'stale', password: 'new password 1' },
    });
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error).toBe('link_expired');
    const short = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/reset',
      payload: { access_token: 'recovery-token', password: 'short' },
    });
    expect(short.statusCode).toBe(400);
  });

  it('revokes upstream on logout and always answers 204', async () => {
    const before = calls.length;
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/logout',
      headers: { authorization: 'Bearer whatever' },
    });
    expect(res.statusCode).toBe(204);
    expect(calls.slice(before)).toEqual(['POST /auth/v1/logout']);
  });
});

describe('sign-in proxy, unconfigured', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
  });
  afterAll(async () => t.close());

  it('reports token-only sign-in and answers 501 to a password attempt', async () => {
    const cfg = await t.app.inject({ method: 'GET', url: '/v1/auth/config' });
    expect(cfg.json()).toEqual({
      password_signin: false,
      token_signin: true,
      google_signin: false,
      google_client_id: null,
      open_access: false,
    });

    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'rep@test-org.test', password: 'x' },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('password_signin_not_configured');
  });
});
