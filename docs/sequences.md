# Talkr Platform — Sequences (drip follow-up)

**Status:** living document; matches `packages/core/src/sequences.ts`,
`packages/core/src/workflows.ts` (manual trigger, `wait`, `exit_rules`),
`packages/db/migrations/0017_sequences.sql`,
`apps/server/src/worker/workflow-engine.ts` (pause / resume),
`apps/server/src/services/sequences.ts`, `apps/server/src/services/sequence-ai.ts`,
`apps/server/src/routes/sequences.ts`, and `apps/web/app/(app)/sequences/`.

A sequence is "text the lead, wait two days, text again, create a task on day
five, stop the moment they reply". It is the Phase 7 workflow engine
(docs/workflows.md) with three additions — a trigger that only a person can
fire, an action that pauses a run, and rules that end a run early — rather
than a second engine. Everything compliance-related is inherited: every text
goes through the Phase 4 send path with suppression and quiet hours enforced,
there is no bulk blast, and the loop-safety caps still apply.

---

## 1. Model

```
workflows (kind = 'sequence'):
  trigger_type = 'manual', trigger_config = {}, conditions = null,
  actions   = the builder's steps translated (see §2),
  exit_rules jsonb  { stop_on_reply, stop_on_statuses[], stop_on_call_answered } | null,
  description text, archived_at timestamptz (soft delete),
  enabled   = "may enroll + may continue" (see §3: disabled = paused)

workflow_runs (one per enrolled lead):
  trigger_source = 'manual', trigger_event_id = lead id,
  status  pending → running ⇄ waiting → succeeded | failed | stopped,
  current_action_index  the next action to execute (the builder shows "step 3/7"),
  resume_at             when a waiting run continues (= the resume job's run_at),
  stopped_reason        unenrolled | replied | status:<x> | call_answered |
                        suppressed | sequence_archived
UNIQUE (workflow_id, trigger_source, trigger_event_id)
  → a lead is enrolled in a given sequence at most once, ever (§2)
```

`kind` defaults to `'workflow'`, so every existing row is untouched;
`GET /v1/workflows` now filters `kind = 'workflow'` so the Workflows page does
not list sequences, and `GET /v1/sequences` lists only sequences.

### Steps ↔ actions

The builder and the API speak in **steps**; the engine runs **actions**.
Translation is pure (`stepsToActions` / `actionsToSteps` in
`packages/core/src/sequences.ts`) and happens at write time and read time,
so the stored row is an ordinary workflow the engine, run history and the
existing tests already understand.

| Step (API / builder) | Action stored |
|---|---|
| `{ type: 'sms', body }` — inline text with merge fields | `{ type: 'send_sms', body }` |
| `{ type: 'sms', template_id }` — a Phase 4 template | `{ type: 'send_sms', template_id }` |
| `{ type: 'wait', days?, hours?, minutes? }` | `{ type: 'wait', minutes }` (1 min – 90 days) |
| `{ type: 'task', title, due_in_days }` | `{ type: 'create_task', title, assign_to: 'lead_owner', due_in_hours }` |
| `{ type: 'status', status }` | `{ type: 'update_lead_status', status }` |
| `{ type: 'agent', goal, allowed[] }` (§11) | `{ type: 'ai_agent', goal, allowed }` |

Rules checked on every save (`validateSequenceSteps`): 1–20 steps, at least
one non-wait step, no trailing wait, every wait ≥ 1 minute, every inline SMS
non-empty with only known merge fields (§4). A sequence may carry up to 40
actions (`MAX_SEQUENCE_ACTIONS`); event workflows keep their limit of 10.

## 2. Endpoints

All under the existing `workflows.manage` permission (manager, admin, owner),
behind the `/v1` auth hook. Registered in `app.ts` right after the workflow
routes.

