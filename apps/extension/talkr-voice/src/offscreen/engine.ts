/**
 * Telnyx's WebRTC SDK behind the extension's softphone, behind one small
 * interface: an engine that registers, reports incoming calls, opens the media
 * leg for a Talkr call and hands back a call with a handful of events.
 *
 * A Telnyx WebRTC endpoint dials numbers, not our TeXML app, so the browser
 * never dials out itself. `connect()` asks the server to ring this browser
 * (`POST /v1/calls/:id/browser-leg`) and answers the resulting invite. Until
 * that invite arrives the call is "pending"; an invite that arrives while one
 * is pending, from one of our own numbers, is the server leg and is answered
 * silently. Any other invite is a real inbound call.
 *
 * This is a port of `apps/web/lib/softphone-engine.ts`. The extension cannot
 * import across app boundaries — a different package, a different build — so
 * the two are kept deliberately line-for-line alike: fix a carrier bug in one
 * and the same edit applies to the other. What differs is only what an
 * offscreen document needs: no `'use client'`, no SSR guards (there is always a
 * document here), and no ringtone routing, because this surface has no UI to
 * ring from.
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
}

export interface EngineHandlers {
  onRegistered(): void;
  /** Lost the carrier (network, sleep, token). The caller re-registers with backoff. */
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
  register(): Promise<void>;
  updateToken(token: string): void;
  isRegistered(): boolean;
  /** Open the media leg for a Talkr call the server already created. */
  connect(callId: string, opts: ConnectOptions): Promise<EngineCall>;
  /**
   * Give up on a `connect` still waiting for its leg (the rep hit Cancel before
   * the carrier rang back). The pending promise rejects with `CANCELLED`, and a
   * leg that turns up for it afterwards is hung up rather than rung as inbound.
   */
  cancelPending(): void;
  /** The org's own numbers: a server leg can present any of them, a customer never does. */
  setOwnNumbers(numbers: string[]): void;
  /** Route call audio to a microphone / speaker, as far as the carrier allows. */
  setInputDevice(deviceId: string): Promise<void>;
  setOutputDevice(deviceId: string): Promise<void>;
  destroy(): void;
}

/** What a cancelled `connect` rejects with, so the caller can tell it from a failure. */
export const CANCELLED = 'cancelled';

/**
 * Shown when Chrome refuses the mic. Offscreen cannot prompt — the grant comes
 * from the tab the popup's Allow mic button opens (src/mic) — so the words point there.
 */
export const MIC_DENIED =
  'Microphone blocked. Open the Talkr popup and press Allow mic.';

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
      const raw = err instanceof Error ? err.message : String(err ?? 'could not answer');
      // Telnyx surfaces Chrome's getUserMedia denial as this code. Without a
      // mic the peer never comes up and the outbound call dies as busy /
      // no-answer with an inbound ring sound — say so in plain words.
      const message = /microphone|MEDIA_MICROPHONE|Permission denied|NotAllowedError/i.test(raw)
        ? MIC_DENIED
        : raw;
      this.emitter.emit('error', { message });
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
}

interface PendingLeg {
  callId: string;
  expectFrom: string | null;
  /** The server has been asked to ring; no leg for this call can exist before. */
  rung: boolean;
  resolve: (call: EngineCall) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

class TelnyxEngine implements SoftphoneEngine {
  readonly kind = 'telnyx' as const;
  readonly browserLeg = 'server' as const;
  private client: TelnyxRTC | null = null;
  private ready = false;
  private destroyed = false;
  private token: string;
  private readonly calls = new Map<string, TelnyxEngineCall>();
  private active: TelnyxEngineCall | null = null;
  private pending: PendingLeg | null = null;
  /** A connect the rep cancelled; its leg may still ring in for a little while. */
  private cancelled: { expectFrom: string | null; until: number } | null = null;
  /** Last ten digits of every org number. */
  private ownNumbers = new Set<string>();
  private readonly remoteElement: HTMLAudioElement;
  private inputId: string | null = null;
  private speakerId: string | null = null;

  private constructor(
    token: VoiceTokenDto,
    private readonly Ctor: typeof TelnyxRTC,
    private readonly handlers: EngineHandlers,
  ) {
    this.token = token.token;
    // The SDK attaches the far end's audio to a media element it is told about.
    // An offscreen document is a real page, so this plays exactly as it does in
    // a tab — and unlike a tab, Chrome will not tear it down mid-call.
    const el = document.createElement('audio');
    el.autoplay = true;
    el.setAttribute('data-talkr-softphone', 'telnyx');
    el.style.display = 'none';
    document.body.appendChild(el);
    this.remoteElement = el;
  }

