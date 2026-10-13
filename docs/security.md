# Talkr Platform — Security

**Status:** living document. Recordings, transcripts, and messages are sensitive business data; treat every design below as load-bearing.

## 1. Tenancy

- Every tenant-owned row carries `org_id`. All reads/writes go through `apps/server`, which resolves an `AuthContext {orgId, userId, role, permissions}` per request and passes it into repositories — repository functions **require** an org scope parameter; there is no "query without org" API shape to misuse.
- The web app never talks to Postgres/PostgREST directly; there is exactly one enforcement point.
- RLS is not the primary mechanism (server-side single-writer is), but the schema is RLS-compatible if we later expose PostgREST or want defense-in-depth.

## 2. AuthN

- **Users:** Supabase Auth issues JWTs; `apps/server` verifies signature (HS256 project secret or JWKS), maps `sub → users.auth_user_id`, rejects disabled users. Tokens are short-lived.
- **Sign-in:** the web app and the Chrome extension sign reps in with email + password through `POST /v1/auth/login`, which proxies Supabase GoTrue (`SUPABASE_URL` + `SUPABASE_ANON_KEY`, server-side only — no Supabase client or anon key ships in a browser bundle). The proxy checks the resulting `sub` against `users` before answering, so an auth user with no workspace row gets `403 no_platform_user` rather than a session that 401s everywhere. Wrong password and unknown email return the same `401 invalid_credentials`. `POST /v1/auth/refresh` rotates the pair (refresh tokens are single-use; each client has one refresh owner — the extension's service worker, one in-flight promise in the web client), `POST /v1/auth/logout` revokes upstream. With the two variables unset, `/v1/auth/config` reports token-only sign-in and clients accept a pasted JWT instead.
- **Partner-issued identity:** a partner app that embeds the phone (CLOZR) signs its reps in with its own tokens. A partner is trusted by a `partner_apps` row (issuer, JWKS URL and/or HS256 secret, browser origins) or by the `PARTNER_*` env fallback. `authenticate` tries the primary secret first, then the partners whose issuer matches the token's `iss`, each bound to that issuer. A partner-verified `sub` resolves through `partner_identities` (issuer, subject) → user, never through `users.auth_user_id`, so one person keeps their Talkr auth id and gains one identity per partner. The link is created on first sight only when the token's email names exactly one Talkr user; anonymous tokens, unknown emails and ambiguous emails are refused, and a disabled user is never reopened. Trusting a partner means trusting it to have verified that email, which is the whole of the trust granted. Numbers, calls and messages made this way are attributed to the rep, not to a machine key. The partner's origins join `WEB_ORIGIN` in the CORS allowlist; nothing else is reflected.
- **Product-testing switch:** `AUTH_BYPASS_USER_EMAIL` on the server makes every `/v1` request that carries no valid bearer run as that (active) user, and `/v1/auth/config` reports `open_access: true` so the web app skips its sign-in gate. A valid bearer still wins. It turns the API into "anyone who can reach it is this user", so it belongs only on a server whose data you would share; unset it to restore sign-in with no other change.
- **Adding a rep:** an owner or admin (`admin.users`) uses **Team → Add teammate**, which creates the `users` row (`status = invited`, `auth_user_id` null) through `POST /v1/team/members` and, when `SUPABASE_SERVICE_ROLE_KEY` is set alongside `SUPABASE_URL`, asks GoTrue to email an invite (`POST /auth/v1/invite`, redirecting to the web app's `/login`). The service-role key is server-only and used for nothing else; without it the row is still created and the UI says the email was not sent, so the auth user can be created by hand as before. On their first successful sign-in the server links the row to the token's `sub` and flips `invited` to `active` (`linkByEmail` in `auth.ts`) — only an *unlinked* row, never one already tied to a different auth user, and never when the same email exists unlinked in two orgs. The same page changes role, title, default caller-ID number and status; disabling a member makes every later request of theirs fail authentication, since `authenticate` only accepts `active` rows. Guards: nobody changes their own role or status, only an owner touches an owner or grants owner, and the last active owner cannot be demoted or disabled. Every change is audited (`team.member.invite`, `team.member.update`).
- **Machine callers:** `api_keys` table (Phase 10 for public API; used earlier for internal tools) — random 32-byte secrets, stored **hashed** (SHA-256), prefix-identified (`tk_live_…`), org-scoped, permission-scoped, revocable, last-used tracked.
- **Telnyx browser SDK:** short-TTL WebRTC login tokens (≤ 1h) minted server-side per authenticated user against that rep's own telephony credential. The Telnyx API key never leaves the server.

## 3. AuthZ (RBAC)

Roles `owner > admin > manager > rep` expand to permission strings in code (`packages/core/src/rbac.ts`):

```
calls.read.own / calls.read.org      recordings.listen.own / .org
calls.place                          numbers.manage
leads.read / leads.assign            reports.view.own / .org
dispositions.manage                  admin.integrations / admin.events / admin.users
suppression.manage                   monitoring.listen (Phase 6 whisper/barge gated separately)
```

Every `/v1` route declares its required permission; the check runs in a Fastify preHandler, denials are audited. Reps see their own calls and leads assigned to them; managers see their teams; admins see the org.

## 4. Secrets

- No secrets in the repo, in frontend bundles, or in the extension — enforced by review + secret scanning (gitleaks in CI, Phase 1 backlog).
- Server secrets come from the environment (host-level secret manager); `apps/server/src/config.ts` zod-validates presence and shape at boot and refuses to start half-configured (missing Telnyx public key ⇒ webhooks would be unverifiable ⇒ hard fail).
- Provider/CRM tokens that must live in the DB (Podio OAuth refresh tokens) are encrypted at the application layer (AES-256-GCM, key from env `SECRET_ENCRYPTION_KEY`) — the `crm_connections.settings` holds ciphertext + key-version, never plaintext.

## 5. Webhook security

- **Inbound:** every provider webhook is signature-verified before any processing (Telnyx Ed25519 signature over `{timestamp}|{raw body}`, verified with the account's public key; Podio hook verification + secret param). Invalid signatures: 403, raw attempt logged with `status='rejected'`, alarm counter. Signature validation is tested with known-good and tampered vectors.
- **Outbound (Phase 10):** per-endpoint secrets, HMAC-SHA256 over `timestamp.body`, timestamp tolerance ±5 min for replay protection, retries with backoff, auto-disable after sustained failure, full delivery logs.

## 6. Recordings & media

- Recording media is mirrored into a private object-storage bucket; access only via short-lived signed URLs minted by the API after a permission check (`recordings.listen.*`), and every listen is audited.
- Provider-side recordings are deleted after mirror + retention policy allows (configurable; default: keep provider copy 7 days as a safety net).
- Retention policies are org-configurable per data class (recordings, transcripts, messages); deletion jobs are audited and produce tombstones, not silent gaps.

## 7. Application security

- CSRF: the API is token-authenticated (no cookie auth), so CSRF surface is minimal; state-changing routes reject non-JSON content types except provider webhooks (form-encoded, signature-gated).
- Rate limits per API key / user / IP on auth and mutation routes.
- Secure headers on the web app (CSP, HSTS, frame-ancestors none) via Next middleware.
- Structured log redaction: phone numbers logged last-4 only outside dedicated columns; auth headers, tokens, and recording URLs never logged. Pino redact paths configured centrally.
- Dependency scanning (`npm audit` gate) + secret scanning in CI (Phase 1 backlog item).

## 8. Auditability

`audit_log` captures actor, action, object, metadata, correlation ID for: logins mapped to users, call placement, disposition changes, suppression add/remove, number assignment, integration changes, event replays, permission denials, recording access. The audit log is append-only at the application layer and excluded from ORM update/delete helpers.

## 9. Compliance posture (safety-relevant defaults)

- Suppression (`suppression_records`) is checked before **every** outbound communication; DNC disposition writes suppression immediately.
- Quiet hours & contact timezone rules default **on** for campaign/bulk paths (Phase 4/5); one-to-one rep-initiated calls warn but allow (rep judgment), and the warning + override is audited.
- Recording consent mode is org-configurable (all-party announcement / one-party / off per state rules); defaults to announcement-on until configured. We build compliance primitives, not evasion — no caller-ID spoofing beyond owned verified numbers, no carrier-filter evasion, no consent-bypass tooling. Counsel signs off on jurisdictional configuration before production cutover.
