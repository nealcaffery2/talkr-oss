/**
 * Dialer domain logic (docs/dialers.md). Pure functions only — the server
 * feeds plain data and applies the results.
 *   §1 campaign settings resolution (every value clamped; compliance caps
 *      cannot be configured away)
 *   §3 lead selection (suppression, attempt caps, calling windows, priority)
 *   §4 retry scheduling + disposition→outcome mapping
 *   §7 abandonment-rate math with the ≤3% hard-cap decision function
 *   §6 predictive pacing interface — designed, DISABLED by config, untuned
 */

export type CampaignMode = 'power' | 'progressive' | 'parallel' | 'predictive';
export type CampaignStatus = 'draft' | 'active' | 'paused' | 'archived';
export type CampaignLeadStatus =
  | 'pending'
  | 'in_progress'
  | 'contacted'
  | 'completed'
  | 'suppressed'
  | 'removed';

export const CAMPAIGN_MODES: readonly CampaignMode[] = ['power', 'progressive', 'parallel', 'predictive'];
export const CAMPAIGN_STATUSES: readonly CampaignStatus[] = ['draft', 'active', 'paused', 'archived'];

/** FTC guidance: ≤3% of answered calls abandoned. Not configurable above. */
export const ABANDONMENT_HARD_CAP_PERCENT = 3;
/** Never more than 3 simultaneous PSTN lines per rep, whatever the config says. */
export const PARALLEL_LINES_HARD_CAP = 3;
/** Rolling window for the abandonment rate (FTC measures per campaign / 30 days). */
export const ABANDONMENT_WINDOW_DAYS = 30;

export interface CampaignSettings {
  callerIdPhoneNumberId?: string;
  /** "HH:MM" local start/end of the allowed auto-dial window. */
  callingWindowStart?: string;
  callingWindowEnd?: string;
  /** 'lead' = lead timezone when known, else org; 'org' = always org. */
  timezonePolicy?: 'lead' | 'org';
  maxAttemptsPerDay?: number;
  maxAttemptsTotal?: number;
  retryBackoffHours?: number;
  parallelLines?: number;
  abandonmentCapPercent?: number;
  amdEnabled?: boolean;
  amdAction?: 'hangup' | 'voicemail_drop';
  amdVoicemailText?: string;
}

export interface ResolvedCampaignSettings {
  callerIdPhoneNumberId: string | null;
  callingWindowStart: string;
  callingWindowEnd: string;
  timezonePolicy: 'lead' | 'org';
  maxAttemptsPerDay: number;
  maxAttemptsTotal: number;
  retryBackoffHours: number;
  parallelLines: number;
  abandonmentCapPercent: number;
  amdEnabled: boolean;
  amdAction: 'hangup' | 'voicemail_drop';
  amdVoicemailText: string;
}

const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * Fill defaults and clamp every value. The compliance-critical clamps are the
 * point: parallelLines can never exceed 3 and abandonmentCapPercent can never
 * exceed the FTC 3% line, no matter what the stored jsonb says.
 */
export function resolveCampaignSettings(raw: CampaignSettings | null | undefined): ResolvedCampaignSettings {
  const s = raw ?? {};
  return {
    callerIdPhoneNumberId: s.callerIdPhoneNumberId ?? null,
    callingWindowStart: HHMM.test(s.callingWindowStart ?? '') ? s.callingWindowStart! : '09:00',
    callingWindowEnd: HHMM.test(s.callingWindowEnd ?? '') ? s.callingWindowEnd! : '20:00',
    timezonePolicy: s.timezonePolicy === 'org' ? 'org' : 'lead',
    maxAttemptsPerDay: clampInt(s.maxAttemptsPerDay, 2, 1, 6),
    maxAttemptsTotal: clampInt(s.maxAttemptsTotal, 8, 1, 30),
    retryBackoffHours: clampInt(s.retryBackoffHours, 4, 1, 72),
    parallelLines: clampInt(s.parallelLines, 2, 1, PARALLEL_LINES_HARD_CAP),
    abandonmentCapPercent: Math.min(
      typeof s.abandonmentCapPercent === 'number' && s.abandonmentCapPercent > 0
        ? s.abandonmentCapPercent
        : ABANDONMENT_HARD_CAP_PERCENT,
      ABANDONMENT_HARD_CAP_PERCENT,
    ),
    amdEnabled: s.amdEnabled === true,
    amdAction: s.amdAction === 'voicemail_drop' ? 'voicemail_drop' : 'hangup',
    amdVoicemailText:
      typeof s.amdVoicemailText === 'string' && s.amdVoicemailText.trim().length > 0
        ? s.amdVoicemailText
        : 'Sorry we missed you. We will try to reach you again. Goodbye.',
  };
}

