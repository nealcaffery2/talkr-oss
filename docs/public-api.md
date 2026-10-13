# Talkr Platform — Public API, Outbound Webhooks & MCP Server (Phase 10)

**Status:** living document; matches `apps/server/src/public-api/*`, `apps/server/src/worker/webhook-fanout.ts`, and the `api_keys` / `webhook_subscriptions` / `webhook_deliveries` tables. The public API is a thin, stable, versioned surface over the existing service layer — it wraps, it does not reimplement, and it never changes internal behavior.

---

## 1. Authentication: API keys

### Key format & lifecycle

- Format: `tk_live_<43 base62 chars>` (32 bytes of `crypto.randomBytes`, base62-encoded). Example: `tk_live_hV8…` (51 chars total).
- **Shown exactly once** in the response that creates it. We store only:
  - `key_hash` — SHA-256 hex of the full key string (unique, the lookup column),
  - `key_prefix` — the first 8 characters of the random segment, for display as `tk_live_<prefix>…` in admin UIs.
- The full key never appears in logs, audit rows, or any response after creation (pino redaction covers `*.token`/`*.secret` paths; the code never places the key on a loggable object).
- Keys are org-scoped and scope-scoped (see §2), carry `created_by`, `last_used_at`, `revoked_at`.
- **Revocation** is a soft delete: `revoked_at` set; the row is kept for audit. A revoked key gets 401 immediately.
- `last_used_at` is stamped **throttled** — at most once per 60s per key (in-memory throttle) — so the hot path does one indexed SELECT, not a write per request.

### Request auth (`/api/v1/*` and `/mcp`)

```
Authorization: Bearer tk_live_…
```

SHA-256 of the presented token → `api_keys.key_hash` lookup → attach `{keyId, orgId, scopes}` to the request. Unknown, malformed, or revoked keys → `401 {error:{code:"unauthenticated"}}`. Every authenticated request that passes the rate limit writes an `audit_log` row (`actor_type='api_key'`, `actor_id=<key id>`, `action='api.request'`, metadata: method + path — never the key, never query strings). Rate-limited (429) requests are deliberately not audited so a hammering client cannot grow the audit table unboundedly.

### Management (existing JWT-authed `/v1` surface, `admin.integrations` permission)

| Endpoint | Effect |
|---|---|
| `POST /v1/admin/api-keys {name, scopes[]}` | mint key; returns `secret` once + metadata; audit `api_key.create` |
| `GET /v1/admin/api-keys` | list (prefix, scopes, last_used_at, revoked_at — never hash or secret) |
| `POST /v1/admin/api-keys/:id/revoke` | set `revoked_at`; audit `api_key.revoke` |
| `POST /v1/admin/webhook-subscriptions {url, event_types[]}` | create; returns `signing_secret` once; audit |
| `GET /v1/admin/webhook-subscriptions` | list (no secret) |
| `PATCH /v1/admin/webhook-subscriptions/:id` | update url/event_types/active; re-activating resets `failure_count` and clears `disabled_at`; audit |
| `DELETE /v1/admin/webhook-subscriptions/:id` | hard delete (deliveries cascade); audit |
| `GET /v1/admin/webhook-deliveries?subscription_id=&state=` | delivery log |
| `POST /v1/admin/webhook-deliveries/:id/redeliver` | re-enqueue a delivery (any state); audit `webhook_delivery.redeliver` |

## 2. Scopes

Scopes are strings stored on the key (`jsonb` array). A key without the route's scope gets `403 {error:{code:"missing_scope"}}` (the required scope is named in the message). Current vocabulary:

| Scope | Grants |
|---|---|
| `calls:read` | `GET /api/v1/calls`, `GET /api/v1/calls/:id`, `GET /api/v1/dispositions` |
| `calls:write` | `POST /api/v1/calls` (click-to-call) |
| `leads:read` | `GET /api/v1/leads`, `GET /api/v1/leads/:id`, `GET /api/v1/lookup/phone` |
| `leads:write` | `POST /api/v1/leads` |
| `numbers:read` | `GET /api/v1/numbers` |
| `users:read` | `GET /api/v1/users` |
| `webhooks:manage` | reserved — webhook subscription management is JWT-only today; this scope exists so key-authed management can be added without a new vocabulary |

MCP tools enforce the same scopes as their REST equivalents (§6).

## 3. Rate limiting

