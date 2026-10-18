/**
 * SMS services (docs/sms.md): outbound send path (§5), inbound/status event
 * application (§3), CTIA keyword handling (§4). apply-events.ts is voice-only
 * and frozen this phase — message events are applied here, with the same
 * idempotency discipline (provider_message_sid unique + monotonic machine).
 */

import { and, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import {
  emptyMessageMergeVars,
  findMessageMergeFields,
  firstWordOf,
  formatPhoneForSpeech,
  isMessageMergeField,
  isWithinSmsSendWindow,
  normalizePhone,
  parseSmsKeyword,
  reduceMessageStatus,
  renderMessageBody,
  smsSegments,
  type CanonicalMessageEvent,
  type MessageFailureClass,
  type MessageMergeVars,
  type MessageSnapshot,
  type MessageStatus,
  type SmsSendWindowConfig,
} from '@talkr/core';
import { enqueueJob, publishBusEvent, schema, type DbHandle, type DbTx } from '@talkr/db';
import type { AuthContext } from '../auth.js';
import type { Logger } from '../logger.js';
import { writeAudit } from './audit.js';
import { chooseCallerId } from './caller-id.js';
import { smsDecision } from './reputation.js';
import { likeContains, searchDigits } from './contacts.js';
import type { ConversationFilters, TimeBound } from './conversation-filters.js';

export class MessageServiceError extends Error {
  constructor(
    public readonly code:
      | 'suppressed'
      | 'quiet_hours'
      | 'invalid_number'
      | 'invalid_body'
      | 'invalid_caller_id'
      | 'no_from_number'
      | 'not_found'
      | 'number_protected',
    message: string,
  ) {
    super(message);
  }
}

type MessageRow = typeof schema.messages.$inferSelect;
type ConversationRow = typeof schema.conversations.$inferSelect;

// ---------------------------------------------------------------------------
// Compliance gates
// ---------------------------------------------------------------------------

/** Active org-scope suppression on the sms (or all) channel. */
export async function findSmsSuppression(
  db: DbTx | DbHandle['db'],
  orgId: string,
  phoneE164: string,
) {
  const rows = await db
    .select({ id: schema.suppressionRecords.id, reason: schema.suppressionRecords.reason })
    .from(schema.suppressionRecords)
    .where(
      and(
        eq(schema.suppressionRecords.orgId, orgId),
        eq(schema.suppressionRecords.phoneE164, phoneE164),
        eq(schema.suppressionRecords.scope, 'org'),
        or(
          eq(schema.suppressionRecords.channel, 'sms'),
          eq(schema.suppressionRecords.channel, 'all'),
        ),
        or(
          isNull(schema.suppressionRecords.expiresAt),
          sql`${schema.suppressionRecords.expiresAt} > now()`,
        ),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Compliance auto-reply texts (docs/sms.md §4)
// ---------------------------------------------------------------------------

export const STOP_CONFIRMATION_BODY =
  'You have been unsubscribed and will receive no further messages from this number. ' +
  'Reply START to resubscribe. Msg&data rates may apply.';

export const START_CONFIRMATION_BODY =
  'You have been resubscribed to messages from this number. ' +
  'Reply STOP to unsubscribe. Msg&data rates may apply.';

export function helpBody(orgName: string): string {
  return (
    `${orgName}: You are receiving messages about your property inquiry. ` +
    'Reply STOP to unsubscribe, START to resubscribe. Msg&data rates may apply.'
  );
}

// ---------------------------------------------------------------------------
// Outbound send path (POST /v1/messages — docs/sms.md §5)
// ---------------------------------------------------------------------------

export interface SendMessageInput {
  conversationId?: string;
  toNumber?: string;
  leadId?: string;
  contactId?: string;
  body?: string;
  templateId?: string;
  /** Public HTTPS URLs from POST /v1/media; present = MMS (docs/sms.md §10). */
  mediaUrls?: string[];
  /**
   * Send from this number instead of the automatic choice. Must be an active
   * number the org owns; it overrides caller-ID selection AND thread
   * continuity (docs/sms.md §5).
   */
  fromPhoneNumberId?: string;
}

export async function sendMessage(dbh: DbHandle, ctx: AuthContext, input: SendMessageInput) {
  const { db } = dbh;

  const mediaUrls = [...new Set((input.mediaUrls ?? []).map((u) => u.trim()).filter(Boolean))];
  if (input.body != null && input.templateId != null) {
    throw new MessageServiceError('invalid_body', 'provide exactly one of body or template_id');
  }
  if (input.body == null && input.templateId == null && mediaUrls.length === 0) {
    throw new MessageServiceError('invalid_body', 'provide body, template_id or media_urls');
  }
  if (mediaUrls.length > 10) {
    throw new MessageServiceError('invalid_body', 'at most 10 attachments per message');
  }

  // Resolve destination + linkage.
  const target = await resolveTarget(db, ctx, input, { requireNumber: true });
  let conversation = target.conversation;
  const toNumber = target.toNumber!;

  // Compliance gate 1: suppression is enforced on every send.
  const suppressed = await findSmsSuppression(db, ctx.orgId, toNumber);
  if (suppressed) {
    throw new MessageServiceError(
      'suppressed',
      'destination has opted out of SMS (suppression list); sending is blocked',
    );
  }

  // Compliance gate 2: org-timezone quiet hours — explicit refusal, never
  // silent queueing (docs/sms.md §4).
  const org = (
    await db.select().from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)).limit(1)
  )[0]!;
  const windowConfig = (org.settings ?? {}) as SmsSendWindowConfig;
  if (!isWithinSmsSendWindow(windowConfig, new Date())) {
    throw new MessageServiceError(
      'quiet_hours',
      'outside the allowed SMS send window for this organization (quiet hours); not queued',
    );
  }

  const { contactId, leadId } = await linkFromNumber(db, ctx.orgId, toNumber, target);

  // Body: merge fields render on EVERY send — a typed body exactly like a
  // template — so no `{first_name}` can reach a carrier (docs/sms.md §6).
  const template = input.templateId
    ? await loadTemplate(db, ctx.orgId, input.templateId, { allowInactive: false })
    : null;
  const vars = await buildMessageMergeVars(db, ctx, {
    contactId,
    leadId,
    orgName: org.name,
    phoneE164: toNumber,
  });
  const templateId = template?.id ?? null;
  const body = renderMessageBody(template ? template.body : input.body ?? '', vars);

  // An MMS may carry no text at all; an SMS may not.
  if (body.trim().length === 0 && mediaUrls.length === 0) {
    throw new MessageServiceError('invalid_body', 'message body is empty');
  }

  // From-number: an explicit override wins over everything, then thread
  // continuity, then the rep's default, then any active number.
  const override = input.fromPhoneNumberId
    ? await requireActiveNumber(db, ctx.orgId, input.fromPhoneNumberId)
    : null;
  let fromNumber: string;
  let phoneNumberId: string | null;
  if (override) {
    fromNumber = override.phoneE164;
    phoneNumberId = override.id;
    // The thread key is (org, our_number, their_number): texting the same
    // person from a different number IS a different thread — that is what the
    // recipient's phone shows — so the message lands in (or opens) the thread
    // for the chosen number and the original one is left untouched. Rewriting
    // conversations.our_number instead would silently collide with the
    // existing thread for that number and rewrite history that already went
    // out over the wire.
    if (conversation && conversation.ourNumber !== fromNumber) conversation = null;
  } else if (conversation) {
    fromNumber = conversation.ourNumber;
    phoneNumberId = conversation.phoneNumberId;
  } else {
    // Reuse the most recent thread with this destination, if any.
    const existing = (
      await db
        .select()
        .from(schema.conversations)
        .where(
          and(eq(schema.conversations.orgId, ctx.orgId), eq(schema.conversations.theirNumber, toNumber)),
        )
        .orderBy(desc(schema.conversations.lastMessageAt))
        .limit(1)
    )[0];
    if (existing) {
      conversation = existing;
      fromNumber = existing.ourNumber;
      phoneNumberId = existing.phoneNumberId;
    } else {
      const selected = await selectFromNumber(db, ctx, toNumber);
      fromNumber = selected.phoneE164;
      phoneNumberId = selected.id;
    }
  }

  // Reputation gate (services/reputation.ts): the line's daily text cap, and
  // texting from a number not on an approved 10DLC campaign — refused or
  // passed back as a warning depending on the workspace's sms_gate.
  const gate = await smsDecision(db, org, fromNumber, toNumber);
  if (gate.action === 'block') throw new MessageServiceError('number_protected', gate.reason);

  const result = await db.transaction(async (tx) => {
    const convo =
      conversation ??
      (await upsertConversation(tx, {
        orgId: ctx.orgId,
        ourNumber: fromNumber,
        theirNumber: toNumber,
        phoneNumberId,
        contactId,
        leadId,
        assignedUserId: ctx.userId,
      }));

    const message = (
      await tx
        .insert(schema.messages)
        .values({
          orgId: ctx.orgId,
          conversationId: convo.id,
          direction: 'outbound',
          status: 'queued',
          body,
          mediaUrls,
          templateId,
          createdBy: ctx.userId,
        })
        .returning()
    )[0]!;

    await tx
      .update(schema.conversations)
      .set({
        lastMessageAt: message.createdAt,
        contactId: convo.contactId ?? contactId,
        leadId: convo.leadId ?? leadId,
      })
      .where(eq(schema.conversations.id, convo.id));

    await enqueueJob(tx, {
      jobType: 'send-message',
      payload: { messageId: message.id },
      dedupeKey: `send-message:${message.id}`,
    });

    await writeAudit(tx, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'message.create',
      objectType: 'message',
      objectId: message.id,
      metadata: {
        to_last4: toNumber.slice(-4),
        from: fromNumber,
        from_override: override != null,
        template_id: templateId,
        media_count: mediaUrls.length,
      },
    });

    return { message, conversationId: convo.id, ourNumber: convo.ourNumber, theirNumber: convo.theirNumber };
  });

  await publishBusEvent(dbh.pool, {
    type: 'conversation.updated',
    orgId: ctx.orgId,
    data: { conversationId: result.conversationId, messageId: result.message.id },
  }).catch(() => undefined);

  return { ...result, warning: gate.action === 'warn' ? gate.reason : null };
}

// ---------------------------------------------------------------------------
// Composer preview (POST /v1/messages/preview — docs/sms.md §6)
// ---------------------------------------------------------------------------

export interface PreviewMessageInput {
  conversationId?: string;
  toNumber?: string;
  leadId?: string;
  contactId?: string;
  body?: string;
  templateId?: string;
}

export interface MessagePreview {
  /** Exactly the text the carrier would receive. */
  body: string;
  merge_fields: MessageMergeVars;
  segments: number;
  characters: number;
  /** Names the body asked for that nobody knows — they render as ''. */
  unknown_fields: string[];
}

/**
 * What this send would actually say. Reads only: no suppression or
 * quiet-hours refusal, because a rep composing at 11pm still needs to see the
 * message (the send itself will refuse). A preview with no recipient is
 * legitimate — that is the composer before anyone is picked — and every merge
 * field simply renders empty.
 */
export async function previewMessage(
  dbh: DbHandle,
  ctx: AuthContext,
  input: PreviewMessageInput,
): Promise<MessagePreview> {
  const { db } = dbh;
  if (input.body != null && input.templateId != null) {
    throw new MessageServiceError('invalid_body', 'provide exactly one of body or template_id');
  }
  if (input.body == null && input.templateId == null) {
    throw new MessageServiceError('invalid_body', 'provide body or template_id');
  }

  const target = await resolveTarget(db, ctx, input, { requireNumber: false });
  const linked = target.toNumber
    ? await linkFromNumber(db, ctx.orgId, target.toNumber, target)
    : { contactId: target.contactId, leadId: target.leadId };

  const org = (
    await db.select().from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)).limit(1)
  )[0]!;
  // An inactive template still previews: that is the manager editing it.
  const template = input.templateId
    ? await loadTemplate(db, ctx.orgId, input.templateId, { allowInactive: true })
    : null;
  const raw = template ? template.body : input.body ?? '';
  const vars = await buildMessageMergeVars(db, ctx, {
    contactId: linked.contactId,
    leadId: linked.leadId,
    orgName: org.name,
    phoneE164: target.toNumber,
  });
  const body = renderMessageBody(raw, vars);
  const { chars, segments } = smsSegments(body);
  return {
    body,
    merge_fields: vars,
    segments,
    characters: chars,
    unknown_fields: findMessageMergeFields(raw).filter((f) => !isMessageMergeField(f)),
  };
}