// ---------------------------------------------------------------------------
// Calling window (docs/dialers.md §7 C3) — FAILS CLOSED on bad timezone data.
// Auto-dialing is machine-initiated: a config bug must block dialing, never
// enable it (contrast isWithinSmsSendWindow, which fails open for human
// replies to an active conversation).
// ---------------------------------------------------------------------------

export interface CallingWindowInput {
  /** IANA timezone the window is evaluated in (lead tz if known, else org). */
  timezone: string;
  /** "HH:MM" inclusive start. */
  start: string;
  /** "HH:MM" exclusive end. */
  end: string;
}

export function isWithinCallingWindow(input: CallingWindowInput, now: Date): boolean {
  if (!HHMM.test(input.start) || !HHMM.test(input.end)) return false; // fail closed
  if (input.start === input.end) return false; // zero-width window = never dial
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: input.timezone,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(now);
  } catch {
    return false; // invalid timezone — fail closed, never auto-dial on a bug
  }
  const hour = parts.find((p) => p.type === 'hour')?.value ?? '';
  const minute = parts.find((p) => p.type === 'minute')?.value ?? '';
  if (!hour || !minute) return false;
  const hm = `${hour === '24' ? '00' : hour}:${minute}`;
  if (input.start < input.end) return hm >= input.start && hm < input.end;
  return hm >= input.start || hm < input.end; // wrap-around window
}

/** Which timezone a candidate's window is evaluated in (docs/dialers.md §10.1). */
export function timezoneForCandidate(
  policy: 'lead' | 'org',
  leadTimezone: string | null | undefined,
  orgTimezone: string,
): string {
  if (policy === 'org') return orgTimezone;
  return leadTimezone && leadTimezone.trim().length > 0 ? leadTimezone : orgTimezone;
}

// ---------------------------------------------------------------------------
// Lead selection (docs/dialers.md §3 step 5)
// ---------------------------------------------------------------------------

export interface CampaignLeadCandidate {
  /** campaign_leads.id */
  id: string;
  leadId: string;
  status: CampaignLeadStatus;
  attempts: number;
  /** Dials already made today (org-local day), counted from the calls table. */
  attemptsToday: number;
  nextAttemptAt: Date | null;
  priority: number;
  createdAt: Date;
  lastAttemptAt: Date | null;
  /** Destination number (primary contact phone), E.164. Null = undialable. */
  phoneE164: string | null;
  /** Lead-local IANA timezone when known (leads.raw.timezone). */
  timezone?: string | null;
}

export type SelectionIdleReason =
  | 'no_leads'
  | 'exhausted'
  | 'waiting_retries'
  | 'outside_calling_window';

export interface SelectionResult {
  pick: CampaignLeadCandidate | null;
  /** Candidates found suppressed at selection time (mark + skip — C1). */
  suppressed: CampaignLeadCandidate[];
  idleReason?: SelectionIdleReason;
}

export interface SelectionContext {
  settings: ResolvedCampaignSettings;
  orgTimezone: string;
  /** E.164 numbers currently suppressed for voice in this org/campaign. */
  suppressedNumbers: ReadonlySet<string>;
  now: Date;
  /** campaign_lead ids to skip (e.g. already picked for this parallel batch). */
  excludeIds?: ReadonlySet<string>;
}

function candidateOrder(a: CampaignLeadCandidate, b: CampaignLeadCandidate): number {
  if (a.priority !== b.priority) return b.priority - a.priority; // priority DESC
  const an = a.nextAttemptAt ? a.nextAttemptAt.getTime() : -1; // NULLS FIRST (fresh leads)
  const bn = b.nextAttemptAt ? b.nextAttemptAt.getTime() : -1;
  if (an !== bn) return an - bn;
  return a.createdAt.getTime() - b.createdAt.getTime();
}

/**
 * Pick the next dialable campaign lead from plain data. Honors, in order:
 * status, retry timing (next_attempt_at), attempt caps (total + per-day),
 * the suppression set, and the calling window (per-candidate timezone).
 * Returns the pick plus every candidate that must be marked suppressed, or
 * an explicit idle reason when nothing is dialable right now.
 */
