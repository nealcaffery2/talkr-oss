-- How a rep's outbound caller ID is chosen (services/caller-id.ts):
-- 'dedicated' = always their default number; 'local_presence' = an org number
-- whose area code matches the destination, falling back to the default.
ALTER TABLE "users" ADD COLUMN "caller_id_mode" text DEFAULT 'dedicated' NOT NULL;
