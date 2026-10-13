# Talkr Platform — Workflow Engine (Phase 7)

**Status:** living document; matches `packages/core/src/workflows.ts`,
`packages/db/src/schema.ts` (Workflows section),
`apps/server/src/worker/workflow-fanout.ts`,
`apps/server/src/worker/workflow-engine.ts`,
`apps/server/src/routes/workflows.ts`, and the `workflows` / `workflow_runs` /
`tasks` tables.

Phase 7 is event-driven automation for lead follow-up: "when X happens (and
these conditions hold), do Y". It is **compliance-first by construction** —
every workflow-sent SMS goes through the existing Phase 4 send path with
suppression and quiet hours fully enforced (no bypass flags exist), there is
no bulk-blast action, and hard loop-safety plus per-workflow rate caps are
mandatory, not optional.

**Sequences** (drip follow-up: text, wait two days, text again, stop on
reply) are built on this same engine — a sequence is a workflow row with
`kind = 'sequence'`, a `manual` trigger, `wait` actions and `exit_rules`.
They have their own API, page and document: **docs/sequences.md**. This
document covers the engine both share; the sequence-specific additions
(`manual`, `wait`, pause/resume, `waiting` / `stopped` runs, exit rules) are
marked where they touch it.

---

## 1. Shape of a workflow

A workflow is a stored, org-scoped row:

```
workflows: org_id, name, enabled, trigger_type, trigger_config jsonb,
           conditions jsonb, actions jsonb (ordered array),
           max_runs_per_lead_per_day (default 3),
           max_runs_per_day (default 500),
           kind ('workflow' | 'sequence'), description, exit_rules jsonb,
           archived_at,                       -- sequences (docs/sequences.md)
           created_by, created_at, updated_at
```

`trigger_type`, `conditions`, and every action are validated with zod at
write time (`packages/core/src/workflows.ts` schemas) — unknown trigger
types, unknown condition fields are *not* checked at write time (they depend
on runtime context) but unknown **ops**, malformed condition trees, and
unknown **action types** are rejected with HTTP 400 before anything is
stored. A workflow that somehow contains an unknown action at run time (e.g.
seeded directly) produces a `failed` run with a clear error — never a crash.

## 2. Trigger vocabulary

| trigger_type | Source tailed | Fires when | Trigger event identity (exactly-once key) |
|---|---|---|---|
| `call.completed` | `call_events` | a call reaches `call.completed` | `('call.completed', call_id)` |
| `call.missed` | `call_events` | **inbound ∧ never answered ∧ terminal** — the Phase 6 definition (`direction='inbound' AND answered_at IS NULL AND status terminal`), evaluated when any terminal call event lands | `('call.missed', call_id)` |
| `disposition.created` | `audit_log` (`action='call.disposition'`) — same source as Phase 10 | a rep wraps up a call | `('disposition.created', 'audit:'+audit_id)` |
| `message.received` | `messages` (`direction='inbound'`) | an inbound SMS is applied | `('message.received', message_id)` |
| `lead.created` | `leads` | a lead row is created | `('lead.created', lead_id)` |
| `no_contact_for_days` | hourly sweep over `leads` | a lead has **no call and no message activity** for `trigger_config.days` days | `('no_contact', lead_id + ':' + period_bucket)` |
| `manual` | **nothing** — no feed, no sweep | only when a user enrolls leads (`POST /v1/sequences/:id/enroll`, docs/sequences.md §2); the fan-out's trigger-type filters never match it | `('manual', lead_id)` — one run per lead per sequence, ever |

Design decisions:

- **Call triggers key on the call id, not the event id.** A single call can
  legitimately append more than one terminal `call_events` row (parent and
  child legs both complete; late events are recorded but never regress
  state). Keying the run on the call id makes each call trigger **at most
  once per call per workflow** no matter how many terminal facts the journal
  records. `call.completed` fires only when a `call.completed` event exists;
  `call.missed` fires on any terminal event whose call satisfies the missed
  predicate.
- **`message.received` reads the `messages` table, not webhooks**, filtered
  `direction = 'inbound'`. Outbound rows — including every workflow-sent
  SMS — are structurally invisible to this trigger (see §6).
