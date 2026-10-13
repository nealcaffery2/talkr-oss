// Extract coachable patterns from a single call's transcript.
// Inserts rows into `patterns` with Voyage-3 embeddings and the call's
// outcome_label inherited from the call's outcome.

import { admin, pgVector } from "../lib/supabase.js";
import { generateJson, MODELS, modelFor } from "../lib/anthropic.js";
import { embedBatch } from "../lib/voyage.js";
import { loadPromptCached, fill } from "../lib/prompts.js";
import type { Database } from "../lib/database.types.js";

type PatternInsert = Database["public"]["Tables"]["patterns"]["Insert"];
type PatternType = Database["public"]["Enums"]["pattern_type"];
type CallStage = Database["public"]["Enums"]["call_stage"];
type OutcomeLabel = Database["public"]["Enums"]["outcome_label"];
type OutcomeStatus = Database["public"]["Enums"]["outcome_status"];

interface ExtractedPattern {
  pattern_type: PatternType;
  stage: CallStage;
  seller_utterance: string;
  seller_utterance_paraphrase: string;
  agent_response: string | null;
  agent_response_quality: "won" | "lost" | "neutral";
  confidence: number;
  tags: string[];
}

const OUTCOME_TO_LABEL: Record<OutcomeStatus, OutcomeLabel> = {
  contract: "winning",
  callback: "winning",
  in_progress: "neutral",
  voicemail: "neutral",
  dead: "losing",
  unqualified: "losing",
  dnc: "losing",
  wrong_number: "neutral",
};

export async function extractPatterns(opts: {
  callId: string;
  transcript: string;            // formatted "[mm:ss] speaker: text" lines
  outcome: OutcomeStatus;
  durationSeconds: number;
  dealValueCents?: number | null;
}): Promise<{ inserted: number; patterns: ExtractedPattern[] }> {
  const systemPrompt = await loadPromptCached("extract_patterns.system.md");
  const userTemplate = await loadPromptCached("extract_patterns.user.template.md");

  const userPrompt = fill(userTemplate, {
    CALL_ID: opts.callId,
    DURATION_SECONDS: opts.durationSeconds,
    OUTCOME: opts.outcome,
    DEAL_VALUE_CENTS: opts.dealValueCents ?? "null",
    TRANSCRIPT: opts.transcript,
  });

  const model = modelFor("extract");
  const { data: patterns, usage } = await generateJson<ExtractedPattern[]>({
    model,
    systemPrompt,
    userPrompt,
    maxTokens: 32000,   // training-corpus compilation videos can produce 50-100+ patterns
  });

  if (!Array.isArray(patterns)) {
    throw new Error(`extract_patterns returned non-array: ${JSON.stringify(patterns).slice(0, 200)}`);
  }
  if (patterns.length === 0) return { inserted: 0, patterns: [] };

  // Validate enum values + drop empty-text patterns. The model occasionally
  // confuses pattern_type with stage ("qualifier" is a stage, not a type),
  // and occasionally produces a pattern with no embeddable utterance.
  const VALID_PATTERN_TYPES = new Set<PatternType>([
    "objection","hesitation","buying_signal","agent_response","close_attempt","rapport",
  ]);
  const VALID_STAGES = new Set<CallStage>([
    "opener","qualifier","motivation","condition","price","close","post_close",
  ]);
  const usable = patterns.filter((p) => {
    const text = (p.seller_utterance_paraphrase || p.seller_utterance || "").trim();
    if (text.length === 0) return false;
    if (!VALID_PATTERN_TYPES.has(p.pattern_type)) return false;
    if (!VALID_STAGES.has(p.stage)) return false;
    return true;
  });
  if (usable.length === 0) {
    console.warn(`[extract-patterns] call=${opts.callId}: all ${patterns.length} patterns invalid; skipping insert`);
    return { inserted: 0, patterns: [] };
  }
  if (usable.length < patterns.length) {
    console.warn(`[extract-patterns] dropped ${patterns.length - usable.length} invalid pattern(s) (bad enum or empty text)`);
  }

  // Embed seller_utterance_paraphrase (the normalized form is what we match on)
  const inputs = usable.map((p) => (p.seller_utterance_paraphrase || p.seller_utterance).trim());
  const embeddings = await embedBatch(inputs, "document");
  if (embeddings.length !== usable.length) {
    throw new Error(`embedding count mismatch: ${embeddings.length} vs ${usable.length}`);
  }

  const outcomeLabel = OUTCOME_TO_LABEL[opts.outcome] ?? "neutral";

  const rows: PatternInsert[] = usable.map((p, i) => ({
    call_id: opts.callId,
    pattern_type: p.pattern_type,
    stage: p.stage,
    seller_utterance: p.seller_utterance,
    seller_utterance_paraphrase: p.seller_utterance_paraphrase,
    agent_response: p.agent_response,
    agent_response_quality: p.agent_response_quality,
    outcome_label: outcomeLabel,
    confidence: p.confidence,
    tags: p.tags ?? [],
    embedding: pgVector(embeddings[i]!),
    extracted_by: model,
  }));

  // Idempotent: clear prior patterns for this call before re-inserting.
  // (Avoids duplicate rows on retries / re-extractions.)
  const { error: deleteErr } = await admin()
    .from("patterns")
    .delete()
    .eq("call_id", opts.callId);
  if (deleteErr) throw new Error(`Supabase delete prior patterns: ${deleteErr.message}`);

  const { error, count } = await admin().from("patterns").insert(rows, { count: "exact" });
  if (error) throw new Error(`Supabase insert: ${error.message}`);

  console.log(
    `[extract-patterns] call=${opts.callId} model=${model} extracted=${patterns.length} usable=${usable.length} inserted=${count}`,
    `tokens in/out=${usage.input_tokens}/${usage.output_tokens}`,
    `cache read/write=${usage.cache_read_input_tokens ?? 0}/${usage.cache_creation_input_tokens ?? 0}`
  );

  return { inserted: count ?? 0, patterns: usable };
}
