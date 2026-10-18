/**
 * SMS webhook ingestion (docs/sms.md §3). Same fast-ack discipline as voice:
 * signature check → raw persist → dedupe → transactional enqueue → respond.
 * No business tables are touched synchronously; the process-sms-webhook job
 * applies the events (apply-events.ts is voice-only and untouched).
 */

import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { kickJob } from '../services/job-kick.js';
import { receiveTwilioWebhook } from './webhooks.js';

/**
 * Apply a just-stored delivery now, not on the worker's next tick: a reply
 * lands in the inbox and a sent text reads Delivered within a second instead
 * of up to a minute later (services/job-kick.ts). Capped short so the ack to
 * Telnyx stays fast; the tick finishes anything a kick did not.
 */
async function applyNow(handled: { valid: boolean; duplicate: boolean; webhookEventId?: string | null }) {
  if (handled.valid && !handled.duplicate && handled.webhookEventId) {
    await kickJob(`process-sms-webhook:${handled.webhookEventId}`, 2_000);
  }
}

export function registerSmsWebhookRoutes(app: FastifyInstance, deps: AppDeps): void {
  /** Incoming-message webhook (the messaging profile's inbound URL). */
  app.post('/webhooks/telnyx/inbound-sms', async (req, reply) => {
    const handled = await receiveTwilioWebhook(deps, req, 'inbound-sms', {
      enqueueProcessing: true,
      jobType: 'process-sms-webhook',
    });
    if (!handled.valid) return reply.code(403).send('invalid signature');
    await applyNow(handled);
    // A bare 200 ack. Auto-replies (STOP/HELP/START) go through the normal send
    // path asynchronously, never inline. This used to answer with Twilio's
    // empty TwiML, which the Telnyx adapter has no builder for: every inbound
    // text 500'd after it was stored, and Telnyx retried it.
    return reply.code(200).send('ok');
  });

  /** Message delivery-status callbacks. */
  app.post('/webhooks/telnyx/sms-status', async (req, reply) => {
    const handled = await receiveTwilioWebhook(deps, req, 'sms-status', {
      enqueueProcessing: true,
      jobType: 'process-sms-webhook',
    });
    if (!handled.valid) return reply.code(403).send('invalid signature');
    await applyNow(handled);
    return reply.code(200).send('ok');
  });
}
