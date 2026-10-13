/**
 * Dialer core units (docs/dialers.md): settings clamps (compliance caps),
 * calling windows (fail closed), lead selection, retry scheduling,
 * disposition outcomes, and abandonment-rate math with the ≤3% cap.
 */

import { describe, expect, it } from 'vitest';
import {
  ABANDONMENT_HARD_CAP_PERCENT,
  PARALLEL_LINES_HARD_CAP,
  abandonmentRate,
  campaignOutcomeForDisposition,
  computeRetrySchedule,
  conservativePacer,
  effectiveLineCount,
  isAbandonmentCapBreached,
  isMachineAnsweredBy,
  isWithinCallingWindow,
  pickNextCampaignLead,
  resolveCampaignSettings,
  timezoneForCandidate,
  type CampaignLeadCandidate,
  type SelectionContext,
} from '../src/dialer.js';

// 16:00 UTC on 2026-08-25 = 12:00 in New York (EDT) and 09:00 in Los Angeles.
const NOON_NY = new Date('2026-08-25T16:00:00Z');

describe('resolveCampaignSettings', () => {
  it('fills defaults', () => {
    const s = resolveCampaignSettings(undefined);
    expect(s.callingWindowStart).toBe('09:00');
    expect(s.callingWindowEnd).toBe('20:00');
    expect(s.timezonePolicy).toBe('lead');
    expect(s.maxAttemptsPerDay).toBe(2);
    expect(s.maxAttemptsTotal).toBe(8);
    expect(s.parallelLines).toBe(2);
    expect(s.abandonmentCapPercent).toBe(3);
    expect(s.amdEnabled).toBe(false);
    expect(s.amdAction).toBe('hangup');
  });

  it('hard-caps parallel lines at 3 no matter the config (C7)', () => {
    expect(resolveCampaignSettings({ parallelLines: 10 }).parallelLines).toBe(
      PARALLEL_LINES_HARD_CAP,
    );
    expect(resolveCampaignSettings({ parallelLines: 0 }).parallelLines).toBe(1);
  });

  it('the abandonment cap can never be configured above 3% (C4)', () => {
    expect(resolveCampaignSettings({ abandonmentCapPercent: 50 }).abandonmentCapPercent).toBe(
      ABANDONMENT_HARD_CAP_PERCENT,
    );
    expect(resolveCampaignSettings({ abandonmentCapPercent: 1 }).abandonmentCapPercent).toBe(1);
  });

  it('rejects malformed window strings back to defaults', () => {
    const s = resolveCampaignSettings({ callingWindowStart: '9am', callingWindowEnd: '25:99' });
    expect(s.callingWindowStart).toBe('09:00');
    expect(s.callingWindowEnd).toBe('20:00');
  });
});

describe('isWithinCallingWindow (fails closed — C3)', () => {
  it('true inside the window in the given timezone', () => {
    expect(
      isWithinCallingWindow({ timezone: 'America/New_York', start: '09:00', end: '20:00' }, NOON_NY),
    ).toBe(true);
  });

  it('false outside the window (same instant, different timezone)', () => {
    // 09:00 in LA with a 09:30 start — too early to auto-dial there.
    expect(
      isWithinCallingWindow(
        { timezone: 'America/Los_Angeles', start: '09:30', end: '20:00' },
        NOON_NY,
      ),
    ).toBe(false);
  });

  it('supports wrap-around windows', () => {
    expect(
      isWithinCallingWindow({ timezone: 'America/New_York', start: '20:00', end: '02:00' }, NOON_NY),
    ).toBe(false);
    const lateNight = new Date('2026-08-26T01:30:00Z'); // 21:30 in NY
    expect(
      isWithinCallingWindow(
        { timezone: 'America/New_York', start: '20:00', end: '02:00' },
        lateNight,
      ),
    ).toBe(true);
  });

  it('FAILS CLOSED on an invalid timezone — a config bug never enables dialing', () => {
    expect(
      isWithinCallingWindow({ timezone: 'Not/AZone', start: '09:00', end: '20:00' }, NOON_NY),
    ).toBe(false);
  });

  it('fails closed on malformed times and zero-width windows', () => {
    expect(
      isWithinCallingWindow({ timezone: 'America/New_York', start: 'oops', end: '20:00' }, NOON_NY),
    ).toBe(false);
    expect(
      isWithinCallingWindow({ timezone: 'America/New_York', start: '09:00', end: '09:00' }, NOON_NY),
    ).toBe(false);
  });

  it('timezoneForCandidate: lead tz when known, else org; org policy always org', () => {
    expect(timezoneForCandidate('lead', 'America/Chicago', 'America/New_York')).toBe(
      'America/Chicago',
    );
    expect(timezoneForCandidate('lead', null, 'America/New_York')).toBe('America/New_York');
    expect(timezoneForCandidate('org', 'America/Chicago', 'America/New_York')).toBe(
      'America/New_York',
    );
  });
});

