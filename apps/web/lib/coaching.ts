/**
 * Client-side helpers for the coaching card and the coaching view
 * (docs/coaching.md). The web app does not depend on @talkr/core, so the
 * small pure bits the pages need — the category order and labels, the score
 * bands, the talk-ratio arithmetic — are mirrored here from
 * packages/core/src/coaching.ts, which stays the source of truth. Nothing
 * here decides anything the server does not already know.
 */

/** The ten rubric categories, in the order a call runs. */
export const COACHING_CATEGORIES: Array<{ id: string; label: string; hint: string }> = [
  { id: 'opener', label: 'Opener', hint: 'Intro and intent in the first thirty seconds.' },
  { id: 'rapport', label: 'Rapport', hint: 'Tone, listening, empathy, warmth.' },
  { id: 'discovery', label: 'Discovery', hint: 'Dug for the pain: motivation, timeline, condition.' },
  { id: 'qualifying', label: 'Qualifying', hint: 'Decision makers, occupancy, payoff, liens.' },
  { id: 'anchoring', label: 'Anchoring', hint: 'Set the price expectation early and showed the math.' },
  { id: 'objection_handling', label: 'Objection handling', hint: 'Education over argument.' },
  { id: 'close_attempt', label: 'Close attempt', hint: 'Asked for the deal directly.' },
  { id: 'confidence', label: 'Confidence', hint: 'Assertive, no apology, owned the call.' },
  { id: 'listening', label: 'Listening', hint: 'Let the seller talk; did not talk over them.' },
  { id: 'next_step_control', label: 'Next step', hint: 'Left with a specific agreed next touch.' },
];

export function categoryLabel(id: string): string {
  return COACHING_CATEGORIES.find((c) => c.id === id)?.label ?? id.replace(/_/g, ' ');
}

export const SELLER_BUCKET_LABELS: Record<string, string> = {
  motivated_priced_right: 'Motivated · right price',
  motivated_priced_high: 'Motivated · high price',
  unmotivated_priced_right: 'Unmotivated · right price',
  unmotivated_priced_high: 'Unmotivated · high price',
  wrong_number: 'Wrong number',
  unqualified: 'Unqualified',
  unknown: 'Not enough call to say',
};

export const RECOMMENDED_PLAY_LABELS: Record<string, string> = {
  lock_it_up: 'Lock it up',
  navigate: 'Navigate the price gap',
  dig_deeper: 'Dig deeper',
  walk_away: 'Walk away',
  verify_owner: 'Verify the owner',
  drop: 'Drop',
  callback: 'Call back',
};

export type ScoreBand = 'strong' | 'solid' | 'developing' | 'weak';

/** Bands follow the rubric's calibration: top reps 7–8, average 5–6, mistakes 3–4. */
export function scoreBand(overall: number): ScoreBand {
  if (overall >= 70) return 'strong';
  if (overall >= 50) return 'solid';
  if (overall >= 30) return 'developing';
  return 'weak';
}

export const BAND_COLOR: Record<ScoreBand, string> = {
  strong: 'var(--green)',
  solid: 'var(--accent)',
  developing: 'var(--amber)',
  weak: 'var(--red)',
};

export const BAND_LABEL: Record<ScoreBand, string> = {
  strong: 'Strong',
  solid: 'Solid',
  developing: 'Developing',
  weak: 'Needs work',
};

/** The colour of one 0–10 category score, on the same calibration. */
export function categoryColor(score: number | null | undefined): string {
  if (score == null) return 'var(--muted-2)';
  return BAND_COLOR[scoreBand(score * 10)];
}

export const TALK_RATIO_TARGET = { min: 0.4, max: 0.45 } as const;
const TALK_RATIO_TOLERANCE = 0.05;

export type TalkRatioVerdict = 'seller_heavy' | 'near_target' | 'on_target' | 'rep_heavy';

export function talkRatioVerdict(ratio: number | null | undefined): TalkRatioVerdict | null {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  if (ratio < TALK_RATIO_TARGET.min - TALK_RATIO_TOLERANCE) return 'seller_heavy';
  if (ratio > TALK_RATIO_TARGET.max + TALK_RATIO_TOLERANCE) return 'rep_heavy';
  if (ratio < TALK_RATIO_TARGET.min || ratio > TALK_RATIO_TARGET.max) return 'near_target';
  return 'on_target';
}

export const TALK_RATIO_NOTE: Record<TalkRatioVerdict, string> = {
  on_target: 'On target — about 40–45% rep is what a discovery call should sound like.',
  near_target: 'Close to the 40–45% rep target for a discovery call.',
  rep_heavy: 'The rep did most of the talking. Target for discovery is about 40–45%.',
  seller_heavy: 'The seller carried the call. Fine when they are pouring it out; thin if the rep never steered.',
};

/** The bar's halves as whole percents that always sum to 100. */
export function talkRatioSplit(ratio: number | null | undefined): { rep: number; seller: number } | null {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  const rep = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  return { rep, seller: 100 - rep };
}

/** "+4.2" / "−1.0" / "—" for a period-over-period move. */
export function formatTrend(trend: number | null): string {
  if (trend == null) return '—';
  if (trend === 0) return 'level';
  return `${trend > 0 ? '+' : '−'}${Math.abs(trend).toFixed(1)}`;
}

export function trendColor(trend: number | null): string {
  if (trend == null || trend === 0) return 'var(--muted)';
  return trend > 0 ? 'var(--green)' : 'var(--red)';
}
