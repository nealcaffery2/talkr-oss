/**
 * "Continue with Google" (POST /v1/auth/google).
 *
 * The client does the Google half and arrives with an id_token; this route
 * trades it for a Supabase session. GoTrue is faked at the fetch boundary, as
 * in auth-signin.test.ts — what is pinned down here is the translation, the
 * nonce being carried through, and above all the provisioning story: a rep an
 * admin added by email only is `invited` with no auth user, and their first
 * Google sign-in must claim that row and make them active.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { signTestToken } from '../src/auth.js';
import { TEST_JWT_SECRET, createTestContext, type TestContext } from './helpers.js';

const SUPABASE_URL = 'https://fake-project.supabase.co';
// Dummy OAuth values. Not real Google credentials; nothing here signs anyone in.
const CLIENT_ID = '000000000000-dummyclientid.apps.googleusercontent.com';

interface GoogleRequest {
  provider?: string;
  id_token?: string;
  nonce?: string;
}

/**
 * Stands in for GoTrue's id_token grant. `accounts` maps a fake id_token to
 * the auth user Google vouched for; anything else is rejected the way a token
 * minted for another app would be.
 */
function fakeGoTrue(
  accounts: Record<string, { sub: string; email: string }>,
  seen: GoogleRequest[],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = (init?.headers ?? {}) as Record<string, string>;
    if (headers.apikey !== 'anon-key') return Response.json({ msg: 'no api key' }, { status: 401 });
    const body = init?.body ? (JSON.parse(String(init.body)) as GoogleRequest) : {};

    if (url.endsWith('/auth/v1/token?grant_type=id_token')) {
      seen.push(body);
      const account = accounts[body.id_token ?? ''];
      if (!account || body.provider !== 'google') {
        return Response.json(
          { error: 'invalid_grant', error_description: 'Invalid ID token' },
          { status: 400 },
        );
      }
      return Response.json({
        access_token: await signTestToken(TEST_JWT_SECRET, account.sub, { email: account.email }),
        refresh_token: `rt_${Math.random().toString(36).slice(2)}`,
        expires_in: 3600,
        token_type: 'bearer',
      });
    }
    return Response.json({ msg: 'not found' }, { status: 404 });
  }) as typeof fetch;
}

describe('google sign-in', () => {
  let t: TestContext;
  const seen: GoogleRequest[] = [];

  beforeAll(async () => {
    t = await createTestContext({
      config: {
        SUPABASE_URL,
        SUPABASE_ANON_KEY: 'anon-key',
        GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
      },
      fetchImpl: fakeGoTrue(
        {
          // The seeded rep, already linked to this auth user.
          'google-token-rep': { sub: 'auth-rep-test-org', email: 'rep@test-org.test' },
          // A rep an admin invited by email, who has never signed in.
          'google-token-invitee': { sub: 'auth-invitee', email: 'invitee@test-org.test' },
          // A real Google account nobody added to the workspace.
          'google-token-stranger': { sub: 'auth-stranger', email: 'stranger@example.com' },
        },
        seen,
      ),
    });
  });
  afterAll(async () => t.close());

  it('advertises google sign-in and the public client id', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/auth/config' });
    expect(res.json()).toMatchObject({
      password_signin: true,
      google_signin: true,
      google_client_id: CLIENT_ID,
    });
  });

  it('trades an id_token for a session and the rep’s platform profile', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/google',
      payload: { id_token: 'google-token-rep', nonce: 'nonce-abc' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.access_token).toMatch(/^eyJ/);
    expect(body.expires_at).toBeGreaterThan(Date.now() / 1000);
    expect(body.user).toMatchObject({ id: t.seed.repId, email: 'rep@test-org.test', role: 'rep' });

    // The session it returns is an ordinary one: the API accepts the token.
    const me = await t.app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${body.access_token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(me.json().id).toBe(t.seed.repId);
  });

  it('asks GoTrue for the google provider and carries the nonce through', async () => {
    const before = seen.length;
    await t.app.inject({
      method: 'POST',
      url: '/v1/auth/google',
      payload: { id_token: 'google-token-rep', nonce: 'nonce-xyz' },
    });
    expect(seen[before]).toEqual({
      provider: 'google',
      id_token: 'google-token-rep',
      nonce: 'nonce-xyz',
    });
  });

  it('omits the nonce entirely when the client did not send one', async () => {
    const before = seen.length;
    await t.app.inject({
      method: 'POST',
      url: '/v1/auth/google',
      payload: { id_token: 'google-token-rep' },
    });
    expect(seen[before]).not.toHaveProperty('nonce');
  });

  it('claims an invited rep’s row on their first Google sign-in and activates them', async () => {
    const [invited] = await t.dbh.db
      .insert(schema.users)
      .values({
        orgId: t.seed.orgId,
        email: 'invitee@test-org.test',
        displayName: 'Invited Rep',
        role: 'rep',
        status: 'invited',
        authUserId: null,
      })
      .returning();

    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/google',
      payload: { id_token: 'google-token-invitee' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(invited!.id);

    const [after] = await t.dbh.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, invited!.id));
    expect(after!.authUserId).toBe('auth-invitee');
    expect(after!.status).toBe('active');
  });

  it('refuses a google account that is not a workspace member', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/google',
      payload: { id_token: 'google-token-stranger' },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error).toBe('no_platform_user');
  });

  it('reports a rejected id_token as its own error, not as wrong credentials', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/google',
      payload: { id_token: 'not-a-real-token' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('invalid_google_token');
    // Without this the rep sees a dead end and whoever they ask has to go
    // reading GoTrue's logs to find out which of a dozen causes it was.
    expect(res.json().detail).toBe('Invalid ID token');
  });

  it('validates the body', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/v1/auth/google', payload: { id_token: '' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('invalid_body');
  });
});

