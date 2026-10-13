/**
 * Contact temperature (docs/contacts.md §4): the pure scorer, its caps, the
 * status overrides, decay, and how dispositions are read as positive or
 * negative. No database — the gatherers are exercised by the API tests.
 */

import { describe, expect, it } from 'vitest';
import {
  TEMPERATURE_HOT_MIN,
  TEMPERATURE_SELLER_MAX,
  TEMPERATURE_WARM_MIN,
  classifyDisposition,
  daysBetween,
  scoreContactTemperature,
  temperatureBucket,
  type TemperatureSignals,
} from '../src/services/contact-temperature.js';

function signals(overrides: Partial<TemperatureSignals> = {}): TemperatureSignals {
  return {
    inbound_sms: 0,
    outbound_sms: 0,
    calls_total: 0,
    calls_answered: 0,
    talk_seconds: 0,
    positive_dispositions: 0,
    negative_dispositions: 0,
    status: 'new',
    days_since_last_activity: 0,
    seller_motivation: null,
    seller_confidence: null,
    seller_bucket: null,
    seller_play: null,
    ...overrides,
  };
}

/**
 * The AI seller read (docs/coaching.md): what Claude made of the seller on
 * their most recent scored call, as points. This is the part of the score
 * that is about intent rather than engagement — answering the phone a lot is
 * not the same as needing to sell.
 */
describe('the AI seller read', () => {
  it('is worth nothing when no call of theirs has been scored', () => {
    const r = scoreContactTemperature(signals({ calls_answered: 1 }));
    expect(r.breakdown.seller_read).toBe(0);
    expect(r.score).toBe(15); // exactly what it scored before this signal existed
  });

  it('scores motivation against the rubric neutral, so a lukewarm read is zero', () => {
    const r = scoreContactTemperature(signals({ seller_motivation: 5, seller_confidence: 1 }));
    expect(r.breakdown.seller_read).toBe(0);
  });

  it('lifts a motivated seller and drops an unmotivated one, to a cap', () => {
    expect(scoreContactTemperature(signals({ seller_motivation: 10, seller_confidence: 1 })).breakdown.seller_read)
      .toBe(TEMPERATURE_SELLER_MAX);
    expect(scoreContactTemperature(signals({ seller_motivation: 8, seller_confidence: 1 })).breakdown.seller_read)
      .toBe(12);
    expect(scoreContactTemperature(signals({ seller_motivation: 0, seller_confidence: 1 })).breakdown.seller_read)
      .toBe(-TEMPERATURE_SELLER_MAX);
  });

  it('moves less when the model says it is unsure', () => {
    const sure = scoreContactTemperature(signals({ seller_motivation: 10, seller_confidence: 1 }));
    const hedged = scoreContactTemperature(signals({ seller_motivation: 10, seller_confidence: 0.25 }));
    expect(hedged.breakdown.seller_read).toBe(5);
    expect(hedged.breakdown.seller_read).toBeLessThan(sure.breakdown.seller_read);
  });

  it('takes a read with no stated confidence at face value', () => {
    expect(scoreContactTemperature(signals({ seller_motivation: 10 })).breakdown.seller_read)
      .toBe(TEMPERATURE_SELLER_MAX);
  });

  it('treats a wrong number or an unqualified seller as the model saying no', () => {
    for (const seller_bucket of ['wrong_number', 'unqualified']) {
      // Even with a high motivation guess beside it: the bucket outranks it.
      const r = scoreContactTemperature(signals({ seller_bucket, seller_motivation: 9, seller_confidence: 1 }));
      expect(r.breakdown.seller_read).toBe(-TEMPERATURE_SELLER_MAX);
    }
  });

  it('has no opinion when the call was too short to read', () => {
    const r = scoreContactTemperature(signals({ seller_bucket: 'unknown', seller_motivation: null }));
    expect(r.breakdown.seller_read).toBe(0);
  });

  it('cannot make a contact hot on its own, but can make one warm', () => {
    const readAlone = scoreContactTemperature(signals({ seller_motivation: 10, seller_confidence: 1 }));
    expect(readAlone.temperature).toBe('cold');
    // One answered call with a motivated read is a warm lead, not a hot one.
    const withCall = scoreContactTemperature(
      signals({ calls_answered: 1, talk_seconds: 600, seller_motivation: 10, seller_confidence: 1 }),
    );
    expect(withCall.score).toBe(45);
    expect(withCall.temperature).toBe('warm');
  });

  it('never rescues a dead or dnc contact', () => {
    for (const status of ['dead', 'dnc']) {
      const r = scoreContactTemperature(signals({ status, seller_motivation: 10, seller_confidence: 1 }));
      expect(r.score).toBe(0);
      expect(r.breakdown.seller_read).toBe(0);
    }
  });
});