export function pickNextCampaignLead(
  candidates: CampaignLeadCandidate[],
  ctx: SelectionContext,
): SelectionResult {
  const { settings, now } = ctx;
  const suppressed: CampaignLeadCandidate[] = [];
  let sawWaitingRetry = false;
  let sawOutsideWindow = false;
  let sawEligibleStatus = false;

  const ordered = [...candidates].sort(candidateOrder);
  for (const c of ordered) {
    if (ctx.excludeIds?.has(c.id)) continue;
    if (c.status !== 'pending') continue;
    sawEligibleStatus = true;
    if (!c.phoneE164) continue; // no number on file — undialable, skip
    if (c.attempts >= settings.maxAttemptsTotal) continue; // exhausted (caller marks completed)
    if (c.nextAttemptAt && c.nextAttemptAt.getTime() > now.getTime()) {
      sawWaitingRetry = true;
      continue;
    }
    if (c.attemptsToday >= settings.maxAttemptsPerDay) {
      sawWaitingRetry = true; // eligible again tomorrow
      continue;
    }
    if (ctx.suppressedNumbers.has(c.phoneE164)) {
      suppressed.push(c); // C1: mark + skip, never dial
      continue;
    }
    const tz = timezoneForCandidate(settings.timezonePolicy, c.timezone, ctx.orgTimezone);
    if (
      !isWithinCallingWindow(
        { timezone: tz, start: settings.callingWindowStart, end: settings.callingWindowEnd },
        now,
      )
    ) {
      sawOutsideWindow = true; // C3: never auto-dial outside the window
      continue;
    }
    return { pick: c, suppressed };
  }

  const idleReason: SelectionIdleReason = sawOutsideWindow
    ? 'outside_calling_window'
    : sawWaitingRetry
      ? 'waiting_retries'
      : sawEligibleStatus
        ? 'exhausted'
        : 'no_leads';
  return { pick: null, suppressed, idleReason };
}

// ---------------------------------------------------------------------------
// Retry scheduling + disposition outcomes (docs/dialers.md §4)
// ---------------------------------------------------------------------------

export interface RetryDecision {
  status: 'pending' | 'completed';
  nextAttemptAt: Date | null;
}

const RETRY_BACKOFF_CAP_HOURS = 72;

/**
 * Schedule the next attempt after a non-conversation outcome. Backoff:
 * retryBackoffHours · 2^(attempts−1), capped at 72h. At the total attempt
 * cap the lead completes (last_outcome 'max_attempts' — caller stamps it).
 */
export function computeRetrySchedule(
  attempts: number,
  settings: Pick<ResolvedCampaignSettings, 'retryBackoffHours' | 'maxAttemptsTotal'>,
  now: Date,
): RetryDecision {
  if (attempts >= settings.maxAttemptsTotal) {
    return { status: 'completed', nextAttemptAt: null };
  }
  const exponent = Math.max(attempts - 1, 0);
  const hours = Math.min(settings.retryBackoffHours * 2 ** exponent, RETRY_BACKOFF_CAP_HOURS);
  return { status: 'pending', nextAttemptAt: new Date(now.getTime() + hours * 3_600_000) };
}

export interface DispositionOutcomeInput {
  dispositionSlug: string;
  addsSuppression: boolean;
  treatAsConversation: boolean;
  attempts: number;
  settings: Pick<ResolvedCampaignSettings, 'retryBackoffHours' | 'maxAttemptsTotal'>;
  now: Date;
}

export interface CampaignLeadOutcome {
  status: CampaignLeadStatus;
  nextAttemptAt: Date | null;
  lastOutcome: string;
}

/** Disposition → campaign_lead outcome (docs/dialers.md §4 table). */
export function campaignOutcomeForDisposition(input: DispositionOutcomeInput): CampaignLeadOutcome {
  if (input.addsSuppression) {
    return { status: 'suppressed', nextAttemptAt: null, lastOutcome: input.dispositionSlug };
  }
  if (input.treatAsConversation) {
    return { status: 'contacted', nextAttemptAt: null, lastOutcome: input.dispositionSlug };
  }
  if (input.dispositionSlug === 'wrong_number') {
    return { status: 'completed', nextAttemptAt: null, lastOutcome: input.dispositionSlug };
  }
  const retry = computeRetrySchedule(input.attempts, input.settings, input.now);
  return {
    status: retry.status,
    nextAttemptAt: retry.nextAttemptAt,
    lastOutcome: retry.status === 'completed' ? 'max_attempts' : input.dispositionSlug,
  };
}

