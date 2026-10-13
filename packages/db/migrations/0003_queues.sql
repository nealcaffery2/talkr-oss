CREATE TABLE "queue_members" (
	"queue_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	CONSTRAINT "queue_members_queue_id_user_id_pk" PRIMARY KEY("queue_id","user_id")
);
--> statement-breakpoint
CREATE TABLE "queues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"strategy" text DEFAULT 'simultaneous' NOT NULL,
	"max_wait_seconds" integer DEFAULT 90 NOT NULL,
	"wait_message" text,
	"overflow" text DEFAULT 'voicemail' NOT NULL,
	"overflow_forward_e164" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_presence" ADD COLUMN "last_rung_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "agent_presence" ADD COLUMN "last_call_ended_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD COLUMN "queue_id" uuid;--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD COLUMN "ivr" jsonb;--> statement-breakpoint
ALTER TABLE "queue_members" ADD CONSTRAINT "queue_members_queue_id_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queue_members" ADD CONSTRAINT "queue_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "queues" ADD CONSTRAINT "queues_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "queues_org_name_uq" ON "queues" USING btree ("org_id","name");--> statement-breakpoint
ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_queue_id_queues_id_fk" FOREIGN KEY ("queue_id") REFERENCES "public"."queues"("id") ON DELETE no action ON UPDATE no action;