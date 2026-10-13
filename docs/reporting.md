# Talkr Platform — Reporting, Floor View & Cost Ledger (Phase 6)

**Status:** living document. Design established 2026-08-25; matches
`apps/server/src/services/reports.ts`, `apps/server/src/routes/reports.ts`,
`apps/server/src/routes/floor.ts`, `apps/server/src/worker/costs.ts`, and the
`provider_costs` schema.

Phase 6 is **read side only**. Every number below is a query over facts the
event-sourced pipeline already captured (`calls`, `call_events`, `call_legs`,
`recordings`, `leads`, `reconciliation_mismatches`, `webhook_events`). Nothing
in this phase changes how the write side records a call. Numbers that are
wrong are worse than numbers that are missing, so **every metric definition
here is pinned by an integration test with hand-computed expectations**
(`apps/server/test/reports.test.ts` and friends).

---

## 1. Date ranges and timezone bucketing

- All report endpoints take `from` and `to` query params as **local calendar
  dates** (`YYYY-MM-DD`) **in the org's timezone** (`organizations.settings.timezone`,
  default `America/New_York` — the same default `packages/core/src/routing.ts`
  uses). The range is **inclusive of both days**: `[from 00:00:00 local, (to+1) 00:00:00 local)`.
- Default range when params are absent: **last 7 local days including today**
  (`to` = today in org tz, `from` = to − 6 days).
- Validation: both params must be `YYYY-MM-DD` and real dates, `from ≤ to`,
  and the span is capped at 366 days. Violations are a 400, never a silent
  clamp.
- **Bucketing implementation.** Day boundaries and day buckets are computed in
  Postgres with `AT TIME ZONE <org tz>`:
  - range lower bound: `(from::date)::timestamp AT TIME ZONE tz` (the UTC
    instant of local midnight);
  - bucket of a call: `(started_at AT TIME ZONE tz)::date`.
  Postgres and `Intl.DateTimeFormat` both evaluate against the platform's
  IANA tzdata, so this is the same DST-correct evaluation the routing engine
  uses; the JS side only computes "what local date is it right now" (via
  `Intl.DateTimeFormat('en-CA')`, `localDayString()` in
  `apps/server/src/services/reports.ts`) for defaults and the floor view's
  "today". The timezone string is validated with `Intl.DateTimeFormat` before
  it is ever handed to SQL; an invalid configured timezone falls back to the
  default rather than erroring the report.
- **A call belongs to the day it started**: `started_at = COALESCE(initiated_at, created_at)`.
  `initiated_at` is when the provider accepted the call; `created_at` covers
  calls that died before launch (`queued → canceled/failed`). A call that
  starts at 23:30 local and ends 00:20 local the next day counts **once, on
  the day it started** (pinned by test: a 03:30 UTC call in
  `America/New_York` lands on the previous local day).

## 2. Metric definitions (the SQL-level truth)

Unless stated otherwise, every metric is scoped `calls.org_id = :org` and to
the date range above, and **"terminal"** means
`status IN ('completed','no_answer','busy','failed','canceled')`.

### 2.1 Overview (`GET /v1/reports/overview`)

