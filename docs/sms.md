# Talkr Platform — SMS (Phase 4)

**Status:** living document; matches `packages/db/src/schema.ts` (SMS section),
`packages/core/src/messaging.ts`, `packages/provider-telnyx/src/normalize.ts`
(`inbound-sms` / `sms-status`), `apps/server/src/services/messages.ts`,
`apps/server/src/services/message-templates.ts`,
`apps/server/src/services/conversation-filters.ts`,
`apps/server/src/routes/messages.ts`, `apps/server/src/routes/webhooks-sms.ts`,
and `apps/server/src/worker/sms-handlers.ts`.

Phase 4 is two-way conversational SMS for reps working leads: a shared
Messages inbox, templated one-at-a-time sends, delivery tracking, and the
compliance primitives (STOP/HELP/START, suppression, quiet hours) enforced on
every send. **There is deliberately no bulk/blast endpoint in this phase** —
`POST /v1/messages` sends exactly one message to exactly one destination, and
campaign sending (Phase 5) will build on the same suppression/consent gates.

---

## 1. Data model

Three new tables (`packages/db/migrations/0004_sms.sql`). Thread key follows
docs/data-model.md Phase 4 note:
`(org_id, our_number, their_number)`.

**conversations** — one row per (org, our E.164, their E.164) thread.
`id, org_id, contact_id, lead_id, phone_number_id (our number's row),
our_number, their_number, assigned_user_id, last_message_at, unread_count,
created_at`. Unique `(org_id, our_number, their_number)`; indexed
`(org_id, last_message_at)` for the inbox list. `unread_count` counts inbound
messages since the last mark-read; `assigned_user_id` is seeded from the
lead's assigned user when the conversation is created and drives the
`messages.read.own` visibility scope (see §6).

**messages** — one row per SMS/MMS, inbound or outbound.
`id, org_id, conversation_id, direction ('outbound'|'inbound'), status
(message_status enum: queued|sending|sent|delivered|undelivered|failed|received),
body, media_urls jsonb (string array), num_segments, provider,
provider_message_sid (unique — the idempotency anchor), error_code,
failure_class (text: none|carrier_failure|platform_failure|suppressed),
template_id, created_by (user, outbound only), is_auto_reply,
crm_sync_status, sent_at, delivered_at, failed_at, created_at`.
Timestamps are **first-write-wins** like calls: a late `sent` after
`delivered` backfills `sent_at` but never regresses `status`.

**message_templates** — org-scoped reusable bodies with merge fields (§6)
and a display `category` (`cold`/`warm`/`hot`/`compliance` today). The
category is free text, not an enum: the set will grow, and a template carrying
an unrecognized one must still render. `GET /v1/message-templates` also
returns `use_count`, counted from `messages.template_id` rather than a
denormalized column, so it cannot drift. `id, org_id, name (unique per org),
body, category, is_active, created_by, created_at`.

`suppression_records` (existing, Phase 1) is the opt-out store; SMS writes
`scope='org', channel='sms', reason='stop'` rows. **Assumption:** the task
brief said "reason opt_out", but the existing `suppression_records.reason`
vocabulary (docs/data-model.md) already defines `'stop'` as the SMS-keyword
opt-out reason, so `'stop'` is used — one vocabulary, no new value.

## 2. Message state machine

Pure function `reduceMessageStatus` in `packages/core/src/messaging.ts`
(unit-tested), same philosophy as the call state machine:

```
outbound: queued(0) ─▶ sending(1) ─▶ sent(2) ─▶ delivered(3)
                                       └──▶ undelivered(3) | failed(3)
inbound:  received (terminal on arrival)
```

1. **Monotonic rank** — a status event mapping to a lower-or-equal rank
   changes nothing except backfilling its first-write-wins timestamp.
2. **Terminal is sticky** — `delivered`, `undelivered`, `failed` never
   transition to anything else via webhooks. Duplicates are no-ops.
3. **Out-of-order safe** — `delivered` before `sent` lands `delivered`;
   the late `sent` backfills `sent_at` only.
4. **Failure classification** — `classifyMessageFailure(errorCode)`:
   21xxx (API/app misuse in the Twilio-compatible numbering, e.g. 21610
   unsubscribed recipient) →
   `platform_failure`; 30xxx (carrier/delivery) → `carrier_failure`;
   unknown/absent code on a failed message → `carrier_failure`. Sends we
   refuse locally use `suppressed`.

