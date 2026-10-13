/**
 * How a rep's browser is addressed on Telnyx: a SIP URI built from the
 * username Telnyx generated when the credential was minted. Addressing a rep
 * with no credential must fail loudly, and a ring group must skip that rep
 * rather than drop the call.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@talkr/db';
import { TelnyxVoiceProvider } from '@talkr/provider-telnyx';
import {
  clientAddressFor,
  clientTargetsFor,
  credentialStore,
  userIdFromClientAddress,
} from '../src/services/client-address.js';
import { createTestContext, type TestContext } from './helpers.js';

const telnyx = new TelnyxVoiceProvider({
  apiKey: 'KEY',
  publicKey: Buffer.alloc(32).toString('base64'),
  accountId: 'acct',
  texmlApplicationId: 'app',
  sipConnectionId: 'conn',
});

describe('client addressing', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext({ provisionCredentials: false });
  });
  afterAll(async () => t.close());

  it('refuses a Telnyx address until the rep has a credential, then uses it', async () => {
    await expect(clientAddressFor(t.dbh, telnyx, t.seed.repId)).rejects.toThrow(/credential/i);

    const store = credentialStore(t.dbh, async () => t.seed.orgId);
    await store.put(t.seed.repId, { credentialId: 'cred-1', sipUsername: 'gencred-xyz' });

    expect(await clientAddressFor(t.dbh, telnyx, t.seed.repId)).toBe(
      'sip:gencred-xyz@sip.telnyx.com',
    );
    expect(await store.get(t.seed.repId)).toEqual({
      credentialId: 'cred-1',
      sipUsername: 'gencred-xyz',
    });
  });

  it('re-minting a credential updates the row rather than failing on the unique index', async () => {
    const store = credentialStore(t.dbh, async () => t.seed.orgId);
    await store.put(t.seed.repId, { credentialId: 'cred-2', sipUsername: 'gencred-second' });
    expect(await store.get(t.seed.repId)).toEqual({
      credentialId: 'cred-2',
      sipUsername: 'gencred-second',
    });
    const rows = await t.dbh.db.select().from(schema.telephonyCredentials);
    expect(rows).toHaveLength(1);
  });

  it('rings the rest of a group when one rep has no credential', async () => {
    const [stranger] = await t.dbh.db
      .insert(schema.users)
      .values({
        orgId: t.seed.orgId,
        email: 'nophone@test-org.test',
        displayName: 'No Phone',
        role: 'rep',
        status: 'active',
      })
      .returning();

    const group = [t.seed.repId, stranger!.id];

    // Telnyx skips the rep who never enabled their softphone, and still rings
    // the one who did — one unconfigured rep must not kill an inbound call.
    const viaTelnyx = await clientTargetsFor(t.dbh, telnyx, group);
    expect(viaTelnyx.skipped).toEqual([stranger!.id]);
    expect(viaTelnyx.targets).toEqual([
      { userId: t.seed.repId, sipUsername: 'gencred-second' },
    ]);
  });

  it('traces an answering leg back to the rep from its SIP address', async () => {
    expect(await userIdFromClientAddress(t.dbh, 'sip:gencred-second@sip.telnyx.com')).toBe(
      t.seed.repId,
    );
    // A PSTN leg is not one of ours.
    expect(await userIdFromClientAddress(t.dbh, '+12165550143')).toBeNull();
    expect(await userIdFromClientAddress(t.dbh, 'sip:unknown@sip.telnyx.com')).toBeNull();
  });

  it('rings the rep at their SIP URI inside <Sip>', () => {
    const target = { userId: t.seed.repId, sipUsername: 'gencred-second' };
    const args = {
      callerId: '+15125550134',
      clientIdentities: [target],
      talkrCallId: 'call-1',
      timeoutSeconds: 20,
      dialActionUrl: 'https://talkr.test/dial-complete',
      statusCallbackUrl: 'https://talkr.test/status',
      record: false,
    };
    const tx = telnyx.buildClientDialResponse(args).body;
    expect(tx).toContain('sip:gencred-second@sip.telnyx.com');
    expect(tx).not.toContain('<Client');
  });
});
