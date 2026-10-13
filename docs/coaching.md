# AI call scoring and coaching

What a sales manager buys a dialer for and never gets: every call graded
against the same rubric, the same way, the day it happened. Transcription
(docs/transcription.md) already turns a recording into speaker turns and a
summary. Scoring is the pass after that — it reads the finished transcript,
grades the rep on ten named categories, reads the seller through the
Price × Motivation grid, and says what to do next.

The seller read is not only read by people: `seller.motivation_score`,
`seller.bucket_confidence` and `seller.bucket` feed **contact temperature**
(docs/contacts.md §4), which is otherwise a pure activity score. That is the
one place a model's judgement changes a number a rep sorts by, so it is
capped at ±20 and weighted by the model's own confidence.

## 1. Pipeline

```
transcribe-recording completes a transcript
  → (same transaction) enqueue score-call   dedupe score:<callId>:m<minute>
  → worker: score-call (apps/server/src/worker/score-handlers.ts)
      1. call_scores row upserted by call_id: status running
      2. rep talk ratio computed from transcript.segments (arithmetic, local)
      3. POST https://api.anthropic.com/v1/messages → the score
      4. status completed; pg_notify score.updated (SSE) so the card refreshes
```

The enqueue is inside the same transaction as the write that marks the
transcript `completed`, so a finished transcript can never exist without the
job that scores it — the rule `apply-events` already applies when a recording
completes. Without `ANTHROPIC_API_KEY` nothing is enqueued and no row is ever
written; the endpoints answer `configured: false` and the UI says "not set up"
rather than "failed".

Everything the card shows comes from one table, `call_scores`
(`packages/db/migrations/0019_call_scores.sql`), **one row per call**:

| column | meaning |
| --- | --- |
| `status` | `queued` · `running` · `completed` · `failed` |
| `overall` | 0–100. The model answers 0–10 on the house scale; `overallToHundred()` multiplies once |
| `rep_talk_ratio` | 0–1, `numeric(4,3)`. Arithmetic over the transcript segments, never a model output |
| `categories` | `{ <category>: { score: 0–10 \| null, reason } }` for the ten categories below |
| `strengths` / `gaps` | `string[]`; strengths carry a verbatim quote, gaps carry what to say instead |
| `missed_opportunities` | `[{ moment, quote, instead }]` — doors the seller opened that the rep walked past |
| `next_action` | One concrete next step for the deal |
| `seller` | The Price × Motivation read-out (§3) |
| `model` | The Claude model id the API reported back |
| `error` | Why a `failed` row failed |

`call_id` is unique: re-scoring **replaces** the row rather than stacking, so
the rollup in §4 can never double-count a re-run.

The job is idempotent: a `completed` score short-circuits unless the payload
carries `force`. The automatic enqueue *does* carry it — a transcript reaching
`completed` is new evidence, so a re-transcribe replaces the standing score
rather than leaving one that was read from text that no longer exists. A model
or network failure marks the row `failed` and
rethrows, so the queue retries with backoff (5 attempts) and dead-letters
after that. A call with no completed transcript is written `failed` with that
sentence and **not** retried — a new transcript enqueues its own scoring job.

## 2. The rubric — where it comes from

Not invented here. `prompts/review_call.system.md` is the house review
prompt that `apps/api/workers/review-call.ts` has been running: seven rep
dimensions, the Price x Motivation bucket grid, the plays, and the calibration
sentence that matters most — *average reps score 5 to 6, top reps 7 to 8,
mistakes and missed opportunities 3 to 4, a 9 or 10 is rare and earned*. All
of that is carried over unchanged, which is why a 6 here means what a 6 meant
there.

Ten categories, in the order a call runs
(`packages/core/src/coaching.ts`, `COACHING_CATEGORIES`):

| category | from | what it measures |
| --- | --- | --- |
| `opener` | talk track | Intro and intent in the first thirty seconds; confirming they can sell |
| `rapport` | rubric | Tone, listening, empathy, warmth |
| `discovery` | rubric | Dug for the pain: motivation, timeline, condition |
| `qualifying` | talk track | Decision makers, occupancy, payoff, liens, agent agreements |
| `anchoring` | rubric | Set the price expectation early and showed the math |
| `objection_handling` | rubric | Education over argument |
| `close_attempt` | rubric | Asked for the deal directly |
| `confidence` | rubric | Assertive, no apology, owned the call |
| `listening` | rubric | Let the seller talk; did not talk over them |
| `next_step_control` | talk track | Left with a specific agreed next touch |

