# Talkr Platform — Deployment Runbook

## Reference deployment

One way to run it. Any Postgres 16 and any Node or Dockerfile host works; the
names below are placeholders.

| Piece | Where | Notes |
|---|---|---|
| Postgres | a Supabase project (`your-talkr-project`) or any Postgres 16 | all migrations applied, a dedicated `talkr_api` role |
| API + worker | a Vercel project (root `apps/server`) → `https://api.talkr.example.com` | one function + a per-minute cron tick (`src/serverless.ts`, `vercel.json`) |
| Web | a Vercel project (root `apps/web`) → `https://app.talkr.example.com` | marketing site at `/`, workspace at `/dialer` |
| Extension | built from `apps/extension/talkr-voice` (`npm run build` → `dist/`), loaded unpacked | points at the API above |
| Carrier | `VOICE_PROVIDER=none` | no calls or texts until the Telnyx variables are added |

**The cron tick is a settling mechanism, never a ringing one.** Vercel's minimum cron
granularity is one minute, so anything that must happen *while the caller waits* runs
inline on the request that the carrier is blocking on: the seller is dialed into the
conference room from `/twiml/outbound-dial` itself (docs/telephony-events.md §9.1), the
inbound router answers synchronously, and the parallel dialer REST-dials from the
session request. What the tick drains is reconciliation, recording mirrors, CRM sync,
workflows, campaign auto-advance after wrap-up, and the fallback for any of the inline
dials that failed — work that can settle within a minute without a human noticing. When
diagnosing "the call took too long to ring", the tick is the first thing to rule out: if
ringing depends on it, that is the bug.

Secrets live only in the Vercel project's environment variables (`DATABASE_URL`, optional
`DATABASE_URL_FALLBACK`, carrier keys). Non-secret settings are baked in
`apps/server/config/deployment.json`. Vercel only rebuilds the API when `apps/server`,
`packages/` or the lockfile change (`ignoreCommand` in `vercel.json`); a change to
environment variables alone needs a manual Redeploy in the Vercel dashboard.

## Product-testing deploy (no carrier yet)

The fastest path to a working product test, in this order. Each step is a few minutes.

1. **Host the API on Railway** (or any Dockerfile host). Railway → New Project → Deploy from GitHub → `your-org/talkr`. It detects the root `Dockerfile`. Set these variables, then deploy:

   | Variable | Value |
   |---|---|
   | `DATABASE_URL` | your Supabase connection string (pooler, port 6543, or direct) |
   | `PUBLIC_BASE_URL` | the Railway URL once it exists, e.g. `https://talkr-api.example.com` (redeploy after setting) |
   | `AUTH_JWT_SECRET` | your Supabase project's JWT secret (dashboard → API); any 32+ character string also boots while sign-in is off |
   | `PARTNER_JWKS_URL` / `PARTNER_JWT_SECRET` / `PARTNER_JWT_ISSUER` | env fallback for trusting **one** partner app's sign-in. Prefer a `partner_apps` row (below): same fields, no redeploy, any number of partners |
   | `WEB_ORIGIN` | comma-separated browser origins allowed to call `/v1` — the web app's own URLs. Partner origins (CLOZR's production and preview URLs) come from `partner_apps.origins` |
   | `DEEPGRAM_PROJECT_ID` | optional. With only `DEEPGRAM_API_KEY` set, `POST /v1/transcription/token` looks the key's project up once and caches it; set this to pin a project when the key can see several |
   | `AUTH_BYPASS_USER_EMAIL` | `you@example.com` — sign-in off, every request runs as this user (security.md §2) |
   | `WEB_ORIGIN` | `https://talkr.example.com,https://app.talkr.example.com` (comma-separated list of allowed browser origins) |
   | `VOICE_PROVIDER` | `none` until the carrier is active, then `telnyx` plus the `TELNYX_*` variables from telnyx-setup.md |
   | `WORKER_INLINE` | `true` |

   Check `GET /health/deep` returns `ok: true` with `provider: "none"`.
