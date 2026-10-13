/**
 * Ringing the customer into a call's conference room
 * (docs/telephony-events.md §9.1).
 *
 * This is the one place that dials the far end, called from two:
 *
 *   1. inline on `POST /twiml/outbound-dial`, so the seller's phone starts
 *      ringing while the rep's browser leg is still connecting; and
 *   2. from the queued `conference-dial-customer` job, which recovers the
 *      call if that inline attempt failed.
 *
 * Why inline at all, when §1 says call-control paths make no provider REST
 * calls? Because the alternative was worse. The queue is drained by a cron
 * tick — once a minute on the serverless deployment (apps/server/vercel.json)
 * — so "one hop later" meant the rep sat listening to hold music for up to a
 * minute before the seller's phone even rang. The participant-add is a single
 * few-hundred-millisecond REST call against a ~15s TwiML budget, and it is
 * non-fatal: the caller logs a failure and still returns TwiML, so a provider
 * hiccup costs a fallback hop instead of a dead call.
 *
 * Exactly-once is the interesting part, because there are now two racers. The
 * customer-participant row cannot be the guard on its own — it only exists
 * *after* the provider call returns, so two attempts that start together
 * would both see an empty roster and both ring the seller. So the dial is
 * claimed first, with the journal-insert gate that cancel-sibling-dials
 * already uses: `call_events.dedupe_token` is uniquely indexed per call, so
 * exactly one attempt wins the insert and the loser stands down. A claim is
 * released only when the provider call itself failed, which is precisely the
 * case where the fallback must be free to try again.
 */

import { and, eq, isNull } from 'drizzle-orm';
import {
  callIdFromRoomName,
  customerParticipantParams,
  conferenceRoomName,
  shouldDialCustomer,
  type VoiceProvider,
} from '@talkr/core';
import { schema, type DbHandle } from '@talkr/db';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { clientAddressFor } from './client-address.js';

/**
 * How long after the inline attempt the fallback job becomes due. The inline
 * dial has finished long before this; the delay only stops a long-running
 * worker from racing it for no reason. On the serverless deployment the cron
 * tick is the real lower bound anyway.
 */
export const CONFERENCE_DIAL_FALLBACK_DELAY_MS = 5_000;

/** The journal entry that claims the dial. One per call, ever. */
const CLAIM_EVENT_TYPE = 'call.customer_dial_claimed';

/** Unique per call via the `call_events_dedupe_uq` partial index. */
export function customerDialClaimToken(callId: string): string {
  return `${callId}:conference-dial:x`;
}

export type CustomerDialOutcome =
  | { dialed: true; providerParticipantId: string }
  /** The rep hung up, or the call failed, before the dial happened. */
  | { dialed: false; reason: 'call_over' }
  /** The customer is already in the room — a retry of work already done. */
  | { dialed: false; reason: 'already_present' }
  /** The other path holds the claim: it is dialing now, or already did. */
  | { dialed: false; reason: 'claimed_elsewhere' };

export interface CustomerDialDeps {
  dbh: DbHandle;
  provider: VoiceProvider;
  config: Config;
  logger: Logger;
}

type CallRow = typeof schema.calls.$inferSelect;

/**
 * Dial the far end into the room the rep's browser just joined.
 *
 * Idempotent: safe to call from both paths, in either order, concurrently.
 * Throws only when the *provider* refused the dial — the caller decides
 * whether that is fatal (the job retries; the TwiML route does not).
 */
export async function dialCustomerIntoConference(
  deps: CustomerDialDeps,
  call: CallRow,
): Promise<CustomerDialOutcome> {
  const { dbh, provider, config, logger } = deps;

  if (!shouldDialCustomer({ status: call.status, endedAt: call.endedAt })) {
    return { dialed: false, reason: 'call_over' };
  }

  // Cheap short-circuit for the common fallback case: the inline dial already
  // ran a moment ago and the roster proves it.
  const existing = (
    await dbh.db
      .select({ id: schema.callParticipants.id })
      .from(schema.callParticipants)
      .where(
        and(
          eq(schema.callParticipants.callId, call.id),
          eq(schema.callParticipants.role, 'customer'),
        ),
      )
      .limit(1)
  )[0];
  if (existing) return { dialed: false, reason: 'already_present' };

  if (!(await claimDial(dbh, call))) return { dialed: false, reason: 'claimed_elsewhere' };

  const room = conferenceRoomName(call.id);
  let added;
  try {
    added = await provider.addParticipant(
      customerParticipantParams({
        callId: call.id,
        fromNumber: call.fromNumber,
        toNumber: call.toNumber,
        publicBaseUrl: config.PUBLIC_BASE_URL,
      }),
    );
  } catch (err) {
    // The seller was never rung, so the claim is worthless — hand it back so
    // the fallback job (or its retry) can try again.
    await releaseDial(dbh, call).catch(() => undefined);
    throw err;
  }

  // Past this point the seller's phone is ringing. A failure here loses a
  // roster row, not the call: the conference participant-join callback
  // reconciles it, exactly as it does for parties we never inserted.
  await dbh.db
    .insert(schema.callParticipants)
    .values({
      orgId: call.orgId,
      callId: call.id,
      roomName: room,
      providerParticipantId: added.providerParticipantId,
      role: 'customer',
      state: 'ringing',
      address: call.toNumber,
      label: call.toNumber,
      raw: added.raw,
    })
    .onConflictDoNothing({ target: schema.callParticipants.providerParticipantId });

  logger.info(
    { callId: call.id, participant: added.providerParticipantId },
    'customer dialed into conference',
  );
  return { dialed: true, providerParticipantId: added.providerParticipantId };
}

