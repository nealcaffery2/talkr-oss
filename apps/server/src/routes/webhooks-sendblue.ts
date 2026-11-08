/**
 * Sendblue webhooks (docs/messaging-channels.md). Same fast-ack discipline as
 * the Telnyx endpoints: authenticate → raw persist → dedupe → transactional
 * enqueue → respond. The process-sendblue-webhook job applies the events.
 *
 *   POST /webhooks/sendblue/status   per-message status_callback (we set it on
 *                                    every send, with ?token=…)
 *   POST /webhooks/sendblue/inbound  the account's `receive` webhook
 *
 * Both answer 404 when Sendblue is not configured, so the routes are inert on
 * a deployment that has not opted in.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { sendblueIdempotencyKey, type SendblueEndpoint } from '@talkr/provider-sendblue';
import type { AppDeps } from '../app.js';
import { ingestWebhook } from '../services/ingest.js';
import { kickJob } from '../services/job-kick.js';
import { resolveSendblue, verifySendblueCallbackToken } from '../services/channels.js';

const JOB_TYPE = 'process-sendblue-webhook';

function headersForLog(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of ['user-agent', 'content-type']) {
    const v = req.headers[h];
    if (typeof v === 'string') out[h] = v;
  }
  // Whether the secret header came, never its value.
  out['sb-signing-secret'] = req.headers['sb-signing-secret'] ? 'present' : 'absent';
  return out;
}

export function registerSendblueWebhookRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config, dbh } = deps;

  async function receive(req: FastifyRequest, endpoint: SendblueEndpoint) {
    const sendblue = resolveSendblue(deps);
    if (!sendblue) return { code: 404, body: 'sendblue not configured' };

    // The account webhook carries SENDBLUE_WEBHOOK_SECRET in sb-signing-secret.
    // A status callback may not (Sendblue documents no header on per-message
    // callbacks), so its URL carries a token only this deployment can mint.
    const query = (req.query ?? {}) as Record<string, string | undefined>;
    const valid =
      sendblue.verifyWebhookSecret(req.headers) ||
      (endpoint === 'sendblue-status' && verifySendblueCallbackToken(config, query.token));

    const body = (req.body ?? {}) as Record<string, unknown>;
    const key = valid ? sendblueIdempotencyKey(endpoint, body) : null;
    const result = await ingestWebhook(dbh.db, {
      provider: 'sendblue',
      endpoint,
      idempotencyKey: key ?? `rejected:${endpoint}:${randomUUID()}`,
      signatureValid: Boolean(valid && key),
      headers: headersForLog(req),
      rawBody: req.rawBodyString ?? '',
      parsed: body as Record<string, string>,
      providerObjectId: typeof body.message_handle === 'string' ? body.message_handle : undefined,
      providerEventType: typeof body.status === 'string' ? body.status : undefined,
      enqueueProcessing: Boolean(valid && key),
      jobType: JOB_TYPE,
    });
    if (!valid) {
      req.log.warn({ endpoint }, 'sendblue webhook rejected: secret/token mismatch');
      return { code: 403, body: 'invalid signature' };
    }
    if (!key) return { code: 200, body: 'ignored' }; // no message_handle: nothing to apply
    if (!result.duplicate) await kickJob(`${JOB_TYPE}:${result.webhookEventId}`, 2_000);
    return { code: 200, body: 'ok' };
  }

  app.post('/webhooks/sendblue/status', async (req, reply) => {
    const r = await receive(req, 'sendblue-status');
    return reply.code(r.code).send(r.body);
  });

  app.post('/webhooks/sendblue/inbound', async (req, reply) => {
    const r = await receive(req, 'sendblue-inbound');
    return reply.code(r.code).send(r.body);
  });
}
