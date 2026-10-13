/**
 * Phone numbers: what the org owns, what the carrier will sell, and who each
 * line belongs to.
 *
 *   GET    /v1/numbers             every rep (the caller-ID picker reads it)
 *   GET    /v1/numbers/available   numbers.manage — carrier inventory by area code
 *   POST   /v1/numbers             numbers.manage — buy one, optionally assign it
 *   PATCH  /v1/numbers/:id         numbers.manage — owner, label, forwarding, last-contact routing
 *   DELETE /v1/numbers/:id         numbers.manage — release at the carrier
 *   GET    /v1/numbers/carrier     numbers.manage — on the carrier account, not here yet
 *   POST   /v1/numbers/import      numbers.manage — adopt one of those (idempotent)
 *   GET    /v1/numbers/:id/routing numbers.manage — the number's call flow
 *   PUT    /v1/numbers/:id/routing numbers.manage — save / clear (null) it, validated
 *   POST   /v1/numbers/:id/routing/simulate — walk a saved or draft flow for a test call
 *
 * A purchase points the number's inbound voice and SMS at this server in the
 * same carrier call (PUBLIC_BASE_URL), so a bought number is a working number.
 * Assigning a line to a rep who has no default caller ID makes it their
 * default — the common case is "buy Riley a 210 number", and a number that
 * shows up in the picker but never gets dialed from is the bug that follows
 * if that step is left to the rep.
 */

import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  flowUsesLastContact,
  isCallFlow,
  simulateCallFlow,
  supportsNumbers,
  validateCallFlow,
  type CallFlow,
  type Permission,
  type PurchasedNumber,
} from '@talkr/core';
import { schema } from '@talkr/db';
import type { AppDeps } from '../app.js';
import { hasPermission } from '../auth.js';
import { writeAudit } from '../services/audit.js';
import { areaCodeOf } from '../services/caller-id.js';
import { flowReferenceErrors, loadFlowFacts, loadOtherFlows } from '../services/call-flows.js';