/**
 * The question the score answers is "how likely is this to close", and
 * activity alone answers a different one. These are the cases that motivate
 * the whole signal, so they are asserted on the numbers rather than the band.
 */
describe('likelihood to close, not talkativeness', () => {
  /** Picks up every time, texts back, happy to chat for ten minutes. */
  const chatty = { calls_answered: 3, inbound_sms: 3, talk_seconds: 600 };

  it('a chatty contact is hot on activity alone — the problem this solves', () => {
    const r = scoreContactTemperature(signals(chatty));
    expect(r.score).toBe(76);
    expect(r.temperature).toBe('hot');
  });

  it('…but a tire-kicker stays cold however much they chat', () => {
    for (const seller_bucket of ['unmotivated_priced_high', 'unmotivated_priced_right']) {
      const r = scoreContactTemperature(signals({ ...chatty, seller_bucket, seller_motivation: 2, seller_confidence: 0.9 }));
      expect(r.breakdown.seller_bound).toBe('capped_cold');
      expect(r.temperature).toBe('cold');
    }
  });

  it('…and one the model says to walk away from is capped the same way', () => {
    const r = scoreContactTemperature(signals({ ...chatty, seller_play: 'walk_away' }));
    expect(r.temperature).toBe('cold');
  });

  it('…and one it writes off scores nothing at all', () => {
    for (const over of [{ seller_bucket: 'wrong_number' }, { seller_bucket: 'unqualified' }, { seller_play: 'drop' }]) {
      const r = scoreContactTemperature(signals({ ...chatty, ...over }));
      expect(r.breakdown.seller_bound).toBe('written_off');
      expect(r.score).toBe(0);
    }
  });

  it('a motivated seller who has gone quiet stays on the list instead of decaying off it', () => {
    // One answered call five weeks ago: activity alone has decayed it to nothing.
    const quiet = { calls_answered: 1, days_since_last_activity: 35 };
    expect(scoreContactTemperature(signals(quiet)).temperature).toBe('cold');

    const read = scoreContactTemperature(
      signals({ ...quiet, seller_bucket: 'motivated_priced_high', seller_motivation: 9, seller_confidence: 0.9 }),
    );
    expect(read.breakdown.seller_bound).toBe('floored_warm');
    expect(read.temperature).toBe('warm');
  });

  it('leaves a contact the model has not read exactly where it found them', () => {
    const r = scoreContactTemperature(signals(chatty));
    expect(r.breakdown.seller_bound).toBe('none');
    expect(r.score).toBe(76);
  });
});

describe('the human outranks the model', () => {
  const chatty = { calls_answered: 3, inbound_sms: 3, talk_seconds: 600 };

  it('a rep who moved the deal forward is never capped cold', () => {
    for (const status of ['appointment', 'offer', 'under_contract']) {
      const r = scoreContactTemperature(
        signals({ ...chatty, status, seller_bucket: 'unmotivated_priced_high', seller_play: 'walk_away' }),
      );
      expect(r.breakdown.seller_bound).toBe('none');
      expect(r.temperature).toBe('hot');
    }
  });

  it('a rep who moved the deal forward is not written off either', () => {
    const r = scoreContactTemperature(signals({ ...chatty, status: 'offer', seller_bucket: 'wrong_number' }));
    expect(r.score).toBeGreaterThan(0);
  });

  it('a floor never buries the rep\'s own "not interested"', () => {
    const r = scoreContactTemperature(
      signals({ negative_dispositions: 1, seller_bucket: 'motivated_priced_right', seller_motivation: 9 }),
    );
    expect(r.breakdown.seller_bound).toBe('none');
    expect(r.temperature).toBe('cold');
  });

  it('dead and dnc still score zero whatever the model read', () => {
    for (const status of ['dead', 'dnc']) {
      const r = scoreContactTemperature(
        signals({ ...chatty, status, seller_bucket: 'motivated_priced_right', seller_motivation: 10 }),
      );
      expect(r.score).toBe(0);
    }
  });
});

