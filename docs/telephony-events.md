# Talkr Platform — Telephony Event Architecture

**Status:** living document; matches `packages/core/src/events.ts`, `packages/core/src/call-state.ts`, and `packages/provider-telnyx/src/normalize.ts`. Telnyx (TeXML) is the only carrier; Talkr previously also ran on Twilio.

## 1. Pipeline

```
Provider webhook ──▶ ingestion (apps/server/src/webhooks/*)
  1. signature check          invalid ⇒ 403 + webhook_events row status='rejected'
  2. raw persist              INSERT webhook_events (headers, raw body, key)
  3. dedupe                   unique(idempotency_key) conflict ⇒ status='skipped_duplicate', ack, stop
  4. transactional enqueue    INSERT jobs(process-webhook, {webhook_event_id}) in same tx
  5. fast ack                 200 (or TeXML for call-control URLs) — no provider/CRM/AI calls here
                              ──▶ worker (apps/server/src/worker.ts)
  6. adapter.normalizeWebhook ⇒ CanonicalEvent[]
  7. applyCanonicalEvent      state machine + row updates + call_events append (idempotent)
  8. follow-on jobs           podio sync, recording mirror, reconciliation, SSE push
  9. on error                 retry w/ exp backoff ⇒ status='dead_letter' after max attempts
```

### Addressing a rep's browser

The rep's identity is the platform user id (`client:<uuid>`), but Telnyx
generates the SIP username (`gencred…`) when the credential is created, so
those are not the same string — the wire carries
`sip:gencred…@sip.telnyx.com` and only a stored row maps it back. That row is
`telephony_credentials`, written the first time a rep mints a voice token.

Two strings, not one, and conflating them breaks inbound routing: TeXML has no
`<Client>` noun. So `clientTargetsFor()` hands the adapter an identity pair and
the adapter renders `<Sip>` to the SIP address.

A rep with no credential has never enabled their softphone. Ring groups skip
them and log it rather than failing the whole inbound call; a direct transfer
to them is refused with a message naming them.

### Signature validation

| Provider | Scheme | Signed bytes |
|---|---|---|
| Telnyx | **Ed25519, asymmetric** — we hold only a public key | `{timestamp}\|{raw_body}`, literal pipe |

Two consequences. The **exact delivered bytes** must be verified, so
the raw body is captured before parsing and never re-serialized. And because
the signature covers the timestamp *header as sent*, that header is required to
be a whole unsigned decimal — parsing it with something `parseInt`-like accepts
`1788000000abc`, which verifies cryptographically and then yields an in-window
replay check. Both are pinned by tests in `packages/provider-telnyx/test`.

**Call-control webhooks are special** (`/twiml/*`, the Voice URL registered on the Telnyx TeXML app): the carrier is *waiting* for TeXML to continue the live call, so these endpoints do the minimum synchronous work (validate, load call, respond) and still persist the raw event + enqueue processing. They are the only ingestion paths allowed to touch business tables synchronously (a single indexed lookup + one status write).

## 2. Canonical events