// ---------------------------------------------------------------------------
// Shared resolution (send + preview see exactly the same contact and lead)
// ---------------------------------------------------------------------------

interface ResolvedTarget {
  conversation: ConversationRow | null;
  toNumber: string | null;
  contactId: string | null;
  leadId: string | null;
}

/**
 * conversation_id → contact_id/lead_id → to_number, in that order of
 * authority, normalized. `requireNumber` is the difference between a send
 * (there must be a destination) and a preview (there need not be).
 */
async function resolveTarget(
  db: DbHandle['db'],
  ctx: AuthContext,
  input: { conversationId?: string; toNumber?: string; leadId?: string; contactId?: string },
  opts: { requireNumber: boolean },
): Promise<ResolvedTarget> {
  let conversation: ConversationRow | null = null;
  let toNumber = input.toNumber;
  let contactId = input.contactId ?? null;
  let leadId = input.leadId ?? null;

  if (input.conversationId) {
    conversation =
      (
        await db
          .select()
          .from(schema.conversations)
          .where(
            and(
              eq(schema.conversations.id, input.conversationId),
              eq(schema.conversations.orgId, ctx.orgId),
            ),
          )
          .limit(1)
      )[0] ?? null;
    if (!conversation) throw new MessageServiceError('not_found', 'conversation not found');
    toNumber = conversation.theirNumber;
    contactId = contactId ?? conversation.contactId;
    leadId = leadId ?? conversation.leadId;
  }

  if (leadId) {
    const lead = (
      await db
        .select()
        .from(schema.leads)
        .where(and(eq(schema.leads.id, leadId), eq(schema.leads.orgId, ctx.orgId)))
        .limit(1)
    )[0];
    if (!lead) throw new MessageServiceError('not_found', 'lead not found');
    contactId = contactId ?? lead.primaryContactId;
  }
  if (!toNumber && contactId) {
    const phone = (
      await db
        .select()
        .from(schema.contactPhones)
        .where(
          and(eq(schema.contactPhones.contactId, contactId), eq(schema.contactPhones.orgId, ctx.orgId)),
        )
        .orderBy(sql`${schema.contactPhones.isPrimary} DESC`)
        .limit(1)
    )[0];
    toNumber = phone?.phoneE164;
  }
  if (!toNumber) {
    if (opts.requireNumber) throw new MessageServiceError('invalid_number', 'no destination number');
    return { conversation, toNumber: null, contactId, leadId };
  }
  const normalized = normalizePhone(toNumber);
  if (!normalized.ok || normalized.e164.startsWith('client:')) {
    throw new MessageServiceError('invalid_number', `cannot normalize ${toNumber}`);
  }
  return { conversation, toNumber: normalized.e164, contactId, leadId };
}

