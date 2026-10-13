/**
 * Last-contact routing, database side (docs/inbound-routing.md §10): who
 * reached out to a phone number lately, from Talkr's own outbound calls and
 * texts plus the outreach a partner posts (POST /v1/outreach). The pure
 * choice — most recent, inside the window, rep available — is
 * packages/core/src/routing.ts `pickLastContact`.
 */

import { and, eq, inArray, or, sql } from 'drizzle-orm';
import {
  LAST_CONTACT_DEFAULT_DAYS,
  normalizePhone,
  type LastContactDto,
  type LastTouch,
  type OutreachChannel,
  type TouchChannel,
} from '@talkr/core';
import { schema, type DbLike } from '@talkr/db';

/** Distinct reps is what matters; a handful of rows covers any real history. */
const TOUCH_LIMIT = 25;

/**
 * Outbound touches to `phoneE164` by active org members since `withinDays`
 * ago, newest first. One statement over three indexed lookups — this runs on
 * the inbound fast path while the caller hears ringing. Failed calls and
 * texts never reached the person and do not count.
 */
export async function loadLastTouches(
  db: DbLike,
  orgId: string,
  phoneE164: string,
  opts: { now?: Date; withinDays?: number } = {},
): Promise<LastTouch[]> {
  const now = opts.now ?? new Date();
  const since = new Date(now.getTime() - (opts.withinDays ?? LAST_CONTACT_DEFAULT_DAYS) * 86_400_000);
  const res = await db.execute(sql`
    SELECT t.user_id, t.channel, t.at, t.ref FROM (
      SELECT c.user_id, 'call'::text AS channel, COALESCE(c.initiated_at, c.created_at) AS at, c.id::text AS ref
        FROM calls c
       WHERE c.org_id = ${orgId} AND c.to_number = ${phoneE164} AND c.direction = 'outbound'
         AND c.user_id IS NOT NULL AND c.status <> 'failed' AND c.created_at >= ${since}
      UNION ALL
      SELECT m.created_by, 'sms', COALESCE(m.sent_at, m.created_at), m.id::text
        FROM conversations cv
        JOIN messages m ON m.conversation_id = cv.id
       WHERE cv.org_id = ${orgId} AND cv.their_number = ${phoneE164} AND m.direction = 'outbound'
         AND m.created_by IS NOT NULL AND m.is_auto_reply = false
         AND m.status NOT IN ('failed', 'undelivered') AND m.created_at >= ${since}
      UNION ALL
      SELECT o.user_id, o.channel, o.occurred_at, o.ref
        FROM outreach_events o
       WHERE o.org_id = ${orgId} AND o.phone_e164 = ${phoneE164} AND o.occurred_at >= ${since}
    ) t
    JOIN users u ON u.id = t.user_id AND u.org_id = ${orgId} AND u.status = 'active'
    ORDER BY t.at DESC
    LIMIT ${TOUCH_LIMIT}`);
  return (res.rows as Array<{ user_id: string; channel: string; at: Date | string; ref: string | null }>).map((r) => ({
    userId: r.user_id,
    channel: r.channel as TouchChannel,
    at: r.at instanceof Date ? r.at : new Date(r.at),
    ref: r.ref,
  }));
}

/**
 * The phone key outreach is stored and matched under: the same E.164 the
 * carrier hands the inbound route as `From` (US numbers in any common
 * spelling become +1XXXXXXXXXX). Null when it cannot be normalized.
 */
export function outreachPhoneKey(input: string): string | null {
  const n = normalizePhone(input);
  return n.ok && /^\+[1-9]\d{7,14}$/.test(n.e164) ? n.e164 : null;
}

/**
 * Partner user ids → Talkr user ids, scoped to one org. A partner (CLOZR)
 * knows its reps by its own auth uid, which Talkr holds in
 * partner_identities.subject once that rep has signed in through the partner
 * (or users.auth_user_id when both share one Supabase project). A Talkr
 * users.id is accepted as is. Only active members of `orgId` resolve.
 */
export async function resolveOrgUserIds(db: DbLike, orgId: string, ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const wanted = [...new Set(ids)];
  if (wanted.length === 0) return out;
  const uuidish = wanted.filter((id) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id));
  const active = and(eq(schema.users.orgId, orgId), eq(schema.users.status, 'active'));
  const direct = await db
    .select({ id: schema.users.id, auth: schema.users.authUserId })
    .from(schema.users)
    .where(and(active, or(uuidish.length > 0 ? inArray(schema.users.id, uuidish) : sql`false`, inArray(schema.users.authUserId, wanted))));
  for (const r of direct) {
    if (wanted.includes(r.id)) out.set(r.id, r.id);
    if (r.auth && wanted.includes(r.auth) && !out.has(r.auth)) out.set(r.auth, r.id);
  }
  const rest = wanted.filter((id) => !out.has(id));
  if (rest.length > 0) {
    const linked = await db
      .select({ subject: schema.partnerIdentities.subject, id: schema.users.id })
      .from(schema.partnerIdentities)
      .innerJoin(schema.users, eq(schema.users.id, schema.partnerIdentities.userId))
      .where(and(active, inArray(schema.partnerIdentities.subject, rest)));
    for (const r of linked) if (!out.has(r.subject)) out.set(r.subject, r.id);
  }
  return out;
}