  static async create(token: VoiceTokenDto, handlers: EngineHandlers): Promise<TelnyxEngine> {
    const mod = await import('@telnyx/webrtc');
    return new TelnyxEngine(token, mod.TelnyxRTC, handlers);
  }

  private build(): TelnyxRTC {
    const client = new this.Ctor({ login_token: this.token });
    client.remoteElement = this.remoteElement;
    client.on('telnyx.ready', () => {
      this.ready = true;
      this.handlers.onRegistered();
    });
    client.on('telnyx.error', (event: { error?: Error; message?: string }) => {
      const message = event?.error?.message ?? event?.message ?? 'Telnyx error';
      this.handlers.onError({
        message,
        fatal: /credential|unauthori|token|login|auth/i.test(message) && !this.ready,
      });
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
      const exact = (expectFrom: string | null) => !expectFrom || key === digits(expectFrom).slice(-10);
      // The leg for a call the rep cancelled, still ringing in. Matched on its
      // exact caller ID only, so a transfer or a real caller is never hung up,
      // and only before the next call has rung the server, so it cannot be
      // mistaken for that call's leg (connect waits for this to clear).
      if (this.cancelled && Date.now() < this.cancelled.until && exact(this.cancelled.expectFrom) && !pending?.rung) {
        this.cancelled = null;
        void call.hangup().catch(() => undefined);
        return;
      }
      const isOurLeg =
        pending !== null &&
        pending.rung &&
        (exact(pending.expectFrom) || key.length < 10 || this.ownNumbers.has(key));
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
    if (this.inputId) await leg.call.setAudioInDevice(this.inputId).catch(() => undefined);
    if (this.speakerId) await leg.call.setAudioOutDevice?.(this.speakerId).catch(() => undefined);
  }

  async setInputDevice(deviceId: string): Promise<void> {
    this.inputId = deviceId;
    if (this.active) await this.active.call.setAudioInDevice(deviceId).catch(() => undefined);
  }

  async setOutputDevice(deviceId: string): Promise<void> {
    this.speakerId = deviceId;
    if (this.client) this.client.speaker = deviceId;
    const el = this.remoteElement as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };
    if (typeof el.setSinkId === 'function') await el.setSinkId(deviceId).catch(() => undefined);
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

  async connect(callId: string, opts: ConnectOptions): Promise<EngineCall> {
    if (this.pending) throw new Error('a call is already being connected');
    let slot: PendingLeg | null = null;
    const leg = new Promise<EngineCall>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending === slot) this.pending = null;
        reject(new Error('The carrier did not ring this browser in time.'));
      }, opts.timeoutMs ?? 30_000);
      slot = { callId, expectFrom: opts.expectFrom ?? null, rung: false, resolve, reject, timer };
      this.pending = slot;
    });
    // The executor above ran synchronously, so the slot is set; TS cannot see that.
    const mine = slot as unknown as PendingLeg;
    // Read through a function: TS still narrows `this.pending` to null from the guard above.
    const stillMine = () => this.pending === mine;
    // A cancelled call's leg may still be on its way. Ring for this one only
    // once it has arrived (and been hung up) or given up.
    while (this.cancelled && Date.now() < this.cancelled.until && stillMine()) {
      await new Promise((r) => setTimeout(r, 100));
    }
    if (!stillMine()) return leg; // cancelled meanwhile: `leg` has already rejected
    mine.rung = true;
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

  cancelPending() {
    const pending = this.pending;
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending = null;
    // Only a leg the server was asked for can still ring in.
    if (pending.rung) this.cancelled = { expectFrom: pending.expectFrom, until: Date.now() + 10_000 };
    pending.reject(new Error(CANCELLED));
  }

  setOwnNumbers(numbers: string[]) {
    this.ownNumbers = new Set(numbers.map((n) => digits(n).slice(-10)).filter((n) => n.length === 10));
  }

  destroy() {
    this.destroyed = true;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(new Error('softphone was shut down'));
      this.pending = null;
    }
    void this.client?.disconnect().catch(() => undefined);
    this.client = null;
    this.remoteElement.remove();
  }
}
