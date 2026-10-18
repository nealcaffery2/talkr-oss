/**
 * Whose call a call is, for the "own" read scope.
 *
 * A call is the rep's who handled it (`calls.user_id`). One nobody picked up
 * (a missed call, a voicemail) has no handler, so it belongs to whoever the
 * voicemail was for (`raw.voicemailFor`, set by the inbound flow) or, failing
 * that, to the owner of the line on our side of it. Without that second half a
 * rep never saw the voicemails left on their own number: only an admin's
 * org-wide read returned them. CLOZR's inbox applies the same rule
 * (lib/inbox-owner.ts callOwner).
 */

import { and, eq, sql, type SQL } from 'drizzle-orm';
import { schema, type Db } from '@talkr/db';

type CallRow = typeof schema.calls.$inferSelect;

/**
 * SQL predicate over a `calls` row: the call is `userId`'s. `alias` names the
 * row in the query (`c` in the history SQL, `calls` in a drizzle select).
 */
export function callOwnedBySql(userId: string, alias: 'c' | 'calls' = 'c'): SQL {
  const c = sql.raw(alias);
  return sql`(${c}.user_id = ${userId}::uuid OR (${c}.user_id IS NULL AND (
    ${c}.raw->>'voicemailFor' = ${userId}::text
    OR (${c}.raw->>'voicemailFor' IS NULL AND EXISTS (
      SELECT 1 FROM phone_numbers pn
      WHERE pn.org_id = ${c}.org_id
        AND pn.assigned_user_id = ${userId}::uuid
        AND pn.phone_e164 = CASE WHEN ${c}.direction::text = 'inbound' THEN ${c}.to_number ELSE ${c}.from_number END
    ))
  )))`;
}

/** The same rule for one loaded row. */
export async function ownsCall(db: Db, call: CallRow, userId: string): Promise<boolean> {
  if (call.userId) return call.userId === userId;
  const raw = (call.raw ?? {}) as { voicemailFor?: unknown };
  if (typeof raw.voicemailFor === 'string') return raw.voicemailFor === userId;
  const ours = call.direction === 'inbound' ? call.toNumber : call.fromNumber;
  const line = await db
    .select({ id: schema.phoneNumbers.id })
    .from(schema.phoneNumbers)
    .where(
      and(
        eq(schema.phoneNumbers.orgId, call.orgId),
        eq(schema.phoneNumbers.phoneE164, ours),
        eq(schema.phoneNumbers.assignedUserId, userId),
      ),
    )
    .limit(1);
  return line.length > 0;
}
