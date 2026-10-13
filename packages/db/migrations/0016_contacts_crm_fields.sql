-- Contacts as a CRM surface (docs/contacts.md). Additive columns on the
-- existing contacts table: type/status/temperature vocabularies live in
-- packages/core/src/contacts.ts (text here so a new value needs no migration),
-- soft delete via deleted_at, and the activity/temperature columns the
-- contact-temperature-sweep job maintains. Existing rows become
-- seller / new / cold with an empty tag list.
ALTER TABLE "contacts" ADD COLUMN "type" text DEFAULT 'seller' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "status" text DEFAULT 'new' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "company" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "tags" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "source" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "notes" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "temperature" text DEFAULT 'cold' NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "temperature_score" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "temperature_locked" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "temperature_updated_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "last_activity_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "assigned_user_id" uuid REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "created_by" uuid REFERENCES "users"("id");--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "contacts_org_type_idx" ON "contacts" ("org_id", "type");--> statement-breakpoint
CREATE INDEX "contacts_org_status_idx" ON "contacts" ("org_id", "status");--> statement-breakpoint
CREATE INDEX "contacts_org_temperature_idx" ON "contacts" ("org_id", "temperature_score" DESC);--> statement-breakpoint
CREATE INDEX "contacts_org_deleted_idx" ON "contacts" ("org_id", "deleted_at");--> statement-breakpoint
CREATE INDEX "contacts_org_activity_idx" ON "contacts" ("org_id", "last_activity_at" DESC);--> statement-breakpoint
CREATE INDEX "contacts_tags_gin_idx" ON "contacts" USING gin ("tags");
