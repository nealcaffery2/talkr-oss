# Talkr Platform — Inbound Calls & Routing (Phase 3)

**Status:** living document. Design established 2026-08-25; matches `packages/core/src/routing.ts`, `apps/server/src/routes/twiml-inbound.ts`, and the `agent_presence` schema.

Phase 3's promise, in one sentence: **when a seller calls back, the right rep's browser rings within a second, with the seller's name and property on screen before they pick up — and if nobody can take it, the seller hears a greeting and leaves a voicemail that lands on the missed-call list, never in a void.**

## 1. The routing chain (v1)

Every inbound call to a platform number walks this chain, top to bottom, taking the first step that can actually ring someone:

```
inbound call to +1614…
  1. business hours check (org settings, org timezone)
        closed  ────────────────────────────────▶ voicemail (after_hours)
  2. caller recognition: contact_phones lookup on From
        found contact → lead → assigned rep
        rep AVAILABLE ──────────────────────────▶ ring that rep's browser
  3. number's assigned user AVAILABLE ──────────▶ ring them
  4. number's assigned team: all AVAILABLE members ─▶ simultaneous ring (cap 5)
  5. number's external forward configured ──────▶ <Dial> the forward number
  6. nothing worked ────────────────────────────▶ voicemail (no_agents)

ring outcome: answered → conversation (recorded, dual-channel)
              no answer in N seconds → voicemail (no_answer)
```

The decision is computed by a **pure function** — `decideInboundRoute()` in `packages/core/src/routing.ts` — that takes plain data (number config, recognized lead, presence map, team members, business hours, now) and returns a `RoutingDecision`. No I/O, fully unit-tested, and the decision is stored on the call (`raw.routing`) plus appended as a `call.routing_decided` event so the admin Call Journey can always answer "why did it ring who it rang."

Queues and IVR menus extend this chain (§9): a number assigned to a **queue** hands the whole treatment to the queue (wait loop, strategy, overflow) — except that a recognized lead owner still wins; a number with an **IVR** fronts the chain with a digit menu. Still deferred: hold-music audio files and queue-position announcements, per-campaign numbers, manager escalation, callback-request.

## 2. Availability = presence + freshness

**`agent_presence`** — one row per user: `status ('available'|'away'|'offline')`, `last_seen_at`.

- The web app heartbeats `POST /v1/presence {status:'available'}` every 30s while the softphone is registered, and best-effort `offline` on teardown.
- A rep counts as available only if `status='available'` **and** `last_seen_at` is within 90s — a crashed browser goes silently stale and the router stops ringing it in ≤90s. No distributed presence system, no Redis; freshness math does the work.

## 3. Business hours

Org-level config in `organizations.settings`:

```jsonc
{
  "timezone": "America/New_York",
  "businessHours": { "mon": [["08:00","20:00"]], … },   // absent day = closed
  "voicemailGreeting": "Thanks for calling Your Company — leave your name and number."
}
```

- **No `businessHours` key at all = always open** (safe default for a shop that answers whenever it can).
- Evaluation (`isWithinBusinessHours`) uses `Intl.DateTimeFormat` with the org timezone — DST handled by the platform, zero dependencies, pure and unit-tested.
- After hours goes straight to voicemail. (Per-number/per-team hours and after-hours forwarding are additive later.)

## 4. Call control flow (TwiML)