- **`no_contact_for_days`:** activity = any `calls` row for the lead OR any
  message in a conversation linked to the lead, by `created_at`. The lead
  itself must also be older than the window (a lead created yesterday has
  not been "uncontacted for 7 days"). The period bucket is
  `floor(days_since_epoch / days)` (UTC), so a lead that stays stale fires
  at most once per N-day period per workflow; a second sweep inside the same
  period hits the unique key and is a no-op.
- **No history replay:** like Phase 10 subscriptions, a workflow only
  matches source rows created at-or-after the workflow's `created_at`.
  Enabling an old workflow does not re-run the past (cursor overlap aside —
  absorbed by the unique key).

## 3. Trigger feed (decoupled fan-out — `apply-events.ts` untouched)

`workflow-fanout` is a self-perpetuating worker job modeled directly on the
Phase 10 `webhook-fanout` sweep:

1. Reads a cursor per source from the existing `webhook_fanout_cursors`
   table under `workflow:`-prefixed keys (`workflow:call_events`,
   `workflow:audit_dispositions`, `workflow:messages`, `workflow:leads`).
   **Why reuse the table:** it is already a generic
   `(source text PK → cursor_at)` bookkeeping table with exactly the access
   pattern we need; a second identical table would add schema surface with
   zero isolation benefit. The `workflow:` prefix keeps the namespaces
   disjoint.
2. Scans each source for rows with `created_at > cursor − 5 min` (the same
   overlap re-scan window as Phase 10 — rows committed late by long
   transactions are never missed).
3. For each (candidate row × enabled workflow with matching trigger in the
   same org): `INSERT INTO workflow_runs … ON CONFLICT
   (workflow_id, trigger_source, trigger_event_id) DO NOTHING`. Only when
   the insert lands is a `workflow-run` job enqueued (dedupe key
   `workflow-run:<run id>`), in the same transaction. **The unique
   constraint is the exactly-once backbone**: overlap re-scans, duplicate
   webhook applications upstream, and concurrent sweeps all collapse into
   one run per (workflow, trigger event).
4. Advances the cursor to the max `created_at` seen and re-enqueues itself
   (`WORKFLOW_FANOUT_INTERVAL_MS`, default 5 s, time-bucketed dedupe key).
   The worker process seeds the first sweep at boot.

The hourly `workflow-time-sweep` job (scheduled by the worker process with
an hour-bucketed dedupe key, like the cost sweep) evaluates
`no_contact_for_days` workflows and inserts runs through the same unique
key.

## 4. Run lifecycle

```
workflow_runs: workflow_id, org_id, trigger_source, trigger_event_id,
               lead_id (resolved at fan-out where the source knows it),
               status pending → running → succeeded | failed | skipped,
                      running ⇄ waiting (wait action / quiet-hours deferral),
                      any active state → stopped (exit rule, unenroll, archive),
               matched boolean, skip_reason, action_results jsonb,
               current_action_index, resume_at, stopped_reason,   -- sequences
               error, started_at, finished_at
UNIQUE (workflow_id, trigger_source, trigger_event_id)
```

`waiting` and `stopped` exist for sequences (docs/sequences.md §3, §5); an
event workflow never enters them unless it carries a `wait` action or
`exit_rules`, which the same engine honours identically.

The `workflow-run` job handler:

1. Loads the run; `succeeded`/`skipped` → idempotent no-op return.
2. Marks `running`, stamps `started_at` (first write wins).
3. Builds the flattened condition/action context (§5) from the trigger
   reference: call + lead + contact + disposition + message, whichever
   apply. A referenced object that has vanished → run `failed` with a clear
   error.
4. **Rate caps (before any action executes):**
   - per-lead: count of runs for (workflow, lead) today (UTC day) with
     `matched = true` and status `running|succeeded|failed` ≥
     `max_runs_per_lead_per_day` → status `skipped`,
     `skip_reason='rate_cap_lead_daily'`.
   - per-workflow: same count without the lead filter ≥
     `max_runs_per_day` → `skipped`, `skip_reason='rate_cap_workflow_daily'`.
   Skipped-by-cap runs are visible in run history with their reason. Runs
   whose conditions did not match do **not** consume cap budget.
