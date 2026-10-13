/**
 * Phase 6 live floor view (docs/reporting.md §4): snapshot correctness with
 * a controlled clock — active calls attributed to the right rep, stale
 * presence excluded from freshness, today's counters bucketed in org tz,
 * queue depth counting only callers still in queue treatment.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { authHeader, createTestContext, type TestContext } from './helpers.js';
import { floorSnapshot } from '../src/services/reports.js';

let ctx: TestContext;
let managerAuth: Record<string, string>;
let repAuth: Record<string, string>;
let repA: string;
let repB: string;
let queueId: string;

// Fixed clock: 2026-08-25 12:00 ET (16:00Z). "Today" local = 2026-08-25.
const NOW = new Date('2026-08-25T16:00:00Z');
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

beforeAll(async () => {
  ctx = await createTestContext();
  const { db } = ctx.dbh;
  repA = ctx.seed.repId;
  repAuth = await authHeader('auth-rep-test-org');

  await db
    .update(schema.organizations)
    .set({ settings: { timezone: 'America/New_York' } })
    .where(eq(schema.organizations.id, ctx.seed.orgId));

  const manager = (
    await db
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
    await db
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

  // Presence: repA fresh-available; repB available but stale (5 min old);
  // everyone else has no presence row at all.
  await db.insert(schema.agentPresence).values([
    { userId: repA, orgId: ctx.seed.orgId, status: 'available', lastSeenAt: minutesAgo(0.5) },
    { userId: repB, orgId: ctx.seed.orgId, status: 'available', lastSeenAt: minutesAgo(5) },
  ]);

  // repA is on a live call right now (answered a minute ago).
  await db.insert(schema.calls).values({
    orgId: ctx.seed.orgId,
    direction: 'inbound',
    status: 'in_progress',
    userId: repA,
    fromNumber: '+16145550042',
    toNumber: '+15005550006',
    providerCallId: 'CA_floor_live',
    initiatedAt: minutesAgo(2),
    answeredAt: minutesAgo(1),
  });

  // Today's finished work: repA one answered call (talk 60s); repB one
  // missed inbound. Plus one call YESTERDAY that must not count today.
  await db.insert(schema.calls).values([
    {
      orgId: ctx.seed.orgId, direction: 'outbound', status: 'completed', userId: repA,
      fromNumber: '+15005550006', toNumber: '+16145550042', providerCallId: 'CA_floor_done',
      initiatedAt: minutesAgo(120), answeredAt: minutesAgo(119),
      endedAt: new Date(minutesAgo(119).getTime() + 60_000), durationSeconds: 62,
    },
    {
      orgId: ctx.seed.orgId, direction: 'inbound', status: 'completed', userId: repB,
      fromNumber: '+16145550055', toNumber: '+15005550006', providerCallId: 'CA_floor_missed',
      initiatedAt: minutesAgo(90), endedAt: minutesAgo(89),
      raw: { voicemailLeft: true },
    },
    {
      orgId: ctx.seed.orgId, direction: 'outbound', status: 'completed', userId: repA,
      fromNumber: '+15005550006', toNumber: '+16145550042', providerCallId: 'CA_floor_yesterday',
      initiatedAt: new Date('2026-08-24T15:00:00Z'), answeredAt: new Date('2026-08-24T15:00:05Z'),
      endedAt: new Date('2026-08-24T15:02:05Z'), durationSeconds: 125,
    },
    // One call on the REAL clock. Every other row here is pinned to NOW so the
    // snapshot maths is deterministic, but the HTTP route computes "today"
    // itself and would otherwise see an empty day on any date but 2026-08-25 —
    // which is exactly how this test started failing daily.
    {
      orgId: ctx.seed.orgId, direction: 'outbound', status: 'completed', userId: repA,
      fromNumber: '+15005550006', toNumber: '+16145550042', providerCallId: 'CA_floor_realtoday',
      initiatedAt: new Date(Date.now() - 60_000), answeredAt: new Date(Date.now() - 59_000),
      endedAt: new Date(), durationSeconds: 45,
    },
  ]);

  // Queue with one caller still holding and one already overflowed.
  const queue = (
    await db
      .insert(schema.queues)
      .values({ orgId: ctx.seed.orgId, name: 'Acquisitions', strategy: 'simultaneous' })
      .returning()
  )[0]!;
  queueId = queue.id;
  await db.insert(schema.queueMembers).values([{ queueId, userId: repA }]);
  const holding = (
    await db
      .insert(schema.calls)
      .values({
        orgId: ctx.seed.orgId, direction: 'inbound', status: 'ringing', userId: null,
        fromNumber: '+16145550066', toNumber: '+15005550006', providerCallId: 'CA_floor_hold',
        initiatedAt: minutesAgo(1), raw: { queueId },
      })
      .returning()
  )[0]!;
  void holding;
  const overflowed = (
    await db
      .insert(schema.calls)
      .values({
        orgId: ctx.seed.orgId, direction: 'inbound', status: 'ringing', userId: null,
        fromNumber: '+16145550077', toNumber: '+15005550006', providerCallId: 'CA_floor_overflowed',
        initiatedAt: minutesAgo(10), raw: { queueId },
      })
      .returning()
  )[0]!;
  await db.insert(schema.callEvents).values({
    orgId: ctx.seed.orgId,
    callId: overflowed.id,
    eventType: 'call.queue_overflow',
    occurredAt: minutesAgo(8),
    source: 'system',
    dedupeToken: 'CA_floor_overflowed:queue-overflow:x',
    payload: { queueId, elapsedSeconds: 95, overflow: 'voicemail' },
  });
});
afterAll(async () => {
  await ctx.close();
});

describe('floor snapshot', () => {
  it('shows the active call on the right rep, freshness, counters, depth, totals', async () => {
    const snap = await floorSnapshot(ctx.dbh.db, ctx.seed.orgId, NOW);

    expect(snap.today).toBe('2026-08-25');
    expect(snap.timezone).toBe('America/New_York');

    const reps = Object.fromEntries(snap.reps.map((r) => [r.display_name, r]));
    expect(Object.keys(reps).sort()).toEqual(['Alex Admin', 'Bella Rep', 'Mandy Manager', 'Riley Rep']);

    const riley = reps['Riley Rep']!;
    expect(riley.presence.status).toBe('available');
    expect(riley.presence.fresh).toBe(true);
    expect(riley.on_call).not.toBeNull();
    expect(riley.on_call!.direction).toBe('inbound');
    expect(riley.on_call!.status).toBe('in_progress');
    expect(riley.on_call!.answered_at).toBe(minutesAgo(1).toISOString());
    // Today: the live call + the finished one (yesterday's excluded).
    expect(riley.today.calls).toBe(2);
    expect(riley.today.answered).toBe(2);
    expect(riley.today.talk_seconds).toBe(60); // only the finished call has ended

    const bella = reps['Bella Rep']!;
    // Stale presence: available status but NOT fresh — the router would skip
    // her, and the floor must not paint her green.
    expect(bella.presence.status).toBe('available');
    expect(bella.presence.fresh).toBe(false);
    expect(bella.on_call).toBeNull();
    expect(bella.today.calls).toBe(1);
    expect(bella.today.answered).toBe(0);

    const admin = reps['Alex Admin']!;
    expect(admin.presence.status).toBe('offline');
    expect(admin.presence.fresh).toBe(false);
    expect(admin.presence.last_seen_at).toBeNull();
    expect(admin.on_call).toBeNull();

    // Queue depth: the holding caller counts; the overflowed one does not.
    expect(snap.queues).toEqual([{ queue_id: queueId, name: 'Acquisitions', waiting: 1 }]);

    // Org totals today: live + done + missed + hold + overflowed = 5 calls.
    expect(snap.totals.calls).toBe(5);
    expect(snap.totals.inbound).toBe(4);
    expect(snap.totals.outbound).toBe(1);
    expect(snap.totals.answered).toBe(2); // live + done
    expect(snap.totals.missed).toBe(1); // CA_floor_missed (hold/overflow not terminal yet)
    expect(snap.totals.voicemails_left).toBe(1);
    expect(snap.totals.talk_seconds).toBe(60);
  });

  it('is served over HTTP to floor.view holders only', async () => {
    const asManager = await ctx.app.inject({
      method: 'GET', url: '/v1/floor/state', headers: managerAuth,
    });
    expect(asManager.statusCode).toBe(200);
    const body = asManager.json() as { reps: unknown[]; totals: { calls: number } };
    expect(body.reps).toHaveLength(4);
    // The route reads the real clock, so the only row it can see today is the
    // one seeded on it. The pinned-clock totals are asserted exactly above.
    expect(body.totals.calls).toBeGreaterThanOrEqual(1);

    const asRep = await ctx.app.inject({
      method: 'GET', url: '/v1/floor/state', headers: repAuth,
    });
    expect(asRep.statusCode).toBe(403);
  });
});
