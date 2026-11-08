/**
 * Read receipts in the message state machine, and the channel choice between
 * iMessage, RCS and SMS (docs/messaging-channels.md).
 */

import { describe, expect, it } from 'vitest';
import {
  channelCandidates,
  classifyMessageFailure,
  reduceMessageStatus,
  selectMessageChannel,
  type ChannelSelectionInput,
  type ChannelSupport,
  type MessageSnapshot,
} from '../src/messaging.js';

const T0 = new Date('2026-10-21T15:00:00Z');
const T1 = new Date('2026-10-21T15:01:00Z');
const T2 = new Date('2026-10-21T15:02:00Z');

function snap(over: Partial<MessageSnapshot> = {}): MessageSnapshot {
  return {
    status: 'sending',
    sentAt: null,
    deliveredAt: null,
    failedAt: null,
    readAt: null,
    errorCode: null,
    failureClass: 'none',
    ...over,
  };
}

describe('read receipts in the state machine', () => {
  it('delivered → read: status moves and read_at is stamped', () => {
    const c = reduceMessageStatus(snap({ status: 'delivered', deliveredAt: T0 }), { status: 'read', occurredAt: T1 });
    expect(c.status).toBe('read');
    expect(c.readAt).toEqual(T1);
    expect(c.deliveredAt).toBeUndefined();
    expect(c.noop).toBe(false);
  });

  it('read before delivered: lands read and backfills delivered_at', () => {
    const c = reduceMessageStatus(snap({ status: 'sent', sentAt: T0 }), { status: 'read', occurredAt: T1 });
    expect(c.status).toBe('read');
    expect(c.readAt).toEqual(T1);
    expect(c.deliveredAt).toEqual(T1);
  });

  it('a late delivered after read never regresses the status', () => {
    const c = reduceMessageStatus(snap({ status: 'read', deliveredAt: T1, readAt: T1 }), {
      status: 'delivered',
      occurredAt: T2,
    });
    expect(c.status).toBeUndefined();
    expect(c.noop).toBe(true);
  });

  it('a duplicate read receipt is a no-op: read_at is first-write-wins', () => {
    const c = reduceMessageStatus(snap({ status: 'read', deliveredAt: T0, readAt: T1 }), {
      status: 'read',
      occurredAt: T2,
    });
    expect(c.noop).toBe(true);
    expect(c.readAt).toBeUndefined();
  });

  it('a failed message stays failed; a stray read only records read_at', () => {
    const c = reduceMessageStatus(snap({ status: 'failed', failedAt: T0 }), { status: 'read', occurredAt: T1 });
    expect(c.status).toBeUndefined();
    expect(c.readAt).toEqual(T1);
    expect(c.deliveredAt).toBeUndefined();
  });

  it('snapshots without readAt (older callers) still reduce', () => {
    const { readAt: _drop, ...old } = snap({ status: 'delivered', deliveredAt: T0 });
    const c = reduceMessageStatus(old, { status: 'read', occurredAt: T1 });
    expect(c.status).toBe('read');
  });
});

describe('failure classification for Sendblue codes', () => {
  it('Sendblue 4xxx/5xxx are platform-side', () => {
    expect(classifyMessageFailure('4001')).toBe('platform_failure');
    expect(classifyMessageFailure('5509')).toBe('platform_failure');
  });
  it('Telnyx and Twilio-era codes keep their classes', () => {
    expect(classifyMessageFailure('21610')).toBe('platform_failure');
    expect(classifyMessageFailure('30007')).toBe('carrier_failure');
    expect(classifyMessageFailure('40300')).toBe('carrier_failure');
    expect(classifyMessageFailure('OPTED_OUT')).toBe('carrier_failure');
  });
});

const ALL_ON: ChannelSelectionInput = {
  imessageConfigured: true,
  imessageLineEnabled: true,
  rcsConfigured: true,
  rcsLineEnabled: true,
  mediaCount: 0,
};

function probeOf(answers: Partial<Record<'imessage' | 'rcs', ChannelSupport | Error>>) {
  const asked: string[] = [];
  const probe = async (c: 'imessage' | 'rcs'): Promise<ChannelSupport> => {
    asked.push(c);
    const a = answers[c] ?? 'unsupported';
    if (a instanceof Error) throw a;
    return a;
  };
  return { probe, asked };
}

describe('channel selection', () => {
  it('nothing configured: SMS without a single lookup', async () => {
    const { probe, asked } = probeOf({ imessage: 'supported' });
    const r = await selectMessageChannel({ ...ALL_ON, imessageConfigured: false, rcsConfigured: false }, probe);
    expect(r).toEqual({ channel: 'sms', reason: 'not_configured' });
    expect(asked).toEqual([]);
  });

  it('configured but the line is off: SMS, no lookup', async () => {
    const { probe, asked } = probeOf({ imessage: 'supported' });
    const r = await selectMessageChannel({ ...ALL_ON, imessageLineEnabled: false, rcsLineEnabled: false }, probe);
    expect(r.channel).toBe('sms');
    expect(asked).toEqual([]);
  });

  it('iMessage recipient on an iMessage line: iMessage, RCS never asked', async () => {
    const { probe, asked } = probeOf({ imessage: 'supported', rcs: 'supported' });
    const r = await selectMessageChannel(ALL_ON, probe);
    expect(r).toEqual({ channel: 'imessage', reason: 'imessage_supported' });
    expect(asked).toEqual(['imessage']);
  });

  it('no iMessage, RCS handset: RCS', async () => {
    const { probe, asked } = probeOf({ imessage: 'unsupported', rcs: 'supported' });
    const r = await selectMessageChannel(ALL_ON, probe);
    expect(r).toEqual({ channel: 'rcs', reason: 'rcs_supported' });
    expect(asked).toEqual(['imessage', 'rcs']);
  });

  it('neither: SMS, recipient_unsupported', async () => {
    const { probe } = probeOf({});
    expect(await selectMessageChannel(ALL_ON, probe)).toEqual({ channel: 'sms', reason: 'recipient_unsupported' });
  });

  it('an inconclusive or failing lookup falls back to SMS', async () => {
    const { probe } = probeOf({ imessage: 'unknown', rcs: new Error('timeout') });
    expect(await selectMessageChannel(ALL_ON, probe)).toEqual({ channel: 'sms', reason: 'capability_unknown' });
  });

  it('one attachment: iMessage yes, RCS no', () => {
    expect(channelCandidates({ ...ALL_ON, mediaCount: 1 })).toEqual(['imessage']);
  });

  it('several attachments keep the MMS path', async () => {
    const { probe, asked } = probeOf({ imessage: 'supported' });
    const r = await selectMessageChannel({ ...ALL_ON, mediaCount: 3 }, probe);
    expect(r).toEqual({ channel: 'sms', reason: 'multiple_attachments' });
    expect(asked).toEqual([]);
  });
});
