import { describe, expect, it } from 'vitest';
import {
  newCallSnapshot,
  reduceCallEvent,
  type CallSnapshot,
} from '../src/call-state.js';
import type { CanonicalCallEvent } from '../src/events.js';

function ev(
  type: CanonicalCallEvent['type'],
  overrides: Partial<CanonicalCallEvent> = {},
): CanonicalCallEvent {
  return {
    type,
    provider: 'telnyx',
    providerObjectId: 'CA123',
    occurredAt: new Date('2026-08-25T12:00:00Z'),
    data: {},
    raw: {},
    ...overrides,
  };
}

function apply(snapshot: CallSnapshot, ...events: CanonicalCallEvent[]): CallSnapshot {
  let s = snapshot;
  for (const e of events) {
    const c = reduceCallEvent(s, e);
    s = {
      status: c.status ?? s.status,
      initiatedAt: c.initiatedAt ?? s.initiatedAt,
      ringingAt: c.ringingAt ?? s.ringingAt,
      answeredAt: c.answeredAt ?? s.answeredAt,
      endedAt: c.endedAt ?? s.endedAt,
      durationSeconds: c.durationSeconds ?? s.durationSeconds,
      failureClass: c.failureClass ?? s.failureClass,
    };
  }
  return s;
}

describe('call state machine', () => {
  it('walks the happy path queued → initiated → ringing → in_progress → completed', () => {
    const s = apply(
      newCallSnapshot(),
      ev('call.initiated'),
      ev('call.ringing'),
      ev('call.answered'),
      ev('call.completed', { data: { durationSeconds: 95 } }),
    );
    expect(s.status).toBe('completed');
    expect(s.initiatedAt).not.toBeNull();
    expect(s.ringingAt).not.toBeNull();
    expect(s.answeredAt).not.toBeNull();
    expect(s.endedAt).not.toBeNull();
    expect(s.durationSeconds).toBe(95);
    expect(s.failureClass).toBe('none');
  });

  it('never regresses status on late lower-rank events', () => {
    const s = apply(
      newCallSnapshot(),
      ev('call.answered'),
      ev('call.ringing'), // late
    );
    expect(s.status).toBe('in_progress');
    expect(s.ringingAt).not.toBeNull(); // timestamp still backfilled
  });

  it('handles completed arriving before answered (out-of-order)', () => {
    const completedAt = new Date('2026-08-25T12:05:00Z');
    const answeredAt = new Date('2026-08-25T12:01:00Z');
    let s = apply(newCallSnapshot('ringing'), ev('call.completed', { occurredAt: completedAt }));
    expect(s.status).toBe('completed');
    expect(s.endedAt).toEqual(completedAt);

    s = apply(s, ev('call.answered', { occurredAt: answeredAt }));
    expect(s.status).toBe('completed'); // terminal sticks
    expect(s.answeredAt).toEqual(answeredAt); // timestamp backfilled
  });

  it('keeps terminal sticky for webhook events', () => {
    const s = apply(newCallSnapshot('completed'), ev('call.failed'));
    expect(s.status).toBe('completed');
  });

  it('allows reconciliation to correct terminal → terminal', () => {
    const snapshot: CallSnapshot = { ...newCallSnapshot('failed'), endedAt: new Date() };
    const change = reduceCallEvent(snapshot, ev('call.no_answer'), 'reconciliation');
    expect(change.status).toBe('no_answer');
    expect(change.failureClass).toBe('seller_no_answer');
  });

  it('is a pure no-op on exact duplicates', () => {
    const s1 = apply(newCallSnapshot(), ev('call.ringing'));
    const change = reduceCallEvent(s1, ev('call.ringing'));
    expect(change.noop).toBe(true);
    expect(change.status).toBeUndefined();
  });

  it('classifies failures: seller vs carrier vs platform', () => {
    expect(apply(newCallSnapshot(), ev('call.no_answer')).failureClass).toBe('seller_no_answer');
    expect(apply(newCallSnapshot(), ev('call.busy')).failureClass).toBe('seller_busy');
    expect(
      apply(newCallSnapshot(), ev('call.failed', { data: { errorCode: '30005' } })).failureClass,
    ).toBe('carrier_failure');
    expect(
      apply(newCallSnapshot(), ev('call.failed', { data: { errorCode: '11200' } })).failureClass,
    ).toBe('platform_failure');
    expect(apply(newCallSnapshot(), ev('call.canceled')).failureClass).toBe('canceled');
  });
});
