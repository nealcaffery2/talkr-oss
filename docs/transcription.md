# Recordings, transcription and AI call notes

What hosted dialers sell as "AI call notes": a recording you can play in
the web app, a speaker-labelled transcript beside it, and a structured
acquisitions summary a manager reads instead of the audio.

## 1. Pipeline

```
carrier recording-status webhook (RecordingStatus=completed)
  → apply-events: recordings.status = 'completed'
      → enqueue mirror-recording   (existing; writes RECORDINGS_DIR, useless on Vercel)
      → enqueue transcribe-recording  dedupe transcribe:<recordingId>
  → worker: transcribe-recording (apps/server/src/worker/transcribe-handlers.ts)
      1. transcripts row upserted by recording_id: status processing
      2. deps.fetchRecordingMedia(recording, { format: 'mp3' })  → §2.1
      3. POST https://api.deepgram.com/v1/listen  → segments + full_text
      4. POST https://api.anthropic.com/v1/messages (if ANTHROPIC_API_KEY) → summary + ai
      5. status completed; pg_notify transcript.updated (SSE) so the page refreshes
      6. (same transaction as 5) enqueue score-call → docs/coaching.md

  every 15 min: retry-failed-transcripts (the same handler file)
      transcripts stuck at failed with a media-shaped error, retry_count < 5,
      failed within the last 7 days → back to queued + a fresh transcribe job
```

A completed transcript is also what **AI call scoring** reads: the same
transaction that marks it `completed` enqueues `score-call`, which grades the
rep against the house rubric and reads the seller. That pipeline, its table
and its endpoints are **docs/coaching.md**; nothing below is affected by it.

Everything the page shows comes from one table, `transcripts`
(`packages/db/migrations/0015_transcripts.sql`), one row per recording:

| column | meaning |
| --- | --- |
| `status` | `queued` · `processing` · `completed` · `failed` · `not_configured` |
| `segments` | `[{ start, end, speaker, text, confidence }]`, seconds, time-ordered; `speaker` is `rep` / `contact` / `unknown` |
| `full_text` | `[m:ss] Rep: …` lines — what the summary model reads |
| `summary` | 2–4 sentence narrative |
| `ai` | `{ key_points[], seller_motivation, timeline, asking_price, property_condition, objections[], next_step, sentiment, rep_talk_ratio }` |
| `model` / `ai_model` | `nova-3` or `nova-3-multichannel`; the Claude model id the API reported |
| `error` | why a `failed` row failed, or on a `completed` row why the summary is missing |
| `retry_count` | how many times the media-failure sweep has re-queued this row; bounded at 5 |

`rep_talk_ratio` (0–1) is arithmetic over the segments, not a model output.
It is **null when only one voice was identified in the whole call**, which on
a mono conference mix means diarization gave up rather than that one party
stayed silent — every utterance then lands on whichever label the first
speaker got. Reporting that as `0` was worse than reporting nothing: the card
showed a confident "Talk ratio 0" and the coaching prompt was handed "rep
spoke 0% of the talking time (measured, not estimated)", which graded the rep
for saying nothing on a call they had just run. A real `0` still comes
through when both parties were identified.

The job is idempotent: a `completed` transcript short-circuits; every other
state is redone in place. A Deepgram or media failure marks the row `failed`
and rethrows, so the queue retries with backoff (5 attempts from the manual
route, the default 8 from the webhook path) and dead-letters after that.

Dead-lettering used to be the end of the line: the row said `failed`, the job
that would have redone it was gone, and nothing re-read the table — which is
how two calls sat at `media fetch failed: 400` for a day with a transcript, a
score and AI notes all missing behind them. The **`retry-failed-transcripts`**
sweep closes that: every quarter hour (seeded by the tick and by the worker
process, deduped per bucket) it takes `failed` rows whose error is media-shaped
— `media fetch failed…`, an adapter's own download error, or "no carrier
adapter" — and puts them back to `queued` with a fresh job. `transcripts.retry_count`
bounds it at 5, so a recording the carrier really lost is tried a few times and
then left alone, and a Deepgram rejection is never retried this way at all.
Asking for a re-transcribe by hand resets the counter: a person clicking
*Retry* is usually doing so because the carrier side has just been fixed. A
Claude failure does **not** fail the job: the transcript is kept `completed`
with `ai = { rep_talk_ratio }` and `error = "summary failed: …"`, and the page
offers *Retry*.

## 2. Vendor requests

### 2.1 Recording media (the carrier half)

