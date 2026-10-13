-- Hand-written expression indexes (drizzle-kit cannot express these).
-- See docs/data-model.md.

-- Second-line idempotency guard: the event applier computes a dedupe token
-- (provider object id + canonical type + sequence); double-apply is impossible.
CREATE UNIQUE INDEX "call_events_dedupe_uq" ON "call_events" ("call_id", "dedupe_token") WHERE "dedupe_token" IS NOT NULL;
--> statement-breakpoint

-- One suppression row per (org, phone, scope, channel, campaign-or-none).
CREATE UNIQUE INDEX "suppression_uq" ON "suppression_records" (
  "org_id", "phone_e164", "scope", "channel",
  COALESCE("campaign_id", '00000000-0000-0000-0000-000000000000'::uuid)
);
