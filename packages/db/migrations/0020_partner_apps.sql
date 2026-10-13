-- Partner apps (CLOZR) whose sign-in Talkr trusts, configured as rows rather
-- than env vars so onboarding one is an insert, not a redeploy. `issuer` is
-- the `iss` claim; `jwks_url` and/or `secret` verify the signature; `origins`
-- join WEB_ORIGIN in the CORS allowlist (exact, or one `*` label).
CREATE TABLE "partner_apps" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "name" text NOT NULL,
  "issuer" text NOT NULL UNIQUE,
  "jwks_url" text,
  "secret" text,
  "origins" text[] DEFAULT '{}'::text[] NOT NULL,
  "enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL,
  "updated_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
-- (issuer, subject) -> user. A person has one Talkr auth id in users.auth_user_id
-- and a different one per partner; this holds the partner ones.
CREATE TABLE "partner_identities" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "issuer" text NOT NULL,
  "subject" text NOT NULL,
  "created_at" timestamptz DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX "partner_identities_iss_sub_uq" ON "partner_identities" ("issuer", "subject");
--> statement-breakpoint
CREATE INDEX "partner_identities_user_idx" ON "partner_identities" ("user_id");