**The media fetch belongs to the carrier adapter, not to one shared function.**
It was one function for a while, shaped entirely like Twilio — HTTP basic auth
with the account's API key, and `.mp3` appended to whatever the webhook stored
— and when the platform moved to Telnyx that shape broke the whole pipeline:
every transcript failed `media fetch failed: 400`, so no transcript, no score,
no AI notes, and `GET /v1/recordings/:id/audio` answered 503 for every call.

What Telnyx stores in `recordings.provider_url` is not what Twilio stored:

| | Telnyx |
| --- | --- |
| what the webhook stores | a **pre-signed S3 link**, already ending in `.mp3`, valid ~10 minutes after the call |
| choosing a container | it is whatever the recording was made in |
| auth | **none** — S3 signed it for `host` alone, and an `Authorization` header makes it 400 |
| when it expires | look the recording id up again |

So `VoiceProvider.fetchRecordingMedia(ref)` is implemented per adapter, takes
both halves of the row (`provider_url` *and* `provider_recording_id`), and
returns bytes plus the content type they actually are. The Telnyx adapter uses
the stored link untouched and unsigned while its own `X-Amz-Date` +
`X-Amz-Expires` say it is still valid, and otherwise — or if it fails anyway —
mints a fresh one from the recording id, which never expires:
`GET /v2/recordings/{id}` → `download_urls.mp3|wav`, falling back to
`GET /v2/texml/Accounts/{account}/Recordings/{sid}.json` → `media_url`. Only a
`*.telnyx.com` URL is ever sent the API key.

`apps/server/src/services/recording-media.ts` picks the adapter, by the
carrier **that made the recording**. Telnyx is the only carrier now; migration 0026
relabelled recordings once stamped `provider = 'twilio'`, and any other label
falls to the Telnyx adapter.

**Deepgram** — `POST /v1/listen?model=nova-3&smart_format=true&punctuate=true&utterances=true&language=en-US`
plus `&multichannel=true` for a two-channel recording or `&diarize=true` for
mono. Headers `Authorization: Token <DEEPGRAM_API_KEY>`,
`Content-Type: audio/mpeg`; body = the MP3 bytes. Only `results.utterances`,
`results.channels[0].detected_language` and `metadata.duration` are read.

**Claude** — `POST /v1/messages`, headers `x-api-key`,
`anthropic-version: 2023-06-01`. Body: `model` = `AI_SUMMARY_MODEL`
(default `claude-sonnet-5`), `max_tokens: 16000`, a fixed system prompt that
frames the call as acquisitions rep ↔ property owner, one user
message with the call header and `full_text`, and
`output_config: { effort: 'low', format: { type: 'json_schema', schema } }`
so the reply is the notes object and nothing else (`effort` is omitted for
Haiku 4.5 / Sonnet 4.5, which reject it). The reply is validated with zod
before anything is stored; a `refusal` or `max_tokens` stop is a summary
failure. Both calls use the global `fetch` — no SDKs in the serverless bundle.

## 3. Speaker mapping (an assumption, documented on purpose)

- **Dual-channel recordings** (`recordings.channels = 2`): Deepgram returns
  one utterance stream per channel. The leg that *started* the recording is
  assumed to be on channel 0 (Twilio-compatible TeXML behaviour; see §7) —
  on our outbound `<Dial>`/`<Conference>` that is the
  rep's browser leg — so **channel 0 → `rep`, channel 1 → `contact`**. One
  function owns this (`mapDualChannelSpeakers`); flip it there if a provider
  orders channels differently.
- **Mono recordings** (conference mixes are mono): Deepgram diarization
  numbers voices in order of first appearance, so the label hangs on *who
  speaks first*. On an **outbound** call that is the owner picking up
  ("Hello?") → first voice = `contact`; on an **inbound** call the rep answers
  → first voice = `rep`. The second voice is the other party; a third voice
  (spouse, voicemail greeting) is left `unknown` rather than guessed
  (`mapMonoSpeakers`). The summary prompt is told the labels can be swapped
  and to use content to tell who is who.

Neither rule has been checked against a real Talkr recording yet — see §7.

## 4. Environment

| variable | required | notes |
| --- | --- | --- |
| `DEEPGRAM_API_KEY` | no | Without it the job writes `status = not_configured` and the page says so. |
| `ANTHROPIC_API_KEY` | no | Without it transcripts still complete; the notes card says AI notes are not set up. |
| `AI_SUMMARY_MODEL` | no | Default `claude-sonnet-5`. Any current Messages-API model id works; structured outputs are model-agnostic. |

