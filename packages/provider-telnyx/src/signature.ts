/**
 * Telnyx webhook signature verification.
 *
 * Telnyx signs asymmetrically, unlike Twilio: the account holds only a public
 * verifying key, and the signed bytes are `{timestamp}|{raw_body}` with a
 * literal pipe. That means the *exact* bytes of the delivered body have to be
 * verified — never a re-serialized parse of them.
 *
 * Two failure modes are deliberately closed here, both of which have shipped
 * as real bugs in other integrations:
 *
 *  1. Parsing the timestamp with `parseInt` accepts trailing junk, so a header
 *     of `1788000000abc` verifies (the signature covers the whole header) and
 *     then passes a replay window computed from the truncated number. The whole
 *     header must be an unsigned decimal integer or the delivery is rejected.
 *  2. Ed25519 signatures are malleable unless verification is strict. Node's
 *     `crypto.verify` is strict for Ed25519, which is why it is used directly
 *     rather than a hand-rolled check.
 */

import { createPublicKey, timingSafeEqual, verify, type KeyObject } from 'node:crypto';

export const SIGNATURE_HEADER = 'telnyx-signature-ed25519';
export const TIMESTAMP_HEADER = 'telnyx-timestamp';

/** How far out of date a delivery may be before it is treated as a replay. */
export const DEFAULT_TOLERANCE_SECONDS = 300;

/**
 * Telnyx publishes the key as bare base64 of the 32 raw Ed25519 bytes; Node
 * wants SPKI DER. This is the fixed Ed25519 SPKI prefix.
 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const ED25519_RAW_KEY_BYTES = 32;
const ED25519_SIGNATURE_BYTES = 64;

/**
 * Build a verifying key from Telnyx's base64 public key. Throws on anything
 * that is not a well-formed Ed25519 key, at construction time rather than on
 * the first webhook.
 */
export function publicKeyFromBase64(base64Key: string): KeyObject {
  const raw = Buffer.from(base64Key.trim(), 'base64');
  if (raw.length !== ED25519_RAW_KEY_BYTES) {
    throw new Error(
      `TELNYX_PUBLIC_KEY must decode to ${ED25519_RAW_KEY_BYTES} bytes, got ${raw.length}`,
    );
  }
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki',
  });
}

/** Strictly a run of decimal digits — no sign, no whitespace, no suffix. */
function parseWholeUnixSeconds(header: string): number | null {
  if (!/^[0-9]{1,15}$/.test(header)) return null;
  const seconds = Number(header);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

export interface VerifyParams {
  /** The exact bytes Telnyx delivered, before any parsing. */
  rawBody: string;
  signatureHeader: string | undefined;
  timestampHeader: string | undefined;
  publicKey: KeyObject;
  toleranceSeconds?: number;
  /** Injectable for tests. */
  nowMs?: number;
}

/**
 * True only when the signature is valid *and* the delivery is inside the
 * replay window. Every failure path returns false rather than throwing: a
 * malformed header is an untrusted request, not an exception.
 */
export function verifyTelnyxSignature(params: VerifyParams): boolean {
  const { rawBody, signatureHeader, timestampHeader, publicKey } = params;
  if (!signatureHeader || !timestampHeader) return false;

  const seconds = parseWholeUnixSeconds(timestampHeader);
  if (seconds === null) return false;

  const tolerance = params.toleranceSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  const nowSeconds = Math.floor((params.nowMs ?? Date.now()) / 1000);
  // Symmetric: a far-future timestamp is as suspect as a stale one.
  if (Math.abs(nowSeconds - seconds) > tolerance) return false;

  let signature: Buffer;
  try {
    signature = Buffer.from(signatureHeader, 'base64');
  } catch {
    return false;
  }
  if (signature.length !== ED25519_SIGNATURE_BYTES) return false;

  // The header value as delivered is what was signed, not the parsed number.
  const message = Buffer.from(`${timestampHeader}|${rawBody}`, 'utf8');
  try {
    return verify(null, message, publicKey, signature);
  } catch {
    return false;
  }
}

/**
 * Constant-time string compare, for the few places a shared secret is compared
 * outside signature verification (connection ids on TeXML callbacks).
 */
export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
