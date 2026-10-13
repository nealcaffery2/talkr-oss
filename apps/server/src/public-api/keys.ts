/**
 * API key minting + authentication for the public API and MCP server
 * (docs/public-api.md §1-2). Keys are secrets: only the SHA-256 hash is
 * stored; the full key is returned exactly once at creation and never logged.
 */

import { createHash, randomBytes } from 'node:crypto';
import { and, eq, isNull } from 'drizzle-orm';
import { schema, type DbLike } from '@talkr/db';

export const API_SCOPES = [
  'calls:read',
  'calls:write',
  'leads:read',
  'leads:write',
  'numbers:read',
  'users:read',
  'webhooks:manage',
] as const;

export type ApiScope = (typeof API_SCOPES)[number];

export function isApiScope(value: string): value is ApiScope {
  return (API_SCOPES as readonly string[]).includes(value);
}

export interface ApiKeyContext {
  keyId: string;
  orgId: string;
  name: string;
  scopes: ReadonlySet<string>;
}

const BASE62 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

/** 32 crypto-random bytes → 43 base62 chars (~190 bits of entropy). */
function randomBase62(chars: number): string {
  // Rejection sampling keeps the distribution uniform.
  let out = '';
  while (out.length < chars) {
    for (const byte of randomBytes(chars)) {
      if (byte < 248) {
        // 248 = 4 * 62 — highest multiple of 62 below 256.
        out += BASE62[byte % 62];
        if (out.length === chars) break;
      }
    }
  }
  return out;
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export interface MintedKey {
  /** The full secret — show once, never store, never log. */
  secret: string;
  keyPrefix: string;
  keyHash: string;
}

export function mintApiKey(): MintedKey {
  const random = randomBase62(43);
  const secret = `tk_live_${random}`;
  return { secret, keyPrefix: random.slice(0, 8), keyHash: hashApiKey(secret) };
}

/** Signing secret for outbound webhook subscriptions (recoverable HMAC key). */
export function mintSigningSecret(): string {
  return `whsec_${randomBytes(24).toString('hex')}`;
}

/**
 * Resolve `Authorization: Bearer tk_live_…` to an org-scoped key context.
 * Returns null on any failure (missing/malformed/unknown/revoked) — callers
 * translate to 401. Never logs or returns the presented key.
 */
export async function authenticateApiKey(
  db: DbLike,
  authorizationHeader: string | undefined,
): Promise<ApiKeyContext | null> {
  if (!authorizationHeader?.startsWith('Bearer ')) return null;
  const token = authorizationHeader.slice('Bearer '.length).trim();
  if (!token.startsWith('tk_live_')) return null;
  const row = (
    await db
      .select()
      .from(schema.apiKeys)
      .where(and(eq(schema.apiKeys.keyHash, hashApiKey(token)), isNull(schema.apiKeys.revokedAt)))
      .limit(1)
  )[0];
  if (!row) return null;
  const scopes = Array.isArray(row.scopes) ? (row.scopes as string[]) : [];
  return { keyId: row.id, orgId: row.orgId, name: row.name, scopes: new Set(scopes) };
}

// last_used_at is a display/hygiene field; stamp at most once per interval per
// key so the hot path stays read-only (docs/public-api.md §1).
const lastStamped = new Map<string, number>();
const STAMP_INTERVAL_MS = 60_000;

export function stampLastUsed(db: DbLike, keyId: string, nowMs = Date.now()): void {
  const prev = lastStamped.get(keyId);
  if (prev !== undefined && nowMs - prev < STAMP_INTERVAL_MS) return;
  lastStamped.set(keyId, nowMs);
  void Promise.resolve(
    db
      .update(schema.apiKeys)
      .set({ lastUsedAt: new Date(nowMs) })
      .where(eq(schema.apiKeys.id, keyId)),
  ).catch(() => undefined);
}

/** Test seam: forget throttle state so a fresh stamp is observable. */
export function resetLastUsedThrottle(): void {
  lastStamped.clear();
}
