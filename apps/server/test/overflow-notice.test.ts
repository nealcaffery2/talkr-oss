/**
 * No-answer overflow (docs/inbound-routing.md §11): the notice a subscriber
 * gets before the caller is dialled on to the AI line, and who gets it.
 */
import { describe, expect, it } from 'vitest';
import { buildOverflowNotice, rungUserId, wantsOverflowNotice } from '../src/services/overflow.js';

describe('overflow notice', () => {
  it('carries the caller, the rep line, the overflow line and the rep', () => {
    const n = buildOverflowNotice(
      { id: 'call-1', fromNumber: '+15125550199', toNumber: '+15125555917' },
      '+12145559557',
      'no_answer',
      { id: 'u-morgan', displayName: 'Morgan Lane', partnerSubject: 'clozr-uuid' },
      new Date('2026-11-06T20:00:00Z'),
    );
    expect(n.type).toBe('call.overflow');
    expect(n.occurredAt).toBe('2026-11-06T20:00:00.000Z');
    expect(n.data).toEqual({
      call_id: 'call-1', from: '+15125550199', to: '+15125555917', overflow_to: '+12145559557', reason: 'no_answer',
      user_id: 'u-morgan', user_name: 'Morgan Lane', partner_subject: 'clozr-uuid',
    });
    expect(n.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('a call nobody rang still overflows, with no rep', () => {
    const n = buildOverflowNotice({ id: 'c', fromNumber: '+1', toNumber: '+2' }, '+3', 'no_agents', null);
    expect(n.data.user_id).toBeNull();
    expect(n.data.partner_subject).toBeNull();
  });

  it('the rung rep is the call user, else the one user the routing picked', () => {
    expect(rungUserId({ userId: 'u1', raw: null })).toBe('u1');
    expect(rungUserId({ userId: null, raw: { routing: { action: 'ring_users', userIds: ['u2'] } } })).toBe('u2');
    expect(rungUserId({ userId: null, raw: { routing: { action: 'ring_users', userIds: ['u2', 'u3'] } } })).toBeNull();
    expect(rungUserId({ userId: null, raw: { routing: { action: 'voicemail' } } })).toBeNull();
  });

  it('missed-call subscribers hear about overflow; inactive or unrelated ones do not', () => {
    expect(wantsOverflowNotice({ active: true, eventTypes: ['call.no_answer'] })).toBe(true);
    expect(wantsOverflowNotice({ active: true, eventTypes: ['call.overflow'] })).toBe(true);
    expect(wantsOverflowNotice({ active: false, eventTypes: ['call.no_answer'] })).toBe(false);
    expect(wantsOverflowNotice({ active: true, eventTypes: ['message.received'] })).toBe(false);
    expect(wantsOverflowNotice({ active: true, eventTypes: 'call.no_answer' })).toBe(false);
  });
});
