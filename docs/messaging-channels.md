# Messaging channels: SMS, iMessage, RCS

**Status:** built, off by default. Matches `packages/core/src/messaging.ts`
(channel selection, `read` status), `packages/provider-sendblue/`,
`packages/provider-telnyx/src/index.ts` (RCS send, capability check) and
`normalize.ts` (RCS webhooks), `apps/server/src/services/channels.ts`,
`apps/server/src/routes/webhooks-sendblue.ts`,
`apps/server/src/worker/sms-handlers.ts`, migration `0028_imessage_rcs.sql`.

A text from Talkr goes one of three ways:

| Channel | Carrier | Read receipts | When |
|---|---|---|---|
| `sms` | Telnyx messaging profile (SMS/MMS) | no | always available; the fallback |
| `imessage` | Sendblue | see §5 | Sendblue keys set, line has iMessage on, recipient has iMessage |
| `rcs` | Telnyx RCS Business Messaging | yes (`message.read`) | `TELNYX_RCS_AGENT_ID` set, line has RCS on, handset supports RCS |

Nothing changes until keys are set and a line is switched on. Suppression,
quiet hours, STOP/HELP/START and merge fields apply to every channel exactly
as in [sms.md](sms.md): they run before the channel is chosen.

## 1. Choosing the channel

At send time (the `send-message` job), per message:

1. Candidates: iMessage if Sendblue is configured and the line has
   `imessage_enabled` and a Sendblue number to send from; then RCS if
   `TELNYX_RCS_AGENT_ID` is set and the line has `rcs_enabled`. A message
   with more than one attachment has no candidates; RCS is skipped for any
   message with an attachment.
2. Each candidate is checked against the recipient, in order, stopping at the
   first yes. Answers are cached in `channel_capabilities` (yes for 30 days,
   no for 7). An inconclusive answer is never cached.
3. No candidate said yes: SMS through Telnyx, as before.

The pure decision is `selectMessageChannel` in core (unit tested); the
server supplies config and cached lookups (`chooseOutboundChannel`).

