import { describe, expect, it } from 'vitest';
import {
  attestationShare,
  decideSmsGate,
  readNumberProtection,
  readSmsGate,
  reputationGrade,
  reputationWarnings,
  validateCnamName,
  type HealthContext,
  type NumberHealthMetrics,
} from '../src/reputation.js';

const quiet: NumberHealthMetrics = {
  calls_today: 0, calls_7d: 0, calls_prior_7d: 0, answered_7d: 0, answered_prior_7d: 0, short_calls_7d: 0,
  sms_sent_7d: 0, sms_failed_7d: 0, sms_error_codes: {}, attestation_30d: attestationShare({}),
};
const ctx = (m: Partial<NumberHealthMetrics>, rest: Partial<HealthContext> = {}): HealthContext => ({
  metrics: { ...quiet, ...m }, sms_assigned: null, flagged_spam: null, cnam_enabled: null, daily_call_cap: null, ...rest,
});
const codes = (h: HealthContext) => reputationWarnings(h).map((w) => w.code);

describe('CNAM names', () => {
  it('accepts up to 15 letters, digits and spaces, collapsing whitespace', () => {
    expect(validateCnamName('  Your  Company 1 ')).toEqual({ ok: true, value: 'Your Company 1' });
    expect(validateCnamName('ABCDEFGHIJKLMNO').ok).toBe(true);
  });
  it('refuses empty, too long, and punctuation', () => {
    expect(validateCnamName('   ').ok).toBe(false);
    expect(validateCnamName('ABCDEFGHIJKLMNOP').ok).toBe(false);
    expect(validateCnamName('Home-Pros').ok).toBe(false);
    expect(validateCnamName('Your Company™').ok).toBe(false);
  });
});

describe('stored settings never throw', () => {
  it('defaults protection and the sms gate from junk', () => {
    expect(readNumberProtection(null)).toEqual({ daily_call_cap: null, daily_sms_cap: null, pause_on_warning: false });
    expect(readNumberProtection({ protection: { daily_call_cap: 'lots' } }).daily_call_cap).toBeNull();
    expect(readNumberProtection({ protection: { daily_call_cap: 80 } })).toMatchObject({ daily_call_cap: 80, pause_on_warning: false });
    expect(readSmsGate({ sms_gate: 'nope' })).toBe('auto');
    expect(readSmsGate({ sms_gate: 'block' })).toBe('block');
  });
});

describe('SMS 10DLC gate', () => {
  const base = { mode: 'auto' as const, toE164: '+12105550100', numberAssigned: false, orgHasApprovedCampaign: false };
  it('only warns before the workspace has any approved campaign', () => {
    expect(decideSmsGate(base).action).toBe('warn');
  });
  it('blocks an unassigned line once a campaign is approved', () => {
    expect(decideSmsGate({ ...base, orgHasApprovedCampaign: true }).action).toBe('block');
  });
  it('never refuses on unknown registration, assigned lines, or non-US destinations', () => {
    expect(decideSmsGate({ ...base, mode: 'block', numberAssigned: null }).action).toBe('allow');
    expect(decideSmsGate({ ...base, mode: 'block', numberAssigned: true }).action).toBe('allow');
    expect(decideSmsGate({ ...base, mode: 'block', toE164: '+447700900000' }).action).toBe('allow');
  });
  it('honours explicit block and warn modes', () => {
    expect(decideSmsGate({ ...base, mode: 'block' }).action).toBe('block');
    expect(decideSmsGate({ ...base, mode: 'warn', orgHasApprovedCampaign: true }).action).toBe('warn');
  });
});

describe('attestation', () => {
  it('shares A/B/C', () => {
    expect(attestationShare({ A: 3, B: 1 })).toEqual({ total: 4, A: 3, B: 1, C: 0, a_share: 0.75 });
    expect(attestationShare({}).a_share).toBeNull();
  });
});

describe('warnings and the badge', () => {
  it('a quiet line is good', () => {
    expect(reputationGrade(reputationWarnings(ctx({})))).toBe('good');
  });

  it('flags an answer-rate drop over 40% only with 30+ calls in both weeks', () => {
    const dropped = { calls_7d: 40, answered_7d: 8, calls_prior_7d: 40, answered_prior_7d: 20 }; // 50% → 20%
    expect(codes(ctx(dropped))).toContain('answer_rate_drop');
    expect(reputationGrade(reputationWarnings(ctx(dropped)))).toBe('at_risk');
    expect(codes(ctx({ ...dropped, calls_7d: 29, answered_7d: 5 }))).not.toContain('answer_rate_drop');
    expect(codes(ctx({ ...dropped, answered_7d: 13 }))).not.toContain('answer_rate_drop'); // 32.5%: a 35% drop
  });

  it('spam-coded text failures are at risk; a plain failure rate is watch', () => {
    expect(reputationGrade(reputationWarnings(ctx({ sms_sent_7d: 10, sms_failed_7d: 1, sms_error_codes: { '40003': 1 } })))).toBe('at_risk');
    const w = reputationWarnings(ctx({ sms_sent_7d: 40, sms_failed_7d: 8, sms_error_codes: { '40001': 8 } }));
    expect(w.map((x) => x.code)).toEqual(['sms_failures']);
    expect(reputationGrade(w)).toBe('watch');
  });

  it('texting unregistered, carrier spam flag, short calls, volume, attestation, missing CNAM', () => {
    expect(codes(ctx({ sms_sent_7d: 1 }, { sms_assigned: false }))).toContain('sms_unregistered');
    expect(codes(ctx({}, { flagged_spam: true }))).toContain('flagged_spam');
    expect(codes(ctx({ calls_7d: 30, answered_7d: 10, short_calls_7d: 6 }))).toContain('short_calls');
    expect(codes(ctx({ calls_today: 101 }))).toContain('high_volume');
    expect(codes(ctx({ calls_today: 101 }, { daily_call_cap: 150 }))).not.toContain('high_volume');
    expect(codes(ctx({ attestation_30d: attestationShare({ A: 3, B: 3 }) }))).toContain('attestation_not_a');
    expect(codes(ctx({}, { cnam_enabled: false }))).toContain('cnam_missing');
    expect(codes(ctx({}, { cnam_enabled: null }))).not.toContain('cnam_missing');
  });
});
