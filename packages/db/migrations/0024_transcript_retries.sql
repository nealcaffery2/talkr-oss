-- Bounded retries for transcripts that failed on the recording media
-- (docs/transcription.md §1). A pre-signed carrier URL that expired before the
-- job ran, or storage that was briefly unreadable, heals by itself — but the
-- queue job behind the row has already dead-lettered by then, so nothing
-- re-reads the table. `retry_count` is what the sweep bounds itself with.
ALTER TABLE "transcripts" ADD COLUMN IF NOT EXISTS "retry_count" integer NOT NULL DEFAULT 0;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "transcripts_status_idx" ON "transcripts" ("status");