| Method + path | Body | Returns |
|---|---|---|
| `GET /v1/sequences` | — | `{ sequences: [{ id, name, description, enabled, steps, exit_rules, timeline, duration_minutes, sms_count, stats }] }` — `stats = { enrolled, active, waiting, completed, stopped, failed, replied }`; `replied` counts leads with an inbound message after enrollment whatever the exit rules say |
| `POST /v1/sequences` | `{ name, description?, steps: Step[], exit_rules?, enabled? }` | 201 `{ sequence }` · 400 `invalid_body` / `invalid_steps` |
| `GET /v1/sequences/:id` | — | `{ sequence, runs }` — the last 50 runs with `lead_name`, `phone`, `lead_status`, `status`, `step / step_count`, `resume_at`, `stopped_reason`, `action_results` |
| `PATCH /v1/sequences/:id` | any of `{ name, description, steps, exit_rules, enabled }` | `{ sequence }` · **409 `runs_active`** when `steps` would change while leads are `pending / running / waiting` (runs remember their position by action index; unenroll first) |
| `DELETE /v1/sequences/:id` | — | archive: `archived_at` set, `enabled = false`, every active run `stopped / sequence_archived`; hidden from the list, history kept |
| `POST /v1/sequences/:id/enroll` | `{ lead_ids?, contact_ids?, phones? }` (≤ 500 total) | `{ enrolled, already_enrolled, skipped, skipped_details: [{ ref, reason }] }` · 409 `sequence_disabled` |
| `POST /v1/sequences/:id/unenroll` | `{ lead_ids }` | `{ stopped }` |
| `POST /v1/ai/sequence-draft` | see §7 | `{ draft, warnings, model, usage }` · 503 `ai_not_configured` · 502 `ai_refused` / `ai_invalid_draft` / `ai_upstream` |

### Enrollment (`services/sequences.ts`)

1. `lead_ids` must belong to the org (`lead_not_found` otherwise).
2. `contact_ids` resolve to the contact's newest lead; a contact with no lead
   gets a minimal one (`source = 'sequence'`, `primary_contact_id`,
   `received_at = now()`), audited as `lead.create` — the same shape
   `POST /v1/leads` writes.
3. `phones` are normalised to E.164 (`invalid_phone`) and looked up in
   `contact_phones` for the org (`unknown_phone` — enrollment never invents a
   contact from a bare number), then treated like `contact_ids`.
4. For each distinct lead: `createRunForWorkflow` inserts the run with
   `('manual', lead_id)` and enqueues its `workflow-run` job **in the same
   transaction** — the engine's exactly-once backbone. A conflict on the
   unique key is `already_enrolled`.

Because the unique key is the identity, **a lead cannot be re-enrolled in the
same sequence** after finishing, stopping or being unenrolled (a documented
v1 limitation — re-enrollment would need a per-enrollment key). Enrollment
into a disabled sequence is refused (409) rather than queued.

## 3. Wait / resume mechanics

The `jobs` table already supports scheduling (`run_at`; `claimJobs` takes
only `run_at <= now()`), so a wait is a scheduled job, not a polling loop:

1. The action loop reaches a `wait` with no recorded result. It records
   `{ index, type: 'wait', status: 'waiting', detail: { minutes, resume_at } }`
   and, in **one transaction**, sets the run to `status = 'waiting'`,
   `resume_at = now + minutes`, `current_action_index = index + 1`, and
   enqueues `workflow-run { runId }` with `run_at = resume_at` and dedupe key
   `workflow-run:<run>:resume:<resume_at ms>`. The current job completes.
2. At `resume_at` the worker claims that job. The handler sees
   `status = 'waiting'`: if it fired more than 60 s early (clock skew, a
   replay) it returns and leaves the run parked; if the sequence is archived
   the run is `stopped / sequence_archived`; if the sequence is **disabled**
   the run stays parked and a re-check job is scheduled 15 minutes out
   (disabled = paused, not cancelled — switching the sequence back on lets
   every parked lead continue at its own next step). Otherwise the run goes
   back to `running`, `resume_at` is cleared, refs are reloaded fresh, and the
   loop resumes: the `waiting` result flips to `succeeded` (with
   `resumed_at`) and execution continues at the next action.
3. Conditions and rate caps are evaluated **once, on the first attempt**
   (`current_action_index = 0` and not resuming). A wake-up never re-judges a
   run, so a lead cannot be rate-capped or "conditions_not_matched" half-way
   through a sequence. Waiting and stopped runs do count toward the caps of
   later runs (docs/workflows.md §4.4).
