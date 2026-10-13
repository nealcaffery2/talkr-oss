/**
 * Dedicated worker process entrypoint (production topology: one API process,
 * one+ worker processes, same image).
 */

import { createDb, enqueueJob, migrate } from '@talkr/db';
import { createProvider } from './services/provider-factory.js';
import { makeRecordingMediaFetcher } from './services/recording-media.js';
import { applyRuntimeSettings } from './services/runtime-settings.js';
import { bootstrapTelnyxIfNeeded } from './services/telnyx-bootstrap.js';
import { loadConfig } from './config.js';
import { createLogger } from './logger.js';
import { NullPodioClient, RealPodioClient, type PodioClient } from './services/podio.js';
import { JobRunner } from './worker/runner.js';
import { HANDLERS } from './worker/handlers.js';
import { seedWebhookFanout } from './worker/webhook-fanout.js';
import { seedWorkflowFanout } from './worker/workflow-fanout.js';
import { seedDialerWatch } from './worker/dialer-handlers.js';
import { scheduleContactTemperatureSweep } from './worker/contact-temperature-sweep.js';
import { scheduleTranscriptRetrySweep } from './worker/transcribe-handlers.js';

if (process.argv[1]?.endsWith('worker-main.ts')) {
  let config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL).child({ process: 'worker' });
  const dbh = createDb(config.DATABASE_URL);
  await migrate(dbh.pool);
  config = (await applyRuntimeSettings(dbh)).config;
  config = await bootstrapTelnyxIfNeeded(dbh, config, logger);

  const provider = createProvider(config, dbh);
  const podio: PodioClient =
    config.PODIO_CLIENT_ID && config.PODIO_CLIENT_SECRET && config.PODIO_APP_ID && config.PODIO_APP_TOKEN
      ? new RealPodioClient({
          clientId: config.PODIO_CLIENT_ID,
          clientSecret: config.PODIO_CLIENT_SECRET,
          appId: config.PODIO_APP_ID,
          appToken: config.PODIO_APP_TOKEN,
        })
      : new NullPodioClient(logger);

  const runner = new JobRunner(
    { dbh, provider, podio, config, logger, fetchRecordingMedia: makeRecordingMediaFetcher(config, provider, dbh) },
    HANDLERS,
    { backoffBaseMs: config.JOB_BACKOFF_BASE_MS },
  );
  runner.start();
  // Seed the self-perpetuating outbound-webhook fan-out sweep (Phase 10).
  await seedWebhookFanout(dbh.db, config.WEBHOOK_FANOUT_INTERVAL_MS);
  // Seed the dialer call_events watcher sweep (Phase 5 — docs/dialers.md §5).
  await seedDialerWatch(dbh.db, config.DIALER_WATCH_INTERVAL_MS);
  logger.info('worker started');

  // Cost-ledger sweep (docs/reporting.md §3.2): hourly, deduped per hour so
  // multiple workers/restarts collapse into one run. Sweeps are idempotent.
  const scheduleCostSweep = async () => {
    const hour = new Date().toISOString().slice(0, 13);
    await enqueueJob(dbh.db, {
      jobType: 'extract-provider-costs',
      payload: {},
      dedupeKey: `extract-provider-costs:${hour}`,
    }).catch((err: Error) => logger.warn({ err: err.message }, 'cost sweep enqueue failed'));
  };
  await scheduleCostSweep();
  const costSweepTimer = setInterval(() => void scheduleCostSweep(), 60 * 60_000);

  // Workflow engine (Phase 7 — docs/workflows.md): seed the self-perpetuating
  // trigger sweep + schedule the hourly no_contact_for_days sweep (deduped
  // per hour like the cost sweep; sweeps are idempotent via the run unique key).
  await seedWorkflowFanout(dbh.db, config.WORKFLOW_FANOUT_INTERVAL_MS);
  const scheduleWorkflowTimeSweep = async () => {
    const hour = new Date().toISOString().slice(0, 13);
    await enqueueJob(dbh.db, {
      jobType: 'workflow-time-sweep',
      payload: {},
      dedupeKey: `workflow-time-sweep:${hour}`,
    }).catch((err: Error) => logger.warn({ err: err.message }, 'workflow time sweep enqueue failed'));
  };
  await scheduleWorkflowTimeSweep();
  const workflowSweepTimer = setInterval(() => void scheduleWorkflowTimeSweep(), 60 * 60_000);

  // Contact temperature (docs/contacts.md §4): hourly, deduped per hour like
  // the two sweeps above; scores are recomputed, so re-runs are harmless.
  const scheduleContactSweep = async () => {
    await scheduleContactTemperatureSweep(dbh.db).catch((err: Error) =>
      logger.warn({ err: err.message }, 'contact temperature sweep enqueue failed'),
    );
  };
  await scheduleContactSweep();
  const contactSweepTimer = setInterval(() => void scheduleContactSweep(), 60 * 60_000);

  // Transcripts that failed on carrier media (docs/transcription.md §1):
  // every few minutes, deduped per quarter hour like the sweeps above, so an
  // expired recording URL costs a transcript minutes rather than for good.
  const scheduleTranscriptRetries = async () => {
    await scheduleTranscriptRetrySweep(dbh.db).catch((err: Error) =>
      logger.warn({ err: err.message }, 'transcript retry sweep enqueue failed'),
    );
  };
  await scheduleTranscriptRetries();
  const transcriptRetryTimer = setInterval(() => void scheduleTranscriptRetries(), 5 * 60_000);

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, async () => {
      clearInterval(costSweepTimer);
      clearInterval(workflowSweepTimer);
      clearInterval(contactSweepTimer);
      clearInterval(transcriptRetryTimer);
      runner.stop();
      await dbh.close();
      process.exit(0);
    });
  }
}
