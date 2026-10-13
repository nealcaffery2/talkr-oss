/**
 * SMS API (docs/sms.md §5–6): one-at-a-time sends (no bulk endpoint in this
 * phase), the composer preview, the shared inbox with its filters, and
 * message-template management. Auth is provided by the /v1 preHandler hook
 * registered in registerV1Routes; register this module after it in app.ts.
 */

import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Permission } from '@talkr/core';
import { schema } from '@talkr/db';
import type { AppDeps } from '../app.js';
import { hasPermission } from '../auth.js';
import { writeAudit } from '../services/audit.js';
import { parseConversationQuery } from '../services/conversation-filters.js';
import {
  serializeTemplate,
  templateBodyProblem,
  templateCreateSchema,
  templatePatchSchema,
  type MessageTemplateRow,
} from '../services/message-templates.js';
import {
  getConversationForUser,
  listConversations,
  MessageServiceError,
  previewMessage,
  sendMessage,
  serializeMessage,
  type ConversationListRow,
} from '../services/messages.js';
import { DEFAULT_TIMEZONE, orgTimezone } from '../services/reports.js';

function requirePermission(permission: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = req.authCtx;
    if (!ctx) return reply.code(401).send({ error: 'unauthenticated' });
    if (!hasPermission(ctx, permission)) {
      req.log.info({ userId: ctx.userId, permission }, 'permission denied');
      return reply.code(403).send({ error: 'forbidden', permission });
    }
  };
}

const UUID = z.string().uuid();

/** Who the message is for — the same selectors on send and on preview. */
const targetShape = {
  conversation_id: UUID.optional(),
  to_number: z.string().min(3).optional(),
  lead_id: UUID.optional(),
  contact_id: UUID.optional(),
};

const sendMessageSchema = z.object({
  ...targetShape,
  body: z.string().max(1600).optional(),
  template_id: UUID.optional(),
  /** From POST /v1/media (or any public https URL the carrier can fetch). */
  media_urls: z.array(z.string().url().max(2048)).max(10).optional(),
  /** Send from this number instead of the automatic caller-ID choice. */
  from_phone_number_id: UUID.optional(),
});

const previewSchema = z.object({
  ...targetShape,
  body: z.string().max(1600).optional(),
  template_id: UUID.optional(),
});

const templatePreviewSchema = z.object(targetShape);

const templateListQuerySchema = z.object({
  include_inactive: z.enum(['true', 'false']).optional(),
});

function mapServiceError(err: unknown, reply: FastifyReply): FastifyReply | null {
  if (!(err instanceof MessageServiceError)) return null;
  const status: Record<MessageServiceError['code'], number> = {
    suppressed: 422,
    quiet_hours: 422,
    invalid_number: 400,
    invalid_body: 400,
    invalid_caller_id: 400,
    no_from_number: 409,
    not_found: 404,
    number_protected: 422,
  };
  return reply.code(status[err.code]).send({ error: err.code, message: err.message });
}

/** One inbox row, wire shape. Every Phase 4 field keeps its name and meaning. */
function serializeConversation(row: ConversationListRow) {
  return {
    id: row.id,
    our_number: row.ourNumber,
    their_number: row.theirNumber,
    phone_number_id: row.phoneNumberId,
    contact_id: row.contactId,
    lead_id: row.leadId,
    contact_name: row.contactName,
    contact_type: row.contactType,
    contact_status: row.contactStatus,
    temperature: row.temperature,
    temperature_score: row.temperatureScore,
    tags: row.tags,
    company: row.company,
    lead_status: row.leadStatus,
    lead_city: row.leadCity,
    lead_state: row.leadState,
    assigned_user_id: row.assignedUserId,
    assigned_user_name: row.assignedUserName,
    last_message_at: row.lastMessageAt,
    // What was last said, for the inbox row. Null on a conversation that
    // exists but has no messages yet (created by an outbound draft).
    last_message: row.lastMessage
      ? {
          direction: row.lastMessage.direction,
          body: row.lastMessage.body,
          media_count: row.lastMessage.mediaCount,
          // A send the carrier rejected has to be visible from the list.
          status: row.lastMessage.status,
          created_at: row.lastMessage.createdAt,
        }
      : null,
    unread_count: row.unreadCount,
    created_at: row.createdAt,
  };
}

