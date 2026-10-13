/**
 * Conference job handlers (docs/telephony-events.md §9).
 *
 * `conference-dial-customer` is the *fallback* for ringing the seller, not the
 * primary path: `/twiml/outbound-dial` dials inline so the phone rings within
 * a second, and enqueues this job so a provider hiccup on that attempt still
 * ends in a connected call. The dial itself lives in
 * services/conference-dial.ts, shared by both, and is idempotent — whichever
 * of the two gets there first is the one that rings the seller.
 */

import { eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { dialCustomerIntoConference } from '../services/conference-dial.js';
import type { JobHandler } from './handlers.js';

export const conferenceDialCustomer: JobHandler = async (deps, job) => {
  const { dbh, provider, config, logger } = deps;
  const { callId } = job.payload as { callId: string };

  const call = (
    await dbh.db.select().from(schema.calls).where(eq(schema.calls.id, callId)).limit(1)
  )[0];
  if (!call) {
    logger.warn({ callId }, 'conference-dial-customer for unknown call');
    return;
  }

  // A provider failure throws: the queue retries it with backoff, which is
  // the entire reason this job still exists alongside the inline dial.
  const outcome = await dialCustomerIntoConference({ dbh, provider, config, logger }, call);
  if (!outcome.dialed) {
    logger.info({ callId, reason: outcome.reason }, 'conference-dial-customer skipped');
  }
};