// ---------------------------------------------------------------------------
// Abandonment rate (docs/dialers.md §7 C4) — hard ≤3% cap
// ---------------------------------------------------------------------------

export interface AbandonmentStats {
  /** Calls answered by a human in the rolling window (machine-answered excluded). */
  answered: number;
  /** Of those, calls we abandoned (answered, no rep to bridge). */
  abandoned: number;
}

/** Rate as a fraction (0..1). Zero answered calls = rate 0 (nothing measured). */
export function abandonmentRate(stats: AbandonmentStats): number {
  if (stats.answered <= 0) return 0;
  return stats.abandoned / stats.answered;
}

/**
 * The cap decision. Strictly-greater comparison against the cap percent:
 * with the default 3% cap, 1 abandon in 33 answered (3.03%) breaches; 3 in
 * 100 (3.00%) does not. With few samples this is aggressive by design — the
 * very first abandoned call breaches (1/1 = 100%) and drops the session to
 * one line. Compliance-first: recovery happens as the window rolls, not by
 * giving the benefit of the doubt. Pure and symmetric: when the windowed
 * rate falls back under the cap this returns false again (recovery), though
 * an in-flight session's line reduction stays sticky (docs/dialers.md §10.6).
 */
export function isAbandonmentCapBreached(stats: AbandonmentStats, capPercent: number): boolean {
  const cap = Math.min(capPercent, ABANDONMENT_HARD_CAP_PERCENT);
  if (stats.answered <= 0) return false;
  return abandonmentRate(stats) * 100 > cap;
}

/** Effective simultaneous lines for a parallel session right now. */
export function effectiveLineCount(
  settings: Pick<ResolvedCampaignSettings, 'parallelLines'>,
  currentLineLimit: number | null,
): number {
  const configured = Math.min(settings.parallelLines, PARALLEL_LINES_HARD_CAP);
  if (currentLineLimit != null) return Math.max(1, Math.min(configured, currentLineLimit));
  return Math.max(1, configured);
}

// ---------------------------------------------------------------------------
// AMD helpers (docs/dialers.md §8)
// ---------------------------------------------------------------------------

/** Twilio AnsweredBy values that mean "not a human picked up". */
export function isMachineAnsweredBy(answeredBy: string | null | undefined): boolean {
  if (!answeredBy) return false;
  return answeredBy.startsWith('machine_') || answeredBy === 'fax';
}

// ---------------------------------------------------------------------------
// Predictive pacing — DESIGNED, DISABLED (docs/dialers.md §6).
// This interface ships so the algorithm is reviewable; no code path invokes
// it while DIALER_PREDICTIVE_ENABLED is false (the default, set nowhere).
// Tuning it responsibly requires real-world answer/abandon statistics that
// do not exist yet.
// ---------------------------------------------------------------------------

export interface PacingInput {
  /** Reps ready to take a bridged call right now. */
  availableReps: number;
  /** Observed answer rate for this campaign (0..1) — must come from history. */
  expectedAnswerRate: number;
  /** Observed average wrap-up seconds — must come from history. */
  expectedWrapupSeconds: number;
  /** Current rolling abandonment rate (0..1). */
  abandonRate: number;
  /** The campaign's cap percent (≤3). */
  abandonCapPercent: number;
}

export interface PacingDecision {
  linesToDial: number;
}

export type PacingStrategy = (input: PacingInput) => PacingDecision;

/**
 * Classic answer-rate pacing with a safety factor that collapses toward
 * progressive (1 line per available rep) as the measured abandonment rate
 * approaches the cap. Documented for review; disabled in configuration.
 */
export const conservativePacer: PacingStrategy = (input) => {
  if (input.availableReps <= 0) return { linesToDial: 0 };
  const answerRate = Math.min(Math.max(input.expectedAnswerRate, 0.05), 1);
  // Headroom 1 → far from the cap, 0 → at/over the cap.
  const cap = Math.min(input.abandonCapPercent, ABANDONMENT_HARD_CAP_PERCENT) / 100;
  const headroom = cap <= 0 ? 0 : Math.min(Math.max(1 - input.abandonRate / cap, 0), 1);
  const raw = (input.availableReps / answerRate) * headroom;
  const lines = Math.max(input.availableReps, Math.floor(raw));
  // Never predictively exceed the same hard per-rep line cap parallel obeys.
  return { linesToDial: Math.min(lines, input.availableReps * PARALLEL_LINES_HARD_CAP) };
};