`/twiml/inbound` (each number's Voice URL) now does real work, still within the fast-ack discipline — a few indexed lookups, no provider API calls:

1. validate signature → persist raw webhook (as every webhook)
2. resolve number → org; **create the call row synchronously** (idempotent on `provider_call_id`) linked to recognized contact + lead
3. compute `decideInboundRoute()`, store it, append `call.routing_decided`
4. respond:
   - **ring**: `<Dial answerOnBridge timeout=25 record="record-from-answer-dual" action="/twiml/inbound-dial-complete?call=…"><Client statusCallback…>user-uuid</Client></Dial>` — client identity is the platform user UUID, same identity the browser registered with
   - **forward**: same `<Dial>` with `<Number>` (still recorded, still status-callbacked)
   - **voicemail**: `<Say>{greeting}</Say><Record maxLength=120 recordingStatusCallback=…>` then hangup

`/twiml/inbound-dial-complete`: `DialCallStatus=completed` → hangup; anything else (no-answer/busy/failed) → the voicemail TwiML. `/twiml/voicemail-complete`: thanks + hangup; the recording arrives asynchronously through the normal recording pipeline (`RecordingSource=RecordVerb` marks it as a voicemail).

**Number configuration contract** (runbook): each platform number's Voice URL → `/twiml/inbound`, status callback → `/webhooks/telnyx/voice-status` (both set on the Telnyx TeXML app; the server moves an app still on the legacy `/webhooks/twilio/` path at boot; no query params needed — inbound events resolve by `provider_call_id` since the call row exists before the first callback can arrive).

## 5. State machine refinement: which leg drives

Phase 2's rule ("client legs don't drive outbound calls past initiated") generalizes in Phase 3:

- **The PSTN leg is always the truth leg.** Outbound: the child leg dialing the seller. Inbound: the parent leg from the caller.
- A **client leg's `answered`** drives `in_progress` in both directions (the rep picking up in the browser *is* the call being answered).
- A **client leg's terminal events never drive** the logical call while a PSTN leg exists — a rep's browser timing out while the caller flows to voicemail must not mark the call `no_answer` prematurely; the caller's leg decides how the call actually ended.
- An inbound call whose ring timed out but whose caller left a voicemail ends `completed` (the caller leg completed) with a voicemail recording attached; a caller who hung up during ringing ends `no_answer`. Reporting reads "missed call" as: inbound ∧ never `in_progress`.

## 6. Browser incoming calls

`SoftphoneProvider` handles the Device's `incoming` event: an incoming-call panel with **Accept / Decline**, ringing state in the global call bar, and seller context fetched from `GET /v1/lookup/phone?number=…` (contact, lead, property — the "know who's calling before you pick up" endpoint, also what the Chrome extension will use in Phase 9). Decline lets the routing chain proceed to voicemail via the dial timeout. Accept flows into the same in-call UI, wrap-up screen, and disposition path as outbound calls — one call experience, both directions.

## 7. What "answered" the phones when nobody answered

Voicemails are recordings with `RecordingSource=RecordVerb`, attached to their call like any recording; the calls list shows a voicemail marker and the missed-call filter is `direction=inbound, never answered`. Nothing about an unanswered call is silent: the routing decision, the ring attempt, the timeout, and the voicemail are all `call_events` on one timeline.

## 9. Queues and IVR

**Queues** (`queues` + `queue_members`) are ring strategies over members with a hold loop — deliberately not a PBX hold queue (no `<Enqueue>`/TaskRouter-style carrier queue yet; that infrastructure arrives if scale demands it):

- **Strategies:** `simultaneous` (all available members, cap 5), `round_robin` (member rung longest ago — `agent_presence.last_rung_at`, stamped on every ring), `longest_idle` (member whose last call ended longest ago — `last_call_ended_at`, stamped when a call reaches terminal state; the answering rep is adopted as the call's owner from their client leg's `client:<uuid>` identity, ordering-safe under at-least-once processing).
- **The wait loop:** each cycle (`/twiml/queue-wait?call&started&n`) either rings whoever the strategy picks *right now* (15s ring, then back to the loop so the next cycle can pick someone else), or plays the wait message and re-evaluates after a pause. Every cycle is a fresh availability decision — a rep coming online mid-hold gets the next ring.
- **Overflow:** after `max_wait_seconds` (or a hard 60-cycle backstop), voicemail or an external forward number. Journaled as `call.queue_overflow`.
- **Fairness is data:** `call.queue_ring` events record strategy, targets, and cycle; the whole hold is reconstructable.
- A **memberless queue is skipped**, not a caller trap — the chain falls through to the number assignee.

**IVR** (`phone_numbers.ivr`, `IvrConfig`): a one-digit `<Gather>` menu fronting the chain. Options map digits to a queue, a specific user, an external forward, or voicemail. A recognized lead owner ring skips the menu (CRM-aware speed-to-answer beats it). Unknown digits and gather timeouts fall to voicemail — never a dropped call. Offered menus and selections are journaled (`call.ivr_offered`, `call.ivr_selected`).

## 8. Testing contract (all green before this doc merges)

- Routing engine unit tests: owner-first, assigned-user fallback, team simultaneous ring cap, stale-presence exclusion, forward fallback, after-hours, no-agents.
- Business hours unit tests: timezone + DST evaluation, absent-config = open, absent-day = closed.
- Integration (real HTTP + worker + Postgres): recognized seller rings the lead owner's `<Client>` with call row linked to contact/lead; unavailable rep → greeting + `<Record>`; after-hours → voicemail; ring timeout → voicemail; voicemail recording lands attached to the call; client-leg answered drives `in_progress`; presence heartbeat flips routing behavior.
- Queues + IVR: round-robin rotates across calls with fairness stamped; hold loop holds when nobody is available and rings when someone appears; overflow after max wait, journaled; the answering member becomes the call owner and feeds longest_idle (including when `answered` processes after the terminal event); IVR renders the menu, digits route to queue/user, unknown digits and timeouts fall to voicemail.

## 10. Last-contact routing (callbacks to pool numbers)

Outbound calls and ringless voicemails rotate caller ID across a pool of the org's numbers, so the number a seller calls back says nothing about who reached them. Last-contact routing rings **the rep who most recently reached out to the caller**.

- **Touches** (`apps/server/src/services/last-contact.ts`, one query on the fast path): outbound `calls` to the caller's number (not `failed`) with a `user_id`; outbound `messages` in a conversation with them (`created_by`, not auto-replies, not failed/undelivered); and `outreach_events` a partner posted. Only active members of the org count. Phone matching is exact E.164 — the same key caller recognition uses (`contact_phones.phone_e164 = From`); posted numbers are normalized with `normalizePhone` before they are stored.
- **The choice** (`pickLastContact`, packages/core/src/routing.ts): the newest touch inside the window (default 14 days) whose rep is available by the §2 presence rule. An offline newer toucher yields to an available older one; nobody eligible falls through.
- **Default routing:** `phone_numbers.route_callbacks_to_last_contact` (boolean, default false; migration 0027). When on, last contact is tried **first** — before the lead owner and before a queue — with reason `last_contact`; otherwise the chain is unchanged. It also skips a legacy IVR menu, like a lead-owner ring does. Turn it on with `PATCH /v1/numbers/:id {"route_callbacks_to_last_contact": true}` (numbers.manage) or the toggle under Settings → Call forwarding. Numbers with a call flow ignore it.
- **Call flows:** a ring target `{kind: 'last_contact', within_days?: 1-90}` (default 14). It resolves to one person or nobody; nobody moves on to the step's other targets and then its `no_answer` edge, exactly like an unknown `lead_owner`. Touches are only loaded for flows that use the target.
- **What the call says:** a call routed this way has `raw.routedVia = 'last_contact'` and `raw.lastContact = {user_id, channel, occurred_at, ref}`; the call DTOs (`GET /v1/calls/ringing`, `/v1/calls/:id`, public API calls and `call.*` webhooks) carry `routing: {reason, last_contact}` so a client can show "Calling back about your voicemail drop from Mar 3". The flow path journal says "last reached out by …".
- **Outreach Talkr cannot see** (`POST /v1/outreach`, `POST /v1/outreach/batch`): authenticated with the ordinary `/v1` bearer — for CLOZR, the per-rep partner token it already mints for `/v1/messages` (HS256 with the partner secret, `iss` = its Supabase auth URL, `sub` = its user id, `email`). Body `{phone_e164, channel: rvm|email|other, occurred_at, ref?, user_id?}`; `user_id` is the partner's user id (resolved through `partner_identities`), a Talkr `users.id`, or absent for the token's own user; recording a touch for someone else needs `leads.assign`. Idempotent on `(org, ref)`. The batch takes an array (or `{events: [...]}`) of up to 500 and judges each item on its own.
