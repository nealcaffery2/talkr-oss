# Talkr Platform — Data Model

**Status:** living document. The authoritative schema is `packages/db/src/schema.ts` (Drizzle) and the generated SQL in `packages/db/migrations/`. This document explains the shape and the reasoning; when they disagree, the code is right and this file needs a PR.

Conventions:

- Every internal ID is a UUID we mint (`gen_random_uuid()`); provider IDs (Telnyx TeXML SIDs, Podio item IDs) are plain columns (`provider_call_id`, `external_item_id`) and are **never** used as foreign keys between our tables.
- `provider` columns default to `'telnyx'` (migration 0025). Traffic rows once stamped `'twilio'` regardless of carrier were relabelled by migration 0026; `phone_numbers` rows saying `'twilio'` are numbers really bought on Twilio and were left alone.
- Every tenant-owned table carries `org_id` and every query path is org-scoped (see security.md).
- `created_at`/`updated_at` are `timestamptz` defaulting to `now()`.
- Append-only tables (`call_events`, `webhook_events`, `audit_log`) are never updated in place except for processing bookkeeping columns.
- Stable closed sets use PG enums; evolving sets (event types, job types) use `text` so adding a value never needs a migration.

## Phase 1–2 schema (implemented)

### Identity & tenancy

**organizations** — `id, name, slug (unique), settings jsonb, created_at, updated_at`.
Settings holds org-level defaults: default caller ID, quiet hours, recording policy.

**users** — `id, org_id, auth_user_id (Supabase JWT sub, unique nullable), email, display_name, role, title, status, timezone, city, default_phone_number_id, created_at`.
`title` is the job ("Acquisitions", "Dispo") and is display-only — it is *not*
`role`, which is the permission boundary. Reps set their own title, timezone
and city; showing `role` on a team card was the bug this replaced.
`role ∈ {owner, admin, manager, rep}` (PG enum). v1 is single-org-per-user; a membership table replaces `users.org_id` if multi-org is ever needed. The role→permission expansion lives in code (`packages/core/src/rbac.ts`), not the DB, so permission changes are code-reviewed.

**teams** — `id, org_id, name`; **team_members** — `(team_id, user_id)` PK.

### CRM linkage

**crm_connections** — `id, org_id, provider ('podio'), status, external_org_id, settings jsonb, created_at`. OAuth tokens are **not** stored here in plaintext; see security.md (secret vault indirection).

**crm_field_mappings** — `id, connection_id, entity ('lead'|'contact'|'property'), external_app_id, external_field_id, internal_field, direction ('inbound'|'outbound'|'both'), transform jsonb`. Drives the admin mapping UI (Phase 2+) and the sync workers.

**leads** — `id, org_id, crm_connection_id, external_item_id (Podio item), status, source, assigned_user_id, property_id, primary_contact_id, raw jsonb` **plus the speed-to-lead ladder**: `external_created_at, received_at, assigned_at, first_attempt_at, first_answer_at, first_conversation_at`. These six timestamps are written exactly once each (first-write-wins) by the event pipeline; the entire speed-to-lead dashboard is queries over them.
Unique: `(crm_connection_id, external_item_id)`.

**Lead activity (read model)** — `GET /v1/leads/:id` returns the lead card plus
one merged, newest-first timeline built at read time from `calls`, `messages`
(via `conversations.lead_id`), `tasks`, and the speed-to-lead columns on the
lead itself (`received_at`, `assigned_at`, `first_attempt_at`, `first_answer_at`,
`first_conversation_at`). Nothing is stored twice; the list is capped (default
50, max 200). On a timestamp tie the concrete event outranks the milestone it
produced, so "Outbound call · answered" reads above "First answer". Service:
`apps/server/src/services/lead-activity.ts`.

**contacts** — `id, org_id, display_name, raw jsonb` plus the CRM columns (`type, status, email, company, tags text[], source, notes, temperature, temperature_score, temperature_locked, temperature_updated_at, last_activity_at, assigned_user_id, created_by, updated_at, deleted_at`) — vocabularies, temperature formula, import format and the `/v1/contacts` API are in [contacts.md](contacts.md).
**contact_phones** — `id, org_id, contact_id, phone_e164, label, is_primary`; unique `(org_id, contact_id, phone_e164)`, indexed `(org_id, phone_e164)` — this index is what makes inbound caller recognition instant.

