# Talkr Coach Setup

How to stand up the Coach (`apps/api` + `apps/extension/talkr-coach`) from scratch.

## Prerequisites

- A Supabase project (any region) with the `vector` extension. Apply the files in
  `supabase/migrations/` in order: schema (tables, enums, RLS) and the
  `match_patterns` + `match_playbook` RPCs.
- API keys for Deepgram, Voyage and Anthropic.
- Copy `apps/api/.env.example` to `apps/api/.env.local` and fill it in.

| Where | What | How |
|---|---|---|
| Supabase | `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` | Dashboard -> Project Settings -> API. The service role key is server-side only; never ship it to the extension. |
| Dialer (optional) | `SMRTPHONE_API_KEY`, `SMRTPHONE_WEBHOOK_SIGNING_SECRET` | Only if you ingest recordings from a smrtPhone account. |
| Podio (optional) | `PODIO_CLIENT_ID`, `PODIO_CLIENT_SECRET`, `PODIO_API_TOKEN`, `PODIO_DEALS_APP_ID` | podio.com/settings/api for client credentials. The app ID is in the URL of your deals app. |

## Process a single recording locally (offline pipeline end-to-end)

Once you have a Supabase service role key in `.env.local`, drop any call MP3
into `recordings/` (gitignored) and run the full pipeline against it:

```bash
cd apps/api
npm install
npm run process -- \
  --file ../../recordings/some-deal.mp3 \
  --outcome contract \
  --agent "Alex" \
  --phone "+15555550000" \
  --deal-value 42000
```

What runs (sequential, ~30-90 seconds total per call):
1. Upload audio to Supabase Storage (`recordings` bucket).
2. Insert `calls` + `outcomes` rows.
3. Deepgram batch transcription (with diarization, or `--multichannel` for 2-ch).
4. Opus 4.6 pattern extraction + Voyage-3 embeddings -> `patterns` table.
5. Opus 4.6 call review (rep score + seller bucket + linguistic observations) -> `call_reviews`.

Run this over your own past recordings to bootstrap the knowledge base. After
30 or so processed calls, live retrieval has real material to work with.

Required outcome values: `contract`, `callback`, `dead`, `voicemail`,
`unqualified`, `in_progress`, `dnc`, `wrong_number`.

## Live coach

The live suggest endpoint and Chrome extension overlay:
- Backend: `apps/api/api/suggest.ts` (SSE streaming Haiku 4.5 + Voyage retrieval)
- Backend: `apps/api/api/deepgram-token.ts` (mints 60s temp keys for the extension)
- Backend: `apps/api/api/session.ts` (live_sessions start/end)
- Extension: `apps/extension/talkr-coach/` (MV3, tab+mic capture, Deepgram WebSocket, overlay)

**To run the live system locally:**

1. Start the backend:
   ```
   cd apps/api
   vercel dev
   # or: npx vercel dev (boots on http://localhost:3000)
   ```
2. Load the extension at `brave://extensions` -> Developer mode -> Load unpacked -> `apps/extension/talkr-coach`.
3. Open the extension popup, expand Settings, paste:
   - API base: `http://localhost:3000`
   - Talkr API key: value of `TALKR_API_KEY` from `apps/api/.env.local`
   - Agent ID: any consistent uuid for now
4. Save settings, then click Start session.
5. Open your web dialer, take a test call, watch the overlay.

See `apps/extension/talkr-coach/README.md` for the full install + use walkthrough.

## Spike A (audio capture check)

`apps/extension/spike-a` records the dialer tab and the microphone to two WAV
files so you can see which call legs your dialer's tab audio carries. That
decides between Deepgram diarization (single channel) and multichannel mode.
Steps are in `apps/extension/spike-a/README.md`.

## Verify the schema landed

In the Supabase SQL editor, paste:

```sql
select table_name from information_schema.tables
where table_schema = 'public' order by table_name;
```

Should return: `agent_profiles`, `call_reviews`, `calls`, `live_sessions`, `live_suggestions`, `outcomes`, `patterns`, `playbook_chunks`, `transcripts`.

Then verify the RPCs and view:

```sql
select proname from pg_proc where proname in ('match_patterns','match_playbook');
select count(*) from agent_scoreboard;
```

Both should succeed.

## Call review

After every call, Claude reviews the transcript and writes a row to `call_reviews` with:
- Rep score per dimension (rapport, discovery, anchoring, objection_handling, close_attempt, confidence, listening) plus a weighted overall.
- Seller bucket: `hot` / `warm` / `cold` / `dead` / `wrong_number` / `unqualified`, with a confidence and rationale.
- Linguistic observations: sarcasm, analogies, mannerisms, evasions, subtle buying signals, red flags.
- Specific strengths and gaps with verbatim quotes.
- A concrete recommended next action.

Per-agent rollup query:
```sql
select * from agent_scoreboard order by avg_overall_score desc;
```

**Bucket framework (Price x Motivation 2x2):**
- `motivated_priced_right` — lock it up
- `motivated_priced_high` — navigate (most common, where money is made)
- `unmotivated_priced_right` — dig deeper (hidden motivation, <1%)
- `unmotivated_priced_high` — walk away
- `wrong_number`, `unqualified`, `unknown` — pre-bucket states

Buckets are an enum in the schema. Adding a bucket requires a migration (`alter type seller_bucket add value 'new_bucket';`). Scoring dimensions live in the prompt (`prompts/review_call.system.md`) and are stored as jsonb in `rep_dimensions`. Adding/renaming dimensions only requires editing the prompt and updating the `agent_scoreboard` view.

## Layout

```
supabase/migrations/   Coach schema + RPCs
prompts/               system + user prompt templates
playbook/              your own scripts and rebuttals (raw/ is read by the chunker)
apps/api/              Coach backend (Vercel functions + scripts + workers)
apps/extension/
  spike-a/             tab + mic WAV capture check
  talkr-coach/         live coaching overlay (MV3)
docs/                  this folder
```
