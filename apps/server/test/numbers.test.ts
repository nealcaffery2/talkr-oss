/**
 * Numbers: inventory search, purchase (with webhooks set at the carrier),
 * owner reassignment carrying the default caller ID, and release.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { TEST_BASE_URL, authHeader, createTestContext, type TestContext } from './helpers.js';

describe('numbers', () => {
  let t: TestContext;
  let admin: Record<string, string>;
  let rep: Record<string, string>;
  beforeAll(async () => {
    t = await createTestContext();
    admin = await authHeader('auth-admin-test-org');
    rep = await authHeader('auth-rep-test-org');
  });
  afterAll(async () => t.close());

  it('lists the org numbers with the owner name', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/v1/numbers', headers: rep });
    expect(res.statusCode).toBe(200);
    const { numbers } = res.json();
    expect(numbers.length).toBeGreaterThan(0);
    expect(numbers[0]).toMatchObject({ phone_e164: expect.stringMatching(/^\+1/), status: 'active' });
    expect(numbers[0].assigned_user_name).toBe('Riley Rep');
  });

  it('search needs numbers.manage and an area code or pattern', async () => {
    const denied = await t.app.inject({ method: 'GET', url: '/v1/numbers/available?area_code=210', headers: rep });
    expect(denied.statusCode).toBe(403);
    const bare = await t.app.inject({ method: 'GET', url: '/v1/numbers/available', headers: admin });
    expect(bare.statusCode).toBe(400);
    const ok = await t.app.inject({ method: 'GET', url: '/v1/numbers/available?area_code=210&limit=2', headers: admin });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().numbers).toHaveLength(2);
    expect(ok.json().numbers[0]).toMatchObject({ phone_e164: '+12105550101', locality: 'San Antonio', area_code: '210' });
  });

  it('buys a number, points its webhooks here, assigns it and makes it the default caller ID', async () => {
    const res = await t.app.inject({
      method: 'POST',
      url: '/v1/numbers',
      headers: admin,
      payload: { phone_e164: '+12105550101', assigned_user_id: t.seed.adminId, label: 'SA line' },
    });
    expect(res.statusCode).toBe(201);
    const { number } = res.json();
    expect(number).toMatchObject({ phone_e164: '+12105550101', area_code: '210', label: 'SA line', assigned_user_id: t.seed.adminId, status: 'active' });

    const bought = t.numberOps.purchased[0]!;
    expect(bought.voiceUrl).toBe(`${TEST_BASE_URL}/twiml/inbound`);
    expect(bought.statusCallbackUrl).toBe(`${TEST_BASE_URL}/webhooks/telnyx/voice-status`);
    expect(bought.smsUrl).toBe(`${TEST_BASE_URL}/webhooks/telnyx/inbound-sms`);

    const [adminRow] = await t.dbh.db.select().from(schema.users).where(eq(schema.users.id, t.seed.adminId));
    expect(adminRow!.defaultPhoneNumberId).toBe(number.id);

    const dup = await t.app.inject({ method: 'POST', url: '/v1/numbers', headers: admin, payload: { phone_e164: '+12105550101' } });
    expect(dup.statusCode).toBe(409);
  });

  it('reassigning moves the default caller ID off the old owner and onto the new one', async () => {
    const list = await t.app.inject({ method: 'GET', url: '/v1/numbers', headers: admin });
    const line = list.json().numbers.find((n: { label: string | null }) => n.label === 'SA line');
    expect(line).toBeTruthy();

    const res = await t.app.inject({
      method: 'PATCH',
      url: `/v1/numbers/${line.id}`,
      headers: admin,
      payload: { assigned_user_id: t.seed.repId, label: 'Riley SA' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().number).toMatchObject({ assigned_user_id: t.seed.repId, assigned_user_name: 'Riley Rep', label: 'Riley SA' });

    const [adminRow] = await t.dbh.db.select().from(schema.users).where(eq(schema.users.id, t.seed.adminId));
    expect(adminRow!.defaultPhoneNumberId).toBeNull();
    // The rep already had a default (the seeded line); it is not overridden.
    const [repRow] = await t.dbh.db.select().from(schema.users).where(eq(schema.users.id, t.seed.repId));
    expect(repRow!.defaultPhoneNumberId).not.toBe(line.id);

    const bad = await t.app.inject({
      method: 'PATCH',
      url: `/v1/numbers/${line.id}`,
      headers: admin,
      payload: { assigned_user_id: '00000000-0000-0000-0000-000000000000' },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('forwarding still works through PATCH and a rep cannot manage numbers', async () => {
    const list = await t.app.inject({ method: 'GET', url: '/v1/numbers', headers: admin });
    const line = list.json().numbers[0];
    const denied = await t.app.inject({ method: 'PATCH', url: `/v1/numbers/${line.id}`, headers: rep, payload: { forward_to_e164: '+15125550000' } });
    expect(denied.statusCode).toBe(403);
    const ok = await t.app.inject({ method: 'PATCH', url: `/v1/numbers/${line.id}`, headers: admin, payload: { forward_to_e164: '+15125550000' } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().forward_to_e164).toBe('+15125550000');
  });

  it('release tells the carrier, keeps the row as released and clears defaults pointing at it', async () => {
    const list = await t.app.inject({ method: 'GET', url: '/v1/numbers', headers: admin });
    const line = list.json().numbers.find((n: { label: string | null }) => n.label === 'Riley SA');
    const res = await t.app.inject({ method: 'DELETE', url: `/v1/numbers/${line.id}`, headers: admin });
    expect(res.statusCode).toBe(204);
    expect(t.numberOps.released).toEqual(['PN_fake_1']);

    const [row] = await t.dbh.db.select().from(schema.phoneNumbers).where(eq(schema.phoneNumbers.id, line.id));
    expect(row!.status).toBe('released');
    expect(row!.assignedUserId).toBeNull();

    // Released numbers still list (history points at them) but are not active.
    const again = await t.app.inject({ method: 'GET', url: '/v1/numbers', headers: admin });
    expect(again.json().numbers.find((n: { id: string }) => n.id === line.id).status).toBe('released');

    // Buying it back reuses the row.
    const rebuy = await t.app.inject({ method: 'POST', url: '/v1/numbers', headers: admin, payload: { phone_e164: '+12105550101' } });
    expect(rebuy.statusCode).toBe(201);
    expect(rebuy.json().number.id).toBe(line.id);
    expect(rebuy.json().number.status).toBe('active');
  });
});