**properties** — `id, org_id, address_line1, city, state, postal_code, raw jsonb`.

### Numbers

**phone_numbers** — `id, org_id, provider, provider_number_id, phone_e164 (unique), capabilities jsonb, status ('active'|'releasing'|'released'), assigned_user_id, assigned_team_id, area_code, label, purchased_at, released_at`. Number pools, reputation, messaging services: Phase 3/4 additive migrations.

### Calls

**calls** — the logical call (one per human-perceived conversation):
`id, org_id, correlation_id, direction ('outbound'|'inbound'), status, user_id, lead_id, contact_id, phone_number_id, from_number, to_number, provider, provider_call_id (parent leg SID, unique), initiated_at, ringing_at, answered_at, ended_at, duration_seconds, failure_class, failure_detail, disposition_id, disposition_note, follow_up_at, wrapup_completed_at, price_cents, price_currency, raw jsonb`.

`status` (PG enum): `queued → initiated → ringing → in_progress → {completed | no_answer | busy | failed | canceled}`. Transitions are **monotonic** — a late `ringing` webhook after `completed` is appended to `call_events` but never changes `status` (see telephony-events.md §4). `failure_class ∈ {none, seller_no_answer, seller_busy, carrier_failure, platform_failure, canceled}` — this is the column that lets reporting distinguish "seller didn't answer" from "our system failed."

