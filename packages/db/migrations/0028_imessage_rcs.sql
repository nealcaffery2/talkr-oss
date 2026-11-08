-- iMessage (Sendblue) and RCS (Telnyx) channels (docs/messaging-channels.md).
-- Everything here defaults off: a deployment without SENDBLUE_* or
-- TELNYX_RCS_AGENT_ID, or a line without the switches, sends SMS exactly as
-- before.
--
-- A read receipt is a new message status. ADD VALUE runs inside the migration
-- transaction (Postgres 12+); nothing in this file uses the new value, which
-- Postgres forbids before the transaction commits.
ALTER TYPE "message_status" ADD VALUE IF NOT EXISTS 'read';
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "read_at" timestamptz;
--> statement-breakpoint
-- How the message travelled. Every existing row is SMS/MMS through Telnyx.
ALTER TABLE "messages" ADD COLUMN IF NOT EXISTS "channel" text NOT NULL DEFAULT 'sms';
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "messages" ADD CONSTRAINT "messages_channel_chk" CHECK ("channel" IN ('sms', 'imessage', 'rcs'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
-- Per-line switches. iMessage cannot leave from a Telnyx number, so a line
-- names the Sendblue number it sends iMessage from (null = SENDBLUE_FROM_NUMBER).
ALTER TABLE "phone_numbers" ADD COLUMN IF NOT EXISTS "imessage_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD COLUMN IF NOT EXISTS "sendblue_from_number" text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "phone_numbers_sendblue_from_number_unique" ON "phone_numbers" ("sendblue_from_number");
--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD COLUMN IF NOT EXISTS "rcs_enabled" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Cached capability lookups (Sendblue allows 30 an hour per line).
CREATE TABLE IF NOT EXISTS "channel_capabilities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "phone_e164" text NOT NULL,
  "channel" text NOT NULL CHECK ("channel" IN ('imessage', 'rcs')),
  "supported" boolean NOT NULL,
  "checked_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "channel_capabilities_uq" ON "channel_capabilities" ("phone_e164", "channel");
