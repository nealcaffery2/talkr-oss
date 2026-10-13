-- In-call scripts (docs/scripts.md): the talk track a rep reads mid-call
-- (kind = 'script') and the objection rebuttals beside it (kind = 'rebuttal').
-- `tags` carries a rebuttal's trigger phrases; `contact_types` narrows a
-- script to contact types (empty = any); `campaign_id` pins one to a
-- campaign. kind/category are text — the vocabularies live in
-- packages/core/src/scripts.ts, so a new value needs no migration.
CREATE TABLE "scripts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"title" text NOT NULL,
	"category" text,
	"tags" text[] DEFAULT '{}'::text[] NOT NULL,
	"contact_types" text[] DEFAULT '{}'::text[] NOT NULL,
	"campaign_id" uuid,
	"body" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scripts" ADD CONSTRAINT "scripts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
-- The list and call-context reads: one org's scripts of one kind, in order.
CREATE INDEX "scripts_org_kind_idx" ON "scripts" USING btree ("org_id","kind","sort_order");--> statement-breakpoint
-- Campaign-pinned scripts for one campaign.
CREATE INDEX "scripts_org_campaign_idx" ON "scripts" USING btree ("org_id","campaign_id");