Seven are the `rep_dimensions` of the house prompt, unrenamed. Three are added
from the example talk track itself (docs/scripts.md §7 — the preset's
`opener`, `qualifying`/`timeline`/`condition` and `close` stages) for stages
the review prompt leans on but never scored.

**Null is not zero.** The rubric is explicit that a 30-second voicemail is not
scored like a 12-minute negotiation, so a category the call never reached gets
`score: null` and a reason saying so. Nulls are skipped by every average — a
discovery-only call does not drag a rep's `close_attempt` down.

`overall` is the coach's gut ("would I want this rep on my team based on this
call?"), explicitly **not** an average of the categories.

## 3. The seller read-out

The Price × Motivation grid, verbatim: `motivated_priced_right`,
`motivated_priced_high` (the most common, and where the money is made),
`unmotivated_priced_right`, `unmotivated_priced_high`, plus `wrong_number`,
`unqualified` and `unknown`. `motivation_score` and `price_alignment_score`
are scored **independently** and the bucket is derived from them, which is
what makes "every call where motivation > 7 but the rep never navigated the
price gap" a query rather than a reading exercise. Each bucket carries its
prescribed play (`lock_it_up`, `navigate`, `dig_deeper`, `walk_away`,
`verify_owner`, `drop`, `callback`), a 0–1 confidence and a quoted rationale,
alongside the situation itself: motivation, timeline, condition, price
expectation and the emotions in the seller's voice.

## 4. Vendor request

`POST /v1/messages`, headers `x-api-key` and `anthropic-version: 2023-06-01`,
over the global `fetch` — the same single-endpoint shape the call-notes
summary uses, no SDK in the serverless bundle. Body: `model` =
`AI_COACHING_MODEL` else `AI_SUMMARY_MODEL` (default `claude-sonnet-5`),
`max_tokens: 16000`, the rubric as a fixed system prompt, one user message
with the call header and the transcript's `full_text`, and
`output_config: { effort: 'medium', format: { type: 'json_schema', schema } }`.

Two deliberate differences from the summary pass:

- **`effort: 'medium'`, not `'low'`.** Extraction is routine; deciding a grade
  and a bucket is judgement. (`effort` is omitted for Haiku 4.5 / Sonnet 4.5,
  which reject the field.)
- **The talk ratio is an input, not an output.** `repTalkRatio()` measures it
  from the segments and the header hands the model the number, flagged
  "measured, not estimated", so the model comments on it instead of guessing
  it.

The reply is validated by `validateCallScore()` (@talkr/core) before anything
is stored; a `refusal` or `max_tokens` stop, a non-JSON body, or a shape
violation is a scoring failure that names the offending field. The JSON schema
handed to the model is *generated* from `COACHING_CATEGORIES`, so the category
list and the schema cannot drift apart.

## 5. API

All under the `/v1` auth preHandler. Visibility mirrors the transcript
endpoints exactly, because a score is a derivative of a transcript.

| route | permission | behaviour |
| --- | --- | --- |
| `GET /v1/calls/:id/score` | `recordings.listen.own` | `{ score \| null, configured }`. A rep sees their own calls, `recordings.listen.org` any call in the org. Wrong org → 404, wrong rep → 403. |
| `POST /v1/calls/:id/score` | `recordings.listen.org` | Body `{ force?: boolean }`. Resets an existing row to `queued` and enqueues the job; 202 `{ status: 'queued' \| 'not_configured' }`. A `completed` row is left alone unless `force`. 409 `transcript_not_ready` when the call has no completed transcript. Writes an audit row `call.score_requested`. |
| `GET /v1/coaching/summary?from&to&user_id` | `calls.read.org` | The per-rep rollup. |

No new permission was invented: queueing a re-score is the same act as
queueing a re-transcribe (`recordings.listen.org`), and the org-wide rollup
sits on the org-wide read that already exists (`calls.read.org`).

**The rollup** (`apps/server/src/services/coaching.ts`) borrows reporting's
range vocabulary — from/to as inclusive org-timezone local days, defaulting to
the last 7, capped at 366 — and dates a score by the **call**, not by when the
score was written, so "last 7 days" means the same thing on /coaching as on
/reports. It returns, for the org and for each rep: calls scored, average
`overall`, the average of every category, the three weakest categories, the
average talk ratio, and the trend against the equal-length period immediately
before the range. Each rep row also carries `example_call_id` — their
*lowest*-scoring call in the range, which is the one worth listening to.