describe('google sign-in configured with a client secret by mistake', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext({
      config: {
        SUPABASE_URL,
        SUPABASE_ANON_KEY: 'anon-key',
        // What you get by copying the field next to the client id in Google's
        // console. It must never reach a client: /v1/auth/config is public.
        GOOGLE_OAUTH_CLIENT_ID: 'GOCSPX-DUMMY-SECRET-not-a-real-credential',
      },
      fetchImpl: fakeGoTrue({}, []),
    });
  });
  afterAll(async () => t.close());

  it('never serves the value and leaves google sign-in off', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/auth/config' });
    expect(res.json()).toMatchObject({ google_signin: false, google_client_id: null });
    // Belt and braces: the secret appears nowhere in the response at all.
    expect(res.body).not.toContain('GOCSPX');
  });

  it('refuses the route rather than sending a bogus client id to GoTrue', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/google',
      payload: { id_token: 'anything' },
    });
    expect(res.statusCode).toBe(501);
  });
});

describe('google sign-in without a client id', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext({
      config: { SUPABASE_URL, SUPABASE_ANON_KEY: 'anon-key' },
      fetchImpl: fakeGoTrue({}, []),
    });
  });
  afterAll(async () => t.close());

  it('does not advertise it', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/auth/config' });
    expect(res.json()).toMatchObject({ google_signin: false, google_client_id: null });
  });

  it('refuses the route with 501 rather than calling GoTrue', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/google',
      payload: { id_token: 'anything' },
    });
    expect(res.statusCode).toBe(501);
    expect(res.json().error).toBe('google_signin_not_configured');
  });
});

/**
 * A provider nobody switched on in the Supabase dashboard is an operator
 * mistake, and it answers identically to a bad token unless the route looks at
 * `error_code`. Telling a rep to "try again" then sends them round a loop that
 * cannot terminate, so it is pinned as its own outcome.
 */
describe('google sign-in with the provider disabled in supabase', () => {
  let t: TestContext;

  beforeAll(async () => {
    t = await createTestContext({
      config: {
        SUPABASE_URL,
        SUPABASE_ANON_KEY: 'anon-key',
        GOOGLE_OAUTH_CLIENT_ID: CLIENT_ID,
      },
      fetchImpl: (async () =>
        Response.json(
          {
            code: 400,
            error_code: 'provider_disabled',
            msg: 'Provider (issuer "https://accounts.google.com") is not enabled',
          },
          { status: 400 },
        )) as typeof fetch,
    });
  });
  afterAll(async () => t.close());

  it('says an admin must enable it, rather than inviting a retry', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/auth/google',
      payload: { id_token: 'google-token-rep' },
    });
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('google_provider_disabled');
    expect(res.json().message).not.toMatch(/try again/i);
  });
});
