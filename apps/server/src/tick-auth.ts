/**
 * Who may run the worker tick (GET /internal/tick, serverless.ts).
 *
 * The tick drains the job queue, so an open endpoint lets anyone make the
 * worker run on demand. Vercel's cron sends `Authorization: Bearer
 * <CRON_SECRET>` when the project has a CRON_SECRET variable; any other host's
 * scheduler can send the same header. Without CRON_SECRET the tick refuses
 * every caller, so a deployment that forgets it fails loudly instead of
 * running open.
 */

import { timingSafeEqual } from 'node:crypto';

export type TickAuth = { ok: true } | { ok: false; status: 401 | 503; error: string };

export function tickAuthorized(authorization: string | undefined, secret: string | undefined): TickAuth {
  if (!secret) return { ok: false, status: 503, error: 'CRON_SECRET is not set' };
  const given = Buffer.from((authorization ?? '').replace(/^Bearer\s+/i, '').trim());
  const want = Buffer.from(secret);
  // Constant-time, so the secret cannot be guessed byte by byte from timing.
  if (given.length !== want.length || !timingSafeEqual(given, want)) {
    return { ok: false, status: 401, error: 'unauthorized' };
  }
  return { ok: true };
}
