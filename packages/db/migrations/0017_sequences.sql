-- Sequences (docs/sequences.md): drip follow-up built on the workflow engine.
-- A sequence is a workflow row with kind = 'sequence' and trigger_type =
-- 'manual'; its runs can pause on a `wait` action and resume from a scheduled
-- job, and end early on an exit rule or an unenroll.
ALTER TABLE "workflows" ADD COLUMN "kind" text DEFAULT 'workflow' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "description" text;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "exit_rules" jsonb;--> statement-breakpoint
ALTER TABLE "workflows" ADD COLUMN "archived_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "workflows_org_kind_idx" ON "workflows" USING btree ("org_id","kind");--> statement-breakpoint
-- Pause / resume state. current_action_index is the next action to execute;
-- resume_at is when a `waiting` run continues (the resume job's run_at);
-- stopped_reason says why a `stopped` run ended early.
ALTER TABLE "workflow_runs" ADD COLUMN "current_action_index" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "resume_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "workflow_runs" ADD COLUMN "stopped_reason" text;--> statement-breakpoint
-- The safety-net sweep's path: overdue waiting runs. Partial expression
-- index, hand-written per the 0001_guards.sql precedent.
CREATE INDEX "workflow_runs_resume_idx" ON "workflow_runs" ("resume_at")
	WHERE "status" = 'waiting';
