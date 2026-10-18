# Talkr — Chrome extension (package: talkr-voice)

The softphone as a browser extension: a toolbar **popup** for dialing and
texting, and a **side panel** that sits beside the CRM for the duration of a
call. Both are React + TypeScript, built with Vite into a plain MV3 bundle.

## Why there is an offscreen document

MV3 destroys a popup the instant it closes and can evict the service worker at
any time. Neither can hold a WebRTC session, so a call started from the popup
would drop the moment the rep clicked away.

`src/offscreen/` is the fix and the heart of this extension: an offscreen
document owns the carrier client, the media leg, and the authoritative
snapshot. The popup and the side panel are thin views — they send commands to
it and render the snapshots it broadcasts. Both can be open at once and stay in
step, because neither holds call state of its own.

```
popup.html ─┐                        ┌─ carrier client (WebRTC)
            ├─► service worker ─────►│  media leg
sidepanel ──┘   (ensures it exists)  └─ CallSnapshot ──► broadcast to both UIs
                                        offscreen.html
```

## Which carrier

Telnyx is the only carrier. `POST /v1/voice/token` returns a Telnyx WebRTC
login token and `src/offscreen/engine.ts` wraps Telnyx's SDK — a port of
`apps/web/lib/softphone-engine.ts`, kept deliberately line-for-line alike so a
fix applies to both.

On an outbound call the server opens the rep's leg (`browser_leg: server`): a
WebRTC endpoint dials numbers, not our TeXML app, so the extension asks the
server to ring *this browser* (`POST /v1/calls/:id/browser-leg`) and answers
the invite that arrives from our own caller ID.

Talkr previously also ran on Twilio; this extension once loaded Twilio's SDK
unconditionally, which is why no call could be placed from it against a Telnyx
deployment until the engine existed.

Call *control* — hold, add call, merge, warm/blind transfer — is not done in
the browser at all. Those are server operations on the call's conference room
(`docs/telephony-events.md` §9); the extension calls the same `/v1` endpoints
the web app does and re-reads the roster afterwards.

## Build

```bash
npm install
npm run build        # typecheck + both vite builds → dist/
npm run dev          # rebuild the extension pages on change
npm run dev:content  # …and the content script, in a second terminal
npm run package      # build, then zip dist/ → talkr-voice.zip for hand-out
```

There are two builds because the content script cannot be an entry in the
first one: a content script is loaded as a classic script, so it may not
`import` the shared chunk the main build would split out for it (the number
detector is used by the worker too). `vite.content.config.ts` emits one IIFE
with everything inlined, into the same `dist`.

Then in Chrome: **chrome://extensions → Developer mode → Load unpacked →
`apps/extension/talkr-voice/dist`** (or drop `talkr-voice.zip` onto that page).

## Signing in

The quickest way in is not the form. **Open a CLOZR tab and the extension signs
itself in** with the same account — see *Working with CLOZR* below.

