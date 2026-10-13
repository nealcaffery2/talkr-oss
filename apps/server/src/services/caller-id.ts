/**
 * Caller-ID selection for outbound calls and texts.
 *
 * Order, first match wins:
 *   1. a campaign-configured number (Phase 5 dial sessions);
 *   2. an explicit per-call override the rep picked in the dialer;
 *   3. local presence, when the rep has it on: an active org number whose
 *      area code matches the destination's, preferring the rep's own line;
 *   4. the rep's default number;
 *   5. the rep's assigned line, else any active org number.
 *
 * Only active numbers the org owns are ever returned; an override that is not
 * one of them is ignored rather than trusted (the route validates it up
 * front and answers 400, so reaching that branch here means a race).
 */

import { and, eq } from 'drizzle-orm';
import { schema, type DbHandle, type DbTx } from '@talkr/db';
import type { AuthContext } from '../auth.js';

type Db = DbHandle['db'] | DbTx;
type PhoneNumberRow = typeof schema.phoneNumbers.$inferSelect;
type UserRow = typeof schema.users.$inferSelect;

export const CALLER_ID_MODES = ['dedicated', 'local_presence'] as const;
export type CallerIdMode = (typeof CALLER_ID_MODES)[number];

export interface ChooseCallerIdOptions {
  /** E.164 destination; drives local presence. */
  toNumber?: string | null;
  /** Per-call pick from the dialer. */
  overridePhoneNumberId?: string | null;
  /** Campaign-level caller ID (dial sessions). */
  campaignPhoneNumberId?: string | null;
  /** Caller's users row when the caller already loaded it. */
  user?: UserRow | null;
}

/** NANP area code of an E.164 number, or null outside +1. */
export function areaCodeOf(e164: string): string | null {
  const m = /^\+1(\d{3})\d{7}$/.exec(e164.trim());
  return m ? m[1]! : null;
}

export async function listActiveNumbers(db: Db, orgId: string): Promise<PhoneNumberRow[]> {
  return db
    .select()
    .from(schema.phoneNumbers)
    .where(and(eq(schema.phoneNumbers.orgId, orgId), eq(schema.phoneNumbers.status, 'active')))
    .orderBy(schema.phoneNumbers.phoneE164);
}

export async function chooseCallerId(
  db: Db,
  ctx: AuthContext,
  opts: ChooseCallerIdOptions = {},
): Promise<PhoneNumberRow | undefined> {
  const active = await listActiveNumbers(db, ctx.orgId);
  if (active.length === 0) return undefined;
  const byId = new Map(active.map((n) => [n.id, n]));

  if (opts.campaignPhoneNumberId && byId.has(opts.campaignPhoneNumberId)) {
    return byId.get(opts.campaignPhoneNumberId);
  }
  if (opts.overridePhoneNumberId && byId.has(opts.overridePhoneNumberId)) {
    return byId.get(opts.overridePhoneNumberId);
  }

  const user =
    opts.user ??
    (await db.select().from(schema.users).where(eq(schema.users.id, ctx.userId)).limit(1))[0] ??
    null;

  const mine = (n: PhoneNumberRow) => n.assignedUserId === ctx.userId;
  const unassigned = (n: PhoneNumberRow) => n.assignedUserId == null;
  const prefer = (list: PhoneNumberRow[]) => list.find(mine) ?? list.find(unassigned) ?? list[0];

  const dest = opts.toNumber ? areaCodeOf(opts.toNumber) : null;
  if (user?.callerIdMode === 'local_presence' && dest) {
    // area_code is stored on purchase; older rows may lack it, so derive.
    const local = active.filter((n) => (n.areaCode ?? areaCodeOf(n.phoneE164)) === dest);
    if (local.length > 0) return prefer(local);
  }

  if (user?.defaultPhoneNumberId && byId.has(user.defaultPhoneNumberId)) {
    return byId.get(user.defaultPhoneNumberId);
  }
  return prefer(active);
}