5. **Conditions** are evaluated by the pure `evaluateConditions` in
   `packages/core` (§5). Not matched → status `skipped`,
   `matched=false`, `skip_reason='conditions_not_matched'`. An evaluation
   error (unknown field / unknown op / type mismatch) → status `failed`
   with the evaluator's message; the job completes normally (no pointless
   retries of a deterministic config error).
6. **Actions** run in order. After each action completes, its result is
   persisted into `action_results` (write-through), so a retry of the job
   **never re-executes an action that already has a terminal result** —
   this is the "recorded completion" idempotency mechanism. Results:
   `succeeded`, `skipped_suppressed`, `skipped_quiet_hours`,
   `skipped_no_lead`, `failed` (+ per-type detail: `message_id`,
   `task_id`, `delivery_count`, …).
7. A **deterministic** action error (unknown type, bad config, missing
   template) → run `failed` immediately, job completes (no retry). A
   **transient** error (DB/provider) → the failure is recorded and the job
   throws → the queue's standard backoff/retry; on the final attempt the run
   is marked `failed`. Between retries the run stays `running` (documented:
   `running` means "an attempt is in flight or awaiting retry").
8. Terminal states stamp `finished_at`.

## 5. Condition DSL

Pure, I/O-free, unit-tested in `packages/core/src/workflows.ts`:

```jsonc
{ "all": [                      // AND  (or "any": OR); nestable, depth ≤ 10
  { "field": "call.direction", "op": "eq",       "value": "inbound" },
  { "any": [
    { "field": "disposition.slug", "op": "in",   "value": ["follow_up", "appointment"] },
    { "field": "lead.status",      "op": "neq",  "value": "dead" }
  ]}
]}
```

Ops: `eq | neq | gt | lt | contains | is_null | not_null | in`.
`contains` = substring on strings / membership on arrays; `in` = value ∈
condition's array; `gt`/`lt` compare numbers numerically and strings
lexically (mixed types are an error). `null`/`{}` conditions match
everything.

The context is a flat map built per trigger; every key the trigger can know
is present (with `null` when the entity has no value). Referencing a field
the context does not define — e.g. `call.status` on a `lead.created` run —
is an **unknown field** and fails the run with a clear message, never a
crash. Field families: `event.type`, `call.*` (status, direction,
duration_seconds, from_number, to_number, failure_class, answered — boolean),
`lead.*` (status, source, assigned_user_id, external_item_id),
`contact.*` (display_name), `disposition.*` (slug, name, note),
`message.*` (body, from, to).

## 6. Action registry

| type | config | Behavior |
|---|---|---|
| `send_sms` | `{template_id}` **or** `{body}` (exactly one) | Sends to the **lead's primary phone** through the *existing* Phase 4 service entry point (`sendMessage` in `apps/server/src/services/messages.ts`) — the same function `POST /v1/messages` calls. `body` is inline text whose `{first_name} {name} {address} {city} {state} {rep_name} {company}` merge fields the engine renders before the send path (docs/sequences.md §4; an unknown field fails the run). Suppression → the service refuses → action result `skipped_suppressed`, run still **succeeds**. Quiet hours → `skipped_quiet_hours`, run succeeds. **Policy: a quiet-hours-blocked workflow SMS is skipped, not deferred** — consistent with Phase 4's "explicit refusal, never silent queueing"; the run history shows exactly what happened. *Sequence-kind* workflows are the one exception: they park the run until the window opens (docs/sequences.md §6). No lead on the run → `skipped_no_lead`. |
| `create_task` | `{title, note?, assign_to: <user uuid> \| "lead_owner", due_in_hours}` | Inserts a `tasks` row (source `workflow`), due `now + due_in_hours`. `lead_owner` resolves to the lead's `assigned_user_id`; unassigned lead + `lead_owner` → task is created unassigned (visible to managers). Structurally exactly-once: unique `(workflow_run_id, action_index)`. |
| `update_lead_status` | `{status}` | Sets `leads.status` (free-text per the existing schema). Audited as `lead.status_updated` with `actor_type='system'`, `actor_id='workflow:<id>'` — the static loop-safety marker a future lead-status trigger must exclude. Naturally idempotent. |
| `assign_lead` | `{user_id}` | Sets `leads.assigned_user_id` (explicit user only — round-robin deferred); backfills `assigned_at` first-write-wins. Audited. Naturally idempotent. |
| `emit_webhook` | `{}` | Hands off to the Phase 10 outbound-webhook machinery: for every active subscription in the org subscribed to `workflow.executed`, inserts a `webhook_deliveries` row (event id `wfrun:<run>:<action index>`, structurally exactly-once per subscription) + `webhook-deliver` job. Payload `data`: `{workflow: {id,name,trigger_type}, run: {id,trigger_source,trigger_event_id}, lead: {...} \| null}`. `workflow.executed` is appended to the public event-type vocabulary (additive). |
| `add_to_campaign` | `campaign_id` | Enrolls the triggering lead into a Phase 5 dialer campaign (wired at Wave 2 integration). Campaign must exist in the run's org (else the run fails); an archived campaign is a visible `skipped_campaign_archived`; enrollment is structurally exactly-once via `campaign_leads_uq` — an already-enrolled lead is a succeeded no-op (`attached: false`). Pinned in `workflows-dialer.test.ts`. |
| `wait` | `{minutes}` (1 – 129 600 = 90 days) | Parks the run: status `waiting`, `resume_at = now + minutes`, action result `waiting`, and a `workflow-run` job scheduled for `resume_at` **in the same transaction** (`run_at` on the job row). The resumed job flips the result to `succeeded` and continues with the next action. Nothing executes while parked; exit rules and stop requests are re-checked on wake-up (docs/sequences.md §3). |