export function registerMessageRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { dbh } = deps;
  const db = dbh.db;
  const t = schema.messageTemplates;

  /** Reading templates is anyone who can send; writing is manager and up. */
  const sendGate = { preHandler: requirePermission('messages.send') };
  const templateWriteGate = { preHandler: requirePermission('messages.templates.manage') };

  /** Sends per template, counted from messages so the number cannot drift. */
  async function templateUsage(orgId: string, ids: string[]): Promise<Map<string, number>> {
    if (ids.length === 0) return new Map();
    const rows = await db
      .select({ templateId: schema.messages.templateId, uses: sql<number>`count(*)::int` })
      .from(schema.messages)
      .where(and(eq(schema.messages.orgId, orgId), inArray(schema.messages.templateId, ids)))
      .groupBy(schema.messages.templateId);
    return new Map(
      rows
        .filter((r): r is { templateId: string; uses: number } => Boolean(r.templateId))
        .map((r) => [r.templateId, Number(r.uses)]),
    );
  }

  async function loadTemplateRow(orgId: string, id: string): Promise<MessageTemplateRow | undefined> {
    return (await db.select().from(t).where(and(eq(t.id, id), eq(t.orgId, orgId))).limit(1))[0];
  }

  /** An active phone_numbers row this org owns — same rule as POST /v1/calls. */
  async function isActiveOrgNumber(id: string, orgId: string): Promise<boolean> {
    const row = (
      await db
        .select({ id: schema.phoneNumbers.id })
        .from(schema.phoneNumbers)
        .where(
          and(
            eq(schema.phoneNumbers.id, id),
            eq(schema.phoneNumbers.orgId, orgId),
            eq(schema.phoneNumbers.status, 'active'),
          ),
        )
        .limit(1)
    )[0];
    return Boolean(row);
  }

  // -------------------------------------------------------------------------
  // Send (merge fields, suppression + quiet hours enforced in the service)
  // -------------------------------------------------------------------------
  app.post('/v1/messages', sendGate, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = sendMessageSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    if (
      parsed.data.from_phone_number_id &&
      !(await isActiveOrgNumber(parsed.data.from_phone_number_id, ctx.orgId))
    ) {
      return reply.code(400).send({ error: 'invalid_caller_id', message: 'not an active number this org owns' });
    }
    try {
      const result = await sendMessage(dbh, ctx, {
        conversationId: parsed.data.conversation_id,
        toNumber: parsed.data.to_number,
        leadId: parsed.data.lead_id,
        contactId: parsed.data.contact_id,
        body: parsed.data.body,
        templateId: parsed.data.template_id,
        mediaUrls: parsed.data.media_urls,
        fromPhoneNumberId: parsed.data.from_phone_number_id,
      });
      return reply.code(201).send({
        message: serializeMessage(result.message),
        conversation_id: result.conversationId,
        // Sent, but from a line carriers are likely to filter (10DLC); null otherwise.
        ...(result.warning ? { warning: result.warning } : {}),
      });
    } catch (err) {
      const mapped = mapServiceError(err, reply);
      if (mapped) return mapped;
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // Preview — exactly what the carrier would receive, before it is sent
  // -------------------------------------------------------------------------
  app.post('/v1/messages/preview', sendGate, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = previewSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    try {
      return await previewMessage(dbh, ctx, {
        conversationId: parsed.data.conversation_id,
        toNumber: parsed.data.to_number,
        leadId: parsed.data.lead_id,
        contactId: parsed.data.contact_id,
        body: parsed.data.body,
        templateId: parsed.data.template_id,
      });
    } catch (err) {
      const mapped = mapServiceError(err, reply);
      if (mapped) return mapped;
      throw err;
    }
  });

  // -------------------------------------------------------------------------
  // Inbox
  // -------------------------------------------------------------------------
  app.get('/v1/conversations', { preHandler: requirePermission('messages.read.own') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = parseConversationQuery(req.query);
    if (!parsed.ok) {
      return reply
        .code(400)
        .send(
          parsed.error === 'invalid_query'
            ? { error: 'invalid_query', issues: parsed.issues }
            : { error: parsed.error, message: parsed.message },
        );
    }
    const seeOrg = hasPermission(ctx, 'messages.read.org');
    // The org timezone is only needed to turn a `from`/`to` given as a
    // calendar day into instants; the unfiltered inbox load skips the read.
    const needsTimezone =
      parsed.filters.from?.kind === 'day' || parsed.filters.to?.kind === 'day';
    const result = await listConversations(dbh, ctx, {
      seeOrg,
      filters: parsed.filters,
      timezone: needsTimezone ? await orgTimezone(db, ctx.orgId) : DEFAULT_TIMEZONE,
    });
    return {
      conversations: result.rows.map(serializeConversation),
      total: result.total,
      counts: result.counts,
      limit: parsed.filters.limit,
      offset: parsed.filters.offset,
    };
  });

  app.get(
    '/v1/conversations/:id/messages',
    { preHandler: requirePermission('messages.read.own') },
    async (req, reply) => {
      const ctx = req.authCtx!;
      const { id } = req.params as { id: string };
      const seeOrg = hasPermission(ctx, 'messages.read.org');
      const conversation = await getConversationForUser(dbh, ctx, id, { seeOrg });
      if (!conversation) return reply.code(404).send({ error: 'not_found' });
      const rows = await db
        .select()
        .from(schema.messages)
        .where(eq(schema.messages.conversationId, conversation.id))
        .orderBy(asc(schema.messages.createdAt))
        .limit(500);
      return {
        conversation_id: conversation.id,
        messages: rows.map(serializeMessage),
      };
    },
  );

  app.post(
    '/v1/conversations/:id/read',
    { preHandler: requirePermission('messages.read.own') },
    async (req, reply) => {
      const ctx = req.authCtx!;
      const { id } = req.params as { id: string };
      const seeOrg = hasPermission(ctx, 'messages.read.org');
      const conversation = await getConversationForUser(dbh, ctx, id, { seeOrg });
      if (!conversation) return reply.code(404).send({ error: 'not_found' });
      await db
        .update(schema.conversations)
        .set({ unreadCount: 0 })
        .where(eq(schema.conversations.id, conversation.id));
      return { ok: true };
    },
  );

  // -------------------------------------------------------------------------
  // Templates — read with messages.send, write with messages.templates.manage
  // -------------------------------------------------------------------------
  app.get('/v1/message-templates', sendGate, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = templateListQuerySchema.safeParse(req.query ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
    }
    const rows = await db
      .select()
      .from(t)
      .where(
        and(
          eq(t.orgId, ctx.orgId),
          ...(parsed.data.include_inactive === 'true' ? [] : [eq(t.isActive, true)]),
        ),
      )
      .orderBy(desc(t.createdAt))
      .limit(200);
    // "Used 34 times" on a template card is the only thing that tells a rep
    // which of these actually works.
    const usage = await templateUsage(ctx.orgId, rows.map((r) => r.id));
    return { templates: rows.map((row) => serializeTemplate(row, usage.get(row.id) ?? 0)) };
  });

  app.post('/v1/message-templates', templateWriteGate, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = templateCreateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    // A body that names a field nobody knows is rejected HERE, where a person
    // can fix it — never mid-conversation (docs/sms.md §6).
    const problem = templateBodyProblem(parsed.data.body);
    if (problem) return reply.code(400).send(problem);

    const template = (
      await db
        .insert(t)
        .values({
          orgId: ctx.orgId,
          name: parsed.data.name,
          body: parsed.data.body,
          category: parsed.data.category ?? null,
          isActive: parsed.data.is_active ?? true,
          createdBy: ctx.userId,
        })
        .onConflictDoNothing({ target: [t.orgId, t.name] })
        .returning()
    )[0];
    if (!template) return reply.code(409).send({ error: 'name_taken' });
    await writeAudit(db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'message_template.create',
      objectType: 'message_template',
      objectId: template.id,
      metadata: { name: template.name, category: template.category },
    });
    return reply.code(201).send({ template: serializeTemplate(template, 0) });
  });

  app.patch('/v1/message-templates/:id', templateWriteGate, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    if (!UUID.safeParse(id).success) return reply.code(404).send({ error: 'not_found' });
    const parsed = templatePatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const input = parsed.data;
    if (input.body != null) {
      const problem = templateBodyProblem(input.body);
      if (problem) return reply.code(400).send(problem);
    }
    const current = await loadTemplateRow(ctx.orgId, id);
    if (!current) return reply.code(404).send({ error: 'not_found' });

    const values: Partial<typeof t.$inferInsert> = {};
    if (input.name !== undefined) values.name = input.name;
    if (input.body !== undefined) values.body = input.body;
    if (input.category !== undefined) values.category = input.category;
    if (input.is_active !== undefined) values.isActive = input.is_active;

    const updated = (
      await db
        .update(t)
        .set(values)
        .where(and(eq(t.id, current.id), eq(t.orgId, ctx.orgId)))
        .returning()
    )[0];
    if (!updated) return reply.code(404).send({ error: 'not_found' });
    await writeAudit(db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'message_template.update',
      objectType: 'message_template',
      objectId: updated.id,
      metadata: { changed: Object.keys(values), name: updated.name },
    });
    const usage = await templateUsage(ctx.orgId, [updated.id]);
    return { template: serializeTemplate(updated, usage.get(updated.id) ?? 0) };
  });

  /**
   * Delete. A template a message already points at is deactivated, not
   * removed: `messages.template_id` is a foreign key and the sent history is
   * the record of what a seller was actually told — deleting the row would
   * either fail or erase that. Anything unused is deleted for real, because
   * an archive full of never-used drafts is just clutter.
   */
  app.delete('/v1/message-templates/:id', templateWriteGate, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    if (!UUID.safeParse(id).success) return reply.code(404).send({ error: 'not_found' });
    const current = await loadTemplateRow(ctx.orgId, id);
    if (!current) return reply.code(404).send({ error: 'not_found' });

    const usage = (await templateUsage(ctx.orgId, [current.id])).get(current.id) ?? 0;
    const mode: 'soft' | 'hard' = usage > 0 ? 'soft' : 'hard';
    if (mode === 'soft') {
      await db.update(t).set({ isActive: false }).where(and(eq(t.id, current.id), eq(t.orgId, ctx.orgId)));
    } else {
      await db.delete(t).where(and(eq(t.id, current.id), eq(t.orgId, ctx.orgId)));
    }
    await writeAudit(db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'message_template.delete',
      objectType: 'message_template',
      objectId: current.id,
      metadata: { mode, name: current.name, use_count: usage },
    });
    return { id: current.id, deleted: mode, use_count: usage };
  });

  /** Same output as POST /v1/messages/preview, with the template's body. */
  app.post('/v1/message-templates/:id/preview', sendGate, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    if (!UUID.safeParse(id).success) return reply.code(404).send({ error: 'not_found' });
    const parsed = templatePreviewSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    try {
      return await previewMessage(dbh, ctx, {
        conversationId: parsed.data.conversation_id,
        toNumber: parsed.data.to_number,
        leadId: parsed.data.lead_id,
        contactId: parsed.data.contact_id,
        templateId: id,
      });
    } catch (err) {
      const mapped = mapServiceError(err, reply);
      if (mapped) return mapped;
      throw err;
    }
  });
}
