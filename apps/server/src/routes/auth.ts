/**
 * Sign-in for the browser surfaces (web app, Chrome extension).
 *
 * Talkr users are Supabase Auth users: AUTH_JWT_SECRET is the project's JWT
 * secret and `users.auth_user_id` is the GoTrue `sub`. This file proxies the
 * three GoTrue calls a client needs — password grant, refresh, logout — so
 * that browsers talk to one origin, the anon key never ships in a bundle, and
 * a successful sign-in is immediately checked against the platform's own user
 * table: an auth user with no Talkr row gets a clear error, not a session
 * that 401s on every request afterwards.
 *
 * Nothing here mints tokens. The access token a client gets back is GoTrue's,
 * and every later request verifies it exactly as before.
 */

import type { FastifyInstance, FastifyReply } from 'fastify';
import { eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { z } from 'zod';
import type { AppDeps } from '../app.js';
import { authenticate, type AuthContext } from '../auth.js';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

const recoverSchema = z.object({
  email: z.string().email(),
  redirect_to: z.string().url().optional(),
});

const resetSchema = z.object({
  access_token: z.string().min(1),
  password: z.string().min(8),
});

const refreshSchema = z.object({
  refresh_token: z.string().min(1),
});

/**
 * A Google id_token the client obtained itself, plus the nonce it asked Google
 * to bind into that token. Google requires a nonce for the id_token response
 * type and GoTrue re-checks it, which is what stops a token minted for another
 * app from being replayed here.
 */
const googleSchema = z.object({
  id_token: z.string().min(1),
  nonce: z.string().min(1).optional(),
});

interface GoTrueSession {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  expires_at?: number;
  token_type: string;
}

interface GoTrueError {
  error?: string;
  error_description?: string;
  msg?: string;
  error_code?: string;
}

/**
 * A Google OAuth client id ends in `.apps.googleusercontent.com`.
 *
 * Worth checking rather than trusting, because the field beside it in the
 * Google console is the client *secret* (`GOCSPX-…`), and this value is
 * deliberately public — /v1/auth/config hands it to every client that asks.
 * Pasting the wrong one would therefore both break sign-in and publish a
 * credential. Anything that is not a client id counts as unconfigured: the
 * value is never served, no client offers the button, and the log says why.
 */
function isGoogleClientId(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim().endsWith('.apps.googleusercontent.com');
}

export function registerAuthRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config, dbh } = deps;
  const configured = Boolean(config.SUPABASE_URL && config.SUPABASE_ANON_KEY);
  // Google sign-in rides the same GoTrue proxy, so it needs that too, plus the
  // client id the browser has to name when it talks to Google.
  const googleConfigured = configured && isGoogleClientId(config.GOOGLE_OAUTH_CLIENT_ID);
  if (config.GOOGLE_OAUTH_CLIENT_ID && !isGoogleClientId(config.GOOGLE_OAUTH_CLIENT_ID)) {
    // Loud, because the likeliest way to get here is pasting the secret, and
    // the symptom otherwise is only that no button appears.
    app.log.error(
      'GOOGLE_OAUTH_CLIENT_ID is not a Google client id (those end in .apps.googleusercontent.com). ' +
        'Google sign-in stays off. If what is set is the client secret, rotate it: it belongs in the ' +
        "Supabase dashboard's Google provider, never here.",
    );
  }

  async function gotrue(
    path: string,
    init: { method: 'POST' | 'PUT'; body?: unknown; bearer?: string },
  ): Promise<{ status: number; body: unknown }> {
    const doFetch = deps.fetchImpl ?? globalThis.fetch;
    const res = await doFetch(`${config.SUPABASE_URL}/auth/v1${path}`, {
      method: init.method,
      headers: {
        apikey: config.SUPABASE_ANON_KEY!,
        'content-type': 'application/json',
        ...(init.bearer ? { authorization: `Bearer ${init.bearer}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* 204 or non-JSON */
    }
    return { status: res.status, body };
  }

  /** Session + the platform user it maps to, in the shape both clients render. */
  async function sessionResponse(session: GoTrueSession, ctx: AuthContext) {
    const org = (
      await dbh.db
        .select({ id: schema.organizations.id, name: schema.organizations.name, slug: schema.organizations.slug })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, ctx.orgId))
        .limit(1)
    )[0];
    return {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      // Absolute expiry so clients don't have to trust their own clock at
      // sign-in time to compute it later.
      expires_at: session.expires_at ?? Math.floor(Date.now() / 1000) + session.expires_in,
      user: {
        id: ctx.userId,
        display_name: ctx.displayName,
        email: ctx.email,
        role: ctx.role,
        org: org ?? null,
      },
    };
  }

  function notConfigured(reply: FastifyReply) {
    return reply.code(501).send({
      error: 'password_signin_not_configured',
      message:
        'Email and password sign-in is not enabled on this server. Sign in with an access token instead.',
    });
  }

  /**
   * Translate a GoTrue failure. Wrong password and unknown email are the same
   * answer on purpose — the server does not confirm which addresses exist.
   */
  function gotrueFailure(reply: FastifyReply, status: number, body: unknown) {
    const err = (body ?? {}) as GoTrueError;
    const detail = err.error_description ?? err.msg ?? err.error ?? 'sign-in failed';
    if (status === 400 || status === 401 || status === 403) {
      const code = err.error_code ?? err.error ?? '';
      if (/email_not_confirmed/.test(code)) {
        return reply.code(403).send({ error: 'email_not_confirmed', message: 'Confirm your email first.' });
      }
      return reply.code(401).send({ error: 'invalid_credentials', message: 'Wrong email or password.' });
    }
    if (status === 429) {
      return reply.code(429).send({ error: 'rate_limited', message: 'Too many attempts. Try again shortly.' });
    }
    return reply.code(502).send({ error: 'auth_upstream_error', message: detail });
  }

  /** What sign-in methods this server offers; clients pick the form to show. */
  app.get('/v1/auth/config', async () => ({
    password_signin: configured,
    token_signin: true,
    google_signin: googleConfigured,
    // The public half of the OAuth client. Clients need it to build the
    // Google URL; shipping it is the point, which is why it is not a secret.
    google_client_id: googleConfigured ? config.GOOGLE_OAUTH_CLIENT_ID! : null,
    // True while AUTH_BYPASS_USER_EMAIL is set: unauthenticated requests run
    // as a fixed user, so clients skip sign-in altogether.
    open_access: Boolean(config.AUTH_BYPASS_USER_EMAIL),
  }));

  app.post('/v1/auth/login', async (req, reply) => {
    if (!configured) return notConfigured(reply);
    const parsed = loginSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const { status, body } = await gotrue('/token?grant_type=password', {
      method: 'POST',
      body: { email: parsed.data.email, password: parsed.data.password },
    });
    if (status !== 200) return gotrueFailure(reply, status, body);
    const session = body as GoTrueSession;

    const ctx = await authenticate(dbh.db, config.AUTH_JWT_SECRET, `Bearer ${session.access_token}`, undefined, config.SUPABASE_URL);
    if (!ctx) {
      // The password was right but there is no active Talkr user behind it.
      // Say so precisely: the fix is an admin adding them, not a retry.
      req.log.info({ email: parsed.data.email }, 'sign-in without platform user');
      return reply.code(403).send({
        error: 'no_platform_user',
        message: 'Your sign-in works, but this account is not a member of a Talkr workspace yet.',
      });
    }
    return sessionResponse(session, ctx);
  });

  /**
   * "Continue with Google".
   *
   * The client does the Google half itself — the extension through
   * chrome.identity, which has no redirect URI we could host — and arrives
   * here with an id_token. We trade it for a Supabase session so that the rest
   * of the system sees an ordinary Supabase user: the access token returned is
   * GoTrue's, verified on later requests exactly like a password sign-in's.
   *
   * That is also what makes this the answer to provisioning. A rep an admin
   * added by email is an `invited` row with no auth user and no password;
   * their first Google sign-in mints the auth user and `linkByEmail` (auth.ts)
   * claims the row and flips it to `active`. Nobody types a password, and no
   * admin copies an auth id around.
   *
   * Whether a given Google account is allowed to become a Supabase user at all
   * is the Supabase project's business (provider settings, and the domain
   * restrictions on the OAuth client); this route's own gate is the same one
   * password sign-in has — there must already be a Talkr user for that email.
   */
  app.post('/v1/auth/google', async (req, reply) => {
    if (!configured) return notConfigured(reply);
    if (!googleConfigured) {
      return reply.code(501).send({
        error: 'google_signin_not_configured',
        message: 'Google sign-in is not enabled on this server.',
      });
    }
    const parsed = googleSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const { status, body } = await gotrue('/token?grant_type=id_token', {
      method: 'POST',
      body: {
        provider: 'google',
        id_token: parsed.data.id_token,
        ...(parsed.data.nonce ? { nonce: parsed.data.nonce } : {}),
      },
    });
    if (status !== 200) {
      // A rejected id_token is not a wrong password: say so plainly rather
      // than reusing the deliberately vague credentials message.
      const err = (body ?? {}) as GoTrueError;
      const detail = err.error_description ?? err.msg ?? err.error ?? 'Google sign-in failed';
      if (status === 400 || status === 401 || status === 403) {
        const code = err.error_code ?? err.error ?? '';
        req.log.warn({ status, code, detail }, 'google id_token rejected');
        // "Try again" is a lie for the two failures that actually happen here,
        // and it cost a real afternoon: a provider nobody switched on, and a
        // nonce the client built wrong. Neither survives a retry, so name them.
        if (code === 'provider_disabled') {
          return reply.code(503).send({
            error: 'google_provider_disabled',
            message:
              'Google sign-in is not switched on for this workspace yet. An admin has to enable it; retrying will not help.',
          });
        }
        return reply.code(401).send({
          error: 'invalid_google_token',
          message: 'Google could not verify that sign-in.',
          // The rep cannot act on this, but the person they report it to can,
          // and it is about a token the caller supplied themselves.
          detail,
        });
      }
      if (status === 429) {
        return reply.code(429).send({ error: 'rate_limited', message: 'Too many attempts. Try again shortly.' });
      }
      return reply.code(502).send({ error: 'auth_upstream_error', message: detail });
    }
    const session = body as GoTrueSession;

    const ctx = await authenticate(dbh.db, config.AUTH_JWT_SECRET, `Bearer ${session.access_token}`, undefined, config.SUPABASE_URL);
    if (!ctx) {
      req.log.info('google sign-in without platform user');
      return reply.code(403).send({
        error: 'no_platform_user',
        message: 'Your Google sign-in works, but this account is not a member of a Talkr workspace yet.',
      });
    }
    return sessionResponse(session, ctx);
  });

  /**
   * Forgot password: GoTrue emails a recovery link that lands on redirect_to
   * with a recovery access token in the URL hash. Always 204, so the answer
   * never confirms whether an address has an account.
   */
  app.post('/v1/auth/recover', async (req, reply) => {
    if (!configured) return notConfigured(reply);
    const parsed = recoverSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const q = parsed.data.redirect_to ? `?redirect_to=${encodeURIComponent(parsed.data.redirect_to)}` : '';
    const { status } = await gotrue(`/recover${q}`, { method: 'POST', body: { email: parsed.data.email } });
    if (status === 429) {
      return reply.code(429).send({ error: 'rate_limited', message: 'Too many requests. Try again in a minute.' });
    }
    if (status >= 500) req.log.warn({ status }, 'recover upstream error');
    return reply.code(204).send();
  });

  /** Set a new password with the recovery token from the emailed link. */
  app.post('/v1/auth/reset', async (req, reply) => {
    if (!configured) return notConfigured(reply);
    const parsed = resetSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', message: 'Use at least 8 characters.' });
    }
    const { status } = await gotrue('/user', {
      method: 'PUT',
      bearer: parsed.data.access_token,
      body: { password: parsed.data.password },
    });
    if (status === 401 || status === 403) {
      return reply.code(401).send({ error: 'link_expired', message: 'This reset link has expired. Request a new one.' });
    }
    if (status !== 200) {
      return reply.code(status === 422 ? 400 : 502).send({ error: 'reset_failed', message: 'Could not set that password. Try a stronger one.' });
    }
    return reply.code(204).send();
  });

  app.post('/v1/auth/refresh', async (req, reply) => {
    if (!configured) return notConfigured(reply);
    const parsed = refreshSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    }
    const { status, body } = await gotrue('/token?grant_type=refresh_token', {
      method: 'POST',
      body: { refresh_token: parsed.data.refresh_token },
    });
    if (status !== 200) {
      // A used or revoked refresh token means the session is over; clients
      // treat 401 here as "sign in again".
      return reply.code(401).send({ error: 'session_expired', message: 'Session expired. Sign in again.' });
    }
    const session = body as GoTrueSession;
    const ctx = await authenticate(dbh.db, config.AUTH_JWT_SECRET, `Bearer ${session.access_token}`, undefined, config.SUPABASE_URL);
    if (!ctx) return reply.code(403).send({ error: 'no_platform_user' });
    return sessionResponse(session, ctx);
  });

  /**
   * Revoke the session upstream. Best effort: the client clears its own
   * storage regardless, and an already-dead token is the outcome we wanted.
   */
  app.post('/v1/auth/logout', async (req, reply) => {
    const authorization = req.headers.authorization;
    if (configured && authorization?.startsWith('Bearer ')) {
      try {
        await gotrue('/logout', { method: 'POST', bearer: authorization.slice('Bearer '.length) });
      } catch (err) {
        req.log.warn({ err }, 'upstream logout failed');
      }
    }
    return reply.code(204).send();
  });
}
