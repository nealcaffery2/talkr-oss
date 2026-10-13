# Telnyx setup

What to create in the Telnyx portal, which value goes in which environment
variable, how a call actually flows on Telnyx, and the go-live runbook. Telnyx is the
only carrier (Talkr previously ran on Twilio). Portal work is done once.

Sources: Telnyx's own TeXML + WebRTC demo (`team-telnyx/demo-texml-webrtc-tool`),
the TeXML verb reference, the telephony-credentials, number-search and
number-order APIs, and `@telnyx/webrtc` 2.27. Where the platform's behaviour is
not yet confirmed against a live account it says so.

---

## 1. Account and API key

1. Sign up at [portal.telnyx.com](https://portal.telnyx.com) and complete
   verification (the account has to be approved before it can buy numbers or
   place calls). Voice and messaging both need a funded balance.
2. **API Keys** → create a V2 key → `TELNYX_API_KEY`.
3. On the same page, copy the **public key** → `TELNYX_PUBLIC_KEY`.

> These are two different credentials from two different fields. The API key
> authenticates our calls *out*; the public key verifies webhooks coming *in*
> (Telnyx signs with Ed25519, so we only ever hold the public half). Swapping
> them produces a 401 that looks like a bad API key. This is the single most
> common first-run failure.

4. Your **account id** is on the account page → `TELNYX_ACCOUNT_ID`. It is also
   delivered on every TeXML webhook as `AccountSid`, so it can be read back
   from a request if you lose it.

## 2. TeXML application — how calls reach our server

**Voice → Programmable Voice → TeXML Applications → Create**.

Set the **Voice URL** (POST) to:

```
https://api.talkr.example.com/twiml/outbound-dial
```

and the **Status callback URL** (POST) to:

```
https://api.talkr.example.com/webhooks/telnyx/voice-status
```

Copy the application id → `TELNYX_TEXML_APP_ID`.

Every number the platform buys is attached to this application (§7), so
inbound calls to any of them hit the same Voice URL. Our server tells an
inbound call from an outbound one by its parameters, not by the URL.

> An app or profile set up before the rename may still point at
> `/webhooks/twilio/…`. That path is still served, and the server moves both to
> `/webhooks/telnyx/…` on boot. TeXML posts Twilio-compatible field names
> (`CallSid`, `CallStatus`, …), which is what the handlers read.

## 3. SIP connection — how reps' browsers register

**Voice → SIP Connections → Create SIP Connection**, type **Credentials**.

- Under **Inbound**, set **Destination Number Format** to **SIP Username**.
  Without this, a call sent to a rep's SIP username will not reach their
  browser.
- Set **Receive SIP URI calls** (`sip_uri_calling_preference`) to
  **From your Account** / `internal`. The default is `disabled`. Talkr's
  outbound path has the TeXML app dial `sip:gencred…@sip.telnyx.com` on this
  connection; with the preference left off, Telnyx answers **403**, the status
  callback reports `SipHangupCause=403`, and CLOZR shows the call as **busy**
  in about a second. Bootstrap creates and reconciles this as `internal`.
- Under **Outbound**, attach an **Outbound Voice Profile** (any). The browser
  never dials out on its own (see §6), but the connection will not save
  without one.
- Leave the SIP subdomain blank unless you have a reason; reps are addressed
  at the shared `sip.telnyx.com`. If you do set a subdomain, put it in
  `TELNYX_SIP_DOMAIN`.

Copy the connection id → `TELNYX_SIP_CONNECTION_ID`.

This connection is what browser credentials are minted against. The platform
creates one **telephony credential per rep** and stores the generated SIP
username in `telephony_credentials` — Telnyx generates that username
(`gencred…`), it is not ours to choose. Nobody presses anything for it: the
credential is minted at boot for every rep who lacks one, when a rep is added
to the team, and when a rep loads the app (`/v1/me`), so ring groups can reach
everyone from the moment the carrier is switched. The softphone itself also
connects on its own when the app opens, in both the Talkr web app and CLOZR.

## 4. Messaging (only if you want SMS)

**Messaging → Messaging Profiles → Create**. Set its inbound webhook URL to:

```
https://api.talkr.example.com/webhooks/telnyx/inbound-sms
```

Copy the profile id → `TELNYX_MESSAGING_PROFILE_ID`. Numbers the platform
buys are attached to it automatically (§7).

**A2P 10DLC.** US carriers block texts from unregistered local numbers on
every provider. Register on Telnyx (**Messaging → 10DLC**: register the brand,
then a campaign, then assign the numbers). Until it is approved, expect texts
to US mobiles to fail; calling is unaffected.

## 5. Settings

Eight values, by either route:

```
VOICE_PROVIDER=telnyx
TELNYX_API_KEY=...
TELNYX_PUBLIC_KEY=...
TELNYX_ACCOUNT_ID=...
TELNYX_TEXML_APP_ID=...
TELNYX_SIP_CONNECTION_ID=...
TELNYX_MESSAGING_PROFILE_ID=...      # SMS only
TELNYX_SIP_DOMAIN=sip.telnyx.com     # only if you set a subdomain
```

**As environment variables** on the API host (e.g. its Vercel project),
then redeploy.

**Or as rows** in `runtime_settings` (migration `0021`), one per name, read
at boot. A real environment variable always wins over the row of the same
name, so on a host where `VOICE_PROVIDER` is unset the row decides. This is
the route that needs no access to the host at all: insert the rows, and the
next cold start runs on Telnyx. The allow-list of keys is in
`apps/server/src/services/runtime-settings.ts`; nothing else in the table is
read.

**§2–§4 happen on their own.** Two rows are enough: `VOICE_PROVIDER = telnyx`
and `TELNYX_API_KEY`. At the next boot the server sees the ids are missing and
creates the outbound voice profile, the credential SIP connection (SIP-username
destination format), the TeXML application (Voice URL and status callback set)
and the messaging profile, reads the account's public key and id from the
API, and writes all of it back as rows
(`apps/server/src/services/telnyx-bootstrap.ts`). Anything already present
under our names is reused, so nothing is duplicated. If a step fails, the
server boots with no carrier and `TELNYX_BOOTSTRAP_ERROR` says why.

The serverless deployment re-reads the rows within a minute of a change
(`/internal/tick` compares the table's latest `updated_at` to the one it
booted with), so no redeploy is needed for a row to take effect.

`VOICE_PROVIDER` accepts `telnyx` (the default) or `none`; a leftover
`twilio` value is read as `telnyx`.

`GET /health/deep` reports `provider: "telnyx"` once the deployment has picked
the change up. Vercel instances are recycled within minutes; a redeploy from
the Vercel dashboard forces it.

## 6. How a call is placed on Telnyx

The browser does not dial the call itself (`apps/web/lib/softphone-engine.ts`,
mirrored in CLOZR and the Chrome extension). A Telnyx WebRTC endpoint dials phone numbers and
SIP URIs — it cannot address our TeXML application with a call id. So the
server opens the rep's leg instead, the same way Telnyx's own demo does:

1. Browser: `POST /v1/calls` → the call record (suppression, quiet hours,
   caller ID all decided here, as before).
2. Browser: `POST /v1/calls/:id/browser-leg`. The server REST-dials the
   rep's SIP address (`sip:gencred…@sip.telnyx.com`) **from** the call's
   caller ID, with the answer URL
   `/twiml/outbound-dial?talkr_call_id=<id>`.
3. The rep's browser receives an invite from its own caller ID while it has
   that call pending, answers it silently (no ringtone), and the softphone
   shows "connecting".
4. The dial carries the call's conference TeXML inline (`Texml` on the
   create-call request), so the answered leg joins the call's room without a
   round trip to us; the answer URL rides along as the fallback for a carrier
   that insists on fetching one.
