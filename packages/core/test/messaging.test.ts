/**
 * SMS domain unit tests (docs/sms.md §2, §4, §6): message state machine
 * (monotonic, out-of-order, duplicates, failure classification), CTIA keyword
 * parser, quiet-hours send window, merge-field rendering.
 */

import { describe, expect, it } from 'vitest';
import {
  classifyMessageFailure,
  emptyMessageMergeVars,
  findMessageMergeFields,
  isMessageMergeField,
  isWithinSmsSendWindow,
  MESSAGE_MERGE_FIELDS,
  parseSmsKeyword,
  reduceMessageStatus,
  renderMessageBody,
  unknownMessageMergeFields,
  type MessageSnapshot,
} from '../src/messaging.js';

function snap(overrides: Partial<MessageSnapshot> = {}): MessageSnapshot {
  return {
    status: 'queued',
    sentAt: null,
    deliveredAt: null,
    failedAt: null,
    errorCode: null,
    failureClass: 'none',
    ...overrides,
  };
}

const t0 = new Date('2026-08-25T12:00:00Z');
const t1 = new Date('2026-08-25T12:00:05Z');

describe('message state machine', () => {
  it('advances through the happy path', () => {
    let s = snap();
    let c = reduceMessageStatus(s, { status: 'sending', occurredAt: t0 });
    expect(c.status).toBe('sending');
    s = snap({ status: 'sending' });
    c = reduceMessageStatus(s, { status: 'sent', occurredAt: t0 });
    expect(c.status).toBe('sent');
    expect(c.sentAt).toEqual(t0);
    s = snap({ status: 'sent', sentAt: t0 });
    c = reduceMessageStatus(s, { status: 'delivered', occurredAt: t1 });
    expect(c.status).toBe('delivered');
    expect(c.deliveredAt).toEqual(t1);
  });

  it('never regresses on out-of-order events: delivered before sent', () => {
    const afterDelivered = snap({ status: 'delivered', deliveredAt: t0 });
    const late = reduceMessageStatus(afterDelivered, { status: 'sent', occurredAt: t1 });
    expect(late.status).toBeUndefined(); // status untouched
    expect(late.sentAt).toEqual(t1); // timestamp backfilled, first-write-wins
    expect(late.noop).toBe(false);
  });

  it('duplicates are pure no-ops', () => {
    const s = snap({ status: 'delivered', sentAt: t0, deliveredAt: t0 });
    const dup = reduceMessageStatus(s, { status: 'delivered', occurredAt: t1 });
    expect(dup.noop).toBe(true);
    expect(dup.status).toBeUndefined();
    expect(dup.deliveredAt).toBeUndefined(); // first write already happened
  });

  it('terminal is sticky: failed never becomes delivered via webhooks', () => {
    const s = snap({ status: 'failed', failedAt: t0, failureClass: 'carrier_failure' });
    const c = reduceMessageStatus(s, { status: 'delivered', occurredAt: t1 });
    expect(c.status).toBeUndefined();
    expect(c.deliveredAt).toEqual(t1); // recorded as data, status unchanged
  });

  it('failed sets error code + failure class', () => {
    const c = reduceMessageStatus(snap({ status: 'sent', sentAt: t0 }), {
      status: 'failed',
      errorCode: '30003',
      occurredAt: t1,
    });
    expect(c.status).toBe('failed');
    expect(c.errorCode).toBe('30003');
    expect(c.failureClass).toBe('carrier_failure');
    expect(c.failedAt).toEqual(t1);
  });

  it('undelivered is terminal with classification', () => {
    const c = reduceMessageStatus(snap({ status: 'sending' }), {
      status: 'undelivered',
      errorCode: '21610',
      occurredAt: t0,
    });
    expect(c.status).toBe('undelivered');
    expect(c.failureClass).toBe('platform_failure'); // 21xxx = our side
  });

  it('classifies error codes: 21xxx platform, 30xxx carrier, unknown carrier', () => {
    expect(classifyMessageFailure('21211')).toBe('platform_failure');
    expect(classifyMessageFailure('30005')).toBe('carrier_failure');
    expect(classifyMessageFailure('junk')).toBe('carrier_failure');
    expect(classifyMessageFailure(undefined)).toBe('carrier_failure');
  });
});

