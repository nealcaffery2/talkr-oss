CREATE TABLE "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"mode" text DEFAULT 'power' NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "campaign_leads" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"lead_id" uuid NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_attempt_at" timestamp with time zone,
	"next_attempt_at" timestamp with time zone,
	"priority" integer DEFAULT 0 NOT NULL,
	"last_outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "dial_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"campaign_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"state" text DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	"dialed_count" integer DEFAULT 0 NOT NULL,
	"connected_count" integer DEFAULT 0 NOT NULL,
	"abandoned_count" integer DEFAULT 0 NOT NULL,
	"current_line_limit" integer,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_leads" ADD CONSTRAINT "campaign_leads_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_leads" ADD CONSTRAINT "campaign_leads_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "campaign_leads" ADD CONSTRAINT "campaign_leads_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dial_sessions" ADD CONSTRAINT "dial_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dial_sessions" ADD CONSTRAINT "dial_sessions_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "dial_sessions" ADD CONSTRAINT "dial_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "campaigns_org_name_uq" ON "campaigns" USING btree ("org_id","name");--> statement-breakpoint
CREATE INDEX "campaigns_org_status_idx" ON "campaigns" USING btree ("org_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX "campaign_leads_uq" ON "campaign_leads" USING btree ("campaign_id","lead_id");--> statement-breakpoint
CREATE INDEX "campaign_leads_selection_idx" ON "campaign_leads" USING btree ("campaign_id","status","next_attempt_at","priority");--> statement-breakpoint
CREATE INDEX "campaign_leads_lead_idx" ON "campaign_leads" USING btree ("lead_id");--> statement-breakpoint
CREATE INDEX "dial_sessions_campaign_idx" ON "dial_sessions" USING btree ("campaign_id");--> statement-breakpoint
CREATE INDEX "dial_sessions_user_idx" ON "dial_sessions" USING btree ("user_id","state");--> statement-breakpoint
-- One active session per rep — DB-enforced (docs/dialers.md §7 C9).
CREATE UNIQUE INDEX "dial_sessions_one_active_uq" ON "dial_sessions" ("user_id") WHERE "state" = 'active';--> statement-breakpoint
-- Session/campaign linkage rides calls.raw (the queueId precedent); these
-- partial expression indexes keep the in-flight and rate queries indexed.
CREATE INDEX "calls_dial_session_idx" ON "calls" ((raw->>'dialSessionId')) WHERE raw->>'dialSessionId' IS NOT NULL;--> statement-breakpoint
CREATE INDEX "calls_campaign_raw_idx" ON "calls" ((raw->>'campaignId')) WHERE raw->>'campaignId' IS NOT NULL;
