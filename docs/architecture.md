# Talkr Platform — Architecture

Talkr has two parts that share one repository:

1. **Talkr Coach** (`apps/api` + `apps/extension/talkr-coach`) — a real-time AI coaching layer that can run on top of an existing web dialer.
2. **Talkr Platform** (`apps/server`, `apps/web`, `packages/*`) — a cloud communications and sales-engagement platform (calling, SMS, dialers, routing, reporting), with the Coach's AI stack folded in as the conversation-intelligence layer.

This document covers the Platform.

---

## 1. Core principles (non-negotiable)

1. **Our Postgres database is the source of truth.** Podio is a CRM integration; Telnyx is a carrier behind an adapter.
2. **The frontend is never authoritative about call state.** Browser state is a *view* of server state; server state is driven by provider events reconciled against provider APIs.
3. **No single webhook is trusted as the sole record.** Every inbound webhook is persisted raw before processing; important records are reconciled against provider REST APIs by background jobs.
4. **Webhook processing is idempotent.** Duplicate deliveries must never duplicate business records. Out-of-order deliveries must never regress state.
5. **Everything is traceable.** One internal correlation ID follows a communication across browser → API → provider → webhook → recording → AI → Podio.
6. **Reliability > features.** A boring call that is perfectly recorded, attributed, and reported beats a flashy feature that loses data.

## 2. System topology

```
┌─────────────────────────────┐
│  apps/web (Next.js, Vercel) │  UI: dialer, inbox, reports, admin
│  @telnyx/webrtc 2.x         │  WebRTC media goes browser ⇄ Telnyx directly
└──────────────┬──────────────┘
               │ HTTPS (JWT)  + SSE/WebSocket for realtime state
┌──────────────▼──────────────────────────────────────────┐
│  apps/server (Fastify, long-running Node host)          │
│  ├─ HTTP API        /v1/*        (auth, RBAC, audit)    │
│  ├─ Webhook ingest  /webhooks/*  (sign-check, raw       │
│  │                        persist, dedupe, fast-ack)    │
│  ├─ TeXML endpoints /twiml/*     (call control)         │
│  └─ Workers         (same codebase, separate process:   │
│        event processing, state machine, Podio sync,     │
│        reconciliation, retries, dead-letter)            │
└───────┬───────────────────────────────┬─────────────────┘
        │                               │
┌───────▼────────────┐        ┌─────────▼─────────────────┐
│ PostgreSQL         │        │ Providers (behind         │
│ (Supabase-managed  │        │ adapters in packages/*)   │
│  in prod; vanilla  │        │  • Telnyx Voice (TeXML)/  │
│  PG in tests)      │        │    SMS/Numbers/Recordings │
│  - transactional   │        │  • Podio CRM              │
│    state           │        │  • Deepgram…              │
│  - raw webhook log │        │                           │
│  - job queue + DLQ │        └───────────────────────────┘
│  - audit log       │
└────────────────────┘
```

### Why a long-running server (not Vercel serverless) for telephony

- Carrier webhooks need consistently fast acknowledgment; cold starts are unacceptable on call-control webhooks (TeXML responses block live call setup).
- Workers need durable loops, `LISTEN/NOTIFY`/polling, and later WebSocket Media Streams — all poor fits for serverless.
- The **frontend** can live on Vercel. The **server** (API + webhooks + workers) targets a long-running Node host (Railway / Fly.io / Render / a VM). One deployable image, two processes: `server` and `worker`.

### Why Postgres-backed jobs instead of Redis/BullMQ (for now)

- One durable store = one backup story, one transaction boundary. Enqueueing a job in the *same transaction* that records a webhook event eliminates a whole class of lost-work bugs.
- `FOR UPDATE SKIP LOCKED` job claiming is proven at far higher volume than our v1 needs.
- The queue is behind a small interface (`packages/db` `JobQueue`); if/when throughput demands it, BullMQ+Redis slots in behind the same interface. Redis is *not* part of the v1 critical path — one less thing to run and to fail.

