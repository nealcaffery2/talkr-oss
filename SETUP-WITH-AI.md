# Talkr setup: instructions for an AI coding assistant

You are an AI coding assistant (Claude Code, Cursor, or similar) helping a
person set up Talkr from this repository. Follow these steps in order. Run
the commands yourself where you have a terminal. After each step, run its
check and compare the output with the expected result before moving on. If a
check fails, use the failure table at the end before improvising.

Human-readable reference: [SETUP.md](SETUP.md) and [README.md](README.md).

## Goal

1. Talkr runs locally with `VOICE_PROVIDER=none` (no carrier) and passes its checks.
2. Optionally: Talkr runs in production with Telnyx calling, SMS, Supabase sign-in, Google sign-in in the Chrome extension, Deepgram/Anthropic features, and the CLOZR partner connection.

Do only the parts the human asks for. Stop after local setup if that is all
they want.

## Rules for handling secrets

- **Never ask the human to paste a secret into the chat.** Secrets include: `AUTH_JWT_SECRET`, `SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `TELNYX_API_KEY`, `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, `PARTNER_JWT_SECRET`, `PODIO_CLIENT_SECRET`, `PODIO_APP_TOKEN`, `DATABASE_URL` (contains a password), the Google client secret (`GOCSPX-…`), passwords, and the extension's private `.pem` key.
- Tell the human which variable name to fill and in which file or secret store, and let them type it there. Then check presence without printing the value (see `check_env` below).
- Never `cat`, `echo`, `grep` without `-q`, or otherwise print a file or variable that holds secrets. Never put secrets in commit messages, logs, or files you create outside `.env.local` / the host's secret store.
- Never commit `.env.local` or `*.pem`. `.env.local` is in `.gitignore`; `*.pem` is not, so keep key files outside the repository.
- Values that are **not** secret and that you may ask for or write: domains and origins, emails, company name, `VOICE_PROVIDER`, the Google OAuth **client ID**, Telnyx resource IDs, `TELNYX_PUBLIC_KEY` (a public key), the Supabase project URL, the extension ID.
- The human must do every step in a web console (Google Cloud, Supabase, Telnyx portal, Chrome's extensions page). You cannot click those. Give them the exact values to enter.

## Questions to ask the human first

Ask these in one message. None of them are secrets.

1. Local only, or production too?
2. Production: where will the API run (Docker host such as Fly.io/Railway/Render, or Vercel)? Where will the web app run?
3. Production: the API origin (for example `https://api.example.com`) and the web app origin (for example `https://app.example.com`).
4. The organization name (for example `Your Company`), a URL slug (for example `your-company`), and the first owner's email and display name.
5. Which optional parts: Telnyx calling, SMS, Google sign-in, Deepgram/Anthropic, Talkr Coach, CLOZR?
6. If CLOZR: its origin(s) and its Supabase project ref (or JWT issuer).

## Helper shell functions

Define these once per shell session (bash or zsh). They edit env files without
printing values.

```bash
set_env() { node -e 'const fs=require("fs");const [f,k,v]=process.argv.slice(1);let s=fs.readFileSync(f,"utf8");const re=new RegExp("^#?\\s*"+k+"=.*$","m");s=re.test(s)?s.replace(re,()=>k+"="+v):s.replace(/\n?$/,"\n")+k+"="+v+"\n";fs.writeFileSync(f,s)' "$1" "$2" "$3"; }
unset_env() { node -e 'const fs=require("fs");const [f,k]=process.argv.slice(1);const s=fs.readFileSync(f,"utf8").split("\n").filter(l=>!new RegExp("^"+k+"=").test(l)).join("\n");fs.writeFileSync(f,s)' "$1" "$2"; }
check_env() { f="$1"; shift; for v in "$@"; do if grep -q "^$v=..*" "$f"; then echo "$v: set"; else echo "$v: MISSING"; fi; done; }
```

- `set_env FILE KEY VALUE` replaces `KEY=…` (or a commented `# KEY=…`) or appends it.
- `unset_env FILE KEY` deletes the `KEY=` line.
- `check_env FILE KEY…` prints `set` or `MISSING` for each key.

Use `set_env` only for non-secret values, or for values you generate yourself
without printing them.

## Part 1: local setup (no carrier)

### Step 1. Check prerequisites

```bash
node -v
npm -v
psql --version
which initdb pg_ctl createdb
```

Expected: Node `v20` or later, `psql (PostgreSQL) 16.x`, and paths for the
three Postgres tools. If Postgres 16 is missing, ask the human to install it
(or give you permission to) before continuing. On Debian/Ubuntu the binaries
are often in `/usr/lib/postgresql/16/bin`, which is not on `PATH`.

### Step 2. Install dependencies

Run from the repository root:

```bash
npm install
npm run typecheck
```

Expected: `npm install` finishes without `ERR!`; `npm run typecheck` exits 0
with no error lines.

### Step 3. Start a local Postgres on port 5544

```bash
initdb -D "$HOME/talkr-pg" -U postgres --auth=trust
pg_ctl -D "$HOME/talkr-pg" -o '-p 5544' -l "$HOME/talkr-pg/log" start
createdb -h 127.0.0.1 -p 5544 -U postgres talkr_platform
createdb -h 127.0.0.1 -p 5544 -U postgres talkr_platform_test
psql -h 127.0.0.1 -p 5544 -U postgres -d talkr_platform -c 'select 1;'
```

Expected: `server started`, then a one-row result. If `initdb` says the
directory exists, skip it and run only `pg_ctl … start`. `initdb` refuses to
run as root; if you are root, run the Postgres commands as the `postgres` user.

### Step 4. Create the server env file

```bash
cp apps/server/.env.example apps/server/.env.local
F=apps/server/.env.local
set_env $F DATABASE_URL postgres://postgres@127.0.0.1:5544/talkr_platform
set_env $F PUBLIC_BASE_URL http://localhost:4000
set_env $F VOICE_PROVIDER none
set_env $F AUTH_BYPASS_USER_EMAIL admin@demo.test
set_env $F AUTH_JWT_SECRET "$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")"
unset_env $F SUPABASE_URL
check_env $F DATABASE_URL PUBLIC_BASE_URL AUTH_JWT_SECRET VOICE_PROVIDER WORKER_INLINE
```

Expected: all five print `set`. `unset_env … SUPABASE_URL` is a safety
step: the config validator stops the boot with `SUPABASE_URL: Invalid url` if
that variable is present but empty.

`AUTH_BYPASS_USER_EMAIL` makes every unauthenticated request run as that user.
It is for local use only.

### Step 5. Load the env and seed

The server reads `process.env` only. Export the file into the shell first, in
every new terminal:

```bash
set -a; . apps/server/.env.local; set +a
npm run seed -w apps/server
```

Expected: a printed object listing 29 applied migrations
(`0000_init.sql` … `0027_sequence_routing.sql`) and `orgId`, `adminId`,
`repId`, `phoneNumberId`, `contactId`, `leadId`. Running it a second time fails
with `organizations_slug_unique`; that means the seed already ran, which is fine.

### Step 6. Run the API

Start it in the background or in a second terminal (after the `set -a` line):

```bash
npm run server:dev
```

Then:

```bash
curl -s localhost:4000/health
curl -s localhost:4000/health/deep
curl -s localhost:4000/v1/auth/config
curl -s localhost:4000/v1/me | head -c 120; echo
curl -s -X POST localhost:4000/v1/voice/token; echo
```

Expected, in order:

```
{"ok":true}
{"ok":true,"jobs":{},"webhook_events":{},"provider":"none","provider_configured":false,"crm_configured":false,"features":{"transcription":false,"ai":false,"partner_apps":0}}
{"password_signin":false,"token_signin":true,"google_signin":false,"google_client_id":null,"open_access":true}
{"id":"…","display_name":"Alex Admin","email":"admin@demo.test","role":"admin",…
{"error":"no_carrier","message":"No carrier is configured on this server (VOICE_PROVIDER=none). Set VOICE_PROVIDER=telnyx with its credentials to place calls and send texts."}
```

`jobs` may list counts once the inline worker has run.

### Step 7. Run the web app

```bash
cp apps/web/.env.example apps/web/.env.local
npm run dev -w apps/web
```

Then:

```bash
curl -s -o /dev/null -w '%{http_code}\n' localhost:3100/dialer
```

Expected: `200`. Tell the human to open `http://localhost:3100/dialer`; they
should land in the workspace as Alex Admin with no sign-in screen.

### Step 8 (optional). Run the test suite

Needs the `talkr_platform_test` database from step 3.

```bash
npm test
```

Expected: ends with `Test Files  79 passed (79)` and `Tests  828 passed (828)`
(counts change as tests are added; zero failures is what matters). It takes
about two minutes.

Local setup is done. Ask the human whether to continue to production.

## Part 2: production

Use the origins the human gave you. Below, `https://api.example.com` and
`https://app.example.com` stand for them; substitute the real values in every
command and in every value you give the human.

### Step 9. Database

Ask the human to create a Postgres 16 database (any managed provider, or
Supabase) and put its connection string in the API host's secret store as
`DATABASE_URL`. For commands you run locally against production, have them put
it in a local file that is git-ignored, for example `apps/server/.env.production.local`:

```bash
touch apps/server/.env.production.local
# Human: open apps/server/.env.production.local and add DATABASE_URL=<connection string>
check_env apps/server/.env.production.local DATABASE_URL
```

Expected: `DATABASE_URL: set`. Migrations run automatically when the API boots.

Tell the human: realtime updates use Postgres `LISTEN/NOTIFY`, which does not
work through a transaction-mode pooler; a long-running API host should use a
direct or session connection.

### Step 10. Supabase Auth (human, in the Supabase dashboard)

Ask the human to:

1. Create or open a Supabase project.
2. Put these into the API host's secret store (and, if you need them locally, into `apps/server/.env.production.local`):
   - `SUPABASE_URL` = `https://<project-ref>.supabase.co` (not secret; they may tell you this one)
   - `SUPABASE_ANON_KEY` = the anon key
   - `AUTH_JWT_SECRET` = the project's JWT secret (legacy HS256 secret)
   - optional `SUPABASE_SERVICE_ROLE_KEY` = the service_role key (only used to email invites)
3. Authentication → URL Configuration → Redirect URLs: add
   - `https://app.example.com/login`
   - `https://app.example.com/login/reset`

### Step 11. API host environment

Give the human this list for the API host. Non-secret values you can fill in
for them:

| Variable | Value |
|---|---|
| `NODE_ENV` | `production` |
| `PUBLIC_BASE_URL` | `https://api.example.com` (no trailing slash) |
| `WEB_ORIGIN` | `https://app.example.com` (web app first; comma-separated if more) |
| `VOICE_PROVIDER` | `none` for now (step 15 switches it) |
| `WORKER_INLINE` | `true` unless they run a separate worker process |

Secrets they enter themselves: `DATABASE_URL`, `AUTH_JWT_SECRET`,
`SUPABASE_ANON_KEY`, optional `SUPABASE_SERVICE_ROLE_KEY`. They must not add an
empty `SUPABASE_URL=`.

### Step 12. Deploy the API

Docker host:

```bash
docker build -t talkr-api .
```

Expected: the build ends with the image tagged `talkr-api`. The container
listens on port 4000 and runs `npm run start -w apps/server`.

Fly.io:

```bash
cp fly.example.toml fly.toml
# set app = "<their fly app name>" and primary_region = "<region>" in fly.toml
fly deploy
```

The human sets secrets with `fly secrets set NAME=value` in their own terminal
(not through you, since the values would appear in your command history).

Vercel: create a project with root directory `apps/server`. Edit
`apps/server/config/deployment.json` so `PUBLIC_BASE_URL`, `WEB_ORIGIN` and
`VOICE_PROVIDER` match; real environment variables override it. The cron in
`apps/server/vercel.json` calls `/internal/tick` every minute to run the worker.
Ask the person to add `CRON_SECRET` (output of `openssl rand -hex 32`, which
they run themselves) to the Vercel project's environment variables. The tick
answers 503 without it and 401 to any caller without the matching bearer.

Check the tick refuses a caller without the secret:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://api.example.com/internal/tick
```

Expected: `401`. A `503` means `CRON_SECRET` is not set on the project.

Check:

```bash
curl -s https://api.example.com/health
curl -s https://api.example.com/health/deep
curl -s https://api.example.com/v1/auth/config
```

Expected: `{"ok":true}`; `"ok":true` with `"provider":"none"`;
`"password_signin":true` and `"open_access":false`.

### Step 13. Deploy the web app

Root directory `apps/web`; environment variable
`NEXT_PUBLIC_API_URL=https://api.example.com`. Check:

```bash
curl -s -o /dev/null -w '%{http_code}\n' https://app.example.com/login
```

Expected: `200`.

### Step 14. Create the first workspace

Run after the API has booted once (so migrations created the tables). Replace
the four quoted values with the human's answers from the first questions.

```bash
set -a; . apps/server/.env.production.local; set +a
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
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
SQL
psql "$DATABASE_URL" -c "select email, role, status from users where role = 'owner';"
```

Expected: `INSERT 0 12`, then one row with the owner's email, `owner`,
`invited`. If psql is not available against the production database, give the
human the SQL to run in their database console.

Then the human creates the matching Supabase user (Supabase → Authentication →
Users → Add user, same email, a password) and signs in at
`https://app.example.com/login`. The first sign-in links the row and sets it
`active`. Check:

```bash
psql "$DATABASE_URL" -c "select email, status, auth_user_id is not null as linked from users where role = 'owner';"
```

Expected: `active` and `linked = t`.

### Step 15. Telnyx (human in the portal, then you verify)

Human, in portal.telnyx.com → API Keys:

1. Create a V2 API key. Put it in the API host's secret store as `TELNYX_API_KEY`.
2. Set `VOICE_PROVIDER=telnyx` on the API host and redeploy or restart.

On boot the server creates or finds, by name, an outbound voice profile
(`talkr-outbound`), a credential SIP connection (SIP-username destination
format, `sip_uri_calling_preference: internal`), a TeXML app (`talkr-texml`)
and a messaging profile (`talkr-messaging`), with these URLs:

| Telnyx setting | Value |
|---|---|
| TeXML Voice URL (POST) | `https://api.example.com/twiml/outbound-dial` |
| TeXML status callback (POST) | `https://api.example.com/webhooks/telnyx/voice-status` |
| Messaging profile inbound webhook | `https://api.example.com/webhooks/telnyx/inbound-sms` |
| SIP connection "Receive SIP URI calls" | From your Account (`internal`) |

If the human prefers to create them by hand, give them that table plus
[docs/telnyx-setup.md](docs/telnyx-setup.md) sections 2 to 4, and have them set
`TELNYX_PUBLIC_KEY`, `TELNYX_ACCOUNT_ID`, `TELNYX_TEXML_APP_ID`,
`TELNYX_SIP_CONNECTION_ID` and `TELNYX_MESSAGING_PROFILE_ID`. The API key and
the public key are different values from the same portal page.

Check:

```bash
curl -s https://api.example.com/health/deep
psql "$DATABASE_URL" -c "select key from runtime_settings order by key;"
psql "$DATABASE_URL" -c "select value from runtime_settings where key = 'TELNYX_BOOTSTRAP_ERROR';"
psql "$DATABASE_URL" -c "select count(*) from telephony_credentials where provider = 'telnyx';"
```

Expected: `"provider":"telnyx","provider_configured":true`; the key list
includes the `TELNYX_*` IDs the bootstrap wrote (unless they were set as env
vars); no `TELNYX_BOOTSTRAP_ERROR` row; one credential per active user.

Numbers: the web app has no buy screen in this release. Ask the human to run
this in their own terminal (it prompts for the password, so it never reaches
you), then buy one `phone_e164` from the search result:

```bash
read -s -p "Password: " PW; echo
TOKEN=$(curl -s -X POST https://api.example.com/v1/auth/login \
  -H 'content-type: application/json' \
  -d "{\"email\":\"owner@example.com\",\"password\":\"$PW\"}" \
  | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).access_token'); unset PW
curl -s -H "authorization: Bearer $TOKEN" 'https://api.example.com/v1/numbers/available?area_code=614'
curl -s -X POST -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"phone_e164":"+16145550100"}' https://api.example.com/v1/numbers
```

For US SMS, the human registers 10DLC in the Telnyx portal (Messaging → 10DLC)
and assigns the number. Texts to US mobiles fail until that is approved.

### Step 16. Chrome extension

You can do all of this except loading it in Chrome.

```bash
# private key outside the repo
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out "$HOME/talkr-extension-key.pem"
KEY=$(openssl rsa -in "$HOME/talkr-extension-key.pem" -pubout -outform DER | openssl base64 -A)
EXT_ID=$(openssl rsa -in "$HOME/talkr-extension-key.pem" -pubout -outform DER | sha256sum | head -c 32 | tr 0-9a-f a-p)
echo "$EXT_ID"
node -e 'const fs=require("fs");const f="apps/extension/talkr-voice/public/manifest.json";const j=JSON.parse(fs.readFileSync(f,"utf8"));j.key=process.argv[1];const h=process.argv[2]+"/*";if(!j.host_permissions.includes(h))j.host_permissions.push(h);fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$KEY" "https://api.example.com"
cd apps/extension/talkr-voice
npm install
npm run package
ls -la talkr-voice.zip dist/manifest.json
cd ../../..
```

On macOS replace `sha256sum` with `shasum -a 256`. Expected: a 32-letter ID
using only `a` to `p` (the public key is not secret, so printing the ID is
fine), and both files listed. Optionally set `DEFAULT_API_URL` in
`apps/extension/talkr-voice/src/shared/session.ts` to `https://api.example.com`
before `npm run package`, so reps do not have to enter it.

Human: Chrome → `chrome://extensions` → Developer mode → Load unpacked →
`apps/extension/talkr-voice/dist`. The card must show the same ID you printed.
If the API URL was not baked in, open the popup → Advanced → API URL
`https://api.example.com`.

### Step 17. Google sign-in (human in Google Cloud and Supabase)

> **Bring your own Google OAuth client.** This repository ships no Google
> credentials; every client ID or secret in the code, tests and examples is a
> dummy and will not work. Tell the person they must create their own OAuth
> client in their own Google Cloud project. Never reuse a value you find in the
> repo, never write the client secret into a file that gets committed, and if
> the secret ever lands in git, a chat log or a public place, tell them to
> rotate it (Google Cloud → Credentials → the client → **Reset secret**) and
> update it everywhere it is stored.

Needs steps 10 and 16. Give the human these exact steps with `<EXT_ID>`
replaced by the ID from step 16:

1. Google Cloud Console → APIs & Services → Credentials → Create credentials → OAuth client ID. Configure the consent screen first if asked.
2. Application type: **Web application**.
3. Authorized JavaScript origins: **leave empty**.
4. Authorized redirect URIs: `https://<EXT_ID>.chromiumapp.org/` (with the trailing slash).
5. Create. Two values appear: the **Client ID** (ends `.apps.googleusercontent.com`) and the **Client secret** (starts `GOCSPX-`).
6. Supabase → Authentication → Providers → Google: enable, paste the client ID and the client secret, and add the client ID under Authorized Client IDs.
7. API host: `GOOGLE_OAUTH_CLIENT_ID` = the **client ID**. Redeploy or restart.

Warn them plainly: the client secret goes only into Supabase. The client ID is
public (the API serves it at `/v1/auth/config`), and the human may tell you the
client ID. If a value that does not end in `.apps.googleusercontent.com` is set,
the server ignores it and logs `GOOGLE_OAUTH_CLIENT_ID is not a Google client id`;
if that value was the secret, they must rotate it in Google Cloud.

Check:

```bash
curl -s https://api.example.com/v1/auth/config
```

Expected: `"google_signin":true,"google_client_id":"….apps.googleusercontent.com"`.
After reloading the extension, its sign-in screen shows Continue with Google.

### Step 18. Deepgram and Anthropic (optional)

Human: add `DEEPGRAM_API_KEY` and `ANTHROPIC_API_KEY` to the API host's secret
store, then redeploy. Optional non-secret `DEEPGRAM_PROJECT_ID`.

Check: `curl -s https://api.example.com/health/deep` shows
`"features":{"transcription":true,"ai":true,…}`.

### Step 19. CLOZR partner (optional)

Ask for CLOZR's origin(s) and its Supabase project ref. Then either insert a
row (preferred, no redeploy):

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
INSERT INTO partner_apps (name, issuer, jwks_url, origins) VALUES (
  'CLOZR',
  'https://<clozr-project-ref>.supabase.co/auth/v1',
  'https://<clozr-project-ref>.supabase.co/auth/v1/.well-known/jwks.json',
  ARRAY['https://clozr.example.com']
);
SQL
```

or have the human set `PARTNER_JWKS_URL` (or a `PARTNER_JWT_SECRET` they enter
themselves), `PARTNER_JWT_ISSUER`, and add CLOZR's origin to `WEB_ORIGIN`
(env-configured partners have no origin list of their own).

Reps must exist in Talkr (Team page) with the same email they use in CLOZR.

Check: `curl -s https://api.example.com/health/deep` shows
`"partner_apps":1` within a minute. With a CLOZR tab open and signed in, the
extension popup shows the rep signed in ("Signed in through CLOZR" under
Account → Session).

### Step 20. Talkr Coach (optional, separate system)

Follow [docs/setup.md](docs/setup.md). The human creates a separate Supabase
project with the `vector` extension and applies `supabase/migrations/*.sql` in
order; the secrets go in `apps/api/.env.local`, which they fill themselves from
`apps/api/.env.example`. Then:

```bash
check_env apps/api/.env.local SUPABASE_URL SUPABASE_SERVICE_ROLE_KEY ANTHROPIC_API_KEY DEEPGRAM_API_KEY VOYAGE_API_KEY TALKR_API_KEY
cd apps/api && npm install && npm run dev
```

Expected: all six `set`; `vercel dev` serves on `http://localhost:3000`.

## Failure modes and fixes

| Output or symptom | Cause | Fix |
|---|---|---|
| `refusing to start: SUPABASE_URL: Invalid url` | Empty `SUPABASE_URL=` line | `unset_env apps/server/.env.local SUPABASE_URL`, or set the real URL |
| `Invalid configuration … AUTH_JWT_SECRET: String must contain at least 16 character(s)` | Secret missing or short | Step 4 generator locally; Supabase JWT secret in production |
| `Invalid configuration … DATABASE_URL` or `PUBLIC_BASE_URL` | Env not exported into this shell | `set -a; . apps/server/.env.local; set +a` |
| `ECONNREFUSED 127.0.0.1:5544` | Postgres not running | `pg_ctl -D "$HOME/talkr-pg" -o '-p 5544' start` |
| `initdb: cannot be run as root` | Running as root | Run Postgres commands as the `postgres` user |
| `organizations_slug_unique` on seed | Seed already ran | Nothing to do |
| `EADDRINUSE :4000` or `:3100` | An earlier server is still running | Stop it, or set `PORT` for the API |
| `/v1/me` returns `{"error":"unauthenticated"}` locally | No bypass and no token | Set `AUTH_BYPASS_USER_EMAIL=admin@demo.test`, re-export, restart |
| `VOICE_PROVIDER=telnyx requires TELNYX_PUBLIC_KEY, …` | Bootstrap could not fill the IDs | Read `TELNYX_BOOTSTRAP_ERROR` in `runtime_settings`; check the API key and `PUBLIC_BASE_URL` |
| Webhooks get 403 `invalid signature` | `TELNYX_PUBLIC_KEY` is wrong (often the API key) | Use the public key from the API Keys page |
| Outbound call "busy" in about a second, `SipHangupCause=403` | SIP connection does not accept SIP URI calls | Set "Receive SIP URI calls" to `internal`, or restart so bootstrap reconciles it |
| CORS error in the browser console | Page origin not allowed | Add it to `WEB_ORIGIN`, or to the partner row's `origins` |
| `403 no_platform_user` | No Talkr user with that email (or duplicates) | Step 14 SQL or the Team page |
| `501 password_signin_not_configured` | `SUPABASE_URL` or `SUPABASE_ANON_KEY` missing | Set both, redeploy |
| `google_signin:false` after setting the client ID | Value does not end in `.apps.googleusercontent.com`, or Supabase vars missing | Fix the value; check server logs for the guard message |
| Google popup: `redirect_uri_mismatch` | Extension ID differs from the registered URI | Compare `chrome://extensions` ID with step 16; the manifest `key` must be present |
| `google_provider_disabled` | Google provider off in Supabase | Enable it |
| `invalid_google_token` | Client ID not in Supabase's Authorized Client IDs | Add it |
| Extension: "Can't reach the Talkr API" | Origin missing from `host_permissions` or wrong API URL | Re-run the step 16 manifest edit, rebuild, reload |
| Partner token 401 | Issuer mismatch, wrong JWKS/secret, email matches zero or two users, or anonymous token | Compare the token's `iss` with the configured issuer; add the rep on the Team page |

## Final checklist

Report each item to the human as done, skipped (by their choice), or failed.

- [ ] `npm run typecheck` exits 0.
- [ ] Local: `/health/deep` returns `"ok":true`; `/v1/me` returns the seeded admin; web app `/dialer` returns 200.
- [ ] Optional: `npm test` passes.
- [ ] Production API: `/health` and `/health/deep` return `"ok":true`; `/v1/auth/config` shows `"password_signin":true` and `"open_access":false`.
- [ ] `AUTH_BYPASS_USER_EMAIL` is **not** set in production.
- [ ] Owner row is `active` and linked after first sign-in.
- [ ] Telnyx: `/health/deep` shows `"provider":"telnyx"`; no `TELNYX_BOOTSTRAP_ERROR`; one credential per active user; at least one number bought or imported.
- [ ] A test call to a phone the human owns connects, and the call shows in history with a recording.
- [ ] Extension: loaded with the expected ID, signed in, softphone enabled, carrier reads `telnyx`.
- [ ] Google: `/v1/auth/config` shows `"google_signin":true`; the `GOCSPX-` secret exists only in Supabase.
- [ ] Deepgram/Anthropic: `features.transcription` and `features.ai` are `true`.
- [ ] CLOZR: `features.partner_apps` is at least 1; the extension signs in from a CLOZR tab.
- [ ] No secret was pasted into the chat, printed, or committed; the `.pem` key is outside the repository.