// ---------------------------------------------------------------------------
// Selection
// ---------------------------------------------------------------------------

let seq = 0;
function candidate(over: Partial<CampaignLeadCandidate> = {}): CampaignLeadCandidate {
  seq += 1;
  return {
    id: `cl-${seq}`,
    leadId: `lead-${seq}`,
    status: 'pending',
    attempts: 0,
    attemptsToday: 0,
    nextAttemptAt: null,
    priority: 0,
    createdAt: new Date(Date.parse('2026-08-01T00:00:00Z') + seq * 1000),
    lastAttemptAt: null,
    phoneE164: `+1614555${String(1000 + seq).slice(-4)}`,
    timezone: null,
    ...over,
  };
}

function ctx(over: Partial<SelectionContext> = {}): SelectionContext {
  return {
    settings: resolveCampaignSettings({}),
    orgTimezone: 'America/New_York',
    suppressedNumbers: new Set(),
    now: NOON_NY,
    ...over,
  };
}

describe('pickNextCampaignLead', () => {
  it('orders by priority DESC, then fresh (no retry time) first, then oldest', () => {
    const low = candidate({ priority: 0 });
    const high = candidate({ priority: 5 });
    expect(pickNextCampaignLead([low, high], ctx()).pick?.id).toBe(high.id);

    const retried = candidate({ nextAttemptAt: new Date(NOON_NY.getTime() - 1000) });
    const fresh = candidate();
    expect(pickNextCampaignLead([retried, fresh], ctx()).pick?.id).toBe(fresh.id);

    const older = candidate();
    const newer = candidate();
    expect(pickNextCampaignLead([newer, older], ctx()).pick?.id).toBe(older.id);
  });

  it('honors next_attempt_at: future retries wait (waiting_retries)', () => {
    const waiting = candidate({ nextAttemptAt: new Date(NOON_NY.getTime() + 60_000) });
    const result = pickNextCampaignLead([waiting], ctx());
    expect(result.pick).toBeNull();
    expect(result.idleReason).toBe('waiting_retries');
  });

  it('enforces the total attempt cap (C5)', () => {
    const exhausted = candidate({ attempts: 8 });
    const ok = candidate({ attempts: 7 });
    const result = pickNextCampaignLead([exhausted, ok], ctx());
    expect(result.pick?.id).toBe(ok.id);
    expect(pickNextCampaignLead([exhausted], ctx()).idleReason).toBe('exhausted');
  });

  it('enforces the per-day attempt cap (C5)', () => {
    const cappedToday = candidate({ attemptsToday: 2 });
    const ok = candidate({ attemptsToday: 1 });
    expect(pickNextCampaignLead([cappedToday, ok], ctx()).pick?.id).toBe(ok.id);
    expect(pickNextCampaignLead([cappedToday], ctx()).idleReason).toBe('waiting_retries');
  });

  it('never picks a suppressed number and reports it for marking (C1)', () => {
    const suppressed = candidate({ priority: 10 });
    const clean = candidate();
    const result = pickNextCampaignLead([suppressed, clean], ctx({
      suppressedNumbers: new Set([suppressed.phoneE164!]),
    }));
    expect(result.pick?.id).toBe(clean.id);
    expect(result.suppressed.map((s) => s.id)).toEqual([suppressed.id]);
  });

  it('skips leads outside their local calling window (C3, per-lead timezone)', () => {
    // At 16:00 UTC: 12:00 in NY (inside 09:30–20:00), 09:00 in LA (outside).
    const la = candidate({ timezone: 'America/Los_Angeles', priority: 10 });
    const ny = candidate({ timezone: 'America/New_York' });
    const settings = resolveCampaignSettings({ callingWindowStart: '09:30' });
    const result = pickNextCampaignLead([la, ny], ctx({ settings }));
    expect(result.pick?.id).toBe(ny.id);

    const onlyLa = pickNextCampaignLead([la], ctx({ settings }));
    expect(onlyLa.pick).toBeNull();
    expect(onlyLa.idleReason).toBe('outside_calling_window');
  });

  it('skips non-pending, phoneless, and excluded candidates; empty = no_leads', () => {
    const done = candidate({ status: 'contacted' });
    const noPhone = candidate({ phoneE164: null });
    const excluded = candidate();
    const result = pickNextCampaignLead([done, noPhone, excluded], ctx({
      excludeIds: new Set([excluded.id]),
    }));
    expect(result.pick).toBeNull();
    expect(pickNextCampaignLead([], ctx()).idleReason).toBe('no_leads');
  });
});

