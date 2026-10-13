import { describe, expect, it } from 'vitest';
import {
  decideInboundRoute,
  pickQueueTargets,
  type PresenceInfo,
  type QueueConfig,
} from '../src/routing.js';

const NOW = new Date('2026-08-25T15:00:00Z');

function presence(
  entries: Record<string, Partial<PresenceInfo>>,
): Map<string, PresenceInfo> {
  const map = new Map<string, PresenceInfo>();
  for (const [id, p] of Object.entries(entries)) {
    map.set(id, {
      status: p.status ?? 'available',
      lastSeenAt: p.lastSeenAt ?? NOW,
      lastRungAt: p.lastRungAt ?? null,
      lastCallEndedAt: p.lastCallEndedAt ?? null,
    });
  }
  return map;
}

function queue(overrides: Partial<QueueConfig> = {}): QueueConfig {
  return {
    id: 'q1',
    strategy: 'simultaneous',
    memberUserIds: ['a', 'b', 'c'],
    maxWaitSeconds: 90,
    overflow: 'voicemail',
    ...overrides,
  };
}

describe('pickQueueTargets', () => {
  it('simultaneous rings all available members up to the cap', () => {
    const members = ['a', 'b', 'c', 'd', 'e', 'f'];
    const targets = pickQueueTargets(
      { strategy: 'simultaneous', memberUserIds: members },
      presence(Object.fromEntries(members.map((m) => [m, {}]))),
      NOW,
    );
    expect(targets).toHaveLength(5);
  });

  it('round_robin picks the member rung longest ago, never-rung first', () => {
    const p = presence({
      a: { lastRungAt: new Date('2026-08-25T14:59:00Z') },
      b: { lastRungAt: new Date('2026-08-25T14:50:00Z') },
      c: {}, // never rung
    });
    expect(pickQueueTargets(queue({ strategy: 'round_robin' }), p, NOW)).toEqual(['c']);
    p.get('c')!.lastRungAt = NOW;
    expect(pickQueueTargets(queue({ strategy: 'round_robin' }), p, NOW)).toEqual(['b']);
  });

  it('round_robin with all-never-rung members still picks exactly one deterministically', () => {
    const p = presence({ a: {}, b: {}, c: {} });
    const targets = pickQueueTargets(queue({ strategy: 'round_robin' }), p, NOW);
    expect(targets).toHaveLength(1);
  });

  it('longest_idle picks the member whose last call ended longest ago', () => {
    const p = presence({
      a: { lastCallEndedAt: new Date('2026-08-25T14:58:00Z') },
      b: { lastCallEndedAt: new Date('2026-08-25T13:00:00Z') },
      c: { lastCallEndedAt: new Date('2026-08-25T14:30:00Z') },
    });
    expect(pickQueueTargets(queue({ strategy: 'longest_idle' }), p, NOW)).toEqual(['b']);
  });

  it('excludes unavailable and stale members entirely', () => {
    const p = presence({
      a: { status: 'offline' },
      b: { lastSeenAt: new Date(NOW.getTime() - 10 * 60_000) }, // stale
      c: {},
    });
    expect(pickQueueTargets(queue({ strategy: 'simultaneous' }), p, NOW)).toEqual(['c']);
    expect(
      pickQueueTargets(
        queue({ strategy: 'round_robin', memberUserIds: ['a', 'b'] }),
        p,
        NOW,
      ),
    ).toEqual([]);
  });
});

describe('decideInboundRoute with queues', () => {
  it('a queue with members owns the treatment even when none are available now', () => {
    const d = decideInboundRoute({
      now: NOW,
      hours: {},
      numberAssignedUserId: 'assignee',
      queue: queue({ memberUserIds: ['x'] }),
      presence: presence({ assignee: {}, x: { status: 'offline' } }),
    });
    expect(d).toMatchObject({ action: 'queue', queueId: 'q1' });
  });

  it('a recognized lead owner still beats the queue', () => {
    const d = decideInboundRoute({
      now: NOW,
      hours: {},
      leadOwnerUserId: 'owner',
      queue: queue(),
      presence: presence({ owner: {} }),
    });
    expect(d).toMatchObject({ action: 'ring_users', reason: 'lead_owner' });
  });

  it('a memberless queue is skipped, not a caller trap', () => {
    const d = decideInboundRoute({
      now: NOW,
      hours: {},
      numberAssignedUserId: 'assignee',
      queue: queue({ memberUserIds: [] }),
      presence: presence({ assignee: {} }),
    });
    expect(d).toMatchObject({ action: 'ring_users', reason: 'number_assignee' });
  });

  it('after-hours beats the queue', () => {
    const d = decideInboundRoute({
      now: NOW,
      hours: { timezone: 'America/New_York', businessHours: {} },
      queue: queue(),
      presence: presence({ a: {} }),
    });
    expect(d).toMatchObject({ action: 'voicemail', reason: 'after_hours' });
  });
});
