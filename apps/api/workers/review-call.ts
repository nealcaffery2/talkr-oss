// Review a call after pattern extraction. Produces:
// - Rep score per dimension + overall
// - Seller bucket on 4-bucket grid + motivation_score + price_alignment_score
// - Linguistic observations (sarcasm, analogies, mannerisms, evasions, signals, red flags)
// - Strengths, gaps, recommended next action

import { admin } from "../lib/supabase.js";
import { generateJson, MODELS, modelFor } from "../lib/anthropic.js";
import { loadPromptCached, fill } from "../lib/prompts.js";
import type { Database } from "../lib/database.types.js";

type CallReviewInsert = Database["public"]["Tables"]["call_reviews"]["Insert"];
type SellerBucket = Database["public"]["Enums"]["seller_bucket"];
type OutcomeStatus = Database["public"]["Enums"]["outcome_status"];

interface CallReview {
  rep_overall_score: number;
  rep_dimensions: {
    rapport: number | null;
    discovery: number | null;
    anchoring: number | null;
    objection_handling: number | null;
    close_attempt: number | null;
    confidence: number | null;
    listening: number | null;
  };
  seller_bucket: SellerBucket;
  motivation_score: number | null;
  price_alignment_score: number | null;
  bucket_confidence: number;
  bucket_rationale: string;
  recommended_play: string;
  linguistic_observations: {
    sarcasm: any[];
    analogies: any[];
    mannerisms: any[];
    evasions: any[];
    buying_signals_subtle: any[];
    red_flags: any[];
  };
  strengths: string[];
  gaps: string[];
  recommended_next_action: string;
}

export async function reviewCall(opts: {
  callId: string;
  agentName: string;
  transcript: string;
  outcome: OutcomeStatus;
  durationSeconds: number;
  dealValueCents?: number | null;
  patternsJson?: unknown;       // optional: the extracted patterns from the prior pass
}): Promise<CallReview> {
  const systemPrompt = await loadPromptCached("review_call.system.md");
  const userTemplate = await loadPromptCached("review_call.user.template.md");

  const userPrompt = fill(userTemplate, {
    CALL_ID: opts.callId,
    DURATION_SECONDS: opts.durationSeconds,
    OUTCOME: opts.outcome,
    DEAL_VALUE_CENTS: opts.dealValueCents ?? "null",
    AGENT_NAME: opts.agentName,
    PATTERNS_JSON: opts.patternsJson ? JSON.stringify(opts.patternsJson, null, 2) : "[]",
    TRANSCRIPT: opts.transcript,
  });

  const model = modelFor("review");
  const { data: review, usage } = await generateJson<CallReview>({
    model,
    systemPrompt,
    userPrompt,
    maxTokens: 8000,
  });

  const row: CallReviewInsert = {
    call_id: opts.callId,
    rep_overall_score: review.rep_overall_score,
    rep_dimensions: review.rep_dimensions as any,
    seller_bucket: review.seller_bucket,
    motivation_score: review.motivation_score,
    price_alignment_score: review.price_alignment_score,
    bucket_confidence: review.bucket_confidence,
    bucket_rationale: review.bucket_rationale,
    recommended_play: review.recommended_play,
    linguistic_observations: review.linguistic_observations as any,
    strengths: review.strengths,
    gaps: review.gaps,
    recommended_next_action: review.recommended_next_action,
    reviewed_by: model,
  };

  const { error } = await admin()
    .from("call_reviews")
    .upsert(row, { onConflict: "call_id" });
  if (error) throw new Error(`Supabase upsert: ${error.message}`);

  console.log(
    `[review-call] call=${opts.callId} model=${model} bucket=${review.seller_bucket} score=${review.rep_overall_score}`,
    `tokens in/out=${usage.input_tokens}/${usage.output_tokens}`,
    `cache read/write=${usage.cache_read_input_tokens ?? 0}/${usage.cache_creation_input_tokens ?? 0}`
  );

  return review;
}
