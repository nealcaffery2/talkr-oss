CREATE TABLE "telephony_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_credential_id" text NOT NULL,
	"sip_username" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "telephony_credentials" ADD CONSTRAINT "telephony_credentials_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "telephony_credentials" ADD CONSTRAINT "telephony_credentials_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "telephony_credentials_user_provider_uq" ON "telephony_credentials" USING btree ("user_id","provider");--> statement-breakpoint
CREATE INDEX "telephony_credentials_org_idx" ON "telephony_credentials" USING btree ("org_id");
