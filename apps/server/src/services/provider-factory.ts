/**
 * Which telecom carrier this deployment talks to: Telnyx, or none at all.
 *
 * The provider abstraction (docs/architecture.md §4) keeps business logic off
 * any one carrier's API, so adding another later is an adapter, not a rewrite.
 * Telnyx's credentials are validated only when it is selected, so a deployment
 * with no carrier (`VOICE_PROVIDER=none`) still boots.
 */

import { eq } from 'drizzle-orm';
import type { MessagingProvider, VoiceProvider } from '@talkr/core';
import { schema, type DbHandle } from '@talkr/db';
import { TelnyxVoiceProvider } from '@talkr/provider-telnyx';
import type { Config } from '../config.js';
import { credentialStore } from './client-address.js';
import { NullProvider } from './null-provider.js';

export type TalkrProvider = VoiceProvider & MessagingProvider;

function required(config: Config, carrier: string, keys: readonly (keyof Config)[]): void {
  const missing = keys.filter((k) => {
    const v = config[k];
    return v === undefined || v === null || v === '';
  });
  if (missing.length > 0) {
    throw new Error(
      `VOICE_PROVIDER=${carrier} requires ${missing.join(', ')} — see apps/server/.env.example`,
    );
  }
}

/**
 * `dbh` is optional so a config-only caller (tests, a boot-time credential
 * check) can build a provider without a database; Telnyx then falls back to an
 * in-process credential map, which is fine for a single process and wrong for
 * serverless — hence the real store whenever a handle is available.
 *
 * `carrier` overrides `VOICE_PROVIDER` for a caller that needs a *particular*
 * carrier rather than the configured one — playing back a recording made
 * before a carrier swap is the case that exists (services/recording-media.ts).
 * It changes nothing else: the same credentials, validated the same way.
 */
export function createProvider(
  config: Config,
  dbh?: DbHandle,
  carrier?: Config['VOICE_PROVIDER'],
): TalkrProvider {
  const selected = carrier ?? config.VOICE_PROVIDER;
  if (selected === 'none') return new NullProvider();
  required(config, selected, [
    'TELNYX_API_KEY',
    'TELNYX_PUBLIC_KEY',
    'TELNYX_ACCOUNT_ID',
    'TELNYX_TEXML_APP_ID',
    'TELNYX_SIP_CONNECTION_ID',
  ]);
  return new TelnyxVoiceProvider(
    {
      apiKey: config.TELNYX_API_KEY!,
      publicKey: config.TELNYX_PUBLIC_KEY!,
      accountId: config.TELNYX_ACCOUNT_ID!,
      texmlApplicationId: config.TELNYX_TEXML_APP_ID!,
      sipConnectionId: config.TELNYX_SIP_CONNECTION_ID!,
      messagingProfileId: config.TELNYX_MESSAGING_PROFILE_ID,
      sipDomain: config.TELNYX_SIP_DOMAIN,
    },
    dbh
      ? {
          credentialStore: credentialStore(dbh, async (userId) => {
            const row = (
              await dbh.db
                .select({ orgId: schema.users.orgId })
                .from(schema.users)
                .where(eq(schema.users.id, userId))
                .limit(1)
            )[0];
            return row?.orgId ?? null;
          }),
        }
      : {},
  );
}
