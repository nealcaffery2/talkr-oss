/**
 * Caller reputation (services/reputation.ts):
 *
 *   GET   /v1/numbers/:id/reputation   numbers.manage — one line's signals (?refresh=1 re-reads the carrier)
 *   PATCH /v1/numbers/:id/reputation   numbers.manage — {cnam: {enabled, name}, protection: {caps, pause_on_warning}}
 *   GET   /v1/reputation/summary       numbers.manage — every line's badge + the registration checklist
 *   PATCH /v1/reputation/settings      numbers.manage — {sms_gate: auto|block|warn}
 *
 * Carrier reads are cached a day; `refresh=1` forces them. Every read Talkr
 * makes is free at Telnyx (Number Reputation is read with fresh=false).
 */

import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { SMS_GATE_MODES, numberProtectionSchema, readNumberProtection, readSmsGate, validateCnamName, type Permission } from '@talkr/core';
import { schema } from '@talkr/db';
import type { AppDeps } from '../app.js';
import { hasPermission } from '../auth.js';
import { writeAudit } from '../services/audit.js';
import {
  numberActivity,
  numberReport,
  readNumberCheck,
  readTenDlc,
  refreshReputation,
  registrationChecklist,
  reputationCarrierFor,
  saveNumberCheck,
} from '../services/reputation.js';

const patchSchema = z
  .object({
    cnam: z.object({ enabled: z.boolean(), name: z.string().max(40).nullable().optional() }).strict(),
    protection: numberProtectionSchema,
  })
  .partial()
  .strict()
  .refine((v) => v.cnam !== undefined || v.protection !== undefined, { message: 'nothing to update' });

const settingsSchema = z.object({ sms_gate: z.enum(SMS_GATE_MODES) }).strict();

function requirePermission(permission: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = req.authCtx;
    if (!ctx) return reply.code(401).send({ error: 'unauthenticated' });
    if (!hasPermission(ctx, permission)) return reply.code(403).send({ error: 'forbidden', permission });
  };
}

const wantsRefresh = (req: FastifyRequest) => ['1', 'true'].includes(String((req.query as { refresh?: string } | null)?.refresh ?? ''));

export function registerReputationRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { dbh, config, provider } = deps;
  const carrier = () => reputationCarrierFor(config, provider.name);
  const manage = { preHandler: requirePermission('numbers.manage') };

  const loadOrg = async (orgId: string) => (await dbh.db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1))[0]!;
  const loadNumber = async (id: string, orgId: string) =>
    (await dbh.db.select().from(schema.phoneNumbers).where(and(eq(schema.phoneNumbers.id, id), eq(schema.phoneNumbers.orgId, orgId))).limit(1))[0];

  app.get('/v1/numbers/:id/reputation', manage, async (req, reply) => {
    const ctx = req.authCtx!;
    const number = await loadNumber((req.params as { id: string }).id, ctx.orgId);
    if (!number) return reply.code(404).send({ error: 'not_found' });
    const org = await loadOrg(ctx.orgId);
    const c = carrier();
    await refreshReputation(dbh.db, c, org, [number], { force: wantsRefresh(req) });
    const activity = (await numberActivity(dbh.db, org, [number])).get(number.id)!;
    return { reputation: numberReport(number, org, activity, Boolean(c)) };
  });

  app.patch('/v1/numbers/:id/reputation', manage, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = patchSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const number = await loadNumber((req.params as { id: string }).id, ctx.orgId);
    if (!number) return reply.code(404).send({ error: 'not_found' });
    if (number.status !== 'active') return reply.code(409).send({ error: 'number_released' });
    const { cnam, protection } = parsed.data;

    if (cnam) {
      const c = carrier();
      if (!c || !number.providerNumberId) {
        return reply.code(501).send({ error: 'cnam_not_supported', message: 'Caller names are set through the Telnyx carrier; this line is not on it.' });
      }
      let name = cnam.name ?? readNumberCheck(number.reputation)?.cnam?.name ?? null;
      if (cnam.enabled || cnam.name) {
        const v = validateCnamName(name ?? '');
        if (!v.ok) return reply.code(400).send({ error: 'invalid_cnam', message: v.error });
        name = v.value;
      }
      let listing;
      try {
        listing = await c.setCnam(number.providerNumberId, { enabled: cnam.enabled, name });
      } catch (err) {
        req.log.warn({ err }, 'cnam update failed');
        return reply.code(502).send({ error: 'carrier_error', message: (err as Error).message });
      }
      const prev = readNumberCheck(number.reputation);
      await saveNumberCheck(dbh.db, number, { checked_at: prev?.checked_at ?? new Date().toISOString(), cnam: listing, spam: prev?.spam ?? null });
    }

    if (protection) {
      const merged = { ...readNumberProtection(number.reputation), ...protection };
      await dbh.db.execute(sql`UPDATE phone_numbers SET reputation = reputation || jsonb_build_object('protection', ${JSON.stringify(merged)}::jsonb) WHERE id = ${number.id}`);
      number.reputation = { ...(number.reputation as object), protection: merged };
    }

    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'number.reputation.update',
      objectType: 'phone_number',
      objectId: number.id,
      metadata: { cnam: cnam ?? undefined, protection: protection ?? undefined },
    });
    const org = await loadOrg(ctx.orgId);
    const activity = (await numberActivity(dbh.db, org, [number])).get(number.id)!;
    return { reputation: numberReport(number, org, activity, Boolean(carrier())) };
  });

  app.get('/v1/reputation/summary', manage, async (req) => {
    const ctx = req.authCtx!;
    const org = await loadOrg(ctx.orgId);
    const numbers = await dbh.db
      .select()
      .from(schema.phoneNumbers)
      .where(and(eq(schema.phoneNumbers.orgId, ctx.orgId), eq(schema.phoneNumbers.status, 'active')))
      .orderBy(schema.phoneNumbers.phoneE164);
    const c = carrier();
    await refreshReputation(dbh.db, c, org, numbers, { force: wantsRefresh(req) });
    const activity = await numberActivity(dbh.db, org, numbers);
    const reports = numbers.map((x) => numberReport(x, org, activity.get(x.id)!, Boolean(c)));
    const t = readTenDlc(org.reputation);
    return {
      carrier: provider.name,
      carrier_connected: Boolean(c),
      sms_gate: readSmsGate(org.reputation),
      ten_dlc: t
        ? { checked_at: t.checked_at, error: t.error ?? null, brands: t.brands ?? [], campaigns: t.campaigns ?? [] }
        : null,
      counts: {
        good: reports.filter((r) => r.grade === 'good').length,
        watch: reports.filter((r) => r.grade === 'watch').length,
        at_risk: reports.filter((r) => r.grade === 'at_risk').length,
      },
      checklist: registrationChecklist(org, reports, Boolean(c)),
      numbers: reports,
    };
  });

  app.patch('/v1/reputation/settings', manage, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = settingsSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    await dbh.db.execute(sql`UPDATE organizations SET reputation = reputation || jsonb_build_object('sms_gate', ${parsed.data.sms_gate}::text) WHERE id = ${ctx.orgId}`);
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'org.reputation.settings',
      objectType: 'organization',
      objectId: ctx.orgId,
      metadata: parsed.data,
    });
    return { sms_gate: parsed.data.sms_gate };
  });
}
