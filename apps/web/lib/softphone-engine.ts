'use client';

/**
 * Telnyx's WebRTC SDK behind the softphone, behind one small interface: an
 * engine that registers, reports incoming calls, opens the media leg for a
 * Talkr call and hands back a call with a handful of events.
 *
 * A Telnyx WebRTC endpoint dials numbers, not our TeXML app, so the browser
 * never dials out itself. `connect()` asks the server to ring this browser
 * (`POST /v1/calls/:id/browser-leg`) and answers the resulting invite. Until
 * that invite arrives the call is "pending"; an invite that arrives while one
 * is pending, from our own caller ID, is the server leg and is answered
 * silently. Any other invite is a real inbound call.
 */

import type { TelnyxRTC } from '@telnyx/webrtc';

export type EngineKind = 'telnyx';
export type BrowserLegMode = 'client' | 'server';

export interface VoiceTokenDto {
  token: string;
  identity: string;
  ttl_seconds: number;
  /** Which carrier minted it. */
  provider?: string;
  browser_leg?: BrowserLegMode;
}

export type EngineCallEvent = 'accept' | 'ringing' | 'disconnect' | 'cancel' | 'reject' | 'error' | 'mute';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type EngineCallListener = (arg?: any) => void;

/** One media leg, whichever SDK carries it. */
export interface EngineCall {
  /** Caller number as the carrier reported it (inbound legs). */
  readonly from: string | null;
  /** The Talkr call id when this is the leg we asked the server for; null for inbound. */
  readonly talkrCallId: string | null;
  /** 'mute' carries the new muted flag, 'error' the SDK's error; the rest carry nothing. */
  on(event: EngineCallEvent, fn: EngineCallListener): void;
  accept(): void;
  reject(): void;
  disconnect(): void;
  mute(on: boolean): void;
  isMuted(): boolean;
  sendDigits(digits: string): void;
  localStream(): MediaStream | null;
  remoteStream(): MediaStream | null;
}

/**
 * Audio-device control the softphone speaks, implemented over
 * `enumerateDevices` and the Telnyx SDK's per-call device setters. Telnyx has
 * no separate ringtone routing, so that collection accepts the choice and
 * applies nothing.
 */
export interface EngineOutputCollection {
  get(): Set<{ deviceId: string }>;
  set(deviceId: string): Promise<void>;
  test(): Promise<void>;
}
export interface EngineAudio {
  readonly isOutputSelectionSupported: boolean;
  readonly availableInputDevices: Map<string, MediaDeviceInfo>;
  readonly availableOutputDevices: Map<string, MediaDeviceInfo>;
  readonly speakerDevices: EngineOutputCollection;
  readonly ringtoneDevices: EngineOutputCollection;
  setInputDevice(deviceId: string): Promise<void>;
  unsetInputDevice(): Promise<void>;
  on(event: 'deviceChange' | 'inputVolume', fn: (arg: never) => void): void;
  off(event: 'deviceChange' | 'inputVolume', fn: (arg: never) => void): void;
}

export interface EngineHandlers {
  onRegistered(): void;
  /** Lost the carrier (network, sleep, token). The softphone re-registers with backoff. */
  onUnregistered(): void;
  /** `fatal` = a fresh token will not help (bad credentials, account suspended). */
  onError(err: { message: string; fatal: boolean }): void;
  onIncoming(call: EngineCall): void;
}

export interface ConnectOptions {
  /** Server-leg carriers: ask the server to ring this browser for the call. */
  ringServer: () => Promise<unknown>;
  /** Our caller ID on the call; the server leg arrives *from* it. */
  expectFrom?: string | null;
  timeoutMs?: number;
}

export interface SoftphoneEngine {
  readonly kind: EngineKind;
  readonly browserLeg: BrowserLegMode;
  readonly audio: EngineAudio;
  register(): Promise<void>;
  updateToken(token: string): void;
  isRegistered(): boolean;
  /** Open the media leg for a Talkr call the server already created. */
  connect(callId: string, opts: ConnectOptions): Promise<EngineCall>;
  /** The org's own numbers: a server leg can present any of them, a customer never does. */
  setOwnNumbers(numbers: string[]): void;
  destroy(): void;
}


export async function createEngine(token: VoiceTokenDto, handlers: EngineHandlers): Promise<SoftphoneEngine> {
  return TelnyxEngine.create(token, handlers);
}

// ── Telnyx ───────────────────────────────────────────────────────────────────

type TelnyxCall = ReturnType<TelnyxRTC['newCall']>;

/** Digits only, so "+1 (210) 555-0101" and "12105550101" compare equal. */
function digits(s: string | null | undefined): string {
  return (s ?? '').replace(/\D/g, '');
}

