# Talkr Platform — Sales Dialers (Phase 5)

**Status:** living document. Design established 2026-08-25; matches
`packages/core/src/dialer.ts`, `packages/db/src/schema.ts` (Dialers section),
`apps/server/src/services/campaigns.ts`, `apps/server/src/services/dial-sessions.ts`,
`apps/server/src/routes/campaigns.ts`, `apps/server/src/routes/twiml-dialer.ts`,
and `apps/server/src/worker/dialer-handlers.ts`.

Phase 5 is the sales-engagement heart of the platform: campaigns of leads,
rep dial sessions that move through them, and three shipping dial modes
(power, progressive, parallel) plus a **designed-but-disabled** predictive
mode. Everything rides the existing event-sourced call pipeline — a session
call **is** a normal call, with campaign/session linkage stamped in
`calls.raw` (the `queueId` precedent), so the state machine, recordings,
reconciliation, reporting and Podio sync all work unchanged.

**Compliance is existential for dialers.** Every compliance rule below is
stated as an invariant with the test that pins it (§7). A suppressed number
is never dialed. Auto-dialing never happens outside a lead's calling window.
Attempt caps hold per day and in total. Parallel dialing tracks abandonment
against a hard ≤3% cap and drops to one line when breached. There is no
caller-ID rotation for filtering evasion, no DNC bypass, and no carrier-limit
gaming anywhere in this design — and none is planned.

---

## 1. Data model

Migration `packages/db/migrations/0008_dialers.sql` (journal tag
`0008_dialers`). Three tables, plus two
expression indexes on `calls.raw` linkage.

**campaigns** — `id, org_id, name, status ('draft'|'active'|'paused'|'archived'),
mode ('power'|'progressive'|'parallel'|'predictive'), settings jsonb,
created_by, created_at, updated_at`. Unique `(org_id, name)`.

`settings` (typed as `CampaignSettings` in core, defaults resolved by
`resolveCampaignSettings`, every value clamped there):

| Key | Default | Meaning |
|---|---|---|
| `callerIdPhoneNumberId` | — | phone_numbers row used as caller ID (falls back to the click-to-call v1 rule: rep default, else any active org number) |
| `callingWindowStart` / `callingWindowEnd` | `09:00` / `20:00` | allowed local dial window, "HH:MM"; deliberately inside the 8am–9pm TCPA telemarketing window |
| `timezonePolicy` | `lead` | `lead` = lead's timezone when known (`leads.raw.timezone`), else org timezone; `org` = always org timezone |
| `maxAttemptsPerDay` | 2 | per-lead dial attempts per org-local day (clamped 1–6) |
| `maxAttemptsTotal` | 8 | per-lead lifetime attempts in this campaign (clamped 1–30) |
| `retryBackoffHours` | 4 | base for retry scheduling (§4), clamped 1–72 |
| `parallelLines` | 2 | parallel-mode simultaneous dials, clamped 1–3 (**hard cap 3**) |
| `abandonmentCapPercent` | 3 | abandonment cap, clamped to **≤3** — cannot be configured above the FTC guidance line |
| `amdEnabled` | false | TeXML answering machine detection on REST dials (parallel mode) |
| `amdAction` | `hangup` | `hangup` or `voicemail_drop` on machine detection |
| `amdVoicemailText` | — | org-configured `<Say>` text for `voicemail_drop` |

**campaign_leads** — `id, org_id, campaign_id (fk, cascade), lead_id (fk),
status ('pending'|'in_progress'|'contacted'|'completed'|'suppressed'|'removed'),
attempts, last_attempt_at, next_attempt_at, priority, last_outcome, created_at`.
Unique `(campaign_id, lead_id)`; selection index
`(campaign_id, status, next_attempt_at, priority)`; `(lead_id)` index.

Status semantics: `pending` = dialable (respecting `next_attempt_at`);
`in_progress` = a dial is in flight; `contacted` = a human conversation was
reached (terminal for auto-dialing — follow-ups are the rep's/Phase 7's job);
`completed` = exhausted (`max_attempts`) or closed by a non-conversation
terminal disposition (e.g. wrong number); `suppressed` = the number hit the
suppression list (never dialed again by any campaign); `removed` = detached
by a manager (re-attaching flips it back to `pending`).

**dial_sessions** — `id, org_id, campaign_id, user_id, mode (snapshot of the
campaign mode at start), state ('active'|'paused'|'ended'), started_at,
ended_at, dialed_count, connected_count, abandoned_count,
current_line_limit (null until the abandonment cap trips, then 1),
meta jsonb, created_at`. **Partial unique index `dial_sessions_one_active_uq
ON (user_id) WHERE state = 'active'`** — one active session per rep, enforced
by the database, not by application hope.

