-- Outbound MMS attachments (docs/sms.md §10). The bytes live in Postgres so
-- the API can serve them to the carrier from a public URL without a second
-- storage system or another secret. Rows are small (3 MB cap) and immutable.
CREATE TABLE "media_assets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "org_id" uuid NOT NULL REFERENCES "organizations"("id"),
  "uploaded_by" uuid REFERENCES "users"("id"),
  "content_type" text NOT NULL,
  "byte_size" integer NOT NULL,
  "filename" text,
  "data" bytea NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);--> statement-breakpoint
CREATE INDEX "media_assets_org_created_idx" ON "media_assets" ("org_id", "created_at");