Fixed-window counter per key id: `API_RATE_LIMIT_PER_MINUTE` requests (default **120**) per `API_RATE_WINDOW_MS` window (default **60 000 ms**). Over-limit → `429 {error:{code:"rate_limited"}}` with `Retry-After: <seconds until window reset>`.

The limiter is an in-memory `Map` behind a small interface (`ApiRateLimiter` in `rate-limit.ts`). **Documented limitation:** a multi-instance deployment enforces the limit per process, so the effective org-wide limit is `N × limit`. When we scale past one API instance, a shared-store implementation (Postgres or Redis) slots in behind the same interface; nothing else changes.

## 4. Conventions

- **Versioning:** everything lives under `/api/v1/`. Breaking changes get `/api/v2/`; `v1` shapes are append-only.
- **Error envelope** (every non-2xx): `{"error": {"code": "<machine_code>", "message": "<human text>"}}`. Codes in use: `unauthenticated`, `missing_scope`, `rate_limited`, `invalid_request`, `not_found`, `suppressed`, `invalid_number`, `no_caller_id`, `invalid_disposition`, `internal_error`.
- **Pagination:** cursor-based. `?limit=` (default 25, max 100) and `?cursor=`. Responses: `{"data":[…], "next_cursor": "<opaque>" | null}`. The cursor is base64url of `(created_at, id)` — keyset pagination, stable under concurrent inserts (new rows appear on page 1, never shift later pages).
- **Org scoping:** every query is scoped to the key's org. Cross-org ids are indistinguishable from missing ids (404).
- Timestamps are ISO-8601 UTC; phone numbers are E.164.

## 5. Endpoint reference (`/api/v1`)

