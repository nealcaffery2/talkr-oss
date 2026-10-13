/**
 * The rep's browser leg on an outbound call, when the server has to open it.
 *
 * A Telnyx WebRTC endpoint cannot dial our call-control URL itself: it dials
 * numbers and SIP URIs, not our TeXML application. So for a provider whose
 * `browserLeg` is `server`, the server REST-dials the rep's SIP address with
 * the call's conference TeXML inline on the dial: when the browser answers,
 * Telnyx puts that leg straight into the call's room. The answer URL
 * (`/twiml/outbound-dial?talkr_call_id=…`) rides along as the fallback for a
 * carrier that insists on fetching one.
 *
 * The seller is not dialed here. Telnyx addresses a room by an id that only
 * exists once the first leg has joined it, so the conference-status
 * participant-join callback rings the seller (services/conference-dial.ts,
 * `dialCustomerOnAgentJoin`); the queued `conference-dial-customer` job is the
 * safety net behind it.
 *
 * The provider id is bound here when the carrier returns one, otherwise by the
 * first webhook (`CallSid`) — the answer URL carries the call id either way.
 */

import { and, eq } from 'drizzle-orm';
import {
  conferenceRoomName,
  holdMusicWaitUrl,
  readHoldMusic,
  type VoiceProvider,
} from '@talkr/core';
import { enqueueJob, schema, type DbHandle } from '@talkr/db';
import type { AuthContext } from '../auth.js';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';
import { CallServiceError } from './calls.js';
import { clientAddressFor } from './client-address.js';
import { CONFERENCE_DIAL_FALLBACK_DELAY_MS } from './conference-dial.js';

export type BrowserLegResult = {
  /** Which side opens the media leg; the client keys its softphone on this. */
  mode: 'client' | 'server';
  /** The provider's id for the rep leg when the carrier returned one at dial time. */
  providerCallId: string | null;
};

export async function ringBrowserForCall(
  dbh: DbHandle,
  provider: VoiceProvider,
  publicBaseUrl: string,
  ctx: AuthContext,
  callId: string,
  opts?: { config?: Config; logger?: Logger },
): Promise<BrowserLegResult> {
  const mode = provider.browserLeg ?? 'client';
  if (mode !== 'server') {
    throw new CallServiceError('browser_leg_is_client', `${provider.name} browsers open their own leg; connect with the SDK instead`);
  }
  const call = (
    await dbh.db
      .select()
      .from(schema.calls)
      .where(and(eq(schema.calls.id, callId), eq(schema.calls.orgId, ctx.orgId)))
      .limit(1)
  )[0];
  if (!call) throw new CallServiceError('not_found', 'call not found');
  // Only the rep the call belongs to may have their browser rung for it.
  if (call.userId !== ctx.userId) throw new CallServiceError('forbidden', 'not your call');
  if (call.direction !== 'outbound') throw new CallServiceError('call_not_active', 'only outbound calls have a browser leg to open');
  if (call.status !== 'queued' && call.status !== 'initiated') {
    throw new CallServiceError('call_not_active', `call is ${call.status}`);
  }
  if (call.providerCallId) throw new CallServiceError('already_bound', 'this call already has a browser leg');

  // Throws when the rep has never minted a credential — the softphone mints
  // one on enable, so this only fires for a browser that skipped that step.
  const address = await clientAddressFor(dbh, provider, ctx.userId);
  const q = `talkr_call_id=${encodeURIComponent(call.id)}`;
  const answerUrl = `${publicBaseUrl}/twiml/outbound-dial?${q}`;

  // Conference mode: the leg joins the call's room the moment it is answered,
  // with no round trip to us in between.
  let answerTexml: string | undefined;
  if (opts?.config?.CALL_CONTROL_MODE === 'conference') {
    const org = (
      await dbh.db
        .select({ settings: schema.organizations.settings })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, call.orgId))
        .limit(1)
    )[0];
    answerTexml = provider.buildConferenceResponse({
      roomName: conferenceRoomName(call.id),
      startConferenceOnEnter: true,
      endConferenceOnExit: true,
      statusCallbackUrl: `${publicBaseUrl}/webhooks/telnyx/conference-status`,
      record: true,
      recordingStatusCallbackUrl: `${publicBaseUrl}/webhooks/telnyx/recording-status?call=${encodeURIComponent(call.id)}`,
      waitUrl: holdMusicWaitUrl(readHoldMusic(org?.settings)),
    }).body;
  }

  const dial = await provider.createCall({
    from: call.fromNumber,
    to: address,
    answerUrl,
    answerUrlMethod: 'POST',
    answerTexml,
    statusCallbackUrl: `${publicBaseUrl}/webhooks/telnyx/voice-status?call=${encodeURIComponent(call.id)}&leg=client`,
    timeoutSeconds: 30,
  });
  const providerCallId = dial.providerCallId || null;
  await dbh.db
    .update(schema.calls)
    .set({
      status: 'initiated',
      ...(providerCallId ? { providerCallId } : {}),
    })
    .where(and(eq(schema.calls.id, call.id), eq(schema.calls.status, call.status)));

  // The seller is rung by the participant-join callback once this leg is in
  // the room. This job only recovers a callback that never arrives or a dial
  // the carrier refused: it is dedupe-keyed and the dial itself is
  // claim-gated, so the two paths can never both ring the customer.
  if (answerTexml) {
    await enqueueJob(dbh.db, {
      jobType: 'conference-dial-customer',
      payload: { callId: call.id },
      dedupeKey: `conference-dial:${call.id}`,
      correlationId: call.correlationId,
      runAt: new Date(Date.now() + CONFERENCE_DIAL_FALLBACK_DELAY_MS),
    });
  }

  return { mode, providerCallId };
}
