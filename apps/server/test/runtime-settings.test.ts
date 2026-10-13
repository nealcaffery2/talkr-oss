/**
 * runtime_settings: rows fill what the environment leaves unset, never more.
 * The carrier swap is the motivating case — VOICE_PROVIDER unset on the host,
 * a `telnyx` row in the database, and the server boots on Telnyx.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { schema } from '@talkr/db';
import { applyRuntimeSettings } from '../src/services/runtime-settings.js';
import { createTestContext, type TestContext } from './helpers.js';

const BASE_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'test',
  DATABASE_URL: 'postgres://postgres@127.0.0.1:5544/talkr_platform_test',
  PUBLIC_BASE_URL: 'https://talkr.test',
  AUTH_JWT_SECRET: 'test-jwt-secret-test-jwt-secret',
};

describe('runtime settings', () => {
  let t: TestContext;
  beforeAll(async () => {
    t = await createTestContext();
  });
  afterAll(async () => t.close());

  it('with no rows, the environment is the configuration', async () => {
    const r = await applyRuntimeSettings(t.dbh, BASE_ENV);
    expect(r.config.VOICE_PROVIDER).toBe('telnyx'); // the default
    expect(r.applied).toEqual([]);
  });

  it('rows fill unset keys: the carrier swap without touching the host', async () => {
    await t.dbh.db.insert(schema.runtimeSettings).values([
      { key: 'VOICE_PROVIDER', value: 'telnyx' },
      { key: 'TELNYX_API_KEY', value: 'KEY0123' },
      { key: 'TELNYX_PUBLIC_KEY', value: Buffer.alloc(32).toString('base64') },
      { key: 'TELNYX_ACCOUNT_ID', value: 'acct-1' },
      { key: 'TELNYX_TEXML_APP_ID', value: 'app-1' },
      { key: 'TELNYX_SIP_CONNECTION_ID', value: 'conn-1' },
      // Not on the allow list: must never reach the configuration.
      { key: 'DATABASE_URL', value: 'postgres://evil/where' },
      { key: 'AUTH_BYPASS_USER_EMAIL', value: 'someone@evil.test' },
    ]);
    const r = await applyRuntimeSettings(t.dbh, BASE_ENV);
    expect(r.config.VOICE_PROVIDER).toBe('telnyx');
    expect(r.config.TELNYX_API_KEY).toBe('KEY0123');
    expect(r.config.TELNYX_TEXML_APP_ID).toBe('app-1');
    expect(r.config.DATABASE_URL).toBe(BASE_ENV.DATABASE_URL);
    expect(r.config.AUTH_BYPASS_USER_EMAIL).toBeUndefined();
    expect(r.applied).toContain('VOICE_PROVIDER');
    expect(r.applied).not.toContain('DATABASE_URL');
  });

  it('a real environment variable wins over the row of the same name', async () => {
    const r = await applyRuntimeSettings(t.dbh, { ...BASE_ENV, VOICE_PROVIDER: 'none' });
    expect(r.config.VOICE_PROVIDER).toBe('none');
    expect(r.shadowed).toContain('VOICE_PROVIDER');
    // The other Telnyx rows still fill in; they are simply unused while the carrier is off.
    expect(r.config.TELNYX_API_KEY).toBe('KEY0123');
  });
});
