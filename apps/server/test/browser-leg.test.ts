/**
 * The rep's browser leg on Telnyx (docs/telnyx-setup.md "How a call is placed").
 *
 * A Telnyx WebRTC endpoint cannot dial our TeXML application with a call id,
 * so the server rings the rep's SIP address with the id on the answer URL and
 * the browser answers. The token response tells the softphone which side
 * opens the leg; the endpoint below is that server side.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { TEST_BASE_URL, authHeader, createTestContext, webhookPost, type TestContext } from './helpers.js';

describe('browser leg on Telnyx', () => {
  let t: TestContext;
  let rep: Record<string, string>;
  let admin: Record<string, string>;
  beforeAll(async () => {
    t = await createTestContext({ provisionCredentials: false });
    rep = await authHeader('auth-rep-test-org');
    admin = await authHeader('auth-admin-test-org');
    // The rep enabled their softphone once: Telnyx issued them a credential.
    await t.dbh.db.insert(schema.telephonyCredentials).values({
      orgId: t.seed.orgId,
      userId: t.seed.repId,
      provider: 'telnyx',
      providerCredentialId: 'cred-rep',
      sipUsername: 'gencredrep1',
    });
  });
  afterAll(async () => t.close());

  it('the token says which SDK to load and that the server opens the leg', async () => {
    const res = await t.app.inject({ method: 'POST', url: '/v1/voice/token', headers: rep });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ token: expect.stringContaining('telnyx-fake-'), provider: 'telnyx', browser_leg: 'server' });
  });

  it('rings the rep at their SIP address with the call id on the answer URL', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/v1/calls', headers: rep, payload: { to_number: '+12165550143' } });
    expect(created.statusCode).toBe(201);
    const call = created.json().call as { id: string; from_number: string };

    const rung = await t.app.inject({ method: 'POST', url: `/v1/calls/${call.id}/browser-leg`, headers: rep });
    expect(rung.statusCode).toBe(202);
    expect(rung.json()).toEqual({ mode: 'server', provider_call_id: 'CA_fake_dial_1' });

    const dial = t.providerDials[0]!;
    expect(dial.to).toBe('sip:gencredrep1@sip.telnyx.com');
    expect(dial.from).toBe(call.from_number);
    expect(dial.answerUrl).toBe(`${TEST_BASE_URL}/twiml/outbound-dial?talkr_call_id=${call.id}`);
    expect(dial.answerUrlMethod).toBe('POST');
    expect(dial.answerTexml).toContain(`talkr-${call.id}`);
    expect(dial.answerTexml).toContain('Conference');
    expect(dial.statusCallbackUrl).toBe(`${TEST_BASE_URL}/webhooks/telnyx/voice-status?call=${call.id}&leg=client`);

    // The room does not exist until the browser answers, and Telnyx addresses
    // rooms by id — so the seller is rung from the participant-join callback
    // (agent-join-dial.test.ts), never from here.
    expect(t.conferenceOps.added).toHaveLength(0);

    const [row] = await t.dbh.db.select().from(schema.calls).where(eq(schema.calls.id, call.id));
    expect(row!.status).toBe('initiated');
    expect(row!.providerCallId).toBe('CA_fake_dial_1');

    // Ringing twice would put two legs on one call.
    const again = await t.app.inject({ method: 'POST', url: `/v1/calls/${call.id}/browser-leg`, headers: rep });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('already_bound');
  });

  it("refuses another rep's call and a rep with no credential", async () => {
    const created = await t.app.inject({ method: 'POST', url: '/v1/calls', headers: rep, payload: { to_number: '+12165550144' } });
    const id = created.json().call.id as string;
    const other = await t.app.inject({ method: 'POST', url: `/v1/calls/${id}/browser-leg`, headers: admin });
    expect(other.statusCode).toBe(403);

    // The admin never enabled a softphone: there is no SIP address to ring.
    const mine = await t.app.inject({ method: 'POST', url: '/v1/calls', headers: admin, payload: { to_number: '+12165550145' } });
    const noCred = await t.app.inject({ method: 'POST', url: `/v1/calls/${mine.json().call.id}/browser-leg`, headers: admin });
    expect(noCred.statusCode).toBe(500);
    expect(t.providerDials).toHaveLength(1);
  });

  it('the call-control URL reads the call id from the query string as well as the body', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/v1/calls', headers: rep, payload: { to_number: '+12165550146' } });
    const id = created.json().call.id as string;
    const res = await webhookPost(t, `/twiml/outbound-dial?talkr_call_id=${id}`, {
      CallSid: 'CA_query_leg_1',
      AccountSid: 'ACtest00000000000000000000000000',
      From: `sip:gencredrep1@sip.telnyx.com`,
      To: '',
      Direction: 'inbound',
      CallStatus: 'in-progress',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain(`talkr-${id}`);
    const [row] = await t.dbh.db.select().from(schema.calls).where(eq(schema.calls.id, id));
    expect(row!.providerCallId).toBe('CA_query_leg_1');
  });

  it('a busy browser leg is platform_failure, not seller_busy', async () => {
    // SipHangupCause=486 on the client fork means a softphone rejected the
    // ring-back — the seller was never dialed. Classifying that as seller_busy
    // lied about why the call died in ~1s.
    const { voiceStatus } = await import('./fixtures/texml.js');
    const created = await t.app.inject({
      method: 'POST',
      url: '/v1/calls',
      headers: rep,
      payload: { to_number: '+12165550147' },
    });
    const id = created.json().call.id as string;
    await t.app.inject({ method: 'POST', url: `/v1/calls/${id}/browser-leg`, headers: rep });
    const sid = t.providerDials.at(-1)!.providerCallId;

    await webhookPost(
      t,
      `/webhooks/telnyx/voice-status?call=${id}&leg=client`,
      voiceStatus({ callSid: sid, status: 'busy', sequence: 3 }),
    );
    await t.runner.drain();

    const [row] = await t.dbh.db.select().from(schema.calls).where(eq(schema.calls.id, id));
    expect(row!.status).toBe('busy');
    expect(row!.failureClass).toBe('platform_failure');
  });
});
