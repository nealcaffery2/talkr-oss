/**
 * SMS job handlers (docs/sms.md §3, §5, §7). Each handler is idempotent —
 * jobs are at-least-once. Registered in handlers.ts alongside the voice set.
 */

import { eq } from 'drizzle-orm';
import { isMessageEvent, maskPhone } from '@talkr/core';
import { publishBusEvent, schema } from '@talkr/db';
import { normalizeSendblueWebhook, SendblueApiError } from '@talkr/provider-sendblue';
import { applyMessageEvent, findSmsSuppression } from '../services/messages.js';
import {
  chooseOutboundChannel,
  lineForConversation,
  resolveRcsLine,
  resolveSendblue,
  resolveSendblueLine,
  sendblueStatusCallbackUrl,
} from '../services/channels.js';
import { writeAudit } from '../services/audit.js';
import type { JobHandler } from './handlers.js';

// ---------------------------------------------------------------------------
// process-sms-webhook: raw delivery → canonical message events → state.
// A separate job type from the voice process-webhook because apply-events.ts
// (frozen this phase) intentionally ignores message events.
// ---------------------------------------------------------------------------
export const processSmsWebhook: JobHandler = async (deps, job) => {
  const { dbh, provider, logger } = deps;
  const { webhookEventId } = job.payload as { webhookEventId: string };
  const row = (
    await dbh.db
      .select()
      .from(schema.webhookEvents)
      .where(eq(schema.webhookEvents.id, webhookEventId))
      .limit(1)
  )[0];
  if (!row) throw new Error(`webhook event ${webhookEventId} not found`);
  if (row.status === 'processed') return; // idempotent re-run

  await dbh.db
    .update(schema.webhookEvents)
    .set({ status: 'processing', attempts: row.attempts + 1 })
    .where(eq(schema.webhookEvents.id, row.id));

  try {
    const events =
      // 'twilio' is how rows were labelled before the carrier name was recorded.
      row.provider === provider.name || row.provider === 'twilio'
        ? provider.normalizeWebhook(row.endpoint, row.parsed as Record<string, string>)
        : [];
    for (const event of events) {
      if (!isMessageEvent(event)) continue; // sms endpoints emit message events only
      // Inbound RCS is addressed to the agent; file it under one of our lines.
      if (event.type === 'message.received' && !event.data.to && event.data.channel === 'rcs' && event.data.from) {
        const ours = await resolveRcsLine(dbh.db, deps.config, event.data.from);
        if (ours) event.data.to = ours;
      }
      const result = await applyMessageEvent(dbh, event, {
        webhookEventId: row.id,
        logger,
      });
      logger.info(
        {
          webhookEventId: row.id,
          eventType: event.type,
          outcome: result.outcome,
          messageId: result.messageId,
        },
        'canonical message event applied',
      );
    }
    await dbh.db
      .update(schema.webhookEvents)
      .set({ status: 'processed', processedAt: new Date(), lastError: null })
      .where(eq(schema.webhookEvents.id, row.id));
  } catch (err) {
    await dbh.db
      .update(schema.webhookEvents)
      .set({ status: 'failed', lastError: (err as Error).message })
      .where(eq(schema.webhookEvents.id, row.id));
    throw err;
  }
};