/** Fill in contact/lead from the destination number when they were not given. */
async function linkFromNumber(
  db: DbHandle['db'],
  orgId: string,
  toNumber: string,
  target: { contactId: string | null; leadId: string | null },
): Promise<{ contactId: string | null; leadId: string | null }> {
  let { contactId, leadId } = target;
  if (!contactId) {
    const link = await lookupContactLead(db, orgId, toNumber);
    contactId = link.contact?.id ?? null;
    leadId = leadId ?? link.lead?.id ?? null;
  } else if (!leadId) {
    const lead = (
      await db
        .select({ id: schema.leads.id })
        .from(schema.leads)
        .where(and(eq(schema.leads.orgId, orgId), eq(schema.leads.primaryContactId, contactId)))
        .orderBy(desc(schema.leads.createdAt))
        .limit(1)
    )[0];
    leadId = lead?.id ?? null;
  }
  return { contactId, leadId };
}

async function loadTemplate(
  db: DbHandle['db'],
  orgId: string,
  templateId: string,
  opts: { allowInactive: boolean },
) {
  const template = (
    await db
      .select()
      .from(schema.messageTemplates)
      .where(
        and(
          eq(schema.messageTemplates.id, templateId),
          eq(schema.messageTemplates.orgId, orgId),
          ...(opts.allowInactive ? [] : [eq(schema.messageTemplates.isActive, true)]),
        ),
      )
      .limit(1)
  )[0];
  if (!template) throw new MessageServiceError('not_found', 'template not found');
  return template;
}

