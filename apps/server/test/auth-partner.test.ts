/**
 * A partner (clozr) signs its reps in with its own tokens. Talkr accepts them
 * when configured to, bound to the partner's issuer, and links the rep by
 * email exactly like a Supabase token.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { schema } from '@talkr/db';
import { signTestToken } from '../src/auth.js';
import { TEST_JWT_SECRET, createTestContext, type TestContext } from './helpers.js';

const PARTNER_SECRET = 'clozr-partner-secret-clozr-partner';
const ISSUER = 'https://your-clozr-project.supabase.co/auth/v1';

async function partnerToken(sub: string, claims: Record<string, unknown> = {}, secret = PARTNER_SECRET, iss = ISSUER) {
  return new SignJWT({ sub, ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(iss)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
}

describe('partner-issued tokens (HS256)', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext({ config: { PARTNER_JWT_SECRET: PARTNER_SECRET, PARTNER_JWT_ISSUER: ISSUER } });
  });
  afterAll(async () => t.close());

  it('signs a rep in from the partner secret and claims their row by email', async () => {
    await t.dbh.db.insert(schema.users).values({
      orgId: t.seed.orgId, email: 'taylor@example.test', displayName: 'Taylor', role: 'rep', status: 'invited', authUserId: null,
    });
    const token = await partnerToken('clozr-user-1', { email: 'Taylor@Example.test' });
    const res = await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe('taylor@example.test');
    // Second request resolves by the now-linked auth id, no email needed.
    const again = await partnerToken('clozr-user-1');
    const res2 = await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${again}` } });
    expect(res2.statusCode).toBe(200);
  });

  it('rejects the partner secret with the wrong issuer, and any other secret', async () => {
    const wrongIss = await partnerToken('clozr-user-1', {}, PARTNER_SECRET, 'https://someone-else.example');
    expect((await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${wrongIss}` } })).statusCode).toBe(401);
    const wrongSecret = await partnerToken('clozr-user-1', {}, 'not-the-partner-secret-not-the-partner');
    expect((await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${wrongSecret}` } })).statusCode).toBe(401);
  });

  it('the primary secret keeps working with no issuer at all', async () => {
    const token = await signTestToken(TEST_JWT_SECRET, 'auth-rep-test-org');
    const res = await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
  });
});

describe('partner-issued tokens (JWKS)', () => {
  let t: TestContext;
  let privateKey: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
  beforeAll(async () => {
    const pair = await generateKeyPair('ES256');
    privateKey = pair.privateKey as Awaited<ReturnType<typeof generateKeyPair>>['privateKey'];
    const jwk = { ...(await exportJWK(pair.publicKey)), kid: 'k1', alg: 'ES256', use: 'sig' };
    // The JWKS is served by a fake fetch; jose fetches it once and caches.
    const fetchImpl: typeof fetch = async (input, init) => {
      const url = String(input);
      if (url === 'https://partner.test/.well-known/jwks.json') {
        return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return fetch(input, init);
    };
    t = await createTestContext({
      config: { PARTNER_JWKS_URL: 'https://partner.test/.well-known/jwks.json', PARTNER_JWT_ISSUER: ISSUER },
      fetchImpl,
    });
    // jose uses the global fetch for remote key sets; point it at the fake.
    globalThis.fetch = fetchImpl;
  });
  afterAll(async () => t.close());

  it('accepts an ES256 token whose key is in the partner JWKS and links the rep by email', async () => {
    // A partner subject is its own namespace: it links to the seeded rep by
    // email (partner_identities), never by matching users.auth_user_id.
    const token = await new SignJWT({ sub: 'clozr-jwks-sub-1', email: 'rep@test-org.test' })
      .setProtectedHeader({ alg: 'ES256', kid: 'k1' })
      .setIssuer(ISSUER)
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(privateKey);
    const res = await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().display_name).toBe('Riley Rep');
  });
});