describe('scoreContactTemperature', () => {
  it('scores nothing as cold zero', () => {
    const r = scoreContactTemperature(signals());
    expect(r.score).toBe(0);
    expect(r.temperature).toBe('cold');
  });

  it('answered calls are +15 each, capped at 30', () => {
    expect(scoreContactTemperature(signals({ calls_answered: 1 })).score).toBe(15);
    expect(scoreContactTemperature(signals({ calls_answered: 2 })).score).toBe(30);
    expect(scoreContactTemperature(signals({ calls_answered: 9 })).score).toBe(30);
    // Unanswered calls alone earn nothing.
    expect(scoreContactTemperature(signals({ calls_total: 6 })).score).toBe(0);
  });

  it('inbound texts are +12 each, capped at 36; outbound texts earn nothing', () => {
    expect(scoreContactTemperature(signals({ inbound_sms: 1 })).score).toBe(12);
    expect(scoreContactTemperature(signals({ inbound_sms: 3 })).score).toBe(36);
    expect(scoreContactTemperature(signals({ inbound_sms: 10 })).score).toBe(36);
    expect(scoreContactTemperature(signals({ outbound_sms: 10 })).score).toBe(0);
  });

  it('positive dispositions are +20 each, capped at 40', () => {
    expect(scoreContactTemperature(signals({ positive_dispositions: 1 })).score).toBe(20);
    expect(scoreContactTemperature(signals({ positive_dispositions: 5 })).score).toBe(40);
  });

  it('talk time is +1 per whole minute, capped at 10', () => {
    expect(scoreContactTemperature(signals({ talk_seconds: 59 })).score).toBe(0);
    expect(scoreContactTemperature(signals({ talk_seconds: 150 })).score).toBe(2);
    expect(scoreContactTemperature(signals({ talk_seconds: 3600 })).score).toBe(10);
  });

  it('status adds 25 for appointment/offer/under_contract and 10 for engaged', () => {
    for (const status of ['appointment', 'offer', 'under_contract']) {
      expect(scoreContactTemperature(signals({ status })).breakdown.status).toBe(25);
    }
    expect(scoreContactTemperature(signals({ status: 'engaged' })).breakdown.status).toBe(10);
    for (const status of ['new', 'attempting', 'closed']) {
      expect(scoreContactTemperature(signals({ status })).breakdown.status).toBe(0);
    }
  });

  it('dead and dnc are zero no matter what else happened', () => {
    const hot = { calls_answered: 2, inbound_sms: 3, positive_dispositions: 2, talk_seconds: 900 };
    expect(scoreContactTemperature(signals({ ...hot, status: 'dead' })).score).toBe(0);
    const dnc = scoreContactTemperature(signals({ ...hot, status: 'dnc' }));
    expect(dnc.score).toBe(0);
    expect(dnc.temperature).toBe('cold');
  });

  it('a negative disposition costs 30, once, and never below zero', () => {
    expect(scoreContactTemperature(signals({ calls_answered: 2, negative_dispositions: 1 })).score).toBe(0);
    expect(scoreContactTemperature(signals({ calls_answered: 2, inbound_sms: 3, negative_dispositions: 1 })).score).toBe(36);
    expect(scoreContactTemperature(signals({ calls_answered: 2, inbound_sms: 3, negative_dispositions: 4 })).score).toBe(36);
  });

  it('decays 1.5 a day after a week of silence, floored at zero', () => {
    const base = { calls_answered: 2, inbound_sms: 3 }; // 66
    expect(scoreContactTemperature(signals({ ...base, days_since_last_activity: 7 })).score).toBe(66);
    expect(scoreContactTemperature(signals({ ...base, days_since_last_activity: 8 })).breakdown.decay).toBe(-1.5);
    expect(scoreContactTemperature(signals({ ...base, days_since_last_activity: 17 })).score).toBe(51);
    expect(scoreContactTemperature(signals({ ...base, days_since_last_activity: 90 })).score).toBe(0);
    // Never active: nothing to decay from.
    expect(scoreContactTemperature(signals({ status: 'engaged', days_since_last_activity: null })).score).toBe(10);
  });

  it('caps at 100 and buckets hot ≥70, warm ≥30, cold below', () => {
    const everything = scoreContactTemperature(
      signals({ calls_answered: 5, inbound_sms: 5, positive_dispositions: 5, talk_seconds: 6000, status: 'offer' }),
    );
    expect(everything.score).toBe(100);
    expect(everything.temperature).toBe('hot');
    expect(temperatureBucket(TEMPERATURE_HOT_MIN)).toBe('hot');
    expect(temperatureBucket(TEMPERATURE_HOT_MIN - 1)).toBe('warm');
    expect(temperatureBucket(TEMPERATURE_WARM_MIN)).toBe('warm');
    expect(temperatureBucket(TEMPERATURE_WARM_MIN - 1)).toBe('cold');
  });

  it('a worked seller reads hot; a cooling one reads warm', () => {
    const worked = scoreContactTemperature(
      signals({ calls_answered: 2, inbound_sms: 3, positive_dispositions: 1, status: 'engaged', days_since_last_activity: 2 }),
    );
    expect(worked.score).toBe(96);
    expect(worked.temperature).toBe('hot');
    const cooling = scoreContactTemperature(signals({ calls_answered: 1, inbound_sms: 2, days_since_last_activity: 12 }));
    expect(cooling.score).toBe(32); // 15 + 24 − 7.5, rounded
    expect(cooling.temperature).toBe('warm');
  });

  it('treats garbage counts as zero', () => {
    expect(scoreContactTemperature(signals({ calls_answered: -3, inbound_sms: Number.NaN })).score).toBe(0);
  });
});