| Endpoint | Scope | Notes |
|---|---|---|
| `GET /calls` | `calls:read` | filters: `direction`, `status`, `user_id`, `from`, `to` (ISO dates on `created_at`); paginated |
| `GET /calls/:id` | `calls:read` | includes `events[]` (the canonical `call_events` timeline) + `recordings[]` summary |
| `POST /calls` | `calls:write` | body `{user_id, to_number \| lead_id \| contact_id}`. Goes through `createOutboundCall` — the same service the UI uses: suppression enforced (`422 suppressed`), caller-id selection, audit (`call.create`). `user_id` names the rep the call is placed for (must be an active user in the key's org) — machine keys act *for* a rep because caller-id selection and attribution are per-user. |
| `GET /leads` | `leads:read` | filter `status`; paginated |
| `GET /leads/:id` | `leads:read` | includes primary contact + phones + property |
| `POST /leads` | `leads:write` | `{contact_name, phone, source?, address?, city?, state?, postal_code?, external_item_id?}` — creates contact + phone (+ property) + lead in one transaction, audited (same pattern as the internal `/v1/leads`) |
| `GET /lookup/phone?number=` | `leads:read` | E.164-normalizing caller lookup (contact → lead → property), same logic as internal lookup |
| `GET /dispositions` | `calls:read` | dispositioned calls; filters `call_id`, `from`, `to` (on wrap-up time) |
| `GET /numbers` | `numbers:read` | org phone numbers (id, e164, status, label, capabilities, assignment) |
| `GET /users` | `users:read` | **id / display_name / role only** |

**Reserved (Phase 4, not built here):** `POST /api/v1/messages`, `GET /api/v1/messages`, `GET /api/v1/threads` — SMS endpoints will land with the messaging phase and follow these same conventions. Nothing in Phase 10 depends on Phase 4 code.

## 6. MCP server (`POST /mcp`)

Talkr is exposed as MCP tools over the official streamable-HTTP transport (`@modelcontextprotocol/sdk`, stateless mode, JSON responses) mounted in Fastify at `/mcp`. Auth: the same `Authorization: Bearer tk_live_…` keys, same 401 behavior, same per-request audit; each tool enforces the same scope as its REST twin — a missing scope returns a tool-level error (`isError: true`), not a protocol error. `GET/DELETE /mcp` return 405 (stateless server: no server-push stream, no sessions).

| Tool | Scope | Mirrors |
|---|---|---|
| `list_calls` | `calls:read` | `GET /calls` (same filters + cursor) |
| `get_call` | `calls:read` | `GET /calls/:id` (with event timeline) |
| `start_call` | `calls:write` | `POST /calls` |
| `lookup_phone` | `leads:read` | `GET /lookup/phone` |
| `list_leads` | `leads:read` | `GET /leads` |
| `get_lead` | `leads:read` | `GET /leads/:id` |
| `create_lead` | `leads:write` | `POST /leads` |
| `list_dispositions` | `calls:read` | `GET /dispositions` |

Tool results are `content: [{type:"text", text:<JSON>}]` carrying exactly the REST response body, so the two surfaces cannot drift.

## 7. Outbound webhooks

### Subscriptions

`webhook_subscriptions`: org, target `url` (http/https), `signing_secret` (generated `whsec_<48 hex>`, returned once at creation), `event_types` (jsonb array — must be a subset of §7.2), `active`, `failure_count`, `disabled_at`, `created_by`.

### Event types emitted

Chosen from the **real canonical vocabulary** (`packages/core/src/events.ts` / the append-only `call_events` log) — no invented names:

| Webhook `type` | Source | Meaning |
|---|---|---|
| `call.completed` | `call_events` | call ended normally |
| `call.no_answer` | `call_events` | destination never answered (the "missed call" event) |
| `call.busy` | `call_events` | destination busy |
| `call.failed` | `call_events` | carrier/platform failure |
| `call.canceled` | `call_events` | canceled before answer |
| `recording.completed` | `call_events` | recording media ready ("recording ready") |
| `disposition.created` | `audit_log` (`action='call.disposition'`) | a rep wrapped up a call |

`disposition.created` is not a canonical telephony event (dispositions are human wrap-up, not provider events), so it is sourced from the append-only audit trail the disposition service already writes transactionally — same event-sourced discipline, no service edits.

### Emission (decoupled fan-out — `apply-events.ts` untouched)

A `webhook-fanout` worker job **tails the two append-only sources** on a cursor:

1. Reads `webhook_fanout_cursors` (`source` → `cursor_at`; first run initializes to `now − overlap`).
2. Scans rows with `created_at > cursor − overlap` (overlap = 5 min re-scan window, so rows committed late by long transactions are never missed).
3. For each row of an emitted type × each **active** subscription in the same org whose `event_types` contains it (and whose `created_at` precedes the event's — new subscriptions do not receive history): `INSERT INTO webhook_deliveries … ON CONFLICT (subscription_id, event_id) DO NOTHING`. Only when the insert lands is a `webhook-deliver` job enqueued (dedupe key `webhook-deliver:<delivery id>`), in the same transaction.
4. Advances the cursor to the max `created_at` seen and re-enqueues itself for `now + WEBHOOK_FANOUT_INTERVAL_MS` (default 5 s; time-bucketed dedupe key). The worker process seeds the first sweep at boot.

The unique `(subscription_id, event_id)` constraint makes fan-out **exactly-once per (subscription, event)** no matter how often the sweep re-scans, and duplicate application of the same canonical fact upstream cannot double-deliver (the `call_events` dedupe guard already collapsed it to one row).

### Delivery contract

`POST <subscription.url>` with body:

```json
{ "id": "<event id>", "type": "call.completed", "occurredAt": "2026-08-25T17:03:11.000Z", "data": { … } }
```

- `id` is stable across retries and redeliveries — consumers dedupe on it.
- `data` for `call.*`: the public call resource (§5 shape; inbound calls carry `routing: {reason, last_contact}` — docs/inbound-routing.md §10). For `recording.completed`: `{call_id, recording:{id,status,duration_seconds,channels}}`. For `disposition.created`: `{call_id, disposition, note, follow_up_at, user_id}`.
- Headers:
  - `X-Talkr-Event: <type>`
  - `X-Talkr-Delivery: <delivery id>`
  - `X-Talkr-Signature: t=<unix seconds>,v1=<hex HMAC-SHA256 over "t" + "." + raw body, keyed by the subscription's signing secret>`
- **Verification (consumer side):** recompute `HMAC-SHA256(secret, t + "." + body)`, constant-time compare with `v1`, reject if `|now − t| > 5 min` (replay protection).

### Retry / dead-letter / auto-disable

Deliveries ride the existing Postgres job queue: HTTP 2xx = delivered; anything else (or timeout, `WEBHOOK_DELIVERY_TIMEOUT_MS`, default 10 s) throws → the queue retries with its standard backoff (`min(base·2^attempts, 1h)` + jitter) up to 8 attempts, then the job dead-letters and the delivery row is marked `state='dead'`.

- A successful delivery resets the subscription's `failure_count` to 0.
- Each delivery that exhausts its retry budget increments `failure_count`. When it reaches **`WEBHOOK_AUTO_DISABLE_AFTER` (default 3) consecutive dead deliveries**, the subscription is set `active=false`, `disabled_at=now()`, and an audit row `webhook_subscription.auto_disabled` is written. Pending deliveries to a disabled subscription are marked failed without being sent.
- Re-enable via `PATCH … {active:true}` (resets the counter) and re-send what was missed with the redeliver endpoint.

`webhook_deliveries` states: `pending → delivered | failed (retrying or terminal-skip) | dead`.

## 8. Documented assumptions & limitations

1. **Signing secrets are stored plaintext** in `webhook_subscriptions.signing_secret` (they must be recoverable to sign). App-layer AES-256-GCM encryption (the `crm_connections` pattern from docs/security.md §4) is the hardening step once `SECRET_ENCRYPTION_KEY` is wired into server config; secrets are never logged (pino redaction) and never returned after creation.
2. **Rate limiting is per-process** (§3); multi-instance deployment multiplies the effective limit until a shared store lands behind the same interface.
3. **`last_used_at` is approximate** (≤ 60 s stale, lost on process restart before the next stamp) — it is a display/hygiene field, not an audit field; the audit log is the per-request record.
4. **Fan-out latency** is up to one sweep interval (default 5 s) behind event application; ordering across event types is by `created_at`, and consumers must treat deliveries as unordered + at-least-once (dedupe by `id`).
5. **First sweep / new subscriptions:** the first sweep after boot looks back one overlap window (5 min); a subscription only receives events recorded at-or-after its creation time.
6. **`disposition.created` payload is built at fan-out time** from the call row, so a re-disposition within the fan-out window reflects the latest values; each wrap-up action still produces its own event (one audit row each).
7. **Fan-out throughput:** each sweep processes up to 500 rows per source; sustained higher rates simply take additional sweeps. Fine for v1 volumes; the batch size is a constant.
8. **`POST /api/v1/calls` requires `user_id`** because click-to-call is inherently per-rep (caller-id selection, attribution, browser leg). The service-level audit row is attributed to that user; the API-key audit row records which key acted.
9. **Key-prefix display:** `key_prefix` stores the first 8 chars of the random segment (after `tk_live_`) — the constant `tk_live_` prefix carries no identifying value.
10. **Journal entry:** migration ships as `0005_public_api.sql` (journal tag `0005_public_api`). The hand-written partial/expression indexes in it follow the `0001_guards.sql` precedent (not expressible in the Drizzle table DSL).
11. **SMS endpoints are reserved, not built** (§5) — Phase 4 owns them.

## Numbers and the in-call smart surface (`/v1`, user JWT)

These are session routes for the web app and partner UIs, not `tk_live_` public API routes.

| Route | Permission | Purpose |
|---|---|---|
| `GET /v1/numbers` | `calls.read.own` | The org's lines with owner names (caller-ID picker, settings) |
| `GET /v1/numbers/available?area_code=210&limit=8` | `numbers.manage` | Carrier inventory; nothing reserved |
| `POST /v1/numbers` `{phone_e164, assigned_user_id?, label?}` | `numbers.manage` | Buy at the carrier with inbound voice + SMS webhooks pointed at `PUBLIC_BASE_URL`; assigning to a rep with no default caller ID makes it theirs |
| `PATCH /v1/numbers/:id` `{assigned_user_id?, label?, forward_to_e164?}` | `numbers.manage` | Reassign (moves the default caller ID with it), relabel, forward |
| `DELETE /v1/numbers/:id` | `numbers.manage` | Release at the carrier; the row stays as `released` so history keeps its number |
| `POST /v1/transcription/token` | `calls.place` | 60-second Deepgram key for the browser's live transcript (`DEEPGRAM_API_KEY` + `DEEPGRAM_PROJECT_ID`) |
| `POST /v1/calls/:id/intel` `{mode: live\|summary, turns[], context?, elapsed_seconds?}` | `calls.read.own` | Seller intelligence over the transcript so far (motivation, timeline, price expectation, objection, suggested response, next question, coaching) or the post-call card; `ANTHROPIC_API_KEY`, model `AI_SUMMARY_MODEL` |

