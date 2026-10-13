/**
 * Partner apps as rows: a `partner_apps` row is enough to trust a partner's
 * tokens and to allow its browser origins, no env var and no redeploy. The
 * identity map means a person who already has a Talkr auth id can also sign
 * in from the partner with a different one.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SignJWT } from 'jose';
import { eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { originMatches } from '../src/partners.js';
import { createTestContext, type TestContext } from './helpers.js';

const SECRET = 'clozr-row-secret-clozr-row-secret';
const ISSUER = 'https://your-clozr-project.supabase.co/auth/v1';

async function token(sub: string, claims: Record<string, unknown> = {}, iss = ISSUER) {
  return new SignJWT({ sub, ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(iss)
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(SECRET));
}

describe('partner_apps rows', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
    await t.dbh.db.insert(schema.partnerApps).values({
      name: 'CLOZR',
      issuer: ISSUER,
      secret: SECRET,
      origins: ['https://clozr.example.com', 'https://clozr-*-team.vercel.app'],
    });
  });
  afterAll(async () => t.close());

  it('an already-linked Talkr user signs in from the partner and gains a second identity', async () => {
    // The seeded rep has a Talkr auth id; the partner knows them by another sub.
    const [rep] = await t.dbh.db.select().from(schema.users).where(eq(schema.users.authUserId, 'auth-rep-test-org')).limit(1);
    expect(rep).toBeTruthy();
    const first = await token('clozr-sub-rep', { email: rep!.email.toUpperCase() });
    const res = await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${first}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe(rep!.email);
    // users.auth_user_id is untouched; the link lives in partner_identities.
    const [again] = await t.dbh.db.select().from(schema.users).where(eq(schema.users.id, rep!.id));
    expect(again!.authUserId).toBe('auth-rep-test-org');
    const ids = await t.dbh.db.select().from(schema.partnerIdentities).where(eq(schema.partnerIdentities.userId, rep!.id));
    expect(ids.map((i) => [i.issuer, i.subject])).toEqual([[ISSUER, 'clozr-sub-rep']]);
    // Second request needs no email: (issuer, sub) resolves.
    const second = await token('clozr-sub-rep');
    expect((await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${second}` } })).statusCode).toBe(200);
  });

  it('an invited teammate is activated by their first partner sign-in', async () => {
    await t.dbh.db.insert(schema.users).values({
      orgId: t.seed.orgId, email: 'riley@example.test', displayName: 'Riley', role: 'rep', status: 'invited', authUserId: null,
    });
    const tok = await token('clozr-sub-riley', { email: 'riley@example.test' });
    const res = await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${tok}` } });
    expect(res.statusCode).toBe(200);
    const [row] = await t.dbh.db.select().from(schema.users).where(eq(schema.users.email, 'riley@example.test'));
    expect(row!.status).toBe('active');
  });

  it('refuses an unknown email, a missing email, an anonymous token and the wrong issuer', async () => {
    const unknown = await token('clozr-sub-x', { email: 'nobody@example.test' });
    expect((await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${unknown}` } })).statusCode).toBe(401);
    const noEmail = await token('clozr-sub-y');
    expect((await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${noEmail}` } })).statusCode).toBe(401);
    const anon = await token('clozr-sub-z', { email: 'riley@example.test', is_anonymous: true });
    expect((await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${anon}` } })).statusCode).toBe(401);
    const wrongIss = await token('clozr-sub-rep', {}, 'https://other.example/auth/v1');
    expect((await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${wrongIss}` } })).statusCode).toBe(401);
  });

  it('a disabled row stays shut', async () => {
    await t.dbh.db.update(schema.partnerApps).set({ enabled: false }).where(eq(schema.partnerApps.issuer, ISSUER));
    t.deps.partners!.invalidate();
    const tok = await token('clozr-sub-rep');
    expect((await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${tok}` } })).statusCode).toBe(401);
    await t.dbh.db.update(schema.partnerApps).set({ enabled: true }).where(eq(schema.partnerApps.issuer, ISSUER));
    t.deps.partners!.invalidate();
  });

  it('CORS allows WEB_ORIGIN, the partner origins (exact and pattern), and nothing else', async () => {
    const preflight = (origin: string) =>
      t.app.inject({
        method: 'OPTIONS',
        url: '/v1/me',
        headers: { origin, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization' },
      });
    expect((await preflight('http://localhost:3100')).headers['access-control-allow-origin']).toBe('http://localhost:3100');
    expect((await preflight('https://clozr.example.com')).headers['access-control-allow-origin']).toBe('https://clozr.example.com');
    const preview = 'https://clozr-git-feature-abc123-team.vercel.app';
    expect((await preflight(preview)).headers['access-control-allow-origin']).toBe(preview);
    expect((await preflight('https://evil.example')).headers['access-control-allow-origin']).toBeUndefined();
  });

  it('originMatches: one star is one hostname label', () => {
    expect(originMatches('https://a-b-c.vercel.app', 'https://a-*.vercel.app')).toBe(true);
    expect(originMatches('https://a.vercel.app/evil', 'https://a-*.vercel.app')).toBe(false);
    expect(originMatches('https://a-b.evil.com', 'https://a-*.vercel.app')).toBe(false);
    expect(originMatches('HTTPS://CLOZR.EXAMPLE.COM', 'https://clozr.example.com')).toBe(true);
  });
});