4. **Safety net:** the hourly `workflow-time-sweep` re-enqueues any run still
   `waiting` more than an hour past `resume_at` (dedupe key per run per hour).
   The only way a run needs it is a deleted or dead-lettered resume job; the
   handler is idempotent under a duplicate wake-up.
5. On the serverless deployment (docs/deploy.md) jobs run from the per-minute
   `/internal/tick`, so a resume lands within a minute of `resume_at`.

The step being waited on, the wake-up time and the stop reason are all on
the run row, so the builder's run table can say "step 3/7 · continues in
1d 4h" or "stopped · replied" without reading the ledger.

## 4. Inline SMS bodies and merge fields

`send_sms` now takes **exactly one** of `template_id` (unchanged: the Phase 4
template renderer, `{{double_brace}}` variables) or `body`. For `body` the
engine renders single-brace merge fields (`{{name}}` is accepted too) with
`renderMergeFields` and hands the send path literal text:

| Field | Value |
|---|---|
| `{first_name}` / `{name}` | first word of / the whole contact display name |
| `{address}` `{city}` `{state}` | the lead's property |
| `{rep_name}` | the acting user's display name (the lead's assignee, else the sequence's creator — docs/workflows.md assumption 2) |
| `{company}` | the organisation's name |

A missing value renders as `''`; an **unknown** field is rejected at save
time (400 `invalid_steps`) and, for a row edited by hand, fails the run with
a clear error — the same loud-failure rule as `renderTemplate`.

Suppression and quiet hours are unchanged: `sendMessage` enforces both, with
no bypass. The results are recorded per action, never as run failures.

## 5. Exit rules

`exit_rules` (zod `exitRulesSchema`, nullable) are evaluated by the engine
**before every action**, including the first and every post-wait one, on
freshly read data:

| Rule | Stops the run when | `stopped_reason` |
|---|---|---|
| `stop_on_reply` | an `inbound` message exists on a conversation linked to the lead (or its primary contact) with `created_at > run.created_at` — i.e. since enrollment. Outbound rows, including everything the sequence sent, cannot match; direction is the loop guard, as in the trigger feed | `replied` |
| `stop_on_statuses` | the lead's current `status` is in the list | `status:<value>` |
| `stop_on_call_answered` | a `calls` row for the lead has `answered_at > run.created_at` | `call_answered` |

The same check re-reads the run row, so a run marked `stopped` by
`unenroll` or `DELETE` while a job is in flight ends at its next step instead
of finishing the list. Stopped runs keep their `action_results`, stay in
history and in the builder's run table with the reason.

## 6. Where sequences differ from event workflows

Only three behaviours key off `kind = 'sequence'`, all in
`workflow-engine.ts`:

1. **Quiet hours defer instead of skip.** The Phase 4 refusal is caught and,
   for a sequence, `nextSmsSendWindowStart` (new pure helper in
   `packages/core/src/messaging.ts`) computes the next allowed minute in the
   org's zone; the run parks exactly like a wait (`deferred_quiet_hours`
   result, `current_action_index` stays on the SMS) and retries the same
   step when the window opens. Bounded: after three deferrals the step is
   `skipped_quiet_hours` like an event workflow's. Event workflows keep the
   documented skip policy (docs/workflows.md assumption 1) — a person
   enrolled the lead knowing texts would follow, which is the review a
   triggered workflow lacks.
2. **A suppressed lead stops the run** (`stopped / suppressed`) after the
   `skipped_suppressed` result is recorded, instead of walking the remaining
   steps to record more skips.
3. **Disabled means paused.** Parked runs of a disabled sequence wait (15-min
   re-checks) and continue when it is re-enabled; enrollment is refused while
   disabled. Archiving is the destructive path.

Everything else — rate caps, recorded-completion idempotency, transient vs.
deterministic failure handling, the `no_acting_user` rule — is the shared
engine.

## 7. AI builder

`POST /v1/ai/sequence-draft` (`workflows.manage`):

```jsonc
{ "goal": "Re-engage sellers who said not right now on the first call",   // 10–600 chars
  "audience": "absentee owners in DFW",                                     // optional
  "tone": "friendly" | "direct" | "professional",                           // default friendly
  "channel": "sms", "steps": 4, "days": 14,                                // 2–8 texts, 1–60 days
  "company_name": "Your Company" }                                             // optional; default = org name
```

