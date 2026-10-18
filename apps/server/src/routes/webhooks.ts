/**
 * Provider webhook + call-control endpoints. Fast-ack discipline:
 * signature check → raw persist → dedupe → transactional enqueue → respond.
 * Only /twiml/* does synchronous business work (Twilio blocks on the reply).
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { eq } from 'drizzle-orm';
import { conferenceRoomName, holdMusicWaitUrl, maskPhone, readHoldMusic } from '@talkr/core';
import { enqueueJob, schema } from '@talkr/db';
import type { AppDeps } from '../app.js';
import { ingestWebhook } from '../services/ingest.js';
import { clientAddressFor } from '../services/client-address.js';
import { applyCanonicalEvent } from '../services/apply-events.js';
import {
  CONFERENCE_DIAL_FALLBACK_DELAY_MS,
  dialCustomerIntoConference,
  dialCustomerOnAgentJoin,
} from '../services/conference-dial.js';
import { writeAudit } from '../services/audit.js';
import { inboundVoiceHandlers } from './twiml-inbound.js';

const DEBUG_HEADERS = ['telnyx-signature-ed25519', 'telnyx-timestamp', 'user-agent', 'content-type'];

function debugHeaders(req: FastifyRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const h of DEBUG_HEADERS) {
    const v = req.headers[h];
    if (typeof v === 'string') out[h] = v;
  }
  return out;
}

export interface HandledWebhook {
  valid: boolean;
  duplicate: boolean;
  params: Record<string, string>;
  merged: Record<string, string>;
  webhookEventId: string | null;
}

export async function receiveTwilioWebhook(
  deps: AppDeps,
  req: FastifyRequest,
  endpoint:
    | 'voice-status'
    | 'recording-status'
    | 'dial-complete'
    | 'inbound-voice'
    | 'twiml-outbound'
    | 'voicemail-complete'
    | 'queue-wait'
    | 'ivr-select'
    | 'inbound-sms'
    | 'sms-status'
    | 'campaign-answer'
    | 'campaign-bridge-complete'
    | 'conference-status',
  opts: { enqueueProcessing: boolean; jobType?: string },
): Promise<HandledWebhook> {
  const { config, dbh, provider } = deps;
  // Telnyx Messaging API v2 posts JSON events; the rest of the pipeline reads
  // the flat TeXML-style params, so a message event is flattened first. The
  // signature still covers the raw bytes (rawBodyString), not this view.
  let params = (provider.flattenMessageWebhook?.(endpoint, req.body) ?? req.body ?? {}) as Record<string, string>;
  const query = (req.query ?? {}) as Record<string, string>;
  const url = `${config.PUBLIC_BASE_URL}${req.raw.url ?? ''}`;
  const rawBody = (req as FastifyRequest & { rawBodyString?: string }).rawBodyString ?? '';

  let valid = provider.validateWebhook({
    url,
    method: req.method,
    headers: req.headers,
    params,
    rawBody,
  });

  // Telnyx posts 2010-04-01 SMS webhooks unsigned. Those are accepted only
  // when the carrier confirms the message, and stored from its record.
  if (
    !valid &&
    (endpoint === 'inbound-sms' || endpoint === 'sms-status') &&
    !req.headers['telnyx-signature-ed25519'] &&
    provider.confirmMessageWebhook
  ) {
    const confirmed = await provider.confirmMessageWebhook(endpoint, params);
    if (confirmed) {
      params = confirmed;
      valid = true;
    }
  }

  const merged = { ...params, ...query };
  const idempotencyKey = valid
    ? provider.idempotencyKey(endpoint, merged)
    : `rejected:${endpoint}:${randomUUID()}`;

  const result = await ingestWebhook(dbh.db, {
    // The carrier that delivered it. Older rows said 'twilio' whatever carried
    // them; migration 0026 relabels those, and the workers still accept the old
    // label for anything an old instance writes mid-deploy.
    provider: provider.name,
    endpoint,
    idempotencyKey,
    signatureValid: valid,
    headers: debugHeaders(req),
    rawBody,
    parsed: merged,
    providerObjectId: params.CallSid ?? params.RecordingSid ?? params.MessageSid,
    providerEventType:
      params.CallStatus ?? params.RecordingStatus ?? params.DialCallStatus ?? params.MessageStatus,
    enqueueProcessing: opts.enqueueProcessing && valid,
    jobType: opts.jobType,
  });

  if (!valid) {
    req.log.warn({ endpoint, url }, 'webhook signature rejected');
  }
  return {
    valid,
    duplicate: result.duplicate,
    params,
    merged,
    webhookEventId: result.webhookEventId,
  };
}

function sendTwiml(reply: FastifyReply, response: { contentType: string; body: string }): void {
  void reply.header('content-type', response.contentType).send(response.body);
}

export function registerWebhookRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config, dbh, provider, logger } = deps;

  // -------------------------------------------------------------------------
  // Status callbacks: pure ingestion, processed async by the worker.
  // -------------------------------------------------------------------------
  app.post('/webhooks/telnyx/voice-status', async (req, reply) => {
    const handled = await receiveTwilioWebhook(deps, req, 'voice-status', { enqueueProcessing: true });
    if (!handled.valid) return reply.code(403).send('invalid signature');
    return reply.code(200).send('ok');
  });

  app.post('/webhooks/telnyx/recording-status', async (req, reply) => {
    const handled = await receiveTwilioWebhook(deps, req, 'recording-status', { enqueueProcessing: true });
    if (!handled.valid) return reply.code(403).send('invalid signature');
    return reply.code(200).send('ok');
  });

  /**
   * Conference lifecycle + participant callbacks (docs/telephony-events.md §9).
   * Ordinary ingestion: the room is not waiting on this response, so the
   * roster is reconciled by the worker like every other status callback.
   */
  app.post('/webhooks/telnyx/conference-status', async (req, reply) => {
    const handled = await receiveTwilioWebhook(deps, req, 'conference-status', {
      enqueueProcessing: true,
    });
    if (!handled.valid) return reply.code(403).send('invalid signature');

    // The rep's leg just joined an outbound call's room: ring the seller now.
    // Telnyx only lets us address a room by its id, which exists from this
    // moment on (the callback carries it), so this is the earliest the dial
    // can happen. Inline for the same reason outbound-dial dials inline — the
    // worker tick is a minute away — and non-fatal for the same reason too:
    // the queued conference-dial-customer job is the net under it.
    if (!handled.duplicate && handled.params.StatusCallbackEvent === 'participant-join') {
      try {
        const outcome = await dialCustomerOnAgentJoin({ dbh, provider, config, logger }, handled.params);
        if (!outcome.dialed && outcome.reason !== 'not_a_room_of_ours' && outcome.reason !== 'not_the_agent') {
          logger.info({ room: handled.params.FriendlyName, reason: outcome.reason }, 'customer dial on participant-join skipped');
        }
      } catch (err) {
        logger.warn(
          { room: handled.params.FriendlyName, err: (err as Error).message },
          'customer dial on participant-join failed; the queued fallback will retry',
        );
      }
    }
    return reply.code(200).send('ok');
  });

  // -------------------------------------------------------------------------
  // Call control: Twilio blocks the live call on these responses.
  // -------------------------------------------------------------------------

  /**
   * TwiML App voice URL. The browser SDK connects with { talkr_call_id };
   * the server decides what actually gets dialed — the client can never make
   * us dial an arbitrary number with our caller ID.
   */
  app.post('/twiml/outbound-dial', async (req, reply) => {
    // Telnyx points every number at the TeXML application's single Voice URL,
    // this one. A carrier-originated inbound call carries no call id of ours:
    // it is routed like any other inbound call.
    const body = (req.body ?? {}) as Record<string, string>;
    const query = (req.query ?? {}) as Record<string, string>;
    if (!body.talkr_call_id && !query.talkr_call_id && body.Direction === 'inbound') {
      const inbound = inboundVoiceHandlers.get(app);
      if (inbound) return inbound(req, reply);
    }
    const handled = await receiveTwilioWebhook(deps, req, 'twiml-outbound', { enqueueProcessing: false });
    if (!handled.valid) return reply.code(403).send('invalid signature');

    // Twilio delivers the connect parameter in the body; a server-originated
    // Telnyx leg carries it on the answer URL's query string. `merged` has both.
    const callId = handled.merged.talkr_call_id;
    const callSid = handled.params.CallSid;
    const call = callId
      ? (
          await dbh.db.select().from(schema.calls).where(eq(schema.calls.id, callId)).limit(1)
        )[0]
      : undefined;

    if (!call || !callSid) {
      logger.warn({ callId, callSid }, 'twiml request for unknown call');
      sendTwiml(reply, provider.buildHangupResponse());
      return reply;
    }

    // Adopt the client leg as the call's parent provider id (idempotent on retry).
    if (!call.providerCallId) {
      await dbh.db
        .update(schema.calls)
        .set({ providerCallId: callSid })
        .where(eq(schema.calls.id, call.id));
    } else if (call.providerCallId !== callSid) {
      // A second browser connection for an already-bound call: refuse.
      logger.warn({ callId: call.id, callSid }, 'call already bound to another provider call');
      sendTwiml(reply, provider.buildHangupResponse());
      return reply;
    }

    await applyCanonicalEvent(
      dbh,
      {
        type: 'call.initiated',
        provider: provider.name,
        providerObjectId: callSid,
        occurredAt: new Date(),
        data: {
          talkrCallId: call.id,
          legRole: 'client',
          from: handled.params.From,
          to: call.toNumber,
          direction: 'outbound',
        },
        raw: handled.params,
      },
      {
        webhookEventId: handled.webhookEventId ?? undefined,
        source: 'api',
        logger,
        reconcileDelayMs: config.RECONCILE_DELAY_MS,
      },
    );

    const q = `call=${call.id}`;

    // Conference mode (docs/telephony-events.md §9): the browser joins a room
    // rather than bridging straight to the seller, because a two-leg bridge
    // cannot hold one party, add a third, or hand the caller to a teammate.
    if (config.CALL_CONTROL_MODE === 'conference') {
      const room = conferenceRoomName(call.id);
      await dbh.db
        .insert(schema.callParticipants)
        .values({
          orgId: call.orgId,
          callId: call.id,
          roomName: room,
          providerParticipantId: callSid,
          role: 'agent',
          state: 'ringing',
          userId: call.userId,
          // The rep's own leg, addressed the way their provider reaches it.
          address: call.userId
            ? await clientAddressFor(dbh, provider, call.userId).catch(() => '')
            : '',
          label: 'You',
        })
        .onConflictDoNothing({ target: schema.callParticipants.providerParticipantId });

      // What the rep hears while alone in the room (§9.7). One indexed
      // primary-key read; a missing or malformed setting resolves to the
      // provider's own default rather than failing the call.
      const org = (
        await dbh.db
          .select({ settings: schema.organizations.settings })
          .from(schema.organizations)
          .where(eq(schema.organizations.id, call.orgId))
          .limit(1)
      )[0];

      // Durability first: the fallback job is on the queue before the inline
      // dial is attempted, so even a crash mid-request ends in a rung seller.
      // It is dedupe-keyed and the dial itself is claim-gated, so the two
      // attempts can never both ring the customer.
      await enqueueJob(dbh.db, {
        jobType: 'conference-dial-customer',
        payload: { callId: call.id },
        dedupeKey: `conference-dial:${call.id}`,
        correlationId: call.correlationId,
        runAt: new Date(Date.now() + CONFERENCE_DIAL_FALLBACK_DELAY_MS),
      });

      // Ring the seller *now* rather than on the next worker tick. The
      // participant-add is a few hundred milliseconds against Twilio's ~15s
      // TwiML budget, and the queue that used to carry this is drained by a
      // once-a-minute cron on the serverless deployment — which is exactly
      // the delay the rep was hearing as hold music.
      //
      // Deliberately non-fatal: a provider hiccup is logged and the TwiML is
      // still returned, so the rep lands in the room and the queued job above
      // recovers the call. A dead call is never an acceptable outcome here.
      try {
        const outcome = await dialCustomerIntoConference({ dbh, provider, config, logger }, call);
        if (!outcome.dialed) {
          logger.info({ callId: call.id, reason: outcome.reason }, 'inline customer dial skipped');
        }
      } catch (err) {
        logger.warn(
          { callId: call.id, callSid, err: (err as Error).message },
          'inline customer dial failed; the queued fallback will retry',
        );
      }

      sendTwiml(
        reply,
        provider.buildConferenceResponse({
          roomName: room,
          startConferenceOnEnter: true,
          // The rep hanging up ends the call — until a transfer flips this off
          // on the participant so the customer outlives the rep leaving.
          endConferenceOnExit: true,
          statusCallbackUrl: `${config.PUBLIC_BASE_URL}/webhooks/telnyx/conference-status`,
          record: true,
          recordingStatusCallbackUrl: `${config.PUBLIC_BASE_URL}/webhooks/telnyx/recording-status?${q}`,
          waitUrl: holdMusicWaitUrl(readHoldMusic(org?.settings)),
        }),
      );
      logger.info(
        { callId: call.id, callSid, room, to: maskPhone(call.toNumber) },
        'outbound conference TwiML issued',
      );
      return reply;
    }

    sendTwiml(
      reply,
      provider.buildOutboundDialResponse({
        callerId: call.fromNumber,
        to: call.toNumber,
        statusCallbackUrl: `${config.PUBLIC_BASE_URL}/webhooks/telnyx/voice-status?${q}&leg=pstn`,
        dialActionUrl: `${config.PUBLIC_BASE_URL}/twiml/dial-complete?${q}`,
        record: true,
        recordingStatusCallbackUrl: `${config.PUBLIC_BASE_URL}/webhooks/telnyx/recording-status?${q}`,
      }),
    );
    logger.info(
      { callId: call.id, callSid, to: maskPhone(call.toNumber) },
      'outbound dial TwiML issued',
    );
    return reply;
  });

  /** <Dial> action: definitive child-leg outcome; processed async. */
  app.post('/twiml/dial-complete', async (req, reply) => {
    const handled = await receiveTwilioWebhook(deps, req, 'dial-complete', { enqueueProcessing: true });
    if (!handled.valid) return reply.code(403).send('invalid signature');
    sendTwiml(reply, provider.buildHangupResponse());
    return reply;
  });

  // /twiml/inbound and its dial/voicemail continuations live in
  // routes/twiml-inbound.ts (Phase 3 routing — docs/inbound-routing.md).
}