const simulateSchema = z.object({
  /** A draft to test instead of the saved flow. */
  flow: z.unknown().optional(),
  /** When the test call happens (ISO); now by default. */
  at: z.string().datetime({ offset: true }).optional(),
  /** Caller number — a known seller makes `lead_owner` targets resolve, and their touch history `last_contact` ones. */
  from: z.string().regex(/^\+[1-9]\d{7,14}$/).optional(),
  /** Keys pressed at each menu, in order ("12"). */
  digits: z.string().regex(/^[0-9*#]{0,10}$/).optional(),
  /** Who picks up: a user id, "forward", or nobody (null / absent). */
  answered_by: z.union([z.string().uuid(), z.literal('forward')]).nullable().optional(),
  /** Everyone counts as available except these… */
  unavailable_user_ids: z.array(z.string().uuid()).max(100).optional(),
  /** …or use live presence instead. */
  use_presence: z.boolean().optional(),
});

/** org.settings.companyLineNumberId: the flow standby numbers fall back to. */
function companyLineOf(settings: unknown): string | null {
  return (settings as { companyLineNumberId?: string } | null)?.companyLineNumberId ?? null;
}

const searchSchema = z.object({
  area_code: z
    .string()
    .regex(/^\d{3}$/)
    .optional(),
  contains: z
    .string()
    .regex(/^[\d*]{1,10}$/)
    .optional(),
  limit: z.coerce.number().int().min(1).max(30).optional(),
});

const purchaseSchema = z.object({
  phone_e164: z.string().regex(/^\+1\d{10}$/),
  assigned_user_id: z.string().uuid().nullable().optional(),
  label: z.string().max(60).nullable().optional(),
});

const updateSchema = z
  .object({
    /** Empty string clears forwarding. */
    forward_to_e164: z.string().max(20).optional(),
    label: z.string().max(60).nullable().optional(),
    /** null unassigns (the line becomes an org line). */
    assigned_user_id: z.string().uuid().nullable().optional(),
    /** The company line: standby numbers with no flow of their own use its flow. */
    is_company_line: z.boolean().optional(),
    /**
     * Default routing rings the rep who last reached out to the caller (call,
     * text, or partner-posted RVM/email in the last 14 days) before the lead
     * owner. Call flows use a `last_contact` ring target instead.
     */
    route_callbacks_to_last_contact: z.boolean().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'nothing to update' });

type NumberRow = typeof schema.phoneNumbers.$inferSelect;

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

export function registerNumberRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config, dbh, provider } = deps;

  function serialize(n: NumberRow, ownerName: string | null, companyLineId: string | null = null) {
    const flow = isCallFlow(n.ivr) ? (n.ivr as CallFlow) : null;
    return {
      id: n.id,
      phone_e164: n.phoneE164,
      label: n.label,
      status: n.status,
      area_code: n.areaCode,
      assigned_user_id: n.assignedUserId,
      assigned_user_name: ownerName,
      forward_to_e164: n.forwardToE164,
      route_callbacks_to_last_contact: n.routeCallbacksToLastContact,
      capabilities: n.capabilities,
      provider: n.provider,
      purchased_at: n.purchasedAt ? n.purchasedAt.toISOString() : null,
      /** flow: its own call flow · menu: the older digit menu · default: owner → team → forward → voicemail. */
      routing_mode: flow ? 'flow' : n.ivr ? 'menu' : n.queueId ? 'queue' : 'default',
      /**
       * Active at the carrier but routing to nobody in particular: no owner,
       * team, queue, forward or flow. Inbound runs the company line's flow when
       * one is set, otherwise voicemail (after a recognized seller's owner).
       */
      standby: n.status === 'active' && !flow && !n.ivr && !n.assignedUserId && !n.assignedTeamId && !n.queueId && !n.forwardToE164,
      is_company_line: companyLineId === n.id,
      flow_steps: flow ? Object.values(flow.nodes).map((s) => s.type) : [],
    };
  }

  /** An active user in this org, or null. */
  async function orgUser(id: string, orgId: string) {
    return (
      await dbh.db
        .select({ id: schema.users.id, displayName: schema.users.displayName, defaultPhoneNumberId: schema.users.defaultPhoneNumberId })
        .from(schema.users)
        .where(and(eq(schema.users.id, id), eq(schema.users.orgId, orgId), eq(schema.users.status, 'active')))
        .limit(1)
    )[0];
  }

  /**
   * Make `numberId` the user's default caller ID if they have none. Never
   * overrides a default the rep (or an admin) already picked.
   */
  async function adoptAsDefault(userId: string, numberId: string) {
    await dbh.db
      .update(schema.users)
      .set({ defaultPhoneNumberId: numberId })
      .where(and(eq(schema.users.id, userId), isNull(schema.users.defaultPhoneNumberId)));
  }

  /** A default that pointed at this number no longer makes sense for `userId`. */
  async function dropDefault(numberId: string, userId?: string | null) {
    await dbh.db
      .update(schema.users)
      .set({ defaultPhoneNumberId: null })
      .where(
        and(
          eq(schema.users.defaultPhoneNumberId, numberId),
          userId ? eq(schema.users.id, userId) : undefined,
        ),
      );
  }

  /** The org's numbers, with owner names, for the picker and the settings card. */
  app.get('/v1/numbers', { preHandler: requirePermission('calls.read.own') }, async (req) => {
    const ctx = req.authCtx!;
    const rows = await dbh.db
      .select({ number: schema.phoneNumbers, ownerName: schema.users.displayName })
      .from(schema.phoneNumbers)
      .leftJoin(schema.users, eq(schema.users.id, schema.phoneNumbers.assignedUserId))
      .where(eq(schema.phoneNumbers.orgId, ctx.orgId))
      .orderBy(schema.phoneNumbers.phoneE164);
    const org = (await dbh.db.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)).limit(1))[0];
    const company = companyLineOf(org?.settings);
    return { numbers: rows.map((r) => serialize(r.number, r.ownerName ?? null, company)) };
  });

  /** Carrier inventory. Read-only at the carrier; nothing is reserved. */
  app.get(
    '/v1/numbers/available',
    { preHandler: requirePermission('numbers.manage') },
    async (req, reply) => {
      const parsed = searchSchema.safeParse(req.query ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_query', issues: parsed.error.issues });
      if (!supportsNumbers(provider)) {
        return reply.code(501).send({ error: 'numbers_not_supported', message: `${provider.name} cannot sell numbers here yet.` });
      }
      if (!parsed.data.area_code && !parsed.data.contains) {
        return reply.code(400).send({ error: 'invalid_query', message: 'area_code or contains is required' });
      }
      try {
        const numbers = await provider.searchAvailableNumbers({
          areaCode: parsed.data.area_code,
          contains: parsed.data.contains,
          limit: parsed.data.limit ?? 10,
        });
        return {
          numbers: numbers.map((n) => ({
            phone_e164: n.phoneE164,
            locality: n.locality,
            region: n.region,
            area_code: n.areaCode,
            capabilities: n.capabilities,
          })),
        };
      } catch (err) {
        req.log.warn({ err }, 'number search failed');
        return reply.code(502).send({ error: 'carrier_error', message: (err as Error).message });
      }
    },
  );

  /** Buy a number. Webhooks are set at purchase; the row is written after the carrier confirms. */
  app.post('/v1/numbers', { preHandler: requirePermission('numbers.manage') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = purchaseSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    if (!supportsNumbers(provider)) {
      return reply.code(501).send({ error: 'numbers_not_supported', message: `${provider.name} cannot sell numbers here yet.` });
    }
    const { phone_e164, label } = parsed.data;
    const assignTo = parsed.data.assigned_user_id ?? null;
    if (assignTo && !(await orgUser(assignTo, ctx.orgId))) {
      return reply.code(400).send({ error: 'invalid_user', message: 'assigned_user_id is not an active member of this org' });
    }
    const existing = (
      await dbh.db.select({ id: schema.phoneNumbers.id, status: schema.phoneNumbers.status }).from(schema.phoneNumbers).where(eq(schema.phoneNumbers.phoneE164, phone_e164)).limit(1)
    )[0];
    if (existing && existing.status !== 'released') {
      return reply.code(409).send({ error: 'already_owned', message: 'that number is already on the platform' });
    }

    let bought;
    try {
      bought = await provider.purchaseNumber({
        phoneE164: phone_e164,
        voiceUrl: `${config.PUBLIC_BASE_URL}/twiml/inbound`,
        statusCallbackUrl: `${config.PUBLIC_BASE_URL}/webhooks/telnyx/voice-status`,
        smsUrl: `${config.PUBLIC_BASE_URL}/webhooks/telnyx/inbound-sms`,
        friendlyName: label ?? `Talkr ${phone_e164}`,
      });
    } catch (err) {
      req.log.warn({ err }, 'number purchase failed');
      return reply.code(502).send({ error: 'carrier_error', message: (err as Error).message });
    }

    const row = await recordNumber(ctx, bought, { assignTo, label: label ?? null, existingId: existing?.id ?? null, action: 'number.purchase' });
    const owner = assignTo ? await orgUser(assignTo, ctx.orgId) : undefined;
    return reply.code(201).send({ number: serialize(row, owner?.displayName ?? null) });
  });

  /** Write the row for a number the carrier now points here (bought or imported). */
  async function recordNumber(
    ctx: NonNullable<FastifyRequest['authCtx']>,
    bought: PurchasedNumber,
    opts: { assignTo: string | null; label: string | null; existingId: string | null; action: string },
  ): Promise<NumberRow> {
    const values = {
      orgId: ctx.orgId,
      provider: provider.name,
      providerNumberId: bought.providerNumberId,
      phoneE164: bought.phoneE164,
      capabilities: bought.capabilities,
      status: 'active',
      assignedUserId: opts.assignTo,
      areaCode: areaCodeOf(bought.phoneE164),
      label: opts.label,
      forwardToE164: null,
      releasedAt: null,
      purchasedAt: new Date(),
    };
    // A number released earlier and bought again reuses its row, so history
    // that points at it (calls, messages) stays attached.
    const row = opts.existingId
      ? (await dbh.db.update(schema.phoneNumbers).set(values).where(eq(schema.phoneNumbers.id, opts.existingId)).returning())[0]!
      : (await dbh.db.insert(schema.phoneNumbers).values(values).returning())[0]!;
    if (opts.assignTo) await adoptAsDefault(opts.assignTo, row.id);
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: opts.action,
      objectType: 'phone_number',
      objectId: row.id,
      metadata: { phone_e164: row.phoneE164, assigned_user_id: opts.assignTo, provider: provider.name },
    });
    return row;
  }

  /** Numbers on the carrier account that Talkr does not have yet — what Settings offers to import. */
  app.get('/v1/numbers/carrier', { preHandler: requirePermission('numbers.manage') }, async (req, reply) => {
    if (!supportsNumbers(provider) || !provider.listCarrierNumbers) {
      return reply.code(501).send({ error: 'numbers_not_supported', message: `${provider.name} cannot list its numbers here.` });
    }
    let carrier;
    try {
      carrier = await provider.listCarrierNumbers();
    } catch (err) {
      req.log.warn({ err }, 'carrier number list failed');
      return reply.code(502).send({ error: 'carrier_error', message: (err as Error).message });
    }
    const known = await dbh.db
      .select({ phone: schema.phoneNumbers.phoneE164 })
      .from(schema.phoneNumbers)
      .where(and(inArray(schema.phoneNumbers.phoneE164, carrier.map((n) => n.phoneE164).concat('')), ne(schema.phoneNumbers.status, 'released')));
    const have = new Set(known.map((k) => k.phone));
    return {
      numbers: carrier
        .filter((n) => !have.has(n.phoneE164))
        .map((n) => ({ phone_e164: n.phoneE164, provider_number_id: n.providerNumberId, status: n.status, attached: n.attached })),
    };
  });

  /**
   * Adopt a number the carrier account already owns (bought in the portal):
   * verify ownership, attach it to our voice app and messaging profile exactly
   * as a purchase does, record it. Idempotent — importing a number already
   * here re-attaches it and returns the existing row.
   */
  app.post('/v1/numbers/import', { preHandler: requirePermission('numbers.manage') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = purchaseSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    if (!supportsNumbers(provider) || !provider.importNumber) {
      return reply.code(501).send({ error: 'numbers_not_supported', message: `${provider.name} cannot import numbers here.` });
    }
    const { phone_e164, label } = parsed.data;
    const assignTo = parsed.data.assigned_user_id ?? null;
    if (assignTo && !(await orgUser(assignTo, ctx.orgId))) {
      return reply.code(400).send({ error: 'invalid_user', message: 'assigned_user_id is not an active member of this org' });
    }
    const existing = (await dbh.db.select().from(schema.phoneNumbers).where(eq(schema.phoneNumbers.phoneE164, phone_e164)).limit(1))[0];
    if (existing && existing.status !== 'released' && existing.orgId !== ctx.orgId) {
      return reply.code(409).send({ error: 'already_owned', message: 'that number belongs to another workspace' });
    }
    let adopted;
    try {
      adopted = await provider.importNumber(phone_e164);
    } catch (err) {
      req.log.warn({ err }, 'number import failed');
      return reply.code(502).send({ error: 'carrier_error', message: (err as Error).message });
    }
    if (!adopted) {
      return reply.code(404).send({ error: 'not_on_carrier', message: `${phone_e164} is not on the ${provider.name} account.` });
    }
    if (existing && existing.status !== 'released') {
      // Already here: the carrier attachments were refreshed; the row keeps its owner.
      const [row] = await dbh.db.update(schema.phoneNumbers)
        .set({ providerNumberId: adopted.providerNumberId, capabilities: adopted.capabilities, provider: provider.name })
        .where(eq(schema.phoneNumbers.id, existing.id)).returning();
      const owner = row!.assignedUserId ? await orgUser(row!.assignedUserId, ctx.orgId) : undefined;
      return reply.code(200).send({ number: serialize(row!, owner?.displayName ?? null), already_imported: true });
    }
    const row = await recordNumber(ctx, adopted, { assignTo, label: label ?? null, existingId: existing?.id ?? null, action: 'number.import' });
    const owner = assignTo ? await orgUser(assignTo, ctx.orgId) : undefined;
    return reply.code(201).send({ number: serialize(row, owner?.displayName ?? null), already_imported: false });
  });

  // -------------------------------------------------------------------------
  // Routing: the number's call flow (packages/core/src/call-flow.ts)
  // -------------------------------------------------------------------------

  async function orgNumber(id: string, orgId: string) {
    return (await dbh.db.select().from(schema.phoneNumbers).where(and(eq(schema.phoneNumbers.id, id), eq(schema.phoneNumbers.orgId, orgId))).limit(1))[0];
  }

  /** Shape, graph and org checks together; the errors a person can act on. */
  async function checkFlow(input: unknown, orgId: string, numberId: string) {
    const v = validateCallFlow(input);
    if (!v.ok) return v;
    const errors = await flowReferenceErrors(dbh.db, orgId, v.flow, numberId);
    return errors.length > 0 ? ({ ok: false, errors } as const) : v;
  }

  app.get('/v1/numbers/:id/routing', { preHandler: requirePermission('numbers.manage') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const number = await orgNumber((req.params as { id: string }).id, ctx.orgId);
    if (!number) return reply.code(404).send({ error: 'not_found' });
    const org = (await dbh.db.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)).limit(1))[0];
    return {
      flow: isCallFlow(number.ivr) ? number.ivr : null,
      // The older digit menu, shown read-only until a flow replaces it.
      legacy_ivr: !isCallFlow(number.ivr) ? number.ivr ?? null : null,
      is_company_line: companyLineOf(org?.settings) === number.id,
    };
  });

  /** Save (or clear, with null) the flow. Invalid flows are refused with every error at once. */
  app.put('/v1/numbers/:id/routing', { preHandler: requirePermission('numbers.manage') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    const number = await orgNumber(id, ctx.orgId);
    if (!number) return reply.code(404).send({ error: 'not_found' });
    if (number.status !== 'active') return reply.code(409).send({ error: 'number_released' });
    const input = (req.body as { flow?: unknown } | null)?.flow;
    if (input === undefined) return reply.code(400).send({ error: 'invalid_body', message: 'flow is required (null clears it)' });
    let flow: CallFlow | null = null;
    if (input !== null) {
      const checked = await checkFlow(input, ctx.orgId, id);
      if (!checked.ok) return reply.code(400).send({ error: 'invalid_flow', errors: checked.errors });
      flow = checked.flow;
    }
    await dbh.db.update(schema.phoneNumbers).set({ ivr: flow }).where(eq(schema.phoneNumbers.id, id));
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'number.routing.update',
      objectType: 'phone_number',
      objectId: id,
      metadata: { cleared: flow === null, steps: flow ? Object.keys(flow.nodes).length : 0 },
    });
    return { flow };
  });

  /**
   * Validate a flow (the saved one, or a draft in the body) and walk it for a
   * test caller at a chosen time: which steps it takes and how it ends.
   * Nothing rings and nothing is written.
   */
  app.post('/v1/numbers/:id/routing/simulate', { preHandler: requirePermission('numbers.manage') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    const number = await orgNumber(id, ctx.orgId);
    if (!number) return reply.code(404).send({ error: 'not_found' });
    const parsed = simulateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const input = parsed.data;
    const draft = input.flow !== undefined ? input.flow : number.ivr;
    if (!isCallFlow(draft) && input.flow === undefined) {
      return { valid: true, errors: [], outcome: 'default_routing', path: [{ node: null, type: 'default', detail: 'No flow on this number — it uses the default routing (owner, team, forward, voicemail).' }], missed_call_text: null };
    }
    const checked = await checkFlow(draft, ctx.orgId, id);
    if (!checked.ok) return { valid: false, errors: checked.errors, outcome: null, path: [], missed_call_text: null };

    let leadOwnerUserId: string | null = null;
    if (input.from) {
      const lead = await dbh.db.execute(sql`
        SELECT l.assigned_user_id FROM contact_phones cp
        JOIN leads l ON l.primary_contact_id = cp.contact_id AND l.org_id = cp.org_id
        WHERE cp.org_id = ${ctx.orgId} AND cp.phone_e164 = ${input.from}
        ORDER BY l.created_at DESC LIMIT 1`);
      leadOwnerUserId = (lead.rows[0] as { assigned_user_id: string | null } | undefined)?.assigned_user_id ?? null;
    }
    const facts = await loadFlowFacts(dbh.db, ctx.orgId, {
      now: input.at ? new Date(input.at) : new Date(),
      leadOwnerUserId,
      lastContactPhone: input.from && flowUsesLastContact(checked.flow) ? input.from : null,
      available: input.use_presence ? 'presence' : { except: input.unavailable_user_ids ?? [] },
    });
    const sim = simulateCallFlow(checked.flow, facts, {
      digits: (input.digits ?? '').split('').filter(Boolean),
      answeredBy: input.answered_by ?? null,
      flows: await loadOtherFlows(dbh.db, ctx.orgId),
    });
    return { valid: true, errors: [], outcome: sim.outcome, path: sim.path, missed_call_text: sim.missedCallText };
  });

  /** Owner, label, forwarding. Reassigning moves the default caller ID with it when it makes sense. */
  app.patch('/v1/numbers/:id', { preHandler: requirePermission('numbers.manage') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const current = (
      await dbh.db.select().from(schema.phoneNumbers).where(and(eq(schema.phoneNumbers.id, id), eq(schema.phoneNumbers.orgId, ctx.orgId))).limit(1)
    )[0];
    if (!current) return reply.code(404).send({ error: 'not_found' });
    if (current.status !== 'active') return reply.code(409).send({ error: 'number_released' });

    const patch: Partial<NumberRow> = {};
    if (parsed.data.forward_to_e164 !== undefined) patch.forwardToE164 = parsed.data.forward_to_e164 || null;
    if (parsed.data.label !== undefined) patch.label = parsed.data.label;
    if (parsed.data.route_callbacks_to_last_contact !== undefined) patch.routeCallbacksToLastContact = parsed.data.route_callbacks_to_last_contact;
    const reassign = parsed.data.assigned_user_id !== undefined && parsed.data.assigned_user_id !== current.assignedUserId;
    if (reassign) {
      const next = parsed.data.assigned_user_id;
      if (next && !(await orgUser(next, ctx.orgId))) {
        return reply.code(400).send({ error: 'invalid_user', message: 'assigned_user_id is not an active member of this org' });
      }
      patch.assignedUserId = next ?? null;
    }

    const [row] = Object.keys(patch).length > 0
      ? await dbh.db.update(schema.phoneNumbers).set(patch).where(eq(schema.phoneNumbers.id, id)).returning()
      : [current];
    if (parsed.data.is_company_line !== undefined) {
      // jsonb merge in SQL so a concurrent settings write elsewhere is not lost.
      await dbh.db.execute(
        parsed.data.is_company_line
          ? sql`UPDATE organizations SET settings = settings || jsonb_build_object('companyLineNumberId', ${id}::text) WHERE id = ${ctx.orgId}`
          : sql`UPDATE organizations SET settings = settings - 'companyLineNumberId' WHERE id = ${ctx.orgId} AND settings->>'companyLineNumberId' = ${id}`,
      );
    }
    if (reassign) {
      // The previous owner's default was this line; it is not theirs any more.
      if (current.assignedUserId) await dropDefault(id, current.assignedUserId);
      if (row!.assignedUserId) await adoptAsDefault(row!.assignedUserId, id);
    }
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: reassign ? 'number.reassign' : 'number.update',
      objectType: 'phone_number',
      objectId: id,
      metadata: {
        forwarding_set: Boolean(row!.forwardToE164),
        route_callbacks_to_last_contact: parsed.data.route_callbacks_to_last_contact,
        from_user_id: reassign ? current.assignedUserId : undefined,
        to_user_id: reassign ? row!.assignedUserId : undefined,
      },
    });
    const owner = row!.assignedUserId ? await orgUser(row!.assignedUserId, ctx.orgId) : undefined;
    const org = (await dbh.db.select({ settings: schema.organizations.settings }).from(schema.organizations).where(eq(schema.organizations.id, ctx.orgId)).limit(1))[0];
    return { number: serialize(row!, owner?.displayName ?? null, companyLineOf(org?.settings)), forward_to_e164: row!.forwardToE164 };
  });

  /** Release. The row stays (as `released`) so past calls keep their number. */
  app.delete('/v1/numbers/:id', { preHandler: requirePermission('numbers.manage') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    const current = (
      await dbh.db.select().from(schema.phoneNumbers).where(and(eq(schema.phoneNumbers.id, id), eq(schema.phoneNumbers.orgId, ctx.orgId))).limit(1)
    )[0];
    if (!current) return reply.code(404).send({ error: 'not_found' });
    if (current.status === 'released') return reply.code(204).send();
    if (current.providerNumberId && supportsNumbers(provider)) {
      try {
        await provider.releaseNumber(current.providerNumberId);
      } catch (err) {
        req.log.warn({ err }, 'number release failed');
        return reply.code(502).send({ error: 'carrier_error', message: (err as Error).message });
      }
    }
    await dbh.db
      .update(schema.phoneNumbers)
      .set({ status: 'released', releasedAt: new Date(), assignedUserId: null })
      .where(eq(schema.phoneNumbers.id, id));
    await dropDefault(id);
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'number.release',
      objectType: 'phone_number',
      objectId: id,
      metadata: { phone_e164: current.phoneE164, was_assigned_to: current.assignedUserId },
    });
    return reply.code(204).send();
  });
}