describe('CTIA keyword parser', () => {
  it('matches the STOP family case-insensitively with trimming', () => {
    for (const word of ['STOP', 'stop', ' Stop ', 'STOPALL', 'unsubscribe', 'Cancel', 'END', 'quit', 'stop.', 'STOP!']) {
      expect(parseSmsKeyword(word), word).toBe('stop');
    }
  });

  it('matches HELP and START families', () => {
    expect(parseSmsKeyword('help')).toBe('help');
    expect(parseSmsKeyword('INFO')).toBe('help');
    expect(parseSmsKeyword('start')).toBe('start');
    expect(parseSmsKeyword('YES')).toBe('start');
    expect(parseSmsKeyword('Unstop')).toBe('start');
  });

  it('sentences containing keywords are NOT keywords', () => {
    expect(parseSmsKeyword('please stop texting me')).toBeNull();
    expect(parseSmsKeyword('yes I want to sell the house')).toBeNull();
    expect(parseSmsKeyword('can you help me')).toBeNull();
    expect(parseSmsKeyword('')).toBeNull();
    expect(parseSmsKeyword(null)).toBeNull();
  });
});

describe('quiet hours send window', () => {
  // 2026-08-25 is EDT (UTC-4): 18:00Z = 14:00 New York.
  const daytimeEt = new Date('2026-08-25T18:00:00Z');
  const lateEt = new Date('2026-08-26T02:30:00Z'); // 22:30 New York

  it('defaults to 08:00–21:00 in the org timezone', () => {
    expect(isWithinSmsSendWindow({ timezone: 'America/New_York' }, daytimeEt)).toBe(true);
    expect(isWithinSmsSendWindow({ timezone: 'America/New_York' }, lateEt)).toBe(false);
  });

  it('honors the org timezone: same instant, different answers', () => {
    // 02:30 New York time is 23:30 in Los Angeles the previous day? No —
    // 06:30Z-4 = 02:30 ET = 23:30 PT. Both outside. Use 12:00Z instead:
    // 12:00Z = 08:00 ET (inside) = 05:00 PT (outside).
    const noonZ = new Date('2026-08-25T12:00:00Z');
    expect(isWithinSmsSendWindow({ timezone: 'America/New_York' }, noonZ)).toBe(true);
    expect(isWithinSmsSendWindow({ timezone: 'America/Los_Angeles' }, noonZ)).toBe(false);
  });

  it('supports configured and wrap-around windows', () => {
    const cfg = { timezone: 'America/New_York', smsSendWindowStart: '09:00', smsSendWindowEnd: '17:00' };
    expect(isWithinSmsSendWindow(cfg, daytimeEt)).toBe(true); // 14:00 ET
    expect(isWithinSmsSendWindow(cfg, new Date('2026-08-25T21:30:00Z'))).toBe(false); // 17:30 ET
    // Wrap-around (start > end): 20:00–02:00 allows 22:30 ET.
    const wrap = { timezone: 'America/New_York', smsSendWindowStart: '20:00', smsSendWindowEnd: '02:00' };
    expect(isWithinSmsSendWindow(wrap, lateEt)).toBe(true);
    expect(isWithinSmsSendWindow(wrap, daytimeEt)).toBe(false);
  });

  it('fails open on an invalid timezone (never blocks on a config bug)', () => {
    expect(isWithinSmsSendWindow({ timezone: 'Not/AZone' }, lateEt)).toBe(true);
  });
});