Counters are **recomputed from the calls table** (never incremented) so the
cursor-tailing watcher (§5) can rescan freely without double counting:
`dialed` = calls stamped with this session; `connected` = those with
`answered_at` set that were neither abandoned nor machine-answered;
`abandoned` = those journaled abandoned.

**Session linkage on calls** rides `calls.raw` (no calls-table columns):
`raw.campaignId`, `raw.dialSessionId`, `raw.campaignLeadId`,
`raw.dialBatchId` (parallel batch uuid), `raw.dialMode`, plus outcome stamps
`raw.abandoned`, `raw.parallelWinner`, `raw.amdResult`. Two partial
expression indexes (`calls_dial_session_idx`, `calls_campaign_raw_idx`) keep
the in-flight/session/rate queries indexed.

## 2. Campaign lifecycle & RBAC

`draft → active ⇄ paused → archived`. Only `active` campaigns can host
sessions; a campaign pausing mid-session makes the next advance refuse with
`campaign_not_active` (the in-flight call finishes normally — we never yank
a live conversation).

New permissions (additive, end-of-list in `packages/core/src/rbac.ts`):

- `campaigns.manage` — create/edit/activate campaigns, attach/detach leads.
  Manager and admin.
- `campaigns.run` — list campaigns, view stats, run dial sessions. Rep and up.

API surface (`apps/server/src/routes/campaigns.ts`):

- `GET /v1/campaigns` (run) — list with per-status lead counts.
- `POST /v1/campaigns` (manage) — create; predictive mode is accepted as a
  draft but can never activate while the predictive flag is off (§6).
- `PATCH /v1/campaigns/:id` (manage) — name/mode/settings/status.
- `POST /v1/campaigns/:id/leads` (manage) — attach by explicit
  `lead_ids: []` and/or by simple `filter: {status?, source?, assigned_user_id?}`.
  `ON CONFLICT (campaign_id, lead_id)` re-attach revives `removed` rows to
  `pending`; every other existing status is left untouched.
- `DELETE /v1/campaigns/:id/leads` (manage) — detach (`status='removed'`).
- `GET /v1/campaigns/:id/stats` (run) — lead status counts, attempt totals,
  calls/answered/abandoned, current rolling abandonment rate.

## 3. Session lifecycle & the `next` path

- `POST /v1/dial-sessions {campaign_id}` (run) — validates the campaign is
  `active` **and the rep's presence is available + fresh** (same 90s math as
  routing). The partial unique index turns a second concurrent start into a
  clean 409 `session_exists`.
- `POST /v1/dial-sessions/:id/pause` / `resume` / `end` — pause blocks
  `next` and auto-advance; end stamps `ended_at`, recomputes final counters,
  and releases any `in_progress` campaign_leads whose dial already reached a
  terminal state back to `pending`.
- `GET /v1/dial-sessions/active` — the caller's active/paused session, for
  page reloads.
- `POST /v1/dial-sessions/:id/next` — **the heart.** One transaction-ish
  sequence per line (1 line for power/progressive, N for parallel):

```
1. load session (org+user scoped) — must be active, must belong to caller
2. refuse when a session call is still in flight (non-terminal)      → 409
3. load campaign — must still be active                              → 422
4. candidate query: top-25 pending campaign_leads by
   (priority DESC, next_attempt_at ASC NULLS FIRST, created_at ASC)
   with next_attempt_at ≤ now, attempts < maxAttemptsTotal
5. SELECTION-TIME COMPLIANCE (SQL + core pickNextCampaignLead):
   a. suppression: candidates whose number is suppressed (org scope
      voice|all, or campaign scope for this campaign) are marked
      status='suppressed' immediately and skipped — never dialed
   b. per-day attempt cap: today's dials counted from the calls table
      (org-local day), candidates at the cap skipped
   c. calling window: evaluated per candidate in its timezone
      (timezonePolicy §1); outside-window candidates skipped
6. nothing eligible → 200 { idle, reason } — the session goes idle with an
   explicit reason (outside_calling_window | waiting_retries | exhausted),
   never an error, never a sneaky after-hours dial
7. mark the pick in_progress (attempts+1, last_attempt_at)
8. DIAL-TIME RE-CHECK: suppression is re-queried immediately before the call
   is created, and createOutboundCall (the existing click-to-call service)
   runs its own suppression gate again. A hit marks the campaign_lead
   'suppressed' and LOOPS to the next candidate — the session moves on.
9. the call is created through the EXISTING createOutboundCall with
   additive campaign context (raw stamps + campaign caller ID); power/
   progressive: the rep's browser then connects exactly like click-to-call;
   parallel: the server REST-dials the seller (§5)
10. respond with the call + lead card (contact, phone, property, lead
    status/source) — what the rep sees before the seller answers
```