**Unregistered-number failures — read this before debugging code.** A
`failed`/`undelivered` callback on texts to US mobiles usually means **the
sending number is not registered for A2P 10DLC** (under Twilio, which Talkr
previously ran on, this was error `30034`): the carrier rejected the message
because of the number's registration status, not because of anything in this
codebase. It classifies as `carrier_failure`. The fix is finishing
brand/campaign registration for that number on Telnyx (see
`docs/telnyx-setup.md` §4) and, until
that clears, sending from a number that is registered — the `from_phone_number_id`
override on `POST /v1/messages` (§5) exists partly for exactly this. No retry,
body change or code change will make an unregistered number deliverable.

Timestamps on status events use webhook **receipt time** — message status
callbacks carry no `Timestamp` field. Ordering safety comes from the
monotonic machine, not clock comparison. (Documented assumption.)

## 3. Webhook flows

Both new endpoints follow the Phase 1 ingestion discipline exactly:
signature check → raw `webhook_events` persist → dedupe on idempotency key →
transactional job enqueue → fast ack. No business tables are touched
synchronously.

| Endpoint | Route | Idempotency key | Ack |
|---|---|---|---|
| `inbound-sms` | `POST /webhooks/telnyx/inbound-sms` | `telnyx:inbound-sms:{MessageSid}` | 200 `ok` |
| `sms-status` | `POST /webhooks/telnyx/sms-status` | `telnyx:sms-status:{MessageSid}:{MessageStatus}` | 200 `ok` |

The legacy `/webhooks/twilio/…` paths (from when Talkr ran on Twilio) are still
served as the same routes, and boot moves the messaging profile to the new
path. Rows written before the carrier name was recorded keep their
`twilio:`-prefixed keys; migration 0026 relabelled their `provider`.

**Note for the integrator:** docs/telephony-events.md §3 sketched these keys
as `twilio:message-in:…` / `twilio:message-status:…` before this phase was
built; the implemented keys above (named after the endpoints, matching every
other key in `normalize.ts`) supersede that table. That doc was left
untouched to avoid cross-agent merge conflicts.

Ingestion enqueues a **`process-sms-webhook`** job (not the voice
`process-webhook`) because `apply-events.ts` is frozen this phase and
intentionally ignores message events. `ingestWebhook` grew an optional
`jobType` field (defaults to `process-webhook`) to keep the same-transaction
enqueue guarantee. The handler normalizes via the adapter and applies:

**`message.received` apply** (idempotent, one transaction):
1. Resolve our `phone_numbers` row by `To`. Unknown number → explicit
   `reconciliation_mismatches` orphan row (`orphan_provider_message`), never
   silently dropped.
2. Insert the message with `provider_message_sid` unique
   `ON CONFLICT DO NOTHING` — a duplicate delivery that survived the
   first-line dedupe stops here as a no-op.
3. Upsert the conversation on the thread key; link `contact`/`lead` via
   `contact_phones (org_id, phone_e164)` (most recent lead for the contact);
   bump `last_message_at`, increment `unread_count`.
4. CTIA keyword handling (§4).
5. Enqueue `podio-sync-message-activity` (dedupe key `podio-sms:{messageId}`)
   when the conversation has a CRM-linked lead.
6. After commit, publish `message.received` on the pg NOTIFY bus (SSE).

**`message.status` apply:** look up the message by `provider_message_sid`,
reduce with the state machine, persist the change (plus `error_code` /
`failure_class` on failure), publish `message.updated`. A status callback for
a SID we don't know yet **throws so the job retries** — the normal cause is a
race with the send job stamping the SID; after max attempts it dead-letters,
which is the explicit orphan state. (Documented assumption.)

## 4. Compliance rules (CTIA / TCPA)

Keyword parsing (`parseSmsKeyword`, unit-tested) is case-insensitive on the
**trimmed whole message** with trailing `.`/`!` tolerated — matching carrier
behavior: "STOP", "stop.", " Stop " match; "please stop texting" does not.

