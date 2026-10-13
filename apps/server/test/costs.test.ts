/**
 * Phase 6 cost ledger (docs/reporting.md §3): extraction from webhook Price
 * fields and reconciliation-backfilled call prices, structural idempotency,
 * and the "no cost data" vs "$0.00" distinction in the report.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { enqueueJob, schema } from '@talkr/db';
import { authHeader, createTestContext, webhookPost, type TestContext } from './helpers.js';
import { twimlOutbound, voiceStatus } from './fixtures/texml.js';
import { parsePriceMagnitude } from '../src/worker/costs.js';

let ctx: TestContext;
let repAuth: Record<string, string>;
let managerAuth: Record<string, string>;

beforeAll(async () => {
  ctx = await createTestContext();
  repAuth = await authHeader('auth-rep-test-org');
  const manager = (
    await ctx.dbh.db
      .insert(schema.users)
      .values({
        orgId: ctx.seed.orgId,
        email: 'manager@test-org.test',
        displayName: 'Mandy Manager',
        role: 'manager',
        authUserId: 'auth-manager-test-org',
      })
      .returning()
  )[0]!;
  managerAuth = await authHeader(manager.authUserId!);
});
afterAll(async () => {
  await ctx.close();
});

async function runCostSweep(runTag: string) {
  await enqueueJob(ctx.dbh.db, {
    jobType: 'extract-provider-costs',
    payload: {},
    dedupeKey: `extract-provider-costs:test:${runTag}`,
  });
  await ctx.runner.drain();
}

async function ledgerRows() {
  return ctx.dbh.db.select().from(schema.providerCosts).orderBy(schema.providerCosts.createdAt);
}

/** Drive an outbound browser call to completed through the real pipeline. */
async function driveCall(tag: string, opts: { price?: string; priceUnit?: string } = {}) {
  const created = await ctx.app.inject({
    method: 'POST',
    url: '/v1/calls',
    headers: repAuth,
    payload: { to_number: '+16145550142' },
  });
  expect(created.statusCode).toBe(201);
  const callId = (created.json() as { call: { id: string } }).call.id;
  await webhookPost(
    ctx,
    '/twiml/outbound-dial',
    twimlOutbound({ clientCallSid: `CA_client_${tag}`, talkrCallId: callId, identity: ctx.seed.repId }),
  );
  const path = `/webhooks/telnyx/voice-status?call=${callId}&leg=pstn`;
  await webhookPost(ctx, path, voiceStatus({
    callSid: `CA_pstn_${tag}`, status: 'in-progress', sequence: 0, parentCallSid: `CA_client_${tag}`,
  }));
  const completedParams = voiceStatus({
    callSid: `CA_pstn_${tag}`, status: 'completed', sequence: 1,
    parentCallSid: `CA_client_${tag}`, duration: 42,
  });
  if (opts.price) {
    completedParams.Price = opts.price;
    completedParams.PriceUnit = opts.priceUnit ?? 'USD';
  }
  await webhookPost(ctx, path, completedParams);
  await ctx.runner.drain();
  return callId;
}

describe('parsePriceMagnitude (unit)', () => {
  it('normalizes Twilio negative prices to magnitude and rejects junk', () => {
    expect(parsePriceMagnitude('-0.0085')).toBe('0.008500');
    expect(parsePriceMagnitude('0.014')).toBe('0.014000');
    expect(parsePriceMagnitude('')).toBeNull();
    expect(parsePriceMagnitude('abc')).toBeNull();
    expect(parsePriceMagnitude(undefined)).toBeNull();
    expect(parsePriceMagnitude(null)).toBeNull();
  });
});

