import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { MessagingProvider, VoiceProvider } from '@talkr/core';
import type { DbHandle } from '@talkr/db';
import type { Config } from './config.js';
import type { Logger } from './logger.js';
import type { PodioClient } from './services/podio.js';
import { registerWebhookRoutes } from './routes/webhooks.js';
import { registerInboundTwimlRoutes } from './routes/twiml-inbound.js';
import { registerV1Routes } from './routes/v1.js';
import { registerAuthRoutes } from './routes/auth.js';
import { registerSseRoutes } from './routes/sse.js';
import { registerSmsWebhookRoutes } from './routes/webhooks-sms.js';
import { registerMediaRoutes } from './routes/media.js';
import { registerMessageRoutes } from './routes/messages.js';
import { registerRecordingsRoutes } from './routes/recordings.js';
import type { RecordingMediaFetcher } from './services/recording-media.js';
import { registerCoachingRoutes } from './routes/coaching.js';
import { registerAiCallRoutes } from './routes/ai-calls.js';
import { registerTeamRoutes } from './routes/team.js';
import { registerNumberRoutes } from './routes/numbers.js';
import { registerOutreachRoutes } from './routes/outreach.js';
import { registerReputationRoutes } from './routes/reputation.js';
import { registerLiveIntelRoutes } from './routes/live-intel.js';
import { registerContactRoutes } from './routes/contacts.js';
import { registerScriptRoutes } from './routes/scripts.js';
import { registerPublicApiRoutes } from './public-api/routes.js';
import { registerPublicApiAdminRoutes } from './routes/v1-admin-public-api.js';
import { registerMcpRoutes } from './public-api/mcp.js';
import { registerReportRoutes } from './routes/reports.js';
import { registerHistoryRoutes } from './routes/history.js';
import { registerFloorRoutes } from './routes/floor.js';
import { registerWorkflowRoutes } from './routes/workflows.js';
import { registerSequenceRoutes } from './routes/sequences.js';
import { registerCampaignRoutes } from './routes/campaigns.js';
import { registerDialerTwimlRoutes } from './routes/twiml-dialer.js';
import { NoCarrierError } from './services/null-provider.js';
import { PartnerRegistry } from './partners.js';

export interface AppDeps {
  config: Config;
  dbh: DbHandle;
  provider: VoiceProvider & MessagingProvider;
  podio: PodioClient;
  logger: Logger;
  /** Outbound HTTP for the auth proxy; tests inject a fake GoTrue. */
  fetchImpl?: typeof fetch;
  /** Trusted partner apps (env + partner_apps rows). Built here when absent. */
  partners?: PartnerRegistry;
  /**
   * Recording media fetcher (services/recording-media.ts). Built from the
   * carrier adapters when absent; injected by tests so no carrier is called.
   */
  recordingMedia?: RecordingMediaFetcher;
}

declare module 'fastify' {
  interface FastifyRequest {
    rawBodyString?: string;
  }
}