### Database: Supabase-managed Postgres, vanilla-Postgres discipline

- Production uses a dedicated Supabase project (separate from the Coach's project) for managed Postgres + auth.
- The schema uses **no Supabase-only features** in the data layer. All access goes through `apps/server` with the service role; the web app talks to our API, never PostgREST. This keeps the door open to RDS/Neon/self-hosted later and lets tests run on plain Postgres 16.
- Supabase Auth issues user JWTs; `apps/server` verifies them and maps them to platform users. RLS is not the tenancy mechanism (server-side scoping is — see security.md); it can be layered on later as hardening.

## 3. Package layout (npm workspaces)

```
talkr/
  apps/
    api/               Talkr Coach backend (existing, untouched)
    extension/         Talkr Coach extension (existing, untouched)
    server/            Platform backend: Fastify API + webhooks + workers
    web/               Platform frontend: Next.js (built after server slice is solid)
  packages/
    core/              Domain types, canonical events, provider interfaces,
                       call state machine, RBAC permission map. Zero I/O deps.
    db/                Drizzle schema, SQL migrations, db client, JobQueue,
                       repositories, test harness
    provider-telnyx/   Telnyx adapter: signature validation, webhook
                       normalization → canonical events, TeXML building,
                       REST (create/fetch call, reconciliation), WebRTC credentials
  docs/                these documents
  supabase/            Coach migrations (existing, untouched)
```

Dependency direction is strict: `apps/server` → `packages/*`; `provider-telnyx` → `core`; `db` → `core`. `core` imports nothing but zod. Business logic never imports carrier types directly.

## 4. Provider abstraction

Interfaces live in `packages/core/src/providers.ts`:

- `VoiceProvider` — mint browser client tokens, create/fetch/hang up calls, build call-control responses (TeXML), normalize voice webhooks.
- `MessagingProvider` — send message, fetch message, normalize messaging webhooks (Phase 4).
- `NumberProvider` — search/purchase/release/configure numbers (Phase 3+).
- `RecordingProvider` — fetch recording metadata/media, normalize recording webhooks.
- `TranscriptionProvider` — batch + streaming transcription (Phase 8; Deepgram adapter will wrap the Coach's existing code).

Every provider object stored in our DB carries `provider` + `provider_*_id` columns next to our own UUID primary key: `calls.id` (ours) ↔ `calls.provider_call_id` (the TeXML `CallSid`). Business logic keys off our IDs only.

Webhook → canonical translation happens **inside the adapter** (`normalizeWebhook`). The worker pipeline only ever sees canonical events (see telephony-events.md).

## 5. Event architecture (summary — full detail in telephony-events.md)

Inbound webhook lifecycle:

```
POST /webhooks/telnyx/voice-status   (the legacy /webhooks/twilio/* path is still served)
  1. verify provider signature (reject 403 if invalid; still log the attempt)
  2. INSERT raw webhook_events row (headers, raw body, idempotency key)
     — duplicate key ⇒ mark skipped_duplicate, ack 200, stop
  3. enqueue process-webhook job IN THE SAME TRANSACTION
  4. respond 200/TwiML immediately (target: <100ms server time, no provider
     API calls, no CRM calls, no AI on this path)
──────────────── async worker ────────────────
  5. adapter normalizes → canonical events
  6. state machine applies events (idempotent, monotonic, out-of-order safe)
  7. append call_events, update calls/recordings/messages rows
  8. trigger follow-on jobs (Podio sync, reconciliation, realtime push)
  9. failures retry with exponential backoff → dead_letter after max attempts
```

Admin tooling (Phase 1: API endpoints; UI later): inspect failed/dead events, replay an event, re-run reconciliation, diff internal call state vs provider state.

## 6. Call flow — the Phase 2 vertical slice

Outbound browser call ("click Call" on a lead):

1. `POST /v1/calls {lead_id | contact_id | to_number}` — server checks suppression/DNC + quiet hours, selects caller ID, creates `calls` row (`status=queued`, fresh correlation ID), writes audit log, returns `{call_id, token_hint}`.
2. Browser registers with a Telnyx WebRTC login token from `POST /v1/voice/token` and asks the server to ring it (`POST /v1/calls/:id/browser-leg`); a WebRTC endpoint cannot dial the TeXML app with a call id, so the *server* opens the rep's leg (telnyx-setup.md §6).
3. Telnyx hits our TeXML App voice URL `POST /twiml/outbound-dial`. Server validates signature, loads the call, marks it `initiated`, records the rep as the room's `agent` participant, enqueues the job that dials the seller, and responds with `<Dial><Conference record="record-from-start" statusCallback=…>talkr-{callId}</Conference></Dial>`. The browser joins a **room**, not a two-leg bridge, because hold / add call / merge / transfer are all participant operations and a bridge has no third party (see [telephony-events.md §9](telephony-events.md)). `CALL_CONTROL_MODE=bridge` restores the original `<Dial><Number>`.
3b. The worker's `conference-dial-customer` job adds the seller to the room via the provider's participant API. It runs one hop later on purpose: the carrier is blocking the live call on step 3's response, and call-control paths make no provider REST calls (§1 of telephony-events.md).
4. TeXML status callbacks (parent and child leg) flow through ingestion → worker → state machine: `initiated → ringing → in_progress → completed/no_answer/busy/failed/canceled`, with `ringing_at/answered_at/ended_at` timestamps.
5. On disconnect the web app shows the wrap-up screen; `POST /v1/calls/:id/disposition` stores disposition + notes + follow-up, updates the lead, enqueues `podio.sync-call-activity`.
6. `recording-status` webhook (async, possibly late) creates/updates the `recordings` row; a fetch job mirrors media to object storage (Supabase Storage bucket) and enqueues transcription (Phase 8).
7. A reconciliation job fetches the call from the provider REST API ~2 minutes after completion and diffs duration/status/price against our record; mismatches are flagged in `reconciliation_mismatches` for the data-integrity dashboard.
8. The Podio job posts exactly **one** activity comment per call (rep, direction, duration, disposition, recording link) — never a stream of low-level events.

Inbound calls are accepted from Phase 1 onward at the ingestion layer (raw event + call row created, routed to a simple "ring the assigned user, else voicemail" TwiML) so no data is ever dropped; full routing is Phase 3.

## 7. Realtime to the browser

v1: Server-Sent Events (`GET /v1/events/stream`) pushing per-user call-state changes (call status, recording state, wrap-up trigger). SSE is trivially proxyable, reconnect-friendly (Last-Event-ID), and enough for call-state UX. Upgrade path: WebSocket fan-out or Supabase Realtime when the floor view (Phase 6) needs org-wide fan-out.

The **media** path never touches our server in v1 — WebRTC flows browser ⇄ Telnyx. Media Streams (Phase 8 live AI) will terminate on a dedicated WebSocket service, not the API server, per the "don't run media through infra that can't hold sockets" rule.

## 8. Observability

- **Structured logs** (pino, JSON): every log line carries `req_id`, and where applicable `org_id`, `user_id`, `call_id`, `webhook_event_id`, `job_id`, `correlation_id`.
- **Correlation ID**: minted at the first touch (API request or webhook), stored on `calls.correlation_id`, propagated into jobs and Podio comments (as an invisible marker), returned in API responses as `x-request-id`.
- `/health` (liveness) and `/health/deep` (DB round-trip, queue depth, provider config present).
- **Ops counters** land in the DB (`webhook_events` statuses, `jobs` statuses, `reconciliation_mismatches`) so the data-integrity dashboard is a set of queries, not a separate metrics stack. OpenTelemetry export is a documented later step, not a v1 dependency.

## 9. Technology choices & versions (verified 2026-08-25)

| Concern | Choice | Notes |
|---|---|---|
| Language | TypeScript (strict) everywhere | |
| Server | Fastify 5, Node ≥ 20 | raw-body access for signature validation |
| ORM/migrations | Drizzle ORM + drizzle-kit SQL migrations | plain SQL artifacts in repo; runs on vanilla PG 16 |
| Jobs | Postgres queue (`jobs` table, SKIP LOCKED) | interface-compatible swap to BullMQ later |
| Frontend | Next.js (App Router) + Tailwind + shadcn/ui | Phase 2 UI |
| Browser calling | `@telnyx/webrtc` 2.x | web app and Chrome extension load only this SDK |
| Server↔Telnyx | plain `fetch` inside the adapter only — no SDK | REST, WebRTC credential minting, Ed25519 signature validation |
| CRM | Podio REST v2 + webhooks | active under Progress Software; **no announced EOL, but vendor risk is real — see risks** |
| Auth | Supabase Auth JWTs verified by our server | API keys table for public API (Phase 10) |
| Carrier | `VOICE_PROVIDER=telnyx\|none` (default `telnyx`); Telnyx is the only adapter (Talkr previously also ran on Twilio) | Telnyx runs on TeXML, not the Call Control API — Call Control would require REST commands from call-control paths, breaking telephony-events.md §1. On Telnyx the *server* opens the rep's browser leg (`browserLeg = 'server'`, `POST /v1/calls/:id/browser-leg`) because a WebRTC endpoint cannot dial the TeXML app with a call id (telnyx-setup.md §6). TeXML uses Twilio-compatible field names (`CallSid`, `CallStatus`, …) |
| Transcription/AI | Deepgram + Anthropic (reuse Coach code) | Phase 8 |

## 10. Top technical risks

1. **Podio vendor risk.** Podio survived the Citrix→Progress transition and is actively maintained, but it is a niche product with an uncertain long arc. *Mitigation:* our DB is the source of truth; Podio is one `CRMConnection` implementation; the mapping layer (podio-integration.md) is CRM-agnostic by design.
2. **Webhook trust & ordering.** Voice status callbacks can arrive out of order and are delivered at-least-once. *Mitigation:* monotonic state machine + `SequenceNumber`-based idempotency keys + REST reconciliation. Tested explicitly (duplicate, out-of-order, late-recording fixtures).
3. **Serverless temptation.** Putting TeXML/webhooks on cold-start-prone infra silently degrades call setup. *Mitigation:* architecture pins telephony HTTP on a long-running host from day one.
4. **A2P 10DLC / messaging compliance lead time.** Brand + campaign registration takes days-to-weeks and gates all SMS. *Mitigation:* start registration during Phase 1–2 (ops task, not code); build suppression/consent primitives before bulk features exist.
5. **Local dev vs telephony.** Telnyx must reach the server; local dev needs a tunnel (ngrok or `cloudflared`) or a deployed dev environment. Documented in the runbook; webhook fixtures make most iteration possible fully offline.
6. **Predictive-dialer compliance (Phase 5).** Abandonment guardrails are regulatory, not optional. The dialer design carries a hard abandonment budget; we do not ship predictive until pacing + guardrails are tested.
7. **Scope gravity.** The spec is a multi-year product. Phase gates are the defense: a single perfect call must be reliable before anything else grows.

## 11. Decisions log

| # | Decision | Why |
|---|---|---|
| D1 | Monorepo via npm workspaces; Coach untouched | shared future, zero risk to shipped system |
| D2 | Long-running Fastify host for API/webhooks/workers; Vercel for web only | telephony latency + workers + future sockets |
| D3 | Postgres-backed job queue v1 | transactional enqueue, fewer moving parts |
| D4 | Drizzle ORM, migrations checked in as SQL | types + reviewable SQL |
| D5 | Canonical event model normalized inside provider adapters | business logic stays provider-free |
| D6 | Monotonic call state machine; late events recorded but never regress state | out-of-order webhook safety |
| D7 | SSE for realtime v1 | simplest thing that is reliable |
| D8 | Separate Supabase project for Platform prod; vanilla PG in tests | isolation from Coach; portability |
| D9 | One Podio activity per call, not per event | Podio is a CRM, not an event log |
| D10 | UUIDs (v4) for all internal IDs | independence from provider SIDs |