Anything else → CRUD 400 `unknown_action_type`; at run time → `failed` run,
clear error.

## 7. Loop safety (why no trigger can be re-entered by any action)

| Trigger | Re-entry analysis |
|---|---|
| `message.received` | Feed filters `direction='inbound'`. `send_sms` creates **outbound** rows only (the Phase 4 send path cannot create inbound rows). A seller's *reply* to a workflow SMS is a genuine inbound message and legitimately triggers — that is a human acting, not a loop. |
| `call.completed` / `call.missed` | No action in the registry creates calls or call events. |
| `disposition.created` | No action writes dispositions or `call.disposition` audit rows. |
| `lead.created` | No action inserts leads. |
| `no_contact_for_days` | Self-limiting in two independent ways: (1) a workflow-sent SMS **is** message activity, so a successful send moves the lead out of the stale set; (2) the period bucket in the unique key caps firing at once per N-day period per lead per workflow even if every action is skipped. |
| future `lead.status_changed` | Does not exist this phase. **Static guard shipped now:** `update_lead_status` writes its audit row with `actor_id='workflow:<id>'`; the future trigger's feed MUST exclude workflow-actored status changes (documented here and next to the action's code). |
| `manual` (sequences) | Cannot be re-entered by anything: no feed produces it, and the unique key `('manual', lead_id)` means a lead gets **one run per sequence, ever** — a second enroll is `already_enrolled`, never a second run. |

**How `wait` interacts with these guarantees.** A parked run is still *one*
run: it keeps its unique key, and the resumed job walks the same
`action_results` ledger, so nothing already recorded executes twice. The
rate caps count `waiting` and `stopped` runs alongside `running` ones
(§4.4) — a sequence with 400 parked leads has spent 400 of its daily 500,
and a run is judged against the caps exactly once, on its first attempt;
waking up never re-judges it. A wake-up job is scheduled per
(run, `resume_at`) with a dedupe key, in the transaction that parks the run;
the hourly `workflow-time-sweep` additionally re-enqueues any run still
`waiting` more than an hour past `resume_at` (a safety net for a deleted or
dead-lettered job), and the handler is idempotent under a duplicate wake-up
(a run that is no longer `waiting`, or is early, returns without doing
anything). Waits do not change what the feed sees: a sequence SMS is an
outbound row like any other, structurally invisible to `message.received`.

On top of the structural guarantees, the per-lead (default 3/day) and
per-workflow (default 500/day) caps bound the blast radius of any
mis-configured workflow, and every capped run is visible as
`skipped / rate_cap_*` in the history.

## 8. Tasks

