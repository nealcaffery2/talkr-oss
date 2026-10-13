/**
 * Google sign-in was broken from the first commit because the raw nonce went
 * to both Google and GoTrue, which hashes before comparing. Nothing in the
 * types catches that — both halves are strings — so the contract is pinned
 * here instead, against a published SHA-256 vector.
 */

import { describe, expect, it } from 'vitest';
import { createNoncePair, sha256Hex } from '../src/shared/nonce';

describe('sha256Hex', () => {
  it('matches the published vector for "abc"', async () => {
    expect(await sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('matches the published vector for the empty string', async () => {
    expect(await sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('returns lowercase hex, zero-padded to 64 characters', async () => {
    expect(await sha256Hex('talkr')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('createNoncePair', () => {
  it('hashes the raw value into the hashed one', async () => {
    const { raw, hashed } = await createNoncePair();
    expect(hashed).toBe(await sha256Hex(raw));
  });

  it('keeps the two forms distinct', async () => {
    // The bug: sending `raw` where `hashed` belongs. If these were ever equal
    // the mistake would be invisible.
    const { raw, hashed } = await createNoncePair();
    expect(raw).not.toBe(hashed);
    expect(raw).toMatch(/^[0-9a-f]{32}$/);
    expect(hashed).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is fresh on every attempt, so a token cannot be replayed', async () => {
    const [a, b] = await Promise.all([createNoncePair(), createNoncePair()]);
    expect(a.raw).not.toBe(b.raw);
  });
});