class Emitter {
  private readonly fns = new Map<string, Array<(arg?: unknown) => void>>();
  on(event: string, fn: (arg?: unknown) => void) {
    const list = this.fns.get(event) ?? [];
    list.push(fn);
    this.fns.set(event, list);
  }
  emit(event: string, arg?: unknown) {
    for (const fn of this.fns.get(event) ?? []) {
      try {
        fn(arg);
      } catch {
        /* a listener must not break the others */
      }
    }
  }
}

class TelnyxEngineCall implements EngineCall {
  readonly from: string | null;
  readonly talkrCallId: string | null;
  private readonly emitter = new Emitter();
  private accepted = false;
  private ended = false;
  private muted = false;

  constructor(
    readonly call: TelnyxCall,
    talkrCallId: string | null,
  ) {
    this.from = call.options.remoteCallerNumber ?? call.options.callerNumber ?? null;
    this.talkrCallId = talkrCallId;
  }

  on(event: EngineCallEvent, fn: EngineCallListener): void {
    this.emitter.on(event, fn);
  }

  /** Fed by the client's callUpdate notifications; states are the SDK's lowercase names. */
  update(state: string): void {
    switch (state) {
      case 'ringing':
      case 'early':
        if (!this.accepted) this.emitter.emit('ringing');
        break;
      case 'active':
        if (!this.accepted) {
          this.accepted = true;
          this.emitter.emit('accept');
        }
        break;
      case 'hangup':
      case 'destroy':
      case 'purge':
        this.end(this.accepted ? 'disconnect' : 'cancel');
        break;
      default:
        break;
    }
  }

  private end(event: 'disconnect' | 'cancel' | 'reject'): void {
    if (this.ended) return;
    this.ended = true;
    this.emitter.emit(event);
  }

  accept() {
    void this.call.answer().catch((err: unknown) => {
      this.emitter.emit('error', { message: err instanceof Error ? err.message : 'could not answer' });
      this.end('cancel');
    });
  }
  reject() {
    void this.call.hangup().catch(() => undefined);
    this.end('reject');
  }
  disconnect() {
    void this.call.hangup().catch(() => undefined);
  }
  mute(on: boolean) {
    if (on) this.call.muteAudio();
    else this.call.unmuteAudio();
    this.muted = on;
    this.emitter.emit('mute', on);
  }
  isMuted() {
    return this.muted;
  }
  sendDigits(digitsToSend: string) {
    this.call.dtmf(digitsToSend);
  }
  localStream() {
    return this.call.localStream ?? null;
  }
  remoteStream() {
    return this.call.remoteStream ?? null;
  }
}

/** Speaker/ringtone collections over `setSinkId`; ringtone is accepted and unused. */
class TelnyxOutputs implements EngineOutputCollection {
  private current: string | null = null;
  constructor(
    private readonly apply: (deviceId: string) => Promise<void>,
    private readonly supported: boolean,
  ) {}
  get(): Set<{ deviceId: string }> {
    return new Set(this.current ? [{ deviceId: this.current }] : []);
  }
  async set(deviceId: string) {
    this.current = deviceId;
    if (this.supported) await this.apply(deviceId);
  }
  async test() {
    if (typeof window === 'undefined') return;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    gain.gain.value = 0.15;
    osc.frequency.value = 660;
    const dest = ctx.createMediaStreamDestination();
    osc.connect(gain).connect(dest);
    const el = new Audio();
    el.srcObject = dest.stream;
    const sink = (el as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId;
    if (sink && this.current && this.current !== 'default') await sink.call(el, this.current).catch(() => undefined);
    osc.start();
    await el.play().catch(() => undefined);
    await new Promise((r) => setTimeout(r, 600));
    osc.stop();
    el.pause();
    await ctx.close().catch(() => undefined);
  }
}

class TelnyxAudio implements EngineAudio {
  readonly isOutputSelectionSupported =
    typeof window !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
  readonly availableInputDevices = new Map<string, MediaDeviceInfo>();
  readonly availableOutputDevices = new Map<string, MediaDeviceInfo>();
  readonly speakerDevices: TelnyxOutputs;
  readonly ringtoneDevices: TelnyxOutputs;
  /** The mic the next call opens on. */
  inputDeviceId: string | null = null;
  private readonly listeners = new Map<string, Set<(arg: never) => void>>();
  private readonly onChange = () => void this.refresh().then(() => this.emit('deviceChange'));

  constructor(private readonly engine: TelnyxEngine) {
    this.speakerDevices = new TelnyxOutputs((id) => engine.applyOutput(id), this.isOutputSelectionSupported);
    this.ringtoneDevices = new TelnyxOutputs(async () => undefined, false);
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.addEventListener) {
      navigator.mediaDevices.addEventListener('devicechange', this.onChange);
      void this.refresh();
    }
  }