Category averaging happens in TypeScript rather than SQL: the categories are a
jsonb blob whose keys are a code-owned vocabulary, and one org's scored calls
over at most 366 days is a few thousand small rows.

## 6. Web

**`/calls/:id`** — a coaching card under the transcript
(`apps/web/components/CoachingCard.tsx`): the overall score as one big banded
number, the talk ratio as a two-sided rep/seller bar with the 40–45 % discovery
target spelled out in words, the ten categories with their bar, score and
reason, then strengths, gaps, missed openings, the seller read-out and the
next action. The page loads and refreshes the score the same way it does the
transcript — the `score.updated` SSE event, plus 5 s polling for up to 3
minutes while a job is in flight. Because a completing transcript enqueues
scoring in the same transaction, the card stays in its "scoring…" state for the
whole chain instead of flashing "not scored yet" in between. Managers get
*Score this call* when nothing exists, *Retry* on a failure and *Re-score*
(force) on a finished one; a server with no key shows the not-configured line.

**`/coaching`** — its own page rather than a seventh section of `/reports`.
Reports answers "how much did we do"; this answers "how well". It is gated on
a different permission, and a manager coaching a rep stays on it for ten
minutes rather than glancing at a tile. Range picker, four KPI tiles (average,
trend, calls scored, weakest category), the rubric averaged across the team,
then a per-rep table: average with its colour band, trend, talk ratio, the
three weakest categories and a link straight into that rep's worst scored call.

Score bands follow the rubric's own calibration: 70+ strong, 50–69 solid,
30–49 developing, under 30 needs work.

## 7. Environment

| variable | required | notes |
| --- | --- | --- |
| `ANTHROPIC_API_KEY` | no | Without it nothing is enqueued, no row is written, and both endpoints answer `configured: false`. |
| `AI_COACHING_MODEL` | no | Default: whatever `AI_SUMMARY_MODEL` is (`claude-sonnet-5`). Set it to run the coach on a stronger model than the note-taker. |

## 8. Cost

Per scored call, on `claude-sonnet-5` ($2 / $10 per million tokens):

| part | tokens | cost |
| --- | --- | --- |
| System prompt + JSON schema | ~1,900 in | $0.004 |
| A 10-minute call's transcript | ~2,000 in | $0.004 |
| Score + thinking at `effort: medium` | ~2,500–4,000 out | $0.025–$0.040 |

**Roughly 3–5 ¢ per scored call**, dominated by output and thinking rather
than by call length — a 60-minute call adds only about a cent of input. On top
of transcription's 4–5 ¢ per 10 minutes, scoring roughly doubles the AI cost
of a call. `AI_COACHING_MODEL=claude-opus-5` costs about 2.5× for a sharper
coach; `claude-haiku-4-5` about half, and it rejects `effort` so it reasons
less about a judgement call. Prompt caching is not used: the fixed prefix
(system + schema) is close to the cacheable minimum and every transcript after
it is unique, so a cache write would cost more than it saves at this volume.

These are estimates from the token arithmetic — no live scoring call has been
made from this branch (§10).

## 9. Operations

- Apply `0019_call_scores.sql` to the production database by hand and record it in
  `_talkr_migrations` (docs/deploy.md) — the Vercel deployment does not run
  migrations at boot.
- Backfill: existing transcripts are not scored retroactively. A manager opens
  the call and clicks *Score this call*, or enqueue `score-call` rows in SQL
  (`payload: { "callId": "…" }`).
- Re-scoring after a rubric change: the row is replaced in place, so a bulk
  re-score is just an enqueue per call. Old scores are not versioned — if that
  ever matters, it needs a second table, not a second row here.
- Dead-lettered jobs are visible and replayable through the existing jobs
  admin route.

## 10. Not verified without keys and a live account

- No real Anthropic scoring call has been made. The request shape, the
  structured-output mechanism and the refusal / truncation handling are copied
  from the transcription pipeline and pinned by
  `apps/server/test/call-scoring.test.ts` against an injected `fetch`; the
  rubric's *behaviour* — whether the calibration holds, whether buckets land
  where a human coach would put them — is unmeasured.
- `0019_call_scores.sql` has not been applied to any database. Its shape
  follows `0015_transcripts.sql`; the Drizzle table beside it typechecks.
- The integration tests were not run (they need Postgres, which the machine
  this was built on lacks). No existing test drives the transcribe job, so
  none needed changing.
- The 40–45 % talk-ratio target is a coaching convention, not something
  measured against the team's own closed deals. When there are enough scored
  calls with known outcomes, check it before trusting it.
