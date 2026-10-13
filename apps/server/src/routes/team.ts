/**
 * Team management (docs/security.md §2 "Adding a rep"): the admin surface for
 * adding teammates, changing role/title/status and assigning a default
 * caller-ID number. GET /v1/team in v1.ts stays the roster reps see (active
 * members only); everything here is the admin's view, invited and disabled
 * included. Auth is provided by the /v1 preHandler hook registered in
 * registerV1Routes; register this module after it in app.ts.
 *
 * Adding a teammate creates our `users` row first and then asks GoTrue to
 * email an invite. The email is best effort on purpose: the row is what makes
 * them a member, and `linkByEmail` (auth.ts) claims it on first sign-in
 * however the auth user came to exist.
 */

import { and, eq, ne, sql } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PRESENCE_FRESHNESS_MS, ROLES, greetingSchema, type Permission } from '@talkr/core';
import { schema } from '@talkr/db';
import type { AppDeps } from '../app.js';
import { hasPermission, type AuthContext } from '../auth.js';
import { writeAudit } from '../services/audit.js';
import { ensureBrowserCredential } from '../services/provision.js';

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

const createMemberSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  display_name: z.string().trim().min(1).max(120),
  role: z.enum(ROLES),
  /** Job title, not a permission — see users.title. */
  title: z.string().trim().max(80).nullable().optional(),
  default_phone_number_id: z.string().uuid().nullable().optional(),
});

const updateMemberSchema = z.object({
  display_name: z.string().trim().min(1).max(120).optional(),
  role: z.enum(ROLES).optional(),
  title: z.string().trim().max(80).nullable().optional(),
  /** `invited` is never set by hand: it is where a new row starts. */
  status: z.enum(['active', 'disabled']).optional(),
  default_phone_number_id: z.string().uuid().nullable().optional(),
  timezone: z.string().max(64).nullable().optional(),
  city: z.string().trim().max(120).nullable().optional(),
  /** Their own phone, where call flows forward what they miss. */
  personal_phone_e164: z.string().regex(/^\+[1-9]\d{7,14}$/, 'E.164, e.g. +12105550100').nullable().optional(),
  /** Their voicemail greeting: spoken text or an uploaded recording. */
  voicemail_greeting: greetingSchema.nullable().optional(),
});

/** Same rule as PATCH /v1/me: a zone the runtime cannot resolve is rejected. */
function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

/** Same freshness rule as the roster: a browser that stopped heartbeating is offline. */
function isFreshPresence(lastSeenAt: Date | null): boolean {
  return lastSeenAt != null && Date.now() - lastSeenAt.getTime() <= PRESENCE_FRESHNESS_MS;
}

type InviteOutcome =
  | { status: 'sent'; message: null }
  | { status: 'failed'; message: string }
  | { status: 'not_configured'; message: null };

interface GoTrueError {
  msg?: string;
  error?: string;
  error_description?: string;
}

/**
 * Ask GoTrue to email an invite. Needs the service-role key, which is why it
 * is a separate optional variable from the anon key sign-in uses: this one can
 * create auth users. Never throws — the caller already has the member row and
 * reports the email outcome alongside it.
 */
