import { describe, expect, it } from 'vitest';
import {
  conferenceRoomName,
  customerParticipantParams,
  shouldDialCustomer,
} from '../src/conference.js';

const TARGET = {
  callId: '11111111-2222-3333-4444-555555555555',
  fromNumber: '+15125550100',
  toNumber: '+15125550199',
  publicBaseUrl: 'https://api.example.com',
};

describe('shouldDialCustomer', () => {
  it('dials for a call that is still going', () => {
    for (const status of ['queued', 'initiated', 'ringing', 'in_progress', 'answered']) {
      expect(shouldDialCustomer({ status, endedAt: null })).toBe(true);
    }
  });

  it('refuses once the call is over — the rep hung up before the dial ran', () => {
    for (const status of ['completed', 'canceled', 'failed']) {
      expect(shouldDialCustomer({ status, endedAt: null })).toBe(false);
    }
  });

  it('refuses on an end timestamp even when the status has not caught up', () => {
    expect(shouldDialCustomer({ status: 'in_progress', endedAt: new Date() })).toBe(false);
  });
});

describe('customerParticipantParams', () => {
  // The inline TwiML dial and the queued fallback both go through this, so
  // downstream event handling cannot tell which one placed the call.
  it('addresses the call’s own room', () => {
    expect(customerParticipantParams(TARGET).roomName).toBe(conferenceRoomName(TARGET.callId));
  });

  it('dials the seller from the org number', () => {
    const params = customerParticipantParams(TARGET);
    expect(params.to).toBe(TARGET.toNumber);
    expect(params.callerId).toBe(TARGET.fromNumber);
  });

  it('carries the pstn-leg status callback the applier keys off', () => {
    expect(customerParticipantParams(TARGET).statusCallbackUrl).toBe(
      `https://api.example.com/webhooks/telnyx/voice-status?call=${TARGET.callId}&leg=pstn`,
    );
  });

  it('ends the conference when the customer leaves', () => {
    expect(customerParticipantParams(TARGET).endConferenceOnExit).toBe(true);
  });

  it('is deterministic, so a retry produces byte-identical params', () => {
    expect(customerParticipantParams(TARGET)).toEqual(customerParticipantParams(TARGET));
  });
});
