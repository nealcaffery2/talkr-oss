# RCS setup (Telnyx)

What the owner does outside the code before Talkr sends RCS. Until every step
is done and `TELNYX_RCS_AGENT_ID` is set, Talkr sends SMS exactly as it does
today. How the code uses RCS is in [messaging-channels.md](messaging-channels.md).

Telnyx docs this follows (read 2026-10-21):

- RCS getting started: https://developers.telnyx.com/docs/messaging/messages/rcs-getting-started
- Agent registration quickstart: https://developers.telnyx.com/docs/messaging/rcs/agent-registration
- Sending RCS and SMS fallback: https://developers.telnyx.com/docs/messaging/messages/send-an-rcs-message
- RCS webhooks (delivery, read, inbound): https://developers.telnyx.com/docs/messaging/messages/receiving-rcs-webhooks
- API reference: https://developers.telnyx.com/api-reference/rcs/send-an-rcs-message,
  https://developers.telnyx.com/api-reference/rcs/check-rcs-capabilities,
  https://developers.telnyx.com/api-reference/rcs/modify-an-rcs-agent

The API steps below are Telnyx's documented endpoints; the portal offers the
same flow, but its menu names were not checked for this doc.

## 1. Gather before you start

- The Telnyx messaging profile Talkr already sends SMS through
  (`TELNYX_MESSAGING_PROFILE_ID`). RCS sends require it.
- Legal business details: legal name, entity type, EIN, address, website, and
  a brand contact (name, email, phone).
- Public HTTPS URLs for: the agent logo, a hero (banner) image, the privacy
  policy, and the terms and conditions.
- A short screen recording at a public URL showing the agent handling START,
  STOP and HELP, plus one example conversation. Carrier review asks for it.
- Opt-in details: how people consent (website form, text, sale point), the
  call-to-action wording and its URL/screenshot, and the opt-in, help and
  opt-out replies.

## 2. Register the brand

In the Telnyx portal's RCS section, or by API: `POST /v2/rcs/brands` then
`POST /v2/rcs/brands/{id}/submit`. Telnyx sends it for external verification.
Wait for brand status `VERIFIED` before step 3.

## 3. Create the agent and submit its basics

Same place, or by API: `POST /v2/rcs/agents` then
`POST /v2/rcs/agents/{id}/submit`. Basics are the display name, description,
logo, hero image, brand color, a phone/website/email contact, privacy policy
and terms. Pick use case `MULTI_USE` or `TRANSACTIONAL` to match how reps
text sellers; set the agent's messaging profile to the one in step 1.

## 4. Add test devices and test

Add your own Android phones as test devices (`POST /v2/rcs/agents/{id}/test_devices`)
and accept the invite on each phone. Testing works before carrier approval,
so Talkr can be exercised against those phones as soon as step 6 is done.

## 5. Submit for launch (carrier approval)

`POST /v2/rcs/agents/{id}/launch` with the campaign section (company and agent
overview, interaction types such as `TWO_WAY_CONVERSATION`, message examples,
consent settings) and the testing section (the video URL from step 1).
Follow progress with `GET /v2/rcs/agents/{id}` and
`GET /v2/rcs/agents/{id}/carrier_approvals`; the agent moves through
`SUBMITTED → VERIFYING → VERIFIED → LAUNCHING → LAUNCHED/LIVE`.

**Timeline.** Telnyx does not publish a fixed duration: "Review duration
depends on the brand, use case, and carriers." Plan for brand verification
first, then per-carrier approval, and expect weeks rather than days in total.
Carriers may approve at different times; until a carrier approves, its
subscribers get the SMS fallback.

## 6. Point the agent's webhook at Talkr

Inbound RCS messages go to the URL on the agent, not the messaging profile.
Set it (portal, or `PATCH /v2/messaging/rcs/agents/{agent_id}`):

```
webhook_url = {PUBLIC_BASE_URL}/webhooks/telnyx/inbound-sms
```

Delivery and read receipts need nothing: Talkr puts
`{PUBLIC_BASE_URL}/webhooks/telnyx/sms-status` on every RCS send. Both
endpoints already verify Telnyx's Ed25519 signature.

## 7. Turn it on in Talkr

1. Set `TELNYX_RCS_AGENT_ID` to the agent id (the `agent_id` RCS sends use,
   shown on the agent in the portal). Optionally set
   `TELNYX_RCS_INBOUND_NUMBER` to the Talkr number that should receive RCS
   replies from people who have no earlier RCS thread.
2. Redeploy.
3. Switch RCS on for each line that should use it:
   `PATCH /v1/numbers/{id}` with `{"rcs_enabled": true}`.

From then on a text from that line goes as RCS when Telnyx's capability check
says the handset supports it, and as SMS otherwise. Every RCS send carries an
SMS fallback from the same line, so a stale capability answer still reaches
the person.

## What is not built yet

- Rich cards, carousels and suggested replies: Talkr sends plain RCS text.
  A tapped suggestion arrives as its text.
- RCS with an attachment: a message with media keeps the MMS path.
- The capability check's negative answer (empty `features` vs HTTP 404) is
  inferred from the API reference and not yet seen on a live agent; both are
  treated as "no RCS", anything else as "unknown" (sent as SMS).