Adapters translate provider payloads into these; nothing downstream ever sees a carrier field name (TeXML's are Twilio-compatible: `CallSid`, `CallStatus`, …). Event type strings are `text`, namespaced, append-only (never renamed):

| Canonical event | Meaning | TeXML source |
|---|---|---|
| `call.initiated` | provider accepted the call | voice status `initiated` / TeXML app hit |
| `call.ringing` | destination ringing | status `ringing` |
| `call.answered` | human/endpoint answered | status `in-progress` / `answered` (pstn leg) |
| `call.completed` | normal end | status `completed` |
| `call.no_answer` | destination never answered | status `no-answer` |
| `call.busy` | destination busy | status `busy` |
| `call.failed` | carrier/platform failure | status `failed` (+ ErrorCode) |
| `call.canceled` | canceled before answer | status `canceled` |
| `recording.started` | recording began | RecordingStatus `in-progress` |
| `recording.completed` | media ready at provider | RecordingStatus `completed` |
| `recording.failed` | recording failed/absent | RecordingStatus `failed`/`absent` |
| `message.received` | inbound SMS/MMS | inbound message webhook (Phase 4 processing; ingested & stored from Phase 1) |
| `message.status` | delivery status change | message status callback (Phase 4) |
| `conference.started` | room opened | conference status `conference-start` (§9) |
| `conference.ended` | room closed | conference status `conference-end` |
| `conference.participant_joined` | a party is in the room | `participant-join` |
| `conference.participant_left` | a party dropped | `participant-leave` |
| `conference.participant_hold` | a party was held | `participant-hold` |
| `conference.participant_unhold` | a party was resumed | `participant-unhold` |

Each `CanonicalEvent` carries: `type, provider, providerObjectId, occurredAt, sequenceNumber?, orgHint?, data (normalized fields), raw (provider params)`.

## 3. Idempotency keys (per provider/endpoint)

Deliveries are at-least-once; the unique key on `webhook_events.idempotency_key` is the first line of defense. Keys must identify the *event*, not the delivery:

| Endpoint | Key |
|---|---|
| Voice status | `telnyx:voice-status:{CallSid}:{CallStatus}:{SequenceNumber ?? 'x'}` |
| TeXML call-control | `telnyx:{endpoint}:{CallSid}[:…]` (see `idempotencyKeyFor` in `packages/provider-telnyx/src/normalize.ts`) |
| Recording status | `telnyx:recording:{RecordingSid}:{RecordingStatus}` |
| Conference status | `telnyx:conference-status:{ConferenceSid}:{StatusCallbackEvent}:{CallSid ?? 'x'}:{SequenceNumber ?? 'x'}` |
| Inbound message | `telnyx:inbound-sms:{MessageSid}` |
| Message status | `telnyx:sms-status:{MessageSid}:{MessageStatus}` |
| Legacy rows | `twilio:`-prefixed keys on rows written before Talkr moved to Telnyx (opaque, left as-is); their `provider` was relabelled `telnyx` by migration 0026 |
| Podio item webhook | `podio:{hook_id}:{item_id}:{type}:{item_revision_id ?? sha256(body)}` |
| Unknown/other | `{provider}:{endpoint}:sha256(raw_body)` |

Second line of defense: `call_events` carries its own uniqueness guard and `applyCanonicalEvent` is a no-op when the event is already reflected — so even two *different* webhook deliveries describing the same fact can't double-apply.

## 4. Call state machine

```
queued ──▶ initiated ──▶ ringing ──▶ in_progress ──▶ completed
   │            │            │             └────────▶ failed (mid-call carrier error)
   │            │            ├──▶ no_answer | busy | canceled | failed
   │            └──▶ (same terminal set — ringing may be skipped)
   └──▶ canceled | failed  (never left the gate)
```

Rules (enforced in `packages/core/src/call-state.ts`, pure function, fully unit-tested):

1. **Monotonic rank.** `queued(0) < initiated(1) < ringing(2) < in_progress(3) < terminal(4)`. An event mapping to a lower-or-equal rank updates timestamps only if they are unset, appends to `call_events`, and never regresses `status`.
2. **Terminal is sticky** for webhooks. Only a `reconciliation` -sourced correction may change one terminal state to another (e.g. provider REST says `no-answer`, we recorded `failed`), and doing so writes both a `call_events` entry and a `reconciliation_mismatches` row.
3. **Out-of-order safety.** `completed` arriving before `answered` sets `ended_at` and terminal status; the late `answered` then backfills `answered_at` only. (Tested: `webhook-ordering.test.ts`.)
4. **Leg semantics.** For browser outbound, the `pstn` leg's events drive `ringing/answered/no_answer/busy`; the `client` leg's `completed` alone never marks the logical call completed unless the pstn leg is already terminal or absent.
5. **Failure classification.** Terminal events set `failure_class`: `no_answer/busy → seller_*`; `failed` with carrier error codes → `carrier_failure`; `failed` caused by our TeXML/app/auth errors (Twilio-compatible error classes 11xxx/12xxx/13xxx/2xxxx app-side) → `platform_failure`. Reporting treats these as different metrics — "seller didn't answer" is not "the phone system failed."

## 5. Speed-to-lead timestamps

The worker writes leads' ladder timestamps first-write-wins as events flow: outbound `call.initiated` on a call linked to a lead ⇒ `first_attempt_at`; `call.answered` ⇒ `first_answer_at`; a completed call ≥ configurable conversation threshold (default 30s of talk) or a disposition flagged `treat_as_conversation` ⇒ `first_conversation_at`.

## 6. Reconciliation

- **Per-call:** ~2 minutes after a call reaches terminal state, a `reconcile-call` job fetches the provider call resource(s) and diffs `status, duration, price` and recording presence. Differences → `reconciliation_mismatches` (+ correction per §4.2 where provider is authoritative).
- **Sweeps:** a periodic job lists provider calls in a trailing window and flags any provider ID with no internal call (`orphan`) and any internal non-terminal call older than N hours (`stuck`) — both feed the data-integrity dashboard.
- **Recordings:** any completed call with recording policy "on" and no recording row within 10 minutes ⇒ mismatch row (`missing_recording`).

## 7. Dead-letter handling & replay

- Processing failures retry with `min(30s · 2^attempts, 1h)` + jitter, `max_attempts=8`, then `webhook_events.status='dead_letter'` / `jobs.status='dead'`.
- Admin endpoints (Phase 1): list dead events/jobs, inspect raw payload + error history, **replay** (re-enqueue with fresh attempt budget), and mark-ignored with a reason. Replay is idempotent by construction — replaying a processed event is a no-op at the apply layer.

## 8. Fixtures

`apps/server/test/fixtures/texml.ts` (and `texml-sms.ts`) hold sanitized real-shape webhook payload factories (status sequences for answered / no-answer / busy / failed calls, dual-channel recording callbacks, duplicate and out-of-order sequences). Tests replay them — with genuine Telnyx Ed25519 signatures from a per-run key pair — through the actual ingestion + worker code paths against a real Postgres 16. When the carrier's payloads change, update the factories from captured production events — never hand-invent fields.

## 9. Conference call control — hold, add call, merge, transfer

**Status:** implemented for browser **outbound** calls. Inbound calls still use
the Phase 3 `<Dial><Client>` bridge and therefore cannot yet be held or
transferred — see "Not yet" below.

### 9.1 Why a room instead of a bridge

Phase 2 dialed the seller with `<Dial><Number>`, which bridges exactly two
legs. A two-leg bridge has no notion of a third party, so it cannot hold one
side, add somebody, or hand the caller to a teammate — every control the rep
actually asks for during a call is impossible in that shape.

So a browser outbound call now runs inside a per-call **conference room** and
every control is a *participant* operation:

```
POST /v1/calls                 server creates the authoritative call row
POST /v1/calls/:id/browser-leg ──► server rings the browser; answered leg ──► /twiml/outbound-dial
                                 ├─ adopt CallSid as the parent leg
                                 ├─ INSERT call_participants (role 'agent')
                                 ├─ enqueue conference-dial-customer (+5s, fallback)
                                 ├─ participants.create(to = seller)  ──► role 'customer'
                                 └─ <Dial><Conference>talkr-{callId}</Conference>
worker: conference-dial-customer
                                 └─ claim lost → no-op (the usual case)
```

**The seller is dialed inline, on the TeXML path.** This is the one deliberate
exception to §1's "call-control paths make no provider REST calls", and it was
bought with evidence: the queue is drained by a cron tick — once a minute on
the serverless deployment (`apps/server/vercel.json`) — so dialing from the job
alone meant up to a full minute between the rep pressing call and the seller's
phone ringing, which the rep experienced as a minute of hold music. The
participant-add is a single few-hundred-millisecond REST call against the carrier's
~15s call-control budget.

The queued job still exists and is still enqueued, *before* the inline attempt,
as the durability net. The inline dial is non-fatal by construction: any error
is logged and the TwiML is still returned, so a provider hiccup costs one
fallback hop instead of a dead call.

Both paths call one function (`services/conference-dial.ts`) so they cannot
drift — same participant row, same status-callback URL, same
`endConferenceOnExit`, same log fields, and downstream event handling never has
to know which one placed the call.

Exactly-once is claim-gated rather than roster-gated. The customer participant
row only exists *after* the provider returns, so two attempts starting together
would both see an empty roster and both ring the seller. Instead the dial is
claimed with the journal-insert gate `cancel-sibling-dials` already uses:
`call_events.dedupe_token` is uniquely indexed per call (`call_events_dedupe_uq`),
so exactly one attempt wins `call.customer_dial_claimed` and the loser stands
down. The claim is released only when the provider call itself failed — the one
case where the fallback must be free to try again.

Room naming is deterministic — `talkr-{callId}` (`conferenceRoomName`) — because
the TwiML names the room before any ConferenceSid exists, and the participant
REST calls have to address the same room later.

### 9.2 The controls

| Control | What actually happens |
|---|---|
| **Hold / resume** | `hold` on the customer participant. |
| **Add call** | Hold the customer *first*, then dial the third party in. A participant cannot be created already held, so the order matters: consult privately, then add. |
| **Merge** | Un-hold everyone. The consultation becomes a conference. |
| **Warm transfer** | Agent's `endConferenceOnExit` → false, target joins with the customer held, rep announces, then `transfer/complete` un-holds the customer and drops the rep. |
| **Blind transfer** | Same, but `complete` runs immediately — the customer hears hold audio for the seconds the target's phone rings. |
| **Remove** | Drop one participant; the room and everyone else carry on. Never the agent — leaving is a different operation. |

`endConferenceOnExit` is the subtle one. The rep holds it so that hanging up
ends the call, which is what a rep expects. Every transfer flips it off on the
agent **before** anyone is handed over — otherwise the rep hanging up would
tear down the room and drop the customer mid-transfer.

### 9.3 Who is authoritative

Our `call_participants` rows are an optimistic view. A control writes the state
the rep asked for immediately, so the UI responds at once; the room's own
callbacks then reconcile it. That is also how changes we did not initiate — a
teammate hanging up, a party the carrier dropped — reach the roster.

`conference.participant_left` is sticky in the same way call terminal states
are (§4.2): a late join or hold callback never resurrects a party who dropped.
`conference-end` marks everyone left, whatever we last believed.

A callback for a room whose friendly name is not ours writes a
`reconciliation_mismatches` row (`orphan_conference`) rather than being
dropped, exactly as an orphan call event does.

### 9.4 Recording

Conference mode records the **room** (`record-from-start`) rather than
dual-channel on a `<Dial>`, because a conference recording keeps capturing when
parties are added, held or transferred mid-call. Recording callbacks are
unchanged and still carry `call={id}`.

### 9.5 Rollback

`CALL_CONTROL_MODE=bridge` restores the Phase 2 two-leg `<Dial><Number>` path
untouched, for an org that hits a conference-specific problem. Conference is
the default; the test harness pins the same default explicitly, so the suite
cannot drift into covering a path production does not take.

### 9.6 Not yet

- **Inbound calls.** `twiml-inbound.ts` still rings reps with `<Dial><Sip>`
  through queues, IVR, business hours and voicemail. Making inbound
  conference-capable means the caller's leg joins a room and the rep is added
  as a participant — a rewrite of that routing path, not a config change.
  Until then the controls above are outbound-only.

### 9.7 Hold music

A room does not *start* until its second party joins, and until then the first
one hears hold music — that is the TeXML (Twilio-compatible) conference lifecycle, and it
is what the rep was hearing for up to a minute before §9.1's inline dial. With
the dial inline the rep hears a beat of it and then the seller's ringback
(participants are added with `earlyMedia`), but "a beat of the carrier's hold
music" is still an org's choice to make, not ours.

So: what a party alone in the room hears is per org, stored in the existing
`organizations.settings` jsonb (no migration, matching how the timezone,
business hours and the SMS send window already live there):

```json
{ "hold_music": { "mode": "default" | "silence" | "url", "url": "https://…" } }
```

| Mode | `waitUrl` on `<Conference>` | What plays |
|---|---|---|
| `default` (absent, or anything unparseable) | attribute omitted | the carrier's own hold music |
| `silence` | `""` | nothing; the empty string means "no wait music" in the Twilio-compatible verb |
| `url` | the stored URL | the org's own MP3/WAV or TeXML |

Validation is at **write** time and nowhere else (`packages/core/src/org-settings.ts`):
`http(s)` only, absolute, ≤500 characters, no embedded credentials, and no host
the carrier could never reach (loopback, RFC1918, link-local, `.local`, a bare
dotless host). A URL the carrier cannot fetch is not a warning — it is dead air
on a live call — so it is refused in the form rather than discovered by a
seller. The read path is the mirror image: `readHoldMusic` never throws and
never rejects a call, so a blob written by an older build or hand-edited in
psql degrades to `default`.

Read and written through `GET`/`PATCH /v1/org/settings`, guarded by the
existing `admin.users` permission — this is org-wide configuration, not a rep
preference, and there is no new role for it. The `PATCH` merges into the
existing blob, so saving hold music cannot wipe the org's calling hours. The
web UI is the "Hold music" card in Settings, rendered for owners and admins
only.

Applied wherever a conference is built for the org, which today is exactly one
place: the outbound TwiML path in `routes/webhooks.ts` (one indexed
primary-key read on the call-control path). The other call paths do not build
conferences and are unaffected — inbound still uses `<Dial>` with its own
`buildQueueWaitResponse` hold loop (§9.6), and the campaign parallel dialer
bridges the winning seller to the rep with `<Dial><Client>`. When either
becomes conference-capable it should read the same setting.

Not covered yet: parties added by the REST participant API carry their own
`WaitUrl`, which `AddParticipantParams` does not expose, so a customer left
alone in the room mid-transfer still hears the carrier default rather than the
org's choice. Same setting, second knob — worth closing when transfers get
their next pass.