5. Telnyx posts the room's `participant-join` callback for that leg. That is
   the first moment the room exists — and Telnyx's participant REST addresses
   a room by its id, never by the name the `<Conference>` noun gave it — so
   the callback is where the seller is dialed (`dialCustomerOnAgentJoin` in
   `services/conference-dial.ts`). The queued `conference-dial-customer` job
   recovers a callback that never arrives or a dial the carrier refused.

`/v1/voice/token` returns the Telnyx login token with `provider: "telnyx"`
and `browser_leg: "server"` (the server opens the leg).
Inbound calls are unchanged: TeXML `<Dial><Sip>` rings the rep's SIP address
with the seller's number as caller ID, and an invite that is not from the
org's own number is offered as an incoming call.

## 7. Numbers

Buy them from the product, not the portal: **CLOZR → Settings → Phone** (or
the Talkr web app's Numbers page) searches Telnyx inventory by area code and
buys with one click. A purchase places a number order attached to the TeXML
application (§2) and, when configured, the messaging profile (§4), so a
bought number rings the server and texts reach the inbox with nothing else to
set. Telnyx fulfils orders asynchronously; the platform polls for the owned
number for a few seconds and falls back to the E.164 as the carrier id when
it has not settled yet — releasing by either works.

If you buy in the portal instead, import it: **CLOZR → Settings → Phone
numbers → Import from carrier** (`GET /v1/numbers/carrier` lists what the
account owns that Talkr does not; `POST /v1/numbers/import {phone_e164}`
verifies ownership, attaches the number to the TeXML application and the
messaging profile exactly as a purchase does, and records it — safe to repeat).

Inbound calls to every attached number arrive at the application's one Voice
URL, `/twiml/outbound-dial`; a request with `Direction=inbound` and no
`talkr_call_id` is handed to the inbound router (`/twiml/inbound`), which runs
the number's call flow (`phone_numbers.ivr` version 2) or the default chain.

## 8. Go-live runbook

Order matters only in that the deployment must not say `telnyx` before the
portal pieces exist.

1. Portal: §1 (API key and public key). Then either §2–§4 by hand or the
   bootstrap script in §5.
2. Settings: the eight values from §5, as `runtime_settings` rows or Vercel
   variables. Confirm `GET /health/deep` shows `provider: "telnyx"`.
3. Credentials mint themselves at the first boot on Telnyx. Confirm rows
   appear:
   ```sql
   SELECT user_id, sip_username FROM telephony_credentials WHERE provider = 'telnyx';
   ```
4. Buy at least one Telnyx number (§7) and make it the default caller ID
   (Settings → Phone → assign / set default). Numbers left over from the
   Twilio era may still be listed under `provider = 'twilio'`; they cannot be
   dialed *from*, so unassign or release them from Settings.
5. First call: dial your own mobile from CLOZR. Watch `webhook_events` and
   `call_events` fill in with `provider = 'telnyx'`. Then call the Telnyx
   number back and check it rings the browser.
6. Porting a number in from another carrier: **Numbers → Port a number** in
   the Telnyx portal. Ports take days. When the port completes, attach the
   number to the TeXML application and update its `provider` /
   `provider_number_id` in `phone_numbers`.

## 9. Migrations

The Vercel deployment does not run migrations at boot (see `deploy.md`). Apply
any unapplied file in `packages/db/migrations/` by hand, and record it:

```sql
INSERT INTO _talkr_migrations (name) VALUES ('0011_telephony_credentials.sql');
```

Go-live needs `0021_runtime_settings` if the settings go in as rows;
`telephony_credentials` and the `provider` column on `phone_numbers` already
exist.

---

## Two REST shapes on one host, because this bites

Everything is on `https://api.telnyx.com/v2` with the API key as a Bearer
token, but the TeXML resources keep Twilio's shape:

| Surface | Path | Body |
|---|---|---|
| TeXML REST (calls, conferences, participants) | `/v2/texml/Accounts/{account_id}/…` | form, PascalCase in; snake_case JSON out |
| Telnyx native (create call, credentials, messaging, numbers) | `/v2/…` | JSON, snake_case |

Two things a live account taught us. The Twilio-style `/2010-04-01/Accounts/…`
path the adapter first used answers 404 for conferences, so no seller was ever
dialed after the cutover. And a conference is addressed by its own id in every
REST path — `Conferences/{conference_sid}/Participants` — not by the friendly
name our `<Conference>` noun gave it; the adapter resolves the name with
`GET /Conferences?FriendlyName=…` (or is told the id by the conference-status
callback) before it touches participants.

## Still unverified against a live account

- Exact response field names on the TeXML REST surface (the adapter reads
  both `sid` and `call_sid`, and both cases of `Hold`/`Muted`).
- Whether `POST /v2/texml/calls/{app}` returns a call sid. Telnyx documents
  the response as `{from, to, status}`; the adapter tolerates no sid and the
  first webhook binds the provider id instead.
- Whether TeXML's `<Sip>` accepts our `statusCallback` attributes on every verb
  the routing code uses.
- AMD (`MachineDetection`) parameter spelling.
- The owned-number record's `features` shape after an order (the adapter
  accepts both `["sms"]` and `[{name: "sms"}]`).
- Call flows: `url` (whisper) on `<Sip>`/`<Number>`; `<Dial callerId>` set to
  the *caller's* number when forwarding to a teammate's personal phone (Telnyx
  may require an owned or verified number — if forwards fail, switch the
  forward's callerId to the called Talkr number in `renderFlow`); and whether
  the Dial `action` request carries `CallStatus=completed` when the caller
  hangs up mid-ring (the missed-call text keys on it).

Each is isolated — the paths in one object, the noun rendering in one method —
so a correction is one edit rather than a hunt.
