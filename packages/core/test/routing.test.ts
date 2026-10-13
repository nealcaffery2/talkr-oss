import { describe, expect, it } from 'vitest';
import {
  LAST_CONTACT_DEFAULT_DAYS,
  decideInboundRoute,
  isAvailable,
  pickLastContact,
  isWithinBusinessHours,
  type PresenceInfo,
  type RouteInput,
} from '../src/routing.js';

const NOW = new Date('2026-08-25T15:00:00Z'); // Tue 11:00 America/New_York (EDT)

function presence(entries: Record<string, Partial<PresenceInfo>>): Map<string, PresenceInfo> {
  const map = new Map<string, PresenceInfo>();
  for (const [id, p] of Object.entries(entries)) {
    map.set(id, { status: p.status ?? 'available', lastSeenAt: p.lastSeenAt ?? NOW });
  }
  return map;
}

function input(overrides: Partial<RouteInput>): RouteInput {
  return {
    now: NOW,
    hours: {},
    presence: new Map(),
    ...overrides,
  };
}

describe('business hours', () => {
  it('no config = always open', () => {
    expect(isWithinBusinessHours({}, NOW)).toBe(true);
  });

  it('evaluates ranges in the org timezone', () => {
    const config = {
      timezone: 'America/New_York',
      businessHours: { tue: [['08:00', '20:00']] as Array<[string, string]> },
    };
    expect(isWithinBusinessHours(config, NOW)).toBe(true); // 11:00 ET
    expect(isWithinBusinessHours(config, new Date('2026-08-26T01:00:00Z'))).toBe(false); // Tue 21:00 ET
  });

  it('absent day in a configured schedule = closed', () => {
    const config = {
      timezone: 'America/New_York',
      businessHours: { mon: [['08:00', '20:00']] as Array<[string, string]> },
    };
    expect(isWithinBusinessHours(config, NOW)).toBe(false); // Tuesday
  });

  it('handles a different timezone correctly', () => {
    const config = {
      timezone: 'America/Los_Angeles',
      businessHours: { tue: [['08:00', '20:00']] as Array<[string, string]> },
    };
    // 15:00 UTC = 08:00 PT — exactly opening time.
    expect(isWithinBusinessHours(config, NOW)).toBe(true);
    // 14:59 UTC = 07:59 PT — before opening.
    expect(isWithinBusinessHours(config, new Date('2026-08-25T14:59:00Z'))).toBe(false);
  });
});

describe('presence freshness', () => {
  it('stale availability does not count', () => {
    expect(isAvailable({ status: 'available', lastSeenAt: NOW }, NOW)).toBe(true);
    expect(
      isAvailable({ status: 'available', lastSeenAt: new Date(NOW.getTime() - 120_000) }, NOW),
    ).toBe(false);
    expect(isAvailable({ status: 'away', lastSeenAt: NOW }, NOW)).toBe(false);
    expect(isAvailable(undefined, NOW)).toBe(false);
  });
});

describe('decideInboundRoute', () => {
  it('rings the lead owner first', () => {
    const d = decideInboundRoute(
      input({
        leadOwnerUserId: 'owner',
        numberAssignedUserId: 'assignee',
        presence: presence({ owner: {}, assignee: {} }),
      }),
    );
    expect(d).toMatchObject({ action: 'ring_users', userIds: ['owner'], reason: 'lead_owner' });
  });

  it('falls back to the number assignee when the owner is unavailable', () => {
    const d = decideInboundRoute(
      input({
        leadOwnerUserId: 'owner',
        numberAssignedUserId: 'assignee',
        presence: presence({ owner: { status: 'offline' }, assignee: {} }),
      }),
    );
    expect(d).toMatchObject({ action: 'ring_users', userIds: ['assignee'], reason: 'number_assignee' });
  });

  it('simultaneous-rings available team members, capped', () => {
    const team = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const d = decideInboundRoute(
      input({
        teamMemberUserIds: team,
        presence: presence(Object.fromEntries(team.map((t) => [t, {}]))),
      }),
    );
    if (d.action !== 'ring_users') throw new Error('expected ring');
    expect(d.reason).toBe('team');
    expect(d.userIds).toHaveLength(5);
  });

  it('excludes stale team members from the ring', () => {
    const d = decideInboundRoute(
      input({
        teamMemberUserIds: ['fresh', 'stale'],
        presence: presence({
          fresh: {},
          stale: { lastSeenAt: new Date(NOW.getTime() - 10 * 60_000) },
        }),
      }),
    );
    if (d.action !== 'ring_users') throw new Error('expected ring');
    expect(d.userIds).toEqual(['fresh']);
  });

  it('forwards externally when configured and nobody is available', () => {
    const d = decideInboundRoute(
      input({
        numberAssignedUserId: 'rep',
        forwardToE164: '+16145550100',
        presence: presence({ rep: { status: 'offline' } }),
      }),
    );
    expect(d).toMatchObject({ action: 'forward', to: '+16145550100' });
  });

  it('voicemails with no_agents when the whole chain is empty', () => {
    const d = decideInboundRoute(input({}));
    expect(d).toMatchObject({ action: 'voicemail', reason: 'no_agents' });
  });

  it('voicemails after hours even when reps are available', () => {
    const d = decideInboundRoute(
      input({
        hours: { timezone: 'America/New_York', businessHours: {} },
        numberAssignedUserId: 'rep',
        presence: presence({ rep: {} }),
      }),
    );
    expect(d).toMatchObject({ action: 'voicemail', reason: 'after_hours' });
  });
});