// ---------------------------------------------------------------------------
// send-message: queued message row → provider send (docs/sms.md §5).
// Provider failure throws → standard backoff/retry; at max attempts the
// runner's dead-letter hook marks the message failed.
// ---------------------------------------------------------------------------
export const sendQueuedMessage: JobHandler = async (deps, job) => {
  const { dbh, provider, config, logger } = deps;
  const { messageId } = job.payload as { messageId: string };
  const message = (
    await dbh.db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).limit(1)
  )[0];
  if (!message) throw new Error(`message ${messageId} not found`);
  // Idempotent re-run: already handed to the provider (or terminal).
  if (message.status !== 'queued' || message.providerMessageSid) return;

  const conversation = (
    await dbh.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, message.conversationId))
      .limit(1)
  )[0];
  if (!conversation) throw new Error(`conversation ${message.conversationId} not found`);

  // Suppression re-check at send time (a STOP can land between queue and
  // send). Compliance auto-replies bypass this — docs/sms.md §4.
  if (!message.isAutoReply) {
    const suppressed = await findSmsSuppression(dbh.db, message.orgId, conversation.theirNumber);
    if (suppressed) {
      await dbh.db
        .update(schema.messages)
        .set({
          status: 'failed',
          failureClass: 'suppressed',
          errorCode: 'suppressed',
          failedAt: new Date(),
        })
        .where(eq(schema.messages.id, message.id));
      await writeAudit(dbh.db, {
        orgId: message.orgId,
        actorType: 'system',
        action: 'message.blocked_suppressed',
        objectType: 'message',
        objectId: message.id,
      });
      logger.info(
        { messageId: message.id, to: maskPhone(conversation.theirNumber) },
        'send blocked: destination suppressed after queueing',
      );
      return;
    }
  }

  const mediaUrls = Array.isArray(message.mediaUrls) ? (message.mediaUrls as string[]) : [];

  // iMessage or RCS when this deployment, this line and this recipient all
  // allow it; SMS otherwise (docs/messaging-channels.md). Suppression above
  // applies whatever the channel.
  const sendblue = resolveSendblue(deps);
  const line = await lineForConversation(dbh.db, conversation);
  const route = await chooseOutboundChannel(dbh.db, {
    config,
    provider,
    sendblue,
    line,
    to: conversation.theirNumber,
    mediaCount: mediaUrls.length,
  });

  let providerMessageId: string;
  let providerName: string = provider.name;
  let channel: 'sms' | 'imessage' | 'rcs' = 'sms';
  let imessageId: string | null = null;
  if (route.channel === 'imessage' && sendblue && route.sendblueFrom) {
    try {
      imessageId = (
        await sendblue.sendMessage({
          from: route.sendblueFrom,
          to: conversation.theirNumber,
          body: message.body,
          ...(mediaUrls[0] ? { mediaUrl: mediaUrls[0] } : {}),
          statusCallbackUrl: sendblueStatusCallbackUrl(config),
        })
      ).providerMessageId;
    } catch (err) {
      // A 4xx is Sendblue refusing the request (a line's new-contact cap, a
      // validation rule): nothing was queued there, so the text goes as SMS
      // now rather than waiting out retries. A 5xx or a dropped connection
      // may have been accepted, so it retries like any provider error.
      if (!(err instanceof SendblueApiError) || err.status < 400 || err.status >= 500) throw err;
      logger.warn(
        { messageId: message.id, status: err.status, err: err.message },
        'sendblue refused the send; sending as SMS',
      );
    }
  }
  if (imessageId) {
    providerMessageId = imessageId;
    providerName = 'sendblue';
    channel = 'imessage';
  } else if (route.channel === 'rcs' && provider.sendRcsMessage) {
    ({ providerMessageId } = await provider.sendRcsMessage({
      to: conversation.theirNumber,
      body: message.body,
      smsFallbackFrom: conversation.ourNumber,
      statusCallbackUrl: `${config.PUBLIC_BASE_URL}/webhooks/telnyx/sms-status`,
    }));
    channel = 'rcs';
  } else {
    ({ providerMessageId } = await provider.sendMessage({
      from: conversation.ourNumber,
      to: conversation.theirNumber,
      body: message.body,
      ...(mediaUrls.length > 0 ? { mediaUrls } : {}),
      statusCallbackUrl: `${config.PUBLIC_BASE_URL}/webhooks/telnyx/sms-status`,
    }));
  }

  // Stamp the SID; only advance queued → sending (a fast status callback can
  // only be applied after this row is committed, so the guard is belt-and-
  // braces for re-runs).
  await dbh.db
    .update(schema.messages)
    .set({
      providerMessageSid: providerMessageId,
      provider: providerName,
      channel,
      status: message.status === 'queued' ? 'sending' : message.status,
    })
    .where(eq(schema.messages.id, message.id));

  await publishBusEvent(dbh.pool, {
    type: 'message.updated',
    orgId: message.orgId,
    status: 'sending',
    data: { conversationId: conversation.id, messageId: message.id, channel },
  }).catch(() => undefined);

  logger.info(
    {
      messageId: message.id,
      providerMessageId,
      channel,
      channelReason: route.reason,
      to: maskPhone(conversation.theirNumber),
    },
    'message handed to provider',
  );
};

