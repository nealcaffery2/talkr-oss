/**
 * Browser credentials without a button: on a carrier that needs one (Telnyx),
 * loading /v1/me mints it, adding a teammate mints it, and the boot-time sweep
 * catches everyone else.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { provisionBrowserCredentials } from '../src/services/provision.js';
import { authHeader, createTestContext, type TestContext } from './helpers.js';

describe('credential provisioning on Telnyx', () => {
  let t: TestContext;
  let rep: Record<string, string>;
  let admin: Record<string, string>;
  beforeAll(async () => {
    t = await createTestContext({ provisionCredentials: false });
    rep = await authHeader('auth-rep-test-org');
    admin = await authHeader('auth-admin-test-org');
  });
  afterAll(async () => t.close());

  const credentialsFor = (userId: string) =>
    t.dbh.db.select().from(schema.telephonyCredentials).where(eq(schema.telephonyCredentials.userId, userId));

  it('loading /v1/me mints the credential once', async () => {
    expect(await credentialsFor(t.seed.repId)).toHaveLength(0);
    const res = await t.app.inject({ method: 'GET', url: '/v1/me', headers: rep });
    expect(res.statusCode).toBe(200);
    const rows = await credentialsFor(t.seed.repId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ provider: 'telnyx', sipUsername: expect.stringMatching(/^gencred/) });
    await t.app.inject({ method: 'GET', url: '/v1/me', headers: rep });
    expect(await credentialsFor(t.seed.repId)).toHaveLength(1);
  });

  it('the rep can now be rung for an outbound call without ever enabling a softphone', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/v1/calls', headers: rep, payload: { to_number: '+12165550143' } });
    const rung = await t.app.inject({ method: 'POST', url: `/v1/calls/${created.json().call.id}/browser-leg`, headers: rep });
    expect(rung.statusCode).toBe(202);
    expect(t.providerDials[0]!.to).toMatch(/^sip:gencred.*@sip\.telnyx\.com$/);
  });

  it('adding a teammate mints theirs', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/team/members',
      headers: admin,
      payload: { email: 'newrep@example.test', display_name: 'New Rep', role: 'rep' },
    });
    expect(res.statusCode).toBe(201);
    const id = res.json().member.id as string;
    // The mint is fire-and-forget; give the event loop a turn.
    await new Promise((r) => setTimeout(r, 50));
    expect(await credentialsFor(id)).toHaveLength(1);
  });

  it('the sweep covers everyone left, and is idempotent', async () => {
    const first = await provisionBrowserCredentials(t.dbh, t.provider);
    // The admin never loaded /v1/me in this file.
    expect(first.minted).toContain(t.seed.adminId);
    expect(first.failed).toEqual([]);
    const second = await provisionBrowserCredentials(t.dbh, t.provider);
    expect(second.minted).toEqual([]);
  });
});