| Keywords | Action |
|---|---|
| STOP, STOPALL, UNSUBSCRIBE, CANCEL, END, QUIT | insert `suppression_records (scope org, channel sms, reason stop)`; send one opt-out confirmation auto-reply |
| HELP, INFO | send the help auto-reply (org name + support contact) |
| START, YES, UNSTOP | delete `channel='sms', reason='stop'` suppression rows for the number; send opt-in confirmation |

- **START only reverses SMS keyword opt-outs.** A DNC disposition,
  complaint, or legal suppression (`channel 'all'` / other reasons) is not
  cleared by texting START; those still block sends. (Deliberate.)
- **Auto-replies bypass quiet hours and the suppression gate** — they are
  compliance responses to a message the recipient just sent (CTIA requires
  the STOP confirmation and HELP response), not marketing. They are flagged
  `is_auto_reply` and are exactly-once: created in the same transaction as
  the inbound apply (itself gated by the SID unique) with job dedupe key
  `sms-auto-reply:{inboundMessageId}`.
- **Suppression is enforced on every send**: `POST /v1/messages` rejects
  suppressed destinations with HTTP 422 `{"error":"suppressed"}`, and the
  send job re-checks at send time (a STOP can land between queue and send),
  marking the message `failed / failure_class=suppressed` without calling
  the provider.
- **Quiet hours**: org-timezone send window from `organizations.settings`
  (`timezone`, `smsSendWindowStart`, `smsSendWindowEnd`; defaults
  `08:00`–`21:00`, `America/New_York` like routing). Outside the window
  `POST /v1/messages` returns HTTP 422 `{"error":"quiet_hours"}` — an
  explicit refusal, **never silent queueing**, so the rep decides what to do.
  Implemented as `isWithinSmsSendWindow` in core using the same Intl
  formatToParts approach as `isWithinBusinessHours`; wrap-around windows
  (start > end) are supported. **Assumption:** the window is evaluated in
  the org's timezone, not the recipient's — the first deployment operated regionally
  and we don't reliably know recipient timezones; per-recipient timezone
  (area-code inference) is a Phase 5 dialer-compliance work item.
- **No spam-evasion features exist or are planned**: no content rotation, no
  per-segment throttling bypass, no bulk endpoint.

## 5. Outbound send path

```
POST /v1/messages {conversation_id | to_number | lead_id | contact_id,
                   body | template_id, media_urls?, from_phone_number_id?}
  1. RBAC (messages.send) + input validation (exactly one of body/template_id)
  2. resolve destination + contact/lead linkage (lead → primary contact phone)
  3. suppression gate (sms|all channel, org scope, unexpired) → 422 suppressed
  4. quiet-hours gate → 422 quiet_hours
  5. merge-field render (§6) — EVERY body, typed or templated, both grammars.
     Nothing braced survives this step; nothing here fails the send.
  6. from-number: from_phone_number_id (must be an active org number, else
     400 invalid_caller_id) → the conversation's our_number → the most recent
     thread with this destination → caller-ID selection
  7. one transaction: upsert conversation, insert message (status queued,
     created_by), audit log, enqueue send-message job
     (dedupe send-message:{messageId})
  8. respond 201 {message, conversation_id}; publish bus event after commit
──────────────── async worker (send-message job) ────────────────
  9. idempotency: message no longer queued or SID already stamped → no-op
 10. suppression re-check (skipped for is_auto_reply) → failed/suppressed
 11. provider.sendMessage({from, to, body, statusCallbackUrl}) →
     stamp provider_message_sid + status sending (guarded: only from queued)
 12. provider error → throw → standard job backoff/retry; at max_attempts the
     job dead-letters and the runner marks the message failed
     (failure_class platform_failure, error_code send_dead_letter)
 13. delivery truth then flows in via sms-status callbacks (§3)
```

**Choosing the from-number.** With no override, nothing changes: an existing
conversation keeps its `our_number`, a brand-new one gets the voice v1 rule
(local presence when the rep has it on, else the rep's default, else any
active org number), and an org with no active number is refused
(`no_from_number`).

`from_phone_number_id` overrides all of that. It must be an **active number
this org owns** — anything else is `400 invalid_caller_id`, the same shape as
`POST /v1/calls` — and it is validated twice, at the route and again in the
service (a number could be released in between).