The recording proxy uses the carrier's own credentials — `TELNYX_API_KEY` for a
Telnyx lookup, sent only to `*.telnyx.com` — and is the same fetcher the
transcription and mirror jobs use (§2.1).

## 5. API

All under the `/v1` auth preHandler. `recordings.listen.own` sees the
caller's own calls; `recordings.listen.org` (manager and up) any call in the
org. Wrong org → 404, wrong rep → 403.

| route | permission | behaviour |
| --- | --- | --- |
| `GET /v1/recordings/:id/audio` | listen.own | Fetches the media server-side through the carrier's adapter (§2.1) and streams it back as `audio/mpeg` (or `audio/wav` when that is all the carrier holds), `cache-control: private, max-age=3600`, `content-disposition: inline`. 404 unless the recording is `completed` and has a URL or a carrier recording id; 503 `{ error: 'media_unavailable' }` when the carrier fetch fails. Writes an audit row `recording.played`. |
| `GET /v1/calls/:id/transcript` | listen.own | `{ transcript \| null, recording \| null, call: { disposition, disposition_note, follow_up_at }, configured, summary_configured }`. Picks the longest completed recording of the call. |
| `POST /v1/recordings/:id/transcribe` | listen.org | Body `{ force?: boolean }`. Resets an existing row to `queued` (including a `failed` one, and clearing its `retry_count`) and enqueues the job; 202 `{ status: 'queued' \| 'not_configured' }`. A `completed` row is left alone unless `force`. 409 `recording_not_ready` while the carrier is still processing. |

The manual route cannot reuse the automatic dedupe key (`jobs.dedupe_key` is
unique for the life of the table), so it uses `transcribe:<id>:m<minute>`,
which still collapses a double click into one job.

## 6. Web

`/calls/:id` (`apps/web/app/(app)/calls/[id]/page.tsx`), linked from the play
button on Call history. The `<audio>` element cannot send a bearer header, so
the page fetches the MP3 through the authenticated client as a Blob, plays it
from an object URL and revokes the URL on unmount. Clicking a transcript line
seeks the audio; the playing line is highlighted and kept in view. While a
transcript is `queued`/`processing` the page polls every 5 s for up to
3 minutes and also refreshes on the `transcript.updated` SSE event. Managers
get *Transcribe now* when no transcript exists, *Retry* on a failure and
*Regenerate* (force) on a finished one.

## 7. Not verified without keys and a live account

- Real Deepgram and Anthropic responses (request shapes follow the vendors'
  current docs; the response parsing is defensive but untested end to end).
- The channel order in §3 — check the first dual-channel transcript by ear.
- Telnyx's `download_urls` shape is mirrored from its current API reference;
  the TeXML `media_url` fallback behind it exists precisely because that is
  the less-documented of the two.
- Wall time on Vercel: the worker runs inside `/internal/tick` with a 60 s
  function cap. A 30-minute call is a ~15 MB MP3 plus ~20–40 s of ASR, which
  is near that ceiling; the job simply retries on the next tick, but a
  persistently slow recording will dead-letter. A dedicated worker process
  (`npm run worker`) has no such cap.

## 8. Cost

Deepgram nova-3 prerecorded is billed per audio minute (about $0.0043/min at
list price → a 10-minute call ≈ 4–5 ¢). Claude Sonnet 5 at $2 / $10 per
million tokens: a 10-minute call is roughly 2k input tokens plus a few hundred
output tokens → well under 1 ¢; a 60-minute call under 3 ¢. Prompt caching is
not used: every transcript is unique and the fixed prefix is shorter than the
cacheable minimum. Setting `AI_SUMMARY_MODEL=claude-haiku-4-5` halves the
Claude side; setting it to `claude-opus-5` costs ~2.5× for marginally better
extraction.

## 9. Operations

- Apply `0015_transcripts.sql` and `0024_transcript_retries.sql` to
  the production database by hand and record them in `_talkr_migrations`
  (docs/deploy.md).
- A run of `media fetch failed` in the logs is a carrier-media problem, not a
  Deepgram one: check §2.1 first. The rows heal themselves within a quarter
  hour once the carrier side works again; `select status, error, retry_count
  from transcripts where status = 'failed'` is the whole picture.
- Backfill: existing recordings are not transcribed retroactively; a manager
  opens the call and clicks *Transcribe now*, or enqueue
  `transcribe-recording` rows in SQL.
- Dead-lettered jobs are visible and replayable through the existing jobs
  admin route.
