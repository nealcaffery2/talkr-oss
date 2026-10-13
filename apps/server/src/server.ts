/**
 * API entrypoint. Runs migrations, boots Fastify, and (optionally) an inline
 * worker for dev. Production runs `worker-main.ts` as a separate process.
 */

import { createDb, migrate } from '@talkr/db';
import { createProvider } from './services/provider-factory.js';
import { provisionBrowserCredentials } from './services/provision.js';
import { applyRuntimeSettings } from './services/runtime-settings.js';
import { bootstrapTelnyxIfNeeded } from './services/telnyx-bootstrap.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { buildApp } from './app.js';
import { NullPodioClient, RealPodioClient, type PodioClient } from './services/podio.js';
import { JobRunner } from './worker/runner.js';
import { HANDLERS } from './worker/handlers.js';
import { makeRecordingMediaFetcher } from './services/recording-media.js';

let config = loadConfig();
const logger = createLogger(config.LOG_LEVEL);
if (config.AUTH_BYPASS_USER_EMAIL) {
  logger.warn(
    { user: config.AUTH_BYPASS_USER_EMAIL },
    'AUTH_BYPASS_USER_EMAIL is set: sign-in is off, every unauthenticated request runs as this user',
  );
}
const dbh = createDb(config.DATABASE_URL);

const applied = await migrate(dbh.pool);
if (applied.length > 0) logger.info({ applied }, 'migrations applied');

const settings = await applyRuntimeSettings(dbh);
config = settings.config;
if (settings.applied.length > 0) logger.info({ keys: settings.applied }, 'runtime settings applied from database');
config = await bootstrapTelnyxIfNeeded(dbh, config, logger);

const provider = createProvider(config, dbh);
void provisionBrowserCredentials(dbh, provider).catch((err: unknown) =>
  logger.warn({ err: (err as Error).message }, 'credential provisioning failed'),
);

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

let runner: JobRunner | null = null;
if (config.WORKER_INLINE) {
  runner = new JobRunner(
    {
      dbh,
      provider,
      podio,
      config,
      logger,
      fetchRecordingMedia: makeRecordingMediaFetcher(config, provider, dbh),
    },
    HANDLERS,
    { backoffBaseMs: config.JOB_BACKOFF_BASE_MS },
  );
  runner.start();
  logger.info('inline worker started');
}

await app.listen({ port: config.PORT, host: '0.0.0.0' });
logger.info({ port: config.PORT }, 'talkr platform server listening');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    logger.info({ signal }, 'shutting down');
    runner?.stop();
    await app.close();
    await dbh.close();
    process.exit(0);
  });
}
