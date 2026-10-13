/**
 * AI call scoring + coaching (docs/coaching.md): the house rubric, the JSON
 * schema Claude is asked to fill, the validator that guards what comes back,
 * and the small arithmetic the score card and the manager rollup share.
 * Zero I/O — the server calls the model and stores the row.
 *
 * The rubric is not new. It is the one already written down in
 * `prompts/review_call.system.md` (the house review prompt
 * behind apps/api/workers/review-call.ts): the same seven rep dimensions, the
 * same Price x Motivation bucket grid, the same recommended plays, the same
 * "average reps score 5 to 6" calibration. Three categories are added from
 * the example talk track itself (docs/scripts.md §7) for stages the review
 * prompt leans on but never scores — the opener, the qualifying block, and
 * whether the rep left the call with a real next touch.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// The rubric
// ---------------------------------------------------------------------------

export interface CoachingCategory {
  id: string;
  /** What the score card and the rollup table print. */
  label: string;
  /** Handed to the model as the category's description; also the UI tooltip. */
  description: string;
  /** `rubric` = verbatim from prompts/review_call.system.md; `talk-track` = a playbook script stage. */
  source: 'rubric' | 'talk-track';
}

/**
 * Ten scored dimensions, in the order a call runs. Seven are the
 * `rep_dimensions` of prompts/review_call.system.md, unchanged and unrenamed
 * so a score here means what a score there meant.
 */
export const COACHING_CATEGORIES = [
  {
    id: 'opener',
    label: 'Opener',
    description:
      'Intro and intent in the first thirty seconds: who they are, why they are calling, and confirmation that they are talking to someone who can sell.',
    source: 'talk-track',
  },
  {
    id: 'rapport',
    label: 'Rapport',
    description: 'Tone, listening, empathy, warmth. Did the seller relax, or stay guarded?',
    source: 'rubric',
  },
  {
    id: 'discovery',
    label: 'Discovery',
    description: 'Dug for the pain: motivation, timeline, condition. Asked why, not just what.',
    source: 'rubric',
  },
  {
    id: 'qualifying',
    label: 'Qualifying',
    description:
      'The logistics that decide whether this is a deal at all: who else must sign, occupancy, payoff, liens, agent agreements.',
    source: 'talk-track',
  },
  {
    id: 'anchoring',
    label: 'Anchoring',
    description:
      'Set the price expectation early and controlled the frame, showing the math behind the number rather than naming one and hoping.',
    source: 'rubric',
  },
  {
    id: 'objection_handling',
    label: 'Objection handling',
    description: 'Responses to pushback — education over argument, especially where motivation is real and the price is high.',
    source: 'rubric',
  },
  {
    id: 'close_attempt',
    label: 'Close attempt',
    description: 'Asked for the deal directly, rather than trailing off into "think about it and call me".',
    source: 'rubric',
  },
  {
    id: 'confidence',
    label: 'Confidence',
    description: 'Assertive, no apology, owned the call. Did not flinch at silence or at a number.',
    source: 'rubric',
  },
  {
    id: 'listening',
    label: 'Listening',
    description: 'Let the seller talk, did not interrupt or talk over, followed what was actually said.',
    source: 'rubric',
  },
  {
    id: 'next_step_control',
    label: 'Next step',
    description:
      'Ended with a specific agreed next touch — who does what, by when — instead of leaving the follow-up to chance.',
    source: 'talk-track',
  },
] as const satisfies readonly CoachingCategory[];

export type CoachingCategoryId = (typeof COACHING_CATEGORIES)[number]['id'];

export const COACHING_CATEGORY_IDS = COACHING_CATEGORIES.map((c) => c.id) as CoachingCategoryId[];

export function coachingCategory(id: string): CoachingCategory | undefined {
  return COACHING_CATEGORIES.find((c) => c.id === id);
}

/** The Price x Motivation grid, verbatim from the house prompt. */
export const SELLER_BUCKETS = [
  'motivated_priced_right',
  'motivated_priced_high',
  'unmotivated_priced_right',
  'unmotivated_priced_high',
  'wrong_number',
  'unqualified',
  'unknown',
] as const;
export type SellerBucket = (typeof SELLER_BUCKETS)[number];

export const SELLER_BUCKET_LABELS: Record<SellerBucket, string> = {
  motivated_priced_right: 'Motivated · right price',
  motivated_priced_high: 'Motivated · high price',
  unmotivated_priced_right: 'Unmotivated · right price',
  unmotivated_priced_high: 'Unmotivated · high price',
  wrong_number: 'Wrong number',
  unqualified: 'Unqualified',
  unknown: 'Not enough call to say',
};

