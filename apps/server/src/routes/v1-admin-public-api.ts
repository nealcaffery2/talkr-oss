/**
 * Phase 10 management surface on the EXISTING JWT-authed /v1 API
 * (docs/public-api.md §1, §7): API keys, webhook subscriptions, delivery log
 * + redelivery. Gated by the existing RBAC map ('admin.integrations').
 * The /v1 auth preHandler registered in routes/v1.ts populates req.authCtx.
 */

import { and, desc, eq, isNull, sql, type SQL } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Permission } from '@talkr/core';
import { enqueueJob, schema } from '@talkr/db';
import type { AppDeps } from '../app.js';
import { hasPermission } from '../auth.js';
import { writeAudit } from '../services/audit.js';
import { isApiScope, mintApiKey, mintSigningSecret, API_SCOPES } from '../public-api/keys.js';
import { PUBLIC_WEBHOOK_EVENT_TYPES } from '../worker/webhook-fanout.js';

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

const createKeySchema = z.object({
  name: z.string().min(1).max(200),
  scopes: z.array(z.string()).min(1),
});

const createSubscriptionSchema = z.object({
  url: z.string().url().refine((u) => /^https?:\/\//.test(u), 'http(s) URL required'),
  event_types: z.array(z.string()).min(1),
});

const updateSubscriptionSchema = z.object({
  url: z.string().url().refine((u) => /^https?:\/\//.test(u), 'http(s) URL required').optional(),
  event_types: z.array(z.string()).min(1).optional(),
  active: z.boolean().optional(),
});

export function registerPublicApiAdminRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { dbh } = deps;
  const admin = { preHandler: requirePermission('admin.integrations' as Permission) };

  // -------------------------------------------------------------------------
  // API keys
  // -------------------------------------------------------------------------
  app.post('/v1/admin/api-keys', admin, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = createKeySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const bad = parsed.data.scopes.filter((s) => !isApiScope(s));
    if (bad.length > 0) {
      return reply.code(400).send({ error: 'invalid_scopes', unknown: bad, known: API_SCOPES });
    }
    const minted = mintApiKey();
    const row = (
      await dbh.db
        .insert(schema.apiKeys)
        .values({
          orgId: ctx.orgId,
          name: parsed.data.name,
          keyPrefix: minted.keyPrefix,
          keyHash: minted.keyHash,
          scopes: parsed.data.scopes,
          createdBy: ctx.userId,
        })
        .returning()
    )[0]!;
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'api_key.create',
      objectType: 'api_key',
      objectId: row.id,
      metadata: { name: row.name, scopes: parsed.data.scopes, key_prefix: row.keyPrefix },
    });
    // The one and only time the secret is returned. It is not stored.
    return reply.code(201).send({ api_key: serializeKey(row), secret: minted.secret });
  });

  app.get('/v1/admin/api-keys', admin, async (req) => {
    const ctx = req.authCtx!;
    const rows = await dbh.db
      .select()
      .from(schema.apiKeys)
      .where(eq(schema.apiKeys.orgId, ctx.orgId))
      .orderBy(desc(schema.apiKeys.createdAt));
    return { api_keys: rows.map(serializeKey) };
  });

  app.post('/v1/admin/api-keys/:id/revoke', admin, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    const rows = await dbh.db
      .update(schema.apiKeys)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(schema.apiKeys.id, id),
          eq(schema.apiKeys.orgId, ctx.orgId),
          isNull(schema.apiKeys.revokedAt),
        ),
      )
      .returning();
    if (rows.length === 0) return reply.code(404).send({ error: 'not_found_or_already_revoked' });
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'api_key.revoke',
      objectType: 'api_key',
      objectId: id,
    });
    return { revoked: true };
  });

  // -------------------------------------------------------------------------
  // Webhook subscriptions
  // -------------------------------------------------------------------------
  app.post('/v1/admin/webhook-subscriptions', admin, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = createSubscriptionSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const bad = parsed.data.event_types.filter(
      (t) => !(PUBLIC_WEBHOOK_EVENT_TYPES as readonly string[]).includes(t),
    );
    if (bad.length > 0) {
      return reply
        .code(400)
        .send({ error: 'invalid_event_types', unknown: bad, known: PUBLIC_WEBHOOK_EVENT_TYPES });
    }
    const signingSecret = mintSigningSecret();
    const row = (
      await dbh.db
        .insert(schema.webhookSubscriptions)
        .values({
          orgId: ctx.orgId,
          url: parsed.data.url,
          signingSecret,
          eventTypes: parsed.data.event_types,
          createdBy: ctx.userId,
        })
        .returning()
    )[0]!;
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'webhook_subscription.create',
      objectType: 'webhook_subscription',
      objectId: row.id,
      metadata: { url: row.url, event_types: parsed.data.event_types },
    });
    // The one and only time the signing secret is returned.
    return reply
      .code(201)
      .send({ subscription: serializeSubscription(row), signing_secret: signingSecret });
  });

  app.get('/v1/admin/webhook-subscriptions', admin, async (req) => {
    const ctx = req.authCtx!;
    const rows = await dbh.db
      .select()
      .from(schema.webhookSubscriptions)
      .where(eq(schema.webhookSubscriptions.orgId, ctx.orgId))
      .orderBy(desc(schema.webhookSubscriptions.createdAt));
    return { subscriptions: rows.map(serializeSubscription) };
  });

  app.patch('/v1/admin/webhook-subscriptions/:id', admin, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    const parsed = updateSubscriptionSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    if (parsed.data.event_types) {
      const bad = parsed.data.event_types.filter(
        (t) => !(PUBLIC_WEBHOOK_EVENT_TYPES as readonly string[]).includes(t),
      );
      if (bad.length > 0) {
        return reply
          .code(400)
          .send({ error: 'invalid_event_types', unknown: bad, known: PUBLIC_WEBHOOK_EVENT_TYPES });
      }
    }
    const update: Partial<typeof schema.webhookSubscriptions.$inferInsert> = {};
    if (parsed.data.url !== undefined) update.url = parsed.data.url;
    if (parsed.data.event_types !== undefined) update.eventTypes = parsed.data.event_types;
    if (parsed.data.active !== undefined) {
      update.active = parsed.data.active;
      if (parsed.data.active) {
        // Re-enable resets the failure streak (docs/public-api.md §7).
        update.failureCount = 0;
        update.disabledAt = null;
      } else {
        update.disabledAt = new Date();
      }
    }
    if (Object.keys(update).length === 0) return reply.code(400).send({ error: 'empty_update' });
    const rows = await dbh.db
      .update(schema.webhookSubscriptions)
      .set(update)
      .where(
        and(eq(schema.webhookSubscriptions.id, id), eq(schema.webhookSubscriptions.orgId, ctx.orgId)),
      )
      .returning();
    if (rows.length === 0) return reply.code(404).send({ error: 'not_found' });
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'webhook_subscription.update',
      objectType: 'webhook_subscription',
      objectId: id,
      metadata: {
        url: parsed.data.url,
        event_types: parsed.data.event_types,
        active: parsed.data.active,
      },
    });
    return { subscription: serializeSubscription(rows[0]!) };
  });

  app.delete('/v1/admin/webhook-subscriptions/:id', admin, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    const rows = await dbh.db
      .delete(schema.webhookSubscriptions)
      .where(
        and(eq(schema.webhookSubscriptions.id, id), eq(schema.webhookSubscriptions.orgId, ctx.orgId)),
      )
      .returning({ id: schema.webhookSubscriptions.id });
    if (rows.length === 0) return reply.code(404).send({ error: 'not_found' });
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'webhook_subscription.delete',
      objectType: 'webhook_subscription',
      objectId: id,
    });
    return { deleted: true };
  });

  // -------------------------------------------------------------------------
  // Delivery log + redelivery
  // -------------------------------------------------------------------------
  app.get('/v1/admin/webhook-deliveries', admin, async (req) => {
    const ctx = req.authCtx!;
    const { subscription_id, state } = req.query as { subscription_id?: string; state?: string };
    const where: SQL[] = [eq(schema.webhookDeliveries.orgId, ctx.orgId)];
    if (subscription_id) where.push(eq(schema.webhookDeliveries.subscriptionId, subscription_id));
    if (state) where.push(eq(schema.webhookDeliveries.state, state));
    const rows = await dbh.db
      .select()
      .from(schema.webhookDeliveries)
      .where(and(...where))
      .orderBy(desc(schema.webhookDeliveries.createdAt))
      .limit(200);
    return { deliveries: rows.map(serializeDelivery) };
  });

  app.post('/v1/admin/webhook-deliveries/:id/redeliver', admin, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    const delivery = (
      await dbh.db
        .select()
        .from(schema.webhookDeliveries)
        .where(
          and(eq(schema.webhookDeliveries.id, id), eq(schema.webhookDeliveries.orgId, ctx.orgId)),
        )
        .limit(1)
    )[0];
    if (!delivery) return reply.code(404).send({ error: 'not_found' });
    await dbh.db.transaction(async (tx) => {
      await tx
        .update(schema.webhookDeliveries)
        .set({ state: 'pending', lastError: null, updatedAt: new Date() })
        .where(eq(schema.webhookDeliveries.id, id));
      await enqueueJob(tx, {
        jobType: 'webhook-deliver',
        payload: { deliveryId: id },
        dedupeKey: `webhook-deliver:${id}:redeliver:${Date.now()}`,
      });
      await writeAudit(tx, {
        orgId: ctx.orgId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'webhook_delivery.redeliver',
        objectType: 'webhook_delivery',
        objectId: id,
        metadata: { subscription_id: delivery.subscriptionId, event_id: delivery.eventId },
      });
    });
    return { redelivered: true };
  });
}

function serializeKey(row: typeof schema.apiKeys.$inferSelect) {
  return {
    id: row.id,
    name: row.name,
    key_prefix: row.keyPrefix,
    scopes: row.scopes,
    created_by: row.createdBy,
    last_used_at: row.lastUsedAt,
    revoked_at: row.revokedAt,
    created_at: row.createdAt,
  };
}

function serializeSubscription(row: typeof schema.webhookSubscriptions.$inferSelect) {
  return {
    id: row.id,
    url: row.url,
    event_types: row.eventTypes,
    active: row.active,
    failure_count: row.failureCount,
    disabled_at: row.disabledAt,
    created_by: row.createdBy,
    created_at: row.createdAt,
  };
}

function serializeDelivery(row: typeof schema.webhookDeliveries.$inferSelect) {
  return {
    id: row.id,
    subscription_id: row.subscriptionId,
    event_id: row.eventId,
    event_type: row.eventType,
    state: row.state,
    attempt_count: row.attemptCount,
    last_status_code: row.lastStatusCode,
    last_error: row.lastError,
    delivered_at: row.deliveredAt,
    created_at: row.createdAt,
  };
}