Session progress rides the existing pg NOTIFY → SSE bus as
`session.updated` events (org + user scoped); the web session panel refetches
on them.

## 4. Per-mode semantics

**Power** — the rep drives. `next` dials one lead; wrap-up (disposition)
never auto-dials; the rep presses Next again. The baseline mode; everything
else builds on it.

**Progressive** — the platform drives, one call at a time. When a session
call's disposition is saved, the wrap-up path enqueues a `campaign-advance`
job (dedupe key `campaign-advance:{callId}` — exactly once per call, no
matter how many times the disposition is re-saved). The handler applies the
disposition outcome to the campaign_lead (all modes) and, for progressive
active sessions only, places the next call server-side through the same
`next` internals, then publishes SSE; the web shows a cancelable countdown
and connects the browser leg. The advance validates session+campaign are
still active and no call is in flight (a retry of the job after the call was
created is a no-op).

**Parallel** — N simultaneous PSTN dials for one rep (N = `parallelLines`,
hard cap 3, further capped to 1 while `current_line_limit` is set). `next`
picks N distinct leads and REST-dials each (`provider.createCall`, new on the
provider interface) with `?call=<id>&leg=pstn` status callbacks and an
`answerUrl` of `/twiml/campaign-answer`. First answer wins:

- `/twiml/campaign-answer` (synchronous call-control, fast-ack discipline):
  locks the session row, checks whether the batch already has a winner.
  - **No winner + human (or AMD off):** this call claims the bridge
    (`raw.parallelWinner`), responds `<Dial answerOnBridge
    record-from-answer-dual><Client>rep</Client></Dial>`, and enqueues a
    `cancel-sibling-dials` job that calls the new
    `provider.cancelCall(providerCallId)` on every still-live sibling.
    Siblings then end `canceled` through the normal webhook pipeline —
    `canceled` is already a terminal state in `call-state.ts`; nothing new
    touches the state machine.
  - **Winner already claimed:** the seller answered and no rep can bridge —
    this is an **abandoned call**. Journaled on the call
    (`call.abandoned` event + `raw.abandoned`), counted in the session and
    the rolling abandonment rate, the campaign_lead is retry-scheduled with
    outcome `abandoned`, and the caller hears the org's abandonment message
    (identification, per FTC abandoned-call rules) before hangup.
- After every abandon the abandonment cap is evaluated (§7 invariant C4);
  a breach sets `current_line_limit = 1` and writes an audit journal entry
  (`dial_session.lines_reduced`) — the session dials one line from then on.
- Losing legs' campaign_leads are retry-scheduled by the watcher (§5) when
  their `call.canceled` terminal event lands.

Parallel advance is explicit (`next`), like power — the rep finishes wrap-up
and asks for the next batch.

**Predictive** — **designed, not shipped, disabled by config.** See §6.

### Retry scheduling & disposition outcomes (core, pure)

`computeRetrySchedule(attempts, settings, now)`:
`next_attempt_at = now + min(retryBackoffHours · 2^(attempts−1), 72h)`;
at `attempts ≥ maxAttemptsTotal` the lead goes `completed`
(`last_outcome='max_attempts'`) instead. Applied on: no-answer / busy /
failed / canceled terminal events without a conversation, abandoned calls,
and AMD machine outcomes.

`campaignOutcomeForDisposition(...)` (applied by the `campaign-advance`
handler on every dispositioned session call):

| Disposition | campaign_lead |
|---|---|
| `adds_suppression` (DNC) | `suppressed` (the suppression record itself is written by the existing disposition path) |
| `treat_as_conversation` (follow up, appointment, offer made, …) | `contacted` |
| `wrong_number` | `completed` (bad number — retrying is pointless) |
| anything else (no answer, voicemail, other) | `pending` + retry schedule, or `completed` at the attempt cap |

The watcher (§5) applies an interim outcome from the terminal call event
(answered-by-human → `contacted`, else retry-schedule) so a rep who skips
wrap-up never leaves a lead stuck `in_progress`; the disposition, when it
arrives, refines it.

## 5. Reacting to events without touching apply-events

`apply-events.ts` is frozen. The dialer reacts through the Phase 10
cursor-tailing pattern: a self-perpetuating **`dialer-watch`** job (interval
`DIALER_WATCH_INTERVAL_MS`, default 1000ms, seeded by worker-main) tails
`call_events` (source key `dialer_call_events` in the existing
`webhook_fanout_cursors` table, with the same overlap window) for
`call.answered` + terminal events on calls carrying `raw.dialSessionId`:

