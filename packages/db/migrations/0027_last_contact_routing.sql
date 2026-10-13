-- Last-contact routing (docs/inbound-routing.md §10): a callback to a pool
-- number rings the rep who last reached out to the caller.
--
-- phone_numbers.route_callbacks_to_last_contact: the per-number switch for the
-- default routing chain (call flows use a `last_contact` ring target instead).
ALTER TABLE "phone_numbers" ADD COLUMN IF NOT EXISTS "route_callbacks_to_last_contact" boolean NOT NULL DEFAULT false;
--> statement-breakpoint
-- Outreach Talkr cannot see (a partner's RVM drops, emails), posted by
-- POST /v1/outreach. ref is the partner's idempotency key; NULL refs never
-- collide (a plain unique index treats NULLs as distinct).
CREATE TABLE IF NOT EXISTS "outreach_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "phone_e164" text NOT NULL,
  "channel" text NOT NULL CHECK ("channel" IN ('rvm', 'email', 'other')),
  "occurred_at" timestamptz NOT NULL,
  "ref" text,
  "created_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "outreach_events_org_ref_uq" ON "outreach_events" ("org_id", "ref");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "outreach_events_org_phone_idx" ON "outreach_events" ("org_id", "phone_e164", "occurred_at");
--> statement-breakpoint
-- The inbound fast path asks "who called / texted this number lately":
-- outbound calls by destination, conversations by the other party.
CREATE INDEX IF NOT EXISTS "calls_org_to_created_idx" ON "calls" ("org_id", "to_number", "created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "conversations_org_their_idx" ON "conversations" ("org_id", "their_number");
