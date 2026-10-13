/**
 * Caller reputation against real Postgres: the per-line daily call cap on the
 * click-to-call path, the SMS daily cap and 10DLC gate on the send path, and
 * the summary / per-line report shapes. The test provider is not Telnyx, so
 * carrier reads are off — the 10DLC snapshot is written the way a refresh
 * would write it.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq, sql } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { authHeader, createTestContext, type TestContext } from './helpers.js';

let t: TestContext;
let rep: Record<string, string>;
let admin: Record<string, string>;
const OUR = '+15005550006';

beforeAll(async () => {
  t = await createTestContext();
  rep = await authHeader('auth-rep-test-org');
  admin = await authHeader('auth-admin-test-org');
  await t.dbh.db.update(schema.organizations)
    .set({ settings: { timezone: 'UTC', smsSendWindowStart: '00:00', smsSendWindowEnd: '00:00' } })
    .where(eq(schema.organizations.id, t.seed.orgId));
});
afterAll(async () => t.close());

const patchLine = (payload: Record<string, unknown>) =>
  t.app.inject({ method: 'PATCH', url: `/v1/numbers/${t.seed.phoneNumberId}/reputation`, headers: admin, payload });

const tenDlc = (assigned: boolean) => ({
  checked_at: new Date().toISOString(),
  brands: [{ id: 'B1', name: 'Your Company', status: 'OK', identity_status: 'VERIFIED', failure_reasons: null }],
  campaigns: [{ id: 'C1', brand_id: 'B1', usecase: 'LOW_VOLUME', campaign_status: 'MNO_PROVISIONED', status: 'ACTIVE', approved: true, failure_reasons: null }],
  assignments: assigned ? { [OUR]: { campaign_id: 'C1', status: 'ASSIGNED' } } : {},
});

async function setOrgReputation(rep: object) {
  await t.dbh.db.execute(sql`UPDATE organizations SET reputation = ${JSON.stringify(rep)}::jsonb WHERE id = ${t.seed.orgId}`);
}

describe('protection settings', () => {
  it('needs numbers.manage, validates, and round-trips', async () => {
    const denied = await t.app.inject({ method: 'PATCH', url: `/v1/numbers/${t.seed.phoneNumberId}/reputation`, headers: rep, payload: { protection: { daily_call_cap: 2 } } });
    expect(denied.statusCode).toBe(403);
    expect((await patchLine({ protection: { daily_call_cap: 0 } })).statusCode).toBe(400);
    const ok = await patchLine({ protection: { daily_call_cap: 2 } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().reputation.protection).toEqual({ daily_call_cap: 2, daily_sms_cap: null, pause_on_warning: false });
  });

  it('caller names need the Telnyx carrier', async () => {
    expect((await patchLine({ cnam: { enabled: true, name: 'YOUR COMPANY' } })).statusCode).toBe(501);
  });
});

describe('daily call cap', () => {
  it('refuses the call past the cap with 429 number_protected, and lifting the cap lets it through', async () => {
    const dial = (n: number) => t.app.inject({ method: 'POST', url: '/v1/calls', headers: rep, payload: { to_number: `+1216555017${n}`, from_phone_number_id: t.seed.phoneNumberId } });
    expect((await dial(1)).statusCode).toBe(201);
    expect((await dial(2)).statusCode).toBe(201);
    const third = await dial(3);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ error: 'number_protected', message: expect.stringContaining('daily cap of 2') });
    await patchLine({ protection: { daily_call_cap: null } });
    expect((await dial(3)).statusCode).toBe(201);
  });
});

describe('SMS gate', () => {
  const send = (to: string) => t.app.inject({ method: 'POST', url: '/v1/messages', headers: rep, payload: { to_number: to, body: 'Hi from Your Company' } });

  it('sends normally with no registration snapshot (unknown is never a refusal)', async () => {
    const res = await send('+16145550701');
    expect(res.statusCode).toBe(201);
    expect(res.json().warning).toBeUndefined();
  });

  it('blocks an unassigned line once an approved campaign exists (auto), warns in warn mode', async () => {
    await setOrgReputation({ ten_dlc: tenDlc(false) });
    const blocked = await send('+16145550702');
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toMatchObject({ error: 'number_protected' });

    const settings = await t.app.inject({ method: 'PATCH', url: '/v1/reputation/settings', headers: admin, payload: { sms_gate: 'warn' } });
    expect(settings.statusCode).toBe(200);
    const warned = await send('+16145550702');
    expect(warned.statusCode).toBe(201);
    expect(warned.json().warning).toMatch(/10DLC/);
  });

  it('an assigned line sends without a warning', async () => {
    await setOrgReputation({ sms_gate: 'block', ten_dlc: tenDlc(true) });
    const res = await send('+16145550703');
    expect(res.statusCode).toBe(201);
    expect(res.json().warning).toBeUndefined();
  });

  it('the daily text cap refuses past the limit', async () => {
    await patchLine({ protection: { daily_sms_cap: 1 } });
    const res = await send('+16145550704');
    expect(res.statusCode).toBe(422);
    expect(res.json().message).toMatch(/daily cap of 1 texts/);
    await patchLine({ protection: { daily_sms_cap: null } });
  });
});

describe('reports', () => {
  it('per-line report counts today\'s calls and texts', async () => {
    const res = await t.app.inject({ method: 'GET', url: `/v1/numbers/${t.seed.phoneNumberId}/reputation`, headers: admin });
    expect(res.statusCode).toBe(200);
    const r = res.json().reputation;
    expect(r).toMatchObject({ phone_e164: OUR, carrier_connected: false, attestation: { expected: 'A' }, ten_dlc: { assigned: true } });
    expect(r.metrics.calls_today).toBe(3);
    expect(r.metrics.sms_sent_7d).toBeGreaterThanOrEqual(3);
    expect(['good', 'watch', 'at_risk']).toContain(r.grade);
  });

  it('summary carries every active line, counts, and the checklist', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/reputation/summary', headers: admin });
    expect(res.statusCode).toBe(200);
    const s = res.json();
    expect(s.sms_gate).toBe('block');
    expect(s.numbers.length).toBeGreaterThan(0);
    expect(s.checklist.map((i: { key: string }) => i.key)).toEqual([
      'stir_shaken', 'cnam', 'free_caller_registry', 'ten_dlc_brand', 'ten_dlc_campaign', 'ten_dlc_numbers', 'number_reputation', 'branded_calling',
    ]);
    expect(s.checklist.find((i: { key: string }) => i.key === 'free_caller_registry')).toMatchObject({ manual: true, status: 'manual' });
    const denied = await t.app.inject({ method: 'GET', url: '/v1/reputation/summary', headers: rep });
    expect(denied.statusCode).toBe(403);
  });
});