export interface OutreachInput {
  phone_e164: string;
  user_id?: string;
  channel: OutreachChannel;
  occurred_at: string;
  ref?: string | null;
}

export type OutreachResult =
  | { index: number; status: 'created' | 'duplicate'; id: string; ref: string | null }
  | { index: number; status: 'rejected'; error: 'invalid_phone' | 'unknown_user' | 'forbidden_user'; message: string; ref: string | null };

/**
 * Record a batch of outreach for `orgId`. Each item is judged on its own (one
 * bad row does not sink a blast). `ref` is idempotent per org: a repeat
 * returns the original row as `duplicate` and changes nothing.
 * `mayActForOthers` false limits items to the caller's own touches.
 */
export async function recordOutreach(
  db: DbLike,
  ctx: { orgId: string; userId: string; mayActForOthers: boolean },
  items: OutreachInput[],
): Promise<OutreachResult[]> {
  const userIds = await resolveOrgUserIds(db, ctx.orgId, items.map((i) => i.user_id).filter((u): u is string => Boolean(u)));
  const results: OutreachResult[] = new Array(items.length);
  type Row = typeof schema.outreachEvents.$inferInsert;
  const rows: Array<{ index: number; row: Row }> = [];
  const seenRefs = new Map<string, number>();
  const sameBatch: Array<{ index: number; ref: string }> = [];
  for (const [index, item] of items.entries()) {
    const ref = item.ref ?? null;
    const phone = outreachPhoneKey(item.phone_e164);
    if (!phone) {
      results[index] = { index, status: 'rejected', error: 'invalid_phone', message: `${item.phone_e164} is not a phone number Talkr can match a caller against`, ref };
      continue;
    }
    const userId = item.user_id ? userIds.get(item.user_id) : ctx.userId;
    if (!userId) {
      results[index] = { index, status: 'rejected', error: 'unknown_user', message: `user ${item.user_id} is not an active member of this workspace (or has not signed in to Talkr yet)`, ref };
      continue;
    }
    if (userId !== ctx.userId && !ctx.mayActForOthers) {
      results[index] = { index, status: 'rejected', error: 'forbidden_user', message: 'only a manager or admin may record outreach for someone else', ref };
      continue;
    }
    // The same ref twice in one batch: the first is the write, the rest repeat it.
    if (ref !== null && seenRefs.has(ref)) {
      sameBatch.push({ index, ref });
      continue;
    }
    if (ref !== null) seenRefs.set(ref, index);
    rows.push({ index, row: { orgId: ctx.orgId, userId, phoneE164: phone, channel: item.channel, occurredAt: new Date(item.occurred_at), ref, createdBy: ctx.userId } });
  }

  // One statement for the whole batch; rows whose ref already exists are skipped.
  const inserted = rows.length > 0
    ? await db
        .insert(schema.outreachEvents)
        .values(rows.map((r) => r.row))
        .onConflictDoNothing({ target: [schema.outreachEvents.orgId, schema.outreachEvents.ref] })
        .returning({ id: schema.outreachEvents.id, ref: schema.outreachEvents.ref })
    : [];
  // RETURNING order is not guaranteed; refless rows come back in insert order.
  const byRef = new Map(inserted.filter((r) => r.ref !== null).map((r) => [r.ref!, r.id]));
  const refless = inserted.filter((r) => r.ref === null);
  const missingRefs = rows.map((r) => r.row.ref).filter((ref): ref is string => ref != null && !byRef.has(ref));
  const existing = new Map<string, string>();
  if (missingRefs.length > 0 || sameBatch.length > 0) {
    const look = [...new Set([...missingRefs, ...sameBatch.map((s) => s.ref)])];
    const found = await db
      .select({ id: schema.outreachEvents.id, ref: schema.outreachEvents.ref })
      .from(schema.outreachEvents)
      .where(and(eq(schema.outreachEvents.orgId, ctx.orgId), inArray(schema.outreachEvents.ref, look)));
    for (const f of found) existing.set(f.ref!, f.id);
  }
  let nextRefless = 0;
  for (const { index, row } of rows) {
    const ref = row.ref ?? null;
    if (ref === null) {
      results[index] = { index, status: 'created', id: refless[nextRefless++]!.id, ref };
    } else if (byRef.has(ref)) {
      results[index] = { index, status: 'created', id: byRef.get(ref)!, ref };
    } else {
      results[index] = { index, status: 'duplicate', id: existing.get(ref)!, ref };
    }
  }
  for (const { index, ref } of sameBatch) {
    results[index] = { index, status: 'duplicate', id: byRef.get(ref) ?? existing.get(ref)!, ref };
  }
  return results;
}

/**
 * Why an inbound call rang who it rang, for the call DTOs: the default
 * chain's reason (or `last_contact` when a flow's last_contact ring took it),
 * plus the touch behind a last-contact ring — what lets a client say
 * "calling back about your voicemail drop from Mar 3".
 */
export function callRoutingOf(raw: unknown): { reason: string | null; last_contact: LastContactDto | null } | null {
  const r = (raw ?? {}) as { routing?: { reason?: string }; routedVia?: string; lastContact?: LastContactDto };
  if (!r.routing && !r.routedVia) return null;
  return {
    reason: r.routedVia ?? r.routing?.reason ?? null,
    last_contact: r.lastContact ?? null,
  };
}