  async refresh(): Promise<void> {
    if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) return;
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      this.availableInputDevices.clear();
      this.availableOutputDevices.clear();
      for (const d of all) {
        if (d.kind === 'audioinput') this.availableInputDevices.set(d.deviceId, d);
        else if (d.kind === 'audiooutput') this.availableOutputDevices.set(d.deviceId, d);
      }
    } catch {
      /* enumeration refused; keep the last list */
    }
  }

  async setInputDevice(deviceId: string) {
    this.inputDeviceId = deviceId;
    await this.engine.applyInput(deviceId);
  }
  async unsetInputDevice() {
    // Telnyx releases the mic with the call; nothing is held between calls.
  }
  on(event: 'deviceChange' | 'inputVolume', fn: (arg: never) => void) {
    const set = this.listeners.get(event) ?? new Set();
    set.add(fn);
    this.listeners.set(event, set);
  }
  off(event: 'deviceChange' | 'inputVolume', fn: (arg: never) => void) {
    this.listeners.get(event)?.delete(fn);
  }
  private emit(event: 'deviceChange') {
    for (const fn of this.listeners.get(event) ?? []) fn(undefined as never);
  }
  dispose() {
    if (typeof navigator !== 'undefined' && navigator.mediaDevices?.removeEventListener) {
      navigator.mediaDevices.removeEventListener('devicechange', this.onChange);
    }
  }
}

interface PendingLeg {
  callId: string;
  expectFrom: string | null;
  resolve: (call: EngineCall) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class TelnyxEngine implements SoftphoneEngine {
  readonly kind = 'telnyx' as const;
  readonly browserLeg = 'server' as const;
  readonly audio: TelnyxAudio;
  private client: TelnyxRTC | null = null;
  private ready = false;
  private destroyed = false;
  private token: string;
  private readonly calls = new Map<string, TelnyxEngineCall>();
  private active: TelnyxEngineCall | null = null;
  private pending: PendingLeg | null = null;
  /** Last ten digits of every org number. */
  private ownNumbers = new Set<string>();
  private readonly remoteElement: HTMLAudioElement | null;
  private speakerId: string | null = null;

  private constructor(
    token: VoiceTokenDto,
    private readonly Ctor: typeof TelnyxRTC,
    private readonly handlers: EngineHandlers,
  ) {
    this.token = token.token;
    // The SDK attaches the far end's audio to a media element it is told about.
    if (typeof document !== 'undefined') {
      const el = document.createElement('audio');
      el.autoplay = true;
      el.setAttribute('data-talkr-softphone', 'telnyx');
      el.style.display = 'none';
      document.body.appendChild(el);
      this.remoteElement = el;
    } else {
      this.remoteElement = null;
    }
    this.audio = new TelnyxAudio(this);
  }

  static async create(token: VoiceTokenDto, handlers: EngineHandlers): Promise<TelnyxEngine> {
    const mod = await import('@telnyx/webrtc');
    return new TelnyxEngine(token, mod.TelnyxRTC, handlers);
  }

  private build(): TelnyxRTC {
    const client = new this.Ctor({ login_token: this.token });
    if (this.remoteElement) client.remoteElement = this.remoteElement;
    client.on('telnyx.ready', () => {
      this.ready = true;
      this.handlers.onRegistered();
    });
    client.on('telnyx.error', (event: { error?: Error; message?: string }) => {
      const message = event?.error?.message ?? event?.message ?? 'Telnyx error';
      this.handlers.onError({ message, fatal: /credential|unauthori|token|login|auth/i.test(message) && !this.ready });
    });
    client.on('telnyx.socket.close', () => {
      const wasReady = this.ready;
      this.ready = false;
      if (!this.destroyed && wasReady) this.handlers.onUnregistered();
    });
    client.on('telnyx.notification', (n: { type: string; call?: TelnyxCall }) => {
      if (n.type === 'callUpdate' && n.call) this.onCallUpdate(n.call);
    });
    return client;
  }

  private onCallUpdate(call: TelnyxCall): void {
    const state = String(call.state).toLowerCase();
    let wrapped = this.calls.get(call.id);
    if (!wrapped) {
      // First sight of this leg. Ours if we asked the server for one and the
      // invite comes from our own caller ID; otherwise a real inbound call.
      if (['hangup', 'destroy', 'purge'].includes(state)) return;
      const pending = this.pending;
      const from = call.options.remoteCallerNumber ?? call.options.callerNumber ?? null;
      // A server leg arrives from our caller ID, but the carrier may present
      // another of the org's numbers, or no number at all (a SIP user). A
      // customer never calls from one of ours, so any of those is the leg we
      // asked for. Treating it as inbound is how an outbound call used to ring
      // the rep as an incoming one, and then drop off the screen mid-call.
      const key = digits(from).slice(-10);
      const exact = !pending?.expectFrom || key === digits(pending.expectFrom).slice(-10);
      // Prefer matching any org number when we have a pending connect — same
      // rule the extension uses. Without this, a mismatched ANI lands in
      // onIncoming and a second softphone may 486-reject the fork.
      const isOurLeg =
        pending !== null && (exact || !from || key.length < 10 || this.ownNumbers.has(key));
      wrapped = new TelnyxEngineCall(call, isOurLeg ? pending!.callId : null);
      this.calls.set(call.id, wrapped);
      wrapped.on('accept', () => void this.onLegUp(wrapped!));
      const forget = () => {
        this.calls.delete(call.id);
        if (this.active === wrapped) this.active = null;
      };
      wrapped.on('disconnect', forget);
      wrapped.on('cancel', forget);
      wrapped.on('reject', forget);
      if (isOurLeg) {
        clearTimeout(pending!.timer);
        this.pending = null;
        this.active = wrapped;
        wrapped.accept();
        pending!.resolve(wrapped);
      } else {
        this.handlers.onIncoming(wrapped);
      }
    }
    wrapped.update(state);
  }

  /** Apply the chosen mic and speaker to a leg that just came up. */
  private async onLegUp(leg: TelnyxEngineCall): Promise<void> {
    this.active = leg;
    if (this.audio.inputDeviceId) await leg.call.setAudioInDevice(this.audio.inputDeviceId).catch(() => undefined);
    if (this.speakerId) await leg.call.setAudioOutDevice?.(this.speakerId).catch(() => undefined);
  }

  async applyInput(deviceId: string): Promise<void> {
    if (this.active) await this.active.call.setAudioInDevice(deviceId).catch(() => undefined);
  }

  async applyOutput(deviceId: string): Promise<void> {
    this.speakerId = deviceId;
    if (this.client) this.client.speaker = deviceId;
    const sink = (this.remoteElement as (HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }) | null)?.setSinkId;
    if (sink && this.remoteElement) await sink.call(this.remoteElement, deviceId).catch(() => undefined);
    if (this.active) await this.active.call.setAudioOutDevice?.(deviceId).catch(() => undefined);
  }