describe('classifyDisposition', () => {
  it('reads the seeded dispositions the way a rep would', () => {
    expect(classifyDisposition('appointment', 'Appointment')).toBe('positive');
    expect(classifyDisposition('offer_made', 'Offer Made')).toBe('positive');
    expect(classifyDisposition('follow_up', 'Follow Up')).toBeNull();
    expect(classifyDisposition('not_interested', 'Not Interested')).toBe('negative');
    expect(classifyDisposition('wrong_number', 'Wrong Number')).toBe('negative');
    expect(classifyDisposition('dead_lead', 'Dead Lead')).toBe('negative');
    expect(classifyDisposition('dnc', 'DNC')).toBe('negative');
    expect(classifyDisposition('no_answer', 'No Answer')).toBeNull();
    expect(classifyDisposition('voicemail', 'Voicemail')).toBeNull();
    expect(classifyDisposition('other', 'Other')).toBeNull();
  });

  it('matches custom labels and slugs by keyword, negative first', () => {
    expect(classifyDisposition('very-interested')).toBe('positive');
    expect(classifyDisposition(null, 'Motivated seller')).toBe('positive');
    expect(classifyDisposition('callback_requested')).toBe('positive');
    expect(classifyDisposition('contract_signed')).toBe('positive');
    expect(classifyDisposition('Interested but do not call again')).toBe('negative');
    expect(classifyDisposition(undefined, undefined)).toBeNull();
    expect(classifyDisposition('')).toBeNull();
  });
});

describe('daysBetween', () => {
  it('counts whole days and never goes negative', () => {
    const t0 = new Date('2026-09-01T12:00:00Z');
    expect(daysBetween(t0, new Date('2026-09-01T23:00:00Z'))).toBe(0);
    expect(daysBetween(t0, new Date('2026-09-02T12:00:00Z'))).toBe(1);
    expect(daysBetween(t0, new Date('2026-09-09T11:59:00Z'))).toBe(7);
    expect(daysBetween(new Date('2026-09-05T00:00:00Z'), t0)).toBe(0);
  });
});