describe('last contact (docs/inbound-routing.md §10)', () => {
  const day = 86_400_000;
  const touch = (userId: string, daysAgo: number, channel: 'call' | 'sms' | 'rvm' | 'email' = 'call') => ({
    userId,
    channel,
    at: new Date(NOW.getTime() - daysAgo * day),
    ref: `${userId}-${daysAgo}`,
  });

  it('pickLastContact: newest touch inside the window wins', () => {
    const picked = pickLastContact([touch('a', 5), touch('b', 1, 'rvm'), touch('c', 20)], { now: NOW, isEligible: () => true });
    expect(picked?.userId).toBe('b');
    expect(picked?.channel).toBe('rvm');
  });

  it('pickLastContact: outside the window is nobody; the window is configurable', () => {
    expect(pickLastContact([touch('a', 20)], { now: NOW, isEligible: () => true })).toBeNull();
    expect(pickLastContact([touch('a', 20)], { now: NOW, withinDays: 30, isEligible: () => true })?.userId).toBe('a');
    expect(LAST_CONTACT_DEFAULT_DAYS).toBe(14);
  });

  it('pickLastContact: an ineligible newer toucher yields to an eligible older one', () => {
    const picked = pickLastContact([touch('a', 1), touch('b', 3)], { now: NOW, isEligible: (id) => id !== 'a' });
    expect(picked?.userId).toBe('b');
  });

  it('rings the latest available toucher first when the number asks, with the touch', () => {
    const d = decideInboundRoute(
      input({
        routeToLastContact: true,
        lastTouches: [touch('owner', 6), touch('dana', 2, 'rvm')],
        leadOwnerUserId: 'owner',
        presence: presence({ owner: {}, dana: {} }),
      }),
    );
    expect(d).toMatchObject({ action: 'ring_users', userIds: ['dana'], reason: 'last_contact' });
    expect((d as { lastContact?: { channel: string; occurred_at: string } }).lastContact).toEqual({
      user_id: 'dana',
      channel: 'rvm',
      occurred_at: new Date(NOW.getTime() - 2 * day).toISOString(),
      ref: 'dana-2',
    });
  });

  it('respects presence: an offline or stale toucher is skipped like any other target', () => {
    const d = decideInboundRoute(
      input({
        routeToLastContact: true,
        lastTouches: [touch('dana', 1), touch('eli', 3)],
        presence: presence({ dana: { status: 'offline' }, eli: { lastSeenAt: new Date(NOW.getTime() - 5 * 60_000) } }),
        leadOwnerUserId: 'owner',
      }),
    );
    // Neither toucher is available and the owner has no presence: nobody to ring.
    expect(d).toEqual({ action: 'voicemail', reason: 'no_agents' });
  });

  it('falls through to the lead owner when nobody touched the caller in the window', () => {
    const d = decideInboundRoute(
      input({
        routeToLastContact: true,
        lastTouches: [touch('dana', 30)],
        leadOwnerUserId: 'owner',
        presence: presence({ owner: {}, dana: {} }),
      }),
    );
    expect(d).toMatchObject({ action: 'ring_users', userIds: ['owner'], reason: 'lead_owner' });
  });

  it('is off unless the number turns it on', () => {
    const d = decideInboundRoute(
      input({ lastTouches: [touch('dana', 1)], leadOwnerUserId: 'owner', presence: presence({ owner: {}, dana: {} }) }),
    );
    expect(d).toMatchObject({ reason: 'lead_owner' });
  });

  it('beats a queue, like the lead owner does', () => {
    const d = decideInboundRoute(
      input({
        routeToLastContact: true,
        lastTouches: [touch('dana', 1)],
        queue: { id: 'q', strategy: 'simultaneous', memberUserIds: ['x'], maxWaitSeconds: 60, overflow: 'voicemail' },
        presence: presence({ dana: {}, x: {} }),
      }),
    );
    expect(d).toMatchObject({ action: 'ring_users', userIds: ['dana'], reason: 'last_contact' });
  });
});