`services/sequence-ai.ts` calls the Messages API over the global `fetch`
(same shape as the call-notes summariser: `x-api-key`, `anthropic-version:
2023-06-01`, `output_config.format = { type: 'json_schema', schema }`, no
SDK in the serverless bundle). The system prompt casts the model as a
real-estate acquisitions SMS follow-up expert and states the rules the
validator enforces:

- every SMS ≤ 320 characters (prefer < 160);
- the **first** SMS identifies the sender via `{rep_name}` / `{company}` and
  ends with opt-out language ("Reply STOP to opt out");
- no misleading urgency, fake deadlines, pressure or all-caps; no price,
  offer or closing-date promises; no invented prior relationship;
- only the merge fields in §4; waits in whole days (+ hours), never two in a
  row, never last; total span within `days`; front-loaded spacing;
- optional task and status steps; `exit_rules` with `stop_on_reply` on by
  default.

Org context goes in the user message: the company name (org row, or the
override) and the caller's display name — what `{rep_name}` will render as
for them. The model answers a flat step shape (`type` + nullable per-kind
fields; one object type is more reliable under structured outputs than a
union) which `validateSequenceDraft` (pure, `packages/core/src/sequences.ts`,
unit-tested) turns into typed steps and checks: SMS count 2..`steps`, length,
merge fields, opt-out and sender identification on the first text, span ≤
`days`, plus normalisation (consecutive waits merged, trailing wait dropped —
reported as `warnings`, as is pressure language). A failing draft is sent
back to the model **once** with the errors listed; a second failure is 502
`ai_invalid_draft` with the details. `stop_reason: refusal` is 502
`ai_refused`. Token usage is logged per call
(`ai sequence draft: model call`, `ai sequence draft`) and audited as
`sequence.ai_draft`.

The result is a **draft**: the web app parks it in `sessionStorage` and opens
the builder with it loaded, flagged "Drafted by <model> — read every message
before saving". Nothing is persisted or sent until the person saves and
enrolls.

## 8. Web

- `/sequences` — list (name, texts / steps, span, enrolled / active / replied
  / done, enabled switch), **New sequence**, **Draft with AI** (goal,
  audience, tone, texts, days; a 503 `ai_not_configured` is explained in the
  modal).
