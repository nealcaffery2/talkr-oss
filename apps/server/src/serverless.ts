/**
 * The API as one serverless function, for a deployment that has no
 * long-running host yet (docs/deploy.md).
 *
 * Everything the real server does, arranged for a host that starts and stops
 * instances at will:
 *
 * - Boot once per instance: settings, migrations, the Fastify app. Later
 *   requests reuse it.
 * - The worker runs as a *tick* instead of a loop: GET /internal/tick drains
 *   the job queue for up to 45 seconds and the host's cron calls it every
 *   minute, with `Authorization: Bearer <CRON_SECRET>` (tick-auth.ts). Calls
 *   still complete; they just settle within a minute.
 * - Settings can be baked in a file next to the bundle (config/talkr.env.json)
 *   for a host where environment variables cannot be set. Real environment
 *   variables win over the file.
 *
 * Realtime (SSE over Postgres LISTEN) does not work through a transaction
 * pooler; clients that lose the stream fall back to re-reading.
 */

import { existsSync, readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import { createDb, enqueueJob, migrate, type DbHandle } from '@talkr/db';
import { buildApp } from './app.js';
import { loadConfig, type Config } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { NullPodioClient, RealPodioClient, type PodioClient } from './services/podio.js';
import { createProvider } from './services/provider-factory.js';
import { provisionBrowserCredentials } from './services/provision.js';
import { applyRuntimeSettings, runtimeSettingsVersion } from './services/runtime-settings.js';
import { bootstrapTelnyxIfNeeded } from './services/telnyx-bootstrap.js';
import { JobRunner } from './worker/runner.js';
import { HANDLERS } from './worker/handlers.js';
import { seedWebhookFanout } from './worker/webhook-fanout.js';
import { tickAuthorized } from './tick-auth.js';
import { seedWorkflowFanout } from './worker/workflow-fanout.js';
import { seedDialerWatch } from './worker/dialer-handlers.js';
import { scheduleContactTemperatureSweep } from './worker/contact-temperature-sweep.js';
import { scheduleTranscriptRetrySweep } from './worker/transcribe-handlers.js';
import { makeRecordingMediaFetcher } from './services/recording-media.js';

/** How long one tick may spend draining the queue; the function limit is 60s. */
const TICK_BUDGET_MS = 45_000;

interface Booted {
  app: FastifyInstance;
  runner: JobRunner;
  dbh: DbHandle;
  config: Config;
  logger: Logger;
}

/** Settings baked next to the bundle, applied under any real environment. */
function applyBakedConfig(): void {
  const candidate =
    process.env.TALKR_CONFIG_FILE ?? fileURLToPath(new URL('../config/deployment.json', import.meta.url));
  if (!existsSync(candidate)) return;
  const baked = JSON.parse(readFileSync(candidate, 'utf8')) as Record<string, string>;
  for (const [key, value] of Object.entries(baked)) process.env[key] ??= value;
  // With sign-in off there is nothing to verify; the verifier still needs a
  // key to exist. The real one belongs in the host's environment.
  if (process.env.AUTH_BYPASS_USER_EMAIL) process.env.AUTH_JWT_SECRET ??= 'sign-in-is-off-on-this-server';
}

let booting: Promise<Booted> | null = null;

function boot(): Promise<Booted> {
  // A boot that fails (the database was unreachable for a moment) must not
  // be remembered, or every later request on this instance fails with it.
  booting ??= bootOnce().catch((err: unknown) => {
    booting = null;
    throw err;
  });
  return booting;
}

async function bootOnce(): Promise<Booted> {
  return (async () => {
    applyBakedConfig();
    let config = loadConfig();
    const logger = createLogger(config.LOG_LEVEL);
    // Serverless instances come and go; a small pool per instance keeps the
    // pooler's connection budget for the instances that are actually busy.
    let dbh = createDb(config.DATABASE_URL, { max: 3 });
    let applied: string[];
    try {
      applied = await migrate(dbh.pool);
    } catch (err) {
      // A managed Postgres can sit behind one of several pooler hosts; when
      // the operator is not sure which, DATABASE_URL_FALLBACK names the other.
      const fallback = process.env.DATABASE_URL_FALLBACK;
      if (!fallback) throw err;
      logger.warn({ err: (err as Error).message }, 'primary DATABASE_URL failed; trying DATABASE_URL_FALLBACK');
      await dbh.close().catch(() => undefined);
      process.env.DATABASE_URL = fallback;
      config = loadConfig();
      dbh = createDb(config.DATABASE_URL, { max: 3 });
      applied = await migrate(dbh.pool);
    }
    if (applied.length > 0) logger.info({ applied }, 'migrations applied');

    // Rows in runtime_settings fill what the host's environment leaves unset
    // (services/runtime-settings.ts): the carrier swap without a redeploy.
    const settings = await applyRuntimeSettings(dbh);
    config = settings.config;
    if (settings.applied.length > 0) logger.info({ keys: settings.applied }, 'runtime settings applied from database');
    if (settings.shadowed.length > 0) logger.warn({ keys: settings.shadowed }, 'runtime_settings rows ignored: the environment sets them');
    // `VOICE_PROVIDER = telnyx` plus an API key is enough: the TeXML app, SIP
    // connection and messaging profile are created here on the first boot.
    config = await bootstrapTelnyxIfNeeded(dbh, config, logger);
    const settingsVersion = await runtimeSettingsVersion(dbh);

    const provider = createProvider(config, dbh);
    // Every rep gets a browser credential with this carrier without pressing
    // anything; bounded, and never allowed to fail the boot.
    void provisionBrowserCredentials(dbh, provider)
      .then((r) => {
        if (r.minted.length > 0 || r.failed.length > 0) logger.info(r, 'browser credentials provisioned');
      })
      .catch((err: unknown) => logger.warn({ err: (err as Error).message }, 'credential provisioning failed'));
    const podio: PodioClient =
      config.PODIO_CLIENT_ID && config.PODIO_CLIENT_SECRET && config.PODIO_APP_ID && config.PODIO_APP_TOKEN
        ? new RealPodioClient({
            clientId: config.PODIO_CLIENT_ID,
            clientSecret: config.PODIO_CLIENT_SECRET,
            appId: config.PODIO_APP_ID,
            appToken: config.PODIO_APP_TOKEN,
          })
        : new NullPodioClient(logger);

    const app = buildApp({ config, dbh, provider, podio, logger });
    const runner = new JobRunner(
      { dbh, provider, podio, config, logger, fetchRecordingMedia: makeRecordingMediaFetcher(config, provider, dbh) },
      HANDLERS,
      { backoffBaseMs: config.JOB_BACKOFF_BASE_MS },
    );

    // The worker, one minute at a time. Sweeps are deduplicated by the queue,
    // so seeding them on every tick costs nothing when they already exist.
    app.get('/internal/tick', async (req, reply) => {
      const auth = tickAuthorized(req.headers.authorization, config.CRON_SECRET);
      if (!auth.ok) {
        if (auth.status === 503) logger.error('CRON_SECRET is not set; the worker tick refuses every caller');
        return reply.code(auth.status).send({ error: auth.error });
      }
      const started = Date.now();
      // A settings row changed since this instance booted: the next request
      // boots afresh and picks it up. This tick still runs on the old config.
      if ((await runtimeSettingsVersion(dbh)) !== settingsVersion) {
        logger.info('runtime_settings changed; re-booting on the next request');
        booting = null;
      }
      const hour = new Date().toISOString().slice(0, 13);
      await Promise.all([
        seedWebhookFanout(dbh.db, config.WEBHOOK_FANOUT_INTERVAL_MS),
        seedDialerWatch(dbh.db, config.DIALER_WATCH_INTERVAL_MS),
        seedWorkflowFanout(dbh.db, config.WORKFLOW_FANOUT_INTERVAL_MS),
        enqueueJob(dbh.db, { jobType: 'extract-provider-costs', payload: {}, dedupeKey: `extract-provider-costs:${hour}` }),
        enqueueJob(dbh.db, { jobType: 'workflow-time-sweep', payload: {}, dedupeKey: `workflow-time-sweep:${hour}` }),
        scheduleContactTemperatureSweep(dbh.db),
        // Transcripts that failed on carrier media, re-queued within minutes
        // (docs/transcription.md §1).
        scheduleTranscriptRetrySweep(dbh.db),
      ]);
      let processed = 0;
      while (Date.now() - started < TICK_BUDGET_MS) {
        const n = await runner.runOnce();
        processed += n;
        if (n === 0) break;
      }
      return { ok: true, processed, ms: Date.now() - started };
    });

    await app.ready();
    logger.info({ provider: provider.name }, 'talkr platform api booted (serverless)');
    return { app, runner, dbh, config, logger };
  })();
}

/** The function the host calls; Fastify answers on the Node request. */
export default async function handler(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const { app } = await boot();
  app.server.emit('request', req, res);
}
