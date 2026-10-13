/**
 * The pure half of AI call scoring (docs/coaching.md): the talk-ratio
 * arithmetic the card draws, the score-response validator that guards what
 * the model returns, and the rollup helpers the manager view averages with.
 * No network, no database — the model call itself lives in
 * apps/server/src/services/call-scoring.ts.
 */

import { describe, expect, it } from 'vitest';
import {
  CALL_SCORE_JSON_SCHEMA,
  COACHING_CATEGORIES,
  COACHING_CATEGORY_IDS,
  TALK_RATIO_TARGET,
  averageOf,
  overallToHundred,
  scoreBand,
  talkRatioSplit,
  talkRatioVerdict,
  validateCallScore,
  weakestCategories,
  type CallScoreDraft,
  type CategoryAverage,
} from '../src/coaching.js';

// ---------------------------------------------------------------------------
// Talk ratio
// ---------------------------------------------------------------------------

describe('talk ratio', () => {
  it('splits into two halves that always sum to 100', () => {
    expect(talkRatioSplit(0.42)).toEqual({ rep: 42, seller: 58 });
    // 0.425 rounds up to 43; the seller half is the remainder, never 58 again.
    expect(talkRatioSplit(0.425)).toEqual({ rep: 43, seller: 57 });
    expect(talkRatioSplit(0.005)).toEqual({ rep: 1, seller: 99 });
    for (const r of [0, 0.001, 0.334, 0.5, 0.666, 0.999, 1]) {
      const split = talkRatioSplit(r)!;
      expect(split.rep + split.seller).toBe(100);
    }
  });

  it('clamps a ratio outside 0-1 and reports nothing for a missing one', () => {
    expect(talkRatioSplit(1.4)).toEqual({ rep: 100, seller: 0 });
    expect(talkRatioSplit(-0.2)).toEqual({ rep: 0, seller: 100 });
    expect(talkRatioSplit(null)).toBeNull();
    expect(talkRatioSplit(undefined)).toBeNull();
    expect(talkRatioSplit(Number.NaN)).toBeNull();
  });

  it('reads 40-45% rep as on target, and the tolerance band as near it', () => {
    expect(talkRatioVerdict(TALK_RATIO_TARGET.min)).toBe('on_target');
    expect(talkRatioVerdict(0.43)).toBe('on_target');
    expect(talkRatioVerdict(TALK_RATIO_TARGET.max)).toBe('on_target');
    // Just outside the target but inside the 5-point tolerance.
    expect(talkRatioVerdict(0.37)).toBe('near_target');
    expect(talkRatioVerdict(0.49)).toBe('near_target');
    // Outside both.
    expect(talkRatioVerdict(0.7)).toBe('rep_heavy');
    expect(talkRatioVerdict(0.2)).toBe('seller_heavy');
    expect(talkRatioVerdict(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

describe('score scales', () => {
  it('stores the house 0-10 gut score as 0-100', () => {
    expect(overallToHundred(0)).toBe(0);
    expect(overallToHundred(5.5)).toBe(55);
    expect(overallToHundred(7.25)).toBe(73);
    expect(overallToHundred(10)).toBe(100);
    // Never out of range, whatever the model says.
    expect(overallToHundred(12)).toBe(100);
    expect(overallToHundred(-3)).toBe(0);
  });

  it('bands follow the rubric calibration: top 7-8, average 5-6, mistakes 3-4', () => {
    expect(scoreBand(85)).toBe('strong');
    expect(scoreBand(70)).toBe('strong');
    expect(scoreBand(69)).toBe('solid');
    expect(scoreBand(50)).toBe('solid');
    expect(scoreBand(49)).toBe('developing');
    expect(scoreBand(30)).toBe('developing');
    expect(scoreBand(29)).toBe('weak');
  });

  it('averages only the values that exist', () => {
    expect(averageOf([4, 6, 8])).toBe(6);
    expect(averageOf([4, null, undefined, 7])).toBe(5.5);
    expect(averageOf([])).toBeNull();
    expect(averageOf([null, undefined])).toBeNull();
    expect(averageOf([0.4, 0.45], 3)).toBe(0.425);
  });
});

// ---------------------------------------------------------------------------
// Weakest categories
// ---------------------------------------------------------------------------

function avg(category: string, average: number | null, scored = 3): CategoryAverage {
  return { category: category as CategoryAverage['category'], label: category, average, scored };
}

describe('weakest categories', () => {
  it('takes the three lowest, lowest first, ignoring categories nobody was scored on', () => {
    const weakest = weakestCategories([
      avg('opener', 8),
      avg('rapport', 4),
      avg('discovery', null, 0),
      avg('qualifying', 6),
      avg('anchoring', 2),
      avg('objection_handling', 5),
    ]);
    expect(weakest.map((w) => w.category)).toEqual(['anchoring', 'rapport', 'objection_handling']);
  });

  it('breaks ties on the rubric order, so the same data gives the same list', () => {
    const weakest = weakestCategories([avg('listening', 5), avg('rapport', 5), avg('opener', 5)], 2);
    expect(weakest.map((w) => w.category)).toEqual(['opener', 'rapport']);
  });

  it('returns nothing when nothing was scored', () => {
    expect(weakestCategories([avg('opener', null, 0), avg('rapport', null, 0)])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The score-response validator
// ---------------------------------------------------------------------------

function goodScore(): CallScoreDraft {
  const categories = Object.fromEntries(
    COACHING_CATEGORY_IDS.map((id) => [id, { score: 6, reason: `${id} was fine` }]),
  ) as CallScoreDraft['categories'];
  return {
    overall: 6.5,
    categories,
    strengths: ['Opened cleanly: "I buy houses in Tarrant County, is this still yours?"'],
    gaps: ['Never anchored — should have said "Based on the comps I can be around 185."'],
    missed_opportunities: [
      { moment: 'Seller asked how fast we close', quote: 'How quick could you do this?', instead: 'Ask what date they need to be out, then close on it.' },
    ],
    next_action: 'Send Friday follow-up at $185k with photos of the comp on Main.',
    seller: {
      bucket: 'motivated_priced_high',
      motivation_score: 8,
      price_alignment_score: 3,
      bucket_confidence: 0.8,
      bucket_rationale: 'Probate closing in 60 days, but wants Zillow retail.',
      recommended_play: 'navigate',
      motivation: 'Probate, wants it off her hands',
      timeline: '60 days',
      condition: 'Roof is 20 years old',
      price_expectation: 'around 240',
      emotions: ['tired', 'defensive'],
    },
  };
}

describe('validateCallScore', () => {
  it('accepts a well-formed score', () => {
    const result = validateCallScore(goodScore());
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.score.seller.bucket).toBe('motivated_priced_high');
  });

  it('accepts a null category score — a discovery-only call is not marked down for a missing close', () => {
    const draft = goodScore();
    draft.categories.close_attempt = { score: null, reason: 'The call never reached a close.' };
    const result = validateCallScore(draft);
    expect(result.ok).toBe(true);
  });

  it('rejects a missing category rather than storing a half-filled card', () => {
    const draft = goodScore() as unknown as { categories: Record<string, unknown> };
    delete draft.categories.anchoring;
    const result = validateCallScore(draft);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.startsWith('categories.anchoring'))).toBe(true);
  });

  it('rejects a category score outside 0-10 and an overall outside 0-10', () => {
    const high = goodScore();
    high.categories.rapport = { score: 42, reason: 'nonsense' };
    expect(validateCallScore(high).ok).toBe(false);

    const overall = goodScore();
    overall.overall = 87; // the 0-100 scale leaking into the model's answer
    const result = validateCallScore(overall);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.errors.some((e) => e.startsWith('overall'))).toBe(true);
  });

  it('rejects a bucket or play outside the house vocabulary', () => {
    const bucket = goodScore();
    (bucket.seller as { bucket: string }).bucket = 'very_motivated';
    expect(validateCallScore(bucket).ok).toBe(false);

    const play = goodScore();
    (play.seller as { recommended_play: string }).recommended_play = 'close_hard';
    expect(validateCallScore(play).ok).toBe(false);
  });

  it('rejects a confidence outside 0-1 and a non-object reply', () => {
    const draft = goodScore();
    draft.seller.bucket_confidence = 80;
    expect(validateCallScore(draft).ok).toBe(false);
    expect(validateCallScore(null).ok).toBe(false);
    expect(validateCallScore('{}').ok).toBe(false);
  });
});

describe('validateCallScore free-text normalisation', () => {
  it('turns the empty strings the schema now asks for back into null', () => {
    const draft = goodScore();
    draft.seller.motivation = '';
    draft.seller.timeline = '   ';
    draft.missed_opportunities = [{ moment: 'Asked about fees', quote: '', instead: 'Answer, then ask for the date.' }];
    const result = validateCallScore(draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.score.seller.motivation).toBeNull();
    expect(result.score.seller.timeline).toBeNull();
    expect(result.score.missed_opportunities[0]!.quote).toBeNull();
    // Real text is untouched.
    expect(result.score.seller.condition).toBe('Roof is 20 years old');
  });

  it('still accepts a null from the older schema', () => {
    const draft = goodScore();
    draft.seller.motivation = null;
    const result = validateCallScore(draft);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.score.seller.motivation).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The schema handed to the model
// ---------------------------------------------------------------------------

describe('CALL_SCORE_JSON_SCHEMA', () => {
  it('requires exactly the categories the validator requires', () => {
    const categories = (CALL_SCORE_JSON_SCHEMA.properties as Record<string, { required: string[] }>).categories!;
    expect(categories.required).toEqual(COACHING_CATEGORY_IDS);
    expect(COACHING_CATEGORY_IDS).toHaveLength(10);
  });

  it('carries every category description, so the model is told what each one means', () => {
    const categories = (CALL_SCORE_JSON_SCHEMA.properties as Record<string, { properties: Record<string, { properties: { score: { description: string } } }> }>)
      .categories!;
    for (const c of COACHING_CATEGORIES) {
      expect(categories.properties[c.id]!.properties.score.description).toContain(c.description);
    }
  });

  /**
   * Structured outputs reject `minimum` / `maximum` on a number outright:
   * `output_config.format.schema: For 'number' type, properties maximum,
   * minimum are not supported`. That is a 400 on the whole request, so a
   * single stray bound anywhere in this tree silently stops *every* call from
   * being scored — which is exactly what happened in production. The bounds
   * live in the descriptions, and zod re-checks them before anything is
   * stored (`validateCallScore`).
   */
  it('carries no numeric bounds anywhere: structured outputs 400 on them', () => {
    const offenders: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((child, i) => walk(child, `${path}[${i}]`));
        return;
      }
      if (!node || typeof node !== 'object') return;
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key === 'minimum' || key === 'maximum' || key === 'exclusiveMinimum' || key === 'exclusiveMaximum') {
          offenders.push(`${path}.${key}`);
        }
        walk(value, `${path}.${key}`);
      }
    };
    walk(CALL_SCORE_JSON_SCHEMA, 'schema');
    expect(offenders).toEqual([]);
  });

  /**
   * The second limit this schema hit in production, right behind the numeric
   * bounds: "Schemas contains too many parameters with union types (17
   * parameters with type arrays or anyOf) … limit: 16". Also a 400 on the
   * whole request, so again every score fails at once. Twelve are spent on
   * the scores that genuinely mean "not applicable" (ten categories and two
   * seller scores); the free-text fields say "not discussed" with an empty
   * string instead, which `optionalText` turns back into null.
   */
  it('stays under the structured-output union limit, with headroom', () => {
    const unions: string[] = [];
    const walk = (node: unknown, path: string): void => {
      if (Array.isArray(node)) {
        node.forEach((child, i) => walk(child, `${path}[${i}]`));
        return;
      }
      if (!node || typeof node !== 'object') return;
      const obj = node as Record<string, unknown>;
      if (Array.isArray(obj.anyOf) || Array.isArray(obj.oneOf) || Array.isArray(obj.type)) {
        unions.push(path);
      }
      for (const [key, value] of Object.entries(obj)) {
        if (key === 'description') continue;
        walk(value, `${path}.${key}`);
      }
    };
    walk(CALL_SCORE_JSON_SCHEMA, 'schema');
    expect(unions.length).toBeLessThanOrEqual(16);
    // The ten category scores plus the two seller scores, and nothing else.
    expect(unions).toHaveLength(12);
  });

  it('asks for an empty string, not null, on the free-text seller fields', () => {
    const seller = (CALL_SCORE_JSON_SCHEMA.properties as Record<string, { properties: Record<string, { type?: string; description: string }> }>).seller!;
    for (const field of ['motivation', 'timeline', 'condition', 'price_expectation']) {
      expect(seller.properties[field]!.type).toBe('string');
      expect(seller.properties[field]!.description).toMatch(/[Ee]mpty string/);
    }
  });

  it('still tells the model the ranges it can no longer express as bounds', () => {
    const props = CALL_SCORE_JSON_SCHEMA.properties as Record<string, { description?: string }>;
    expect(props.overall!.description).toContain('0-10');
    const seller = (CALL_SCORE_JSON_SCHEMA.properties as Record<string, { properties: Record<string, { description: string }> }>).seller!;
    expect(seller.properties.bucket_confidence!.description).toContain('0 to 1');
    expect(seller.properties.motivation_score!.description).toContain('0 to 10');
  });
});