Otherwise the popup opens on a sign-in screen. Reps sign in with the **email and
password** of their Talkr workspace account (Supabase Auth, proxied by the
API's `/v1/auth/login` so the extension only ever talks to one origin), or with
**Continue with Google** when the server offers it. The
session — access token, refresh token, who you are — is held by the service
worker in `chrome.storage.local`, scoped to this browser profile, and renewed
automatically before it expires.

The gear button in the header opens **Account**: name, email, organization,
role, your assigned number, local zone, softphone status, the API in use, and
**Sign out**. Signing out tears the softphone down so a shared machine stops
ringing for the previous rep.

**Continue with Google** appears only when `GET /v1/auth/config` says
`google_signin` is on, so the button cannot show up half-configured. The
extension asks Google for an `id_token` through `chrome.identity` — there is no
redirect URI for an extension to host, so it uses the
`https://<extension id>.chromiumapp.org/` loopback — and the API trades that
token for a Supabase session. It is also how a rep who was only ever invited by
email gets in: that first sign-in claims their row and activates it, with no
password ever issued. Setup is in `docs/deploy.md`.

`manifest.json` ships **without** a `key`. Add your own before you hand the
extension out: a `key` fixes the extension id on every machine. An unpacked
extension without one takes its id from the folder path, so every rep would get
a different id and Google's registered redirect URI would match none of them.
Generate a key pair, put the base64 public key in `"key"`, and register
`https://<your extension id>.chromiumapp.org/` with Google.

**Advanced** on the sign-in screen (shown automatically when the server has
neither password nor Google sign-in configured) takes an API URL and a pasted
access token — for a developer against a local API, or an org that mints JWTs
elsewhere.

Whichever way you sign in, press **Enable softphone** once. This asks for the
microphone *from the popup* on purpose — an offscreen document has no UI, so
Chrome will never show a permission prompt for it, and the grant has to be
made from a visible extension page. Once given it sticks, and later calls
open the mic without the popup being involved.

If the API is not on `http://localhost:4000` or a `*.vercel.app`,
`*.up.railway.app`, `*.fly.dev` or `*.onrender.com` host, add its origin to
`host_permissions` in `public/manifest.json` and rebuild — the extension cannot
reach an origin it has not declared.

## Why the session lives in the service worker

Three contexts need the token — popup, side panel, and the offscreen document
that holds the Telnyx voice credential — and the offscreen document **has no
`chrome.storage` at all**. So every context asks the service worker for the
session over `chrome.runtime` messaging (`src/shared/session.ts`), and the
worker alone reads storage, refreshes, and broadcasts changes. That single
owner is also what makes refresh safe: refresh tokens are single-use, and two
surfaces racing to redeem the same one would sign the rep out.

## Surfaces

- **Popup** (400×620, design 1a) — Dial / Messages / Lead. The dial tab moves
  through dialpad → ringing → the active-call control grid, with the tone dial
  and the transfer sheet as overlays. Messages is the iPhone-style thread with
  templates. Lead shows the counterpart's local time against the 9a–8p calling
  window.
- **Side panel** (design 1b) — the same call, laid out to stay open: an inline
  4-across control grid, the live conference roster, the transfer list with
  every teammate's local time, and call notes.

## Call context

The moment a call rings or connects, both surfaces pull up who it is and what
to say. The data is one read of **`GET /v1/call-context`** — the same endpoint
the web dialer's CallContext panel uses, so the two agree — keyed by the
platform **call id** when the snapshot has one (an outbound call from its
first moment; an inbound call once accepted) and by the other party's
**phone** otherwise (an inbound call still ringing). The result is cached per
call in `src/shared/callContext.ts`; switching tabs, reopening the panel or
having both surfaces up never re-reads it, and an inbound call carries its
by-number entry over when it gains an id on accept. If the id read fails the
number is tried, because a number beats an empty panel.

In the **side panel** the body under the control grid is tabbed:

- **Lead** — name (or *Unknown number* with a quick-add that `POST`s
  `/v1/contacts`), type / status / temperature badges and score, tags,
  address and lead status, rep, sequence chips, campaign, a CRM link that
  opens in a new tab, the last call's summary, the contact's notes (saved on
  blur with `PATCH /v1/contacts/:id`), status and temperature selects (same
  `PATCH`), the last ten activity rows and any open tasks.
- **Script** — the primary script the server matched to this contact and
  campaign, merge fields already filled in, rendered from its light markdown
  (`##` sections fold, `- ` bullets, `> ` asides, `**bold**`) with a text
  size toggle; a dropdown of alternatives, fetched by id and rendered here
  from `merge_fields`; **Mark used** records it against the call.
- **Objections** — every matched rebuttal, searchable and filterable by tag,
  each expanding to its rendered body with a **Used it** button
  (`POST /v1/scripts/:id/used`). The last call's objections are offered as
  one-tap searches.
- **Call** — the conference roster, the transfer list and the panel's own
  scratch notes, where they were before.

The panel opens on **Lead** while a call rings and switches to **Script** the
moment an outbound call connects, unless the rep has already picked a tab.
Badge colours follow `apps/web/components/contacts.tsx`.

The **popup** shows a one-line strip — name · address · temperature — on a
ringing or live call, with an **Open side panel** button when the panel is
not already up in this window, and names the contact under a number as it
is typed (debounced, same endpoint).

## Click to call, on any page

A rep works a list in whatever the seller's county put on the web, so every
phone number on every page is dialable. Four ways in, cheapest first:

- **`tel:` links** are intercepted where they are — nothing is rewritten, the
  call just stops going to FaceTime or Skype.
- **Numbers in text** are wrapped in a clickable span with a dotted underline.
  This is the only part that touches the page, so it is the careful part:
  `src/content/phone-numbers.ts` decides what counts as a number and
  `test/phone-numbers.test.ts` is where that judgement is kept honest. Invoice
  totals, dates, versions, ZIP+4 and tracking numbers are not phone numbers.
  Editable regions, `<input>`, `<code>` and existing links are never rewritten.
- **A selection** anywhere — a form field, a table the page drew itself, a
  number the detector was too careful to mark up — raises a floating **Call**
  button. This is the escape hatch that makes the careful detector affordable.
- **Right-click** a selection or a `tel:` link for *Call with Talkr*.

The overlay lives in a closed shadow root, so no page stylesheet can restyle it
and no page script can reach in. Account → **Click to call** has a switch for
the current site and one for all of them; both take effect without a reload,
and switching off puts the page back exactly as it was.

The content script never places a call itself — it has no session and no
carrier client. It asks the service worker, which answers with a refusal a rep
can act on: signed out, softphone not enabled, already on a call.

## Working with CLOZR

CLOZR and this extension are two front ends over the same Talkr account. Before
the bridge a rep signed in twice and ended up with two softphones registered
under one identity, which is how an inbound call rings in a tab nobody is
looking at.

CLOZR already signs its Talkr requests with the rep's own Supabase access
token, which Talkr verifies as a partner identity and links by email
(`apps/server/src/auth.ts`). That token is all the extension needs, so an open
CLOZR tab hands it over:

- CLOZR marks itself with `data-talkr-bridge="clozr"` on `<html>`. That is why
  there is no list of CLOZR origins to maintain — a preview deployment, a
  custom domain and `localhost:3000` all work the moment CLOZR says so.
- **Credentials only travel page → extension.** The extension never posts a
  session or a rep's data onto the page.
- **An offer is a claim, not a fact.** Every offered token is verified against
  `GET /v1/me` before it is stored, so a page can only get the extension signed
  in as whoever Talkr says that token is.
- **A rep already signed in by hand is never replaced** underneath them.
- **Renewal is re-reading the tab.** A Supabase refresh token is single-use and
  belongs to CLOZR; redeeming it here would sign the rep out of the CRM. The
  tab renews as it always did and the worker asks it for what it has.

While the extension's softphone is registered it says so, and CLOZR stands its
own down rather than registering a second one. Calls placed here are mirrored
onto the CLOZR page as they ring, connect and end, so the record is not the
last to know what its own phone did.

## Only the rep's own calls and texts

The extension is one rep's phone. An owner or admin's Talkr lists are the whole
office's, so Inbox, Recents and Voicemail keep only the signed-in rep's, by
the same rules as CLOZR's inbox (`src/shared/owner.ts`, CLOZR's
`lib/inbox-owner.ts`):

