-- Before the carrier name was recorded, every call, leg, participant, recording,
-- message, webhook delivery and cost row was stamped 'twilio' whatever carried
-- it, and production has run on Telnyx since the cutover. Twilio is gone, so the
-- label now says what these rows are. Left alone: phone_numbers, where 'twilio'
-- can mean a number really bought on Twilio that cannot be dialed from any
-- more (docs/telnyx-setup.md §9), and provider_accounts, which describe
-- accounts, not traffic.
UPDATE "calls" SET "provider" = 'telnyx' WHERE "provider" = 'twilio';--> statement-breakpoint
UPDATE "call_legs" SET "provider" = 'telnyx' WHERE "provider" = 'twilio';--> statement-breakpoint
UPDATE "call_participants" SET "provider" = 'telnyx' WHERE "provider" = 'twilio';--> statement-breakpoint
UPDATE "recordings" SET "provider" = 'telnyx' WHERE "provider" = 'twilio';--> statement-breakpoint
UPDATE "messages" SET "provider" = 'telnyx' WHERE "provider" = 'twilio';--> statement-breakpoint
UPDATE "webhook_events" SET "provider" = 'telnyx' WHERE "provider" = 'twilio';--> statement-breakpoint
UPDATE "reconciliation_mismatches" SET "provider" = 'telnyx' WHERE "provider" = 'twilio';--> statement-breakpoint
-- (provider, item_type, provider_ref) is unique: a leg already in the ledger
-- under 'telnyx' keeps that row and the duplicate 'twilio' one goes.
DELETE FROM "provider_costs" t
  WHERE t."provider" = 'twilio'
    AND EXISTS (
      SELECT 1 FROM "provider_costs" x
      WHERE x."provider" = 'telnyx' AND x."item_type" = t."item_type" AND x."provider_ref" = t."provider_ref"
    );--> statement-breakpoint
UPDATE "provider_costs" SET "provider" = 'telnyx' WHERE "provider" = 'twilio';
