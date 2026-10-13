/**
 * Carrier selection (docs/architecture.md §4).
 *
 * The point of these is that a half-configured deployment fails at boot with a
 * message naming the missing variable, rather than at the first call with a
 * provider error nobody can trace back to an env var.
 */

import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import { createProvider } from '../src/services/provider-factory.js';
import { testConfig } from './helpers.js';

const TELNYX = {
  VOICE_PROVIDER: 'telnyx' as const,
  TELNYX_API_KEY: 'KEY123',
  // 32 zero bytes: structurally valid Ed25519, which is all construction needs.
  TELNYX_PUBLIC_KEY: Buffer.alloc(32).toString('base64'),
  TELNYX_ACCOUNT_ID: 'acct-1',
  TELNYX_TEXML_APP_ID: 'app-1',
  TELNYX_SIP_CONNECTION_ID: 'conn-1',
};

describe('provider selection', () => {
  const base = {
    DATABASE_URL: 'postgres://x/y',
    PUBLIC_BASE_URL: 'https://t',
    AUTH_JWT_SECRET: 'test-jwt-secret-test-jwt-secret',
  };

  it('defaults to Telnyx', () => {
    expect(loadConfig({ ...base }).VOICE_PROVIDER).toBe('telnyx');
  });

  it('forgives case, whitespace and the classic misspelling of the carrier name', () => {
    expect(loadConfig({ ...base, VOICE_PROVIDER: 'telynx' }).VOICE_PROVIDER).toBe('telnyx');
    expect(loadConfig({ ...base, VOICE_PROVIDER: 'NONE' }).VOICE_PROVIDER).toBe('none');
    expect(() => loadConfig({ ...base, VOICE_PROVIDER: 'vonage' })).toThrow(/VOICE_PROVIDER/);
  });

  it('a host still set to Twilio boots on Telnyx rather than failing', () => {
    expect(loadConfig({ ...base, VOICE_PROVIDER: ' Twilio ' }).VOICE_PROVIDER).toBe('telnyx');
  });

  it('boots with no carrier at all when VOICE_PROVIDER=none, and says so on use', () => {
    const provider = createProvider(testConfig({ VOICE_PROVIDER: 'none' }));
    expect(provider.name).toBe('none');
    expect(() => provider.mintClientToken('user-1')).toThrow(/VOICE_PROVIDER=none/);
    expect(provider.validateWebhook({ url: '', method: 'POST', headers: {}, params: {}, rawBody: '' })).toBe(false);
  });

  it('builds the Telnyx adapter when selected', () => {
    expect(createProvider(testConfig(TELNYX)).name).toBe('telnyx');
  });

  it('names the missing variable rather than failing at the first call', () => {
    expect(() => createProvider(testConfig({ ...TELNYX, TELNYX_SIP_CONNECTION_ID: '' }))).toThrow(
      /TELNYX_SIP_CONNECTION_ID/,
    );
    expect(() => createProvider(testConfig({ ...TELNYX, TELNYX_API_KEY: undefined }))).toThrow(
      /TELNYX_API_KEY/,
    );
  });
});