- **A text thread** is the rep's whose line carries it; on a shared line, the
  assignee's. The inbox reads the threads assigned to the rep plus the threads
  on each of their lines (`api.listMyConversations`).
- **A call** is the rep's who handled it. One nobody picked up (missed, a
  voicemail) is whoever the voicemail was for, else the owner of the line it
  rang. The server applies the same rule to its "own" scope
  (`apps/server/src/services/call-owner.ts`), so a rep can see and play the
  voicemails left on their own number.

**Line filter.** With more than one line in play, the Inbox has a line picker
(CLOZR's `line` filter): only the threads and calls on that number. The
options are the rep's own lines plus any line one of their threads is on
(`src/shared/lines.ts`).

## Texting from a line

A thread's composer says which line the text leaves from. It defaults to the
line already carrying the thread, so the seller keeps one conversation, or to
the rep's default on a new one (CLOZR's `lib/thread-line.ts`; a transaction
coordinator texts on her own line rather than a teammate's). The rep can pick
any of their own lines instead; the pick is sent as `from_phone_number_id` and
stands until another thread is opened.

## Presence and Do not disturb

The status under *Talkr* in the popup header is a picker: **Available**, **Do
not disturb** or **Away**, the same three as CLOZR (`src/shared/presence.ts`).

- The offscreen document's 30-second heartbeat (`POST /v1/presence`) sends
  `available` only when Available is picked and the softphone is registered;
  otherwise `away`. A change is sent at once.
- **Do not disturb** declines every incoming call in the offscreen document,
  including one already ringing when it is turned on, so the caller reaches
  voicemail. Dialling out is unaffected.
- The pick lives in `chrome.storage` (`talkr_presence`) via the service worker,
  since the offscreen document has no storage API. The worker hands it to the
  document each time it creates one, and it survives sign-out.

## Notifications, ringing and the toolbar badge

The offscreen document keeps Talkr's live stream open (`GET /v1/events/stream`,
`src/offscreen/live.ts`) and rings incoming calls itself
(`src/offscreen/ringtone.ts`); the service worker raises the Chrome
notifications:

- **Incoming call:** a notification with *Answer* / *Decline*, and a ring, with
  the popup shut.
- **New text or voicemail** that is the rep's own: a notification; clicking it
  opens the popup on Inbox or Voicemail. An admin is not alerted to the rest of
  the office's.
- **Badge:** the number of the rep's threads with something unread.
- An open popup re-reads its lists when the stream says something moved, and
  an open thread shows a reply as it lands.

**With CLOZR open** nothing doubles up: CLOZR stands its softphone down while
this one is registered (so only one rings), and CLOZR already chimes for texts
and voicemail, so the extension's text and voicemail notifications arrive
silent while a CLOZR tab is open.

## Smoke test before handing it out

Nothing here is covered by `npm run build` — a carrier, a microphone and
somebody else's web page are not things a typecheck has an opinion about. Run
these in order against a real deployment; each step tells you which piece is
broken when it fails.

1. **Load it.** `npm run build`, then chrome://extensions → Load unpacked →
   `dist`. The service worker should say *Active* with no errors.
2. **Sign in from CLOZR.** Open a CLOZR tab, signed in. Open the Talkr popup:
   it should already be signed in as you. Account → *Session* reads **Signed
   in through CLOZR**. — If it still asks for a password, CLOZR is not setting
   `data-talkr-bridge`, or `/v1/me` refused the token (check
   `PARTNER_JWKS_URL` / `PARTNER_JWT_ISSUER` on the Talkr server).
3. **Enable the softphone.** Press *Enable softphone* in the popup and allow
   the microphone. Account → *Carrier* should read **telnyx** in production.
   — If it stays *Not connected yet*, check the server is not on
   `VOICE_PROVIDER=none`; if it never
   leaves *Connecting*, the carrier refused the credential.
4. **Place an outbound call.** Dial a number you can answer. On Telnyx the
   server rings this browser and the extension answers silently, so what you
   should hear is ringing and then the far end — no second prompt. — A
   *"carrier did not ring this browser in time"* means the server-leg dial
   failed; check the credential connection's **Receive SIP URI calls** setting
   (README of the platform, Telnyx section). A *"softphone rejected the carrier
   ring-back (busy)"* means another softphone on the same account (a CLOZR tab
   or the web dialer) answered 486 on the fork — close or stand down the other
   one and try again.
5. **Close the popup mid-call.** Audio must keep going. That is the offscreen
   document doing its job.
6. **Take an inbound call.** Ring your Talkr number with everything closed.
   It should ring and raise an *Incoming call* notification; *Answer* on it
   connects. The popup should show the caller, with the contact's name if
   Talkr knows them. — No notification: Windows/macOS notifications for Chrome
   are off, or Focus Assist is on.
7. **Text and voicemail.** Text your Talkr number, then call it and leave a
   voicemail. Each raises a notification and the badge counts the unread
   thread. Signed in as an admin, a text to a teammate's line must not.
8. **One softphone.** With the extension's softphone up, the CLOZR tab's
   dialer should say calls are running through the extension, and dialling
   there should hand the call over rather than opening a second one.
9. **Click to call.** On any page with a phone number on it — a county
   appraisal district site is the honest test — the numbers carry a dotted
   underline; clicking one dials it. Then check it has *not* marked up an
   invoice total, a date or an order number. Select a number inside a form
   field and use the floating Call button. Right-click a `tel:` link.
10. **Do not disturb.** Set the header status to *Do not disturb* and ring
   your Talkr number: nothing rings and the caller reaches voicemail. Set it
   back to *Available* and it rings again.
11. **Switch it off.** Account → Click to call → toggle this site off. The
   underlines disappear and the page is back exactly as it was.

## Known limits

- **Call notes in the panel are local.** Saving them against the call needs the
  notes endpoint, which is not wired up yet. Notes about the *person* are on
  the Lead tab and are saved to the contact.
- **Dispositions are set in the web app**, not here.
- **Outbound MMS** is not supported — the send endpoint takes no media.
- The roster is **polled every 2s while a call is up** rather than streamed;
  an offscreen document is not a good place to hold an SSE connection Chrome
  may suspend.
- Click-to-call **guesses at NANP only**. A bare ten-digit run is read as a US
  number; anything international has to carry its own `+`, because guessing a
  country from a seven-digit local number is how a rep dials a stranger.
- The wrapper **cannot reach text a page draws itself** — a canvas, a PDF
  viewer, a cross-origin frame that blocks injection. Selecting the number and
  using the floating Call button is the answer there.