describe('extraction', () => {
  it('absent prices produce no ledger rows and the report says "no data"', async () => {
    await driveCall('noprice'); // simulated traffic: no Price fields anywhere
    await runCostSweep('empty');
    expect(await ledgerRows()).toHaveLength(0);

    const res = await ctx.app.inject({
      method: 'GET', url: '/v1/reports/costs', headers: managerAuth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { has_data: boolean; total: unknown[] };
    expect(body.has_data).toBe(false);
    expect(body.total).toHaveLength(0);
  });

  it('a webhook payload with Price fields becomes exactly one ledger row', async () => {
    const callId = await driveCall('priced', { price: '-0.0085', priceUnit: 'USD' });
    await runCostSweep('webhook-1');

    const rows = await ledgerRows();
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.orgId).toBe(ctx.seed.orgId);
    expect(row.callId).toBe(callId);
    expect(row.provider).toBe('telnyx');
    expect(row.itemType).toBe('call');
    expect(row.providerRef).toBe('CA_pstn_priced');
    expect(Number(row.amount)).toBeCloseTo(0.0085, 10);
    expect(row.currency).toBe('USD');
    expect((row.raw as { source: string }).source).toBe('webhook');
    expect(row.occurredAt).not.toBeNull();
  });

  it('duplicate sweep runs never duplicate rows (structural idempotency)', async () => {
    await runCostSweep('webhook-2');
    await runCostSweep('webhook-3');
    expect(await ledgerRows()).toHaveLength(1);
  });

  it('reconciliation-backfilled prices land under the truth-leg SID', async () => {
    // Provider REST truth carries the price; the reconcile job (already run
    // as part of the pipeline) backfills calls.price_cents. The sweep reads
    // that — without touching the reconcile service.
    ctx.providerCalls.set('CA_pstn_recon', {
      providerCallId: 'CA_pstn_recon',
      status: 'completed',
      durationSeconds: 42,
      priceCents: 4,
      priceCurrency: 'USD',
      raw: {},
    });
    const callId = await driveCall('recon'); // no webhook Price
    const call = (
      await ctx.dbh.db.select().from(schema.calls).where(eq(schema.calls.id, callId))
    )[0]!;
    expect(call.priceCents).toBe(4); // reconcile did its Phase 2 job

    await runCostSweep('recon-1');
    await runCostSweep('recon-2'); // idempotent again

    const rows = await ledgerRows();
    expect(rows).toHaveLength(2); // priced webhook row + reconciled row
    const recon = rows.find((r) => r.providerRef === 'CA_pstn_recon')!;
    expect(recon.callId).toBe(callId);
    expect(Number(recon.amount)).toBeCloseTo(0.04, 10);
    expect(recon.currency).toBe('USD');
    expect((recon.raw as { source: string }).source).toBe('reconciliation');
  });
});

describe('costs report', () => {
  it('spend by day/type/rep with data, and per-rep cost joins into by-rep', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/v1/reports/costs', headers: managerAuth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      has_data: boolean;
      total: Array<{ currency: string; amount: string; items: number }>;
      by_day: Array<{ day: string; currency: string; amount: string }>;
      by_type: Array<{ item_type: string; currency: string; amount: string; items: number }>;
      by_rep: Array<{ user_id: string | null; display_name: string | null; currency: string; amount: string }>;
    };
    expect(body.has_data).toBe(true);
    expect(body.total).toHaveLength(1);
    expect(body.total[0]!.currency).toBe('USD');
    expect(Number(body.total[0]!.amount)).toBeCloseTo(0.0485, 10);
    expect(body.total[0]!.items).toBe(2);

    expect(body.by_type).toHaveLength(1);
    expect(body.by_type[0]!.item_type).toBe('call');
    expect(Number(body.by_type[0]!.amount)).toBeCloseTo(0.0485, 10);

    // Both calls ended today (org tz) — one daily bucket carrying the total.
    expect(body.by_day).toHaveLength(1);
    expect(Number(body.by_day[0]!.amount)).toBeCloseTo(0.0485, 10);

    expect(body.by_rep).toHaveLength(1);
    expect(body.by_rep[0]!.display_name).toBe('Riley Rep');
    expect(Number(body.by_rep[0]!.amount)).toBeCloseTo(0.0485, 10);

    // The by-rep report carries the same spend; cost is null only when
    // there is genuinely no data.
    const byRep = await ctx.app.inject({
      method: 'GET', url: '/v1/reports/by-rep', headers: managerAuth,
    });
    const reps = (byRep.json() as {
      reps: Array<{ display_name: string; cost: Record<string, string> | null }>;
    }).reps;
    const riley = reps.find((r) => r.display_name === 'Riley Rep')!;
    expect(riley.cost).not.toBeNull();
    expect(Number(riley.cost!.USD)).toBeCloseTo(0.0485, 10);
    const admin = reps.find((r) => r.display_name === 'Alex Admin')!;
    expect(admin.cost).toBeNull();
  });

  it('a range with no ledger rows is "no data", not $0.00', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/v1/reports/costs?from=2020-01-01&to=2020-01-07',
      headers: managerAuth,
    });
    const body = res.json() as { has_data: boolean; total: unknown[] };
    expect(body.has_data).toBe(false);
    expect(body.total).toHaveLength(0);
  });
});