// ---------------------------------------------------------------------------
// process-sendblue-webhook: a stored Sendblue delivery → canonical events.
// Inbound iMessage arrives on a Sendblue number; it is filed under the Talkr
// line that number belongs to, so SMS and iMessage with one person share a
// thread and every inbound rule (STOP/HELP/START, Podio, unread) applies.
// ---------------------------------------------------------------------------
export const processSendblueWebhook: JobHandler = async (deps, job) => {
  const { dbh, config, logger } = deps;
  const { webhookEventId } = job.payload as { webhookEventId: string };
  const row = (
    await dbh.db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.id, webhookEventId)).limit(1)
  )[0];
  if (!row) throw new Error(`webhook event ${webhookEventId} not found`);
  if (row.status === 'processed') return;

  await dbh.db
    .update(schema.webhookEvents)
    .set({ status: 'processing', attempts: row.attempts + 1 })
    .where(eq(schema.webhookEvents.id, row.id));

  try {
    const endpoint = row.endpoint === 'sendblue-inbound' ? 'sendblue-inbound' : 'sendblue-status';
    for (const event of normalizeSendblueWebhook(endpoint, row.parsed)) {
      if (event.type === 'message.received' && event.data.from && event.data.to) {
        const line = await resolveSendblueLine(dbh.db, config, event.data.to, event.data.from);
        if (!line) {
          await dbh.db.insert(schema.reconciliationMismatches).values({
            objectType: 'orphan_provider_message',
            provider: 'sendblue',
            providerObjectId: event.providerObjectId,
            field: 'message',
            internalValue: null,
            providerValue: `sendblue line ${maskPhone(event.data.to)} maps to no Talkr number`,
          });
          logger.warn({ webhookEventId: row.id }, 'inbound iMessage on an unmapped Sendblue line');
          continue;
        }
        event.data.to = line.phoneE164;
      }
      const result = await applyMessageEvent(dbh, event, { webhookEventId: row.id, logger });
      logger.info(
        { webhookEventId: row.id, eventType: event.type, outcome: result.outcome, messageId: result.messageId },
        'sendblue message event applied',
      );
    }
    await dbh.db
      .update(schema.webhookEvents)
      .set({ status: 'processed', processedAt: new Date(), lastError: null })
      .where(eq(schema.webhookEvents.id, row.id));
  } catch (err) {
    await dbh.db
      .update(schema.webhookEvents)
      .set({ status: 'failed', lastError: (err as Error).message })
      .where(eq(schema.webhookEvents.id, row.id));
    throw err;
  }
};

// ---------------------------------------------------------------------------
// podio-sync-message-activity: exactly one CRM comment per inbound message
// on a CRM-linked lead (dedupe key + crm_sync_status, like calls).
// ---------------------------------------------------------------------------
export const podioSyncMessageActivity: JobHandler = async (deps, job) => {
  const { dbh, podio, logger } = deps;
  const { messageId } = job.payload as { messageId: string };
  const message = (
    await dbh.db.select().from(schema.messages).where(eq(schema.messages.id, messageId)).limit(1)
  )[0];
  if (!message) throw new Error(`message ${messageId} not found`);
  if (message.crmSyncStatus === 'synced') return; // idempotent re-run

  const conversation = (
    await dbh.db
      .select()
      .from(schema.conversations)
      .where(eq(schema.conversations.id, message.conversationId))
      .limit(1)
  )[0];
  const lead = conversation?.leadId
    ? (
        await dbh.db.select().from(schema.leads).where(eq(schema.leads.id, conversation.leadId)).limit(1)
      )[0]
    : undefined;
  if (!lead?.externalItemId) {
    // Lead isn't CRM-linked; nothing to sync, and that's a valid state.
    await dbh.db
      .update(schema.messages)
      .set({ crmSyncStatus: 'none' })
      .where(eq(schema.messages.id, message.id));
    return;
  }

  const contact = conversation?.contactId
    ? (
        await dbh.db
          .select()
          .from(schema.contacts)
          .where(eq(schema.contacts.id, conversation.contactId))
          .limit(1)
      )[0]
    : undefined;
  const who = contact?.displayName || conversation?.theirNumber || 'unknown';
  const preview = message.body.length > 200 ? `${message.body.slice(0, 200)}…` : message.body;
  const lines = [
    `💬 SMS received from ${who}`,
    preview.length > 0 ? `"${preview}"` : '(no text)',
    `[talkr:${message.id}]`, // loop-prevention marker
  ];

  try {
    const { commentId } = await podio.addCommentToItem(lead.externalItemId, lines.join('\n'));
    await dbh.db
      .update(schema.messages)
      .set({ crmSyncStatus: 'synced' })
      .where(eq(schema.messages.id, message.id));
    await writeAudit(dbh.db, {
      orgId: message.orgId,
      actorType: 'system',
      action: 'podio.sms_activity_posted',
      objectType: 'message',
      objectId: message.id,
      metadata: { itemId: lead.externalItemId, commentId },
    });
  } catch (err) {
    await dbh.db
      .update(schema.messages)
      .set({ crmSyncStatus: 'failed' })
      .where(eq(schema.messages.id, message.id));
    logger.warn({ messageId: message.id, err: (err as Error).message }, 'podio sms sync failed');
    throw err; // let the queue retry / dead-letter
  }
};