describe('merge-field rendering', () => {
  const vars = {
    ...emptyMessageMergeVars(),
    first_name: 'Sally',
    name: 'Sally Seller',
    contact_name: 'Sally Seller',
    address: '123 Maple St',
    city: 'Columbus',
    rep_name: 'Riley Rep',
    rep_first_name: 'Riley',
    company: 'Your Company',
    org_name: 'Your Company',
  };

  it('renders both grammars — {field} and {{field}} — identically', () => {
    expect(renderMessageBody('Hi {first_name}, about {address}.', vars)).toBe(
      'Hi Sally, about 123 Maple St.',
    );
    expect(renderMessageBody('Hi {{first_name}}, about {{address}}.', vars)).toBe(
      'Hi Sally, about 123 Maple St.',
    );
    expect(renderMessageBody('Hi {{ first_name }} in { city }.', vars)).toBe('Hi Sally in Columbus.');
  });

  it('is case-insensitive on the field name', () => {
    expect(renderMessageBody('Hi {First_Name}', vars)).toBe('Hi Sally');
  });

  it('renders a known field with no value as an empty string, tidily', () => {
    const thin = { ...emptyMessageMergeVars(), first_name: 'Sally' };
    expect(renderMessageBody('Hi {first_name}, about {address}.', thin)).toBe('Hi Sally, about.');
    expect(renderMessageBody('{first_name} {city} says hi', thin)).toBe('Sally says hi');
  });

  it('renders a field nobody knows as an empty string — never the braces', () => {
    expect(renderMessageBody('Hi {frist_name}!', vars)).toBe('Hi!');
    expect(renderMessageBody('Hi {{seller_nickname}} there', vars)).toBe('Hi there');
  });

  it('never lets a placeholder reach the carrier (the prod bug)', () => {
    const body = 'Hi {first_name}, following up on {address} — {{rep_name}} / {bogus}';
    const out = renderMessageBody(body, vars);
    expect(out).toBe('Hi Sally, following up on 123 Maple St — Riley Rep /');
    expect(out).not.toMatch(/\{\{?\s*[a-zA-Z0-9_]+\s*\}?\}/);
  });

  it('leaves braces that are not merge syntax exactly as typed', () => {
    // A rep's own text, not a placeholder: substituting or deleting it would
    // silently rewrite what they meant to say.
    expect(renderMessageBody('We can do {50%} down', vars)).toBe('We can do {50%} down');
  });

  it('does not re-scan substituted values', () => {
    const out = renderMessageBody('Hi {first_name}', { ...vars, first_name: '{address}' });
    expect(out).toBe('Hi {address}');
  });

  it('leaves a body with no merge fields byte-identical', () => {
    const typed = 'Hey  there.   Are you around?  ';
    expect(renderMessageBody(typed, vars)).toBe(typed);
  });

  it('keeps line breaks and only collapses mid-line gaps', () => {
    expect(renderMessageBody('Hi {first_name}\nAbout {address}', vars)).toBe(
      'Hi Sally\nAbout 123 Maple St',
    );
  });

  it('finds the fields a body references, in order, deduped and lowercased', () => {
    expect(findMessageMergeFields('{{First_Name}} {address} {first_name} {nope}')).toEqual([
      'first_name',
      'address',
      'nope',
    ]);
  });

  it('lists exactly the unknown fields — what a template write rejects on', () => {
    expect(unknownMessageMergeFields('Hi {first_name} at {addres} in {citty}')).toEqual([
      'addres',
      'citty',
    ]);
    expect(unknownMessageMergeFields('Hi {first_name} at {address}')).toEqual([]);
  });

  it('knows every field the scripts and sequence builders offer', () => {
    for (const field of ['first_name', 'name', 'address', 'city', 'state', 'postal_code', 'company', 'rep_name', 'rep_first_name', 'phone']) {
      expect(isMessageMergeField(field)).toBe(true);
    }
    // Phase 4 templates were written with these two; they keep working.
    expect(isMessageMergeField('contact_name')).toBe(true);
    expect(isMessageMergeField('org_name')).toBe(true);
    expect(isMessageMergeField('nope')).toBe(false);
  });

  it('empty vars render every known field as empty', () => {
    const empty = emptyMessageMergeVars();
    for (const field of MESSAGE_MERGE_FIELDS) expect(empty[field]).toBe('');
    expect(renderMessageBody(MESSAGE_MERGE_FIELDS.map((f) => `{${f}}`).join(' '), empty)).toBe('');
  });
});
