CREATE TABLE "provider_costs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"call_id" uuid,
	"recording_id" uuid,
	"message_id" uuid,
	"provider" text DEFAULT 'twilio' NOT NULL,
	"item_type" text NOT NULL,
	"amount" numeric(12, 6) NOT NULL,
	"currency" text DEFAULT 'USD' NOT NULL,
	"provider_ref" text NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"raw" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "provider_costs" ADD CONSTRAINT "provider_costs_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_costs" ADD CONSTRAINT "provider_costs_call_id_calls_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "provider_costs" ADD CONSTRAINT "provider_costs_recording_id_recordings_id_fk" FOREIGN KEY ("recording_id") REFERENCES "public"."recordings"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "provider_costs_ref_uq" ON "provider_costs" USING btree ("provider","item_type","provider_ref");--> statement-breakpoint
CREATE INDEX "provider_costs_org_occurred_idx" ON "provider_costs" USING btree ("org_id","occurred_at");--> statement-breakpoint
CREATE INDEX "provider_costs_call_idx" ON "provider_costs" USING btree ("call_id");
