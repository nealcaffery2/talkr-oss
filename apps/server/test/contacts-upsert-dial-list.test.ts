/**
 * A partner CRM (CLOZR) pushes its call list and dials it on parallel lines:
 * /v1/contacts/upsert keys on the partner's id (then phone) so a re-push never
 * duplicates, and /v1/contacts/bulk/dial-list lets a rep — who has no
 * campaigns.manage — create a parallel AMD campaign whose leads carry the
 * seller's timezone.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { createTestContext, type TestContext } from './helpers.js';
import { nextApi, repAuth, setPresence, startSessionApi } from './dialer-helpers.js';

let ctx: TestContext;
let rep: Record<string, string>;

type UpsertResult = { external_id: string; contact_id: string | null; status: string; reason?: string };

async function upsert(contacts: unknown[]): Promise<UpsertResult[]> {
  const res = await ctx.app.inject({ method: 'POST', url: '/v1/contacts/upsert', headers: rep, payload: { contacts } });
  expect(res.statusCode).toBe(200);
  return (res.json() as { results: UpsertResult[] }).results;
}

beforeAll(async () => {
  ctx = await createTestContext();
  rep = await repAuth();
});
afterAll(async () => {
  await ctx.close();
});

describe('contacts upsert + parallel dial list', () => {
  let ids: string[] = [];

  it('creates by external id, skips bad numbers, and returns ids in order', async () => {
    const results = await upsert([
      { external_id: 'p-1', name: 'Ann Seller', phones: ['(210) 555-0101'], timezone: 'America/New_York' },
      { external_id: 'p-2', name: 'Bob Seller', phones: ['210-555-0102', '210-555-0112'] },
      { external_id: 'p-3', name: 'No Number', phones: ['call me'] },
      { external_id: 'p-4', name: 'Cy Seller', phones: ['2105550104'], timezone: 'Not/AZone' },
    ]);
    expect(results.map((r) => [r.external_id, r.status])).toEqual([
      ['p-1', 'created'],
      ['p-2', 'created'],
      ['p-3', 'skipped'],
      ['p-4', 'created'],
    ]);
    expect(results[2]!.reason).toBe('invalid_phone');
    ids = results.filter((r) => r.contact_id).map((r) => r.contact_id!);
    const ann = (await ctx.dbh.db.select().from(schema.contacts).where(eq(schema.contacts.id, ids[0]!)))[0]!;
    expect(ann.raw).toMatchObject({ externalId: 'p-1', timezone: 'America/New_York' });
    const cy = (await ctx.dbh.db.select().from(schema.contacts).where(eq(schema.contacts.id, ids[2]!)))[0]!;
    expect((cy.raw as { timezone?: string }).timezone).toBeUndefined();
  });

  it('a re-push merges into the same contacts (by external id, then by phone)', async () => {
    const again = await upsert([
      { external_id: 'p-1', name: 'Ann Seller', phones: ['210-555-0199'] },
      { external_id: 'p-9', name: 'Bob Again', phones: ['210-555-0112'] },
    ]);
    expect(again.map((r) => [r.status, r.contact_id])).toEqual([
      ['merged', ids[0]],
      ['merged', ids[1]],
    ]);
    const annPhones = await ctx.dbh.db
      .select()
      .from(schema.contactPhones)
      .where(eq(schema.contactPhones.contactId, ids[0]!));
    expect(annPhones.map((p) => p.phoneE164).sort()).toEqual(['+12105550101', '+12105550199']);
  });

  it('a rep builds a parallel AMD campaign that dials two lines', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/contacts/bulk/dial-list',
      headers: rep,
      payload: {
        ids,
        name: 'CLOZR list',
        mode: 'parallel',
        settings: {
          parallelLines: 2,
          amdEnabled: true,
          amdAction: 'voicemail_drop',
          amdVoicemailText: 'Hi, this is Sam with Acme Homes.',
          callingWindowStart: '00:00',
          callingWindowEnd: '23:59',
        },
      },
    });
    expect(res.statusCode, res.body).toBe(201);
    const body = res.json() as { campaign_id: string; enrolled: number };
    expect(body.enrolled).toBe(3);
    const campaign = (await ctx.dbh.db.select().from(schema.campaigns).where(eq(schema.campaigns.id, body.campaign_id)))[0]!;
    expect(campaign.mode).toBe('parallel');
    expect(campaign.status).toBe('active');
    expect(campaign.settings).toMatchObject({ parallelLines: 2, amdEnabled: true, amdAction: 'voicemail_drop' });

    const annLead = (await ctx.dbh.db.select().from(schema.leads).where(eq(schema.leads.primaryContactId, ids[0]!)))[0]!;
    expect((annLead.raw as { timezone?: string }).timezone).toBe('America/New_York');

    await setPresence(ctx, ctx.seed.repId, 'available');
    const started = await startSessionApi(ctx, rep, body.campaign_id);
    expect(started.statusCode).toBe(201);
    const next = await nextApi(ctx, rep, started.session!.id);
    expect(next.lines).toHaveLength(2);
    expect(ctx.providerDials).toHaveLength(2);
    expect(ctx.providerDials[0]!.machineDetection).toBe('detect_message_end');
  });

  it('the old power default still holds without a mode', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/v1/contacts/bulk/dial-list',
      headers: rep,
      payload: { ids: [ids[2]], name: 'Plain list' },
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = (res.json() as { campaign_id: string }).campaign_id;
    expect((await ctx.dbh.db.select().from(schema.campaigns).where(eq(schema.campaigns.id, id)))[0]!.mode).toBe('power');
  });
});
