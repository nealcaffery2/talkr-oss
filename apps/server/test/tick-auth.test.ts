/**
 * The worker tick (GET /internal/tick) runs only for the host's scheduler
 * (tick-auth.ts): the right bearer passes, anything else is refused, and an
 * unset CRON_SECRET refuses everyone.
 */

import { describe, expect, it } from 'vitest';
import { tickAuthorized } from '../src/tick-auth.js';

const SECRET = 'a-cron-secret-of-32-characters-xx';

describe('tickAuthorized', () => {
  it('passes the scheduler bearer', () => {
    expect(tickAuthorized(`Bearer ${SECRET}`, SECRET)).toEqual({ ok: true });
  });

  it('refuses no header, a wrong secret and a secret of another length', () => {
    expect(tickAuthorized(undefined, SECRET)).toMatchObject({ ok: false, status: 401 });
    expect(tickAuthorized(`Bearer ${SECRET.slice(0, -1)}y`, SECRET)).toMatchObject({ ok: false, status: 401 });
    expect(tickAuthorized('Bearer short', SECRET)).toMatchObject({ ok: false, status: 401 });
  });

  it('refuses every caller when CRON_SECRET is unset', () => {
    expect(tickAuthorized(`Bearer ${SECRET}`, undefined)).toMatchObject({ ok: false, status: 503 });
    expect(tickAuthorized(undefined, undefined)).toMatchObject({ ok: false, status: 503 });
  });
});
