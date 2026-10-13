-- Caller reputation (packages/core/src/reputation.ts).
-- One jsonb per owner rather than tables: the shapes are small, read on the
-- send path next to rows already loaded, and read with never-throwing readers.
--
-- phone_numbers.reputation: {protection: {daily_call_cap, daily_sms_cap,
--   pause_on_warning}, check: {checked_at, cnam, spam}} - protection is what an
--   admin set; check is the last carrier lookup (refreshed at most daily).
-- organizations.reputation: {sms_gate: auto|block|warn, ten_dlc: {checked_at,
--   brands, campaigns, assignments}} - the 10DLC snapshot the SMS gate reads.
ALTER TABLE "phone_numbers" ADD COLUMN IF NOT EXISTS "reputation" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "reputation" jsonb NOT NULL DEFAULT '{}'::jsonb;