/** Win the right to dial, or discover somebody else already has it. */
async function claimDial(dbh: DbHandle, call: CallRow): Promise<boolean> {
  const claimed = await dbh.db
    .insert(schema.callEvents)
    .values({
      orgId: call.orgId,
      callId: call.id,
      eventType: CLAIM_EVENT_TYPE,
      occurredAt: new Date(),
      source: 'system',
      dedupeToken: customerDialClaimToken(call.id),
      payload: { to: call.toNumber },
    })
    .onConflictDoNothing()
    .returning({ id: schema.callEvents.id });
  return claimed.length > 0;
}

/** Give the claim back after a dial that never reached the carrier. */
async function releaseDial(dbh: DbHandle, call: CallRow): Promise<void> {
  await dbh.db
    .delete(schema.callEvents)
    .where(
      and(
        eq(schema.callEvents.callId, call.id),
        eq(schema.callEvents.dedupeToken, customerDialClaimToken(call.id)),
      ),
    );
}

/** Why the participant-join hook stood down, beyond what the dial itself reports. */
export type AgentJoinDialOutcome =
  | CustomerDialOutcome
  | { dialed: false; reason: 'not_a_room_of_ours' | 'not_outbound' | 'not_the_agent' | 'bridge_mode' };

/**
 * The conference-status `participant-join` hook.
 *
 * On Telnyx the browser leg joins the room from TeXML shipped inline on the
 * dial, so nothing of ours runs between the rep answering and the room
 * existing — except this callback. It is also the first moment the room has
 * an id, which is the only thing Telnyx's participant REST accepts. When the
 * joiner is the rep on an outbound call, bind the leg, record the agent, and
 * ring the seller. The claim inside `dialCustomerIntoConference` makes a
 * second attempt a no-op. Throws only when the provider refused the dial — the
 * queued fallback retries then.
 */
export async function dialCustomerOnAgentJoin(
  deps: CustomerDialDeps,
  params: Record<string, string>,
): Promise<AgentJoinDialOutcome> {
  const { dbh, provider, config } = deps;
  if (config.CALL_CONTROL_MODE !== 'conference') return { dialed: false, reason: 'bridge_mode' };
  const friendlyName = params.FriendlyName ?? '';
  const callId = callIdFromRoomName(friendlyName);
  if (!callId) return { dialed: false, reason: 'not_a_room_of_ours' };
  const call = (
    await dbh.db.select().from(schema.calls).where(eq(schema.calls.id, callId)).limit(1)
  )[0];
  if (!call) return { dialed: false, reason: 'not_a_room_of_ours' };

  // Whatever else happens, the provider now knows this room's id.
  if (params.ConferenceSid) provider.rememberConferenceSid?.(friendlyName, params.ConferenceSid);
  if (call.direction !== 'outbound') return { dialed: false, reason: 'not_outbound' };

  const legSid = params.CallSid;
  if (!legSid) return { dialed: false, reason: 'not_the_agent' };
  // The seller's leg carries the seller's number; the rep's carries a SIP address.
  if (params.To && sameNumber(params.To, call.toNumber)) return { dialed: false, reason: 'not_the_agent' };
  if (call.providerCallId && call.providerCallId !== legSid) return { dialed: false, reason: 'not_the_agent' };

  if (!call.providerCallId) {
    // The carrier returned no id at dial time. On an outbound call the first
    // leg into the room is the rep's — the same adoption outbound-dial does.
    await dbh.db
      .update(schema.calls)
      .set({ providerCallId: legSid })
      .where(and(eq(schema.calls.id, call.id), isNull(schema.calls.providerCallId)));
  }
  await dbh.db
    .insert(schema.callParticipants)
    .values({
      orgId: call.orgId,
      callId: call.id,
      roomName: conferenceRoomName(call.id),
      providerConferenceId: params.ConferenceSid ?? null,
      providerParticipantId: legSid,
      role: 'agent',
      state: 'joined',
      joinedAt: new Date(),
      userId: call.userId,
      address: call.userId ? await clientAddressFor(dbh, provider, call.userId).catch(() => '') : '',
      label: 'You',
    })
    .onConflictDoNothing({ target: schema.callParticipants.providerParticipantId });

  return dialCustomerIntoConference(deps, { ...call, providerCallId: call.providerCallId ?? legSid });
}

/** Same national number, however either side formatted it. */
function sameNumber(a: string, b: string): boolean {
  const tail = (s: string) => s.replace(/\D/g, '').slice(-10);
  const x = tail(a);
  return x.length >= 7 && x === tail(b);
}