- terminal event → campaign_lead outcome (guarded: only rows still
  `in_progress`), session counter recompute, `session.updated` SSE;
- everything is idempotent by construction (recomputed counters, guarded
  status transitions, dedupe-keyed jobs), so the overlap rescan is free.

REST-dialed parallel calls are cancelable server-side; browser-dialed
power/progressive calls are hung up by the rep (existing softphone), so
`cancelCall` is only ever invoked on our own REST dials.

## 6. Predictive mode — designed, disabled

The pacing interface ships in `packages/core/src/dialer.ts`:

```ts
interface PacingInput  { availableReps, expectedAnswerRate, expectedWrapupSeconds,
                         abandonRate, abandonCapPercent }
interface PacingDecision { linesToDial }
type PacingStrategy = (input: PacingInput) => PacingDecision
```

The documented algorithm (`conservativePacer`) is classic answer-rate
pacing: `lines = floor(availableReps / expectedAnswerRate)` clamped by a
safety factor that shrinks toward 1.0 as the measured rolling abandonment
rate approaches the cap, so the pacer converges on progressive (1 line per
rep) whenever it is at risk of abandoning calls.

**It is OFF and stays OFF**: activating a predictive campaign (and starting
a session on one) requires `DIALER_PREDICTIVE_ENABLED=true`, which defaults
to false and is not set anywhere. This is deliberate: **tuning predictive
pacing responsibly requires real-world answer/abandon statistics that do not
exist yet.** The expectedAnswerRate/expectedWrapup inputs must come from
observed campaign history, and the abandonment guardrail must be validated
against live carrier behavior before a single predictively-paced call is
placed. Until that data exists, predictive is a documented interface and an
enum value, not a behavior. No test exercises a predictive dial because no
predictive dial can happen.

## 7. Compliance invariants (each pinned by a test)

Suppression scope for AUTO-dialing = **any unexpired suppression record on
the number** (org scope any channel, plus campaign scope for the dialing
campaign). This is deliberately stricter than manual click-to-call, which
gates on `voice|all`: a seller who just texted STOP is never auto-dialed —
machine-initiated outreach to someone who opted out of texts is exactly the
complaint generator compliance-first forbids — while a rep's own judgment
call (manual dial) remains possible since voice consent was not revoked.

| # | Invariant | Pinned by |
|---|---|---|
| C1 | A suppressed number is never selected: selection marks suppressed candidates `suppressed` and skips them. | `dialer-compliance.test.ts` "suppressed lead is never selected" + core `dialer.test.ts` selection suppression cases |
| C2 | Suppression is re-checked at dial time; a hit (e.g. DNC landing mid-session) marks the lead `suppressed`, is never dialed, and the session moves on to the next lead. | `dialer-compliance.test.ts` "mid-session suppression" + "dial-time re-check race" (test-seam injection between selection and dial) |
| C3 | No auto-dial outside the lead's calling window (lead timezone when known, else org). Outside the window `next`/advance go idle with an explicit reason. Invalid timezone data **fails closed** (no dial) — auto-dialing is machine-initiated, so a config bug must block dialing, not enable it. | `dialer-compliance.test.ts` "calling window blocks selection" + core window unit tests |
| C4 | Rolling abandonment rate (campaign scope, trailing 30 days, denominator = human-answered dials) is hard-capped at ≤3%: `abandonmentCapPercent` cannot be configured above 3, breach immediately drops the session to 1 line, journaled. The pure decision function supports recovery when the windowed rate falls back under the cap; the in-session reduction is sticky for the session's remainder (conservative). | `dialer-parallel.test.ts` "cap trip drops to 1 line" + core abandonment math tests (incl. recovery) |
| C5 | Per-lead attempt caps: per-day (org-local day) and total, enforced at selection; exhausted leads go `completed`, never redialed. | `dialer-compliance.test.ts` "attempt caps across days" + core cap tests |
| C6 | An answered call with no rep to bridge is journaled `abandoned`, counted in the session and the rolling rate, and the caller hears an identification message — never silent dead air then hangup without trace. | `dialer-parallel.test.ts` "abandonment counted" |
| C7 | Parallel line count is hard-capped at 3 regardless of configuration. | core `resolveCampaignSettings` clamp test |
| C8 | Predictive dialing cannot be activated: flag off ⇒ activation and session start refuse with `predictive_disabled`. | `dialer-session.test.ts` predictive refusal |
| C9 | One active session per rep (partial unique index — DB-enforced). | `dialer-session.test.ts` |
| C10 | No caller-ID rotation, DNC bypass, or carrier-limit evasion exists. Caller ID is one configured number per campaign (or the click-to-call default). | by construction — there is no code path to rotate |

