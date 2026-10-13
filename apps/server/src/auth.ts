import { createRemoteJWKSet, decodeJwt, jwtVerify, SignJWT, type JWTPayload, type JWTVerifyGetKey } from 'jose';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { permissionsForRole, type Permission, type Role } from '@talkr/core';
import { schema, type DbLike } from '@talkr/db';

export interface AuthContext {
  userId: string;
  orgId: string;
  role: Role;
  email: string;
  displayName: string;
}

export function hasPermission(ctx: AuthContext, permission: Permission): boolean {
  return permissionsForRole(ctx.role).has(permission);
}

/**
 * Verify a bearer JWT (HS256, Supabase project secret) and resolve the
 * platform user. Returns null on any failure — callers translate to 401.
 */
/**
 * A second trusted issuer (config PARTNER_JWT_SECRET / PARTNER_JWT_ISSUER).
 * Tokens it signs must carry that `iss`; the primary secret's tokens are not
 * checked for an issuer, so an operator setting the same value for both
 * secrets does not lock everyone out.
 */
export interface PartnerIssuer {
  /** HS256 shared secret (a Supabase project's legacy JWT secret, or a secret clozr signs with). */
  secret?: string;
  /** JWKS endpoint for asymmetric keys (Supabase "JWT signing keys"). */
  jwksUrl?: string;
  /** Required `iss`; unset accepts any issuer the key verifies. */
  issuer?: string;
}

/** One remote key set per URL, so the JWKS is fetched and cached once, not per request. */
const jwksCache = new Map<string, JWTVerifyGetKey>();
function remoteJwks(url: string): JWTVerifyGetKey {
  let get = jwksCache.get(url);
  if (!get) {
    get = createRemoteJWKSet(new URL(url));
    jwksCache.set(url, get);
  }
  return get;
}

/** True when the config names at least one partner verifier. */
export function partnerConfigured(p: PartnerIssuer | undefined): p is PartnerIssuer {
  return Boolean(p && (p.secret || p.jwksUrl));
}

/**
 * `partners` is the env-configured partner, a list (env plus `partner_apps`
 * rows, see partners.ts), or nothing. A token the primary secret verifies
 * resolves through users.auth_user_id as before. A token a partner verifies
 * resolves through partner_identities (issuer, sub); the first time a partner
 * sub is seen its email claim must match exactly one user, who is then linked
 * — an invited row becomes active, a linked Talkr user simply gains a second
 * identity. The partner is trusted to have verified that email; that is what
 * trusting a partner means.
 */
export async function authenticate(
  db: DbLike,
  secret: string,
  authorizationHeader: string | undefined,
  partners?: PartnerIssuer | PartnerIssuer[],
  /** The project's own Supabase URL: its asymmetric signing keys (ES256) verify like the HS256 secret. */
  supabaseUrl?: string,
): Promise<AuthContext | null> {
  if (!authorizationHeader?.startsWith('Bearer ')) return null;
  const token = authorizationHeader.slice('Bearer '.length);
  const list = (Array.isArray(partners) ? partners : partners ? [partners] : []).filter(partnerConfigured);
  let verified: Verified;
  try {
    verified = await verifyEither(token, secret, list, supabaseUrl);
  } catch {
    return null;
  }
  const { payload } = verified;
  if (typeof payload.sub !== 'string' || payload.sub.length === 0) return null;
  const sub = payload.sub;
  const email = typeof payload.email === 'string' ? payload.email : null;

  let user: typeof schema.users.$inferSelect | undefined;
  if (verified.partner) {
    if (payload.is_anonymous === true) return null;
    user = await resolvePartnerIdentity(db, verified.partner, sub, email);
  } else {
    const rows = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.authUserId, sub))
      .limit(1);
    user = rows[0] ?? (email ? await linkByEmail(db, sub, email) : undefined);
  }
  if (!user || user.status !== 'active') return null;
  return toContext(user);
}

type Verified = { payload: JWTPayload; partner: PartnerIssuer | null };

/**
 * Primary secret first. Then the partners: the ones whose issuer matches the
 * token's unverified `iss` are tried first (so a fleet of partners costs one
 * verification, not N), each bound to its issuer, secret before JWKS.
 */
