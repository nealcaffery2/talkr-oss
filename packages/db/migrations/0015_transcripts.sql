-- Call transcripts + AI call notes (docs/transcription.md). One row per
-- recording, written by the transcribe-recording job once the recording
-- completes. Kept apart from recordings because it is a different pipeline
-- (Deepgram, then Claude) that fails, retries and is re-run on its own.
CREATE TABLE "transcripts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "call_id" uuid NOT NULL REFERENCES "calls"("id") ON DELETE CASCADE,
  "recording_id" uuid REFERENCES "recordings"("id") ON DELETE SET NULL,
  "provider" text DEFAULT 'deepgram' NOT NULL,
  "model" text,
  "status" text DEFAULT 'queued' NOT NULL,
  "language" text,
  "duration_seconds" integer,
  "segments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "full_text" text,
  "summary" text,
  "ai" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "ai_model" text,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone
);--> statement-breakpoint
CREATE UNIQUE INDEX "transcripts_recording_uq" ON "transcripts" ("recording_id");--> statement-breakpoint
CREATE INDEX "transcripts_call_idx" ON "transcripts" ("call_id");--> statement-breakpoint
CREATE INDEX "transcripts_org_created_idx" ON "transcripts" ("org_id", "created_at");