/** The caller-ID override: an active number this org owns, or a 400. */
async function requireActiveNumber(db: DbHandle['db'], orgId: string, phoneNumberId: string) {
  const row = (
    await db
      .select()
      .from(schema.phoneNumbers)
      .where(
        and(
          eq(schema.phoneNumbers.id, phoneNumberId),
          eq(schema.phoneNumbers.orgId, orgId),
          eq(schema.phoneNumbers.status, 'active'),
        ),
      )
      .limit(1)
  )[0];
  if (!row) {
    throw new MessageServiceError('invalid_caller_id', 'not an active number this org owns');
  }
  return row;
}

/** Same rule as voice (services/caller-id.ts): local presence, default, any active. */
async function selectFromNumber(db: DbHandle['db'] | DbTx, ctx: AuthContext, toNumber?: string) {
  const number = await chooseCallerId(db, ctx, { toNumber: toNumber ?? null });
  if (!number) throw new MessageServiceError('no_from_number', 'org has no active phone number');
  return number;
}

async function lookupContactLead(db: DbHandle['db'] | DbTx, orgId: string, phoneE164: string) {
  let contact: typeof schema.contacts.$inferSelect | null = null;
  let lead: typeof schema.leads.$inferSelect | null = null;
  const phoneRow = (
    await db
      .select()
      .from(schema.contactPhones)
      .where(
        and(eq(schema.contactPhones.orgId, orgId), eq(schema.contactPhones.phoneE164, phoneE164)),
      )
      .limit(1)
  )[0];
  if (phoneRow) {
    contact =
      (
        await db.select().from(schema.contacts).where(eq(schema.contacts.id, phoneRow.contactId)).limit(1)
      )[0] ?? null;
    if (contact) {
      lead =
        (
          await db
            .select()
            .from(schema.leads)
            .where(and(eq(schema.leads.orgId, orgId), eq(schema.leads.primaryContactId, contact.id)))
            .orderBy(desc(schema.leads.createdAt))
            .limit(1)
        )[0] ?? null;
    }
  }
  return { contact, lead };
}

/**
 * Merge-field values for an outbound body (docs/sms.md §6). Same fields, same
 * sources as `GET /v1/call-context` and the sequence builder, so a body moved
 * between them renders the same words.
 *
 * `company`/`org_name` are OUR company; the address comes from the property
 * behind the lead, which is where the contacts API reads it from too.
 */
async function buildMessageMergeVars(
  db: DbHandle['db'],
  ctx: AuthContext,
  refs: {
    contactId: string | null;
    leadId: string | null;
    orgName: string;
    phoneE164?: string | null;
  },
): Promise<MessageMergeVars> {
  const contact = refs.contactId
    ? (
        await db.select().from(schema.contacts).where(eq(schema.contacts.id, refs.contactId)).limit(1)
      )[0]
    : undefined;
  const lead = refs.leadId
    ? (await db.select().from(schema.leads).where(eq(schema.leads.id, refs.leadId)).limit(1))[0]
    : undefined;
  const property = lead?.propertyId
    ? (
        await db.select().from(schema.properties).where(eq(schema.properties.id, lead.propertyId)).limit(1)
      )[0]
    : undefined;
  const name = contact?.displayName?.trim() ?? '';
  return {
    ...emptyMessageMergeVars(),
    first_name: firstWordOf(name),
    name,
    // Phase 4 templates were written with {{contact_name}}; it keeps working.
    contact_name: name,
    address: property?.addressLine1 ?? '',
    city: property?.city ?? '',
    state: property?.state ?? '',
    postal_code: property?.postalCode ?? '',
    company: refs.orgName,
    org_name: refs.orgName,
    rep_name: ctx.displayName,
    rep_first_name: firstWordOf(ctx.displayName),
    phone: formatPhoneForSpeech(refs.phoneE164 ?? null),
  };
}

async function upsertConversation(
  tx: DbTx,
  values: {
    orgId: string;
    ourNumber: string;
    theirNumber: string;
    phoneNumberId: string | null;
    contactId: string | null;
    leadId: string | null;
    assignedUserId: string | null;
  },
): Promise<ConversationRow> {
  const inserted = await tx
    .insert(schema.conversations)
    .values(values)
    .onConflictDoNothing({
      target: [
        schema.conversations.orgId,
        schema.conversations.ourNumber,
        schema.conversations.theirNumber,
      ],
    })
    .returning();
  if (inserted[0]) return inserted[0];
  return (
    await tx
      .select()
      .from(schema.conversations)
      .where(
        and(
          eq(schema.conversations.orgId, values.orgId),
          eq(schema.conversations.ourNumber, values.ourNumber),
          eq(schema.conversations.theirNumber, values.theirNumber),
        ),
      )
      .limit(1)
  )[0]!;
}

// ---------------------------------------------------------------------------
// Event application (worker — docs/sms.md §3)
// ---------------------------------------------------------------------------

export interface ApplyMessageContext {
  webhookEventId?: string;
  logger: Logger;
}

export interface ApplyMessageResult {
  outcome: 'applied' | 'duplicate' | 'orphaned' | 'ignored';
  messageId?: string;
  conversationId?: string;
}

export async function applyMessageEvent(
  dbh: DbHandle,
  event: CanonicalMessageEvent,
  ctx: ApplyMessageContext,
): Promise<ApplyMessageResult> {
  if (event.type === 'message.received') return applyInboundMessage(dbh, event, ctx);
  return applyMessageStatus(dbh, event, ctx);
}

