/**
 * No-answer overflow to an AI agent (docs/inbound-routing.md §11).
 *
 * When a rep's line does not pick up and the number names an overflow line,
 * the caller is dialled on to it instead of voicemail. Before that dial goes
 * out, every active webhook subscription in the org that listens for missed
 * calls is told synchronously (`call.overflow`, signed like any delivery), so
 * the system behind the overflow line (CLOZR's voice agent) knows whose call
 * it is picking up by the time the agent's own webhook fires. Best effort:
 * a slow or failing subscriber never holds the caller.
 */
import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import type { DbHandle } from '@talkr/db';
import { schema } from '@talkr/db';
import { signWebhookBody } from '../worker/webhook-fanout.js';

export const OVERFLOW_EVENT = 'call.overflow';
export const OVERFLOW_NOTICE_TIMEOUT_MS = 2500;
/** The overflow leg rings a little longer than a rep: an AI line always answers, a dead one should not hold the caller. */
export const OVERFLOW_DIAL_TIMEOUT_SECONDS = 30;

export type OverflowRep = { id: string; displayName: string; partnerSubject: string | null };

export type OverflowNotice = {
  id: string;
  type: typeof OVERFLOW_EVENT;
  occurredAt: string;
  data: {
    call_id: string;
    /** The caller. */
    from: string;
    /** The line they dialled: the rep's. */
    to: string;
    overflow_to: string;
    reason: string;
    /** The rep this line rang (Talkr user), when one did. */
    user_id: string | null;
    user_name: string | null;
    /** That rep's id in the partner system (partner_identities.subject), when linked. */
    partner_subject: string | null;
  };
};

export function buildOverflowNotice(
  call: { id: string; fromNumber: string; toNumber: string },
  overflowTo: string,
  reason: string,
  rep: OverflowRep | null,
  now: Date = new Date(),
): OverflowNotice {
  return {
    id: randomUUID(),
    type: OVERFLOW_EVENT,
    occurredAt: now.toISOString(),
    data: {
      call_id: call.id,
      from: call.fromNumber,
      to: call.toNumber,
      overflow_to: overflowTo,
      reason,
      user_id: rep?.id ?? null,
      user_name: rep?.displayName ?? null,
      partner_subject: rep?.partnerSubject ?? null,
    },
  };
}

/** A subscription that hears about missed calls hears about overflow too; nobody has to subscribe to a new type. */
export function wantsOverflowNotice(sub: { active: boolean; eventTypes: unknown }): boolean {
  if (!sub.active || !Array.isArray(sub.eventTypes)) return false;
  return sub.eventTypes.includes('call.no_answer') || sub.eventTypes.includes(OVERFLOW_EVENT);
}

/** The rep whose line this call rang: the call's user, else the one user the routing decision picked. */
export function rungUserId(call: { userId: string | null; raw: unknown }): string | null {
  if (call.userId) return call.userId;
  const routing = (call.raw as { routing?: { action?: string; userIds?: unknown } } | null)?.routing;
  const ids = routing?.action === 'ring_users' && Array.isArray(routing.userIds) ? routing.userIds : [];
  return ids.length === 1 && typeof ids[0] === 'string' ? ids[0] : null;
}

export async function loadOverflowRep(db: DbHandle['db'], call: { userId: string | null; raw: unknown }): Promise<OverflowRep | null> {
  const id = rungUserId(call);
  if (!id) return null;
  const [user] = await db.select({ id: schema.users.id, displayName: schema.users.displayName }).from(schema.users).where(eq(schema.users.id, id)).limit(1);
  if (!user) return null;
  const [identity] = await db.select({ subject: schema.partnerIdentities.subject }).from(schema.partnerIdentities)
    .where(eq(schema.partnerIdentities.userId, id)).limit(1);
  return { id: user.id, displayName: user.displayName, partnerSubject: identity?.subject ?? null };
}

/** POST the notice to every subscriber that wants it, waiting at most `timeoutMs` for each. Failures are logged, never thrown. */
export async function notifyOverflow(
  deps: { db: DbHandle['db']; logger: { warn(obj: unknown, msg: string): void }; timeoutMs?: number },
  orgId: string,
  notice: OverflowNotice,
): Promise<number> {
  const subs = await deps.db.select().from(schema.webhookSubscriptions)
    .where(and(eq(schema.webhookSubscriptions.orgId, orgId), eq(schema.webhookSubscriptions.active, true)));
  const wanted = subs.filter(wantsOverflowNotice);
  if (!wanted.length) return 0;
  const body = JSON.stringify(notice);
  const timestamp = Math.floor(Date.now() / 1000);
  let delivered = 0;
  await Promise.all(wanted.map(async (sub) => {
    try {
      const res = await fetch(sub.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-talkr-event': notice.type,
          'x-talkr-delivery': notice.id,
          'x-talkr-signature': signWebhookBody(sub.signingSecret, timestamp, body),
        },
        body,
        signal: AbortSignal.timeout(deps.timeoutMs ?? OVERFLOW_NOTICE_TIMEOUT_MS),
      });
      await res.arrayBuffer().catch(() => undefined);
      if (res.ok) delivered++;
      else deps.logger.warn({ subscriptionId: sub.id, status: res.status, callId: notice.data.call_id }, 'overflow notice refused');
    } catch (err) {
      deps.logger.warn({ subscriptionId: sub.id, callId: notice.data.call_id, err: (err as Error).message }, 'overflow notice failed');
    }
  }));
  return delivered;
}