// ---------------------------------------------------------------------------
// Retry scheduling + disposition outcomes
// ---------------------------------------------------------------------------

describe('computeRetrySchedule', () => {
  const settings = { retryBackoffHours: 4, maxAttemptsTotal: 8 };

  it('backs off exponentially: 4h, 8h, 16h … capped at 72h', () => {
    const h = 3_600_000;
    expect(computeRetrySchedule(1, settings, NOON_NY).nextAttemptAt!.getTime()).toBe(
      NOON_NY.getTime() + 4 * h,
    );
    expect(computeRetrySchedule(2, settings, NOON_NY).nextAttemptAt!.getTime()).toBe(
      NOON_NY.getTime() + 8 * h,
    );
    expect(computeRetrySchedule(6, settings, NOON_NY).nextAttemptAt!.getTime()).toBe(
      NOON_NY.getTime() + 72 * h, // 4·2^5 = 128h → capped
    );
  });

  it('completes the lead at the attempt cap instead of scheduling', () => {
    const decision = computeRetrySchedule(8, settings, NOON_NY);
    expect(decision.status).toBe('completed');
    expect(decision.nextAttemptAt).toBeNull();
  });
});

describe('campaignOutcomeForDisposition', () => {
  const base = {
    attempts: 2,
    settings: { retryBackoffHours: 4, maxAttemptsTotal: 8 },
    now: NOON_NY,
  };

  it('DNC → suppressed; conversation → contacted; wrong number → completed', () => {
    expect(
      campaignOutcomeForDisposition({
        ...base, dispositionSlug: 'dnc', addsSuppression: true, treatAsConversation: false,
      }).status,
    ).toBe('suppressed');
    expect(
      campaignOutcomeForDisposition({
        ...base, dispositionSlug: 'follow_up', addsSuppression: false, treatAsConversation: true,
      }).status,
    ).toBe('contacted');
    expect(
      campaignOutcomeForDisposition({
        ...base, dispositionSlug: 'wrong_number', addsSuppression: false, treatAsConversation: false,
      }).status,
    ).toBe('completed');
  });

  it('non-conversation outcomes retry with backoff, or complete at the cap', () => {
    const retry = campaignOutcomeForDisposition({
      ...base, dispositionSlug: 'no_answer', addsSuppression: false, treatAsConversation: false,
    });
    expect(retry.status).toBe('pending');
    expect(retry.nextAttemptAt).not.toBeNull();
    expect(retry.lastOutcome).toBe('no_answer');

    const capped = campaignOutcomeForDisposition({
      ...base, attempts: 8,
      dispositionSlug: 'no_answer', addsSuppression: false, treatAsConversation: false,
    });
    expect(capped.status).toBe('completed');
    expect(capped.lastOutcome).toBe('max_attempts');
  });
});

