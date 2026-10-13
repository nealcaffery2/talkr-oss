/**
 * Caller reputation: how a line looks to carriers and spam-labelling apps, and
 * the local rules that keep it from getting worse.
 *
 * Pure. Nothing here can promise a number is not labelled "Spam Likely" —
 * the analytics engines (Hiya, TNS, First Orion) decide that from signals we
 * only partly see. What we can do is show those signals (attestation, CNAM,
 * 10DLC registration, answer-rate trends, message failures) and stop the
 * behaviour that earns a label (burst volume, texting unregistered).
 *
 * Stored shapes are read with never-throwing readers: a blob written by an
 * older build degrades to "no limit / unknown", never to a refused call.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Per-number protection settings (phone_numbers.reputation)
// ---------------------------------------------------------------------------

/** Industry rule of thumb: past ~100 outbound calls a day one line starts to look like a robocaller. */
export const RECOMMENDED_DAILY_CALL_CAP = 100;

export const numberProtectionSchema = z
  .object({
    /** Outbound calls placed from this line per org-local day; null = no cap. */
    daily_call_cap: z.number().int().min(1).max(5000).nullable(),
    /** Outbound texts sent from this line per org-local day; null = no cap. */
    daily_sms_cap: z.number().int().min(1).max(10000).nullable(),
    /** Pause outbound calls from this line while a "possible spam label" warning is active. */
    pause_on_warning: z.boolean(),
  })
  .partial()
  .strict();

export interface NumberProtection {
  daily_call_cap: number | null;
  daily_sms_cap: number | null;
  pause_on_warning: boolean;
}

export const NUMBER_PROTECTION_DEFAULT: NumberProtection = {
  daily_call_cap: null,
  daily_sms_cap: null,
  pause_on_warning: false,
};

/** The protection settings out of phone_numbers.reputation. Never throws. */
export function readNumberProtection(reputation: unknown): NumberProtection {
  const raw = (reputation as { protection?: unknown } | null)?.protection;
  const parsed = numberProtectionSchema.safeParse(raw ?? {});
  return parsed.success ? { ...NUMBER_PROTECTION_DEFAULT, ...parsed.data } : NUMBER_PROTECTION_DEFAULT;
}

// ---------------------------------------------------------------------------
// CNAM (outbound caller name)
// ---------------------------------------------------------------------------

/** Carrier CNAM databases store 15 characters; Telnyx enforces letters, digits and spaces. */
export const CNAM_MAX = 15;