**call_legs** — one row per provider call resource:
`id, org_id, call_id, leg_role ('client'|'pstn'|'other'), provider, provider_call_id (unique), status, from_number, to_number, started_at, answered_at, ended_at, duration_seconds, raw`.
A browser outbound call has a `client` leg (rep's browser ⇄ Telnyx) and a `pstn` leg (Telnyx ⇄ seller). The **pstn leg** drives the logical call's answered/no-answer semantics.

**call_events** — append-only canonical timeline:
`id, org_id, call_id, leg_id, event_type (text, canonical), occurred_at, source ('webhook'|'api'|'client'|'reconciliation'|'system'), webhook_event_id, sequence_number, payload jsonb, created_at`.
Unique `(call_id, event_type, coalesce(leg_id), coalesce(sequence_number))` dedupe guard on webhook-sourced events. The Call Journey admin view is a straight read of this table.

**call_dispositions** — org-configurable wrap-up choices: `id, org_id, name, slug, sort_order, is_system, is_active, requires_follow_up, treat_as_conversation`. Seeded per org with: No Answer, Voicemail, Wrong Number, Follow Up, Appointment, Offer Made, Not Interested, Dead Lead, Contract Sent, Contract Signed, DNC, Other. Selecting DNC also writes a `suppression_records` row.

**call_notes** — `id, org_id, call_id, user_id, body, created_at`.

**scripts** — what a rep reads mid-call: `id, org_id, kind ('script'|'rebuttal'), title, category, tags text[], contact_types text[], campaign_id, body, sort_order, enabled, created_by, created_at, updated_at`. Indexed `(org_id, kind, sort_order)` and `(org_id, campaign_id)`. Vocabularies, merge fields, the campaign → contact-type → generic selection rule, the Your Company playbook preset, the `/v1/scripts` API and the `GET /v1/call-context` read the dialer makes are in [scripts.md](scripts.md).

### Recordings

**recordings** — `id, org_id, call_id, provider, provider_recording_id (unique), status ('processing'|'completed'|'failed'|'absent'|'deleted'), duration_seconds, channels, provider_url, storage_path, error_code, started_at, completed_at, raw`.
Created only from recording webhooks or reconciliation — **never** assumed to exist because a call ended. `storage_path` is set by the mirror job that copies media into our object storage; until then playback proxies the provider URL server-side (signed, permission-checked).

### Compliance primitives

**suppression_records** — `id, org_id, phone_e164, scope ('org'|'campaign'), campaign_id, channel ('voice'|'sms'|'all'), reason ('stop'|'dnc_disposition'|'manual'|'complaint'|'legal'), source, note, created_at, expires_at`. Unique `(org_id, phone_e164, scope, channel, coalesce(campaign_id))`. `POST /v1/calls` and every future send path check this table first.

**consent_records** — `id, org_id, contact_id, phone_e164, channel, consent_type ('express'|'implied'|'unknown'), captured_by, captured_at, evidence jsonb`.

### Event ingestion, jobs, audit, integrity

**webhook_events** — the raw inbound log:
`id, provider, endpoint, idempotency_key (unique), org_id (nullable until resolved), signature_valid, headers jsonb, raw_body text, parsed jsonb, provider_object_id, provider_event_type, status ('received'|'processing'|'processed'|'failed'|'dead_letter'|'skipped_duplicate'|'rejected'), attempts, last_error, received_at, processed_at`.
Idempotency keys per provider/endpoint are specified in telephony-events.md §3.

**jobs** — the durable queue:
`id, queue, job_type, payload jsonb, dedupe_key (unique nullable), status ('pending'|'running'|'succeeded'|'failed'|'dead'), run_at, attempts, max_attempts, priority, last_error, locked_at, locked_by, correlation_id, created_at, updated_at`.
Claim = `SELECT … FOR UPDATE SKIP LOCKED`; retry backoff `min(base·2^attempts, cap)` with jitter; `attempts ≥ max_attempts ⇒ status='dead'` (the dead-letter queue is `status='dead'`, replayable via admin API which resets it to pending).

**audit_log** — `id, org_id, actor_type ('user'|'system'|'api_key'|'provider'), actor_id, action, object_type, object_id, metadata jsonb, correlation_id, created_at`. Written for every state-changing API call and every consequential system action (call created, disposition set, suppression added, number assigned, replay triggered).

**reconciliation_mismatches** — `id, org_id, object_type, object_id, provider, field, internal_value, provider_value, detected_at, resolved_at, resolution`. Fed by the post-call reconciliation job; surfaced on the data-integrity dashboard. Also covers **orphans**: a provider call ID with no internal object creates a mismatch row with `object_id = null` — satisfying the "100% of provider call IDs map to an internal object or explicit orphan state" SLO.

**provider_accounts** — `id, org_id, provider, external_account_id, label, status, config jsonb (non-secret)`. Secret material lives in the environment/secret store under keys referenced from config (see security.md).

## Later-phase entities (designed, not yet migrated)

| Phase | Entities | Notes |
|---|---|---|
| 3 | `routing_rules`, `queues`, `queue_members`, `business_hours`, `voicemail_greetings`, `agent_presence` | inbound routing; presence in PG + memory, Redis if needed |
| 4 | `message_threads`, `messages`, `message_events`, `message_templates`, `messaging_services`, `opt_out_events` | thread key = `(org_id, our_number, their_number)`; STOP writes suppression + opt_out_events |
| 5 | `campaigns`, `campaign_contacts`, `dial_sessions`, `dial_attempts`, `retry_rules`, `number_pools`, `number_assignments` | power → progressive → parallel → predictive |
| 6 | reporting is **views/materialized views over existing facts**, not new write paths | plus `cost_ledger` fed by provider usage reconciliation |
| 7 | `workflows`, `workflow_versions`, `workflow_runs`, `workflow_step_runs` | versioned definitions; run-level idempotency; loop budget per trigger |
| 8 | `transcripts`, `ai_analyses`, `scorecards`, `scorecard_results` | Coach's pattern/playbook tables merge in here |
| 10 | `api_keys`, `webhook_subscriptions`, `webhook_deliveries`, `webhook_fanout_cursors` (implemented — docs/public-api.md) | HMAC-signed outbound webhooks with replay protection; MCP server reuses `api_keys`, no table of its own |

## Reconstructability guarantee

For any call, the following joins reconstruct exactly what happened, in order, with provenance:

```
calls ← call_legs ← call_events (ordered by occurred_at, sequence_number)
      ← recordings                 each webhook-sourced event links to its
      ← webhook_events (raw)       raw webhook_events row: the exact bytes
      ← audit_log (who did what)   the carrier sent us, headers included
      ← jobs (what we did about it, including failures and retries)
      ← reconciliation_mismatches (where provider truth disagreed with ours)
```

If that chain can't answer a question about a call, the schema is missing something — file it as a bug.