async function applyInboundMessage(
  dbh: DbHandle,
  event: CanonicalMessageEvent,
  ctx: ApplyMessageContext,
): Promise<ApplyMessageResult> {
  const { from, to } = event.data;
  const result = await dbh.db.transaction(async (tx): Promise<ApplyMessageResult> => {
    if (!from || !to) return { outcome: 'ignored' };

    // Which org owns the destination number?
    const number = (
      await tx
        .select()
        .from(schema.phoneNumbers)
        .where(eq(schema.phoneNumbers.phoneE164, to))
        .limit(1)
    )[0];
    if (!number) {
      // Never silently dropped: explicit orphan state.
      await tx.insert(schema.reconciliationMismatches).values({
        objectType: 'orphan_provider_message',
        provider: event.provider,
        providerObjectId: event.providerObjectId,
        field: 'message',
        internalValue: null,
        providerValue: event.type,
      });
      return { outcome: 'orphaned' };
    }

    const { contact, lead } = await lookupContactLead(tx, number.orgId, from);

    const conversation = await upsertConversation(tx, {
      orgId: number.orgId,
      ourNumber: to,
      theirNumber: from,
      phoneNumberId: number.id,
      contactId: contact?.id ?? null,
      leadId: lead?.id ?? null,
      assignedUserId: lead?.assignedUserId ?? number.assignedUserId ?? null,
    });

    // Idempotency gate: provider_message_sid unique. A duplicate delivery
    // that survived the webhook-level dedupe stops here as a no-op.
    const inserted = await tx
      .insert(schema.messages)
      .values({
        orgId: number.orgId,
        conversationId: conversation.id,
        direction: 'inbound',
        status: 'received',
        body: event.data.body ?? '',
        mediaUrls: event.data.mediaUrls ?? [],
        numSegments: event.data.numSegments ?? null,
        provider: event.provider,
        providerMessageSid: event.providerObjectId,
      })
      .onConflictDoNothing({ target: schema.messages.providerMessageSid })
      .returning();
    const message = inserted[0];
    if (!message) return { outcome: 'duplicate', conversationId: conversation.id };

    // Conversation bookkeeping: recency, unread, backfilled CRM links.
    await tx
      .update(schema.conversations)
      .set({
        lastMessageAt: event.occurredAt,
        unreadCount: sql`${schema.conversations.unreadCount} + 1`,
        contactId: conversation.contactId ?? contact?.id ?? null,
        leadId: conversation.leadId ?? lead?.id ?? null,
      })
      .where(eq(schema.conversations.id, conversation.id));

    // CTIA keyword handling (docs/sms.md §4).
    const keyword = parseSmsKeyword(event.data.body);
    if (keyword === 'stop') {
      await tx
        .insert(schema.suppressionRecords)
        .values({
          orgId: number.orgId,
          phoneE164: from,
          scope: 'org',
          channel: 'sms',
          reason: 'stop',
          source: `message:${message.id}`,
          note: `keyword: ${(event.data.body ?? '').trim().slice(0, 40)}`,
        })
        .onConflictDoNothing();
      await writeAudit(tx, {
        orgId: number.orgId,
        actorType: 'provider',
        action: 'sms.opt_out',
        objectType: 'message',
        objectId: message.id,
        metadata: { phone_last4: from.slice(-4) },
      });
      await queueAutoReply(tx, conversation, STOP_CONFIRMATION_BODY);
    } else if (keyword === 'help') {
      const org = (
        await tx
          .select()
          .from(schema.organizations)
          .where(eq(schema.organizations.id, number.orgId))
          .limit(1)
      )[0]!;
      await queueAutoReply(tx, conversation, helpBody(org.name));
    } else if (keyword === 'start') {
      // START reverses SMS keyword opt-outs only; DNC/complaint/legal
      // suppressions (channel 'all' or other reasons) remain in force.
      await tx
        .delete(schema.suppressionRecords)
        .where(
          and(
            eq(schema.suppressionRecords.orgId, number.orgId),
            eq(schema.suppressionRecords.phoneE164, from),
            eq(schema.suppressionRecords.scope, 'org'),
            eq(schema.suppressionRecords.channel, 'sms'),
            eq(schema.suppressionRecords.reason, 'stop'),
          ),
        );
      await writeAudit(tx, {
        orgId: number.orgId,
        actorType: 'provider',
        action: 'sms.opt_in',
        objectType: 'message',
        objectId: message.id,
        metadata: { phone_last4: from.slice(-4) },
      });
      await queueAutoReply(tx, conversation, START_CONFIRMATION_BODY);
    }

    // Exactly one Podio activity per inbound message on a CRM-linked lead.
    const effectiveLeadId = conversation.leadId ?? lead?.id ?? null;
    if (effectiveLeadId) {
      await enqueueJob(tx, {
        jobType: 'podio-sync-message-activity',
        payload: { messageId: message.id },
        dedupeKey: `podio-sms:${message.id}`,
      });
    }

    return { outcome: 'applied', messageId: message.id, conversationId: conversation.id };
  });

  // Publish after commit so subscribers always see committed state.
  if (result.outcome === 'applied' && result.conversationId) {
    const convo = (
      await dbh.db
        .select()
        .from(schema.conversations)
        .where(eq(schema.conversations.id, result.conversationId))
        .limit(1)
    )[0];
    if (convo) {
      await publishBusEvent(dbh.pool, {
        type: 'message.received',
        orgId: convo.orgId,
        data: { conversationId: convo.id, messageId: result.messageId },
      }).catch((err) => ctx.logger.warn({ err }, 'bus publish failed'));
    }
  }
  return result;
}

/**
 * Compliance auto-reply: goes through the same send path (queued row +
 * send-message job) but flagged is_auto_reply so the send job bypasses the
 * suppression and quiet-hours gates — it responds to a message the recipient
 * just sent us (docs/sms.md §4). Created in the same transaction as the
 * inbound apply, which is SID-gated, so it is exactly-once.
 */
