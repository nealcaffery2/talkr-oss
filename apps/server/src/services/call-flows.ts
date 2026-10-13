/**
 * The database side of call flows (packages/core/src/call-flow.ts): the facts
 * the executor reads, the org checks a saved flow must pass, greeting
 * resolution, and the missed-call auto-text.
 */

import { and, eq, gte, inArray, ne, sql } from 'drizzle-orm';
import {
  LAST_CONTACT_MAX_DAYS,
  flowReferences,
  isAvailable,
  isCallFlow,
  type CallFlow,
  type FlowFacts,
  type FlowGreeting,
} from '@talkr/core';
import { schema, type Db } from '@talkr/db';
import type { JobHandler } from '../worker/handlers.js';
import { MessageServiceError, sendMessage } from './messages.js';
import { loadPresenceMap } from './inbound-routing.js';
import { loadLastTouches } from './last-contact.js';

type NumberRow = typeof schema.phoneNumbers.$inferSelect;

const DEFAULT_GREETING =
  'Thank you for calling. We are unable to take your call right now. Please leave your name and number after the beep.';

/**
 * Everything the executor may ask about one org, in four queries.
 * `available: 'all'` is the simulator's default: pretend everyone is in.
 */
export async function loadFlowFacts(
  db: Db,
  orgId: string,
  opts: {
    now?: Date;
    leadOwnerUserId?: string | null;
    /** The caller, when a flow's last_contact target needs their touch history. */
    lastContactPhone?: string | null;
    tried?: Record<string, string[]>;
    available?: 'presence' | 'all' | { except: string[] };
  } = {},
): Promise<FlowFacts> {
  const now = opts.now ?? new Date();
  const users = await db
    .select({ id: schema.users.id, personal: schema.users.personalPhoneE164 })
    .from(schema.users)
    .where(and(eq(schema.users.orgId, orgId), eq(schema.users.status, 'active')));
  const members = await db
    .select({ teamId: schema.teamMembers.teamId, userId: schema.teamMembers.userId })
    .from(schema.teamMembers)
    .innerJoin(schema.teams, eq(schema.teams.id, schema.teamMembers.teamId))
    .where(eq(schema.teams.orgId, orgId));
  const active = new Set(users.map((u) => u.id));
  const teams: Record<string, string[]> = {};
  for (const m of members) if (active.has(m.userId)) (teams[m.teamId] ??= []).push(m.userId);
  const presence = await loadPresenceMap(db, [...active]);
  const phones = new Map(users.map((u) => [u.id, u.personal]));
  const mode = opts.available ?? 'presence';
  // Every target's window fits inside the longest one; core filters per target.
  const lastTouches = opts.lastContactPhone
    ? (await loadLastTouches(db, orgId, opts.lastContactPhone, { now, withinDays: LAST_CONTACT_MAX_DAYS })).filter((t) => active.has(t.userId))
    : [];
  return {
    now,
    everyone: users.map((u) => u.id),
    teams,
    leadOwnerUserId: opts.leadOwnerUserId && active.has(opts.leadOwnerUserId) ? opts.leadOwnerUserId : null,
    lastTouches,
    isAvailable: (id) =>
      mode === 'all' ? active.has(id) : typeof mode === 'object' ? active.has(id) && !mode.except.includes(id) : isAvailable(presence.get(id), now),
    lastRungAt: (id) => presence.get(id)?.lastRungAt?.getTime() ?? -1,
    personalPhone: (id) => phones.get(id) ?? null,
    tried: opts.tried ?? {},
  };
}

/** Users, teams and numbers a flow names must belong to the org. */
export async function flowReferenceErrors(db: Db, orgId: string, flow: CallFlow, selfNumberId: string): Promise<string[]> {
  const refs = flowReferences(flow);
  const errors: string[] = [];
  if (refs.userIds.length > 0) {
    const rows = await db.select({ id: schema.users.id }).from(schema.users)
      .where(and(eq(schema.users.orgId, orgId), inArray(schema.users.id, refs.userIds)));
    const found = new Set(rows.map((r) => r.id));
    for (const id of refs.userIds) if (!found.has(id)) errors.push(`user ${id} is not on this team`);
  }
  if (refs.teamIds.length > 0) {
    const rows = await db.select({ id: schema.teams.id }).from(schema.teams)
      .where(and(eq(schema.teams.orgId, orgId), inArray(schema.teams.id, refs.teamIds)));
    const found = new Set(rows.map((r) => r.id));
    for (const id of refs.teamIds) if (!found.has(id)) errors.push(`team ${id} is not in this workspace`);
  }
  for (const id of refs.phoneNumberIds) {
    if (id === selfNumberId) errors.push('a number cannot hand calls to its own flow');
  }
  const others = refs.phoneNumberIds.filter((id) => id !== selfNumberId);
  if (others.length > 0) {
    const rows = await db.select({ id: schema.phoneNumbers.id }).from(schema.phoneNumbers)
      .where(and(eq(schema.phoneNumbers.orgId, orgId), inArray(schema.phoneNumbers.id, others), eq(schema.phoneNumbers.status, 'active')));
    const found = new Set(rows.map((r) => r.id));
    for (const id of others) if (!found.has(id)) errors.push(`number ${id} is not an active number in this workspace`);
  }
  return errors;
}