```
tasks: org_id, lead_id?, assigned_user_id?, title, note?, due_at?,
       status open|done|canceled, source workflow|manual,
       workflow_id?, workflow_run_id?, action_index?, created_by?,
       created_at, updated_at, completed_at
UNIQUE (workflow_run_id, action_index) where workflow_run_id is not null
INDEX (org_id, assigned_user_id, status, due_at)   -- my-open-tasks
INDEX (org_id, lead_id)
```

API: `GET /v1/tasks` (mine by default, `?lead_id=`, `?status=`, open first
then by due date), `POST /v1/tasks` (manual), `POST /v1/tasks/:id/complete`,
`POST /v1/tasks/:id/cancel`. Visibility: assignee (+ unassigned tasks) via
`tasks.read.own`; managers/admins see and act on everything via
`tasks.read.org`.

## 9. API + RBAC + audit

New permissions (additive in `packages/core/src/rbac.ts`):
`workflows.manage` (manager, admin, owner), `tasks.read.own` (rep+),
`tasks.read.org` (manager+), `tasks.write` (rep+).

- `POST /v1/workflows` · `GET /v1/workflows` (with run counts) ·
  `GET /v1/workflows/:id` · `PATCH /v1/workflows/:id` (fields +
  enable/disable) — all `workflows.manage`, full zod validation, unknown
  trigger/action/op rejected at write time.
- `GET /v1/workflows/:id/runs?limit=&cursor=` — paginated run history
  (keyset on `created_at`), newest first.
- `GET /v1/workflow-runs?limit=` — org-wide recent runs.
- Audit actions: `workflow.create`, `workflow.update`, `workflow.enable`,
  `workflow.disable`; engine-side `lead.status_updated`, `lead.assigned`
  (system actor), plus the Phase 4 `message.create` audit the send path
  already writes.

## 10. Documented assumptions

1. **Quiet-hours policy for workflow SMS is skip, not defer** (§6) — the
   action result says `skipped_quiet_hours`, the run succeeds, nothing is
   silently queued for later. Rationale: Phase 4's explicit-refusal
   principle; a deferred send hours later without human review is exactly
   the "automation becomes a spam cannon" failure mode this phase refuses.
2. **Workflow SMS attribution:** the send is executed *as* the lead's
   assigned user (else the workflow's creator) via the normal Phase 4
   service, so `created_by`, conversation assignment, `{{rep_name}}`
   template rendering, and the `message.create` audit row all behave as if
   that rep had sent it. A lead with no assignee and a workflow with no
   creator on record fails the action with a clear error (`no_acting_user`);
   attribution is never invented.
3. **Rate-cap day boundary is UTC**, not org-local. Caps are a safety
   valve, not a reporting metric; a timezone-exact day adds complexity with
   no compliance benefit. Only `matched` runs consume budget.
4. **Between queue retries a run stays `running`** (§4.7). `pending` always
   means "never attempted".
5. **Action idempotency:** `create_task` and `emit_webhook` are
   structurally exactly-once (unique keys); `update_lead_status` /
   `assign_lead` are naturally idempotent; `send_sms` relies on recorded
   completion — the result is persisted immediately after the send path
   commits, so the only duplicate window is a process crash inside that
   gap, the same at-least-once envelope every existing handler lives in.
6. **Cursor table reuse** (§3): `webhook_fanout_cursors` holds the
   workflow cursors under `workflow:*` source keys instead of a new
   identical table.
7. **No-history rule:** workflows only match source rows created at-or-after
   the workflow row itself (§2).
8. **`no_contact_for_days` counts both directions of messages and all calls
   as activity**, and requires the lead to be older than the window (§2).
9. `add_to_campaign` graduated from reserved to executable at Wave 2 integration (§6).
10. The trigger feed's fan-out latency is up to one sweep interval
    (default 5 s; hourly for the time trigger) behind the source tables.
11. **Sequences reuse the engine rather than fork it** (docs/sequences.md):
    `kind = 'sequence'` changes only three behaviours — quiet hours defer
    instead of skip, a suppressed lead stops the run instead of walking on,
    and a disabled sequence pauses parked runs instead of dropping them. An
    event workflow's behaviour is unchanged.
