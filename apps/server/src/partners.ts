/**
 * Partner apps: who else may sign a rep in, and from which browser origins.
 *
 * A partner (CLOZR) embeds the Talkr phone and signs its reps in with its own
 * tokens. Talkr trusts a partner when either the PARTNER_* env vars name it
 * or a `partner_apps` row does. Rows win on convenience: onboarding a partner
 * or adding a preview origin is an insert, not a redeploy of the API.
 *
 * The registry caches the enabled rows for a minute. Both the auth preHandler
 * and the CORS origin check read it on every request, so the cache is what
 * keeps a partner lookup from being a query per call.
 */

import { eq } from 'drizzle-orm';
import { schema, type DbLike } from '@talkr/db';
import type { PartnerIssuer } from './auth.js';

export interface PartnerApp extends PartnerIssuer {
  /** The `iss` claim; also the identity namespace in partner_identities. */
  issuer: string;
  name: string;
  origins: string[];
}

const TTL_MS = 60_000;

/** `https://app-*-team.vercel.app` → one `*` matches one hostname label. */
export function originMatches(origin: string, pattern: string): boolean {
  const o = origin.toLowerCase();
  const p = pattern.trim().toLowerCase();
  if (!p.includes('*')) return o === p;
  const re = new RegExp(
    '^' + p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[a-z0-9-]+') + '$',
  );
  return re.test(o);
}

export class PartnerRegistry {
  private cache: { at: number; rows: PartnerApp[] } | null = null;
  private inflight: Promise<PartnerApp[]> | null = null;

  constructor(
    private readonly db: DbLike,
    /** The env-configured partner, if any; listed alongside the rows. */
    private readonly fromEnv: PartnerIssuer | undefined,
    private readonly webOrigins: string[],
  ) {}

  /** Forget the cache; the next call re-reads the table. */
  invalidate(): void {
    this.cache = null;
  }

  /** Every trusted partner: env first, then enabled rows. */
  async list(): Promise<PartnerApp[]> {
    const now = Date.now();
    if (this.cache && now - this.cache.at < TTL_MS) return this.cache.rows;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const rows: PartnerApp[] = [];
      if (this.fromEnv && (this.fromEnv.secret || this.fromEnv.jwksUrl)) {
        rows.push({
          name: 'env',
          issuer: this.fromEnv.issuer ?? '',
          secret: this.fromEnv.secret,
          jwksUrl: this.fromEnv.jwksUrl,
          origins: [],
        });
      }
      try {
        const found = await this.db
          .select()
          .from(schema.partnerApps)
          .where(eq(schema.partnerApps.enabled, true));
        for (const r of found) {
          rows.push({
            name: r.name,
            issuer: r.issuer,
            jwksUrl: r.jwksUrl ?? undefined,
            secret: r.secret ?? undefined,
            origins: r.origins,
          });
        }
      } catch {
        // A table that does not exist yet (migration pending) must not take
        // authentication down with it: env config still applies.
      }
      this.cache = { at: Date.now(), rows };
      this.inflight = null;
      return rows;
    })();
    return this.inflight;
  }

  /** WEB_ORIGIN plus every partner origin. Undefined origin (no browser) is not allowed a header. */
  async originAllowed(origin: string | undefined): Promise<boolean> {
    if (!origin) return false;
    if (this.webOrigins.some((w) => originMatches(origin, w))) return true;
    const partners = await this.list();
    return partners.some((p) => p.origins.some((pat) => originMatches(origin, pat)));
  }
}
