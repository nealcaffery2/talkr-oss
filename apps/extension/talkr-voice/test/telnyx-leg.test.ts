/**
 * On Telnyx the server rings this browser back for every outbound call, and
 * the engine has to recognise that ring as its own. When it did not, an
 * outbound call rang the rep as an incoming one and then vanished from the
 * screen mid-call with no way to hang up. Pinned here against a fake carrier.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Listener = (arg: unknown) => void;
const clients: FakeClient[] = [];

class FakeClient {
  remoteElement: unknown = null;
  connected = true;
  private readonly listeners = new Map<string, Listener[]>();
  constructor() {
    clients.push(this);
  }
  on(event: string, fn: Listener) {
    this.listeners.set(event, [...(this.listeners.get(event) ?? []), fn]);
  }
  emit(event: string, arg?: unknown) {
    for (const fn of this.listeners.get(event) ?? []) fn(arg);
  }
  async connect() {
    queueMicrotask(() => this.emit('telnyx.ready'));
  }
  async disconnect() {}
}

vi.mock('@telnyx/webrtc', () => ({ TelnyxRTC: FakeClient }));

// The engine plays the far end through an <audio> it appends; node has no DOM.
vi.stubGlobal('document', {
  createElement: () => ({ setAttribute() {}, style: {}, remove() {} }),
  body: { appendChild() {} },
});

const { CANCELLED, createEngine } = await import('../src/offscreen/engine');

function invite(id: string, from: string) {
  return {
    id,
    state: 'ringing',
    options: { remoteCallerNumber: from },
    answer: vi.fn(async () => undefined),
    hangup: vi.fn(async () => undefined),
  };
}

async function setup() {
  const onIncoming = vi.fn();
  const engine = await createEngine(
    { token: 't', identity: 'me', ttl_seconds: 3600, provider: 'telnyx', browser_leg: 'server' },
    { onRegistered() {}, onUnregistered() {}, onError() {}, onIncoming },
  );
  await engine.register();
  engine.setOwnNumbers(['+12105550100', '+15125550142']);
  const ring = (call: ReturnType<typeof invite>) =>
    clients.at(-1)!.emit('telnyx.notification', { type: 'callUpdate', call });
  return { engine, onIncoming, ring };
}

describe('Telnyx server leg', () => {
  beforeEach(() => {
    clients.length = 0;
  });

  it('answers a ring-back from another of our numbers as our leg, not inbound', async () => {
    const { engine, onIncoming, ring } = await setup();
    const inv = invite('a', '+15125550142');
    const leg = engine.connect('call-1', {
      ringServer: async () => ring(inv),
      expectFrom: '+12105550100',
    });
    const call = await leg;
    expect(call.talkrCallId).toBe('call-1');
    expect(inv.answer).toHaveBeenCalled();
    expect(onIncoming).not.toHaveBeenCalled();
  });

  it('answers a short/missing From as our leg while a connect is pending', async () => {
    const { engine, onIncoming, ring } = await setup();
    const inv = invite('sip', '');
    const leg = engine.connect('call-1', {
      ringServer: async () => ring(inv),
      expectFrom: '+12105550100',
    });
    expect((await leg).talkrCallId).toBe('call-1');
    expect(inv.answer).toHaveBeenCalled();
    expect(onIncoming).not.toHaveBeenCalled();
  });

  it('still rings a customer who calls in while a leg is pending', async () => {
    const { engine, onIncoming, ring } = await setup();
    void engine.connect('call-1', { ringServer: async () => undefined, expectFrom: '+12105550100' }).catch(() => undefined);
    ring(invite('b', '+13125559999'));
    expect(onIncoming).toHaveBeenCalledTimes(1);
    engine.cancelPending();
  });

  it('cancel rejects the wait and hangs up the leg if it rings in afterwards', async () => {
    const { engine, onIncoming, ring } = await setup();
    const leg = engine.connect('call-1', { ringServer: async () => undefined, expectFrom: '+12105550100' });
    engine.cancelPending();
    await expect(leg).rejects.toThrow(CANCELLED);
    const late = invite('c', '+12105550100');
    ring(late);
    expect(late.hangup).toHaveBeenCalled();
    expect(late.answer).not.toHaveBeenCalled();
    expect(onIncoming).not.toHaveBeenCalled();
  });

  it('a cancelled call’s late leg is never adopted by the next call', async () => {
    const { engine, onIncoming, ring } = await setup();
    const first = engine.connect('call-A', { ringServer: async () => undefined, expectFrom: '+12105550100' });
    engine.cancelPending();
    await expect(first).rejects.toThrow(CANCELLED);

    // Redial at once: B must not ring the server until A's stray leg is dealt with.
    const ringB = vi.fn(async () => undefined);
    const second = engine.connect('call-B', { ringServer: ringB, expectFrom: '+12105550100' });
    await new Promise((r) => setTimeout(r, 20));
    expect(ringB).not.toHaveBeenCalled();

    const legA = invite('a', '+12105550100');
    ring(legA);
    expect(legA.hangup).toHaveBeenCalled();
    expect(legA.answer).not.toHaveBeenCalled();

    await new Promise((r) => setTimeout(r, 150));
    expect(ringB).toHaveBeenCalled();
    const legB = invite('b', '+12105550100');
    ring(legB);
    expect((await second).talkrCallId).toBe('call-B');
    expect(legB.answer).toHaveBeenCalled();
    expect(onIncoming).not.toHaveBeenCalled();
  });

  it('never hangs up a teammate transfer that arrives after a cancel', async () => {
    const { engine, onIncoming, ring } = await setup();
    const first = engine.connect('call-A', { ringServer: async () => undefined, expectFrom: '+12105550100' });
    engine.cancelPending();
    await expect(first).rejects.toThrow(CANCELLED);
    const transfer = invite('t', '+15125550142');
    ring(transfer);
    expect(transfer.hangup).not.toHaveBeenCalled();
    expect(onIncoming).toHaveBeenCalledTimes(1);
  });
});
