/**
 * Inbound call control (docs/inbound-routing.md §4, §9):
 *   /twiml/inbound               number's Voice URL — IVR or route the caller
 *   /twiml/ivr-select            digit chosen (or timed out) on an IVR menu
 *   /twiml/queue-wait            queue hold cycle: re-evaluate, ring or wait
 *   /twiml/inbound-dial-complete direct-ring outcome — bridge done or voicemail
 *   /twiml/voicemail-complete    Record done — thanks + hangup
 * Synchronous work is a handful of indexed lookups; the raw delivery is still
 * persisted and the async pipeline still applies canonical events.
 */

import { randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import {
  FLOW_MAX_HOPS,
  enterFlowNode,
  flowUsesLastContact,
  isCallFlow,
  maskPhone,
  resumeFlow,
  type CallFlow,
  type FlowInstruction,
  type FlowPathEntry,
  type IvrConfig,
  type QueueConfig,
} from '@talkr/core';
import { enqueueJob, publishBusEvent, schema } from '@talkr/db';
import type { TelnyxVoiceProvider } from '@talkr/provider-telnyx';
import { clientTargetsFor } from '../services/client-address.js';
import type { AppDeps } from '../app.js';
import { receiveTwilioWebhook } from './webhooks.js';
import {
  loadQueueConfig,
  markRung,
  pickAndMarkQueueTargets,
  resolveInboundContext,
  voicemailGreetingFor,
} from '../services/inbound-routing.js';
import { loadFlowFacts, voicemailGreeting } from '../services/call-flows.js';

const QUEUE_WAIT_PAUSE_SECONDS = 10;
const QUEUE_MAX_CYCLES = 60; // hard backstop over max_wait_seconds

function sendTwiml(reply: FastifyReply, response: { contentType: string; body: string }): void {
  void reply.header('content-type', response.contentType).send(response.body);
}

type CallRow = typeof schema.calls.$inferSelect;
type NumberRow = typeof schema.phoneNumbers.$inferSelect;
type Handler = (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;

/**
 * The inbound Voice URL handler per app. Telnyx sends inbound calls to the
 * TeXML application's one Voice URL (/twiml/outbound-dial), so that route
 * hands a carrier-originated inbound call over to this one.
 */
export const inboundVoiceHandlers = new WeakMap<FastifyInstance, Handler>();

export function registerInboundTwimlRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config, dbh, logger } = deps;
  const provider = deps.provider as TelnyxVoiceProvider;

  // -------------------------------------------------------------------------
  // Render helpers (each journals what it decided on the call timeline)
  // -------------------------------------------------------------------------

  function voicemailTwiml(callId: string, greeting: string) {
    return provider.buildVoicemailResponse({
      greeting,
      maxLengthSeconds: 120,
      actionUrl: `${config.PUBLIC_BASE_URL}/twiml/voicemail-complete?call=${callId}`,
      recordingStatusCallbackUrl: `${config.PUBLIC_BASE_URL}/webhooks/telnyx/recording-status?call=${callId}`,
    });
  }

  async function markVoicemailOffered(callId: string, reason: string): Promise<void> {
    await dbh.db.execute(sql`
      UPDATE calls SET raw = raw || jsonb_build_object('voicemailOffered', true, 'voicemailReason', ${reason}::text)
      WHERE id = ${callId}`);
  }

  async function journal(call: CallRow, eventType: string, dedupe: string, payload: unknown) {
    await dbh.db
      .insert(schema.callEvents)
      .values({
        orgId: call.orgId,
        callId: call.id,
        eventType,
        occurredAt: new Date(),
        source: 'system',
        dedupeToken: dedupe,
        payload: payload as Record<string, unknown>,
      })
      .onConflictDoNothing();
  }

  async function renderRingUsers(
    reply: FastifyReply,
    call: CallRow,
    userIds: string[],
    opts: { timeoutSeconds: number; dialActionUrl: string; record?: boolean; whisperUrl?: string; skipIfNobody?: boolean },
  ): Promise<boolean> {
    const q = `call=${call.id}`;
    // A rep with no provider credential has never enabled their softphone;
    // skip them so the rest of the group still rings.
    const { targets, skipped } = await clientTargetsFor(dbh, provider, userIds);
    if (skipped.length > 0) {
      app.log.warn({ callId: call.id, skipped }, 'ring group members have no softphone credential');
    }
    if (targets.length === 0 && opts.skipIfNobody) return false;
    await markRung(dbh.db, userIds);
    sendTwiml(
      reply,
      provider.buildClientDialResponse({
        callerId: call.fromNumber,
        clientIdentities: targets,
        talkrCallId: call.id,
        timeoutSeconds: opts.timeoutSeconds,
        dialActionUrl: opts.dialActionUrl,
        statusCallbackUrl: `${config.PUBLIC_BASE_URL}/webhooks/telnyx/voice-status?${q}&leg=client`,
        record: opts.record ?? true,
        recordingStatusCallbackUrl: `${config.PUBLIC_BASE_URL}/webhooks/telnyx/recording-status?${q}`,
        whisperUrl: opts.whisperUrl,
      }),
    );
    return true;
  }

  // -------------------------------------------------------------------------
  // Call flows (phone_numbers.ivr version 2 — packages/core/src/call-flow.ts)
  // -------------------------------------------------------------------------

  async function flowFacts(call: CallRow, flow: CallFlow) {
    const lead = call.leadId
      ? (await dbh.db.select({ owner: schema.leads.assignedUserId }).from(schema.leads).where(eq(schema.leads.id, call.leadId)).limit(1))[0]
      : undefined;
    const tried = ((call.raw ?? {}) as { flowTried?: Record<string, string[]> }).flowTried ?? {};
    return loadFlowFacts(dbh.db, call.orgId, {
      leadOwnerUserId: lead?.owner ?? null,
      // Touch history is one more query; only flows that ask for it pay it.
      lastContactPhone: flowUsesLastContact(flow) ? call.fromNumber : null,
      tried,
    });
  }

  /**
   * A ring a last_contact target chose: say so on the call, so the answering
   * client (GET /v1/calls/ringing) and webhooks can show what it is about.
   * The first such ring on a call is the one recorded.
   */
  async function markLastContact(call: CallRow, ins: Extract<FlowInstruction, { kind: 'ring' }>): Promise<boolean> {
    if (!ins.lastContact) return false;
    const res = await dbh.db.execute(sql`
      UPDATE calls SET raw = raw || jsonb_build_object('routedVia', 'last_contact', 'lastContact', ${JSON.stringify(ins.lastContact)}::jsonb)
      WHERE id = ${call.id} AND NOT (raw ? 'lastContact') RETURNING id`);
    return res.rows.length > 0;
  }

  async function reloadCall(id: string): Promise<CallRow> {
    return (await dbh.db.select().from(schema.calls).where(eq(schema.calls.id, id)).limit(1))[0]!;
  }

  async function enqueueMissedCallText(call: CallRow) {
    await enqueueJob(dbh.db, {
      jobType: 'missed-call-text',
      payload: { callId: call.id },
      dedupeKey: `missed-call-text:${call.id}`,
      // After the caller has hung up, not while they hear the greeting.
      runAt: new Date(Date.now() + 30_000),
      correlationId: call.correlationId,
    });
  }

  /** The number a call's flow comes from: its own, or the company line's for a standby number. */
  async function flowNumberFor(number: NumberRow, orgSettings: unknown): Promise<NumberRow | null> {
    if (isCallFlow(number.ivr)) return number;
    const standby = !number.assignedUserId && !number.assignedTeamId && !number.queueId && !number.forwardToE164 && !number.ivr;
    const companyId = (orgSettings as { companyLineNumberId?: string } | null)?.companyLineNumberId;
    if (!standby || !companyId || companyId === number.id) return null;
    const company = (
      await dbh.db.select().from(schema.phoneNumbers)
        .where(and(eq(schema.phoneNumbers.id, companyId), eq(schema.phoneNumbers.orgId, number.orgId), eq(schema.phoneNumbers.status, 'active')))
        .limit(1)
    )[0];
    return company && isCallFlow(company.ivr) ? company : null;
  }

  /** Render one flow instruction as call control, journaling the path that led to it. */
  async function renderFlow(
    reply: FastifyReply,
    call: CallRow,
    number: NumberRow,
    flow: CallFlow,
    hops: number,
    ins: FlowInstruction,
    path: FlowPathEntry[],
  ): Promise<void> {
    if (path.length > 0) {
      await journal(call, 'call.flow_path', `${call.providerCallId}:flow:${randomUUID()}`, { numberId: number.id, path });
    }
    const base = config.PUBLIC_BASE_URL;
    const q = `call=${call.id}`;
    const action = (node: string, extra = '') =>
      `${base}/twiml/flow?${q}&num=${number.id}&hops=${hops}&node=${encodeURIComponent(node)}${extra}`;
    const whisperUrl = flow.whisper ? `${base}/twiml/whisper?${q}&num=${number.id}` : undefined;
    const recordingStatusCallbackUrl = `${base}/webhooks/telnyx/recording-status?${q}`;

    switch (ins.kind) {
      case 'ring': {
        // Who this call already rang on this step, so sequential and
        // round-robin move on to the next person on the way back.
        await dbh.db.execute(sql`
          UPDATE calls SET raw = jsonb_set(raw, '{flowTried}',
            COALESCE(raw->'flowTried', '{}'::jsonb) || jsonb_build_object(${ins.node}::text,
              COALESCE(raw->'flowTried'->${ins.node}, '[]'::jsonb) || ${JSON.stringify(ins.userIds)}::jsonb), true)
          WHERE id = ${call.id}`);
        // Recorded before the answer goes out, so the ringing browser's lookup sees it.
        const marked = await markLastContact(call, ins);
        const rang = await renderRingUsers(reply, call, ins.userIds, {
          timeoutSeconds: ins.timeoutSeconds,
          dialActionUrl: action(ins.node),
          record: flow.recording,
          whisperUrl,
          skipIfNobody: true,
        });
        if (rang) return;
        if (marked) {
          await dbh.db.execute(sql`UPDATE calls SET raw = raw - 'routedVia' - 'lastContact' WHERE id = ${call.id}`);
        }
        // Nobody on this step has a softphone: same as nobody answering.
        const fresh = await reloadCall(call.id);
        const nextPath: FlowPathEntry[] = [];
        const next = resumeFlow(flow, ins.node, { kind: 'dial', status: 'no-answer' }, await flowFacts(fresh, flow), nextPath);
        return renderFlow(reply, fresh, number, flow, hops, next, nextPath);
      }
      case 'forward':
        sendTwiml(
          reply,
          provider.buildForwardDialResponse({
            // The caller's number, so the teammate's phone shows who is calling.
            callerId: call.fromNumber,
            to: ins.to,
            timeoutSeconds: ins.timeoutSeconds,
            dialActionUrl: action(ins.node),
            statusCallbackUrl: `${base}/webhooks/telnyx/voice-status?${q}&leg=pstn`,
            record: flow.recording,
            recordingStatusCallbackUrl,
            whisperUrl,
          }),
        );
        return;
      case 'gather': {
        const g = 'tts' in ins.greeting ? { text: ins.greeting.tts } : { text: '', audioUrl: ins.greeting.audio_url };
        sendTwiml(
          reply,
          provider.buildIvrGatherResponse({
            greeting: g.text,
            greetingAudioUrl: g.audioUrl,
            actionUrl: action(ins.node, `&attempt=${ins.attempt}`),
            timeoutSeconds: ins.timeoutSeconds,
          }),
        );
        return;
      }
      case 'voicemail': {
        const org = (await dbh.db.select().from(schema.organizations).where(eq(schema.organizations.id, call.orgId)).limit(1))[0];
        const greeting = await voicemailGreeting(dbh.db, {
          step: ins.greeting,
          userId: ins.userId,
          flow,
          number,
          orgSettings: org?.settings,
        });
        const voicemailFor = ins.userId ?? number.assignedUserId;
        await dbh.db.execute(sql`
          UPDATE calls SET raw = raw || jsonb_build_object('voicemailOffered', true, 'voicemailReason', 'flow', 'voicemailFor', ${voicemailFor}::text)
          WHERE id = ${call.id}`);
        await enqueueMissedCallText(call);
        sendTwiml(
          reply,
          provider.buildVoicemailResponse({
            greeting: greeting.text,
            greetingAudioUrl: greeting.audioUrl,
            maxLengthSeconds: 120,
            actionUrl: `${base}/twiml/voicemail-complete?${q}`,
            recordingStatusCallbackUrl,
          }),
        );
        return;
      }
      case 'hangup':
        await enqueueMissedCallText(call);
        sendTwiml(reply, provider.buildRejectResponse(ins.message ?? undefined));
        return;
      case 'number_flow': {
        const target = (
          await dbh.db.select().from(schema.phoneNumbers)
            .where(and(eq(schema.phoneNumbers.id, ins.phoneNumberId), eq(schema.phoneNumbers.orgId, call.orgId), eq(schema.phoneNumbers.status, 'active')))
            .limit(1)
        )[0];
        const nextPath: FlowPathEntry[] = [];
        if (!target || !isCallFlow(target.ivr) || hops >= FLOW_MAX_HOPS) {
          nextPath.push({ node: ins.node, type: 'voicemail', detail: 'Hand-off target has no flow — voicemail' });
          return renderFlow(reply, call, number, flow, hops, { kind: 'voicemail', node: null, greeting: null, userId: null }, nextPath);
        }
        const next = enterFlowNode(target.ivr, target.ivr.start, await flowFacts(call, target.ivr), nextPath);
        return renderFlow(reply, call, target, target.ivr, hops + 1, next, nextPath);
      }
      case 'done':
        sendTwiml(reply, provider.buildHangupResponse());
        return;
    }
  }

  async function renderOverflow(reply: FastifyReply, call: CallRow, queue: QueueConfig) {
    if (queue.overflow === 'forward' && queue.overflowForwardE164) {
      const q = `call=${call.id}`;
      sendTwiml(
        reply,
        provider.buildForwardDialResponse({
          callerId: call.fromNumber,
          to: queue.overflowForwardE164,
          timeoutSeconds: 25,
          dialActionUrl: `${config.PUBLIC_BASE_URL}/twiml/inbound-dial-complete?${q}`,
          statusCallbackUrl: `${config.PUBLIC_BASE_URL}/webhooks/telnyx/voice-status?${q}&leg=pstn`,
          record: true,
          recordingStatusCallbackUrl: `${config.PUBLIC_BASE_URL}/webhooks/telnyx/recording-status?${q}`,
        }),
      );
      return;
    }
    const org = (
      await dbh.db
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.id, call.orgId))
        .limit(1)
    )[0]!;
    await markVoicemailOffered(call.id, 'queue_overflow');
    sendTwiml(reply, voicemailTwiml(call.id, voicemailGreetingFor(org)));
  }

  /**
   * One queue cycle: overflow when the caller has waited long enough,
   * otherwise ring whoever the strategy picks right now, otherwise hold.
   */
  async function renderQueueCycle(
    reply: FastifyReply,
    call: CallRow,
    queue: QueueConfig,
    startedEpochSec: number,
    cycle: number,
  ) {
    const elapsed = Math.floor(Date.now() / 1000) - startedEpochSec;
    if (elapsed >= queue.maxWaitSeconds || cycle >= QUEUE_MAX_CYCLES) {
      await journal(call, 'call.queue_overflow', `${call.providerCallId}:queue-overflow:x`, {
        queueId: queue.id,
        elapsedSeconds: elapsed,
        overflow: queue.overflow,
      });
      await renderOverflow(reply, call, queue);
      return;
    }
    const nextUrl = `${config.PUBLIC_BASE_URL}/twiml/queue-wait?call=${call.id}&started=${startedEpochSec}&n=${cycle + 1}`;
    const targets = await pickAndMarkQueueTargets(dbh.db, queue);
    if (targets.length > 0) {
      await journal(call, 'call.queue_ring', `${call.providerCallId}:queue-ring:${cycle}`, {
        queueId: queue.id,
        strategy: queue.strategy,
        targets,
        cycle,
      });
      // Ring timeout stays short so the caller returns to the hold loop and
      // the next cycle can pick a different member.
      await renderRingUsers(reply, call, targets, {
        timeoutSeconds: 15,
        dialActionUrl: nextUrl,
      });
      return;
    }
    sendTwiml(
      reply,
      provider.buildQueueWaitResponse({
        message: queue.waitMessage ?? 'Please hold while we connect you to the next available team member.',
        pauseSeconds: QUEUE_WAIT_PAUSE_SECONDS,
        redirectUrl: nextUrl,
      }),
    );
  }

  async function enterQueue(reply: FastifyReply, call: CallRow, queue: QueueConfig) {
    await dbh.db.execute(sql`
      UPDATE calls SET raw = raw || jsonb_build_object('queueId', ${queue.id}::text)
      WHERE id = ${call.id}`);
    await renderQueueCycle(reply, call, queue, Math.floor(Date.now() / 1000), 0);
  }

  // -------------------------------------------------------------------------
  // /twiml/inbound — number's Voice URL
  // -------------------------------------------------------------------------
  const inboundVoice: Handler = async (req, reply) => {
    const handled = await receiveTwilioWebhook(deps, req, 'inbound-voice', { enqueueProcessing: true });
    if (!handled.valid) return reply.code(403).send('invalid signature');

    const { CallSid, From, To } = handled.params;
    if (!CallSid || !From || !To) {
      sendTwiml(reply, provider.buildHangupResponse());
      return reply;
    }

    const context = await resolveInboundContext(dbh.db, To, From);
    if (!context) {
      logger.warn({ to: maskPhone(To) }, 'inbound call to unknown number');
      sendTwiml(reply, provider.buildRejectResponse('This number is not in service. Goodbye.'));
      return reply;
    }

    // A number with a call flow (or a standby number the company line's flow
    // covers) runs the flow instead of the default chain below.
    const flowNumber = await flowNumberFor(context.number, context.org.settings);
    const viaLastContact =
      !flowNumber && context.decision.action === 'ring_users' && context.decision.lastContact
        ? { routedVia: 'last_contact', lastContact: context.decision.lastContact }
        : {};

    const inserted = await dbh.db
      .insert(schema.calls)
      .values({
        orgId: context.org.id,
        direction: 'inbound',
        status: 'queued',
        phoneNumberId: context.number.id,
        contactId: context.contact?.id ?? null,
        leadId: context.lead?.id ?? null,
        userId:
          context.decision.action === 'ring_users' && context.decision.userIds.length === 1
            ? context.decision.userIds[0]
            : null,
        fromNumber: From,
        toNumber: To,
        provider: provider.name,
        providerCallId: CallSid,
        // routedVia/lastContact: default routing chose by last contact (a flow
        // sets them itself when one of its rings does).
        raw: { routing: context.decision, ...viaLastContact },
      })
      .onConflictDoNothing({ target: schema.calls.providerCallId })
      .returning();
    const call =
      inserted[0] ??
      (
        await dbh.db
          .select()
          .from(schema.calls)
          .where(eq(schema.calls.providerCallId, CallSid))
          .limit(1)
      )[0];
    if (!call) {
      sendTwiml(reply, provider.buildHangupResponse());
      return reply;
    }

    await journal(call, 'call.routing_decided', `${CallSid}:routing:x`, context.decision);

    if (flowNumber && isCallFlow(flowNumber.ivr)) {
      const flow = flowNumber.ivr;
      if (flowNumber.id !== context.number.id) {
        await dbh.db.execute(sql`
          UPDATE calls SET raw = raw || jsonb_build_object('flowNumberId', ${flowNumber.id}::text) WHERE id = ${call.id}`);
      }
      if (flow.announce) {
        sendTwiml(
          reply,
          provider.buildQueueWaitResponse({
            message: flow.announce,
            pauseSeconds: 0,
            redirectUrl: `${config.PUBLIC_BASE_URL}/twiml/flow?call=${call.id}&num=${flowNumber.id}&hops=0&start=1`,
          }),
        );
        return reply;
      }
      const path: FlowPathEntry[] = [];
      const ins = enterFlowNode(flow, flow.start, await flowFacts(call, flow), path);
      await renderFlow(reply, call, flowNumber, flow, 0, ins, path);
      logger.info({ callId: call.id, instruction: ins.kind, from: maskPhone(From) }, 'inbound call entered its flow');
      return reply;
    }

    // A configured IVR fronts everything except a recognized lead owner ring
    // or a callback to the rep who last reached out (CRM-aware
    // speed-to-answer beats the menu).
    if (context.ivr && context.decision.reason !== 'lead_owner' && context.decision.reason !== 'last_contact') {
      await journal(call, 'call.ivr_offered', `${CallSid}:ivr-offered:x`, {
        options: Object.keys(context.ivr.options),
      });
      sendTwiml(
        reply,
        provider.buildIvrGatherResponse({
          greeting: context.ivr.greeting,
          actionUrl: `${config.PUBLIC_BASE_URL}/twiml/ivr-select?call=${call.id}`,
        }),
      );
      return reply;
    }

    const decision = context.decision;
    const q = `call=${call.id}`;
    if (decision.action === 'ring_users') {
      await renderRingUsers(reply, call, decision.userIds, {
        timeoutSeconds: decision.timeoutSeconds,
        dialActionUrl: `${config.PUBLIC_BASE_URL}/twiml/inbound-dial-complete?${q}`,
      });
    } else if (decision.action === 'queue') {
      const queue = context.queue!;
      await enterQueue(reply, call, queue);
    } else if (decision.action === 'forward') {
      sendTwiml(
        reply,
        provider.buildForwardDialResponse({
          callerId: From,
          to: decision.to,
          timeoutSeconds: 25,
          dialActionUrl: `${config.PUBLIC_BASE_URL}/twiml/inbound-dial-complete?${q}`,
          statusCallbackUrl: `${config.PUBLIC_BASE_URL}/webhooks/telnyx/voice-status?${q}&leg=pstn`,
          record: true,
          recordingStatusCallbackUrl: `${config.PUBLIC_BASE_URL}/webhooks/telnyx/recording-status?${q}`,
        }),
      );
    } else {
      await markVoicemailOffered(call.id, decision.reason);
      sendTwiml(reply, voicemailTwiml(call.id, voicemailGreetingFor(context.org)));
    }
    logger.info(
      { callId: call.id, decision: decision.action, from: maskPhone(From) },
      'inbound call routed',
    );
    return reply;
  };
  app.post('/twiml/inbound', inboundVoice);
  inboundVoiceHandlers.set(app, inboundVoice);

  // -------------------------------------------------------------------------
  // /twiml/flow — a flow step came back: a dial finished, a key was pressed,
  // or the announcement ended (start=1)
  // -------------------------------------------------------------------------
  app.post('/twiml/flow', async (req, reply) => {
    const body = (req.body ?? {}) as Record<string, string>;
    const dialed = Boolean(body.DialCallStatus);
    const handled = await receiveTwilioWebhook(deps, req, dialed ? 'dial-complete' : 'ivr-select', { enqueueProcessing: dialed });
    if (!handled.valid) return reply.code(403).send('invalid signature');

    const { call: callId, num, node, start } = handled.merged;
    const call = callId ? (await dbh.db.select().from(schema.calls).where(eq(schema.calls.id, callId)).limit(1))[0] : undefined;
    const number = call && num
      ? (await dbh.db.select().from(schema.phoneNumbers).where(and(eq(schema.phoneNumbers.id, num), eq(schema.phoneNumbers.orgId, call.orgId))).limit(1))[0]
      : undefined;
    if (!call || !number || !isCallFlow(number.ivr)) {
      sendTwiml(reply, provider.buildHangupResponse());
      return reply;
    }
    const status = handled.params.DialCallStatus;
    if (dialed && (status === 'completed' || status === 'answered')) {
      sendTwiml(reply, provider.buildHangupResponse());
      return reply;
    }
    // The caller hung up while it was still ringing: a missed call, nothing left to render.
    if (handled.params.CallStatus === 'completed') {
      await enqueueMissedCallText(call);
      sendTwiml(reply, provider.buildHangupResponse());
      return reply;
    }

    const flow = number.ivr;
    const hops = Number(handled.merged.hops) || 0;
    const facts = await flowFacts(call, flow);
    const path: FlowPathEntry[] = [];
    const ins = start
      ? enterFlowNode(flow, flow.start, facts, path)
      : flow.nodes[node ?? '']?.type === 'menu' && !dialed
        ? resumeFlow(flow, node!, { kind: 'digits', digits: handled.params.Digits ?? null, attempt: Number(handled.merged.attempt) || 0 }, facts, path)
        : resumeFlow(flow, node ?? '', { kind: 'dial', status: status ?? 'no-answer' }, facts, path);
    await renderFlow(reply, call, number, flow, hops, ins, path);
    return reply;
  });

  /** What the answering rep hears before the caller is connected. */
  app.post('/twiml/whisper', async (req, reply) => {
    const handled = await receiveTwilioWebhook(deps, req, 'ivr-select', { enqueueProcessing: false });
    if (!handled.valid) return reply.code(403).send('invalid signature');
    const num = handled.merged.num;
    const number = num ? (await dbh.db.select().from(schema.phoneNumbers).where(eq(schema.phoneNumbers.id, num)).limit(1))[0] : undefined;
    const text = number && isCallFlow(number.ivr) ? number.ivr.whisper : null;
    sendTwiml(reply, provider.buildWhisperResponse(text ?? ''));
    return reply;
  });

  // -------------------------------------------------------------------------
  // /twiml/ivr-select — digit chosen (or Gather timed out with none)
  // -------------------------------------------------------------------------
  app.post('/twiml/ivr-select', async (req, reply) => {
    const handled = await receiveTwilioWebhook(deps, req, 'ivr-select', { enqueueProcessing: false });
    if (!handled.valid) return reply.code(403).send('invalid signature');

    const callId = handled.merged.call;
    const digits = handled.params.Digits;
    const call = callId
      ? (await dbh.db.select().from(schema.calls).where(eq(schema.calls.id, callId)).limit(1))[0]
      : undefined;
    if (!call) {
      sendTwiml(reply, provider.buildHangupResponse());
      return reply;
    }
    const number = call.phoneNumberId
      ? (
          await dbh.db
            .select()
            .from(schema.phoneNumbers)
            .where(eq(schema.phoneNumbers.id, call.phoneNumberId))
            .limit(1)
        )[0]
      : undefined;
    const ivr = (number?.ivr as IvrConfig | null) ?? null;
    const option = digits && ivr ? ivr.options[digits] : undefined;

    await journal(call, 'call.ivr_selected', `${call.providerCallId}:ivr-selected:x`, {
      digits: digits ?? null,
      matched: option?.type ?? 'none',
    });

    const org = (
      await dbh.db
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.id, call.orgId))
        .limit(1)
    )[0]!;
    const q = `call=${call.id}`;

    if (option?.type === 'queue') {
      const queue = await loadQueueConfig(dbh.db, option.queueId);
      if (queue && queue.memberUserIds.length > 0) {
        await enterQueue(reply, call, queue);
        return reply;
      }
    } else if (option?.type === 'user') {
      await renderRingUsers(reply, call, [option.userId], {
        timeoutSeconds: 25,
        dialActionUrl: `${config.PUBLIC_BASE_URL}/twiml/inbound-dial-complete?${q}`,
      });
      return reply;
    } else if (option?.type === 'forward') {
      sendTwiml(
        reply,
        provider.buildForwardDialResponse({
          callerId: call.fromNumber,
          to: option.to,
          timeoutSeconds: 25,
          dialActionUrl: `${config.PUBLIC_BASE_URL}/twiml/inbound-dial-complete?${q}`,
          statusCallbackUrl: `${config.PUBLIC_BASE_URL}/webhooks/telnyx/voice-status?${q}&leg=pstn`,
          record: true,
          recordingStatusCallbackUrl: `${config.PUBLIC_BASE_URL}/webhooks/telnyx/recording-status?${q}`,
        }),
      );
      return reply;
    }
    // voicemail option, unknown digit, or timeout: never drop the caller.
    await markVoicemailOffered(call.id, digits ? 'ivr_voicemail' : 'ivr_timeout');
    sendTwiml(reply, voicemailTwiml(call.id, voicemailGreetingFor(org)));
    return reply;
  });

  // -------------------------------------------------------------------------
  // /twiml/queue-wait — hold cycle and queue-dial outcome
  // -------------------------------------------------------------------------
  app.post('/twiml/queue-wait', async (req, reply) => {
    const handled = await receiveTwilioWebhook(deps, req, 'queue-wait', { enqueueProcessing: true });
    if (!handled.valid) return reply.code(403).send('invalid signature');

    const dialStatus = handled.params.DialCallStatus;
    if (dialStatus === 'completed' || dialStatus === 'answered') {
      sendTwiml(reply, provider.buildHangupResponse());
      return reply;
    }

    const callId = handled.merged.call;
    const started = Number(handled.merged.started);
    const cycle = Number(handled.merged.n ?? '0');
    const call = callId
      ? (await dbh.db.select().from(schema.calls).where(eq(schema.calls.id, callId)).limit(1))[0]
      : undefined;
    const queueId = (call?.raw as { queueId?: string } | null)?.queueId;
    const queue = call && queueId ? await loadQueueConfig(dbh.db, queueId) : null;
    if (!call || !queue || Number.isNaN(started)) {
      sendTwiml(reply, provider.buildHangupResponse());
      return reply;
    }
    await renderQueueCycle(reply, call, queue, started, Number.isNaN(cycle) ? 0 : cycle);
    return reply;
  });

  // -------------------------------------------------------------------------
  // /twiml/inbound-dial-complete — direct-ring outcome
  // -------------------------------------------------------------------------
  app.post('/twiml/inbound-dial-complete', async (req, reply) => {
    const handled = await receiveTwilioWebhook(deps, req, 'dial-complete', { enqueueProcessing: true });
    if (!handled.valid) return reply.code(403).send('invalid signature');

    const status = handled.params.DialCallStatus;
    const callId = handled.merged.call;
    if (status === 'completed' || status === 'answered' || !callId) {
      sendTwiml(reply, provider.buildHangupResponse());
      return reply;
    }
    const call = (
      await dbh.db.select().from(schema.calls).where(eq(schema.calls.id, callId)).limit(1)
    )[0];
    if (!call) {
      sendTwiml(reply, provider.buildHangupResponse());
      return reply;
    }
    const org = (
      await dbh.db
        .select()
        .from(schema.organizations)
        .where(eq(schema.organizations.id, call.orgId))
        .limit(1)
    )[0]!;
    await markVoicemailOffered(call.id, 'no_answer');
    sendTwiml(reply, voicemailTwiml(call.id, voicemailGreetingFor(org)));
    return reply;
  });

  // -------------------------------------------------------------------------
  // /twiml/voicemail-complete — Record verb action
  // -------------------------------------------------------------------------
  app.post('/twiml/voicemail-complete', async (req, reply) => {
    const handled = await receiveTwilioWebhook(deps, req, 'voicemail-complete', { enqueueProcessing: false });
    if (!handled.valid) return reply.code(403).send('invalid signature');
    const callId = handled.merged.call;
    if (callId && handled.params.RecordingSid) {
      const updated = await dbh.db.execute(sql`
        UPDATE calls SET raw = raw || jsonb_build_object('voicemailLeft', true)
        WHERE id = ${callId}
        RETURNING org_id, raw->>'voicemailFor' AS voicemail_for`);
      // Tell whoever the voicemail is for; the transcript follows through
      // the recording pipeline (transcribe-recording) when Deepgram is set.
      const row = updated.rows[0] as { org_id: string; voicemail_for: string | null } | undefined;
      if (row && !handled.duplicate) {
        await publishBusEvent(dbh.pool, {
          type: 'voicemail.left',
          orgId: row.org_id,
          userId: row.voicemail_for ?? undefined,
          callId,
        }).catch(() => undefined);
      }
    }
    sendTwiml(reply, provider.buildVoicemailThanksResponse());
    return reply;
  });
}
