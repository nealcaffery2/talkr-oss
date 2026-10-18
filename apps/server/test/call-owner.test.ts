/**
 * The "own" read scope for calls: a rep sees the calls they handled plus the
 * unanswered ones (missed, voicemail) left on their own line, and not a
 * teammate's. Covers GET /v1/history, GET /v1/calls and GET /v1/calls/:id —
 * the reads the Chrome extension's Recents and Voicemail tabs make.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@talkr/db';
import { authHeader, createTestContext, type TestContext } from './helpers.js';

const REP_LINE = '+15005550041';
const DANA_LINE = '+15005550042';
const SHARED_LINE = '+15005550043';
const SELLER = '+15005550049';

let ctx: TestContext;
let rep: Record<string, string>;
let admin: Record<string, string>;
let danaId: string;
const ids: Record<string, string> = {};

async function insertCall(key: string, values: Partial<typeof schema.calls.$inferInsert>) {
  const row = (
    await ctx.dbh.db
      .insert(schema.calls)
      .values({ orgId: ctx.seed.orgId, direction: 'inbound', status: 'completed', fromNumber: SELLER, toNumber: REP_LINE, ...values })
      .returning()
  )[0]!;
  ids[key] = row.id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  rep = await authHeader('auth-rep-test-org');
  admin = await authHeader('auth-admin-test-org');
  const { db } = ctx.dbh;
  danaId = (
    await db
      .insert(schema.users)
      .values({ orgId: ctx.seed.orgId, email: 'dana-owner@test-org.test', displayName: 'Dana Rep', role: 'rep', authUserId: 'auth-dana-owner' })
      .returning()
  )[0]!.id;
  await db.insert(schema.phoneNumbers).values([
    { orgId: ctx.seed.orgId, phoneE164: REP_LINE, providerNumberId: 'PN_own_rep', assignedUserId: ctx.seed.repId },
    { orgId: ctx.seed.orgId, phoneE164: DANA_LINE, providerNumberId: 'PN_own_dana', assignedUserId: danaId },
    { orgId: ctx.seed.orgId, phoneE164: SHARED_LINE, providerNumberId: 'PN_own_shared' },
  ]);

  await insertCall('handled', { userId: ctx.seed.repId, toNumber: SHARED_LINE, durationSeconds: 60 });
  await insertCall('missedOnMyLine', { toNumber: REP_LINE });
  await insertCall('voicemailForMe', { toNumber: SHARED_LINE, raw: { voicemailOffered: true, voicemailFor: ctx.seed.repId } });
  await insertCall('voicemailForDanaOnMyLine', { toNumber: REP_LINE, raw: { voicemailOffered: true, voicemailFor: danaId } });
  await insertCall('missedOnDanaLine', { toNumber: DANA_LINE });
  await insertCall('missedOnSharedLine', { toNumber: SHARED_LINE });
  await insertCall('danaHandled', { userId: danaId, toNumber: REP_LINE, durationSeconds: 30 });
});
afterAll(async () => ctx.close());

const MINE = ['handled', 'missedOnMyLine', 'voicemailForMe'];
const NOT_MINE = ['voicemailForDanaOnMyLine', 'missedOnDanaLine', 'missedOnSharedLine', 'danaHandled'];

function idsOf(rows: Array<{ id: string }>): Set<string> {
  return new Set(rows.map((r) => r.id));
}

describe('own call scope', () => {
  it('GET /v1/history for a rep: handled calls plus unanswered ones on their line', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/history?type=calls&limit=200', headers: rep });
    expect(res.statusCode).toBe(200);
    const seen = idsOf(res.json().items);
    for (const k of MINE) expect(seen.has(ids[k]!), k).toBe(true);
    for (const k of NOT_MINE) expect(seen.has(ids[k]!), k).toBe(false);
  });

  it('GET /v1/history?user_id= narrows an admin to that rep by the same rule', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/v1/history?type=calls&limit=200&user_id=${ctx.seed.repId}`,
      headers: admin,
    });
    expect(res.statusCode).toBe(200);
    const seen = idsOf(res.json().items);
    for (const k of MINE) expect(seen.has(ids[k]!), k).toBe(true);
    for (const k of NOT_MINE) expect(seen.has(ids[k]!), k).toBe(false);
  });

  it('GET /v1/calls for a rep uses the same rule', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/v1/calls', headers: rep });
    expect(res.statusCode).toBe(200);
    const seen = idsOf(res.json().calls);
    for (const k of MINE) expect(seen.has(ids[k]!), k).toBe(true);
    for (const k of NOT_MINE) expect(seen.has(ids[k]!), k).toBe(false);
  });

  it('GET /v1/calls/:id opens a voicemail on the rep line and refuses a teammate one', async () => {
    const mine = await ctx.app.inject({ method: 'GET', url: `/v1/calls/${ids.missedOnMyLine}`, headers: rep });
    expect(mine.statusCode).toBe(200);
    const theirs = await ctx.app.inject({ method: 'GET', url: `/v1/calls/${ids.missedOnDanaLine}`, headers: rep });
    expect(theirs.statusCode).toBe(403);
  });
});