export function validateCnamName(input: string): { ok: true; value: string } | { ok: false; error: string } {
  const value = input.trim().replace(/\s+/g, ' ');
  if (value.length === 0) return { ok: false, error: 'caller name is empty' };
  if (value.length > CNAM_MAX) return { ok: false, error: `caller name is at most ${CNAM_MAX} characters` };
  if (!/^[A-Za-z0-9 ]+$/.test(value)) return { ok: false, error: 'caller name may only use letters, digits and spaces' };
  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// SMS registration gate (organizations.reputation.sms_gate)
// ---------------------------------------------------------------------------

/**
 * `auto`: warn while the workspace has no approved 10DLC campaign (nothing to
 * send from yet), block once one exists — at that point texting from an
 * unassigned number is a choice, and it is the one that gets numbers blocked.
 * `block` always refuses; `warn` never does.
 */
export const SMS_GATE_MODES = ['auto', 'block', 'warn'] as const;
export type SmsGateMode = (typeof SMS_GATE_MODES)[number];

export function readSmsGate(orgReputation: unknown): SmsGateMode {
  const v = (orgReputation as { sms_gate?: unknown } | null)?.sms_gate;
  return (SMS_GATE_MODES as readonly unknown[]).includes(v) ? (v as SmsGateMode) : 'auto';
}

export interface SmsGateInput {
  mode: SmsGateMode;
  /** +1 destinations are what A2P 10DLC governs. */
  toE164: string;
  /** From the last registration snapshot; null when never checked. */
  numberAssigned: boolean | null;
  /** The workspace has at least one campaign the carriers accepted. */
  orgHasApprovedCampaign: boolean;
}

export type SmsGateDecision = { action: 'allow' } | { action: 'warn' | 'block'; reason: string };

export function decideSmsGate(i: SmsGateInput): SmsGateDecision {
  // Non-NANP destinations are outside 10DLC; a number never checked is
  // unknown, and an unknown is never a reason to refuse a text.
  if (!i.toE164.startsWith('+1') || i.numberAssigned !== false) return { action: 'allow' };
  const reason = i.orgHasApprovedCampaign
    ? 'this number is not assigned to an approved 10DLC campaign; US carriers filter or block its texts'
    : 'this workspace has no approved 10DLC campaign yet; US carriers filter or block unregistered texts';
  const block = i.mode === 'block' || (i.mode === 'auto' && i.orgHasApprovedCampaign);
  return { action: block ? 'block' : 'warn', reason };
}

// ---------------------------------------------------------------------------
// Attestation
// ---------------------------------------------------------------------------

export type AttestationLevel = 'A' | 'B' | 'C';

export interface AttestationShare {
  total: number;
  A: number;
  B: number;
  C: number;
  /** Share of calls whose attestation was reported at all that were A (0..1), null with none. */
  a_share: number | null;
}

export function attestationShare(counts: Partial<Record<AttestationLevel, number>>): AttestationShare {
  const A = counts.A ?? 0;
  const B = counts.B ?? 0;
  const C = counts.C ?? 0;
  const total = A + B + C;
  return { total, A, B, C, a_share: total ? A / total : null };
}

// ---------------------------------------------------------------------------
// Health: warnings and the Good / Watch / At risk badge
// ---------------------------------------------------------------------------

export interface NumberHealthMetrics {
  calls_today: number;
  calls_7d: number;
  /** Outbound calls in the 7 days before the last 7. */
  calls_prior_7d: number;
  answered_7d: number;
  answered_prior_7d: number;
  /** Answered calls under 10 seconds (hang-ups on pickup). */
  short_calls_7d: number;
  sms_sent_7d: number;
  sms_failed_7d: number;
  /** Carrier error codes on failed texts in the window, with counts. */
  sms_error_codes: Record<string, number>;
  attestation_30d: AttestationShare;
}

export type WarningLevel = 'watch' | 'at_risk';

export interface ReputationWarning {
  code:
    | 'answer_rate_drop'
    | 'short_calls'
    | 'high_volume'
    | 'sms_failures'
    | 'sms_spam_blocked'
    | 'sms_unregistered'
    | 'attestation_not_a'
    | 'flagged_spam'
    | 'cnam_missing';
  level: WarningLevel;
  message: string;
}

/** Minimum outbound calls in both weeks before an answer-rate comparison means anything. */
export const ANSWER_DROP_MIN_CALLS = 30;
export const ANSWER_DROP_THRESHOLD = 0.4;

export const answerRate = (answered: number, calls: number): number | null => (calls > 0 ? answered / calls : null);

/**
 * Carrier errors that mean the traffic was judged spam or unregistered, as
 * opposed to a bad destination. Telnyx
 * (developers.telnyx.com/docs/messaging/messages/error-codes): 40002 / 40003
 * spam (temporary / permanent), 40015 Telnyx spam filter, 40017 AT&T 10DLC
 * spam, 40315 unhealthy sender, 40322 content blocked, 40010 not 10DLC
 * registered, 40329 toll-free not verified. Twilio: 30007 carrier filtered,
 * 30034 unregistered 10DLC.
 */
export const SMS_SPAM_ERROR_CODES: ReadonlySet<string> = new Set([
  '40002', '40003', '40015', '40017', '40315', '40322', '40010', '40329', '30007', '30034',
]);

export interface HealthContext {
  metrics: NumberHealthMetrics;
  /** Registration snapshot for this number; null when never checked or not texting. */
  sms_assigned: boolean | null;
  /** Carrier/analytics spam flag when a check exists; null when unknown. */
  flagged_spam: boolean | null;
  cnam_enabled: boolean | null;
  daily_call_cap: number | null;
}

export function reputationWarnings(h: HealthContext): ReputationWarning[] {
  const m = h.metrics;
  const out: ReputationWarning[] = [];
  const now = answerRate(m.answered_7d, m.calls_7d);
  const before = answerRate(m.answered_prior_7d, m.calls_prior_7d);
  if (
    now !== null && before !== null && before > 0 &&
    m.calls_7d >= ANSWER_DROP_MIN_CALLS && m.calls_prior_7d >= ANSWER_DROP_MIN_CALLS &&
    (before - now) / before > ANSWER_DROP_THRESHOLD
  ) {
    out.push({
      code: 'answer_rate_drop',
      level: 'at_risk',
      message: `Answer rate fell from ${pct(before)} to ${pct(now)} week over week — a common sign the number has picked up a spam label. Rest it, and check it at freecallerregistry.com.`,
    });
  }
  if (h.flagged_spam) {
    out.push({ code: 'flagged_spam', level: 'at_risk', message: 'A reputation check reports this number as flagged for spam.' });
  }
  const spamSms = Object.entries(m.sms_error_codes).filter(([c]) => SMS_SPAM_ERROR_CODES.has(c)).reduce((n, [, v]) => n + v, 0);
  if (spamSms > 0) {
    out.push({ code: 'sms_spam_blocked', level: 'at_risk', message: `${spamSms} text${spamSms === 1 ? '' : 's'} in the last 7 days were blocked as spam or unregistered traffic.` });
  }
  if (h.sms_assigned === false && m.sms_sent_7d > 0) {
    out.push({ code: 'sms_unregistered', level: 'at_risk', message: 'This number texts but is not assigned to an approved 10DLC campaign.' });
  }
  if (m.sms_sent_7d >= 20 && m.sms_failed_7d / m.sms_sent_7d > 0.1) {
    out.push({ code: 'sms_failures', level: 'watch', message: `${pct(m.sms_failed_7d / m.sms_sent_7d)} of texts failed in the last 7 days.` });
  }
  if (m.calls_7d >= ANSWER_DROP_MIN_CALLS && m.answered_7d > 0 && m.short_calls_7d / m.answered_7d > 0.5) {
    out.push({ code: 'short_calls', level: 'watch', message: `${pct(m.short_calls_7d / m.answered_7d)} of answered calls ended within 10 seconds — people are hanging up on pickup.` });
  }
  if (h.daily_call_cap === null && m.calls_today > RECOMMENDED_DAILY_CALL_CAP) {
    out.push({ code: 'high_volume', level: 'watch', message: `${m.calls_today} calls today from one line. Spread volume across lines or set a daily cap (${RECOMMENDED_DAILY_CALL_CAP} is a common ceiling).` });
  }
  const att = m.attestation_30d;
  if (att.total >= 5 && att.a_share !== null && att.a_share < 0.9) {
    out.push({ code: 'attestation_not_a', level: 'watch', message: `Only ${pct(att.a_share)} of reported calls carried A attestation. Calls should go out from a number you own on the carrier.` });
  }
  if (h.cnam_enabled === false) {
    out.push({ code: 'cnam_missing', level: 'watch', message: 'No outbound caller name (CNAM) is listed for this number.' });
  }
  return out;
}

/** True when a warning should pause a line that opted into pause_on_warning. */
export const isPauseWarning = (w: ReputationWarning) => w.code === 'answer_rate_drop' || w.code === 'flagged_spam';

export type ReputationGrade = 'good' | 'watch' | 'at_risk';

export function reputationGrade(warnings: ReputationWarning[]): ReputationGrade {
  if (warnings.some((w) => w.level === 'at_risk')) return 'at_risk';
  return warnings.length > 0 ? 'watch' : 'good';
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
