import { describe, expect, it } from 'vitest';
import { canMonitor, isMerged, monitorPatch, type ControlContext } from '../src/conference.js';
import { roleHas } from '../src/rbac.js';

const live = (extra: ControlContext['participants'] = []): ControlContext => ({
  callActive: true,
  participants: [
    { providerParticipantId: 'agent-sid', role: 'agent', state: 'joined' },
    { providerParticipantId: 'cust-sid', role: 'customer', state: 'joined' },
    ...extra,
  ],
});

describe('monitorPatch', () => {
  it('listen is muted and not coaching', () => {
    expect(monitorPatch('listen', 'agent-sid')).toEqual({ muted: true, coaching: false });
  });
  it('whisper coaches the rep, and only the rep', () => {
    expect(monitorPatch('whisper', 'agent-sid')).toEqual({
      muted: false,
      coaching: true,
      callSidToCoach: 'agent-sid',
    });
  });
  it('barge is an ordinary unmuted party', () => {
    expect(monitorPatch('barge', 'agent-sid')).toEqual({ muted: false, coaching: false });
  });
});

describe('canMonitor', () => {
  it("allows a teammate's live call", () => {
    expect(canMonitor(live(), 'rep-1', 'mgr-1')).toBeNull();
  });
  it('refuses your own call', () => {
    expect(canMonitor(live(), 'mgr-1', 'mgr-1')).toBe('own_call');
  });
  it('refuses an ended call, and a room with no rep in it', () => {
    expect(canMonitor({ ...live(), callActive: false }, 'rep-1', 'mgr-1')).toBe('call_not_active');
    expect(
      canMonitor(
        { callActive: true, participants: [{ providerParticipantId: 'c', role: 'customer', state: 'joined' }] },
        'rep-1',
        'mgr-1',
      ),
    ).toBe('no_agent');
  });
});

describe('supervisors are not guests', () => {
  it('a listening supervisor does not make a two-party call "merged"', () => {
    expect(isMerged(live([{ providerParticipantId: 'sup', role: 'supervisor', state: 'joined' }]))).toBe(false);
  });
  it('calls.monitor belongs to managers and up, not reps', () => {
    expect(roleHas('rep', 'calls.monitor')).toBe(false);
    for (const role of ['manager', 'admin', 'owner'] as const) expect(roleHas(role, 'calls.monitor')).toBe(true);
  });
});
