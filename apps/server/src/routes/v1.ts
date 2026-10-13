/**
 * Authenticated platform API. Every route declares its permission; org
 * scoping is enforced in queries, never assumed (docs/security.md §1,3).
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  PRESENCE_FRESHNESS_MS,
  greetingSchema,
  orgSettingsPatchSchema,
  readAiAgent,
  readHoldMusic,
  MONITOR_MODES,
  type Permission,
} from '@talkr/core';
import { enqueueJob, publishBusEvent, retryDeadJob, schema } from '@talkr/db';
import type { AppDeps } from '../app.js';
import { authenticate, bypassContext, hasPermission, type AuthContext } from '../auth.js';
import { CallServiceError, createOutboundCall, setDisposition } from '../services/calls.js';
import { ringBrowserForCall } from '../services/browser-leg.js';
import { ensureBrowserCredential } from '../services/provision.js';
import {
  ConferenceError,
  addParty,
  completeTransfer,
  liveCallsForSupervisor,
  mergeCall,
  removeParty,
  setHold,
  setMonitorMode,
  startMonitoring,
  stopMonitoring,
  transferCall,
} from '../services/conference.js';
import { writeAudit } from '../services/audit.js';
import { leadActivity } from '../services/lead-activity.js';
import { seedDemo } from '../seed-demo.js';
import { callRoutingOf } from '../services/last-contact.js';

declare module 'fastify' {
  interface FastifyRequest {
    authCtx: AuthContext | null;
  }
}

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

const createCallSchema = z.object({
  to_number: z.string().optional(),
  contact_id: z.string().uuid().optional(),
  lead_id: z.string().uuid().optional(),
  /** Caller-ID pick for this call; must be an active number the org owns. */
  from_phone_number_id: z.string().uuid().optional(),
});

const holdSchema = z.object({ hold: z.boolean() });

const monitorSchema = z.object({ mode: z.enum(MONITOR_MODES) });

/** A party is either a teammate (dialed on their browser) or a raw number. */
const addParticipantSchema = z
  .object({
    user_id: z.string().uuid().optional(),
    to_number: z.string().min(3).optional(),
    consult: z.boolean().optional(),
  })
  .refine((v) => Boolean(v.user_id) !== Boolean(v.to_number), {
    message: 'exactly one of user_id or to_number is required',
  });

const transferSchema = z
  .object({
    mode: z.enum(['warm', 'blind']),
    user_id: z.string().uuid().optional(),
    to_number: z.string().min(3).optional(),
  })
  .refine((v) => Boolean(v.user_id) !== Boolean(v.to_number), {
    message: 'exactly one of user_id or to_number is required',
  });

const updateMeSchema = z.object({
  timezone: z.string().max(64).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  /** Job title, not a permission — see users.title. */
  title: z.string().max(80).nullable().optional(),
  /** Caller ID (services/caller-id.ts): the number to dial out from, and how it is chosen. */
  default_phone_number_id: z.string().uuid().nullable().optional(),
  caller_id_mode: z.enum(['dedicated', 'local_presence']).optional(),
  /** Your own voicemail greeting; null falls back to the line's or the org's. */
  voicemail_greeting: greetingSchema.nullable().optional(),
});

const dispositionSchema = z.object({
  disposition: z.string().min(1),
  note: z.string().max(10_000).optional(),
  follow_up_at: z.coerce.date().optional(),
  lead_status: z.string().optional(),
});

const createLeadSchema = z.object({
  contact_name: z.string().min(1),
  phone: z.string().min(3),
  source: z.string().optional(),
  address: z.string().optional(),
  city: z.string().optional(),
  state: z.string().optional(),
  postal_code: z.string().optional(),
  external_item_id: z.string().optional(),
});

function mapServiceError(err: unknown, reply: FastifyReply): FastifyReply | null {
  if (!(err instanceof CallServiceError)) return null;
  const status: Record<CallServiceError['code'], number> = {
    suppressed: 422,
    invalid_number: 400,
    no_caller_id: 409,
    not_found: 404,
    invalid_disposition: 400,
    lead_mismatch: 400,
    forbidden: 403,
    call_not_active: 409,
    already_bound: 409,
    browser_leg_is_client: 409,
    number_protected: 429,
  };
  return reply.code(status[err.code]).send({ error: err.code, message: err.message });
}

/**
 * A refused control is a conflict, not a crash: the rep asked for something
 * the call is not in a state to do (holding an already-held customer, merging
 * with nobody to merge). 409 lets the UI re-sync rather than show an error.
 */
function mapConferenceError(err: unknown, reply: FastifyReply): FastifyReply | null {
  if (!(err instanceof ConferenceError)) return null;
  const status =
    err.code === 'not_found'
      ? 404
      : err.code === 'forbidden'
        ? 403
        : err.code === 'invalid_target'
          ? 400
          : 409;
  return reply.code(status).send({ error: err.code, message: err.message });
}

