-- Completion routing + AI agent steps (docs/sequences.md §11-12).
-- on_complete: {mode none|fixed|smart, sequence_id, candidate_ids[], also_when_stopped};
-- null means the lead simply leaves the plan when the run ends.
ALTER TABLE "workflows" ADD COLUMN "on_complete" jsonb;--> statement-breakpoint
-- Where a finished run sent its lead next, and why (the router's reason or
-- the fixed rule). Set once, by the engine, when the next run is created.
ALTER TABLE "workflow_runs" ADD COLUMN "routed_run_id" uuid;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "routed_reason" text;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD CONSTRAINT "workflow_runs_routed_run_id_workflow_runs_id_fk" FOREIGN KEY ("routed_run_id") REFERENCES "public"."workflow_runs"("id") ON DELETE set null ON UPDATE no action;
