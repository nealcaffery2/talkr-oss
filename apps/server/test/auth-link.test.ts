/**
 * A rep added by email only is linked to their auth user on first sign-in.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { signTestToken } from '../src/auth.js';
import { TEST_JWT_SECRET, createTestContext, type TestContext } from './helpers.js';

describe('link by email on first sign-in', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
  });
  afterAll(async () => t.close());

  async function addRep(email: string, authUserId: string | null) {
    const [row] = await t.dbh.db
      .insert(schema.users)
      .values({ orgId: t.seed.orgId, email, displayName: 'New Rep', role: 'rep', status: 'active', authUserId })
      .returning();
    return row!;
  }

  it('claims an unlinked row whose email matches the token, once', async () => {
    const row = await addRep('New.Rep@test-org.test', null);
    const token = await signTestToken(TEST_JWT_SECRET, 'auth-new-rep', { email: 'new.rep@test-org.test' });

    const res = await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().id).toBe(row.id);

    const [after] = await t.dbh.db.select().from(schema.users).where(eq(schema.users.id, row.id));
    expect(after!.authUserId).toBe('auth-new-rep');

    // A different auth user with the same email can no longer take the row.
    const other = await signTestToken(TEST_JWT_SECRET, 'auth-impostor', { email: 'new.rep@test-org.test' });
    const denied = await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${other}` } });
    expect(denied.statusCode).toBe(401);
  });

  it('never reassigns a row already linked to another auth user', async () => {
    await addRep('linked@test-org.test', 'auth-linked');
    const token = await signTestToken(TEST_JWT_SECRET, 'auth-someone-else', { email: 'linked@test-org.test' });
    const res = await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });

  it('does nothing without an email claim', async () => {
    await addRep('noclaim@test-org.test', null);
    const token = await signTestToken(TEST_JWT_SECRET, 'auth-no-claim');
    const res = await t.app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(401);
  });
});
