-- No-answer overflow to an AI agent (docs/inbound-routing.md §11). A rep's line
-- can name a number that picks up when the rep does not: the AI agent that
-- covers their team, wired by CLOZR. Null keeps today's behaviour (voicemail).
ALTER TABLE "phone_numbers" ADD COLUMN IF NOT EXISTS "overflow_to_e164" text;
--> statement-breakpoint
-- How long the rep's browser rings before the call overflows; null = 25.
ALTER TABLE "phone_numbers" ADD COLUMN IF NOT EXISTS "ring_timeout_seconds" integer;