async function verifyEither(
  token: string,
  secret: string,
  partners: PartnerIssuer[],
  supabaseUrl?: string,
): Promise<Verified> {
  try {
    const { payload } = await jwtVerify(token, new TextEncoder().encode(secret));
    return { payload, partner: null };
  } catch (hsErr) {
    let primaryErr: unknown = hsErr;
    // Projects on Supabase "JWT signing keys" sign ES256; the legacy secret can't verify those.
    if (supabaseUrl) {
      const base = supabaseUrl.replace(/\/$/, '');
      try {
        const { payload } = await jwtVerify(token, remoteJwks(`${base}/auth/v1/.well-known/jwks.json`), {
          issuer: `${base}/auth/v1`,
        });
        return { payload, partner: null };
      } catch (err) {
        primaryErr = err;
      }
    }
    if (partners.length === 0) throw primaryErr;
    let iss: string | undefined;
    try {
      iss = decodeJwt(token).iss;
    } catch {
      throw primaryErr;
    }
    const ordered = [
      ...partners.filter((p) => p.issuer && p.issuer === iss),
      ...partners.filter((p) => !p.issuer),
    ];
    let lastErr: unknown = primaryErr;
    for (const partner of ordered) {
      const opts = partner.issuer ? { issuer: partner.issuer } : {};
      if (partner.secret) {
        try {
          const { payload } = await jwtVerify(token, new TextEncoder().encode(partner.secret), opts);
          return { payload, partner };
        } catch (err) {
          lastErr = err;
        }
      }
      if (partner.jwksUrl) {
        try {
          const { payload } = await jwtVerify(token, remoteJwks(partner.jwksUrl), opts);
          return { payload, partner };
        } catch (err) {
          lastErr = err;
        }
      }
    }
    throw lastErr;
  }
}

/**
 * (issuer, sub) → user, creating the link on first sight when the token's
 * email names exactly one user. A row already linked to this partner is
 * never re-pointed; a second Talkr user with the same email is ambiguous and
 * left for an admin.
 */
async function resolvePartnerIdentity(db: DbLike, partner: PartnerIssuer, sub: string, email: string | null) {
  const issuer = partner.issuer ?? '';
  const linked = await db
    .select({ user: schema.users })
    .from(schema.partnerIdentities)
    .innerJoin(schema.users, eq(schema.users.id, schema.partnerIdentities.userId))
    .where(and(eq(schema.partnerIdentities.issuer, issuer), eq(schema.partnerIdentities.subject, sub)))
    .limit(1);
  if (linked[0]) return linked[0].user;
  if (!email) return undefined;
  const normalized = email.trim().toLowerCase();
  const candidates = await db
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${normalized}`)
    .limit(2);
  if (candidates.length !== 1) return undefined;
  const [row] = candidates;
  if (row!.status === 'disabled') return undefined;
  await db
    .insert(schema.partnerIdentities)
    .values({ userId: row!.id, issuer, subject: sub })
    .onConflictDoNothing();
  if (row!.status === 'invited') {
    const updated = await db
      .update(schema.users)
      .set({ status: 'active' })
      .where(and(eq(schema.users.id, row!.id), eq(schema.users.status, 'invited')))
      .returning();
    return updated[0] ?? row;
  }
  return row;
}

function toContext(user: typeof schema.users.$inferSelect): AuthContext {
  return {
    userId: user.id,
    orgId: user.orgId,
    role: user.role,
    email: user.email,
    displayName: user.displayName,
  };
}

/**
 * The user an unauthenticated request runs as while AUTH_BYPASS_USER_EMAIL is
 * set (config.ts). Matched by email so the switch needs no ids copied out of
 * the database. Null when no single active user has that address — the same
 * email in two orgs is ambiguous, and picking one would be picking an org —
 * and null here means the request is treated exactly as if the switch were off.
 */
export async function bypassContext(db: DbLike, email: string): Promise<AuthContext | null> {
  const normalized = email.trim().toLowerCase();
  const rows = await db
    .select()
    .from(schema.users)
    .where(sql`lower(${schema.users.email}) = ${normalized}`)
    .limit(2);
  if (rows.length !== 1) return null;
  const user = rows[0]!;
  if (user.status !== 'active') return null;
  return toContext(user);
}

/**
 * First sign-in for a rep an admin added by email only.
 *
 * Adding a teammate means two records in two systems — a Supabase Auth user
 * and our `users` row — and the only thing they naturally share is the email.
 * Rather than making the admin copy an auth id across, an unlinked row whose
 * email matches the token's is claimed on its first successful sign-in. Only
 * an unlinked row: a row already tied to another auth user is never reassigned.
 */
async function linkByEmail(db: DbLike, sub: string, email: string) {
  const normalized = email.trim().toLowerCase();
  const candidates = await db
    .select()
    .from(schema.users)
    .where(and(isNull(schema.users.authUserId), sql`lower(${schema.users.email}) = ${normalized}`))
    .limit(2);
  // Ambiguous (same email in two orgs) is left for an admin to resolve by hand.
  if (candidates.length !== 1) return undefined;
  const [row] = candidates;
  const updated = await db
    .update(schema.users)
    .set({
      authUserId: sub,
      // A row an admin added from the Team page starts as `invited`; the
      // sign-in that claims it is the invite being accepted. A disabled row
      // stays disabled — claiming it must not reopen the door.
      status: sql`case when ${schema.users.status} = 'invited' then 'active' else ${schema.users.status} end`,
    })
    .where(and(eq(schema.users.id, row!.id), isNull(schema.users.authUserId)))
    .returning();
  return updated[0];
}

/** Test/dev helper: mint a token the verifier above accepts. */
export async function signTestToken(
  secret: string,
  sub: string,
  claims: Record<string, unknown> = {},
): Promise<string> {
  return new SignJWT({ sub, ...claims })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('1h')
    .sign(new TextEncoder().encode(secret));
}