- `/sequences/new` and `/sequences/[id]` — the builder: name, description,
  vertical step list with add / remove / reorder (SMS: textarea, merge-field
  chips that insert at the caret, character + segment counter, "start from a
  template" picker via `GET /v1/message-templates`; wait: days / hours; task;
  status), exit rules (checkboxes + status chips), timeline preview ("Day 0
  SMS · Day 2 SMS · Day 5 Task"), Save, the enabled switch, **Enroll leads**
  (paste phone numbers; `GET /v1/leads` has no search, so numbers are the
  picker and the server resolves them), the run table with Stop per lead, and
  Archive. Steps lock while leads are in flight (the 409 from §2, explained
  inline).
- Rail: **Sequences** next to Workflows.

## 9. Environment

| Variable | Meaning |
|---|---|
| `ANTHROPIC_API_KEY` | shared with call notes; unset → `POST /v1/ai/sequence-draft` answers 503 `ai_not_configured` and the button says so; an `agent` step fails its run with `ai_agent: ANTHROPIC_API_KEY is not set`; smart routing falls back to its deterministic rule (§12) |
| `AI_BUILDER_MODEL` | model for the builder; unset → `AI_SUMMARY_MODEL` (default `claude-sonnet-5`) |
| `AI_AGENT_MODEL` | model for agent steps and the smart router; unset → the builder model |
| `AI_SUMMARY_MODEL` | the call-notes model (docs/transcription.md); the builder's fallback |

## 11. AI agent steps

A step of type `agent` (`{ type: 'agent', goal, allowed }`, stored as the
`ai_agent` action, sequences only) hands one point of the plan to the model:
when the lead reaches it, the engine builds a brief from the lead's history
(`services/lead-history.ts`: status, source, the last texts in both
directions, calls and whether they were answered, every plan the lead has
been through and how each ended, open tasks) and asks the model what to do
right now, inside `allowed`:

| Capability | What the plan may contain | Executed as |
|---|---|---|
| `send_sms` | `sms_body`, at most 320 characters, §4 merge fields | the Phase 4 send path: suppression, quiet hours, opt-out all enforced; quiet hours park the run exactly like a written text (§6), and the parked result keeps the plan so the retry sends what was decided |
| `create_task` | `task_title`, `task_due_in_days` | a `tasks` row, exactly-once per (run, action index) like `create_task`, assigned to the lead's rep (else the acting user), the model's summary as the note |
| `update_lead_status` | `lead_status` | the same update + audit row as a `status` step, with `by: 'ai_agent'` in the metadata |

At most one of each per step; a plan with none of them is valid ("they
replied yesterday, a person should pick this up") and records as a
succeeded step that did nothing. `services/agent-step.ts` calls the
Messages API the way the builder does (structured output
`AI_AGENT_PLAN_JSON_SCHEMA`, one correction round through
`validateAgentPlan`, which also rejects any capability the step did not
allow). A refusal or a plan that cannot pass validation fails the run
deterministically; an upstream outage throws into the queue's retry, which
re-plans. The result's `detail` carries `summary`, `plan`, `model` and
`executed` (`message_id`, `task_id`, `status`), so the run table can show
what the agent did and why.

## 12. Completion routing

`on_complete` on the sequence (`{ mode, sequence_id, candidate_ids,
also_when_stopped }`, `workflows.on_complete`, migration
`0027_sequence_routing.sql`) says where a lead goes when their run ends:

| Mode | Behaviour |
|---|---|
| `none` (or null) | the lead leaves the plan |
| `fixed` | enroll in `sequence_id` |
| `smart` | the model reads the same history brief as §11 plus every candidate's name and description (`candidate_ids`, or every enabled sequence when empty) and picks one or none (`AI_ROUTING_CHOICE_JSON_SCHEMA`, `validateRoutingChoice`). Without an API key, or when the model fails, the deterministic fallback enrolls the first candidate the lead has never been through, so a plan never dead-ends on a config problem; the reason says so |

Routing runs from `workflow-engine.ts` after the run's own terminal state
is persisted (`routeAfter`), on `succeeded` always and on `stopped` only
when `also_when_stopped` is set: a lead who replied is, by default, a
person's to pick up. It never routes into the sequence that just ended, an
archived or disabled one, or one the lead already ran (§2 makes that
impossible anyway); the next run is created through `createRunForWorkflow`,
the same exactly-once path a person's enroll uses. The finished run records
`routed_run_id` and `routed_reason` (set once; a replayed job sees them and
does nothing), the audit log gets `sequence.route`, and a routing failure
is logged, never a reason to fail the run that already succeeded. `PATCH`
and `POST /v1/sequences` validate the rule (`fixed` needs a target, no
self-reference, every target must be a live sequence of the org; 400
`invalid_routing`).

No new job types: waits reuse `workflow-run` with `run_at`; the safety net
rides on the existing hourly `workflow-time-sweep`. Migration
`0017_sequences.sql` adds the columns and the partial index
`workflow_runs_resume_idx (resume_at) WHERE status = 'waiting'`; on the
Vercel deployment apply it by hand like the others (docs/deploy.md §3).

## 10. Documented assumptions

1. One run per lead per sequence, ever (§2). Re-enrollment is a v1
   non-feature, not an oversight.
2. Steps are immutable while any run is active (§2); name, description, exit
   rules and enabled are not.
3. Disabled = paused (§6). Archive is how you stop everything.
4. Exit-rule "since enrollment" means `> run.created_at`; a reply that
   arrived a minute before enrollment does not stop the run.
5. Quiet-hours deferral is capped at three per step (§6) so a window that
   can never open (misconfiguration) cannot park a run forever.
6. The AI draft's 320-character cap is the *builder's* rule; a person may
   save a longer text (the send path's 1600 limit applies) and sees the
   segment count.
7. `{rep_name}` at run time is the acting user — the lead's assignee if it
   has one — which may differ from the person who drafted the sequence; the
   draft prompt uses the drafter's name only as an example of the shape.
