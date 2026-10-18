/**
 * The DOM-free half of the web's "Continue with Google": the authorize URL,
 * which nonce goes where, and how the callback is checked against the attempt
 * this tab started.
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildGoogleAuthorize, readGoogleCallback, safeReturnTo, type GoogleAttempt } from '../lib/googleSignIn';

const CLIENT_ID = '000000000000-dummyclientid.apps.googleusercontent.com';
const ORIGIN = 'https://talkr.test';

describe('buildGoogleAuthorize', () => {
  it('asks Google for an id_token back on /login/google', async () => {
    const { url } = await buildGoogleAuthorize(CLIENT_ID, ORIGIN, '/dialer');
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(u.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(u.searchParams.get('response_type')).toBe('id_token');
    expect(u.searchParams.get('redirect_uri')).toBe('https://talkr.test/login/google');
    expect(u.searchParams.get('scope')).toBe('openid email profile');
    expect(u.searchParams.get('prompt')).toBe('select_account');
  });

  it('gives Google the hashed nonce and keeps the raw one for the API', async () => {
    const { url, attempt } = await buildGoogleAuthorize(CLIENT_ID, ORIGIN, '/dialer');
    const sent = new URL(url).searchParams.get('nonce');
    expect(sent).toBe(createHash('sha256').update(attempt.nonce).digest('hex'));
    expect(sent).not.toBe(attempt.nonce);
    expect(new URL(url).searchParams.get('state')).toBe(attempt.state);
  });

  it('makes a new nonce and state every time', async () => {
    const a = await buildGoogleAuthorize(CLIENT_ID, ORIGIN, '/dialer');
    const b = await buildGoogleAuthorize(CLIENT_ID, ORIGIN, '/dialer');
    expect(a.attempt.nonce).not.toBe(b.attempt.nonce);
    expect(a.attempt.state).not.toBe(b.attempt.state);
  });

  it('only keeps an in-app return path', async () => {
    expect((await buildGoogleAuthorize(CLIENT_ID, ORIGIN, '//evil.example')).attempt.returnTo).toBe('/dialer');
    expect(safeReturnTo('https://evil.example')).toBe('/dialer');
    expect(safeReturnTo('/calls?x=1')).toBe('/calls?x=1');
    expect(safeReturnTo(null)).toBe('/dialer');
  });
});

describe('readGoogleCallback', () => {
  const attempt: GoogleAttempt = { nonce: 'raw-nonce', state: 'state-1', returnTo: '/calls' };
  const back = (fragment: string, query = '') => `${ORIGIN}/login/google${query}#${fragment}`;

  it('hands back the token, the raw nonce and where to go', () => {
    expect(readGoogleCallback(back('state=state-1&id_token=tok'), attempt)).toEqual({
      ok: true,
      idToken: 'tok',
      nonce: 'raw-nonce',
      returnTo: '/calls',
    });
  });

  it('refuses a token this tab did not ask for', () => {
    expect(readGoogleCallback(back('state=other&id_token=tok'), attempt)).toMatchObject({ ok: false, reason: 'state_mismatch' });
    expect(readGoogleCallback(back('state=state-1&id_token=tok'), null)).toMatchObject({ ok: false, reason: 'no_attempt' });
  });

  it('treats closing the chooser as a cancel and reports other errors', () => {
    expect(readGoogleCallback(back('error=access_denied&state=state-1'), attempt)).toMatchObject({ ok: false, reason: 'cancelled' });
    expect(readGoogleCallback(back('', '?error=invalid_request'), attempt)).toMatchObject({ ok: false, reason: 'failed' });
    expect(readGoogleCallback(back('state=state-1'), attempt)).toMatchObject({ ok: false, reason: 'failed' });
  });
});