  async register(): Promise<void> {
    if (this.destroyed) throw new Error('softphone was shut down');
    if (this.ready && this.client?.connected) return;
    // A lost socket is re-logged in with whatever token we hold now; a stale
    // client is replaced rather than nursed, the SDK has no updateToken.
    if (this.client) {
      try {
        await this.client.disconnect();
      } catch {
        /* already closed */
      }
    }
    const client = this.build();
    this.client = client;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Telnyx did not answer the registration')), 15_000);
      client.on('telnyx.ready', () => {
        clearTimeout(timer);
        resolve();
      });
      client.on('telnyx.error', (event: { error?: Error; message?: string }) => {
        clearTimeout(timer);
        reject(new Error(event?.error?.message ?? event?.message ?? 'Telnyx refused the login'));
      });
      void client.connect().catch((err: unknown) => {
        clearTimeout(timer);
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  }

  updateToken(token: string) {
    this.token = token;
  }

  isRegistered() {
    return this.ready && Boolean(this.client?.connected);
  }

  setOwnNumbers(numbers: string[]) {
    this.ownNumbers = new Set(numbers.map((n) => digits(n).slice(-10)).filter((n) => n.length === 10));
  }

  async connect(callId: string, opts: ConnectOptions): Promise<EngineCall> {
    if (this.pending) throw new Error('a call is already being connected');
    let slot: PendingLeg | null = null;
    const leg = new Promise<EngineCall>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending === slot) this.pending = null;
        reject(new Error('The carrier did not ring this browser in time.'));
      }, opts.timeoutMs ?? 30_000);
      slot = { callId, expectFrom: opts.expectFrom ?? null, resolve, reject, timer };
      this.pending = slot;
    });
    try {
      await opts.ringServer();
    } catch (err) {
      if (slot && this.pending === slot) {
        clearTimeout((slot as PendingLeg).timer);
        this.pending = null;
      }
      throw err;
    }
    return leg;
  }

  destroy() {
    this.destroyed = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('softphone was shut down'));
      this.pending = null;
    }
    this.audio.dispose();
    void this.client?.disconnect().catch(() => undefined);
    this.client = null;
    this.remoteElement?.remove();
  }
}
