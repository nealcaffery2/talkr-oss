/**
 * Browser credentials for every rep, without anyone pressing a button.
 *
 * On Telnyx a rep is reachable only once a telephony credential exists for
 * them (client-address.ts). Minting it lazily on the first voice token meant
 * a rep who had not opened the dialer yet could not be rung, and the owner
 * had to walk the team through "enable softphone". So the credential is
 * created wherever a rep first becomes visible: when they load `/v1/me`, when
 * they are added to the team, and for everyone at boot.
 *
 * The null carrier has nothing to mint; that falls out of the duck-typed
 * check below.
 */

import { and, eq, inArray, isNull } from 'drizzle-orm';
import { schema, type DbHandle } from '@talkr/db';
import type { VoiceProvider } from '@talkr/core';

interface MintsCredentials {
  ensureCredential(userId: string): Promise<{ credentialId: string; sipUsername: string }>;
}

function mints(provider: VoiceProvider): provider is VoiceProvider & MintsCredentials {
  return typeof (provider as Partial<MintsCredentials>).ensureCredential === 'function';
}

/** Make sure one rep has a credential with the active carrier. No-op for carriers that need none. */
export async function ensureBrowserCredential(dbh: DbHandle, provider: VoiceProvider, userId: string): Promise<boolean> {
  if (!mints(provider)) return false;
  const existing = await dbh.db
    .select({ id: schema.telephonyCredentials.id })
    .from(schema.telephonyCredentials)
    .where(and(eq(schema.telephonyCredentials.userId, userId), eq(schema.telephonyCredentials.provider, provider.name)))
    .limit(1);
  if (existing.length > 0) return false;
  await provider.ensureCredential(userId);
  return true;
}

/**
 * Every rep without a credential gets one. Bounded so a boot never spends
 * more than a few seconds here; the rest are picked up by their own `/v1/me`.
 */
export async function provisionBrowserCredentials(
  dbh: DbHandle,
  provider: VoiceProvider,
  opts: { orgId?: string; limit?: number } = {},
): Promise<{ minted: string[]; failed: Array<{ userId: string; error: string }> }> {
  const minted: string[] = [];
  const failed: Array<{ userId: string; error: string }> = [];
  if (!mints(provider)) return { minted, failed };
  const have = dbh.db
    .select({ userId: schema.telephonyCredentials.userId })
    .from(schema.telephonyCredentials)
    .where(eq(schema.telephonyCredentials.provider, provider.name));
  const missing = await dbh.db
    .select({ id: schema.users.id })
    .from(schema.users)
    .leftJoin(schema.telephonyCredentials, and(
      eq(schema.telephonyCredentials.userId, schema.users.id),
      eq(schema.telephonyCredentials.provider, provider.name),
    ))
    .where(and(
      inArray(schema.users.status, ['active', 'invited']),
      isNull(schema.telephonyCredentials.id),
      ...(opts.orgId ? [eq(schema.users.orgId, opts.orgId)] : []),
    ))
    .limit(opts.limit ?? 50);
  void have;
  for (const row of missing) {
    try {
      await provider.ensureCredential(row.id);
      minted.push(row.id);
    } catch (err) {
      failed.push({ userId: row.id, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { minted, failed };
}
