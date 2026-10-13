-- Two display columns the design needs and the schema did not have.
--
-- `users.title` is the job someone does ("Acquisitions", "Dispo"), which is
-- not their RBAC role — the team board was rendering `rep` because that was
-- the only thing there. Roles stay the permission boundary; this is a label.
ALTER TABLE "users" ADD COLUMN "title" text;--> statement-breakpoint
-- Template category drives the chip on a template card (cold/warm/hot/
-- compliance). Free text rather than an enum: the set will grow, and a
-- template with an unrecognized category still has to render.
ALTER TABLE "message_templates" ADD COLUMN "category" text;
