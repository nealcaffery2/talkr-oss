# Talkr setup guide

This guide takes you from a fresh checkout to a production deployment with
calling, SMS, sign-in, AI features, the Chrome extension and (optionally) the
CLOZR partner connection. Each step ends with a check.

Placeholders used below:

| Placeholder | Meaning |
|---|---|
| `https://api.example.com` | Your Talkr API (apps/server) |
| `https://app.example.com` | Your Talkr web app (apps/web) |
| `https://clozr.example.com` | Your CLOZR deployment, if you use it |
| `Your Company` | Your organization's name |
| `owner@example.com` | The first admin's email |
| `+15555550100` | A phone number |
| `<your-extension-id>` | The 32-letter Chrome extension ID from step 9 |

If you are working with an AI coding assistant, hand it
[SETUP-WITH-AI.md](SETUP-WITH-AI.md) instead; it covers the same steps.

## Contents

1. [Prerequisites](#1-prerequisites)
2. [Get the code and install](#2-get-the-code-and-install)
3. [Postgres](#3-postgres)
4. [Migrations](#4-migrations)
5. [Supabase Auth and the first workspace](#5-supabase-auth-and-the-first-workspace)
6. [Server environment variables](#6-server-environment-variables)
7. [Deploy the API and the web app](#7-deploy-the-api-and-the-web-app)
8. [Telnyx](#8-telnyx)
9. [Build and load the Chrome extension](#9-build-and-load-the-chrome-extension)
10. [Google sign-in](#10-google-sign-in)
11. [Transcription and AI (Deepgram, Anthropic)](#11-transcription-and-ai-deepgram-anthropic)
12. [Talkr Coach (optional, separate system)](#12-talkr-coach-optional-separate-system)
13. [Connect CLOZR (optional)](#13-connect-clozr-optional)
14. [Verify end to end](#14-verify-end-to-end)
15. [Troubleshooting](#15-troubleshooting)

## 1. Prerequisites

- Node.js 20 or later (`engines` in `package.json`; the Dockerfile uses `node:22-alpine`) and npm.
- Postgres 16. Local for development; any managed Postgres for production.
- A Supabase project for user sign-in (Supabase Auth). The database itself can be elsewhere.
- A host for the API: anything that runs the root `Dockerfile` (Fly.io, Railway, Render, a VM) or Vercel (`apps/server/vercel.json`).
- A host for the Next.js web app (`apps/web/vercel.json` targets Vercel).
- For calls and texts: a Telnyx account, verified and funded.
- Optional: Deepgram and Anthropic API keys; a Google Cloud project for Google sign-in; Chrome 116 or later for the extension (`minimum_chrome_version`).
- `zip` on your PATH for `npm run package` in the extension folder.

## 2. Get the code and install

```bash
# from the repository root
npm install            # root workspaces: packages/*, apps/server, apps/web
npm run typecheck      # packages/core, packages/db, packages/provider-telnyx, apps/server
```

**Check:** `npm run typecheck` exits with code 0 and prints no errors.

`apps/extension/talkr-voice` and `apps/api` are separate npm projects; you
install them in their own steps.

## 3. Postgres

### Local (development and tests)

```bash
initdb -D ~/talkr-pg && pg_ctl -D ~/talkr-pg -o '-p 5544' start
createdb -h 127.0.0.1 -p 5544 -U postgres talkr_platform
createdb -h 127.0.0.1 -p 5544 -U postgres talkr_platform_test
```

Port 5544 matches `apps/server/.env.example` and the test default
(`TEST_DATABASE_URL`). Any port works if you change the URLs.

### Production

Create a Postgres 16 database and note its connection string for
`DATABASE_URL`. On Supabase, use the connection string from the dashboard
(the docs mention the transaction pooler on port 6543, or a direct
connection).

- Realtime updates (`GET /v1/events/stream`) use Postgres `LISTEN/NOTIFY`, which
  does not work through a transaction-mode pooler. With a long-running server,
  prefer a direct or session connection. Clients fall back to re-reading when
  the stream drops.
- On the serverless deployment you can set `DATABASE_URL_FALLBACK` to a second
  connection string that is tried if the first fails at boot.

**Check:** `psql "$DATABASE_URL" -c 'select version();'` reports PostgreSQL 16.

## 4. Migrations

Platform migrations live in `packages/db/migrations/*.sql`. They apply
automatically, in filename order, inside one transaction under an advisory
lock, whenever any of these start:

- `npm run start -w apps/server` / `npm run server:dev`
- `npm run worker -w apps/server` / `npm run worker:dev`
- `npm run seed -w apps/server` and `npm run seed:demo -w apps/server`
- the serverless function (`apps/server/src/serverless.ts`)

Applied files are recorded in the table `_talkr_migrations`.

**Check:**

```bash
psql "$DATABASE_URL" -c 'select count(*) from _talkr_migrations;'
ls packages/db/migrations/*.sql | wc -l
```

The two numbers match after the first boot.

To apply a file by hand (for example from a database console), run its SQL and
record it:

```sql
INSERT INTO _talkr_migrations (name) VALUES ('0021_runtime_settings.sql');
```

Talkr Coach has its own schema in `supabase/migrations/` (step 12). Do not
apply it to the Platform database.

## 5. Supabase Auth and the first workspace

Talkr users are Supabase Auth users. The API proxies sign-in to Supabase
(GoTrue), so browsers only ever talk to the API and the anon key never ships in
a bundle. A Supabase user can use Talkr only if a row in Talkr's `users` table
has the same email.

### 5.1 Collect the Supabase values

From your Supabase project's dashboard (project settings, API and JWT
sections):

| Supabase value | Talkr variable |
|---|---|
| Project URL, `https://<project-ref>.supabase.co` | `SUPABASE_URL` |
| anon / publishable key | `SUPABASE_ANON_KEY` |
| JWT secret (legacy HS256 secret) | `AUTH_JWT_SECRET` |
| service_role key (optional, server only) | `SUPABASE_SERVICE_ROLE_KEY` |

If your project signs tokens with asymmetric JWT signing keys, the server
verifies them through `SUPABASE_URL/auth/v1/.well-known/jwks.json`;
`AUTH_JWT_SECRET` must still be set to a string of 16 or more characters.

`SUPABASE_SERVICE_ROLE_KEY` is used for one thing: emailing an invite when an
admin adds a teammate. Without it the teammate row is still created.

### 5.2 Supabase URL configuration

In Supabase → Authentication → URL Configuration, add these redirect URLs:

- `https://app.example.com/login` (invite emails redirect here; the server uses the first `WEB_ORIGIN` entry)
- `https://app.example.com/login/reset` (password reset links)

### 5.3 Create the first workspace

There is no sign-up screen. Create the organization, the first owner and the
default dispositions with SQL. The disposition list matches
`DEFAULT_DISPOSITIONS` in `apps/server/src/seed.ts`.

```sql
WITH org AS (
  INSERT INTO organizations (name, slug)
  VALUES ('Your Company', 'your-company')
  RETURNING id
), owner AS (
  INSERT INTO users (org_id, email, display_name, role, status)
  SELECT id, 'owner@example.com', 'Your Name', 'owner', 'invited' FROM org
  RETURNING id
)
INSERT INTO call_dispositions
  (org_id, name, slug, sort_order, is_system, requires_follow_up, treat_as_conversation, adds_suppression)
SELECT org.id, d.name, d.slug, d.sort_order, true, d.follow_up, d.conversation, d.suppression
FROM org, (VALUES
  ('No Answer',       'no_answer',        0, false, false, false),
  ('Voicemail',       'voicemail',        1, false, false, false),
  ('Wrong Number',    'wrong_number',     2, false, false, false),
  ('Follow Up',       'follow_up',        3, true,  true,  false),
  ('Appointment',     'appointment',      4, true,  true,  false),
  ('Offer Made',      'offer_made',       5, false, true,  false),
  ('Not Interested',  'not_interested',   6, false, true,  false),
  ('Dead Lead',       'dead_lead',        7, false, true,  false),
  ('Contract Sent',   'contract_sent',    8, false, true,  false),
  ('Contract Signed', 'contract_signed',  9, false, true,  false),
  ('DNC',             'dnc',             10, false, false, true),
  ('Other',           'other',           11, false, false, false)
) AS d(name, slug, sort_order, follow_up, conversation, suppression);
```

Run it after the API has booted once against this database (step 7), so the
migrations have created the tables.

Then create the matching Supabase user: Supabase → Authentication → Users →
Add user, with `owner@example.com` and a password. On the first successful
sign-in, Talkr links the `invited` row to that Supabase user and sets it
`active` (`linkByEmail` in `apps/server/src/auth.ts`). Later teammates are added
from the Team page.

**Check (after step 7):**

```bash
curl -s -X POST https://api.example.com/v1/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"owner@example.com","password":"<the password>"}' | head -c 200
```

The response contains `access_token` and `"role":"owner"`. A
`no_platform_user` error means no Talkr row matches that email.

### Local development without Supabase

Leave `SUPABASE_URL` and `SUPABASE_ANON_KEY` out. Either set
`AUTH_BYPASS_USER_EMAIL` to an active user's email (sign-in is skipped), or mint
a token the server accepts:

```bash
npm run seed -w apps/server   # creates admin@demo.test with auth_user_id auth-admin-demo
node -e "import('jose').then(async({SignJWT})=>console.log(await new SignJWT({sub:'auth-admin-demo'}).setProtectedHeader({alg:'HS256'}).setIssuedAt().setExpirationTime('12h').sign(new TextEncoder().encode(process.env.AUTH_JWT_SECRET))))"
```

Paste the token under **Advanced** on the sign-in screen of the web app or the
extension.

## 6. Server environment variables

Start from `apps/server/.env.example`. The full table with defaults is in the
[README](README.md#environment-variables). The minimum for each stage:

| Stage | Variables |
|---|---|
| Boots, no carrier | `DATABASE_URL`, `PUBLIC_BASE_URL`, `AUTH_JWT_SECRET`, `VOICE_PROVIDER=none` |
| Real sign-in | add `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `WEB_ORIGIN` |
| Calls and texts | `VOICE_PROVIDER=telnyx`, `TELNYX_API_KEY` (the rest from step 8) |
| Worker | `WORKER_INLINE=true`, or a separate worker process (serverless: `CRON_SECRET`) |
| Optional | `SUPABASE_SERVICE_ROLE_KEY`, `GOOGLE_OAUTH_CLIENT_ID`, `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, `PARTNER_*`, `PODIO_*` |

Rules the config parser enforces (`apps/server/src/config.ts`):

- `PUBLIC_BASE_URL` must be a URL. It must be the exact external origin Telnyx can reach, with no trailing slash.
- `AUTH_JWT_SECRET` must be at least 16 characters; `PARTNER_JWT_SECRET` too, if set.
- `SUPABASE_URL`, if present, must be a valid URL. An empty `SUPABASE_URL=` line stops the boot with `SUPABASE_URL: Invalid url`. Delete the line instead of leaving it blank.
- `WEB_ORIGIN` is a comma-separated list. Put the web app's main origin first.
- The server does not read `.env` files. Locally, export them (`set -a; . apps/server/.env.local; set +a`); in production use the host's environment or secret store.

Some keys (`VOICE_PROVIDER`, `TELNYX_*`, `DEEPGRAM_*`, `ANTHROPIC_API_KEY`,
`CALL_CONTROL_MODE`) can also live as rows in the `runtime_settings` table; a
real environment variable always wins over a row.

## 7. Deploy the API and the web app

### 7.1 API with Docker (Fly.io, Railway, Render, a VM)

The root `Dockerfile` builds the API image and starts
`npm run start -w apps/server` on port 4000.

```bash
docker build -t talkr-api .
docker run -p 4000:4000 --env-file /path/to/production.env talkr-api
```

With Fly.io:

```bash
cp fly.example.toml fly.toml     # set app = "<your app>", primary_region = "<region>"
fly secrets set DATABASE_URL=... AUTH_JWT_SECRET=... PUBLIC_BASE_URL=https://api.example.com
fly deploy
```

`fly.example.toml` sets `WORKER_INLINE=true` (one machine runs API and worker),
keeps one machine running, and health-checks `/health`. For a separate worker,
run the same image with `npm run worker -w apps/server`.

### 7.2 API on Vercel (serverless)

Create a Vercel project with root directory `apps/server`. `apps/server/vercel.json`
bundles the server into one function and adds a cron that calls
`GET /internal/tick` every minute; each tick drains the job queue for up to 45
seconds. Calls still ring immediately; background work (reconciliation,
recording mirrors, CRM sync, workflows) settles within about a minute.

- Edit `apps/server/config/deployment.json` (baked defaults: `PUBLIC_BASE_URL`, `WEB_ORIGIN`, `VOICE_PROVIDER`, `RECORDINGS_DIR`, `LOG_LEVEL`) or override them with real environment variables, which win.
- Put secrets in the Vercel project's environment variables. Redeploy after changing them.
- Set `CRON_SECRET` to a random value of at least 16 characters (`openssl rand -hex 32`). Vercel sends it as `Authorization: Bearer <CRON_SECRET>` on the cron call, and `/internal/tick` refuses every other caller. Without it the tick answers 503 and the worker never runs.

### 7.3 Web app

Deploy `apps/web` (for Vercel: root directory `apps/web`) with:

```
NEXT_PUBLIC_API_URL=https://api.example.com
```

The web app holds no provider secrets. Add its origin to the API's `WEB_ORIGIN`.

**Check:**

```bash
curl -s https://api.example.com/health
# {"ok":true}
curl -s https://api.example.com/health/deep
# {"ok":true,"jobs":{...},"webhook_events":{...},"provider":"none",...,"features":{"transcription":false,"ai":false,"partner_apps":0}}
curl -s https://api.example.com/v1/auth/config
# {"password_signin":true,"token_signin":true,"google_signin":false,"google_client_id":null,"open_access":false}
```

Open `https://app.example.com/login` and sign in as the owner.

## 8. Telnyx

Telnyx is the only carrier. Full reference: [docs/telnyx-setup.md](docs/telnyx-setup.md).
Make sure `PUBLIC_BASE_URL` is correct before this step: it is written into
the Telnyx resources.

### 8.1 API key and public key

In the Telnyx portal (portal.telnyx.com), **API Keys**:

- Create a V2 API key → `TELNYX_API_KEY`.
- Copy the **public key** from the same page → `TELNYX_PUBLIC_KEY`.

These are two different credentials. The API key authenticates Talkr's calls
to Telnyx; the public key verifies Telnyx's webhooks (Ed25519). Swapping them
is the most common first-run failure.

### 8.2 Option A: let the server provision the rest

Set `VOICE_PROVIDER=telnyx` and `TELNYX_API_KEY`, then restart. On boot
(`apps/server/src/services/telnyx-bootstrap.ts`) the server finds or creates,
by name:

- an outbound voice profile (`talkr-outbound`),
- a credential SIP connection with SIP-username destination format and `sip_uri_calling_preference: internal`,
- a TeXML application (`talkr-texml`) with Voice URL `{PUBLIC_BASE_URL}/twiml/outbound-dial` and status callback `{PUBLIC_BASE_URL}/webhooks/telnyx/voice-status`,
- a messaging profile (`talkr-messaging`) with webhook `{PUBLIC_BASE_URL}/webhooks/telnyx/inbound-sms`,

and reads the account ID and public key from the API. The resulting IDs are
saved as `runtime_settings` rows. If a step fails, the server boots with no
carrier and stores the reason:

```sql
SELECT value FROM runtime_settings WHERE key = 'TELNYX_BOOTSTRAP_ERROR';
```

### 8.3 Option B: create the resources by hand

1. **TeXML application** (Voice → Programmable Voice → TeXML Applications):
   - Voice URL (POST): `https://api.example.com/twiml/outbound-dial`
   - Status callback URL (POST): `https://api.example.com/webhooks/telnyx/voice-status`
   - ID → `TELNYX_TEXML_APP_ID`
2. **SIP connection** (Voice → SIP Connections), type **Credentials**:
   - Inbound → Destination Number Format: **SIP Username**.
   - **Receive SIP URI calls** (`sip_uri_calling_preference`): **From your Account** / `internal`. The default is disabled. Left disabled, Telnyx answers the server-dialed browser leg with 403 (`SipHangupCause=403`) and the call shows as busy in about a second.
   - Outbound: attach any Outbound Voice Profile (the connection will not save without one).
   - Leave the SIP subdomain blank, or put it in `TELNYX_SIP_DOMAIN`.
   - ID → `TELNYX_SIP_CONNECTION_ID`
3. **Messaging profile** (only for SMS): inbound webhook URL `https://api.example.com/webhooks/telnyx/inbound-sms`. ID → `TELNYX_MESSAGING_PROFILE_ID`.
4. **Account ID** (account page) → `TELNYX_ACCOUNT_ID`.

Set all values plus `VOICE_PROVIDER=telnyx` and restart. Even with every ID
present, the server re-checks `sip_uri_calling_preference` on each boot.

### 8.4 Numbers

The API searches Telnyx inventory and buys numbers; a purchase is attached to
the TeXML app and, when configured, the messaging profile. The web app lists
and edits numbers but has no buy screen in this release, so buy through the API
(or from CLOZR, if connected). These calls need an admin's access token:

```bash
# Sign in as an admin and keep the token in a shell variable (type the password yourself)
read -s -p "Password: " PW; echo
TOKEN=$(curl -s -X POST https://api.example.com/v1/auth/login \
  -H 'content-type: application/json' \
  -d "{\"email\":\"owner@example.com\",\"password\":\"$PW\"}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).access_token'); unset PW

# Search by area code, then buy one phone_e164 from the results
curl -s -H "authorization: Bearer $TOKEN" 'https://api.example.com/v1/numbers/available?area_code=614'
curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"phone_e164":"+16145550100"}' https://api.example.com/v1/numbers
```

Numbers bought in the Telnyx portal can be imported: `GET /v1/numbers/carrier`
lists numbers the account owns that Talkr does not, and
`POST /v1/numbers/import` with `{"phone_e164":"+1…"}` attaches and records one.
Then set each rep's default caller ID on the Team page.

### 8.5 SMS registration (US)

US carriers block texts from unregistered local numbers. Register a 10DLC brand
and campaign in Telnyx (Messaging → 10DLC) and assign your numbers. Calling
works before approval.

### 8.6 Rep credentials

Each rep gets a Telnyx telephony credential automatically: at boot, when a rep
is added, and on `/v1/me`.

**Check:**

```bash
curl -s https://api.example.com/health/deep    # "provider":"telnyx","provider_configured":true
```

```sql
SELECT user_id, sip_username FROM telephony_credentials WHERE provider = 'telnyx';
```

One row per active rep.

## 9. Build and load the Chrome extension

The extension lives in `apps/extension/talkr-voice`.

### 9.1 Give it a fixed ID

`public/manifest.json` ships without a `key`. Without one, an unpacked
extension's ID depends on its folder path, so every rep would get a different
ID and Google sign-in's redirect URI would match none of them.

```bash
# Keep the private key outside the repository (*.pem is not in .gitignore)
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out "$HOME/talkr-extension-key.pem"
# The value for "key" in public/manifest.json:
openssl rsa -in "$HOME/talkr-extension-key.pem" -pubout -outform DER | openssl base64 -A; echo
# The extension ID that key produces:
openssl rsa -in "$HOME/talkr-extension-key.pem" -pubout -outform DER | sha256sum | head -c 32 | tr 0-9a-f a-p; echo
```

Add `"key": "<base64 value>"` to `apps/extension/talkr-voice/public/manifest.json`.
Keep the `.pem` file private. The public `key` in the manifest is what fixes the ID.
On macOS use `shasum -a 256` in place of `sha256sum`. Changing or removing the
`key` changes the ID and breaks the Google redirect URI.

### 9.2 Point it at your API

- Add your API origin to `host_permissions` in `public/manifest.json`, for example `"https://api.example.com/*"`. The shipped list covers `http://localhost:4000`, `*.vercel.app`, `*.up.railway.app`, `*.fly.dev` and `*.onrender.com`; the extension cannot reach any other origin.
- The default API URL is `DEFAULT_API_URL` in `src/shared/session.ts` (`https://api.talkr.example.com`). Change it before building, or have each rep set the API URL under **Advanced** on the sign-in screen.

### 9.3 Build

```bash
cd apps/extension/talkr-voice
npm install
npm run build          # typecheck + two vite builds into dist/
npm run package        # build, then zip dist/ into talkr-voice.zip
npm run package:store  # talkr-store.zip for the Chrome Web Store (manifest key removed)
```

### 9.4 Load

Chrome → `chrome://extensions` → Developer mode on → **Load unpacked** →
`apps/extension/talkr-voice/dist` (or drop `talkr-voice.zip` on the page).

**Check:** the card shows the ID from 9.1 and the service worker reads
*Active*. Open the popup, sign in, press **Enable softphone** and allow the
microphone. Account → Carrier reads `telnyx`.

## 10. Google sign-in

> **Bring your own Google OAuth client.** This repository ships no Google
> credentials. Every client ID or secret in the code, tests and examples is a
> dummy (such as `000000000000-dummyclientid.apps.googleusercontent.com` or
> `GOCSPX-DUMMY-SECRET-not-a-real-credential`) and will not work. Create your
> own OAuth client in your own Google Cloud project using the steps below. Keep
> the client secret out of git, and rotate it in Google Cloud (Credentials →
> your client → **Reset secret**) if it is ever committed, pasted in a public
> place or shared.

Optional. Google sign-in appears in the Chrome extension. It needs step 5
(Supabase) and step 9.1 (fixed extension ID).

1. Google Cloud Console → **APIs & Services** → **Credentials** → **Create credentials** → **OAuth client ID**. Set up the OAuth consent screen first if prompted.
2. Application type: **Web application**. Name: for example `Talkr extension`.
3. **Authorized JavaScript origins:** leave empty.
4. **Authorized redirect URIs:** add exactly `https://<your-extension-id>.chromiumapp.org/` (trailing slash included).
5. Create, then copy the **Client ID** (`….apps.googleusercontent.com`) and the **Client secret** (`GOCSPX-…`).
6. Supabase → Authentication → Providers → **Google**: enable, paste the client ID and client secret, and add the client ID under **Authorized Client IDs**.
7. API host: set `GOOGLE_OAUTH_CLIENT_ID` to the **client ID**. Restart or redeploy.
8. Reload the extension at `chrome://extensions`.

The client secret goes only into Supabase. `GOOGLE_OAUTH_CLIENT_ID` is served
publicly by `GET /v1/auth/config`. If the value does not end in
`.apps.googleusercontent.com` the server ignores it, keeps Google off, and logs
`GOOGLE_OAUTH_CLIENT_ID is not a Google client id …`. If you ever pasted the
`GOCSPX-` secret there, rotate it in Google Cloud.

**Check:**

```bash
curl -s https://api.example.com/v1/auth/config
# {..."google_signin":true,"google_client_id":"<id>.apps.googleusercontent.com",...}
```

The extension's sign-in screen shows **Continue with Google**. A Google account
with no matching Talkr user gets "not a member of a Talkr workspace yet".

## 11. Transcription and AI (Deepgram, Anthropic)

Optional. Set on the API host:

| Variable | Enables |
|---|---|
| `DEEPGRAM_API_KEY` | Transcripts of recorded calls; `POST /v1/transcription/token` (60-second browser keys for live transcription) |
| `DEEPGRAM_PROJECT_ID` | Pins the Deepgram project for browser keys (looked up from the key when unset) |
| `ANTHROPIC_API_KEY` | Call notes, call scoring, `POST /v1/calls/:id/intel`, sequence drafts and agent steps |
| `AI_SUMMARY_MODEL`, `AI_COACHING_MODEL`, `AI_BUILDER_MODEL`, `AI_AGENT_MODEL` | Model choices (defaults in the README table) |

Without the keys, recordings still play and the call page says what is
missing; the AI endpoints answer `503` with `transcription_not_configured` or
`ai_not_configured`.

**Check:** `GET /health/deep` shows `"features":{"transcription":true,"ai":true,...}`.
After a recorded call completes, `GET /v1/calls/<id>/transcript` returns the
transcript and a score appears on the call page.

## 12. Talkr Coach (optional, separate system)

Talkr Coach is a separate backend (`apps/api`, Vercel functions) and extension
(`apps/extension/talkr-coach`) with its own Supabase project. Full guide:
[docs/setup.md](docs/setup.md).

1. Create a Supabase project, enable the `vector` extension, and apply `supabase/migrations/*.sql` in filename order (SQL editor or `psql`).
2. `cp apps/api/.env.example apps/api/.env.local` and set `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ANTHROPIC_API_KEY`, `DEEPGRAM_API_KEY`, `VOYAGE_API_KEY`, and `TALKR_API_KEY` (generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`).
3. Run it:
   ```bash
   cd apps/api
   npm install
   npm run dev            # vercel dev, http://localhost:3000
   ```
4. Load `apps/extension/talkr-coach` unpacked. In its popup Settings enter the API base URL, the `TALKR_API_KEY` value, and an agent ID.
5. Build the knowledge base: put files in `playbook/raw/` and run `npm run playbook`; process past recordings with `npm run process -- --file <path> --outcome contract --agent "<name>" --phone "+15555550100"` (`--deal-value` is optional; outcomes are listed in docs/setup.md).

**Check:** in the Coach Supabase SQL editor,
`select proname from pg_proc where proname in ('match_patterns','match_playbook');`
returns two rows.

## 13. Connect CLOZR (optional)

CLOZR signs reps in with its own JWT and calls the Talkr API with it. The
Chrome extension also picks up a CLOZR session from an open CLOZR tab.

### 13.1 Trust CLOZR's tokens

Option A, a database row (no redeploy, any number of partners, origins included):

```sql
INSERT INTO partner_apps (name, issuer, jwks_url, origins) VALUES (
  'CLOZR',
  'https://<clozr-project-ref>.supabase.co/auth/v1',
  'https://<clozr-project-ref>.supabase.co/auth/v1/.well-known/jwks.json',
  ARRAY['https://clozr.example.com']
);
```

Use the `secret` column instead of (or as well as) `jwks_url` if CLOZR signs
with an HS256 shared secret. An origin pattern may contain one `*` for one
hostname label (for preview deployments). The API re-reads rows every minute.

Option B, environment variables (one partner):

```
PARTNER_JWKS_URL=https://<clozr-project-ref>.supabase.co/auth/v1/.well-known/jwks.json
# or PARTNER_JWT_SECRET=<16+ character shared secret>
PARTNER_JWT_ISSUER=https://<clozr-project-ref>.supabase.co/auth/v1
WEB_ORIGIN=https://app.example.com,https://clozr.example.com
```

With Option B, CLOZR's origin must be in `WEB_ORIGIN`, because the
env-configured partner has no origin list of its own.

### 13.2 Add the reps

A partner token signs in a rep only when its `email` claim matches exactly one
Talkr user. Add each rep on the Team page first (they start as `invited`; the
first partner sign-in activates them). Tokens with `is_anonymous: true` are
refused.

### 13.3 Point CLOZR at Talkr

Configure CLOZR with your Talkr API URL (`https://api.example.com`) as its
documentation describes. For the extension hand-off, the CLOZR page marks itself
with `data-talkr-bridge="clozr"` on `<html>`; the extension verifies any offered
token with `GET /v1/me` before storing it.

**Check:** `GET /health/deep` shows `"partner_apps": 1` (or more). With CLOZR
open and signed in, the extension popup is signed in and Account → Session
reads "Signed in through CLOZR".

## 14. Verify end to end

1. `GET /health/deep`: `"ok":true`, `"provider":"telnyx"`.
2. Sign in on the web app, open `/dialer`, enable the softphone, and call a phone you own.
3. After hang-up, check the call row is terminal with a duration, `call_events` has the full timeline, a recording row is `completed`, and the wrap-up saved.
4. `GET /v1/admin/mismatches` has nothing for that call once reconciliation has run (`RECONCILE_DELAY_MS`, default 2 minutes).
5. Call your Talkr number from that phone: the rep's browser rings. Decline it; voicemail is recorded.
6. If SMS is set up: text the Talkr number and reply from `/messages`.
7. In the extension: place a call, close the popup mid-call (audio continues), and test click to call on a page with a phone number.

Useful SQL while testing:

```sql
SELECT status, count(*) FROM webhook_events GROUP BY status;
SELECT status, count(*) FROM jobs GROUP BY status;
```

## 15. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `refusing to start: SUPABASE_URL: Invalid url` | An empty `SUPABASE_URL=` line. Delete it or set a real URL. |
| `Invalid configuration … AUTH_JWT_SECRET` | Missing or shorter than 16 characters. |
| `VOICE_PROVIDER=telnyx requires TELNYX_PUBLIC_KEY, …` | Telnyx selected but IDs missing and the bootstrap did not fill them. Check `TELNYX_BOOTSTRAP_ERROR` in `runtime_settings`. |
| Calls fail with `503 no_carrier` | `VOICE_PROVIDER=none`. Switch to `telnyx` with credentials. |
| Webhooks rejected with 403 | `TELNYX_PUBLIC_KEY` holds the API key, or is from another account. Use the public key from the API Keys page. |
| Outbound call shows busy in about a second, `SipHangupCause=403` | The SIP connection's Receive SIP URI calls setting is not `internal`. Set it, or restart so the bootstrap reconciles it. |
| "Carrier did not ring this browser in time" (extension) | The server-dialed browser leg failed. Same SIP URI setting as above; check `PUBLIC_BASE_URL` matches the TeXML app. |
| "Softphone rejected the carrier ring-back (busy)" | Another softphone for the same rep (CLOZR tab or web dialer) answered first. Close it. |
| Browser shows a CORS error | Add the page's origin to `WEB_ORIGIN` or the partner's `partner_apps.origins`. |
| `403 no_platform_user` after a correct password or Google sign-in | No Talkr `users` row with that email, or two unlinked rows with the same email in different orgs. Add the user on the Team page or fix by SQL. |
| `501 password_signin_not_configured` | `SUPABASE_URL` or `SUPABASE_ANON_KEY` is unset. |
| No Google button | `GET /v1/auth/config` shows `google_signin:false`: client ID unset, not ending in `.apps.googleusercontent.com`, or Supabase not configured. |
| Google: `google_provider_disabled` | Enable the Google provider in Supabase. |
| Google: `invalid_google_token` | Client ID not in Supabase's Authorized Client IDs, or a nonce mismatch. Check the `detail` field. |
| Google window shows `redirect_uri_mismatch` | The redirect URI in Google Cloud does not match `https://<extension-id>.chromiumapp.org/`. Check the ID on `chrome://extensions` and the manifest `key`. |
| Extension: "Can't reach the Talkr API" | API origin missing from `host_permissions`, or wrong API URL under Advanced. Rebuild after editing the manifest. |
| Partner token gets 401 | `iss` does not equal the configured issuer, the JWKS URL or secret is wrong, the email matches no Talkr user (or two), or the token is anonymous. |
| Realtime updates do not arrive | `LISTEN/NOTIFY` through a transaction pooler. Use a direct or session connection for the long-running server. |
| Transcript reads "not configured" | Set `DEEPGRAM_API_KEY`; for notes, `ANTHROPIC_API_KEY`. |
| Texts to US mobiles fail | 10DLC registration is missing or pending. |
| `npm run seed` fails with `organizations_slug_unique` | The demo org already exists in that database. |
