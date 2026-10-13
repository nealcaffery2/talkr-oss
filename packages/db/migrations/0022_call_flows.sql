-- Call flows (packages/core/src/call-flow.ts) live in phone_numbers.ivr as
-- {version: 2, ...}; no new table. What the flows need that did not exist:
-- a teammate's own phone to forward to when they miss a call, and their own
-- voicemail greeting ({tts} or {audio_url}).
ALTER TABLE "users" ADD COLUMN "personal_phone_e164" text;
ALTER TABLE "users" ADD COLUMN "voicemail_greeting" jsonb;

-- Missed-call auto-text cooldown looks back for the caller's recent calls to
-- the same line.
CREATE INDEX IF NOT EXISTS "calls_number_from_created_idx" ON "calls" ("phone_number_id", "from_number", "created_at");