**Fallbacks after the choice.** Sendblue falls back to SMS on its own when a
handset turns out not to have iMessage (the receipt then says
`service: "SMS"`, and the row's `channel` becomes `sms`). A Sendblue 4xx
refusal (a line's new-contact cap, a validation rule) sends the text as
Telnyx SMS immediately. Every RCS send carries `sms_fallback` from our line;
a receipt with `type: SMS` sets the row's `channel` to `sms`.

## 2. Per-line settings

`PATCH /v1/numbers/:id` (`numbers.manage`):

| Field | Meaning |
|---|---|
| `imessage_enabled` | send iMessage from this line when possible |
| `sendblue_from_number` | the Sendblue line (E.164) this number's iMessage goes from and arrives on; `null` uses `SENDBLUE_FROM_NUMBER`. Unique across lines (`409 sendblue_number_taken`) |
| `rcs_enabled` | send RCS from this line when possible |

`GET /v1/numbers` returns all three.

**iMessage leaves from a different number.** Apple does not let a Telnyx
number send iMessage, so the person sees the Sendblue number on blue bubbles
and the Telnyx number on green ones. Talkr keeps one thread: an inbound
iMessage on a Sendblue number is filed under the Talkr line that uses it, so
SMS and iMessage with one person read as one conversation in Talkr and CLOZR.

## 3. Data

Migration `0028_imessage_rcs.sql`:

- `message_status` gains `read`.
- `messages.channel` (`sms` | `imessage` | `rcs`, default `sms`) and
  `messages.read_at`. `messages.provider` (existing) is `telnyx` or `sendblue`.
- `phone_numbers.imessage_enabled`, `sendblue_from_number`, `rcs_enabled`.
- `channel_capabilities (phone_e164, channel, supported, checked_at)`.

State machine: `read` ranks above `delivered`; `delivered → read` is the one
move out of a terminal status. A read receipt backfills `delivered_at` if the
delivery receipt never came. `read_at` is first-write-wins. A failed message
never becomes `read`.

## 4. Webhooks in

| Route | From | Auth | Idempotency key |
|---|---|---|---|
| `POST /webhooks/sendblue/status` | Sendblue `status_callback` (set on every send) | `?token=` minted from `SENDBLUE_WEBHOOK_SECRET` (else the API secret), or the `sb-signing-secret` header | `sendblue:status:{message_handle}:{STATUS}` |
| `POST /webhooks/sendblue/inbound` | Sendblue `receive` webhook | `sb-signing-secret` header = `SENDBLUE_WEBHOOK_SECRET` | `sendblue:inbound:{message_handle}` |
| `POST /webhooks/telnyx/sms-status` | RCS delivery and read receipts (existing route) | Ed25519 | `telnyx:sms-status:{id}:{status}` |
| `POST /webhooks/telnyx/inbound-sms` | inbound RCS, via the agent's `webhook_url` (existing route) | Ed25519 | `telnyx:inbound-sms:{id}` |

Both Sendblue routes answer 404 when Sendblue is not configured. Same ingest
discipline as every other webhook: verify, store raw in `webhook_events`,
dedupe, enqueue `process-sendblue-webhook`, ack.

Sendblue status mapping: REGISTERED/PENDING/QUEUED → `queued`, ACCEPTED →
`sending`, SENT → `sent`, DELIVERED → `delivered`, READ → `read`,
DECLINED/ERROR → `failed` (`error_code`, else `error_key`). Group messages
are ignored.

Inbound line resolution:

- **iMessage**: the line whose `sendblue_from_number` is the receiving
  Sendblue number; for the shared `SENDBLUE_FROM_NUMBER`, the iMessage line
  this person last texted with, else the only iMessage line on the default.
- **RCS** (addressed to the agent, not a number): the RCS line this person
  last texted with, else `TELNYX_RCS_INBOUND_NUMBER`.
- Neither: a `reconciliation_mismatches` orphan row, never a guess.

## 5. Events out (the CLOZR contract)

Realtime bus / SSE (`/v1/events/stream`):

| Event | When | `status` | `data` |
|---|---|---|---|
| `message.received` | inbound on any channel | (none) | `{conversationId, messageId}` |
| `message.updated` | any status change (unchanged event) | new status, now including `read` | `{conversationId, messageId, channel, readAt?}` |
| `message.read` | first read receipt for a message | `read` | `{conversationId, messageId, channel, readAt}` |

Public outbound webhook (`/v1/admin/webhook-subscriptions`, signed as in
[public-api.md](public-api.md) §7): new subscribable type **`message.read`**,
sent once per message (`id` = `message.read:{message_id}`):

```json
{ "id": "message.read:…", "type": "message.read", "occurredAt": "<read_at>",
  "data": { "id": "…", "conversation_id": "…", "direction": "outbound",
            "status": "read", "read_at": "<ISO>", "channel": "imessage",
            "provider": "sendblue", "from_number": "+1…", "to_number": "+1…",
            "body": "…", "sent_at": "…", "delivered_at": "…", … } }
```

Message resources (`GET /v1/conversations/:id/messages`, `POST /v1/messages`)
add `channel`, `read_at` and `provider`; `status` may be `read`.

**Read receipts by channel.** RCS: Telnyx documents `message.read`; mapped.
iMessage: Sendblue's docs list no READ status for outbound messages
(statuses end at DELIVERED). The adapter maps a `READ` status or a
`date_read` field should a line send one, but until a live account shows it,
expect iMessage messages to stop at `delivered`.

## 6. Configuration

| Variable | Purpose |
|---|---|
| `SENDBLUE_API_KEY_ID`, `SENDBLUE_API_SECRET` | turn iMessage on for the deployment |
| `SENDBLUE_FROM_NUMBER` | default Sendblue line for iMessage lines without their own |
| `SENDBLUE_WEBHOOK_SECRET` | secret set on the Sendblue `receive` webhook (required for inbound) |
| `SENDBLUE_API_BASE` | optional host override |
| `TELNYX_RCS_AGENT_ID` | turn RCS on (also needs `TELNYX_MESSAGING_PROFILE_ID`) |
| `TELNYX_RCS_INBOUND_NUMBER` | optional home for RCS replies with no earlier thread |

## 7. Sendblue account (outside the code)

1. A Sendblue plan with dedicated lines that may message first. Sendblue's
   AI Agent plan is inbound-first (a contact must text before you can);
   outbound to sellers needs the outbound plan ("Blue Ocean", by demo:
   https://sendblue.com/request-a-demo). Its limits: 50 new contacts per day
   and 15 per hour per line; lookups 30/hour and 100/day per line.
2. Keys from the dashboard (API keys) into `SENDBLUE_API_KEY_ID` /
   `SENDBLUE_API_SECRET`; the line's number into `SENDBLUE_FROM_NUMBER` or a
   line's `sendblue_from_number`.
3. Dashboard → Developer → Webhooks: a `receive` webhook at
   `{PUBLIC_BASE_URL}/webhooks/sendblue/inbound` with a secret; put the same
   secret in `SENDBLUE_WEBHOOK_SECRET`. Status callbacks need no setup.
4. `PATCH /v1/numbers/:id {"imessage_enabled": true}` on the lines to use.