// ---------------------------------------------------------------------------
// Abandonment (C4)
// ---------------------------------------------------------------------------

describe('abandonment rate + cap decision', () => {
  it('rate math; zero answered measures nothing', () => {
    expect(abandonmentRate({ answered: 0, abandoned: 0 })).toBe(0);
    expect(abandonmentRate({ answered: 100, abandoned: 3 })).toBeCloseTo(0.03);
  });

  it('breaches strictly above 3%: the very first abandon trips it', () => {
    expect(isAbandonmentCapBreached({ answered: 1, abandoned: 1 }, 3)).toBe(true);
    expect(isAbandonmentCapBreached({ answered: 33, abandoned: 1 }, 3)).toBe(true); // 3.03%
    expect(isAbandonmentCapBreached({ answered: 100, abandoned: 3 }, 3)).toBe(false); // 3.00%
    expect(isAbandonmentCapBreached({ answered: 0, abandoned: 0 }, 3)).toBe(false);
  });

  it('recovers when the windowed rate falls back under the cap', () => {
    expect(isAbandonmentCapBreached({ answered: 10, abandoned: 1 }, 3)).toBe(true);
    // The window rolled: same abandon count over many more answered calls.
    expect(isAbandonmentCapBreached({ answered: 200, abandoned: 1 }, 3)).toBe(false);
  });

  it('a configured cap above 3 is still evaluated at 3 (hard cap)', () => {
    expect(isAbandonmentCapBreached({ answered: 10, abandoned: 1 }, 50)).toBe(true);
  });

  it('effectiveLineCount honors the reduction and the hard cap', () => {
    const settings = resolveCampaignSettings({ parallelLines: 3 });
    expect(effectiveLineCount(settings, null)).toBe(3);
    expect(effectiveLineCount(settings, 1)).toBe(1);
    expect(effectiveLineCount(resolveCampaignSettings({ parallelLines: 99 }), null)).toBe(3);
  });
});

describe('AMD + pacing interface', () => {
  it('classifies machine AnsweredBy values', () => {
    expect(isMachineAnsweredBy('machine_start')).toBe(true);
    expect(isMachineAnsweredBy('machine_end_beep')).toBe(true);
    expect(isMachineAnsweredBy('fax')).toBe(true);
    expect(isMachineAnsweredBy('human')).toBe(false);
    expect(isMachineAnsweredBy(undefined)).toBe(false);
  });

  it('conservativePacer collapses to progressive at the abandonment cap (designed-only)', () => {
    expect(conservativePacer({
      availableReps: 0, expectedAnswerRate: 0.3, expectedWrapupSeconds: 30,
      abandonRate: 0, abandonCapPercent: 3,
    }).linesToDial).toBe(0);
    const atCap = conservativePacer({
      availableReps: 2, expectedAnswerRate: 0.3, expectedWrapupSeconds: 30,
      abandonRate: 0.03, abandonCapPercent: 3,
    });
    expect(atCap.linesToDial).toBe(2); // headroom 0 → 1 line per rep
    const roomy = conservativePacer({
      availableReps: 2, expectedAnswerRate: 0.2, expectedWrapupSeconds: 30,
      abandonRate: 0, abandonCapPercent: 3,
    });
    expect(roomy.linesToDial).toBeLessThanOrEqual(2 * PARALLEL_LINES_HARD_CAP);
    expect(roomy.linesToDial).toBeGreaterThanOrEqual(2);
  });
});
