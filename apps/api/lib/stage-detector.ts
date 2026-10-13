// Heuristic call-stage detector. Reads the rolling transcript (last N turns
// + elapsed seconds) and returns the most likely call_stage. Used by the live
// suggest endpoint to filter retrieval to stage-relevant patterns.
//
// Design notes:
// - Heuristic, not LLM. We want stage detection in <5ms; an LLM call would
//   blow the latency budget. Trades 5-10% accuracy for 100x latency win.
// - Defaults to "qualifier" early in the call, slides forward as keywords appear.
// - Stage is monotonic-ish: we don't go backwards from "close" to "opener".

import type { Database } from "./database.types.js";

type CallStage = Database["public"]["Enums"]["call_stage"];

interface Turn {
  speaker: "agent" | "seller";
  text: string;
}

interface DetectionInput {
  turns: Turn[];                    // most recent ~8 turns
  elapsedSeconds: number;
  previousStage?: CallStage;        // monotonic guard
}

const STAGE_ORDER: CallStage[] = [
  "opener", "qualifier", "motivation", "condition", "price", "close", "post_close",
];

// Lower-cased keyword/phrase fragments that signal each stage.
// Order: longer / more specific phrases first within each stage.
const STAGE_SIGNALS: Record<CallStage, string[]> = {
  opener: [
    "this is .* calling about", "is this .*?\\?", "i'm calling about your property",
    "did i catch you at a bad", "do you have a minute",
  ],
  qualifier: [
    "are you the owner", "how long have you owned", "is the property still available",
    "still selling", "what kind of property", "single family", "duplex", "rental",
  ],
  motivation: [
    "why are you selling", "behind on payments", "going through a divorce",
    "moving out of", "inherited", "probate", "tired landlord", "homesick",
    "lost my job", "behind on the mortgage", "foreclosure", "trying to relocate",
  ],
  condition: [
    "what kind of shape", "what condition", "any repairs", "needs new roof",
    "kitchen needs", "bathroom needs", "foundation", "leaks", "mold",
    "when was the roof", "any updates", "remodeled", "tenants in",
  ],
  price: [
    "how much are you looking", "what were you hoping", "what's your number",
    "i can offer", "my offer is", "my number", "i'm at", "i can pay",
    "would you take", "best price", "lowest you'll go", "asking price",
    "comps in your area", "after repair value",
  ],
  close: [
    "send you the contract", "i'll send the agreement", "earnest money",
    "title company", "closing date", "when can we close", "i'll get the paperwork",
    "let's lock this in", "we have a deal", "are we good", "shake on it",
    "i'll have my dispo", "tomorrow at",
  ],
  post_close: [
    "after we close", "after the contract", "what happens next", "moving out by",
    "leaseback", "stay in the house until", "send wiring instructions",
    "earnest money was wired", "title called",
  ],
};

const COMPILED: Record<CallStage, RegExp[]> = Object.fromEntries(
  STAGE_ORDER.map((s) => [s, STAGE_SIGNALS[s].map((p) => new RegExp(p, "i"))])
) as Record<CallStage, RegExp[]>;

export function detectStage(input: DetectionInput): CallStage {
  const { turns, elapsedSeconds, previousStage } = input;
  const text = turns.map((t) => t.text).join(" ").toLowerCase();

  // Score each stage by hit count
  const scores: Record<CallStage, number> = Object.fromEntries(
    STAGE_ORDER.map((s) => [s, 0])
  ) as Record<CallStage, number>;

  for (const stage of STAGE_ORDER) {
    for (const re of COMPILED[stage]) {
      if (re.test(text)) scores[stage]++;
    }
  }

  // Time-decay prior: early in the call we're more likely in opener/qualifier;
  // late in the call we're more likely in close/post_close.
  if (elapsedSeconds < 60) {
    scores.opener += 2;
    scores.qualifier += 1;
  } else if (elapsedSeconds < 180) {
    scores.qualifier += 1;
    scores.motivation += 1;
  } else if (elapsedSeconds > 600) {
    scores.close += 1;
  }

  // Pick the highest-scoring stage. Ties break to the LATER stage (we lean forward).
  let best: CallStage = previousStage ?? "qualifier";
  let bestScore = -1;
  for (const stage of STAGE_ORDER) {
    if (scores[stage] >= bestScore) {
      best = stage;
      bestScore = scores[stage];
    }
  }

  // Monotonic guard: don't regress more than one stage backward.
  // Keeps the live coach from oscillating between stages mid-call.
  if (previousStage) {
    const prevIdx = STAGE_ORDER.indexOf(previousStage);
    const newIdx = STAGE_ORDER.indexOf(best);
    if (newIdx < prevIdx - 1) {
      return previousStage;
    }
  }

  return best;
}