async function queueAutoReply(tx: DbTx, conversation: ConversationRow, body: string): Promise<void> {
  const reply = (
    await tx
      .insert(schema.messages)
      .values({
        orgId: conversation.orgId,
        conversationId: conversation.id,
        direction: 'outbound',
        status: 'queued',
        body,
        isAutoReply: true,
      })
      .returning()
  )[0]!;
  await enqueueJob(tx, {
    jobType: 'send-message',
    payload: { messageId: reply.id },
    dedupeKey: `send-message:${reply.id}`,
  });
}

async function applyMessageStatus(
  dbh: DbHandle,
  event: CanonicalMessageEvent,
  ctx: ApplyMessageContext,
): Promise<ApplyMessageResult> {
  const result = await dbh.db.transaction(async (tx): Promise<ApplyMessageResult> => {
    const message = (
      await tx
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.providerMessageSid, event.providerObjectId))
        .limit(1)
    )[0];
    if (!message) {
      // Almost always a race with the send job stamping the SID — throw so
      // the job retries with backoff; a truly unknown SID dead-letters,
      // which is the explicit orphan state (docs/sms.md §3).
      throw new Error(`message for provider sid ${event.providerObjectId} not found (will retry)`);
    }

    const snapshot: MessageSnapshot = {
      status: message.status,
      sentAt: message.sentAt,
      deliveredAt: message.deliveredAt,
      failedAt: message.failedAt,
      errorCode: message.errorCode,
      failureClass: message.failureClass as MessageFailureClass,
    };
    const change = reduceMessageStatus(snapshot, {
      status: (event.data.status ?? 'queued') as MessageStatus,
      errorCode: event.data.errorCode,
      occurredAt: event.occurredAt,
    });
    if (change.noop) return { outcome: 'duplicate', messageId: message.id };

    const update: Partial<typeof schema.messages.$inferInsert> = {};
    if (change.status) update.status = change.status;
    if (change.sentAt) update.sentAt = change.sentAt;
    if (change.deliveredAt) update.deliveredAt = change.deliveredAt;
    if (change.failedAt) update.failedAt = change.failedAt;
    if (change.errorCode) update.errorCode = change.errorCode;
    if (change.failureClass) update.failureClass = change.failureClass;
    if (event.data.numSegments != null && message.numSegments == null) {
      update.numSegments = event.data.numSegments;
    }
    await tx.update(schema.messages).set(update).where(eq(schema.messages.id, message.id));
    return {
      outcome: 'applied',
      messageId: message.id,
      conversationId: message.conversationId,
    };
  });

  if (result.outcome === 'applied' && result.messageId) {
    const fresh = (
      await dbh.db.select().from(schema.messages).where(eq(schema.messages.id, result.messageId)).limit(1)
    )[0];
    if (fresh) {
      await publishBusEvent(dbh.pool, {
        type: 'message.updated',
        orgId: fresh.orgId,
        status: fresh.status,
        data: { conversationId: fresh.conversationId, messageId: fresh.id },
      }).catch((err) => ctx.logger.warn({ err }, 'bus publish failed'));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Read models (GET /v1/conversations… — docs/sms.md §6)
//
// The inbox is the hot path: two queries whatever the filters, one for the
// page (conversation + contact + assignee + lead/property + newest message,
// via a LATERAL) and one for the totals. Never a query per row.
// ---------------------------------------------------------------------------

/** Enough of the newest message to render an inbox row, and nothing more. */
export interface LastMessagePreview {
  direction: 'inbound' | 'outbound';
  body: string;
  /** Attached media; an MMS with no text still needs to say something. */
  mediaCount: number;
  /** Delivery state — this is how the inbox shows a send that failed. */
  status: MessageStatus;
  createdAt: Date;
}

/** One inbox row, already joined. Serialized by routes/messages.ts. */
export interface ConversationListRow {
  id: string;
  ourNumber: string;
  theirNumber: string;
  phoneNumberId: string | null;
  contactId: string | null;
  leadId: string | null;
  contactName: string | null;
  contactType: string | null;
  contactStatus: string | null;
  temperature: string | null;
  temperatureScore: number | null;
  tags: string[];
  company: string | null;
  leadStatus: string | null;
  leadCity: string | null;
  leadState: string | null;
  assignedUserId: string | null;
  assignedUserName: string | null;
  lastMessageAt: Date | null;
  lastMessage: LastMessagePreview | null;
  unreadCount: number;
  createdAt: Date;
}

export interface ConversationCounts {
  /** Conversations in this filtered set with unread inbound messages. */
  unread: number;
  /** Contact type → count; conversations with no contact count under `none`. */
  by_type: Record<string, number>;
  by_temperature: Record<string, number>;
}

export interface ConversationListResult {
  rows: ConversationListRow[];
  total: number;
  counts: ConversationCounts;
}

interface ConversationListRawRow extends Record<string, unknown> {
  id: string;
  our_number: string;
  their_number: string;
  phone_number_id: string | null;
  contact_id: string | null;
  lead_id: string | null;
  contact_name: string | null;
  contact_type: string | null;
  contact_status: string | null;
  temperature: string | null;
  temperature_score: number | null;
  tags: string[] | null;
  company: string | null;
  lead_status: string | null;
  lead_city: string | null;
  lead_state: string | null;
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  last_message_at: Date | null;
  unread_count: number;
  created_at: Date;
  lm_direction: 'inbound' | 'outbound' | null;
  lm_body: string | null;
  lm_status: MessageStatus | null;
  lm_media_count: number | null;
  lm_created_at: Date | null;
}

/** Activity time for sorting and range filters: a thread with no messages sorts by when it opened. */
const ACTIVITY_AT = sql`COALESCE(cv.last_message_at, cv.created_at)`;

/** A day bound is org-local midnight; an instant is used verbatim. */
function boundSql(bound: TimeBound, timezone: string, edge: 'start' | 'end'): SQL {
  if (bound.kind === 'instant') return sql`${bound.at}`;
  return edge === 'start'
    ? sql`((${bound.day}::date)::timestamp AT TIME ZONE ${timezone})`
    : sql`((${bound.day}::date + 1)::timestamp AT TIME ZONE ${timezone})`;
}

function conversationWhere(ctx: AuthContext, opts: ConversationSqlOptions): SQL {
  const f = opts.filters;
  const clauses: SQL[] = [sql`cv.org_id = ${ctx.orgId}::uuid`];
  if (!opts.seeOrg) {
    // messages.read.own is the shared inbox: mine, plus everything unassigned.
    clauses.push(sql`(cv.assigned_user_id = ${ctx.userId}::uuid OR cv.assigned_user_id IS NULL)`);
  }
  if (f.q) {
    const pattern = likeContains(f.q);
    const digits = searchDigits(f.q);
    const parts: SQL[] = [
      sql`ct.display_name ILIKE ${pattern} ESCAPE '\\'`,
      sql`ct.company ILIKE ${pattern} ESCAPE '\\'`,
      sql`lm.body ILIKE ${pattern} ESCAPE '\\'`,
    ];
    if (digits) {
      parts.push(sql`cv.their_number LIKE ${`%${digits}%`}`);
      parts.push(sql`cv.our_number LIKE ${`%${digits}%`}`);
    }
    clauses.push(sql`(${sql.join(parts, sql` OR `)})`);
  }
  // sql.param, not a bare array: drizzle expands a plain array into a
  // parameter LIST (`($1, $2)`), which is a row constructor, not an array.
  if (f.types.length > 0) clauses.push(sql`ct.type = ANY(${sql.param(f.types)}::text[])`);
  if (f.temperature) clauses.push(sql`ct.temperature = ${f.temperature}`);
  if (f.status) clauses.push(sql`ct.status = ${f.status}`);
  if (f.tag) clauses.push(sql`ct.tags @> ARRAY[${f.tag}]::text[]`);
  if (f.userId) clauses.push(sql`cv.assigned_user_id = ${f.userId}::uuid`);
  if (f.unread) clauses.push(sql`cv.unread_count > 0`);
  if (f.direction) clauses.push(sql`lm.direction = ${f.direction}`);
  if (f.hasLead === true) clauses.push(sql`cv.lead_id IS NOT NULL`);
  if (f.hasLead === false) clauses.push(sql`cv.lead_id IS NULL`);
  if (f.from) clauses.push(sql`${ACTIVITY_AT} >= ${boundSql(f.from, opts.timezone, 'start')}`);
  if (f.to) clauses.push(sql`${ACTIVITY_AT} < ${boundSql(f.to, opts.timezone, 'end')}`);
  if (f.numberId) {
    // Old rows can predate phone_number_id; match the number itself too.
    clauses.push(
      opts.numberE164
        ? sql`(cv.phone_number_id = ${f.numberId}::uuid OR cv.our_number = ${opts.numberE164})`
        : sql`cv.phone_number_id = ${f.numberId}::uuid`,
    );
  }
  return sql.join(clauses, sql` AND `);
}

function conversationOrder(sort: ConversationFilters['sort']): SQL {
  switch (sort) {
    case 'oldest':
      return sql`${ACTIVITY_AT} ASC, cv.id ASC`;
    case 'unread':
      return sql`cv.unread_count DESC, ${ACTIVITY_AT} DESC, cv.id DESC`;
    case 'temperature':
      return sql`ct.temperature_score DESC NULLS LAST, ${ACTIVITY_AT} DESC, cv.id DESC`;
    default:
      return sql`${ACTIVITY_AT} DESC, cv.id DESC`;
  }
}

/**
 * The joined FROM every inbox query shares. The LATERAL is what makes "show
 * me threads whose last message failed" a filter rather than a client-side
 * scan of 200 rows.
 */
const CONVERSATION_FROM = sql`
  FROM conversations cv
  LEFT JOIN contacts ct ON ct.id = cv.contact_id
  LEFT JOIN users au ON au.id = cv.assigned_user_id
  LEFT JOIN leads l ON l.id = cv.lead_id
  LEFT JOIN properties p ON p.id = l.property_id
  LEFT JOIN LATERAL (
    SELECT m.direction, m.body, m.status, m.created_at,
           jsonb_array_length(m.media_urls) AS media_count
    FROM messages m
    WHERE m.conversation_id = cv.id
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT 1
  ) lm ON TRUE
`;

interface ConversationCountsRawRow extends Record<string, unknown> {
  total: number;
  unread: number;
  by_type: Record<string, number>;
  by_temperature: Record<string, number>;
}

export interface ConversationSqlOptions {
  seeOrg: boolean;
  filters: ConversationFilters;
  /** The org's timezone, for `from`/`to` given as calendar days. */
  timezone: string;
  /** The E.164 behind `number_id`, when it resolved to a number this org owns. */
  numberE164: string | null;
}

/**
 * The two statements the inbox runs. Exported so their composition is
 * unit-tested (every filter it claims to support has to reach the WHERE
 * clause; a filter that silently does nothing is worse than a 400).
 */
export function buildConversationListSql(
  ctx: AuthContext,
  opts: ConversationSqlOptions,
): { page: SQL; counts: SQL } {
  const f = opts.filters;
  const where = conversationWhere(ctx, opts);
  const order = conversationOrder(f.sort);
  const page = sql`
      SELECT
        cv.id, cv.our_number, cv.their_number, cv.phone_number_id, cv.contact_id, cv.lead_id,
        cv.assigned_user_id, cv.last_message_at, cv.unread_count, cv.created_at,
        ct.display_name AS contact_name,
        ct.type AS contact_type,
        ct.status AS contact_status,
        ct.temperature,
        ct.temperature_score,
        ct.tags,
        ct.company,
        au.display_name AS assigned_user_name,
        l.status AS lead_status,
        p.city AS lead_city,
        p.state AS lead_state,
        lm.direction AS lm_direction,
        lm.body AS lm_body,
        lm.status AS lm_status,
        lm.media_count AS lm_media_count,
        lm.created_at AS lm_created_at
      ${CONVERSATION_FROM}
      WHERE ${where}
      ORDER BY ${order}
      LIMIT ${f.limit} OFFSET ${f.offset}
    `;
  const counts = sql`
      WITH filtered AS (
        SELECT cv.id, cv.unread_count, ct.type AS contact_type, ct.temperature
        ${CONVERSATION_FROM}
        WHERE ${where}
      )
      SELECT
        (SELECT count(*)::int FROM filtered) AS total,
        (SELECT count(*)::int FROM filtered WHERE unread_count > 0) AS unread,
        (SELECT COALESCE(jsonb_object_agg(k, n), '{}'::jsonb)
           FROM (SELECT COALESCE(contact_type, 'none') AS k, count(*)::int AS n
                   FROM filtered GROUP BY 1) t) AS by_type,
        (SELECT COALESCE(jsonb_object_agg(k, n), '{}'::jsonb)
           FROM (SELECT COALESCE(temperature, 'none') AS k, count(*)::int AS n
                   FROM filtered GROUP BY 1) t) AS by_temperature
    `;
  return { page, counts };
}

export async function listConversations(
  dbh: DbHandle,
  ctx: AuthContext,
  opts: { seeOrg: boolean; filters: ConversationFilters; timezone: string },
): Promise<ConversationListResult> {
  const { db } = dbh;
  const f = opts.filters;

  // number_id names a phone_numbers row; conversations also carry the literal
  // number, so resolve it once and match either.
  let numberE164: string | null = null;
  if (f.numberId) {
    numberE164 =
      (
        await db
          .select({ phoneE164: schema.phoneNumbers.phoneE164 })
          .from(schema.phoneNumbers)
          .where(
            and(eq(schema.phoneNumbers.id, f.numberId), eq(schema.phoneNumbers.orgId, ctx.orgId)),
          )
          .limit(1)
      )[0]?.phoneE164 ?? null;
  }

  const { page: pageSql, counts: countsSql } = buildConversationListSql(ctx, { ...opts, numberE164 });
  const [page, counts] = await Promise.all([
    db.execute<ConversationListRawRow>(pageSql),
    db.execute<ConversationCountsRawRow>(countsSql),
  ]);

  const totals = counts.rows?.[0];
  return {
    rows: (page.rows ?? []).map((r) => ({
      id: r.id,
      ourNumber: r.our_number,
      theirNumber: r.their_number,
      phoneNumberId: r.phone_number_id,
      contactId: r.contact_id,
      leadId: r.lead_id,
      contactName: r.contact_name,
      contactType: r.contact_type,
      contactStatus: r.contact_status,
      temperature: r.temperature,
      temperatureScore: r.temperature_score == null ? null : Number(r.temperature_score),
      tags: r.tags ?? [],
      company: r.company,
      leadStatus: r.lead_status,
      leadCity: r.lead_city,
      leadState: r.lead_state,
      assignedUserId: r.assigned_user_id,
      assignedUserName: r.assigned_user_name,
      lastMessageAt: r.last_message_at,
      lastMessage:
        r.lm_direction == null
          ? null
          : {
              direction: r.lm_direction,
              body: r.lm_body ?? '',
              mediaCount: Number(r.lm_media_count ?? 0),
              status: (r.lm_status ?? 'queued') as MessageStatus,
              createdAt: r.lm_created_at!,
            },
      unreadCount: Number(r.unread_count ?? 0),
      createdAt: r.created_at,
    })),
    total: Number(totals?.total ?? 0),
    counts: {
      unread: Number(totals?.unread ?? 0),
      by_type: totals?.by_type ?? {},
      by_temperature: totals?.by_temperature ?? {},
    },
  };
}

export async function getConversationForUser(
  dbh: DbHandle,
  ctx: AuthContext,
  conversationId: string,
  opts: { seeOrg: boolean },
): Promise<ConversationRow | null> {
  const row = (
    await dbh.db
      .select()
      .from(schema.conversations)
      .where(
        and(eq(schema.conversations.id, conversationId), eq(schema.conversations.orgId, ctx.orgId)),
      )
      .limit(1)
  )[0];
  if (!row) return null;
  if (!opts.seeOrg && row.assignedUserId && row.assignedUserId !== ctx.userId) return null;
  return row;
}

/**
 * A message on the wire. The numbers belong to the thread (one thread per
 * our_number × their_number), so they are copied onto each message when the
 * caller has the conversation: a CRM filing the text by who sent it needs the
 * line it left from, and the conversation list alone does not say.
 */
export function serializeMessage(m: MessageRow, conv?: { ourNumber: string; theirNumber: string } | null) {
  const outbound = m.direction === 'outbound';
  return {
    id: m.id,
    conversation_id: m.conversationId,
    direction: m.direction,
    status: m.status,
    body: m.body,
    media_urls: m.mediaUrls,
    from_number: conv ? (outbound ? conv.ourNumber : conv.theirNumber) : null,
    to_number: conv ? (outbound ? conv.theirNumber : conv.ourNumber) : null,
    num_segments: m.numSegments,
    provider_message_sid: m.providerMessageSid,
    error_code: m.errorCode,
    failure_class: m.failureClass,
    template_id: m.templateId,
    created_by: m.createdBy,
    is_auto_reply: m.isAutoReply,
    sent_at: m.sentAt,
    delivered_at: m.deliveredAt,
    failed_at: m.failedAt,
    created_at: m.createdAt,
  };
}