export function buildApp(deps: AppDeps): FastifyInstance {
  // Cast: passing a pino instance narrows Fastify's logger generic in a way
  // that infects every registrar signature; the default-typed instance is fine.
  const app = Fastify({
    loggerInstance: deps.logger,
    genReqId: () => randomUUID(),
    trustProxy: true,
    // Carrier webhooks live under /webhooks/telnyx/. The Twilio-era path is
    // still registered on older Telnyx apps, messaging profiles and in-flight
    // calls, so it is served as the same routes. Boot repoints the app and
    // profile (services/telnyx-bootstrap.ts); drop this once logs show no
    // legacy hits.
    rewriteUrl: (req) => (req.url ?? '/').replace(/^\/webhooks\/twilio\//, '/webhooks/telnyx/'),
  }) as unknown as FastifyInstance;

  // The web app's origins and every trusted partner's origins are the only
  // allowed browser origins; webhooks are server-to-server and unaffected.
  const partners = deps.partners ?? new PartnerRegistry(
    deps.dbh.db,
    { secret: deps.config.PARTNER_JWT_SECRET, jwksUrl: deps.config.PARTNER_JWKS_URL, issuer: deps.config.PARTNER_JWT_ISSUER },
    deps.config.WEB_ORIGIN,
  );
  deps.partners = partners;
  void app.register(cors, {
    origin: (origin, cb) => {
      partners.originAllowed(origin).then((ok) => cb(null, ok), (err: Error) => cb(err, false));
    },
    // PATCH/DELETE are used only by the Phase 10 admin surface (webhook
    // subscription management); additive for the web admin UI.
    methods: ['GET', 'POST', 'PATCH', 'DELETE'],
    // Lets the browser read the CSV export's filename (history export).
    exposedHeaders: ['content-disposition'],
    allowedHeaders: ['authorization', 'content-type'],
  });

  // Form-encoded parser that also preserves the exact raw body for the
  // webhook_events log (docs/telephony-events.md §1 step 2).
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (req, body, done) => {
      req.rawBodyString = body as string;
      const params: Record<string, string> = {};
      for (const [k, v] of new URLSearchParams(body as string)) params[k] = v;
      done(null, params);
    },
  );

  app.decorateRequest('authCtx', null);

  app.addHook('onSend', async (req, reply) => {
    void reply.header('x-request-id', req.id);
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof NoCarrierError) {
      // Not a failure of this request: the deployment has no carrier yet.
      // 503 with the message, so the softphone shows it instead of "error".
      void reply.code(503).send({ error: err.code, message: err.message });
      return;
    }
    req.log.error({ err }, 'request failed');
    void reply.code(500).send({ error: 'internal_error', request_id: req.id });
  });

  app.get('/health', async () => ({ ok: true }));

  app.get('/health/deep', async (_req, reply) => {
    try {
      await deps.dbh.db.execute(sql`SELECT 1`);
      const depth = await deps.dbh.db.execute(sql`
        SELECT status, count(*)::int AS n FROM jobs GROUP BY status`);
      const webhooks = await deps.dbh.db.execute(sql`
        SELECT status, count(*)::int AS n FROM webhook_events GROUP BY status`);
      return {
        ok: true,
        jobs: Object.fromEntries(depth.rows.map((r) => [r.status, r.n])),
        webhook_events: Object.fromEntries(webhooks.rows.map((r) => [r.status, r.n])),
        provider: deps.provider.name,
        provider_configured: deps.provider.name !== 'none',
        crm_configured: deps.podio.configured,
        // Which optional features have their keys, so an operator can see
        // what is missing without reading env vars. Booleans only.
        features: {
          transcription: Boolean(deps.config.DEEPGRAM_API_KEY),
          ai: Boolean(deps.config.ANTHROPIC_API_KEY),
          partner_apps: (await partners.list()).length,
        },
      };
    } catch (err) {
      return reply.code(503).send({ ok: false, error: (err as Error).message });
    }
  });

  registerWebhookRoutes(app, deps);
  registerInboundTwimlRoutes(app, deps);
  registerV1Routes(app, deps);
  // Sign-in proxy (Supabase Auth). After registerV1Routes so a bearer on
  // /v1/auth/logout resolves through the same preHandler.
  registerAuthRoutes(app, deps);
  registerSseRoutes(app, deps);
  // SMS (Phase 4): webhook ingestion + inbox API. Registered after
  // registerV1Routes so its /v1 auth preHandler hook covers these routes.
  registerSmsWebhookRoutes(app, deps);
  registerMessageRoutes(app, deps);
  // Recording playback + transcripts (docs/transcription.md): same /v1 auth hook.
  registerRecordingsRoutes(app, deps, { fetchRecordingMedia: deps.recordingMedia });
  // AI call scoring + coaching (docs/coaching.md): reads what transcripts
  // produce, on the same /v1 auth hook and the same visibility rules.
  registerCoachingRoutes(app, deps);
  // Telnyx AI Assistants outbound (ElevenLabs voice configured on the assistant).
  registerAiCallRoutes(app, deps);
  // Team management (admin.users): same reason, needs the /v1 auth hook.
  registerTeamRoutes(app, deps);
  // Numbers: list for everyone, buy / assign / release for numbers.manage.
  registerNumberRoutes(app, deps);
  registerOutreachRoutes(app, deps);
  registerReputationRoutes(app, deps);
  // In-call smart surface: Deepgram browser key + live seller intelligence.
  registerLiveIntelRoutes(app, deps);
  // Contacts (docs/contacts.md): same reason, needs the /v1 auth hook.
  registerContactRoutes(app, deps);
  // Scripts + in-call context (docs/scripts.md): same /v1 auth hook; after
  // contacts because call-context reuses the ContactDto loader.
  registerScriptRoutes(app, deps);
  // MMS attachments: authenticated upload under /v1, public fetch under /media
  // so the carrier can pull the bytes.
  registerMediaRoutes(app, deps);
  registerPublicApiRoutes(app, deps);
  registerPublicApiAdminRoutes(app, deps);
  registerMcpRoutes(app, deps);
  registerReportRoutes(app, deps);
  registerHistoryRoutes(app, deps);
  registerFloorRoutes(app, deps);
  // Workflows + tasks (Phase 7): after registerV1Routes so its /v1 auth
  // preHandler hook covers these routes.
  registerWorkflowRoutes(app, deps);
  // Sequences (docs/sequences.md): drip enrollment + the AI builder, on the
  // same workflows.manage permission and the same /v1 auth hook.
  registerSequenceRoutes(app, deps);
  // Dialers (Phase 5): campaign/session API (after registerV1Routes so the
  // /v1 auth preHandler hook covers it) + parallel-dial call control.
  registerCampaignRoutes(app, deps);
  registerDialerTwimlRoutes(app, deps);

  return app;
}