/** The play the grid prescribes; same seven values the house prompt returns. */
export const RECOMMENDED_PLAYS = [
  'lock_it_up',
  'navigate',
  'dig_deeper',
  'walk_away',
  'verify_owner',
  'drop',
  'callback',
] as const;
export type RecommendedPlay = (typeof RECOMMENDED_PLAYS)[number];

export const RECOMMENDED_PLAY_LABELS: Record<RecommendedPlay, string> = {
  lock_it_up: 'Lock it up',
  navigate: 'Navigate the price gap',
  dig_deeper: 'Dig deeper',
  walk_away: 'Walk away',
  verify_owner: 'Verify the owner',
  drop: 'Drop',
  callback: 'Call back',
};

// ---------------------------------------------------------------------------
// The score
// ---------------------------------------------------------------------------

export interface CategoryScore {
  /**
   * 0-10 on the house scale (average 5-6, top 7-8, mistakes 3-4). Null when
   * the stage never came up — the rubric is explicit that a discovery-only
   * call must not be marked down for a missing close.
   */
  score: number | null;
  /** One line, in the coach's voice, saying why. */
  reason: string;
}

export interface MissedOpportunity {
  /** What the seller opened that the rep walked past. */
  moment: string;
  /** The seller's words, so the rep can find it in the recording. Null when it was a silence. */
  quote: string | null;
  /** What to say there next time. */
  instead: string;
}

/** What the call told us about the seller — the read-out, not the rep's grade. */
export interface SellerRead {
  bucket: SellerBucket;
  /** 0-10, independent of price. Null when the call was too short to tell. */
  motivation_score: number | null;
  /** 0-10: 10 = their number matches what we would pay, 0 = full retail. Null when price never came up. */
  price_alignment_score: number | null;
  /** 0-1 confidence in the bucket. */
  bucket_confidence: number;
  bucket_rationale: string;
  recommended_play: RecommendedPlay;
  /** Why they are considering selling, in their words. */
  motivation: string | null;
  timeline: string | null;
  condition: string | null;
  price_expectation: string | null;
  /** What they were feeling, one or two words each ("tired", "defensive", "relieved"). */
  emotions: string[];
}

/** Exactly what the model returns. `overall` is the house 0-10 gut score. */
export interface CallScoreDraft {
  overall: number;
  categories: Record<CoachingCategoryId, CategoryScore>;
  strengths: string[];
  gaps: string[];
  missed_opportunities: MissedOpportunity[];
  next_action: string;
  seller: SellerRead;
}

const categoryScoreSchema = z.object({
  score: z.number().min(0).max(10).nullable(),
  reason: z.string(),
});

/**
 * A free-text field the model may have nothing to say for.
 *
 * It is a plain `string` on the wire rather than a nullable one, because
 * structured outputs cap a schema at 16 union-typed parameters and this
 * schema had 17 (see CALL_SCORE_JSON_SCHEMA). The model is told to answer
 * with an empty string instead, and the empty string becomes `null` right
 * here, so everything downstream — the stored jsonb, the API, the card —
 * keeps seeing exactly what it saw before. `null` is still accepted, so a
 * reply from the older schema still validates.
 */
const optionalText = z
  .union([z.string(), z.null()])
  .transform((v) => (v === null || v.trim() === '' ? null : v));

/** Mirrors CALL_SCORE_JSON_SCHEMA; the schema is generated from the same list. */
export const callScoreSchema = z.object({
  overall: z.number().min(0).max(10),
  categories: z.object({
    opener: categoryScoreSchema,
    rapport: categoryScoreSchema,
    discovery: categoryScoreSchema,
    qualifying: categoryScoreSchema,
    anchoring: categoryScoreSchema,
    objection_handling: categoryScoreSchema,
    close_attempt: categoryScoreSchema,
    confidence: categoryScoreSchema,
    listening: categoryScoreSchema,
    next_step_control: categoryScoreSchema,
  }),
  strengths: z.array(z.string()),
  gaps: z.array(z.string()),
  missed_opportunities: z.array(
    z.object({ moment: z.string(), quote: optionalText, instead: z.string() }),
  ),
  next_action: z.string(),
  seller: z.object({
    bucket: z.enum(SELLER_BUCKETS),
    motivation_score: z.number().min(0).max(10).nullable(),
    price_alignment_score: z.number().min(0).max(10).nullable(),
    bucket_confidence: z.number().min(0).max(1),
    bucket_rationale: z.string(),
    recommended_play: z.enum(RECOMMENDED_PLAYS),
    motivation: optionalText,
    timeline: optionalText,
    condition: optionalText,
    price_expectation: optionalText,
    emotions: z.array(z.string()),
  }),
});

