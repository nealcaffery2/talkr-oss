import { z } from 'zod';

const boolish = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const configSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().default(4000),
  LOG_LEVEL: z.string().default('info'),

  DATABASE_URL: z.string().min(1),

  /**
   * The exact public origin the carrier posts webhooks to (scheme + host, no
   * trailing slash). Behind a proxy/tunnel this MUST be the external URL.
   */
  PUBLIC_BASE_URL: z.string().url(),

  /** HS256 secret for verifying user JWTs (Supabase project JWT secret). */
  AUTH_JWT_SECRET: z.string().min(16),

  /**
   * A second, partner-issued identity. clozr (the CRM Talkr renders inside)
   * signs a short-lived HS256 JWT with this shared secret for the rep who is
   * using it — `sub` = clozr's user id, `email`, `iss` = PARTNER_JWT_ISSUER —
   * and Talkr resolves it exactly like a Supabase token: `users.auth_user_id`,
   * or an unlinked row claimed by email on first sight. This is how a rep is
   * one person in both products without the two apps sharing an Auth project.
   * Optional; unset means only AUTH_JWT_SECRET tokens are accepted.
   */
  PARTNER_JWT_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(16).optional()),
  /**
   * Or, when the partner's tokens are signed asymmetrically (a Supabase
   * project on JWT signing keys), the partner's JWKS URL, e.g.
   * `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`. Either or both
   * may be set; a token is accepted if any configured verifier accepts it.
   */
  PARTNER_JWKS_URL: z.preprocess((v) => (v === '' ? undefined : v), z.string().url().optional()),
  /** The `iss` claim partner tokens must carry. Supabase issues `<SUPABASE_URL>/auth/v1`. */
  PARTNER_JWT_ISSUER: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(1).optional()),

  /**
   * Shared secret the host's scheduler sends as `Authorization: Bearer <secret>`
   * on GET /internal/tick (the serverless worker). Vercel sends it on its own
   * when the project has a CRON_SECRET variable. Without it the tick refuses
   * every caller (tick-auth.ts).
   */
  CRON_SECRET: z.preprocess((v) => (v === '' ? undefined : v), z.string().min(16).optional()),

  /**
   * Browser origins allowed to call the /v1 API: the web app's URL, plus any
   * alias it is also served from, comma-separated.
   */
  WEB_ORIGIN: z
    .string()
    .default('http://localhost:3100')
    .transform((v) => v.split(',').map((s) => s.trim()).filter(Boolean)),

  /**
   * Supabase Auth, for email + password sign-in from the web app and the
   * extension (POST /v1/auth/login). The API proxies GoTrue so browsers only
   * ever talk to one origin and the anon key stays server-side. Both optional:
   * without them sign-in returns 501 and clients fall back to pasting a JWT
   * minted elsewhere — AUTH_JWT_SECRET verifies either.
   */
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  /**
   * Service-role key. Server-only, and used for exactly one thing: asking
   * GoTrue to email an invite when an admin adds a teammate (routes/team.ts).
   * Optional — without it the teammate is still added and can sign in as soon
   * as an auth user exists for their email; the Team page says so.
   */
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),

  /**
   * Google OAuth client id for "Continue with Google" (POST /v1/auth/google).
   * Not a secret: clients read it from /v1/auth/config and hand it to Google
   * themselves — the Chrome extension has no redirect URI to host, so it asks
   * Google for an id_token directly and we trade that for a Supabase session.
   * Its secret half lives in the Supabase dashboard, never here. Optional:
   * unset simply means clients do not offer the button.
   */
  GOOGLE_OAUTH_CLIENT_ID: z.string().optional(),

  /**
   * Product-testing switch. When set, every /v1 request that carries no valid
   * bearer runs as this user (matched by email, case-insensitive; must be
   * active), and /v1/auth/config says so, which is how the web app knows to
   * skip its sign-in screen. A valid bearer still wins. Anyone who can reach
   * the server acts as this user, so it belongs only where the data is not
   * worth protecting; unset it and sign-in is back with no other change.
   */
  AUTH_BYPASS_USER_EMAIL: z.preprocess(
    (v) => (v === '' ? undefined : v),
    z.string().email().optional(),
  ),

  /**
   * Which carrier this deployment uses (docs/architecture.md §4): Telnyx, the
   * only adapter, or `none`. Only the selected carrier's credentials are
   * required. `none` boots with no carrier at all — every other surface works, and any
   * attempt to call or text fails with one message naming this switch — for
   * product testing before a carrier account exists.
   */
  // Forgiving on purpose: a misspelling here ("telynx") once took the whole
  // API down at boot. Case, whitespace and the first three letters decide.
  // Twilio is gone; a host still saying `twilio` gets the only carrier there
  // is rather than a boot failure.
  VOICE_PROVIDER: z.preprocess(
    (v) =>
      typeof v === 'string'
        ? ({ tel: 'telnyx', twi: 'telnyx', non: 'none' } as Record<string, string>)[v.trim().toLowerCase().slice(0, 3)] ?? v
        : v,
    z.enum(['telnyx', 'none']).default('telnyx'),
  ),

  // ── Telnyx (required when VOICE_PROVIDER=telnyx) ───────────────────────────
  /** V2 API key, used as the Bearer token for every REST call. */
  TELNYX_API_KEY: z.string().optional(),
  /**
   * Base64 Ed25519 *public* key that verifies inbound webhooks. A different
   * credential from the API key, from a different page of the portal — the
   * usual operator mix-up, so the names stay explicit.
   */
  TELNYX_PUBLIC_KEY: z.string().optional(),
  /** Account id; a path segment in every TeXML REST call. */
  TELNYX_ACCOUNT_ID: z.string().optional(),
  /** TeXML Application whose Voice URL points at {PUBLIC_BASE_URL}/twiml/outbound-dial. */
  TELNYX_TEXML_APP_ID: z.string().optional(),
  /** SIP Connection that browser (WebRTC) credentials are minted against. */
  TELNYX_SIP_CONNECTION_ID: z.string().optional(),
  /** Messaging profile for outbound SMS/MMS. */
  TELNYX_MESSAGING_PROFILE_ID: z.string().optional(),
  /** SIP domain reps' browsers are reachable at; Telnyx's shared one by default. */
  TELNYX_SIP_DOMAIN: z.string().default('sip.telnyx.com'),

  /** Podio app auth (optional until the integration is wired). */
  PODIO_CLIENT_ID: z.string().optional(),
  PODIO_CLIENT_SECRET: z.string().optional(),
  PODIO_APP_ID: z.string().optional(),
  PODIO_APP_TOKEN: z.string().optional(),

  // ── Transcription + AI call notes (docs/transcription.md) ──────────────────
  /** Deepgram key. Unset: recordings still play; transcripts read "not configured". */
  DEEPGRAM_API_KEY: z.string().optional(),
  /**
   * Deepgram project id, for minting 60-second browser keys
   * (POST /v1/transcription/token). The in-call live transcript streams audio
   * from the rep's browser straight to Deepgram; the master key stays here.
   */
  DEEPGRAM_PROJECT_ID: z.string().optional(),
  /** Anthropic key for the call summary. Unset: transcripts land without notes. */
  ANTHROPIC_API_KEY: z.string().optional(),
  /**
   * Messages-API model that writes the notes. Sonnet 5 is the low-cost tier
   * that still extracts carefully; any current model id can replace it.
   */
  AI_SUMMARY_MODEL: z.string().default('claude-sonnet-5'),
  /**
   * Messages-API model that scores calls (docs/coaching.md). Unset: the same
   * model as AI_SUMMARY_MODEL (see coachingModel below). Scoring is judgement
   * rather than extraction, so an org that wants a sharper coach points this
   * at a stronger model without changing what writes the notes.
   */
  AI_COACHING_MODEL: z.string().optional(),

  /** Where mirrored recording media lands (local dir v1; object storage later). */
  RECORDINGS_DIR: z.string().default('./data/recordings'),

  /** Run the worker loop inside the API process (dev convenience). */
  WORKER_INLINE: boolish,

  /**
   * How a browser outbound call is wired (docs/telephony-events.md §9).
   * `conference` puts both parties in a room, which is what hold, add call,
   * merge and transfer need. `bridge` is the original two-leg <Dial>, kept as
   * a rollback lever for an org that hits a conference-specific problem.
   */
  CALL_CONTROL_MODE: z.enum(['conference', 'bridge']).default('conference'),

  /** Delay before post-call provider reconciliation. */
  RECONCILE_DELAY_MS: z.coerce.number().default(120_000),

  /** Job retry backoff base (tests set 0 for immediate retries). */
  JOB_BACKOFF_BASE_MS: z.coerce.number().default(30_000),

  // ── Public API (Phase 10, docs/public-api.md) ──────────────────────────────
  /** Fixed-window rate limit per API key (docs/public-api.md §3). */
  API_RATE_LIMIT_PER_MINUTE: z.coerce.number().default(120),
  API_RATE_WINDOW_MS: z.coerce.number().default(60_000),
  /** Outbound webhook fan-out sweep interval. */
  WEBHOOK_FANOUT_INTERVAL_MS: z.coerce.number().default(5_000),
  /** Per-attempt delivery timeout. */
  WEBHOOK_DELIVERY_TIMEOUT_MS: z.coerce.number().default(10_000),
  /** Consecutive dead deliveries before a subscription auto-disables. */
  WEBHOOK_AUTO_DISABLE_AFTER: z.coerce.number().default(3),

  // ── Workflows (Phase 7, docs/workflows.md) ─────────────────────────────────
  /** Workflow trigger-feed sweep interval (event sources). */
  WORKFLOW_FANOUT_INTERVAL_MS: z.coerce.number().default(5_000),
  // ── Sequences (docs/sequences.md) ──────────────────────────────────────────
  /**
   * Messages-API model behind POST /v1/ai/sequence-draft. Unset: the same
   * model as AI_SUMMARY_MODEL (see builderModel below). Needs ANTHROPIC_API_KEY;
   * without the key the endpoint answers 503 ai_not_configured.
   */
  AI_BUILDER_MODEL: z.string().optional(),
  /**
   * Model behind an `agent` sequence step and the smart completion router
   * (docs/sequences.md §11-12). Unset: the builder model. Needs
   * ANTHROPIC_API_KEY; without it an agent step fails the run visibly and
   * a smart router falls back to its deterministic rule.
   */
  AI_AGENT_MODEL: z.string().optional(),
  // ── Dialers (Phase 5, docs/dialers.md) ─────────────────────────────────────
  /** Predictive pacing is designed-but-disabled; OFF until real-world
   * answer/abandon statistics exist to tune it responsibly (docs §6). */
  DIALER_PREDICTIVE_ENABLED: boolish,
  /** dialer-watch sweep interval (call_events tail — docs/dialers.md §5). */
  DIALER_WATCH_INTERVAL_MS: z.coerce.number().default(1_000),
});

export type Config = z.infer<typeof configSchema>;

/** The model the AI sequence builder calls: its own setting, else the summary model. */
export function builderModel(config: Config): string {
  return config.AI_BUILDER_MODEL?.trim() || config.AI_SUMMARY_MODEL;
}

/** The model behind agent steps and smart routing: its own setting, else the builder model. */
export function agentModel(config: Config): string {
  return config.AI_AGENT_MODEL?.trim() || builderModel(config);
}

/** The model that scores calls (docs/coaching.md): its own setting, else the summary model. */
export function coachingModel(config: Config): string {
  return config.AI_COACHING_MODEL?.trim() || config.AI_SUMMARY_MODEL;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = configSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`Invalid configuration — refusing to start: ${details}`);
  }
  return parsed.data;
}
