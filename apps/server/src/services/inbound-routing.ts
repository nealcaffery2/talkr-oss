/**
 * Inbound routing: gather the facts, let the pure engine decide
 * (docs/inbound-routing.md). All queries here are single indexed lookups —
 * this runs on the TwiML fast path while the caller hears ringing.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import {
  decideInboundRoute,
  isCallFlow,
  pickQueueTargets,
  type BusinessHoursConfig,
  type IvrConfig,
  type PresenceInfo,
  type QueueConfig,
  type RoutingDecision,
} from '@talkr/core';
import { schema, type Db } from '@talkr/db';
import { loadLastTouches } from './last-contact.js';

export interface InboundContext {
  number: typeof schema.phoneNumbers.$inferSelect;
  org: typeof schema.organizations.$inferSelect;
  contact: typeof schema.contacts.$inferSelect | null;
  lead: typeof schema.leads.$inferSelect | null;
  queue: QueueConfig | null;
  ivr: IvrConfig | null;
  decision: RoutingDecision;
}

/** Load a queue with its members in the engine's shape. */
export async function loadQueueConfig(db: Db, queueId: string): Promise<QueueConfig | null> {
  const queue = (
    await db.select().from(schema.queues).where(eq(schema.queues.id, queueId)).limit(1)
  )[0];
  if (!queue) return null;
  const members = await db
    .select({ userId: schema.queueMembers.userId })
    .from(schema.queueMembers)
    .where(eq(schema.queueMembers.queueId, queue.id));
  return {
    id: queue.id,
    strategy: queue.strategy as QueueConfig['strategy'],
    memberUserIds: members.map((m) => m.userId),
    maxWaitSeconds: queue.maxWaitSeconds,
    waitMessage: queue.waitMessage,
    overflow: queue.overflow as QueueConfig['overflow'],
    overflowForwardE164: queue.overflowForwardE164,
  };
}

export async function loadPresenceMap(db: Db, userIds: string[]): Promise<Map<string, PresenceInfo>> {
  const presence = new Map<string, PresenceInfo>();
  if (userIds.length === 0) return presence;
  const rows = await db
    .select()
    .from(schema.agentPresence)
    .where(inArray(schema.agentPresence.userId, userIds));
  for (const row of rows) {
    presence.set(row.userId, {
      status: row.status as PresenceInfo['status'],
      lastSeenAt: row.lastSeenAt,
      lastRungAt: row.lastRungAt,
      lastCallEndedAt: row.lastCallEndedAt,
    });
  }
  return presence;
}

/**
 * Pick who the queue rings this cycle and stamp their last_rung_at so
 * round_robin rotates fairly across calls.
 */
export async function pickAndMarkQueueTargets(
  db: Db,
  queue: QueueConfig,
  now = new Date(),
): Promise<string[]> {
  const presence = await loadPresenceMap(db, queue.memberUserIds);
  const targets = pickQueueTargets(queue, presence, now);
  if (targets.length > 0) {
    await db
      .update(schema.agentPresence)
      .set({ lastRungAt: now })
      .where(inArray(schema.agentPresence.userId, targets));
  }
  return targets;
}

/** Stamp ring fairness for direct (non-queue) rings too. */
export async function markRung(db: Db, userIds: string[], now = new Date()): Promise<void> {
  if (userIds.length === 0) return;
  await db
    .update(schema.agentPresence)
    .set({ lastRungAt: now })
    .where(inArray(schema.agentPresence.userId, userIds));
}

/** Terminal calls feed longest_idle fairness. */
export async function markCallEnded(db: Db, userId: string, at: Date): Promise<void> {
  await db.execute(sql`
    UPDATE agent_presence SET last_call_ended_at = ${at} WHERE user_id = ${userId}`);
}

export async function resolveInboundContext(
  db: Db,
  toNumber: string,
  fromNumber: string,
  now = new Date(),
): Promise<InboundContext | null> {
  const number = (
    await db
      .select()
      .from(schema.phoneNumbers)
      .where(eq(schema.phoneNumbers.phoneE164, toNumber))
      .limit(1)
  )[0];
  if (!number) return null;

  const org = (
    await db
      .select()
      .from(schema.organizations)
      .where(eq(schema.organizations.id, number.orgId))
      .limit(1)
  )[0];
  if (!org) return null;

  // Caller recognition: phone → contact → most recent lead.
  let contact: typeof schema.contacts.$inferSelect | null = null;
  let lead: typeof schema.leads.$inferSelect | null = null;
  const phoneRow = (
    await db
      .select()
      .from(schema.contactPhones)
      .where(
        and(
          eq(schema.contactPhones.orgId, number.orgId),
          eq(schema.contactPhones.phoneE164, fromNumber),
        ),
      )
      .limit(1)
  )[0];
  if (phoneRow) {
    contact =
      (
        await db
          .select()
          .from(schema.contacts)
          .where(eq(schema.contacts.id, phoneRow.contactId))
          .limit(1)
      )[0] ?? null;
    if (contact) {
      lead =
        (
          await db
            .select()
            .from(schema.leads)
            .where(
              and(
                eq(schema.leads.orgId, number.orgId),
                eq(schema.leads.primaryContactId, contact.id),
              ),
            )
            .orderBy(desc(schema.leads.createdAt))
            .limit(1)
        )[0] ?? null;
    }
  }

  // Candidate users for the chain + their presence, in one pass.
  const teamMemberIds = number.assignedTeamId
    ? (
        await db
          .select({ userId: schema.teamMembers.userId })
          .from(schema.teamMembers)
          .where(eq(schema.teamMembers.teamId, number.assignedTeamId))
      ).map((r) => r.userId)
    : [];
  const queue = number.queueId ? await loadQueueConfig(db, number.queueId) : null;
  // Last-contact routing (docs/inbound-routing.md §10): only numbers that ask,
  // and not one whose own call flow decides instead.
  const lastTouches = number.routeCallbacksToLastContact && !isCallFlow(number.ivr)
    ? await loadLastTouches(db, number.orgId, fromNumber, { now })
    : [];
  const candidateIds = [
    ...new Set(
      [
        ...lastTouches.map((t) => t.userId),
        lead?.assignedUserId,
        number.assignedUserId,
        ...teamMemberIds,
        ...(queue?.memberUserIds ?? []),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
  const presence = await loadPresenceMap(db, candidateIds);

  const hours = (org.settings ?? {}) as BusinessHoursConfig;
  const decision = decideInboundRoute({
    now,
    hours,
    routeToLastContact: number.routeCallbacksToLastContact,
    lastTouches,
    leadOwnerUserId: lead?.assignedUserId ?? null,
    numberAssignedUserId: number.assignedUserId ?? null,
    teamMemberUserIds: teamMemberIds,
    queue,
    forwardToE164: number.forwardToE164 ?? null,
    presence,
  });

  // A v2 call flow is not the legacy digit menu; twiml-inbound runs it instead.
  const ivr = isCallFlow(number.ivr) ? null : ((number.ivr as IvrConfig | null) ?? null);
  return { number, org, contact, lead, queue, ivr, decision };
}

export function voicemailGreetingFor(org: typeof schema.organizations.$inferSelect): string {
  const settings = (org.settings ?? {}) as BusinessHoursConfig;
  return (
    settings.voicemailGreeting ??
    'Thank you for calling. We are unable to take your call right now. Please leave your name and number after the beep.'
  );
}