export type CallScoreValidation =
  | { ok: true; score: CallScoreDraft }
  | { ok: false; errors: string[] };

/**
 * Guard the model's reply before any of it reaches the database. Structured
 * outputs make a shape violation unlikely, not impossible, and a half-filled
 * score card is worse than no score card.
 */
export function validateCallScore(value: unknown): CallScoreValidation {
  const parsed = callScoreSchema.safeParse(value);
  if (!parsed.success) {
    const errors = parsed.error.issues.map((i) => {
      const path = i.path.join('.');
      return path ? `${path}: ${i.message}` : i.message;
    });
    return { ok: false, errors };
  }
  return { ok: true, score: parsed.data as CallScoreDraft };
}

// ---------------------------------------------------------------------------
// The JSON schema handed to structured outputs
// ---------------------------------------------------------------------------

/**
 * Free text the model may have nothing for. Deliberately **not** nullable:
 * structured outputs reject a schema with more than 16 union-typed
 * parameters, and the ten category scores plus the two seller scores already
 * spend twelve of them. An empty string says "not discussed" and
 * `optionalText` turns it back into `null` before anything is stored.
 */
const emptyableString = { type: 'string' } as const;
/**
 * **No `minimum` / `maximum` anywhere in this schema.** Structured outputs
 * reject them outright — `output_config.format.schema: For 'number' type,
 * properties maximum, minimum are not supported` — and the whole request 400s,
 * so every score on the deployment fails at once. The range belongs in the
 * field's `description`, which the model reads anyway, and the real guard is
 * `callScoreSchema` above: zod re-checks every bound before a score is stored.
 */
const nullableTen = {
  anyOf: [{ type: 'number' }, { type: 'null' }],
} as const;

function categoriesJsonSchema(): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const c of COACHING_CATEGORIES) {
    properties[c.id] = {
      type: 'object',
      properties: {
        score: { ...nullableTen, description: `${c.description} A number from 0 to 10, or null if the call never reached this.` },
        reason: { type: 'string', description: 'One line saying why this score, quoting the call where it helps.' },
      },
      required: ['score', 'reason'],
      additionalProperties: false,
    };
  }
  return {
    type: 'object',
    description: 'Every category, scored 0-10 on the house scale, each with a one-line reason.',
    properties,
    required: COACHING_CATEGORY_IDS,
    additionalProperties: false,
  };
}

/**
 * Handed to `output_config.format` (`{ type: 'json_schema', schema }`) — the
 * same mechanism the call-notes summary uses. Generated from
 * COACHING_CATEGORIES so the list and the schema cannot drift apart.
 */