| Metric | Definition |
|---|---|
| `total_calls`, `outbound_calls`, `inbound_calls` | count of calls in range, split on `direction` |
| `answered_calls` (and per direction) | calls with `answered_at IS NOT NULL`. `answered_at` is stamped only when a *human* answered: the PSTN leg answering an outbound dial, or a rep's client leg answering an inbound call. An inbound caller flowing to voicemail never stamps it (the parent-leg `answered` does not drive the call — docs/inbound-routing.md §5), so voicemail ≠ answered by construction. |
| `missed_calls` | **inbound ∧ never in_progress ∧ terminal**: `direction='inbound' AND answered_at IS NULL AND status terminal`. The "terminal" clause is a deliberate refinement of the docs/inbound-routing.md §5 definition: a call still ringing on the floor has not been *missed* yet; it appears once it ends unanswered. An answered-then-completed inbound call is not missed; a never-answered voicemail call (`completed`, voicemail attached) **is** missed; a caller hangup during ringing (`no_answer`) is missed. |
| `voicemails_left` | calls where `raw ->> 'voicemailLeft' = 'true'` — stamped by `/twiml/voicemail-complete` only when the carrier confirms a `RecordingSid` for the Record verb. Being *offered* voicemail without leaving one does not count. |
| `answer_rate` (per direction) | `answered / terminal calls` of that direction; `null` when the denominator is 0 (never `0%` for "no calls"). In-flight calls are excluded from both sides. |
| `talk_seconds_total`, `talk_seconds_avg` | talk time of a call = `EXTRACT(EPOCH FROM ended_at - answered_at)`, summed/averaged over calls with **both** stamps. This is deliberately *not* `duration_seconds`: the provider-billed duration of an inbound parent leg includes IVR, queue hold and voicemail time; `answered_at → ended_at` is the conversation. (`duration_seconds` remains the billing-truth column and drives cost, not talk.) |
| `speed_to_lead_avg_seconds` | `AVG(first_attempt_at - received_at)` over **leads** with `received_at` in range and `first_attempt_at` set (both stamps are first-write-wins from the Phase 2 ladder). Leads not yet attempted are excluded from the average but reported as `leads_awaiting_first_attempt`; `null` when no lead qualifies. |
| `dispositions` | count of calls in range grouped by disposition slug/name, plus an explicit `undispositioned` count (`disposition_id IS NULL`). |

### 2.2 By-rep (`GET /v1/reports/by-rep`)

One row per **active user** in the org (zero rows are real zeros, not
missing). Attribution is `calls.user_id` — for inbound this is the routed
single target or, for queue/simultaneous rings, the rep whose client leg
answered (adopted by the applier).

| Column | Definition |
|---|---|
| `calls_made` | outbound calls attributed to the user, in range |
| `calls_received` | inbound calls attributed to the user (includes calls routed to them that they missed) |
| `answered` | attributed calls (either direction) with `answered_at IS NOT NULL` |
| `talk_seconds` | sum of `ended_at - answered_at` over attributed calls with both stamps |
| `avg_wrapup_seconds` | `AVG(wrapup_completed_at - ended_at)` over attributed calls with both stamps — "how long after hangup until the disposition was saved." Calls dispositioned mid-call (negative interval) are excluded (`wrapup_completed_at >= ended_at`). |
| `dispositions` | per-rep disposition slug counts |
| `cost` | sum of `provider_costs.amount` joined through the rep's calls (§3); `null` when the rep's calls carry no ledger rows — *no data*, not $0.00 |

### 2.3 By-day series (`GET /v1/reports/by-day`)

`generate_series(from, to)` of local days LEFT JOINed to calls bucketed by
`(started_at AT TIME ZONE tz)::date` — days with no calls appear with zeros.
Per day: `total`, `inbound`, `outbound`, `answered`, `missed` (same
definitions as §2.1). This is the endpoint whose timezone math is proven by
the 23:30-local test.

### 2.4 Queues (`GET /v1/reports/queues`)

Queue membership of a call is `calls.raw ->> 'queueId'` — stamped by
`enterQueue()` the moment the caller enters the queue treatment (directly or
via IVR). Waits are reconstructed from the journal
(`call.queue_ring` / `call.queue_overflow` events) plus call timestamps.

