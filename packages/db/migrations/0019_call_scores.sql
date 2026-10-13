-- AI call scoring + coaching (docs/coaching.md). One row per call, upserted
-- by call_id: a call has exactly one current score and re-scoring replaces it
-- in place, so the coaching rollup never double-counts a re-run. Kept apart
-- from `transcripts` because it is a second Claude pass with its own model,
-- its own failures and its own manual re-run, over a transcript that is
-- already finished.
CREATE TABLE "call_scores" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "call_id" uuid NOT NULL REFERENCES "calls"("id") ON DELETE CASCADE,
  -- The transcript the score was read from; SET NULL keeps a score readable
  -- after a transcript is re-run, and the row records which model wrote it.
  "transcript_id" uuid REFERENCES "transcripts"("id") ON DELETE SET NULL,
  "model" text,
  "status" text DEFAULT 'queued' NOT NULL, -- queued|running|completed|failed
  -- 0-100. The model answers on the house 0-10 scale (average 5-6, top 7-8);
  -- packages/core/src/coaching.ts multiplies once, here it is a percentage.
  "overall" integer,
  -- Rep share of speaking time, 0-1. Arithmetic over the transcript segments,
  -- never a model output.
  "rep_talk_ratio" numeric(4, 3),
  -- { <category>: { score: 0-10 | null, reason } } for the ten categories in
  -- packages/core/src/coaching.ts.
  "categories" jsonb DEFAULT '{}'::jsonb NOT NULL,
  -- string[]: what the rep did well, each with a verbatim quote.
  "strengths" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- string[]: what to fix, each with what to say instead.
  "gaps" jsonb DEFAULT '[]'::jsonb NOT NULL,
  -- [{ moment, quote, instead }]: doors the seller opened that the rep passed.
  "missed_opportunities" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "next_action" text,
  -- The Price x Motivation read-out: { bucket, motivation_score,
  -- price_alignment_score, bucket_confidence, bucket_rationale,
  -- recommended_play, motivation, timeline, condition, price_expectation,
  -- emotions[] }.
  "seller" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);--> statement-breakpoint
-- One current score per call: the scoring job upserts on this.
CREATE UNIQUE INDEX "call_scores_call_uq" ON "call_scores" ("call_id");--> statement-breakpoint
-- The manager rollup: one org's scores over a date range.
CREATE INDEX "call_scores_org_created_idx" ON "call_scores" ("org_id", "created_at");
