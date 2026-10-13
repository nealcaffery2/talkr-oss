/**
 * Phase 6 reporting: every metric definition pinned against real Postgres
 * with hand-computed expectations (docs/reporting.md §2). Calls are seeded
 * directly with exact timestamps — reports are the READ side; the write
 * pipeline that produces these rows is pinned by the Phase 2/3 suites.
 *
 * Scripted week (org timezone America/New_York, EDT = UTC-4 in August),
 * report range 2026-08-17 .. 2026-08-23 (local days):
 *
 *  c1  out repA answered   Aug17 14:00Z  talk 120s  disp follow_up wrap 60s
 *  c2  out repA no_answer  Aug17 15:00Z             disp no_answer wrap 30s
 *  c3  out repA busy       Aug18 16:00Z
 *  c4  out repB answered   Aug19 17:00Z  talk 180s  disp offer_made wrap 90s
 *  c5  out repB failed     Aug20 12:00Z  carrier_failure
 *  c6  out repA failed     Aug20 12:30Z  platform_failure
 *  c7  in  repA answered   Aug21 13:00Z  talk 60s
 *  c8  in  repA MISSED     Aug21 14:00Z  completed, voicemail left
 *  c9  in  --   MISSED     Aug22 15:00Z  no_answer (hangup during ring)
 *  c10 in  repB answered   Aug19 03:30Z = Aug18 23:30 LOCAL  talk 90s  ← midnight
 *  c11 out repA in-flight  Aug23 18:00Z  in_progress (answered, not ended)
 *  c12 out repA answered   Aug16 12:00Z  ← before range (excluded)
 *  c13 out repA answered   Aug24 04:30Z = Aug24 00:30 LOCAL ← after range (excluded)
 *  c14 out repB answered   Aug24 03:30Z = Aug23 23:30 LOCAL  talk 30s ← in range
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { authHeader, createTestContext, type TestContext } from './helpers.js';
import { seedDemoOrg } from '../src/seed.js';
import { localDayString, resolveRange, ReportRangeError } from '../src/services/reports.js';

let ctx: TestContext;
let repAuth: Record<string, string>;
let managerAuth: Record<string, string>;
let repA: string;
let repB: string;
const FROM = '2026-08-17';
const TO = '2026-08-23';
const RANGE = `from=${FROM}&to=${TO}`;

type CallSeed = {
  direction: 'outbound' | 'inbound';
  status: 'queued' | 'initiated' | 'ringing' | 'in_progress' | 'completed' | 'no_answer' | 'busy' | 'failed' | 'canceled';
  userId?: string | null;
  initiatedAt: string;
  answeredAt?: string;
  endedAt?: string;
  durationSeconds?: number;
  failureClass?: 'none' | 'seller_no_answer' | 'seller_busy' | 'carrier_failure' | 'platform_failure' | 'canceled';
  dispositionSlug?: string;
  wrapupAfterEndSeconds?: number;
  raw?: Record<string, unknown>;
  orgId?: string;
};

const inserted: Record<string, string> = {};

async function seedCall(name: string, seed: CallSeed): Promise<string> {
  const orgId = seed.orgId ?? ctx.seed.orgId;
  let dispositionId: string | null = null;
  if (seed.dispositionSlug) {
    const d = (
      await ctx.dbh.db
        .select()
        .from(schema.callDispositions)
        .where(
          and(
            eq(schema.callDispositions.orgId, orgId),
            eq(schema.callDispositions.slug, seed.dispositionSlug),
          ),
        )
        .limit(1)
    )[0]!;
    dispositionId = d.id;
  }
  const ended = seed.endedAt ? new Date(seed.endedAt) : null;
  const row = (
    await ctx.dbh.db
      .insert(schema.calls)
      .values({
        orgId,
        direction: seed.direction,
        status: seed.status,
        userId: seed.userId ?? null,
        fromNumber: seed.direction === 'outbound' ? '+15005550006' : '+16145550042',
        toNumber: seed.direction === 'outbound' ? '+16145550042' : '+15005550006',
        provider: 'twilio',
        providerCallId: `CA_report_${name}`,
        initiatedAt: new Date(seed.initiatedAt),
        answeredAt: seed.answeredAt ? new Date(seed.answeredAt) : null,
        endedAt: ended,
        durationSeconds: seed.durationSeconds ?? null,
        failureClass: seed.failureClass ?? 'none',
        dispositionId,
        wrapupCompletedAt:
          ended && seed.wrapupAfterEndSeconds != null
            ? new Date(ended.getTime() + seed.wrapupAfterEndSeconds * 1000)
            : null,
        raw: seed.raw ?? {},
      })
      .returning({ id: schema.calls.id })
  )[0]!;
  inserted[name] = row.id;
  return row.id;
}

beforeAll(async () => {
  ctx = await createTestContext();
  repAuth = await authHeader('auth-rep-test-org');
  repA = ctx.seed.repId;

  await ctx.dbh.db
    .update(schema.organizations)
    .set({ settings: { timezone: 'America/New_York' } })
    .where(eq(schema.organizations.id, ctx.seed.orgId));

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

  const bella = (
    await ctx.dbh.db
      .insert(schema.users)
      .values({
        orgId: ctx.seed.orgId,
        email: 'repb@test-org.test',
        displayName: 'Bella Rep',
        role: 'rep',
        authUserId: 'auth-repb-test-org',
      })
      .returning()
  )[0]!;
  repB = bella.id;

  // The scripted week.
  await seedCall('c1', {
    direction: 'outbound', status: 'completed', userId: repA,
    initiatedAt: '2026-08-17T14:00:00Z', answeredAt: '2026-08-17T14:00:30Z',
    endedAt: '2026-08-17T14:02:30Z', durationSeconds: 125,
    dispositionSlug: 'follow_up', wrapupAfterEndSeconds: 60,
  });
  await seedCall('c2', {
    direction: 'outbound', status: 'no_answer', userId: repA,
    initiatedAt: '2026-08-17T15:00:00Z', endedAt: '2026-08-17T15:00:25Z',
    failureClass: 'seller_no_answer', dispositionSlug: 'no_answer', wrapupAfterEndSeconds: 30,
  });
  await seedCall('c3', {
    direction: 'outbound', status: 'busy', userId: repA,
    initiatedAt: '2026-08-18T16:00:00Z', endedAt: '2026-08-18T16:00:20Z',
    failureClass: 'seller_busy',
  });
  await seedCall('c4', {
    direction: 'outbound', status: 'completed', userId: repB,
    initiatedAt: '2026-08-19T17:00:00Z', answeredAt: '2026-08-19T17:00:10Z',
    endedAt: '2026-08-19T17:03:10Z', durationSeconds: 185,
    dispositionSlug: 'offer_made', wrapupAfterEndSeconds: 90,
  });
  await seedCall('c5', {
    direction: 'outbound', status: 'failed', userId: repB,
    initiatedAt: '2026-08-20T12:00:00Z', endedAt: '2026-08-20T12:00:05Z',
    failureClass: 'carrier_failure',
  });
  await seedCall('c6', {
    direction: 'outbound', status: 'failed', userId: repA,
    initiatedAt: '2026-08-20T12:30:00Z', endedAt: '2026-08-20T12:30:02Z',
    failureClass: 'platform_failure',
  });
  await seedCall('c7', {
    direction: 'inbound', status: 'completed', userId: repA,
    initiatedAt: '2026-08-21T13:00:00Z', answeredAt: '2026-08-21T13:00:08Z',
    endedAt: '2026-08-21T13:01:08Z', durationSeconds: 68,
  });
  await seedCall('c8', {
    direction: 'inbound', status: 'completed', userId: repA,
    initiatedAt: '2026-08-21T14:00:00Z', endedAt: '2026-08-21T14:00:45Z',
    durationSeconds: 45, raw: { voicemailOffered: true, voicemailReason: 'no_answer', voicemailLeft: true },
  });
  await seedCall('c9', {
    direction: 'inbound', status: 'no_answer', userId: null,
    initiatedAt: '2026-08-22T15:00:00Z', endedAt: '2026-08-22T15:00:20Z',
    failureClass: 'seller_no_answer',
  });
  await seedCall('c10', {
    direction: 'inbound', status: 'completed', userId: repB,
    initiatedAt: '2026-08-19T03:30:00Z', answeredAt: '2026-08-19T03:30:10Z',
    endedAt: '2026-08-19T03:31:40Z', durationSeconds: 100,
  });
  await seedCall('c11', {
    direction: 'outbound', status: 'in_progress', userId: repA,
    initiatedAt: '2026-08-23T18:00:00Z', answeredAt: '2026-08-23T18:00:05Z',
  });
  await seedCall('c12', {
    direction: 'outbound', status: 'completed', userId: repA,
    initiatedAt: '2026-08-16T12:00:00Z', answeredAt: '2026-08-16T12:00:05Z',
    endedAt: '2026-08-16T12:01:05Z', durationSeconds: 65,
  });
  await seedCall('c13', {
    direction: 'outbound', status: 'completed', userId: repA,
    initiatedAt: '2026-08-24T04:30:00Z', answeredAt: '2026-08-24T04:30:05Z',
    endedAt: '2026-08-24T04:31:05Z', durationSeconds: 65,
  });
  await seedCall('c14', {
    direction: 'outbound', status: 'completed', userId: repB,
    initiatedAt: '2026-08-24T03:30:00Z', answeredAt: '2026-08-24T03:30:10Z',
    endedAt: '2026-08-24T03:30:40Z', durationSeconds: 35,
  });

  // Cross-org isolation: a busy week in another org must never leak in.
  const other = await seedDemoOrg(ctx.dbh.db, {
    slug: 'other-org-p6',
    phoneE164: '+15005550701',
    contactPhone: '+15005550702',
  });
  await seedCall('other1', {
    orgId: other.orgId, direction: 'outbound', status: 'completed', userId: other.repId,
    initiatedAt: '2026-08-19T12:00:00Z', answeredAt: '2026-08-19T12:00:05Z',
    endedAt: '2026-08-19T12:01:05Z', durationSeconds: 65,
  });

  // Speed-to-lead ladder rows (received in range).
  await ctx.dbh.db.insert(schema.leads).values([
    {
      orgId: ctx.seed.orgId, source: 'ppc',
      receivedAt: new Date('2026-08-18T12:00:00Z'),
      firstAttemptAt: new Date('2026-08-18T12:02:00Z'),
    },
    {
      orgId: ctx.seed.orgId, source: 'ppc',
      receivedAt: new Date('2026-08-19T12:00:00Z'),
      firstAttemptAt: new Date('2026-08-19T12:04:00Z'),
    },
    {
      orgId: ctx.seed.orgId, source: 'ppc',
      receivedAt: new Date('2026-08-20T12:00:00Z'),
    },
  ]);

  // Quality inputs: mismatches (one open, one resolved, plus noise rows that
  // must not count: another org's row and a null-org orphan).
  await ctx.dbh.db.insert(schema.reconciliationMismatches).values([
    {
      orgId: ctx.seed.orgId, objectType: 'call', objectId: inserted.c1, provider: 'twilio',
      field: 'duration_seconds', internalValue: '120', providerValue: '125',
      detectedAt: new Date('2026-08-17T15:00:00Z'),
    },
    {
      orgId: ctx.seed.orgId, objectType: 'call', objectId: inserted.c4, provider: 'twilio',
      field: 'status', internalValue: 'failed', providerValue: 'no-answer',
      detectedAt: new Date('2026-08-19T18:00:00Z'), resolvedAt: new Date('2026-08-19T19:00:00Z'),
      resolution: 'corrected',
    },
    {
      orgId: other.orgId, objectType: 'call', objectId: null, provider: 'twilio',
      field: 'status', detectedAt: new Date('2026-08-19T18:00:00Z'),
    },
    {
      orgId: null, objectType: 'orphan_provider_call', provider: 'twilio',
      providerObjectId: 'CA_orphan_x', field: 'call',
      detectedAt: new Date('2026-08-19T18:00:00Z'),
    },
  ]);

  // Recordings: c1 has one (fine), c4's failed, c7/c10/c14 missing.
  await ctx.dbh.db.insert(schema.recordings).values([
    {
      orgId: ctx.seed.orgId, callId: inserted.c1!, providerRecordingId: 'RE_rep_c1',
      status: 'completed', durationSeconds: 120, channels: 2,
    },
    {
      orgId: ctx.seed.orgId, callId: inserted.c4!, providerRecordingId: 'RE_rep_c4',
      status: 'failed', errorCode: 'ERR',
    },
  ]);
});
afterAll(async () => {
  await ctx.close();
});

describe('range resolution (unit)', () => {
  it('defaults to the last 7 local days including today', () => {
    const now = new Date('2026-08-25T02:00:00Z'); // Aug 24 22:00 in New York
    const range = resolveRange({}, 'America/New_York', now);
    expect(range.to).toBe('2026-08-24');
    expect(range.from).toBe('2026-08-18');
  });

  it('rejects malformed and impossible dates and inverted ranges', () => {
    expect(() => resolveRange({ from: '2026-8-1', to: TO }, 'America/New_York')).toThrow(ReportRangeError);
    expect(() => resolveRange({ from: '2026-02-30', to: TO }, 'America/New_York')).toThrow(ReportRangeError);
    expect(() => resolveRange({ from: TO, to: FROM }, 'America/New_York')).toThrow(ReportRangeError);
    expect(() => resolveRange({ from: '2020-01-01', to: '2026-01-01' }, 'America/New_York')).toThrow(
      ReportRangeError,
    );
  });

  it('localDayString matches the Intl evaluation the router uses', () => {
    expect(localDayString(new Date('2026-08-19T03:30:00Z'), 'America/New_York')).toBe('2026-08-18');
    expect(localDayString(new Date('2026-08-19T03:30:00Z'), 'UTC')).toBe('2026-08-19');
  });
});

describe('RBAC and validation', () => {
  it('rep-level tokens cannot read org-wide reports; manager can', async () => {
    const asRep = await ctx.app.inject({
      method: 'GET', url: `/v1/reports/overview?${RANGE}`, headers: repAuth,
    });
    expect(asRep.statusCode).toBe(403);
    const asManager = await ctx.app.inject({
      method: 'GET', url: `/v1/reports/overview?${RANGE}`, headers: managerAuth,
    });
    expect(asManager.statusCode).toBe(200);
    const anon = await ctx.app.inject({ method: 'GET', url: `/v1/reports/overview?${RANGE}` });
    expect(anon.statusCode).toBe(401);
  });

  it('date-range validation edges are 400s, never silent clamps', async () => {
    for (const [qs, code] of [
      ['from=2026-8-1&to=2026-08-23', 'invalid_date'],
      ['from=2026-02-30&to=2026-08-23', 'invalid_date'],
      ['from=2026-08-23&to=2026-08-17', 'invalid_range'],
      ['from=2020-01-01&to=2026-01-01', 'range_too_large'],
    ] as const) {
      const res = await ctx.app.inject({
        method: 'GET', url: `/v1/reports/overview?${qs}`, headers: managerAuth,
      });
      expect(res.statusCode).toBe(400);
      expect((res.json() as { error: string }).error).toBe(code);
    }
  });

  it('defaults (no params) resolve to last-7-days and succeed', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: '/v1/reports/overview', headers: managerAuth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { range: { from: string; to: string; timezone: string } };
    expect(body.range.timezone).toBe('America/New_York');
    expect(body.range.to >= body.range.from).toBe(true);
  });
});

describe('overview', () => {
  it('every number matches the hand-computed expectation', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: `/v1/reports/overview?${RANGE}`, headers: managerAuth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      totals: Record<string, number>;
      answer_rate: { outbound: number | null; inbound: number | null };
      talk: { total_seconds: number; avg_seconds: number | null; calls_with_talk: number };
      speed_to_lead: { avg_seconds: number | null; leads_received: number; leads_awaiting_first_attempt: number };
      dispositions: Array<{ slug: string; count: number }>;
    };

    // 12 in-range calls: c1..c11 + c14 (c12 before, c13 after the local range).
    expect(body.totals.total).toBe(12);
    expect(body.totals.outbound).toBe(8);
    expect(body.totals.inbound).toBe(4);
    expect(body.totals.answered).toBe(6); // c1 c4 c7 c10 c11 c14
    expect(body.totals.answered_outbound).toBe(4);
    expect(body.totals.answered_inbound).toBe(2);
    expect(body.totals.missed).toBe(2); // c8 (voicemail) + c9 (ring hangup)
    expect(body.totals.voicemails_left).toBe(1); // c8 only
    expect(body.totals.undispositioned).toBe(9); // all but c1 c2 c4

    // Rates over terminal calls only (c11 in-flight excluded from both sides).
    expect(body.answer_rate.outbound).toBeCloseTo(4 / 7, 10);
    expect(body.answer_rate.inbound).toBeCloseTo(2 / 4, 10);

    // Talk = answered→ended: 120 + 180 + 60 + 90 + 30 = 480 over 5 calls.
    expect(body.talk.total_seconds).toBe(480);
    expect(body.talk.calls_with_talk).toBe(5);
    expect(body.talk.avg_seconds).toBeCloseTo(96, 10);

    // Speed to lead: (120 + 240) / 2 = 180s; one lead still awaiting.
    expect(body.speed_to_lead.avg_seconds).toBeCloseTo(180, 10);
    expect(body.speed_to_lead.leads_received).toBe(3);
    expect(body.speed_to_lead.leads_awaiting_first_attempt).toBe(1);

    const dispositions = Object.fromEntries(body.dispositions.map((d) => [d.slug, d.count]));
    expect(dispositions).toEqual({ follow_up: 1, no_answer: 1, offer_made: 1 });
  });

  it('missed-call definition: answered-then-completed vs voicemail vs ring-hangup', async () => {
    // Pinned by construction above, verified against the daily buckets: the
    // two misses land on Aug 21 (voicemail) and Aug 22 (ring hangup); the
    // answered inbound calls (c7, c10) never count.
    const res = await ctx.app.inject({
      method: 'GET', url: `/v1/reports/by-day?${RANGE}`, headers: managerAuth,
    });
    const days = (res.json() as { days: Array<{ day: string; missed: number }> }).days;
    const missedByDay = Object.fromEntries(days.map((d) => [d.day, d.missed]));
    expect(missedByDay['2026-08-21']).toBe(1);
    expect(missedByDay['2026-08-22']).toBe(1);
    expect(days.reduce((a, d) => a + d.missed, 0)).toBe(2);
  });
});

describe('by-rep', () => {
  it('per-rep numbers match, zero-activity users included', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: `/v1/reports/by-rep?${RANGE}`, headers: managerAuth,
    });
    expect(res.statusCode).toBe(200);
    const reps = (res.json() as {
      reps: Array<{
        display_name: string; calls_made: number; calls_received: number; answered: number;
        talk_seconds: number; avg_wrapup_seconds: number | null;
        dispositions: Record<string, number>; cost: Record<string, string> | null;
      }>;
    }).reps;

    expect(reps.map((r) => r.display_name)).toEqual([
      'Alex Admin', 'Bella Rep', 'Mandy Manager', 'Riley Rep',
    ]);

    const riley = reps.find((r) => r.display_name === 'Riley Rep')!;
    expect(riley.calls_made).toBe(5); // c1 c2 c3 c6 c11
    expect(riley.calls_received).toBe(2); // c7 c8
    expect(riley.answered).toBe(3); // c1 c7 c11
    expect(riley.talk_seconds).toBe(180); // c1 120 + c7 60 (c11 not ended)
    expect(riley.avg_wrapup_seconds).toBeCloseTo(45, 10); // (60 + 30) / 2
    expect(riley.dispositions).toEqual({ follow_up: 1, no_answer: 1 });
    expect(riley.cost).toBeNull(); // no ledger rows: no data, not $0.00

    const bella = reps.find((r) => r.display_name === 'Bella Rep')!;
    expect(bella.calls_made).toBe(3); // c4 c5 c14
    expect(bella.calls_received).toBe(1); // c10
    expect(bella.answered).toBe(3); // c4 c10 c14
    expect(bella.talk_seconds).toBe(300); // 180 + 90 + 30
    expect(bella.avg_wrapup_seconds).toBeCloseTo(90, 10);
    expect(bella.dispositions).toEqual({ offer_made: 1 });

    const admin = reps.find((r) => r.display_name === 'Alex Admin')!;
    expect(admin.calls_made).toBe(0);
    expect(admin.calls_received).toBe(0);
    expect(admin.answered).toBe(0);
    expect(admin.talk_seconds).toBe(0);
    expect(admin.avg_wrapup_seconds).toBeNull();
    expect(admin.dispositions).toEqual({});
  });
});

describe('by-day (timezone bucketing must be provably right)', () => {
  it('a 23:30 America/New_York call lands on the local day, not the UTC day', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: `/v1/reports/by-day?${RANGE}`, headers: managerAuth,
    });
    expect(res.statusCode).toBe(200);
    const days = (res.json() as {
      days: Array<{ day: string; total: number; outbound: number; inbound: number; answered: number; missed: number }>;
    }).days;

    expect(days.map((d) => d.day)).toEqual([
      '2026-08-17', '2026-08-18', '2026-08-19', '2026-08-20',
      '2026-08-21', '2026-08-22', '2026-08-23',
    ]);
    const byDay = Object.fromEntries(days.map((d) => [d.day, d]));

    // c10 (Aug 19 03:30Z) is Aug 18 23:30 local → counts on Aug 18, NOT Aug 19.
    expect(byDay['2026-08-18']).toMatchObject({ total: 2, outbound: 1, inbound: 1, answered: 1, missed: 0 });
    expect(byDay['2026-08-19']).toMatchObject({ total: 1, outbound: 1, inbound: 0, answered: 1, missed: 0 });

    // c14 (Aug 24 03:30Z = Aug 23 23:30 local) is in; c13 (Aug 24 00:30 local) is out.
    expect(byDay['2026-08-23']).toMatchObject({ total: 2, outbound: 2, inbound: 0, answered: 2, missed: 0 });

    expect(byDay['2026-08-17']).toMatchObject({ total: 2, outbound: 2, inbound: 0, answered: 1, missed: 0 });
    expect(byDay['2026-08-20']).toMatchObject({ total: 2, outbound: 2, inbound: 0, answered: 0, missed: 0 });
    expect(byDay['2026-08-21']).toMatchObject({ total: 2, outbound: 0, inbound: 2, answered: 1, missed: 1 });
    expect(byDay['2026-08-22']).toMatchObject({ total: 1, outbound: 0, inbound: 1, answered: 0, missed: 1 });

    expect(days.reduce((a, d) => a + d.total, 0)).toBe(12);
  });
});

describe('quality', () => {
  it('failure classes, trend, mismatches, and recording gaps', async () => {
    const res = await ctx.app.inject({
      method: 'GET', url: `/v1/reports/quality?${RANGE}`, headers: managerAuth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      failure_classes: Record<string, number>;
      carrier_failure_trend: Array<{ day: string; carrier_failures: number; terminal_calls: number }>;
      mismatches: { open: number; resolved: number };
      recordings: { missing: number; failed: number };
    };

    // 11 terminal calls (c11 in-flight excluded).
    expect(body.failure_classes).toEqual({
      none: 6, // c1 c4 c7 c8 c10 c14
      seller_no_answer: 2, // c2 c9
      seller_busy: 1, // c3
      carrier_failure: 1, // c5
      platform_failure: 1, // c6
      canceled: 0,
    });

    const trend = Object.fromEntries(body.carrier_failure_trend.map((d) => [d.day, d]));
    expect(trend['2026-08-20']).toMatchObject({ carrier_failures: 1, terminal_calls: 2 });
    expect(trend['2026-08-17']).toMatchObject({ carrier_failures: 0, terminal_calls: 2 });
    expect(trend['2026-08-23']).toMatchObject({ carrier_failures: 0, terminal_calls: 1 }); // c14 only

    // Org-scoped: the other org's row and the null-org orphan don't count.
    expect(body.mismatches).toEqual({ open: 1, resolved: 1 });

    // Answered+completed calls past the grace period: c1 (has recording),
    // c4 (failed recording), c7 c10 c14 (nothing at all).
    expect(body.recordings.missing).toBe(3);
    expect(body.recordings.failed).toBe(1);
  });
});

describe('org scoping', () => {
  it('the other org sees only its own week', async () => {
    const otherManagerAuth = await authHeader('auth-admin-other-org-p6');
    const res = await ctx.app.inject({
      method: 'GET', url: `/v1/reports/overview?${RANGE}`, headers: otherManagerAuth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { totals: { total: number } };
    expect(body.totals.total).toBe(1); // just other1
  });
});

describe('floor RBAC', () => {
  it('floor.view is manager-level: rep 403, manager 200', async () => {
    const asRep = await ctx.app.inject({ method: 'GET', url: '/v1/floor/state', headers: repAuth });
    expect(asRep.statusCode).toBe(403);
    const asManager = await ctx.app.inject({ method: 'GET', url: '/v1/floor/state', headers: managerAuth });
    expect(asManager.statusCode).toBe(200);
  });
});