| Metric | Definition |
|---|---|
| `offered` | calls in range with `raw->>'queueId' = queue.id` |
| `answered` | offered calls with `answered_at IS NOT NULL` |
| `overflowed` | offered calls having a `call.queue_overflow` event whose payload `queueId` matches |
| `avg_wait_to_answer_seconds` | `AVG(answered_at - started_at)` over answered offered calls. Queue entry is synchronous with call start (the TwiML route stamps `raw.queueId` while answering the number's Voice URL), so call start ≈ queue entry; if an IVR fronted the queue, menu time is included in the wait — documented assumption, revisit if IVR-fronted queues need menu time excluded (the `call.ivr_selected` journal makes that possible later). |
| `avg_wait_to_overflow_seconds` | `AVG((payload->>'elapsedSeconds')::numeric)` over the queue's `call.queue_overflow` events — the elapsed value the wait loop itself computed and journaled, i.e. the authoritative hold time. |

### 2.5 Quality (`GET /v1/reports/quality`)

| Metric | Definition |
|---|---|
| `failure_classes` | terminal calls in range grouped by `failure_class` (`none`, `seller_no_answer`, `seller_busy`, `carrier_failure`, `platform_failure`, `canceled`) |
| `carrier_failure_trend` | by-day series of `carrier_failures` and `terminal_calls` (rate is computed client-side; days with 0 terminal calls have `null` rate, not 0) |
| `mismatches_open` / `mismatches_resolved` | `reconciliation_mismatches` rows with `org_id = :org`, `detected_at` in range, split on `resolved_at IS NULL`. Orphan rows carry `org_id IS NULL` and are deliberately **not** in this org-scoped report — they live on the admin integrity surface (`/v1/admin/mismatches`). |
| `missing_recordings` | calls in range that **expected** a recording but have none: `answered_at IS NOT NULL AND status='completed' AND ended_at < now() - interval '10 minutes'` (every bridged dial records dual-channel; 10 minutes is the recording-arrival grace period from docs/telephony-events.md §6) with **no `recordings` row at all**. A row with `status='failed'` is a *failed* recording, reported separately as `failed_recordings`, not "missing". |

## 3. Cost ledger

### 3.1 `provider_costs` table

One row per priced provider item, append-only from the extractor's point of
view. `org_id` + nullable linkage (`call_id`, `recording_id`, `message_id` —
message linkage is a plain uuid column until Phase 4's `messages` table
exists), `provider`, `item_type` (text: `'call'`, later `'recording'`,
`'sms'`…), `amount numeric(12,6)` (dollars, always ≥ 0 — TeXML reports
prices as negative decimals, Twilio-style; we store magnitude), `currency`, `provider_ref`
(the provider object id, e.g. leg CallSid), `occurred_at`, `raw` jsonb
provenance, `created_at`.

**Idempotency is structural**: `UNIQUE (provider, item_type, provider_ref)` +
`ON CONFLICT DO NOTHING`. Re-running the extractor over the same data can
never duplicate a row.

Migration: `packages/db/migrations/0006_reporting.sql` with a matching
`meta/_journal.json` entry tagged `0006_reporting`.

### 3.2 Extraction job (`extract-provider-costs`)

A periodic sweep worker job (`apps/server/src/worker/costs.ts`, registered
additively in the handler map; scheduled hourly by the worker entrypoint with
a dedupe key so overlapping schedules collapse). It **reads** what the write
side already persisted — it does not touch `apply-events.ts` or the reconcile
service:

1. **Webhook-carried prices.** TeXML includes `Price`/`PriceUnit` on some
   completed-call status callbacks. The sweep scans `webhook_events`
   (`provider IN ('twilio','telnyx')`: `'twilio'` covers anything an old instance
   writes mid-deploy, after migration 0026 relabelled the rest; `parsed->>'Price'` present, `received_at` within the
   lookback window, default 7 days) and emits one `call` ledger row per
   priced leg SID, resolving the internal call via `call_legs.provider_call_id`
   then `calls.provider_call_id`. A priced SID that resolves to no internal
   call is skipped this sweep (it stays in `webhook_events`; the next sweep
   retries after the call materializes) — never guessed into another org.
2. **Reconciliation-fetched prices.** The reconcile job already backfills
   `calls.price_cents`/`price_currency` from the provider REST snapshot of
   the truth leg (pstn leg if present, else the parent). The sweep reads
   calls with `price_cents IS NOT NULL` (ended within the lookback window)
   and emits a `call` row under **that same truth-leg SID**, so a
   webhook-derived row and a reconciliation-derived row for the same leg
   collapse into one via the unique key instead of double-counting.

`occurred_at` = the call's `ended_at` (fallback `created_at`) — spend buckets
onto the day the call ended, which is the event the carrier prices.

**Absent prices are normal** (test/simulated traffic, and many callback
variants omit `Price`): the sweep simply produces no rows, and the costs
report distinguishes *"no cost data"* (`has_data: false`, zero ledger rows in
range) from a genuine $0.00 total.

### 3.3 Costs report (`GET /v1/reports/costs`)

Spend in range (bucketed by `occurred_at` in org tz): `by_day`, `by_type`,
and `by_rep` (joined through `provider_costs.call_id → calls.user_id`;
un-linked or un-attributed rows land in an explicit `unattributed` bucket).
Amounts are returned as decimal strings per currency; the ledger keeps exact
`numeric`. The by-rep report (§2.2) joins per-rep cost in when rows exist.

## 4. Live floor view

### 4.1 Snapshot (`GET /v1/floor/state`)

One org-scoped query set, computed at request time (no caching — the floor is
a handful of indexed queries over one org's live rows):

- **Reps:** every `status='active'` user with presence (`status`,
  `last_seen_at`, and `fresh` = seen within `PRESENCE_FRESHNESS_MS` (90s) — a
  stale `available` row renders as unavailable, same math the router uses),
  plus their **current call**: the most recent non-terminal call
  (`status IN ('queued','initiated','ringing','in_progress')`) attributed to
  them, with direction, status, `answered_at`/`initiated_at` (the client
  computes live durations from these instants — no server ticking).
- **Today's per-rep counters** (local "today" via org tz): calls, answered,
  talk seconds — same definitions as §2.1/§2.2.
- **Queue depth:** per queue, calls currently in queue treatment: non-terminal
  ∧ `raw->>'queueId' = queue.id` ∧ `answered_at IS NULL` ∧ no
  `call.queue_overflow` event (an overflowed caller is in voicemail/forward,
  no longer waiting on the queue).
- **Org totals today:** calls, inbound, outbound, answered, missed, talk
  seconds, voicemails.

### 4.2 Live updates

The floor page rides the **existing** pg NOTIFY → SSE bus
(`/v1/events/stream`): `call.updated` events already publish on every driving
state change. One additive publish was needed: the presence heartbeat route
now also emits a `presence.updated` bus event (status flips were otherwise
invisible until the next poll). The floor client refetches the snapshot
(debounced) on either event type, ticks in-call durations locally every
second, and refreshes on a 30s interval as a fallback — no new server
plumbing, no per-floor socket fan-out.

## 5. AuthZ

- All `/v1/reports/*` endpoints require the existing **`reports.view.org`**
  permission (manager+). Rep tokens hold `reports.view.own` only and are
  denied — pinned by test.
- `/v1/floor/state` requires the new **`floor.view`** permission, added at
  manager level to the permission map (`packages/core/src/rbac.ts`,
  end-of-list). It is separated from `reports.view.org` so a future decision
  to show reps the wallboard is a one-line role-map change, not a data-scope
  change.

## 6. Implementation notes & scale-later

- Reports are **parameterized SQL** through Drizzle's `sql` template against
  the live tables. No materialized views yet: at small-team volume (thousands
  of calls/week) these are single-digit-millisecond index scans. When volume
  demands it, the documented upgrade path is materialized daily rollups
  (`report_daily_calls`) refreshed by a worker job — the metric definitions
  above become the view definitions, and the endpoints keep their contracts.
- The cost sweep is a bounded rescan (idempotent inserts + lookback window)
  rather than a high-water-mark cursor — simpler, self-healing after
  downtime, and cheap at v1 volume. A cursor is the scale-later step.
- Floor snapshot cost is O(org users + live calls); if orgs grow into
  hundreds of reps, snapshot assembly moves behind a 1–2s cache.

## 7. Documented assumptions

1. `answered_at` is the single source of "a human answered" for both
   directions (guaranteed by the driving rules in docs/inbound-routing.md §5).
2. Talk time is `answered_at → ended_at`, not the billed `duration_seconds`
   (which includes IVR/hold/voicemail time on inbound parent legs).
3. A call's report day is the local day it **started**.
4. Queue entry time ≈ call start (synchronous TwiML); IVR menu time counts
   into queue wait when an IVR fronts a queue.
5. Recording expectation = answered ∧ completed ∧ ended >10min ago; voicemail
   recordings belong to unanswered calls and are never "expected".
6. Ledger amounts store magnitude (the negative price convention is
   normalized); currency mixing is preserved per-currency in reports, never
   summed across currencies.
7. Speed-to-lead measures `received_at → first_attempt_at` on leads received
   in range; leads awaiting first attempt are counted, not averaged.
8. Reconciliation mismatch counts in the quality report are org-scoped;
   null-org orphan rows remain an admin-surface concern.

## 8. Activity history (`GET /v1/history`)

The manager-facing "one history" view: calls and texts in a single feed
with real filters, a KPI block that follows those filters, and a CSV export.
Implemented in `apps/server/src/routes/history.ts`; the web page is
`/calls` ("History"). Read side only — every number reuses a definition
from §1–2, nothing new is invented here.

### 8.1 Query parameters (all optional)

| Param | Meaning |
|---|---|
| `type` | `all` (default), `calls`, `sms` |
| `from`, `to` | Either `YYYY-MM-DD` (local calendar days in the org timezone, inclusive of both days, bucketed exactly like §1) or ISO datetimes (exact instants; `to` inclusive). Default: last 30 local days including today. Same validation as reports: real dates, `from ≤ to`, span ≤ 366 days, else 400 (`invalid_date` / `invalid_range` / `range_too_large`). |
| `direction` | `inbound` or `outbound` (both sources) |
| `status` | a call status (`completed`, `no_answer`, …) or a text status (`delivered`, `failed`, …). Compared as text, so an unknown value is an empty result, never a Postgres enum error. |
| `user_id` | rep. Calls: `calls.user_id`. Texts: the sender (`created_by`) for outbound, the conversation's `assigned_user_id` for inbound; compliance auto-replies belong to nobody. |
| `disposition` | disposition **slug** (calls only) |
| `min_duration`, `max_duration` | seconds of **talk time** (`ended_at − answered_at`, §2.1); calls only |
| `has_recording` | `true` = a `recordings` row with `status='completed'` exists; `false` = none |
| `has_note` | `true` = non-blank `disposition_note` |
| `q` | case-insensitive substring over contact name, rep name, lead/contact property address (line 1, city, state, postal code), disposition note and name, text body; digits in `q` (≥3) also match the phone numbers digit-for-digit (`512 555` finds `+15125550134`). LIKE metacharacters are escaped; every value is a bound parameter. |
| `limit`, `offset` | page size (default 50, max 200) and offset |

A text can never satisfy a call-only filter, so when `disposition`,
`min_duration`, `max_duration`, `has_recording=true` or `has_note=true` is
set, texts drop out of the feed and the KPIs. The negative forms
(`has_recording=false`, `has_note=false`) keep texts.

### 8.2 Response

```
{
  range: { from, to, timezone },        // resolved bounds (day strings or ISO)
  scope: 'own' | 'org',
  items: [{
    kind: 'call' | 'sms', id, direction, status, at,
    duration_seconds,                    // talk time for calls; null for texts / unanswered
    from_number, to_number, contact_name,
    address,                             // "line1, city, state" from the lead's property
    user_id, user_name,
    disposition_slug, disposition_label, note,
    has_recording,
    body, media_count,                   // texts
    lead_id, contact_id, conversation_id
  }],
  total,                                 // rows matching the filters (both sources)
  kpis: {
    calls, answered, connect_rate, avg_duration_seconds, talk_time_seconds,
    inbound, outbound, sms_sent, sms_received,
    by_disposition: [{ slug, label, count }],
    by_rep: [{ user_id, name, calls, answered, talk_time_seconds, sms }]
  }
}
```

Items are ordered by `at` descending (`COALESCE(initiated_at, created_at)`
for calls — the moment the call started, §1 — and `created_at` for texts).
Both sources are queried through one `UNION ALL` so pagination is exact.

**Address.** Leads carry the CRM (Podio) property via `leads.property_id`
(docs/podio-integration.md) — that is how a phone number ties to a house.
The row's own lead is used first; a row with a contact but no lead falls
back to the newest lead whose `primary_contact_id` is that contact.

### 8.3 KPI definitions (reused, not redefined)

| KPI | Definition |
|---|---|
| `calls`, `inbound`, `outbound` | calls matching the filters, split on `direction` |
| `answered` | `answered_at IS NOT NULL` (§2.1) |
| `connect_rate` | `answered / terminal` over both directions, `null` when no call is terminal (§2.1 `answer_rate`, combined) |
| `talk_time_seconds` | `Σ (ended_at − answered_at)` over calls with both stamps (§2.1) |
| `avg_duration_seconds` | `talk_time_seconds / calls with talk`, `null` when none (§2.1 `talk_seconds_avg`) |
| `sms_sent` / `sms_received` | matching texts, outbound / inbound (auto-replies included in `sms_sent`) |
| `by_disposition` | matching calls grouped by disposition slug/name (undispositioned excluded) |
| `by_rep` | per user: calls, answered, talk time (attribution `calls.user_id`, §2.2) plus texts attributed as under `user_id` above |

All KPIs respect the same filters as the rows, including `q`.

### 8.4 Scope (AuthZ)

- Gate: `calls.read.own` (every role).
- Calls: `calls.read.org` sees the org; otherwise `calls.user_id = me` —
  the rule `GET /v1/calls` already applies.
- Texts: `messages.read.org` sees the org; otherwise conversations assigned
  to me **or unassigned**, the same rule the inbox applies
  (`listConversations` in `services/messages.ts`). Without
  `messages.read.own` texts are omitted entirely.
- `scope` in the response tells the page whether the by-rep table and rep
  filter are meaningful.

### 8.5 CSV export (`GET /v1/history/export.csv`)

Same query parameters and scope; `limit`/`offset` are ignored and the whole
filtered set is written, capped at **10,000 rows** (newest first). Streams
`text/csv; charset=utf-8` with a UTF-8 BOM (so Excel reads names and
addresses correctly) and
`Content-Disposition: attachment; filename="talkr-history-<from>-to-<to>.csv"`.

Columns, in order: `when (<org tz>)` (local time, `YYYY-MM-DD HH:mm:ss`),
`kind` (call/text), `direction`, `status`, `contact`, `phone` (the other
party), `address`, `rep`, `duration_seconds` (talk time), `disposition`,
`note`, `recording` (yes/no, calls only), `sms_body`, `id`.

Free-text cells written by reps or sellers (contact, address, rep, disposition,
note, body) are neutralized against spreadsheet formula injection: a value
starting with `=`, `+`, `-`, `@`, tab or CR is prefixed with `'`.

The web page downloads through the authenticated client (`requestBlob` in
`apps/web/lib/api.ts`) and hands the bytes to the browser as a file — a plain
link cannot carry the bearer header. The server's `Content-Disposition` is
only readable cross-origin if CORS exposes it; the page computes the same
filename locally as a fallback.

### 8.6 Web page (`/calls`)

Filter bar (date presets Today / Yesterday / Last 7 / Last 30 / This month /
Custom, type, direction, rep, disposition, minimum length, recorded, has
note, search with a 300 ms debounce) persisted in the URL query string so a
view is shareable (`?range=7d&type=calls&dir=outbound&user=…&disp=…&min=60&rec=1&note=1&q=…`,
or `?range=custom&from=YYYY-MM-DD&to=YYYY-MM-DD`). The KPI strip and the
by-rep table (org viewers) are driven by the response `kpis`. "Load more"
pages with `offset`; the reports page links here with its applied range.