**An override on an existing thread forks the thread, deliberately.** The
thread key is `(org_id, our_number, their_number)`: texting the same person
from a different number is a different thread, which is exactly what the
recipient's phone shows — a new conversation from an unknown number. So the
message is written to (or opens) the conversation for the chosen number and
the original conversation is left untouched; the 201 response carries the
`conversation_id` the message actually landed in, which may not be the one the
caller passed. **The composer should follow the returned id.** The rejected
alternative — rewriting `conversations.our_number` in place — either collides
with the unique thread key when a thread for that number already exists, or
silently rewrites history that has already gone out over the wire under the
old number.

## 6. Merge fields, API surface + RBAC

### 6.1 Merge fields — no brace ever reaches a carrier

One grammar for every outbound body, shared with scripts and sequences:
**`{field}` and `{{field}}`** both work, inner whitespace is fine
(`{{ first_name }}`), and field names are case-insensitive. Fields:

| Field | Value |
|---|---|
| `first_name` | first word of the contact's display name (a company-looking name stays whole) |
| `name`, `contact_name` | the contact's display name (`contact_name` is the Phase 4 spelling, still supported) |
| `address`, `city`, `state`, `postal_code` | the property behind the lead |
| `company`, `org_name` | **our** organization's name — the same meaning it has in scripts and sequences |
| `rep_name`, `rep_first_name` | the sending user |
| `phone` | the contact's number, formatted `(614) 555-0134` |

Rendering happens on **every** outbound send — a body typed into the composer
exactly like a template — and in the send path, so the stored `messages.body`
is the literal text the carrier receives. The renderer is total:

- known field with a value → the value;
- known field with no value → `''` (a thin CRM record must not block a rep);
- **field nobody knows → `''`**, never the raw braces.

The gap left behind is tidied (a stranded space before punctuation is dropped,
runs of spaces mid-line collapse, the result is trimmed); newlines survive.
That tidy-up runs only when something was actually substituted, so a body with
no merge fields in it is stored and sent byte-for-byte as the rep typed it.
Braces around anything that is not an identifier — `{50%}` — are the rep's own
text, not merge syntax, and are left exactly as typed. That is the precise
guarantee: **any `{name}` / `{{name}}` placeholder is always substituted, so a
message like `Hi {first_name}, following up on {address}` can never go out
verbatim again.**

Loud failure moved to **template write time**: `POST` / `PATCH
/v1/message-templates` reject a body naming unknown fields with
`400 {"error":"unknown_merge_field","fields":["frist_name"]}`. A manager fixes
the typo there; a rep never discovers it mid-conversation. (Templates saved
before this rule still send — their unknown fields simply render empty.)

`POST /v1/messages/preview` (`messages.send`) shows exactly what will be sent:

```
POST /v1/messages/preview
  { body? | template_id?, conversation_id? | contact_id? | lead_id? | to_number? }
→ { body, merge_fields: {…every field…}, segments, characters,
    unknown_fields: ["bogus"] }
```

It reads only — no suppression or quiet-hours refusal (the send itself will
refuse), nothing queued — and a preview with **no** recipient is legitimate:
that is the composer before anyone is picked, and every contact field renders
empty. `POST /v1/message-templates/:id/preview` is the same output for a
stored template (an inactive one included, so a manager can preview an edit).

### 6.2 Permissions

Permissions (`packages/core/src/rbac.ts`): `messages.send`,
`messages.read.own`, `messages.read.org`, `messages.templates.manage`.
Reps get send + read.own; **managers add read.org and templates.manage**;
admins inherit both. Template management moved from admin to manager
deliberately: the person who coaches the reps is the person who fixes the
wording, and an admin round-trip for a typo is exactly why reps paste raw text
into the composer instead of using a template.

### 6.3 Endpoints

- `POST /v1/messages` — send (messages.send). Errors: `suppressed`,
  `quiet_hours` (422), `invalid_number`, `invalid_body`, `invalid_caller_id`
  (400), `not_found` (404), `no_from_number` (409). *(The Phase 4 error
  `unknown_template_variable` is gone: the send path no longer fails on merge
  fields, and template writes return `unknown_merge_field` instead.)*
