-- Twilio is gone; Telnyx is the only carrier. New rows that leave `provider`
-- unset are Telnyx's. Existing rows keep whatever they say: before the carrier
-- name was recorded everything was stamped 'twilio' regardless of who carried
-- it, so rewriting history would only swap one guess for another.
ALTER TABLE "phone_numbers" ALTER COLUMN "provider" SET DEFAULT 'telnyx';--> statement-breakpoint
ALTER TABLE "calls" ALTER COLUMN "provider" SET DEFAULT 'telnyx';--> statement-breakpoint
ALTER TABLE "call_legs" ALTER COLUMN "provider" SET DEFAULT 'telnyx';--> statement-breakpoint
ALTER TABLE "call_participants" ALTER COLUMN "provider" SET DEFAULT 'telnyx';--> statement-breakpoint
ALTER TABLE "recordings" ALTER COLUMN "provider" SET DEFAULT 'telnyx';--> statement-breakpoint
ALTER TABLE "messages" ALTER COLUMN "provider" SET DEFAULT 'telnyx';--> statement-breakpoint
ALTER TABLE "provider_costs" ALTER COLUMN "provider" SET DEFAULT 'telnyx';
