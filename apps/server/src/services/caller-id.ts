/**
 * Caller-ID selection for outbound calls and texts.
 *
 * Order, first match wins:
 *   1. a campaign-configured number (Phase 5 dial sessions);
 *   2. an explicit per-call override the rep picked in the dialer;
 *   2b. a dial session with no pin rotates the rep's own voice lines: the
 *       destination's area code first, then the line with the fewest
 *       outbound calls in the last 7 days (core pickRotatedCallerId);
 *   3. local presence, when the rep has it on: an active org number whose
 *      area code matches the destination's, preferring the rep's own line;
 *   4. the rep's default number;
 *   5. the rep's assigned line, else any active org number.
 *
 * Only active numbers the org owns are ever returned; an override that is not
 * one of them is ignored rather than trusted (the route validates it up
 * front and answers 400, so reaching that branch here means a race). An AI
 * agent's line (label `AI · ...`, core isAiLine) is never one of them, pinned
 * or picked: voice on it rings the agent, so a lead calling back would reach
 * the agent instead of the rep.
 */

import { and, eq, gt, inArray, sql } from 'drizzle-orm';
import { isAiLine, pickRotatedCallerId } from '@talkr/core';
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
  /** A dialer session line: spread the rep's own lines instead of one default. */
  rotate?: boolean;
}

const ROTATION_WINDOW_DAYS = 7;

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
  const active = (await listActiveNumbers(db, ctx.orgId)).filter((n) => !isAiLine(n));
  if (active.length === 0) return undefined;
  const byId = new Map(active.map((n) => [n.id, n]));

  if (opts.campaignPhoneNumberId && byId.has(opts.campaignPhoneNumberId)) {
    return byId.get(opts.campaignPhoneNumberId);
  }
  if (opts.overridePhoneNumberId && byId.has(opts.overridePhoneNumberId)) {
    return byId.get(opts.overridePhoneNumberId);
  }

  if (opts.rotate) {
    const mine = active.filter((n) => n.assignedUserId === ctx.userId);
    if (mine.length > 0) {
      const since = new Date(Date.now() - ROTATION_WINDOW_DAYS * 86_400_000);
      const rows = await db
        .select({ from: schema.calls.fromNumber, n: sql<number>`count(*)::int` })
        .from(schema.calls)
        .where(
          and(
            eq(schema.calls.orgId, ctx.orgId),
            eq(schema.calls.direction, 'outbound'),
            gt(schema.calls.createdAt, since),
            inArray(schema.calls.fromNumber, mine.map((n) => n.phoneE164)),
          ),
        )
        .groupBy(schema.calls.fromNumber);
      const usage = new Map(rows.map((r) => [r.from, Number(r.n)]));
      const pick = pickRotatedCallerId(
        mine.map((n) => ({
          id: n.id,
          phoneE164: n.phoneE164,
          areaCode: n.areaCode,
          assignedUserId: n.assignedUserId,
          voice: (n.capabilities as { voice?: boolean }).voice !== false,
        })),
        { userId: ctx.userId, toNumber: opts.toNumber, usage },
      );
      if (pick) return byId.get(pick.id);
    }
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