export const CALL_SCORE_JSON_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    overall: {
      type: 'number',
      description:
        "Your coach's gut on the house 0-10 scale: would you want this rep on your team based on this call? Average reps 5-6, top reps 7-8, mistakes and missed opportunities 3-4. Not a strict average of the categories.",
    },
    categories: categoriesJsonSchema(),
    strengths: {
      type: 'array',
      items: { type: 'string' },
      description: '1-3 specific things the rep did well, each with a verbatim quote so they can find the moment.',
    },
    gaps: {
      type: 'array',
      items: { type: 'string' },
      description: '1-3 things to fix next call, each saying what the rep should have said instead.',
    },
    missed_opportunities: {
      type: 'array',
      description: 'Doors the seller opened that the rep walked past — buying signals, evasions worth chasing, pain left undug.',
      items: {
        type: 'object',
        properties: {
          moment: { type: 'string', description: 'What the seller opened.' },
          quote: { ...emptyableString, description: "The seller's words. Empty string when the opening was a silence." },
          instead: { type: 'string', description: 'What to say there next time.' },
        },
        required: ['moment', 'quote', 'instead'],
        additionalProperties: false,
      },
    },
    next_action: {
      type: 'string',
      description:
        'One concrete next step for this deal, e.g. "Send Friday follow-up at $185k with photos of the comp on Main".',
    },
    seller: {
      type: 'object',
      description: 'The seller read-out: the Price x Motivation bucket and the situation behind it.',
      properties: {
        bucket: { type: 'string', enum: [...SELLER_BUCKETS], description: 'Bucket the SELLER, not the call outcome.' },
        motivation_score: { ...nullableTen, description: 'Real pain and a clear timeline, independent of price, from 0 to 10. Null if the call was too short.' },
        price_alignment_score: { ...nullableTen, description: '10 = their number matches what we would pay; 0 = full retail. Null if price never came up.' },
        bucket_confidence: { type: 'number', description: 'How sure you are of the bucket, from 0 to 1. Lower it when signals and statements disagree.' },
        bucket_rationale: { type: 'string', description: '1-2 sentences with quotes explaining the bucket.' },
        recommended_play: { type: 'string', enum: [...RECOMMENDED_PLAYS], description: 'The play the grid prescribes for this bucket.' },
        motivation: { ...emptyableString, description: "Why they are considering selling, in their words. Empty string if not discussed." },
        timeline: { ...emptyableString, description: 'When they want or need to be out. Empty string if not discussed.' },
        condition: { ...emptyableString, description: 'Repairs, occupancy, tenants, notable issues. Empty string if not discussed.' },
        price_expectation: { ...emptyableString, description: 'Any number they named or reacted to, with context. Empty string if none.' },
        emotions: { type: 'array', items: { type: 'string' }, description: 'One or two words each: tired, defensive, relieved, suspicious.' },
      },
      required: [
        'bucket', 'motivation_score', 'price_alignment_score', 'bucket_confidence', 'bucket_rationale',
        'recommended_play', 'motivation', 'timeline', 'condition', 'price_expectation', 'emotions',
      ],
      additionalProperties: false,
    },
  },
  required: ['overall', 'categories', 'strengths', 'gaps', 'missed_opportunities', 'next_action', 'seller'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Arithmetic (never asked of the model)
// ---------------------------------------------------------------------------

/**
 * The stored `overall` is 0-100 so it reads as a score; the model answers on
 * the house 0-10 scale so the calibration in the rubric still means what it
 * says. One multiplication, in one place.
 */
export function overallToHundred(overall: number): number {
  return Math.max(0, Math.min(100, Math.round(overall * 10)));
}

export type ScoreBand = 'strong' | 'solid' | 'developing' | 'weak';

/**
 * Bands follow the rubric's own calibration: top reps 7-8, average 5-6,
 * mistakes 3-4. Input is the stored 0-100 number.
 */
export function scoreBand(overall: number): ScoreBand {
  if (overall >= 70) return 'strong';
  if (overall >= 50) return 'solid';
  if (overall >= 30) return 'developing';
  return 'weak';
}

/** Rep share of speaking time we coach toward on a discovery call. */
export const TALK_RATIO_TARGET = { min: 0.4, max: 0.45 } as const;
/** How far outside the target still reads as "close", not "wrong". */
export const TALK_RATIO_TOLERANCE = 0.05;

export type TalkRatioVerdict = 'seller_heavy' | 'near_target' | 'on_target' | 'rep_heavy';

/**
 * Where a rep talk ratio (0-1) sits against the target. `seller_heavy` is not
 * automatically bad — on a call where the seller is pouring it out, it is the
 * point — so the card names the band and leaves the judgement to the reason.
 */
export function talkRatioVerdict(ratio: number | null | undefined): TalkRatioVerdict | null {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  if (ratio < TALK_RATIO_TARGET.min - TALK_RATIO_TOLERANCE) return 'seller_heavy';
  if (ratio > TALK_RATIO_TARGET.max + TALK_RATIO_TOLERANCE) return 'rep_heavy';
  if (ratio < TALK_RATIO_TARGET.min || ratio > TALK_RATIO_TARGET.max) return 'near_target';
  return 'on_target';
}

/**
 * The two-sided bar's halves as whole percents that always sum to 100 — the
 * seller half is the remainder, so rounding can never leave a 1% gap.
 */
export function talkRatioSplit(ratio: number | null | undefined): { rep: number; seller: number } | null {
  if (ratio == null || !Number.isFinite(ratio)) return null;
  const rep = Math.max(0, Math.min(100, Math.round(ratio * 100)));
  return { rep, seller: 100 - rep };
}

/** Mean of the numbers that exist, rounded to `places`; null when none do. */
export function averageOf(values: Array<number | null | undefined>, places = 1): number | null {
  const present = values.filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
  if (present.length === 0) return null;
  const factor = 10 ** places;
  return Math.round((present.reduce((a, b) => a + b, 0) / present.length) * factor) / factor;
}

export interface CategoryAverage {
  category: CoachingCategoryId;
  label: string;
  /** 0-10, or null when nobody was scored on it in the range. */
  average: number | null;
  /** How many scored calls contributed — a 2.0 off one call is not a trend. */
  scored: number;
}

/**
 * The weakest categories, lowest first. Categories nobody was scored on are
 * left out rather than ranked at zero, and ties break on the category order
 * so the same call always produces the same list.
 */
export function weakestCategories(averages: CategoryAverage[], limit = 3): CategoryAverage[] {
  const order = new Map(COACHING_CATEGORY_IDS.map((id, i) => [id, i]));
  return averages
    .filter((a) => a.average != null)
    .sort((a, b) => a.average! - b.average! || (order.get(a.category) ?? 0) - (order.get(b.category) ?? 0))
    .slice(0, limit);
}