/** Other numbers' flows, for simulating number_flow steps. */
export async function loadOtherFlows(db: Db, orgId: string): Promise<Record<string, CallFlow | null>> {
  const rows = await db.select({ id: schema.phoneNumbers.id, ivr: schema.phoneNumbers.ivr }).from(schema.phoneNumbers)
    .where(and(eq(schema.phoneNumbers.orgId, orgId), eq(schema.phoneNumbers.status, 'active')));
  return Object.fromEntries(rows.map((r) => [r.id, isCallFlow(r.ivr) ? r.ivr : null]));
}

/** A greeting rendered for the carrier: spoken text, or a recording to play. */
export interface RenderedGreeting {
  text: string;
  audioUrl?: string;
}

function render(g: FlowGreeting | null | undefined): RenderedGreeting | null {
  if (!g) return null;
  return 'tts' in g ? { text: g.tts } : { text: '', audioUrl: g.audio_url };
}

/**
 * Most specific first: the step's own greeting, the named person's, the
 * number's, the line owner's, the org's, the platform default.
 */
export async function voicemailGreeting(
  db: Db,
  input: { step: FlowGreeting | null; userId: string | null; flow: CallFlow | null; number: NumberRow; orgSettings: unknown },
): Promise<RenderedGreeting> {
  const direct = render(input.step);
  if (direct) return direct;
  const personal = async (id: string | null) => {
    if (!id) return null;
    const row = (await db.select({ g: schema.users.voicemailGreeting }).from(schema.users).where(eq(schema.users.id, id)).limit(1))[0];
    return render(row?.g as FlowGreeting | null);
  };
  return (
    (await personal(input.userId)) ??
    render(input.flow?.voicemail_greeting) ??
    (await personal(input.number.assignedUserId)) ?? {
      text: (input.orgSettings as { voicemailGreeting?: string } | null)?.voicemailGreeting ?? DEFAULT_GREETING,
    }
  );
}

/**
 * missed-call-text: the flow ended a call in voicemail or a hang-up. Texts the
 * caller from the number they called, once per cooldown, through the normal
 * send path — so suppression, quiet hours and merge fields all apply exactly
 * as they do to a rep's own text. A refusal there is final, not retried.
 */
export const missedCallText: JobHandler = async (deps, job) => {
  const { dbh, logger } = deps;
  const { callId } = job.payload as { callId: string };
  const call = (await dbh.db.select().from(schema.calls).where(eq(schema.calls.id, callId)).limit(1))[0];
  if (!call?.phoneNumberId) return;
  const raw = (call.raw ?? {}) as Record<string, unknown>;
  if (raw.missedCallTextAt || raw.missedCallTextSkipped) return;
  const number = (await dbh.db.select().from(schema.phoneNumbers).where(eq(schema.phoneNumbers.id, call.phoneNumberId)).limit(1))[0];
  const config = number && isCallFlow(number.ivr) ? number.ivr.missed_call_text : null;
  if (!number || !config?.enabled || number.status !== 'active') return;

  const mark = (patch: Record<string, unknown>) =>
    dbh.db.execute(sql`UPDATE calls SET raw = raw || ${JSON.stringify(patch)}::jsonb WHERE id = ${call.id}`);

  if (config.cooldown_hours > 0) {
    const since = new Date(Date.now() - config.cooldown_hours * 3600_000);
    const recent = await dbh.db.select({ id: schema.calls.id }).from(schema.calls).where(and(
      eq(schema.calls.phoneNumberId, number.id),
      eq(schema.calls.fromNumber, call.fromNumber),
      ne(schema.calls.id, call.id),
      gte(schema.calls.createdAt, since),
      sql`${schema.calls.raw} ? 'missedCallTextAt'`,
    )).limit(1);
    if (recent.length > 0) {
      await mark({ missedCallTextSkipped: 'cooldown' });
      return;
    }
  }

  // The text is "from" the line's owner, or an admin for an org line.
  const sender = (
    await dbh.db.select().from(schema.users).where(and(
      eq(schema.users.orgId, call.orgId),
      eq(schema.users.status, 'active'),
      number.assignedUserId ? eq(schema.users.id, number.assignedUserId) : inArray(schema.users.role, ['owner', 'admin']),
    )).limit(1)
  )[0];
  if (!sender) {
    await mark({ missedCallTextSkipped: 'no_sender' });
    return;
  }
  try {
    await sendMessage(
      dbh,
      { userId: sender.id, orgId: call.orgId, role: sender.role, email: sender.email, displayName: sender.displayName },
      { toNumber: call.fromNumber, body: config.body, fromPhoneNumberId: number.id },
    );
    await mark({ missedCallTextAt: new Date().toISOString() });
  } catch (err) {
    if (err instanceof MessageServiceError) {
      logger.info({ callId, code: err.code }, 'missed-call text not sent');
      await mark({ missedCallTextSkipped: err.code });
      return;
    }
    throw err;
  }
};
