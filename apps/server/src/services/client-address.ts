/**
 * How a rep's browser is addressed in a dial, and how an answering leg is
 * traced back to the rep.
 *
 * Telnyx generates the SIP username, so the address is not the user id: the
 * wire carries `sip:gencred…@sip.telnyx.com` and only a stored row maps it
 * back. Everything that needs either direction goes through here rather than
 * concatenating a prefix at the call site.
 */

import { and, eq, inArray } from 'drizzle-orm';
import { schema, type DbHandle } from '@talkr/db';
import type { ClientTarget, VoiceProvider } from '@talkr/core';
import type { TelnyxCredentialStore } from '@talkr/provider-telnyx';

/**
 * A store over `telephony_credentials` for the Telnyx adapter, so the adapter
 * never learns about the database and the mapping still survives a cold start.
 */
export function credentialStore(dbh: DbHandle, orgIdFor: (userId: string) => Promise<string | null>): TelnyxCredentialStore {
  return {
    async get(userId) {
      const row = (
        await dbh.db
          .select()
          .from(schema.telephonyCredentials)
          .where(
            and(
              eq(schema.telephonyCredentials.userId, userId),
              eq(schema.telephonyCredentials.provider, 'telnyx'),
            ),
          )
          .limit(1)
      )[0];
      return row
        ? { credentialId: row.providerCredentialId, sipUsername: row.sipUsername }
        : null;
    },
    async put(userId, cred) {
      const orgId = await orgIdFor(userId);
      if (!orgId) throw new Error(`cannot store a credential for unknown user ${userId}`);
      await dbh.db
        .insert(schema.telephonyCredentials)
        .values({
          orgId,
          userId,
          provider: 'telnyx',
          providerCredentialId: cred.credentialId,
          sipUsername: cred.sipUsername,
        })
        // A concurrent mint for the same rep is a race, not an error; last
        // write wins and both point at a working credential.
        .onConflictDoUpdate({
          target: [schema.telephonyCredentials.userId, schema.telephonyCredentials.provider],
          set: { providerCredentialId: cred.credentialId, sipUsername: cred.sipUsername },
        });
    },
  };
}

/** The stored SIP usernames for these reps, keyed by user id. */
async function sipUsernames(
  dbh: DbHandle,
  provider: VoiceProvider,
  userIds: string[],
): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await dbh.db
    .select()
    .from(schema.telephonyCredentials)
    .where(
      and(
        inArray(schema.telephonyCredentials.userId, userIds),
        eq(schema.telephonyCredentials.provider, provider.name),
      ),
    );
  return new Map(rows.map((r) => [r.userId, r.sipUsername]));
}

/**
 * The dialable address for one rep's browser. Throws when the provider needs a
 * credential the rep does not have yet — which means they have never enabled
 * their softphone, and dialing them would ring nothing.
 */
export async function clientAddressFor(
  dbh: DbHandle,
  provider: VoiceProvider,
  userId: string,
): Promise<string> {
  const found = await sipUsernames(dbh, provider, [userId]);
  return provider.formatClientAddress({ userId, sipUsername: found.get(userId) ?? null });
}

/**
 * Ring-group targets, skipping reps with no credential rather than failing the
 * whole inbound call: one rep who never enabled their softphone must not stop
 * the others from ringing.
 *
 * These are identity *pairs*, not finished addresses: the adapter renders its
 * own dial noun from the pair (a SIP URI inside <Sip> on Telnyx).
 */
export async function clientTargetsFor(
  dbh: DbHandle,
  provider: VoiceProvider,
  userIds: string[],
): Promise<{ targets: ClientTarget[]; skipped: string[] }> {
  const found = await sipUsernames(dbh, provider, userIds);
  const targets: ClientTarget[] = [];
  const skipped: string[] = [];
  for (const userId of userIds) {
    const sipUsername = found.get(userId) ?? null;
    // A provider that needs a credential and has none cannot be rung.
    try {
      provider.formatClientAddress({ userId, sipUsername });
    } catch {
      skipped.push(userId);
      continue;
    }
    targets.push({ userId, sipUsername });
  }
  return { targets, skipped };
}

/**
 * The rep behind an answering client leg, or null when the address is not one
 * of ours.
 *
 * Takes no provider: a SIP username is unique across the credential table, so
 * the event pipeline can resolve it on its own.
 */
export async function userIdFromClientAddress(
  dbh: DbHandle,
  address: string,
): Promise<string | null> {
  if (!address.startsWith('sip:')) return null;
  const username = address.slice('sip:'.length).split('@')[0];
  if (!username) return null;
  const row = (
    await dbh.db
      .select()
      .from(schema.telephonyCredentials)
      .where(eq(schema.telephonyCredentials.sipUsername, username))
      .limit(1)
  )[0];
  return row?.userId ?? null;
}
