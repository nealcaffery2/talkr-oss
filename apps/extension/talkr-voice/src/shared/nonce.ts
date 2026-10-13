/**
 * Nonce handling for the Google id_token sign-in.
 *
 * The two halves of this flow want *different* values, which is the trap this
 * module exists to close. Google embeds whatever `nonce` the authorize URL
 * carries straight into the token's claim. GoTrue, on the other side, hashes
 * the nonce it is given and compares that to the claim:
 *
 *     hash := fmt.Sprintf("%x", sha256.Sum256([]byte(params.Nonce)))
 *     if hash != idToken.Nonce { ... "Nonces mismatch" }
 *
 * So Google must be handed the SHA-256 hex, and our API the raw value it will
 * be hashed back from. Passing the same string to both reads as obviously
 * correct and fails every single time, with an error that names neither side.
 */

/** The two forms of one nonce. Which goes where is the whole point. */
export interface NoncePair {
  /** Sent to our API, forwarded to GoTrue, hashed there. Never sent to Google. */
  raw: string;
  /** Put on the Google authorize URL, so it lands in the token's nonce claim. */
  hashed: string;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** SHA-256 of `value`, lowercase hex — the encoding GoTrue compares against. */
export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return toHex(new Uint8Array(digest));
}

/** A fresh nonce for one sign-in attempt, in both the forms it is needed in. */
export async function createNoncePair(): Promise<NoncePair> {
  const raw = toHex(crypto.getRandomValues(new Uint8Array(16)));
  return { raw, hashed: await sha256Hex(raw) };
}