- `POST /v1/messages/preview` — §6.1 (messages.send).
- `GET /v1/conversations` — the inbox (§6.4).
- `GET /v1/conversations/:id/messages` — the thread, ascending.
- `POST /v1/conversations/:id/read` — resets unread_count.
- `GET /v1/message-templates?include_inactive=true` (messages.send).
- `POST /v1/message-templates` `{name, body, category?, is_active?}`,
  `PATCH /v1/message-templates/:id` (any subset of the same fields),
  `DELETE /v1/message-templates/:id`,
  `POST /v1/message-templates/:id/preview` — writes need
  `messages.templates.manage`; the preview needs only `messages.send`.

Template validation: `name` 1–120 (trimmed, unique per org → `409 name_taken`),
`body` 1–1600 and not blank, unknown merge fields rejected as above. Every
write is audited (`message_template.create` / `.update` / `.delete`).

**Delete is conditional, and says which it did:**
`{ "id": …, "deleted": "soft" | "hard", "use_count": n }`. A template some
message already points at is **deactivated** (`is_active=false`) — the sent
history is the record of what a seller was actually told, and
`messages.template_id` is a foreign key onto it. A template nothing references
is **hard-deleted**, because an archive of never-used drafts is only clutter.
Deactivated templates disappear from the picker, are refused by the send path
with `404`, and stay visible under `include_inactive=true` with their
`use_count`.

A template row reads:
`{id, name, body, category, is_active, use_count, merge_fields, created_at}`.

### 6.4 The inbox: `GET /v1/conversations`

`messages.read.own` sees conversations assigned to the caller **or
unassigned** (shared inbox); `messages.read.org` sees everything. (Documented
assumption.)

Response — `conversations` keeps its name and every Phase 4 field keeps its
meaning:

```jsonc
{
  "conversations": [{
    "id": "…", "our_number": "+1…", "their_number": "+1…",
    "phone_number_id": "…|null",
    "contact_id": "…|null", "lead_id": "…|null",
    "contact_name": "Sally Seller|null",
    "contact_type": "seller|buyer|title|company|vendor|other|null",
    "contact_status": "new|attempting|…|null",
    "temperature": "hot|warm|cold|null",
    "temperature_score": 42,             // null when there is no contact
    "tags": ["probate"],                 // [] when there is no contact
    "company": "…|null",                 // the CONTACT's company, if any
    "lead_status": "…|null",
    "lead_city": "Columbus|null", "lead_state": "OH|null",
    "assigned_user_id": "…|null", "assigned_user_name": "Riley Rep|null",
    "last_message_at": "2026-08-25T18:04:00Z|null",
    "last_message": {                     // null when the thread has no messages
      "direction": "inbound|outbound",
      "body": "Yes still interested. Whats your offer?",
      "media_count": 0,
      "status": "queued|sending|sent|delivered|undelivered|failed|received",
      "created_at": "2026-08-25T18:04:00Z"
    },
    "unread_count": 2,
    "created_at": "2026-08-20T15:00:00Z"
  }],
  "total": 137,
  "counts": {
    "unread": 9,
    "by_type": { "seller": 120, "buyer": 5, "none": 12 },
    "by_temperature": { "hot": 8, "warm": 40, "cold": 77, "none": 12 }
  },
  "limit": 50,
  "offset": 0
}
```

`last_message.status` is what lets the list show a send the carrier rejected
without opening the thread. `counts` describes the **filtered** set, not the
whole inbox, and conversations with no contact are counted under `none`.

Filters — all optional, all combinable (AND), an empty value means "not set":