/**
 * Reject a zone the runtime cannot resolve, rather than storing a string that
 * silently formats as an error everywhere it is read.
 */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/**
 * Same freshness rule the inbound router uses: a browser that stopped
 * heartbeating is unreachable, whatever it last said about itself. Showing a
 * crashed tab as "available" is how a transfer lands nowhere.
 */
function isFreshPresence(lastSeenAt: Date | null): boolean {
  return lastSeenAt != null && Date.now() - lastSeenAt.getTime() <= PRESENCE_FRESHNESS_MS;
}

function serializeParticipant(p: typeof schema.callParticipants.$inferSelect) {
  return {
    id: p.id,
    call_id: p.callId,
    provider_participant_id: p.providerParticipantId,
    role: p.role,
    state: p.state,
    user_id: p.userId,
    address: p.address,
    label: p.label,
    joined_at: p.joinedAt,
    left_at: p.leftAt,
  };
}

export function registerV1Routes(app: FastifyInstance, deps: AppDeps): void {
  const { config, dbh, provider, logger } = deps;

  /** An active phone_numbers row this org owns — the only thing a caller-ID field may point at. */
  async function isActiveOrgNumber(id: string, orgId: string): Promise<boolean> {
    const row = (
      await dbh.db
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

  app.addHook('preHandler', async (req) => {
    if (!req.url.startsWith('/v1/')) return;
    let authorization = req.headers.authorization;
    // EventSource cannot set headers; the SSE endpoint (and only it) accepts
    // the JWT as a query param. Same verifier, same expiry rules.
    if (!authorization && req.url.startsWith('/v1/events/stream')) {
      const token = (req.query as { access_token?: string }).access_token;
      if (token) authorization = `Bearer ${token}`;
    }
    req.authCtx = await authenticate(
      dbh.db,
      config.AUTH_JWT_SECRET,
      authorization,
      deps.partners
        ? await deps.partners.list()
        : { secret: config.PARTNER_JWT_SECRET, jwksUrl: config.PARTNER_JWKS_URL, issuer: config.PARTNER_JWT_ISSUER },
      config.SUPABASE_URL,
    );
    // Product testing without sign-in (config.ts): no valid bearer means the
    // request runs as the configured user. A valid bearer was honoured above.
    if (!req.authCtx && config.AUTH_BYPASS_USER_EMAIL) {
      req.authCtx = await bypassContext(dbh.db, config.AUTH_BYPASS_USER_EMAIL);
    }
  });

  // -------------------------------------------------------------------------
  // Voice
  // -------------------------------------------------------------------------
  /**
   * A browser credential plus what the softphone needs to know about the
   * carrier behind it: which SDK to load (`provider`) and who opens the media
   * leg on an outbound call (`browser_leg`, see BrowserLegMode in @talkr/core).
   */
  app.post('/v1/voice/token', { preHandler: requirePermission('calls.place') }, async (req) => {
    const ctx = req.authCtx!;
    const token = await provider.mintClientToken(ctx.userId, 3600);
    return {
      token: token.token,
      identity: token.identity,
      ttl_seconds: token.ttlSeconds,
      provider: provider.name,
      browser_leg: provider.browserLeg ?? 'client',
    };
  });

  /**
   * Open the rep's browser leg from the server (browser_leg = 'server'). The
   * carrier rings the rep's registered SIP endpoint with this call's id on the
   * answer URL; the browser answers and the call proceeds as any other.
   */
  app.post('/v1/calls/:id/browser-leg', { preHandler: requirePermission('calls.place') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    try {
      const result = await ringBrowserForCall(dbh, provider, config.PUBLIC_BASE_URL, ctx, id, {
        config,
        logger,
      });
      return reply.code(202).send({ mode: result.mode, provider_call_id: result.providerCallId });
    } catch (err) {
      const mapped = mapServiceError(err, reply);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.post('/v1/calls', { preHandler: requirePermission('calls.place') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = createCallSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    if (parsed.data.from_phone_number_id && !(await isActiveOrgNumber(parsed.data.from_phone_number_id, ctx.orgId))) {
      return reply.code(400).send({ error: 'invalid_caller_id', message: 'not an active number this org owns' });
    }
    try {
      const call = await createOutboundCall(dbh, ctx, {
        toNumber: parsed.data.to_number,
        contactId: parsed.data.contact_id,
        leadId: parsed.data.lead_id,
        fromPhoneNumberId: parsed.data.from_phone_number_id,
      });
      return reply.code(201).send({ call: serializeCall(call) });
    } catch (err) {
      const mapped = mapServiceError(err, reply);
      if (mapped) return mapped;
      throw err;
    }
  });

  app.get('/v1/calls', { preHandler: requirePermission('calls.read.own') }, async (req) => {
    const ctx = req.authCtx!;
    const seeOrg = hasPermission(ctx, 'calls.read.org');
    const where = seeOrg
      ? eq(schema.calls.orgId, ctx.orgId)
      : and(eq(schema.calls.orgId, ctx.orgId), eq(schema.calls.userId, ctx.userId));
    const rows = await dbh.db
      .select()
      .from(schema.calls)
      .where(where)
      .orderBy(desc(schema.calls.createdAt))
      .limit(100);
    const contactIds = [
      ...new Set(rows.map((r) => r.contactId).filter((v): v is string => Boolean(v))),
    ];
    const nameById = new Map(
      (contactIds.length
        ? await dbh.db
            .select({ id: schema.contacts.id, displayName: schema.contacts.displayName })
            .from(schema.contacts)
            .where(inArray(schema.contacts.id, contactIds))
        : []
      ).map((c) => [c.id, c.displayName]),
    );
    return {
      calls: rows.map((c) => serializeCall(c, c.contactId ? nameById.get(c.contactId) : null)),
    };
  });

  /**
   * The inbound call ringing a rep's browser from this number. A Telnyx invite
   * to a WebRTC endpoint carries the caller's number but not our call id, so
   * the softphone asks here when the rep answers; without the id there is no
   * wrap-up and no call controls. Not scoped to the call's owner: on a ring
   * group nobody owns it until someone picks up.
   */
  app.get('/v1/calls/ringing', { preHandler: requirePermission('calls.read.own') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const last10 = String((req.query as { from?: string }).from ?? '').replace(/\D/g, '').slice(-10);
    if (last10.length !== 10) return reply.code(400).send({ error: 'invalid_from' });
    const call = (
      await dbh.db
        .select()
        .from(schema.calls)
        .where(
          and(
            eq(schema.calls.orgId, ctx.orgId),
            eq(schema.calls.direction, 'inbound'),
            sql`${schema.calls.endedAt} IS NULL`,
            sql`${schema.calls.createdAt} > now() - interval '2 minutes'`,
            sql`right(regexp_replace(${schema.calls.fromNumber}, '\\D', '', 'g'), 10) = ${last10}`,
          ),
        )
        .orderBy(desc(schema.calls.createdAt))
        .limit(1)
    )[0];
    if (!call) return reply.code(404).send({ error: 'not_found' });
    return { call: serializeCall(call) };
  });

  app.get('/v1/calls/:id', { preHandler: requirePermission('calls.read.own') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    const call = (
      await dbh.db
        .select()
        .from(schema.calls)
        .where(and(eq(schema.calls.id, id), eq(schema.calls.orgId, ctx.orgId)))
        .limit(1)
    )[0];
    if (!call) return reply.code(404).send({ error: 'not_found' });
    if (!hasPermission(ctx, 'calls.read.org') && call.userId !== ctx.userId) {
      return reply.code(403).send({ error: 'forbidden' });
    }
    const [events, recs] = await Promise.all([
      dbh.db
        .select()
        .from(schema.callEvents)
        .where(eq(schema.callEvents.callId, call.id))
        .orderBy(schema.callEvents.occurredAt),
      dbh.db.select().from(schema.recordings).where(eq(schema.recordings.callId, call.id)),
    ]);
    return {
      call: serializeCall(call),
      events: events.map((e) => ({
        id: e.id,
        type: e.eventType,
        occurred_at: e.occurredAt,
        source: e.source,
        sequence_number: e.sequenceNumber,
      })),
      recordings: recs.map((r) => ({
        id: r.id,
        status: r.status,
        duration_seconds: r.durationSeconds,
        channels: r.channels,
      })),
    };
  });

  /**
   * The org's people, with the local time each of them is actually in. This
   * powers the transfer roster and the team board: a transfer target at 3am
   * their time is a transfer you do not make.
   */
  app.get('/v1/team', { preHandler: requirePermission('calls.read.own') }, async (req) => {
    const ctx = req.authCtx!;
    const rows = await dbh.db
      .select({
        id: schema.users.id,
        displayName: schema.users.displayName,
        role: schema.users.role,
        title: schema.users.title,
        status: schema.users.status,
        timezone: schema.users.timezone,
        city: schema.users.city,
        presenceStatus: schema.agentPresence.status,
        lastSeenAt: schema.agentPresence.lastSeenAt,
      })
      .from(schema.users)
      .leftJoin(schema.agentPresence, eq(schema.agentPresence.userId, schema.users.id))
      .where(and(eq(schema.users.orgId, ctx.orgId), eq(schema.users.status, 'active')))
      .orderBy(schema.users.displayName);

    return {
      members: rows.map((r) => ({
        id: r.id,
        display_name: r.displayName,
        role: r.role,
        // The job, for the card. Falls back to nothing rather than to the
        // RBAC role, which is a permission and not a person's title.
        title: r.title,
        timezone: r.timezone,
        city: r.city,
        // Presence goes stale rather than lying: a browser that stopped
        // heartbeating is not "available", it is unreachable.
        presence: isFreshPresence(r.lastSeenAt) ? (r.presenceStatus ?? 'offline') : 'offline',
        last_seen_at: r.lastSeenAt,
        is_self: r.id === ctx.userId,
      })),
    };
  });

  /** The signed-in rep's own profile. */
  app.get('/v1/me', { preHandler: requirePermission('calls.read.own') }, async (req) => {
    const ctx = req.authCtx!;
    // A rep who can load the app can be rung: their carrier credential is
    // minted here if it does not exist yet, so nobody has to "enable" anything.
    await ensureBrowserCredential(dbh, provider, ctx.userId).catch((err: unknown) =>
      req.log.warn({ err: (err as Error).message }, 'could not provision browser credential'),
    );
    const me = (
      await dbh.db.select().from(schema.users).where(eq(schema.users.id, ctx.userId)).limit(1)
    )[0];
    const org = (
      await dbh.db
        .select({ id: schema.organizations.id, name: schema.organizations.name, slug: schema.organizations.slug })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, ctx.orgId))
        .limit(1)
    )[0];
    // The rep's own line(s): what the dialer presents as caller ID.
    const numbers = await dbh.db
      .select({ id: schema.phoneNumbers.id, phone_e164: schema.phoneNumbers.phoneE164, label: schema.phoneNumbers.label })
      .from(schema.phoneNumbers)
      .where(and(eq(schema.phoneNumbers.orgId, ctx.orgId), eq(schema.phoneNumbers.assignedUserId, ctx.userId)));
    // Every active line in the org: the caller-ID picker's options.
    const orgNumbers = await dbh.db
      .select({
        id: schema.phoneNumbers.id,
        phone_e164: schema.phoneNumbers.phoneE164,
        label: schema.phoneNumbers.label,
        area_code: schema.phoneNumbers.areaCode,
        assigned_user_id: schema.phoneNumbers.assignedUserId,
        assigned_user_name: schema.users.displayName,
      })
      .from(schema.phoneNumbers)
      .leftJoin(schema.users, eq(schema.users.id, schema.phoneNumbers.assignedUserId))
      .where(and(eq(schema.phoneNumbers.orgId, ctx.orgId), eq(schema.phoneNumbers.status, 'active')))
      .orderBy(schema.phoneNumbers.phoneE164);
    return {
      id: ctx.userId,
      display_name: me?.displayName ?? null,
      email: me?.email ?? null,
      role: me?.role ?? null,
      timezone: me?.timezone ?? null,
      city: me?.city ?? null,
      title: me?.title ?? null,
      org: org ?? null,
      numbers,
      org_numbers: orgNumbers,
      default_phone_number_id: me?.defaultPhoneNumberId ?? null,
      caller_id_mode: me?.callerIdMode ?? 'dedicated',
      voicemail_greeting: me?.voicemailGreeting ?? null,
    };
  });

  /**
   * Set your own working zone. This is self-service on purpose: the person who
   * knows where a rep works is that rep, and a stale zone quietly ruins every
   * transfer decision made about them. Your voicemail greeting is yours too.
   */
  app.patch('/v1/me', { preHandler: requirePermission('calls.read.own') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = updateMeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    if (parsed.data.timezone && !isValidTimeZone(parsed.data.timezone)) {
      return reply.code(400).send({ error: 'invalid_timezone', message: 'not an IANA time zone' });
    }
    if (
      parsed.data.default_phone_number_id &&
      !(await isActiveOrgNumber(parsed.data.default_phone_number_id, ctx.orgId))
    ) {
      return reply.code(400).send({ error: 'invalid_caller_id', message: 'not an active number this org owns' });
    }
    const [row] = await dbh.db
      .update(schema.users)
      .set({
        ...(parsed.data.timezone !== undefined ? { timezone: parsed.data.timezone } : {}),
        ...(parsed.data.city !== undefined ? { city: parsed.data.city } : {}),
        ...(parsed.data.title !== undefined ? { title: parsed.data.title } : {}),
        ...(parsed.data.default_phone_number_id !== undefined
          ? { defaultPhoneNumberId: parsed.data.default_phone_number_id }
          : {}),
        ...(parsed.data.caller_id_mode !== undefined ? { callerIdMode: parsed.data.caller_id_mode } : {}),
        ...(parsed.data.voicemail_greeting !== undefined ? { voicemailGreeting: parsed.data.voicemail_greeting } : {}),
      })
      .where(eq(schema.users.id, ctx.userId))
      .returning();
    return {
      id: ctx.userId,
      timezone: row?.timezone ?? null,
      city: row?.city ?? null,
      title: row?.title ?? null,
      default_phone_number_id: row?.defaultPhoneNumberId ?? null,
      caller_id_mode: row?.callerIdMode ?? 'dedicated',
      voicemail_greeting: row?.voicemailGreeting ?? null,
    };
  });

  // -------------------------------------------------------------------------
  // Conference call control (docs/telephony-events.md §9)
  // -------------------------------------------------------------------------

  /** Everyone currently in the call's room, in join order. */
  app.get(
    '/v1/calls/:id/participants',
    { preHandler: requirePermission('calls.read.own') },
    async (req, reply) => {
      const ctx = req.authCtx!;
      const { id } = req.params as { id: string };
      const call = (
        await dbh.db
          .select()
          .from(schema.calls)
          .where(and(eq(schema.calls.id, id), eq(schema.calls.orgId, ctx.orgId)))
          .limit(1)
      )[0];
      if (!call) return reply.code(404).send({ error: 'not_found' });
      if (!hasPermission(ctx, 'calls.read.org') && call.userId !== ctx.userId) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      const rows = await dbh.db
        .select()
        .from(schema.callParticipants)
        .where(eq(schema.callParticipants.callId, call.id))
        .orderBy(schema.callParticipants.createdAt);
      // A supervisor listening in is invisible to the rep; only supervisors see supervisors.
      const visible = hasPermission(ctx, 'calls.monitor') ? rows : rows.filter((r) => r.role !== 'supervisor');
      return { participants: visible.map(serializeParticipant) };
    },
  );

  const controlDeps = () => ({ dbh, provider, config });

  /** Hold or resume the customer. Body: `{ hold: boolean }`. */
  app.post(
    '/v1/calls/:id/hold',
    { preHandler: requirePermission('calls.control') },
    async (req, reply) => {
      const parsed = holdSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const { id } = req.params as { id: string };
      try {
        const participants = await setHold(controlDeps(), req.authCtx!, id, parsed.data.hold);
        return { participants: participants.map(serializeParticipant) };
      } catch (err) {
        const mapped = mapConferenceError(err, reply);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  /**
   * Add a party. `consult` (the default) holds the customer first, which is
   * "add call"; pass `consult: false` to drop them straight into the
   * conversation.
   */
  app.post(
    '/v1/calls/:id/participants',
    { preHandler: requirePermission('calls.control') },
    async (req, reply) => {
      const parsed = addParticipantSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const { id } = req.params as { id: string };
      try {
        const participant = await addParty(controlDeps(), req.authCtx!, id, {
          userId: parsed.data.user_id,
          toNumber: parsed.data.to_number,
          consult: parsed.data.consult ?? true,
          endConferenceOnExit: false,
          role: parsed.data.user_id ? 'teammate' : 'external',
        });
        return reply.code(201).send({ participant: serializeParticipant(participant) });
      } catch (err) {
        const mapped = mapConferenceError(err, reply);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  /** Un-hold everyone: the consultation becomes a conference. */
  app.post(
    '/v1/calls/:id/merge',
    { preHandler: requirePermission('calls.control') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        const participants = await mergeCall(controlDeps(), req.authCtx!, id);
        return { participants: participants.map(serializeParticipant) };
      } catch (err) {
        const mapped = mapConferenceError(err, reply);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  /** Drop one party; the room and everyone else carry on. */
  app.post(
    '/v1/calls/:id/participants/:participantId/remove',
    { preHandler: requirePermission('calls.control') },
    async (req, reply) => {
      const { id, participantId } = req.params as { id: string; participantId: string };
      try {
        await removeParty(controlDeps(), req.authCtx!, id, participantId);
        return { ok: true };
      } catch (err) {
        const mapped = mapConferenceError(err, reply);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  /**
   * Warm transfer announces first and waits for `/transfer/complete`; blind
   * hands the customer over and drops the rep in one call.
   */
  app.post(
    '/v1/calls/:id/transfer',
    { preHandler: requirePermission('calls.control') },
    async (req, reply) => {
      const parsed = transferSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const { id } = req.params as { id: string };
      try {
        const participant = await transferCall(controlDeps(), req.authCtx!, id, {
          mode: parsed.data.mode,
          userId: parsed.data.user_id,
          toNumber: parsed.data.to_number,
        });
        return reply.code(201).send({
          participant: serializeParticipant(participant),
          mode: parsed.data.mode,
        });
      } catch (err) {
        const mapped = mapConferenceError(err, reply);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  /** Finish a warm transfer: un-hold the customer, drop the rep. */
  app.post(
    '/v1/calls/:id/transfer/complete',
    { preHandler: requirePermission('calls.control') },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      try {
        await completeTransfer(controlDeps(), req.authCtx!, id);
        return { ok: true };
      } catch (err) {
        const mapped = mapConferenceError(err, reply);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  // -------------------------------------------------------------------------
  // Supervision: listen / whisper / barge (calls.monitor)
  // -------------------------------------------------------------------------

  /** Teammates' live calls a supervisor can join, and which they already are on. */
  app.get('/v1/calls/live', { preHandler: requirePermission('calls.monitor') }, async (req) => ({
    calls: await liveCallsForSupervisor(dbh, req.authCtx!),
  }));

  /**
   * POST joins (or re-joins) in `mode`, PATCH switches mode, DELETE leaves.
   * The supervisor's browser is dialed like a teammate's; it rings and must
   * be answered.
   */
  const monitorHandler =
    (op: 'start' | 'mode' | 'stop') => async (req: FastifyRequest, reply: FastifyReply) => {
      const { id } = req.params as { id: string };
      const parsed = op === 'stop' ? null : monitorSchema.safeParse(req.body ?? {});
      if (parsed && !parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      try {
        if (op === 'stop') {
          await stopMonitoring(controlDeps(), req.authCtx!, id);
          return { ok: true };
        }
        const mode = parsed!.data!.mode;
        const row =
          op === 'start'
            ? await startMonitoring(controlDeps(), req.authCtx!, id, mode)
            : await setMonitorMode(controlDeps(), req.authCtx!, id, mode);
        return reply.code(op === 'start' ? 201 : 200).send({ participant: serializeParticipant(row), mode });
      } catch (err) {
        const mapped = mapConferenceError(err, reply);
        if (mapped) return mapped;
        throw err;
      }
    };
  const monitorGate = { preHandler: requirePermission('calls.monitor') };
  app.post('/v1/calls/:id/monitor', monitorGate, monitorHandler('start'));
  app.patch('/v1/calls/:id/monitor', monitorGate, monitorHandler('mode'));
  app.delete('/v1/calls/:id/monitor', monitorGate, monitorHandler('stop'));

  app.post(
    '/v1/calls/:id/disposition',
    { preHandler: requirePermission('calls.disposition') },
    async (req, reply) => {
      const ctx = req.authCtx!;
      const { id } = req.params as { id: string };
      const parsed = dispositionSchema.safeParse(req.body ?? {});
      if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      try {
        const result = await setDisposition(dbh, ctx, id, {
          dispositionSlug: parsed.data.disposition,
          note: parsed.data.note,
          followUpAt: parsed.data.follow_up_at,
          leadStatus: parsed.data.lead_status,
        });
        return { call: serializeCall(result.call), disposition: result.disposition.slug };
      } catch (err) {
        const mapped = mapServiceError(err, reply);
        if (mapped) return mapped;
        throw err;
      }
    },
  );

  app.get('/v1/dispositions', { preHandler: requirePermission('calls.read.own') }, async (req) => {
    const ctx = req.authCtx!;
    const rows = await dbh.db
      .select()
      .from(schema.callDispositions)
      .where(and(eq(schema.callDispositions.orgId, ctx.orgId), eq(schema.callDispositions.isActive, true)))
      .orderBy(schema.callDispositions.sortOrder);
    return {
      dispositions: rows.map((d) => ({
        slug: d.slug,
        name: d.name,
        requires_follow_up: d.requiresFollowUp,
        adds_suppression: d.addsSuppression,
      })),
    };
  });

  // -------------------------------------------------------------------------
  // Presence (inbound routing input — docs/inbound-routing.md §2)
  // -------------------------------------------------------------------------
  app.post('/v1/presence', { preHandler: requirePermission('calls.place') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = z
      .object({ status: z.enum(['available', 'away', 'offline']) })
      .safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body' });
    await dbh.db
      .insert(schema.agentPresence)
      .values({
        userId: ctx.userId,
        orgId: ctx.orgId,
        status: parsed.data.status,
        lastSeenAt: new Date(),
      })
      .onConflictDoUpdate({
        target: schema.agentPresence.userId,
        set: { status: parsed.data.status, lastSeenAt: new Date() },
      });
    // Floor view (Phase 6): presence flips ride the existing NOTIFY→SSE bus.
    await publishBusEvent(dbh.pool, {
      type: 'presence.updated',
      orgId: ctx.orgId,
      userId: ctx.userId,
      data: { status: parsed.data.status },
    }).catch((err: Error) => req.log.warn({ err: err.message }, 'presence bus publish failed'));
    return { ok: true, status: parsed.data.status };
  });

  // -------------------------------------------------------------------------
  // Caller lookup ("know who's calling before you pick up")
  // -------------------------------------------------------------------------
  app.get('/v1/lookup/phone', { preHandler: requirePermission('leads.read') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const raw = (req.query as { number?: string }).number;
    if (!raw) return reply.code(400).send({ error: 'number_required' });
    const { normalizePhone } = await import('@talkr/core');
    const normalized = normalizePhone(raw);
    const phone = (
      await dbh.db
        .select()
        .from(schema.contactPhones)
        .where(
          and(
            eq(schema.contactPhones.orgId, ctx.orgId),
            eq(schema.contactPhones.phoneE164, normalized.e164),
          ),
        )
        .limit(1)
    )[0];
    if (!phone) return { contact: null, lead: null, property: null };
    const contact = (
      await dbh.db.select().from(schema.contacts).where(eq(schema.contacts.id, phone.contactId)).limit(1)
    )[0];
    const lead = contact
      ? (
          await dbh.db
            .select()
            .from(schema.leads)
            .where(
              and(eq(schema.leads.orgId, ctx.orgId), eq(schema.leads.primaryContactId, contact.id)),
            )
            .orderBy(desc(schema.leads.createdAt))
            .limit(1)
        )[0]
      : undefined;
    const property = lead?.propertyId
      ? (
          await dbh.db
            .select()
            .from(schema.properties)
            .where(eq(schema.properties.id, lead.propertyId))
            .limit(1)
        )[0]
      : undefined;
    return {
      contact: contact ? { id: contact.id, display_name: contact.displayName } : null,
      lead: lead
        ? { id: lead.id, status: lead.status, source: lead.source, assigned_user_id: lead.assignedUserId }
        : null,
      property: property
        ? {
            id: property.id,
            address_line1: property.addressLine1,
            city: property.city,
            state: property.state,
          }
        : null,
    };
  });

  // -------------------------------------------------------------------------
  // Leads (minimal Phase 2 surface; Podio webhook sync will feed this table)
  // -------------------------------------------------------------------------
  app.get('/v1/leads', { preHandler: requirePermission('leads.read') }, async (req) => {
    const ctx = req.authCtx!;
    const rows = await dbh.db
      .select()
      .from(schema.leads)
      .where(eq(schema.leads.orgId, ctx.orgId))
      .orderBy(desc(schema.leads.createdAt))
      .limit(100);
    return { leads: rows };
  });

  /**
   * One lead with its card and merged activity — the dialer's Lead tab. The
   * `leads.read` holder sees any lead in the org; there is no per-rep scoping
   * on leads today (the list above has none either), and a rep taking a
   * transfer needs the history of a lead that is not theirs.
   */
  app.get('/v1/leads/:id', { preHandler: requirePermission('leads.read') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    if (!/^[0-9a-f-]{36}$/i.test(id)) return reply.code(404).send({ error: 'not_found' });
    const limitRaw = Number((req.query as { limit?: string }).limit);
    const activity = await leadActivity(dbh.db, ctx.orgId, id, {
      limit: Number.isFinite(limitRaw) && limitRaw > 0 ? limitRaw : undefined,
    });
    if (!activity) return reply.code(404).send({ error: 'not_found' });
    return activity;
  });

  app.post('/v1/leads', { preHandler: requirePermission('leads.assign') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = createLeadSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    const d = parsed.data;
    const lead = await dbh.db.transaction(async (tx) => {
      const contact = (
        await tx
          .insert(schema.contacts)
          .values({ orgId: ctx.orgId, displayName: d.contact_name })
          .returning()
      )[0]!;
      await tx.insert(schema.contactPhones).values({
        orgId: ctx.orgId,
        contactId: contact.id,
        phoneE164: d.phone,
        isPrimary: true,
      });
      const property = d.address
        ? (
            await tx
              .insert(schema.properties)
              .values({
                orgId: ctx.orgId,
                addressLine1: d.address,
                city: d.city,
                state: d.state,
                postalCode: d.postal_code,
              })
              .returning()
          )[0]
        : undefined;
      const row = (
        await tx
          .insert(schema.leads)
          .values({
            orgId: ctx.orgId,
            source: d.source ?? 'manual',
            primaryContactId: contact.id,
            propertyId: property?.id,
            externalItemId: d.external_item_id,
            receivedAt: new Date(),
          })
          .returning()
      )[0]!;
      await writeAudit(tx, {
        orgId: ctx.orgId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'lead.create',
        objectType: 'lead',
        objectId: row.id,
      });
      return row;
    });
    return reply.code(201).send({ lead });
  });

  // -------------------------------------------------------------------------
  // Admin: event log, dead letters, replay, integrity (docs/telephony-events.md §7)
  // -------------------------------------------------------------------------
  app.get(
    '/v1/admin/webhook-events',
    { preHandler: requirePermission('admin.events') },
    async (req) => {
      const { status } = req.query as { status?: string };
      const rows = await dbh.db
        .select({
          id: schema.webhookEvents.id,
          provider: schema.webhookEvents.provider,
          endpoint: schema.webhookEvents.endpoint,
          status: schema.webhookEvents.status,
          attempts: schema.webhookEvents.attempts,
          duplicateCount: schema.webhookEvents.duplicateCount,
          providerObjectId: schema.webhookEvents.providerObjectId,
          providerEventType: schema.webhookEvents.providerEventType,
          lastError: schema.webhookEvents.lastError,
          receivedAt: schema.webhookEvents.receivedAt,
        })
        .from(schema.webhookEvents)
        .where(status ? eq(schema.webhookEvents.status, status) : sql`true`)
        .orderBy(desc(schema.webhookEvents.receivedAt))
        .limit(200);
      return { events: rows };
    },
  );

  app.post(
    '/v1/admin/webhook-events/:id/replay',
    { preHandler: requirePermission('admin.events') },
    async (req, reply) => {
      const ctx = req.authCtx!;
      const { id } = req.params as { id: string };
      const row = (
        await dbh.db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.id, id)).limit(1)
      )[0];
      if (!row) return reply.code(404).send({ error: 'not_found' });
      await dbh.db
        .update(schema.webhookEvents)
        .set({ status: 'received', lastError: null })
        .where(eq(schema.webhookEvents.id, id));
      await enqueueJob(dbh.db, {
        jobType: 'process-webhook',
        payload: { webhookEventId: id },
        dedupeKey: `process-webhook:${id}:replay:${Date.now()}`,
      });
      await writeAudit(dbh.db, {
        orgId: ctx.orgId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'webhook_event.replay',
        objectType: 'webhook_event',
        objectId: id,
      });
      return { replayed: true };
    },
  );

  app.get('/v1/admin/jobs', { preHandler: requirePermission('admin.events') }, async (req) => {
    const { status } = req.query as { status?: string };
    const rows = await dbh.db
      .select()
      .from(schema.jobs)
      .where(status ? eq(schema.jobs.status, status) : sql`true`)
      .orderBy(desc(schema.jobs.updatedAt))
      .limit(200);
    return { jobs: rows };
  });

  app.post(
    '/v1/admin/jobs/:id/retry',
    { preHandler: requirePermission('admin.events') },
    async (req, reply) => {
      const ctx = req.authCtx!;
      const { id } = req.params as { id: string };
      const ok = await retryDeadJob(dbh.db, id);
      if (!ok) return reply.code(404).send({ error: 'not_dead_or_missing' });
      await writeAudit(dbh.db, {
        orgId: ctx.orgId,
        actorType: 'user',
        actorId: ctx.userId,
        action: 'job.retry_dead',
        objectType: 'job',
        objectId: id,
      });
      return { retried: true };
    },
  );

  /**
   * Load the demo history (seed-demo.ts) into the caller's own workspace, for
   * product testing a fresh org from a phone. Idempotent per seller.
   */
  app.post('/v1/admin/seed-demo', { preHandler: requirePermission('admin.events') }, async (req) => {
    const ctx = req.authCtx!;
    const result = await seedDemo(dbh.db, ctx.email);
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'admin.seed_demo',
      objectType: 'organization',
      objectId: ctx.orgId,
      metadata: result,
    });
    return result;
  });

  app.get('/v1/admin/mismatches', { preHandler: requirePermission('admin.events') }, async () => {
    const rows = await dbh.db
      .select()
      .from(schema.reconciliationMismatches)
      .orderBy(desc(schema.reconciliationMismatches.detectedAt))
      .limit(200);
    return { mismatches: rows };
  });

  // -------------------------------------------------------------------------
  // Org settings (docs/telephony-events.md §9.7)
  //
  // The org's shared configuration, not the rep's — so it rides `admin.users`,
  // the existing org-administration permission, rather than a new role. Reads
  // are gated the same way: what the whole org hears on a call is an admin's
  // business, and a rep has nothing to do with it.
  // -------------------------------------------------------------------------

  /** Everything an admin can configure for the org. Hold music, so far. */
  app.get('/v1/org/settings', { preHandler: requirePermission('admin.users') }, async (req) => {
    const ctx = req.authCtx!;
    const org = (
      await dbh.db
        .select({ settings: schema.organizations.settings })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, ctx.orgId))
        .limit(1)
    )[0];
    return { hold_music: readHoldMusic(org?.settings), ai_agent: readAiAgent(org?.settings) };
  });

  /**
   * Merge a settings patch. The column is a shared jsonb blob (business hours,
   * the SMS window, the dialer abandon message), so keys this endpoint does
   * not own are read back and rewritten untouched — a hold-music save must
   * never wipe the org's calling hours.
   *
   * Validation is here, at write time, and nowhere else: a hold-music URL that
   * would not play is a form error, never a silent call.
   */
  app.patch('/v1/org/settings', { preHandler: requirePermission('admin.users') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = orgSettingsPatchSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const org = (
      await dbh.db
        .select({ settings: schema.organizations.settings })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, ctx.orgId))
        .limit(1)
    )[0];
    if (!org) return reply.code(404).send({ error: 'not_found' });

    const current = (org.settings ?? {}) as Record<string, unknown>;
    const next = { ...current };
    if (parsed.data.hold_music) next.hold_music = parsed.data.hold_music;
    if (parsed.data.ai_agent) next.ai_agent = parsed.data.ai_agent;

    const [row] = await dbh.db
      .update(schema.organizations)
      .set({ settings: next, updatedAt: new Date() })
      .where(eq(schema.organizations.id, ctx.orgId))
      .returning({ settings: schema.organizations.settings });

    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'org.settings_update',
      objectType: 'organization',
      objectId: ctx.orgId,
      metadata: { keys: Object.keys(parsed.data) },
    });
    return { hold_music: readHoldMusic(row?.settings), ai_agent: readAiAgent(row?.settings) };
  });
}

function serializeCall(
  call: typeof schema.calls.$inferSelect,
  /** Resolved separately so the single-call route need not join. */
  contactName?: string | null,
) {
  return {
    id: call.id,
    correlation_id: call.correlationId,
    direction: call.direction,
    status: call.status,
    user_id: call.userId,
    lead_id: call.leadId,
    contact_id: call.contactId,
    from_number: call.fromNumber,
    to_number: call.toNumber,
    initiated_at: call.initiatedAt,
    ringing_at: call.ringingAt,
    answered_at: call.answeredAt,
    ended_at: call.endedAt,
    duration_seconds: call.durationSeconds,
    failure_class: call.failureClass,
    disposition_id: call.dispositionId,
    follow_up_at: call.followUpAt,
    crm_sync_status: call.crmSyncStatus,
    // Who it was, not just what number. A history of ten phone numbers is
    // unreadable, and every row already knows its contact.
    contact_name: contactName ?? null,
    created_at: call.createdAt,
    /** Inbound: why it rang who it rang; `last_contact` carries the touch. Null for outbound. */
    routing: callRoutingOf(call.raw),
  };
}