2. **Point the web app at it.** Vercel → your web project → Settings → Environment Variables → `NEXT_PUBLIC_API_URL` = the Railway URL → Redeploy. The sign-in screen disappears and the workspace loads as the bypass user.
3. **Give it history.** `DATABASE_URL=… DEMO_USER_EMAIL=you@example.com npm run seed:demo -w apps/server` writes the designs' sellers, thread, calls and tasks into the workspace (idempotent).
4. **Load the extension.** `apps/extension/talkr-voice`: `npm run package`, drop `talkr-voice.zip` on chrome://extensions, then on its sign-in screen open Advanced and set the API URL to the Railway URL. The manifest already allows `*.up.railway.app`, `*.fly.dev` and `*.onrender.com`.
5. **When Telnyx is active:** follow telnyx-setup.md (API key, SIP credentials connection, TeXML app with Voice URL `{PUBLIC_BASE_URL}/twiml/outbound-dial`, messaging profile, a number), switch `VOICE_PROVIDER=telnyx`, add the `TELNYX_*` variables, redeploy. Calls and texts start working with no other change; the swap runbook and the way a Telnyx call is placed (the server rings the rep's browser) are in telnyx-setup.md §6 and §8.

## Server deployment (when host + credentials exist)

1. Deploy `apps/server` on the chosen host, two processes from one build:
   - API: `npm run start -w apps/server`
   - Worker: `npm run worker -w apps/server`
2. Environment (`apps/server/.env.example` is the authoritative list):
   - `DATABASE_URL` — your Supabase **connection pooler** string (Transaction mode, port 6543) or direct connection; password from Supabase dashboard → Database settings.
   - `PUBLIC_BASE_URL` — the server's public HTTPS origin. **Must match the URLs registered on the Telnyx TeXML app and messaging profile**; it is also the base of every callback URL the server hands the carrier.
   - `AUTH_JWT_SECRET` — your Supabase project's JWT secret (dashboard → API).
   - `SUPABASE_URL` + `SUPABASE_ANON_KEY` — the same Supabase project (`https://your-talkr-project.supabase.co`, anon key from dashboard → API). Enables email + password sign-in for the web app and the extension via `/v1/auth/login`; without them reps must paste a JWT.
   - `WEB_ORIGIN` — the deployed web app origin(s) for CORS, comma-separated when the app is served from more than one host.
   - `VOICE_PROVIDER` (`telnyx` | `none`) and the `TELNYX_*` variables from telnyx-setup.md §5.
   - `PODIO_*` — optional until Podio wiring.
   - `DEEPGRAM_API_KEY`, `ANTHROPIC_API_KEY`, `AI_SUMMARY_MODEL` — optional; transcripts and AI call notes (docs/transcription.md). Without them recordings still play and the call page says what is missing.
3. **Partner apps** (migration `0020_partner_apps`). A partner that embeds the phone (CLOZR) is one row:

   ```sql
   insert into partner_apps (name, issuer, jwks_url, origins) values (
     'CLOZR',
     'https://your-clozr-project.supabase.co/auth/v1',
     'https://your-clozr-project.supabase.co/auth/v1/.well-known/jwks.json',
     array['https://clozr.example.com', 'https://clozr-*-team.vercel.app']);
   ```

   `issuer` is the `iss` claim its tokens carry; `jwks_url` and/or `secret` verify them; `origins` join `WEB_ORIGIN` in the CORS allowlist (exact, or one `*` for one hostname label, which is how Vercel preview URLs are covered). The API re-reads enabled rows every minute. On a rep's first partner sign-in the token's email must match exactly one Talkr user — an invited teammate becomes active, an existing Talkr user gains a second identity in `partner_identities` — so add reps under Team first. `GET /health/deep` reports `features.partner_apps` as the count in force.

4. Boot check: `GET /health/deep` returns `ok:true` with DB counters and a `features` block (`transcription`, `ai`, `partner_apps`) naming which optional keys are present. Migrations run automatically at boot **when the server process starts** (`npm run start`); the Vercel serverless deployment does not run them, so after merging a migration apply it to the database by hand (the SQL in `packages/db/migrations/NNNN_*.sql` plus `INSERT INTO _talkr_migrations (name) VALUES ('NNNN_*.sql')`).
5. **Settings without host access** (migration `0021_runtime_settings`). Any of the carrier and AI keys listed in `apps/server/src/services/runtime-settings.ts` can be a row in `runtime_settings` instead of an environment variable; rows are read once at boot and fill what the environment leaves unset (a real variable always wins). This is how the carrier is switched from a database console: insert `VOICE_PROVIDER` and the `TELNYX_*` rows (telnyx-setup.md §5) and the next cold start runs on Telnyx.

## Google sign-in (one-time)

"Continue with Google" is how a rep gets in without anyone issuing a password. It
also *is* the provisioning path: an admin adds a teammate by email (Team page →
an `invited` row with no auth user), and their first Google sign-in mints the
Supabase user and `linkByEmail` (`apps/server/src/auth.ts`) claims the row and
flips it to `active`. Nothing is typed, nothing is copied between systems.

The rest of the stack is unchanged: the token the client ends up holding is an
ordinary Supabase access token, verified on every later request exactly as a
password sign-in's is.

1. **Google Cloud Console** → APIs & Services → Credentials → Create credentials →
   OAuth client ID → **Web application**. Under *Authorized redirect URIs* add the
   extension's loopback:

   ```
   https://<your-extension-id>.chromiumapp.org/
   ```

   Pin the id by adding your own `key` to `apps/extension/talkr-voice/public/manifest.json`
   (the repo ships without one), so it is the same for every rep and on every machine.
   **Changing or removing that `key` changes the id and breaks this URI.** (An unpacked
   extension without a `key` takes its id from the folder path.)

   The web app's "Continue with Google" (on `/login`) redirects back to
   `/login/google`, so add that path for every origin the web app is served from
   to the same *Authorized redirect URIs* list:

   ```
   https://talkr.example.com/login/google
   ```

   Without them Google stops the web sign-in with `redirect_uri_mismatch`; the
   extension is unaffected.
2. Copy the **client ID** and **client secret**.
3. **Supabase dashboard** (your project) → Authentication → Providers → **Google** →
   enable, paste both. In *Authorized Client IDs* on that same page, add the client ID
   as well — that list is what the `id_token` grant checks, and the extension uses that
   grant rather than a redirect.
4. **Vercel** (your API project) → Settings → Environment Variables →
   `GOOGLE_OAUTH_CLIENT_ID` = the client **ID**, the one ending
   `.apps.googleusercontent.com`. Then **Redeploy** — an environment-variable
   change alone does not rebuild (`ignoreCommand` in `vercel.json`).

   **Not the client secret.** The two sit side by side in Google's console and
   the secret starts `GOCSPX-`. This variable is deliberately public —
   `/v1/auth/config` serves it to every client — so pasting the secret both
   breaks sign-in and publishes a credential. The server checks the shape and
   treats anything that is not a client id as unconfigured (no button, nothing
   served, an error in the logs), but if a secret was ever set here, rotate it
   in Google Cloud: it has been served. The secret's only home is the Supabase
   dashboard's Google provider.
5. Check `GET /v1/auth/config` reports `"google_signin": true` with the client id.
   Clients read exactly that: until it flips, no Google button is shown anywhere, so
   steps 1–4 can be done in any order without a half-built button appearing.
6. Reload the extension (chrome://extensions → ⟳). "Continue with Google" appears
   above the email and password fields.

Restricting *which* Google accounts may sign in is the Supabase project's business
(provider settings) plus the OAuth client's own domain restrictions. The API's own
gate is the same one password sign-in has: there must already be a Talkr user with
that email, or the answer is `no_platform_user`.

To turn it off, unset `GOOGLE_OAUTH_CLIENT_ID` and redeploy; the button disappears
and `POST /v1/auth/google` answers 501.

## Carrier configuration (one-time)

Telnyx is the only carrier. Portal setup (API key, SIP credentials connection,
TeXML app, messaging profile, numbers, 10DLC) is in **telnyx-setup.md**.

- `VOICE_PROVIDER` accepts `telnyx` (default) or `none`. A leftover `twilio`
  value from before the Twilio removal is read as `telnyx` rather than failing
  boot.
- Carrier webhooks live under `/webhooks/telnyx/*`. The Twilio-era
  `/webhooks/twilio/*` path is still served as the same routes (a rewrite in
  `apps/server/src/app.ts`), and on every boot the server moves the Telnyx
  TeXML app's status callback and the messaging profile's inbound URL to the
  new path if they still point at the old one. Remove the rewrite once the logs
  show no legacy hits. Call-control routes stay under `/twiml/*`. TeXML posts
  Twilio-compatible field names (`CallSid`, `CallStatus`, …), which is why the
  handlers read them.
- Migration `0025_carrier_default_telnyx` sets the `provider` column defaults
  to `'telnyx'`, and `0026_relabel_twilio_rows` relabels the traffic rows that
  were stamped `'twilio'` before the carrier name was recorded (not
  `phone_numbers`, where `'twilio'` means a number really bought there). Old webhook
  idempotency keys keep their `twilio:` prefix; they are opaque.

## First-call smoke test

1. Seed org + rep (`npm run seed -w apps/server` against prod DB, or SQL), map the rep's `auth_user_id` to a Supabase Auth user.
2. Sign in on the web app, Enable softphone, call a real test phone.
3. Verify after hang-up: call row terminal with duration; `call_events` timeline complete; dual-channel recording row `completed`; wrap-up saved; reconcile job ran clean (`/v1/admin/mismatches` empty for the call).
4. Repeat 20×; then run the inbound path (call the platform number → rep's browser rings → decline → voicemail lands).