| Param | Meaning |
|---|---|
| `q` | contact name, contact company, last message body, or ≥3 digits of either number |
| `type` | contact type; repeatable (`?type=seller&type=buyer`) or comma-separated |
| `temperature` | `hot` / `warm` / `cold` |
| `status` | contact status |
| `tag` | one contact tag |
| `user_id` | conversation assignee |
| `unread=true` | `unread_count > 0` |
| `direction` | direction of the **last** message |
| `has_lead` | `true` / `false` |
| `from`, `to` | `YYYY-MM-DD` (a day in the ORG's timezone) **or** a full ISO instant; filters last activity, `to` covering the whole named day |
| `number_id` | our number (a `phone_numbers` id; matches `phone_number_id` or the literal `our_number`, so rows that predate `phone_number_id` still match) |
| `sort` | `recent` (default), `oldest`, `unread`, `temperature` |
| `limit` | default 50, max 200 |
| `offset` | page offset |

A bad value is a `400`, never a silently ignored filter: `invalid_query` (with
zod issues), `invalid_type` (names the offending value) or `invalid_date`.
Last activity is `COALESCE(last_message_at, created_at)`, so a thread with no
messages yet still sorts and filters sensibly.

Two queries serve the endpoint whatever the filters — the page (conversation +
contact + assignee + lead/property + newest message through one `LEFT JOIN
LATERAL`) and one CTE for `total` and `counts` — never a query per row.

## 7. Realtime + Podio

- Bus events `message.received`, `message.updated`, `conversation.updated`
  are published on the existing pg NOTIFY bus **after commit** and fan out
  through the existing SSE stream (`/v1/events/stream`). They carry no
  `userId` so the whole org's inbox stays live (the SSE layer's own
  org-scoping applies).
- `podio-sync-message-activity` posts exactly one Podio comment per inbound
  message on a CRM-linked lead ("💬 SMS received … " + body preview +
  `[talkr:{message_id}]` marker), guarded by job dedupe key and
  `messages.crm_sync_status`, mirroring the call-activity job.

## 8. Documented assumptions (rollup)

1. Suppression reason is `'stop'` (existing vocabulary), not `'opt_out'`.
2. Quiet hours use the **org's** timezone; recipient-timezone enforcement is
   Phase 5. Defaults 08:00–21:00, configurable per org via settings keys
   `smsSendWindowStart` / `smsSendWindowEnd` / `timezone`.
3. Auto-replies (STOP/HELP/START responses) bypass quiet hours and the
   suppression gate — they are compliance responses, not marketing.
4. START clears only `channel='sms', reason='stop'` suppressions.
5. Status-callback timestamps are receipt-time approximations (the carrier
   sends no event timestamp); ordering safety is rank-based.
6. A status callback for an unknown SID retries (send-job race) and
   dead-letters as the explicit orphan state; inbound SMS to an unknown
   number writes an orphan mismatch row.
7. `messages.read.own` includes unassigned conversations (shared inbox).
8. Merge fields render on **every** outbound send, in both `{field}` and
   `{{field}}` grammars; a field with no value and a field nobody knows both
   render as `''`, so no placeholder can reach a carrier (§6.1). Loud failure
   for unknown fields lives at template write time
   (`unknown_merge_field`), not at send time.
9. Idempotency keys are `telnyx:inbound-sms:{MessageSid}` and
   `telnyx:sms-status:{MessageSid}:{MessageStatus}` — supersedes the
   pre-Phase-4 sketch rows in docs/telephony-events.md §3.
10. MMS: inbound media URLs are stored (`media_urls`) and rendered inline.
    Outbound: the web composer uploads each file to `POST /v1/media` (base64
    JSON; JPEG/PNG/GIF/WebP/MP4/PDF/vCard, 3 MB cap, images downscaled to
    1600 px client-side), which stores the bytes in `media_assets` and returns
    a public `{PUBLIC_BASE_URL}/media/{id}/{name}` URL. `POST /v1/messages`
    accepts `media_urls` (max 10) and the send job passes them to the
    provider as `mediaUrl`/`media_urls`; a message may have media and no text.
11. `num_segments` is recorded from webhook params when the carrier provides it;
    it is informational (cost reporting lands with Phase 6).
12. `from_phone_number_id` on a send overrides caller-ID selection **and**
    thread continuity. Because the thread key is
    `(org_id, our_number, their_number)`, using it on an existing thread lands
    the message in a separate conversation for the chosen number rather than
    rewriting `conversations.our_number`; the response says which
    conversation it landed in (§5).
13. Deleting a message template that any message references deactivates it
    (`is_active=false`) rather than removing it — the sent history points at
    it. An unreferenced template is deleted outright. The response says which
    happened (§6.3).
14. `messages.templates.manage` is a **manager+** permission now (it was
    admin-only in Phase 4) — §6.2.
15. Inbox `counts` are computed over the filtered set, and conversations with
    no contact are counted under the key `none` (§6.4).
