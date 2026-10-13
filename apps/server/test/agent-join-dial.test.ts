/**
 * The seller is rung when the rep's leg joins the room (docs/telnyx-setup.md §6).
 *
 * On Telnyx the browser leg joins from TeXML shipped inline on the dial, so the
 * conference-status participant-join callback is the first moment the room
 * exists and has the id Telnyx's participant REST needs. The hook itself is
 * carrier-neutral, so it is exercised here through Twilio's signature scheme,
 * the only one the tests can forge.
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { authHeader, createTestContext, webhookPost, type TestContext } from './helpers.js';
import { conferenceStatus } from './fixtures/texml.js';

describe('customer dial when the agent joins the room', () => {
  let t: TestContext;
  let rep: Record<string, string>;
  beforeAll(async () => {
    t = await createTestContext();
    rep = await authHeader('auth-rep-test-org');
  });
  afterAll(async () => t.close());

  it('binds the leg, records the agent and rings the seller exactly once', async () => {
    const created = await t.app.inject({ method: 'POST', url: '/v1/calls', headers: rep, payload: { to_number: '+12165550177' } });
    expect(created.statusCode).toBe(201);
    const callId = created.json().call.id as string;
    const room = `talkr-${callId}`;

    // No /twiml/outbound-dial on this call: the leg was answered into the room
    // from inline TeXML, and this callback is the first thing we hear.
    const join = conferenceStatus({ event: 'participant-join', conferenceSid: 'CF_room_1', friendlyName: room, callSid: 'CA_agent_join_1', sequence: 1 });
    const res = await webhookPost(t, '/webhooks/telnyx/conference-status', join);
    expect(res.statusCode).toBe(200);

    expect(t.conferenceOps.added).toHaveLength(1);
    expect(t.conferenceOps.added[0]!.roomName).toBe(room);
    expect(t.conferenceOps.added[0]!.to).toBe('+12165550177');

    const [call] = await t.dbh.db.select().from(schema.calls).where(eq(schema.calls.id, callId));
    expect(call!.providerCallId).toBe('CA_agent_join_1');
    const parts = await t.dbh.db.select().from(schema.callParticipants).where(eq(schema.callParticipants.callId, callId));
    expect(parts.map((p) => `${p.role}:${p.state}`).sort()).toEqual(['agent:joined', 'customer:ringing']);
    expect(parts.find((p) => p.role === 'agent')!.providerConferenceId).toBe('CF_room_1');

    // A redelivered callback, then the seller's own join: neither rings anyone.
    await webhookPost(t, '/webhooks/telnyx/conference-status', join);
    const customerSid = t.conferenceOps.added[0]!.providerParticipantId;
    await webhookPost(
      t,
      '/webhooks/telnyx/conference-status',
      conferenceStatus({ event: 'participant-join', conferenceSid: 'CF_room_1', friendlyName: room, callSid: customerSid, sequence: 2 }),
    );
    await t.runner.drain();
    expect(t.conferenceOps.added).toHaveLength(1);
    // The fallback job found the seller already in the room and stood down.
    const after = await t.dbh.db.select().from(schema.callParticipants).where(eq(schema.callParticipants.callId, callId));
    expect(after.filter((p) => p.role === 'customer')).toHaveLength(1);
  });

  it('leaves rooms that are not ours alone', async () => {
    const before = t.conferenceOps.added.length;
    const res = await webhookPost(
      t,
      '/webhooks/telnyx/conference-status',
      conferenceStatus({ event: 'participant-join', conferenceSid: 'CF_other', friendlyName: 'someone-elses-room', callSid: 'CA_other' }),
    );
    expect(res.statusCode).toBe(200);
    expect(t.conferenceOps.added).toHaveLength(before);
  });
});
