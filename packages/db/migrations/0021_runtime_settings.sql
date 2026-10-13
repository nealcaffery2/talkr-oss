-- Deployment settings as rows, for hosts where the operator cannot (or would
-- rather not) edit environment variables. Read once at boot, allow-listed to
-- carrier and AI keys (apps/server/src/services/runtime-settings.ts); a real
-- environment variable always wins over the row of the same name.
CREATE TABLE "runtime_settings" (
  "key" text PRIMARY KEY NOT NULL,
  "value" text NOT NULL,
  "note" text,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