## 8. AMD (answering machine detection)

Available on REST dials only (carrier constraint), i.e. parallel mode.
`amdEnabled` sets `MachineDetection` on `calls.create` — `Enable` for the
`hangup` action, `DetectMessageEnd` for `voicemail_drop` (so the drop lands
after the greeting/beep). Telnyx then includes `AnsweredBy` on the answerUrl
request and on status callbacks; the adapter normalizes `AnsweredBy` into
canonical call-event data (`data.answeredBy`, additive in
`packages/provider-telnyx/src/normalize.ts` + `packages/core/src/events.ts`).

On a machine (`machine_start`, `machine_end_*`, `fax`) at
`/twiml/campaign-answer`:

- `hangup`: respond `<Hangup/>`; journal `call.amd` (answeredBy + action);
  `raw.amdResult` stamped; campaign_lead outcome `machine_hangup` + retry
  schedule.
- `voicemail_drop`: respond `<Say>{amdVoicemailText}</Say><Hangup/>`;
  journal as above; campaign_lead outcome `voicemail_dropped` + retry
  schedule.

`human` (or AMD off) proceeds to the normal bridge/abandon decision.
Machine-answered calls are **excluded from the abandonment-rate denominator**
(FTC safe-harbor measures abandonment against calls answered by a person)
and from `connected_count`.

**Plainly stated:** all AMD behavior here is exercised through fixture
payloads with genuine signed webhooks against the real ingestion code, but
**live AMD accuracy is untested on real traffic**.
Telnyx's detection timing (and its `MachineDetection` parameter spelling —
telnyx-setup.md, *Still unverified*), `DetectMessageEnd` beep behavior, and false
human/machine rates must be validated on real traffic before AMD decisions
are trusted operationally.

## 9. Web

`/campaigns` (nav link added immediately after Floor): campaign list with
mode, status, lead-status progress bars and stats; create/edit (mode +
settings) for managers; a dial-session panel for reps — Start/Pause/End,
campaign name + mode, dialed/connected/abandoned counters, the current lead
card (contact, phone, property, lead status/source), explicit **Next** in
power/parallel, auto-advance countdown (cancelable — cancel pauses the
session) in progressive, all live via the existing SSE stream. A session
call is a normal call: the existing global CallBar and WrapUp drive the
in-call and disposition experience; the softphone gains one additive
`connectExisting(call)` to open the media leg for a server-created call.

## 10. Documented assumptions

1. **Calling-window default 09:00–20:00 local**, deliberately inside the
   TCPA 8am–9pm window; configurable but the *evaluation* is per-lead local
   time. Lead timezone comes from `leads.raw.timezone` (IANA name, mapped
   from the CRM) — when absent, the org timezone is used
   (`timezonePolicy: 'lead'` default). Area-code timezone inference is a
   documented later step, not silently guessed at.
2. Calling-window evaluation **fails closed** on invalid timezone data
   (contrast: SMS quiet hours fail open because a human rep is replying to
   an active conversation; auto-dialing has no human judgment in the loop).
3. "Per day" for attempt caps = the **org-local calendar day** (same
   `AT TIME ZONE` bucketing as reporting).
4. Attempts are counted **when the dial is created** (not when it connects)
   — over-counting is compliance-safe; a canceled-before-dial progressive
   call still consumes its attempt.
5. Session counters and abandonment rates are **recomputed from calls**, not
   incremented, so at-least-once processing and cursor rescans cannot drift
   them.
6. Abandonment rate window = trailing 30 days, campaign scope (FTC measures
   per campaign over 30 days); denominator = human-answered campaign calls,
   machine-answered excluded. A breach is evaluated on every abandon; the
   in-session line reduction is sticky until the session ends.
7. `contacted` is terminal for auto-dialing; follow-up work belongs to the
   rep / the Phase 7 workflow engine (not this phase's concern).
8. Parallel bridge quality: the winner's bridge (`<Dial><Client>`) means the
   seller hears ringing until the rep's browser answers. Real-world bridge
   latency and the resulting perceived-abandonment risk are untested until
   live traffic exists; the conservative default of 2 lines reflects that.
9. The `campaign-advance` enqueue in the disposition path and the additive
   `CreateCallInput` extension are the only edits to
   `apps/server/src/services/calls.ts`; `apply-events.ts`, `call-state.ts`
   and `routing.ts` are untouched.
10. Predictive stays off (§6) until real answer/abandon statistics exist.