async function sendAuthInvite(
  deps: AppDeps,
  log: FastifyBaseLogger,
  input: { email: string; displayName: string; orgId: string },
): Promise<InviteOutcome> {
  const { config } = deps;
  if (!config.SUPABASE_URL || !config.SUPABASE_SERVICE_ROLE_KEY) {
    return { status: 'not_configured', message: null };
  }
  const origin = config.WEB_ORIGIN[0];
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  try {
    const res = await doFetch(`${config.SUPABASE_URL}/auth/v1/invite`, {
      method: 'POST',
      headers: {
        apikey: config.SUPABASE_SERVICE_ROLE_KEY,
        authorization: `Bearer ${config.SUPABASE_SERVICE_ROLE_KEY}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        email: input.email,
        data: { display_name: input.displayName, org_id: input.orgId },
        ...(origin ? { redirect_to: `${origin}/login` } : {}),
      }),
    });
    if (res.ok) {
      log.info({ email: input.email }, 'auth invite sent');
      return { status: 'sent', message: null };
    }
    let body: GoTrueError = {};
    try {
      body = (await res.json()) as GoTrueError;
    } catch {
      /* non-JSON error page */
    }
    const message = body.msg ?? body.error_description ?? body.error ?? `auth server responded ${res.status}`;
    log.warn({ email: input.email, status: res.status, message }, 'auth invite failed');
    return { status: 'failed', message };
  } catch (err) {
    log.warn({ err, email: input.email }, 'auth invite failed');
    return { status: 'failed', message: (err as Error).message };
  }
}

export function registerTeamRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { dbh } = deps;
  const admin = { preHandler: requirePermission('admin.users') };

  /** Members with presence joined, in roster order; `id` narrows to one. */
  async function loadMembers(orgId: string, id?: string) {
    return dbh.db
      .select({
        user: schema.users,
        presenceStatus: schema.agentPresence.status,
        lastSeenAt: schema.agentPresence.lastSeenAt,
      })
      .from(schema.users)
      .leftJoin(schema.agentPresence, eq(schema.agentPresence.userId, schema.users.id))
      .where(and(eq(schema.users.orgId, orgId), id ? eq(schema.users.id, id) : undefined))
      .orderBy(schema.users.displayName);
  }

  function serializeMember(
    row: Awaited<ReturnType<typeof loadMembers>>[number],
    ctx: AuthContext,
  ) {
    const u = row.user;
    return {
      id: u.id,
      email: u.email,
      display_name: u.displayName,
      role: u.role,
      title: u.title,
      status: u.status,
      timezone: u.timezone,
      city: u.city,
      default_phone_number_id: u.defaultPhoneNumberId,
      personal_phone_e164: u.personalPhoneE164,
      voicemail_greeting: u.voicemailGreeting ?? null,
      // False until their first sign-in claims the row (linkByEmail). This is
      // what tells an admin whether "resend invite" still means anything.
      auth_linked: u.authUserId != null,
      presence: isFreshPresence(row.lastSeenAt) ? (row.presenceStatus ?? 'offline') : 'offline',
      last_seen_at: row.lastSeenAt,
      created_at: u.createdAt,
      is_self: u.id === ctx.userId,
    };
  }

  /** A caller-ID default must be one of the org's own live numbers. */
  async function isAssignableNumber(orgId: string, id: string): Promise<boolean> {
    const rows = await dbh.db
      .select({ id: schema.phoneNumbers.id })
      .from(schema.phoneNumbers)
      .where(
        and(
          eq(schema.phoneNumbers.id, id),
          eq(schema.phoneNumbers.orgId, orgId),
          eq(schema.phoneNumbers.status, 'active'),
        ),
      )
      .limit(1);
    return rows.length > 0;
  }

  // -------------------------------------------------------------------------
  // Roster, every status
  // -------------------------------------------------------------------------
  app.get('/v1/team/members', admin, async (req) => {
    const ctx = req.authCtx!;
    const rows = await loadMembers(ctx.orgId);
    return { members: rows.map((r) => serializeMember(r, ctx)) };
  });

  // -------------------------------------------------------------------------
  // Add
  // -------------------------------------------------------------------------
  app.post('/v1/team/members', admin, async (req, reply) => {
    const ctx = req.authCtx!;
    const parsed = createMemberSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const input = parsed.data;
    if (input.role === 'owner' && ctx.role !== 'owner') {
      return reply.code(403).send({ error: 'owner_required', message: 'Only an owner can add another owner.' });
    }
    if (input.default_phone_number_id && !(await isAssignableNumber(ctx.orgId, input.default_phone_number_id))) {
      return reply.code(400).send({ error: 'invalid_phone_number', message: 'Not an active number in this workspace.' });
    }
    // The unique index is on the exact string; rows written before emails
    // were normalized may carry capitals, so the duplicate check is case-blind.
    const existing = await dbh.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(and(eq(schema.users.orgId, ctx.orgId), sql`lower(${schema.users.email}) = ${input.email}`))
      .limit(1);
    if (existing.length > 0) {
      return reply.code(409).send({ error: 'email_taken', message: 'Someone with that email is already on the team.' });
    }
    const inserted = (
      await dbh.db
        .insert(schema.users)
        .values({
          orgId: ctx.orgId,
          email: input.email,
          displayName: input.display_name,
          role: input.role,
          title: input.title ?? null,
          status: 'invited',
          defaultPhoneNumberId: input.default_phone_number_id ?? null,
        })
        .onConflictDoNothing({ target: [schema.users.orgId, schema.users.email] })
        .returning({ id: schema.users.id })
    )[0];
    if (!inserted) {
      return reply.code(409).send({ error: 'email_taken', message: 'Someone with that email is already on the team.' });
    }

    const invite = await sendAuthInvite(deps, req.log, {
      email: input.email,
      displayName: input.display_name,
      orgId: ctx.orgId,
    });
    // Reachable from day one: ring groups can include them before they ever sign in.
    void ensureBrowserCredential(dbh, deps.provider, inserted.id).catch((err: unknown) =>
      req.log.warn({ err: (err as Error).message, userId: inserted.id }, 'could not provision browser credential'),
    );
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'team.member.invite',
      objectType: 'user',
      objectId: inserted.id,
      metadata: { email: input.email, role: input.role, auth_invite: invite.status },
    });

    const [row] = await loadMembers(ctx.orgId, inserted.id);
    return reply.code(201).send({
      member: serializeMember(row!, ctx),
      auth_invite: invite.status,
      auth_invite_error: invite.message,
    });
  });

  // -------------------------------------------------------------------------
  // Change
  // -------------------------------------------------------------------------
  app.patch('/v1/team/members/:id', admin, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    const parsed = updateMemberSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const input = parsed.data;

    const target = (
      await dbh.db
        .select()
        .from(schema.users)
        .where(and(eq(schema.users.id, id), eq(schema.users.orgId, ctx.orgId)))
        .limit(1)
    )[0];
    if (!target) return reply.code(404).send({ error: 'not_found' });

    // Role and status are the two fields that decide who can do what, so
    // every guard below is about them. Nobody edits their own: locking
    // yourself out or promoting yourself both need a second admin.
    const changesRole = input.role !== undefined && input.role !== target.role;
    const changesStatus = input.status !== undefined && input.status !== target.status;
    if (target.id === ctx.userId && (input.role !== undefined || input.status !== undefined)) {
      return reply.code(403).send({
        error: 'cannot_change_self',
        message: 'Your own role and status can only be changed by another admin.',
      });
    }
    if (ctx.role !== 'owner') {
      if (target.role === 'owner') {
        return reply.code(403).send({ error: 'owner_required', message: 'Only an owner can change an owner.' });
      }
      if (input.role === 'owner') {
        return reply.code(403).send({ error: 'owner_required', message: 'Only an owner can grant owner.' });
      }
    }
    const removesActiveOwner =
      target.role === 'owner' &&
      target.status === 'active' &&
      ((changesRole && input.role !== 'owner') || input.status === 'disabled');
    if (removesActiveOwner) {
      const [others] = await dbh.db
        .select({ n: sql<number>`count(*)::int` })
        .from(schema.users)
        .where(
          and(
            eq(schema.users.orgId, ctx.orgId),
            eq(schema.users.role, 'owner'),
            eq(schema.users.status, 'active'),
            ne(schema.users.id, target.id),
          ),
        );
      if ((others?.n ?? 0) === 0) {
        return reply.code(409).send({
          error: 'last_owner',
          message: 'This is the only active owner. Make someone else an owner first.',
        });
      }
    }
    if (input.timezone && !isValidTimeZone(input.timezone)) {
      return reply.code(400).send({ error: 'invalid_timezone', message: 'not an IANA time zone' });
    }
    if (input.default_phone_number_id && !(await isAssignableNumber(ctx.orgId, input.default_phone_number_id))) {
      return reply.code(400).send({ error: 'invalid_phone_number', message: 'Not an active number in this workspace.' });
    }

    const update: Partial<typeof schema.users.$inferInsert> = {};
    if (input.display_name !== undefined) update.displayName = input.display_name;
    if (input.role !== undefined) update.role = input.role;
    if (input.title !== undefined) update.title = input.title;
    if (input.status !== undefined) update.status = input.status;
    if (input.default_phone_number_id !== undefined) update.defaultPhoneNumberId = input.default_phone_number_id;
    if (input.timezone !== undefined) update.timezone = input.timezone;
    if (input.city !== undefined) update.city = input.city;
    if (input.personal_phone_e164 !== undefined) update.personalPhoneE164 = input.personal_phone_e164;
    if (input.voicemail_greeting !== undefined) update.voicemailGreeting = input.voicemail_greeting;
    if (Object.keys(update).length === 0) return reply.code(400).send({ error: 'empty_update' });

    await dbh.db.update(schema.users).set(update).where(eq(schema.users.id, target.id));
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'team.member.update',
      objectType: 'user',
      objectId: target.id,
      metadata: {
        changed: Object.keys(input),
        // The before/after that matters for a security review; the rest is
        // recoverable from the row itself.
        ...(changesRole ? { role: { from: target.role, to: input.role } } : {}),
        ...(changesStatus ? { status: { from: target.status, to: input.status } } : {}),
      },
    });

    const [row] = await loadMembers(ctx.orgId, target.id);
    return { member: serializeMember(row!, ctx) };
  });

  // -------------------------------------------------------------------------
  // Invite again
  // -------------------------------------------------------------------------
  app.post('/v1/team/members/:id/resend-invite', admin, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    const target = (
      await dbh.db
        .select()
        .from(schema.users)
        .where(and(eq(schema.users.id, id), eq(schema.users.orgId, ctx.orgId)))
        .limit(1)
    )[0];
    if (!target) return reply.code(404).send({ error: 'not_found' });
    if (target.authUserId) {
      return reply.code(409).send({ error: 'already_linked', message: 'They have already signed in.' });
    }
    if (target.status === 'disabled') {
      return reply.code(409).send({ error: 'member_disabled', message: 'Re-enable them before inviting again.' });
    }
    const invite = await sendAuthInvite(deps, req.log, {
      email: target.email,
      displayName: target.displayName,
      orgId: ctx.orgId,
    });
    await writeAudit(dbh.db, {
      orgId: ctx.orgId,
      actorType: 'user',
      actorId: ctx.userId,
      action: 'team.member.invite',
      objectType: 'user',
      objectId: target.id,
      metadata: { email: target.email, resend: true, auth_invite: invite.status },
    });
    return { auth_invite: invite.status, auth_invite_error: invite.message };
  });
}
