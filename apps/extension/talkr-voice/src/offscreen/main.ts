/**
 * The call's home.
 *
 * A popup is destroyed the moment it closes and the MV3 service worker can be
 * evicted mid-call, so neither can hold a WebRTC session. This offscreen
 * document outlives both: it owns the carrier client, the media leg, and the
 * authoritative snapshot, and it broadcasts that snapshot to whichever UI
 * happens to be open.
 *
 * The carrier is Telnyx, behind `engine.ts`: this file sees an engine and its
 * calls, never the SDK.
 *
 * The server is still the source of truth for call state (docs/architecture.md
 * "global dialer"); this is the browser's media leg plus a fast local view.
 */

import { ApiError, api } from '@/shared/api';
import { onSessionChanged } from '@/shared/session';
import { startLive, stopLive } from './live';
import { startRingtone, stopRingtone } from './ringtone';
import { heartbeatStatus } from '@/shared/presence';
import {
  COMMAND_TARGET,
  EMPTY_SNAPSHOT,
  isEnvelope,
  type CallSnapshot,
  type Command,
} from '@/shared/messages';
import { CANCELLED, createEngine, MIC_DENIED, type EngineCall, type SoftphoneEngine } from './engine';

let engine: SoftphoneEngine | null = null;
let activeCall: EngineCall | null = null;
let heartbeat: ReturnType<typeof setInterval> | null = null;
let tokenTimer: ReturnType<typeof setTimeout> | null = null;
let reregisterTimer: ReturnType<typeof setTimeout> | null = null;
let reregisterAttempt = 0;
let incomingCall: EngineCall | null = null;
let snapshot: CallSnapshot = { ...EMPTY_SNAPSHOT };
let pollTimer: ReturnType<typeof setInterval> | null = null;
/** Set by Cancel while an outbound call is still being created or connected. */
let cancelRequested = false;
/** Who we are and the org's numbers (last ten digits), for telling our own legs from real inbound. */
let myUserId: string | null = null;
let ownNumbers = new Set<string>();
/** Calls this softphone created, so one it cancelled is never mistaken for another softphone's. */
const placedHere = new Set<string>();

const last10 = (n: string) => n.replace(/\D/g, '').slice(-10);

/** Pull who we are and the org's numbers; the engine uses them to recognise its own server legs. */
async function loadOwnNumbers(): Promise<void> {
  try {
    const me = await api.getMe();
    myUserId = me.id;
    const numbers = (me.org_numbers ?? []).map((n) => n.phone_e164);
    ownNumbers = new Set(numbers.map(last10));
    engine?.setOwnNumbers(numbers);
  } catch {
    /* without them the engine still matches the call's own caller ID */
  }
}

/**
 * An invite from one of our own numbers while we already have a live outbound
 * (ours here, or on another softphone registered on the same line). It is the
 * browser / server leg for that call — not a customer ringing us — and must
 * never play the inbound ringtone. Matching only "other softphone" used to miss
 * the invite for a call *this* extension just placed when the engine failed to
 * claim it (mic denied on answer, number mismatch), which is how outbound
 * attempts spammed the Incoming… screen.
 */
async function isOwnOutboundLeg(from: string): Promise<boolean> {
  if (!ownNumbers.has(last10(from))) return false;
  if (activeCall || snapshot.phase === 'connecting' || snapshot.phase === 'ringing') return true;
  if (!myUserId) return false;
  try {
    const { calls } = await api.listCalls();
    return calls.some(
      (c) =>
        c.direction === 'outbound' &&
        c.user_id === myUserId &&
        // A queued record has not rung anything yet, so it has no leg to hear.
        c.status !== 'queued' &&
        !c.ended_at &&
        Date.now() - Date.parse(c.created_at) < 120_000,
    );
  } catch {
    return false;
  }
}

/**
 * Offscreen cannot show a permission prompt. If the popup already granted the
 * mic for this extension origin, getUserMedia succeeds; if not, fail before we
 * create a server call that will only hang up as no-answer.
 */
async function ensureMic(): Promise<void> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error(MIC_DENIED);
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    const name = err instanceof DOMException ? err.name : '';
    if (name === 'NotFoundError' || name === 'OverconstrainedError') {
      throw new Error('No microphone found. Plug one in and try again.');
    }
    throw new Error(MIC_DENIED);
  }
}

function patch(next: Partial<CallSnapshot>): void {
  snapshot = { ...snapshot, ...next };
  // Nobody may be listening — every UI can be closed. That is not an error.
  chrome.runtime.sendMessage({ type: 'snapshot', snapshot }).catch(() => undefined);
}

/** Recompute the flags the UI reads from the roster the server gave us. */
function applyRoster(participants: CallSnapshot['participants']): void {
  const live = participants.filter((p) => p.state !== 'left');
  patch({
    participants,
    onHold: live.some((p) => p.role === 'customer' && p.state === 'on_hold'),
    merged:
      live.filter((p) => p.state === 'joined').length >= 3 &&
      live.some((p) => p.role === 'customer' && p.state === 'joined'),
  });
}

async function refreshRoster(): Promise<void> {
  if (!snapshot.callId) return;
  try {
    const { participants } = await api.listParticipants(snapshot.callId);
    applyRoster(participants);
  } catch {
    /* transient read failure keeps the last known roster */
  }
}

/**
 * The extension has no SSE connection of its own — an offscreen document is
 * not a good place to hold a long-lived stream that Chrome may suspend — so
 * the roster is polled while a call is up. Two seconds is fast enough that a
 * teammate joining feels immediate and slow enough to be free.
 */
function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => void refreshRoster(), 2000);
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

// ── Registration ───────────────────────────────────────────────────────────

function clearTimers(): void {
  if (tokenTimer) clearTimeout(tokenTimer);
  tokenTimer = null;
  if (reregisterTimer) clearTimeout(reregisterTimer);
  reregisterTimer = null;
}

/**
 * Re-mint before the credential dies. Telnyx cannot swap a token into a live
 * client, so the fresh token is held and used by the next registration.
 */
function scheduleTokenRenewal(ttlSeconds: number): void {
  if (tokenTimer) clearTimeout(tokenTimer);
  const inMs = Math.max(30, ttlSeconds - 120) * 1000;
  tokenTimer = setTimeout(() => {
    void (async () => {
      try {
        const fresh = await api.voiceToken();
        engine?.updateToken(fresh.token);
        scheduleTokenRenewal(fresh.ttl_seconds);
      } catch {
        // The next call attempt surfaces the auth error; try again shortly
        // rather than letting the credential lapse in silence.
        scheduleTokenRenewal(120);
      }
    })();
  }, inMs);
}

/**
 * The carrier can drop us — laptop sleep, a flaky network, a socket close —
 * and a softphone that stays down until the rep notices is a missed call. Back
 * off so a carrier outage is not hammered, and cap it at half a minute so a
 * rep who reopens the lid is ringing again quickly.
 */
function scheduleReregister(): void {
  if (reregisterTimer || !engine) return;
  const delay = Math.min(30_000, 1000 * 2 ** reregisterAttempt);
  reregisterAttempt += 1;
  reregisterTimer = setTimeout(() => {
    reregisterTimer = null;
    void (async () => {
      if (!engine || engine.isRegistered()) return;
      try {
        await engine.register();
        reregisterAttempt = 0;
        patch({ device: 'ready', deviceError: null });
      } catch (err) {
        patch({ deviceError: (err as Error).message });
        scheduleReregister();
      }
    })();
  }, delay);
}

async function initDevice(): Promise<void> {
  if (engine || snapshot.device === 'initializing') return;
  patch({ device: 'initializing', deviceError: null });
  try {
    const token = await api.voiceToken();
    const created = await createEngine(token, {
      onRegistered: () => {
        reregisterAttempt = 0;
        patch({ device: 'ready', deviceError: null });
      },
      onUnregistered: () => {
        // Not an error the rep must act on, but the softphone is not ringing
        // until it is back, so say so and start climbing back.
        patch({ device: 'error', deviceError: 'Reconnecting to the carrier…' });
        scheduleReregister();
      },
      onError: (err) => {
        // Registration failures arrive as events, not rejections: a client that
        // never gets to 'ready' must not sit on 'initializing' forever.
        patch({
          deviceError: err.message,
          device: snapshot.device === 'ready' && !err.fatal ? 'ready' : 'error',
        });
        if (!err.fatal) scheduleReregister();
      },
      onIncoming: (call) => onIncoming(call),
    });
    await created.register();
    engine = created;
    void loadOwnNumbers();
    scheduleTokenRenewal(token.ttl_seconds);
    patch({ device: 'ready', provider: created.kind });

    // Presence: routing only rings browsers that are actually alive, and a
    // rep who picked Away or Do not disturb stays that way (shared/presence.ts).
    beat();
    if (heartbeat) clearInterval(heartbeat);
    heartbeat = setInterval(beat, 30_000);
  } catch (err) {
    patch({ device: 'error', deviceError: (err as Error).message });
  }
}

/** Tell Talkr whether this rep can take a call: what they picked, if the phone is up. */
function beat(): void {
  const status = heartbeatStatus(snapshot.presence, snapshot.device === 'ready');
  void api.heartbeat(status).catch(() => undefined);
}

function onIncoming(call: EngineCall): void {
  // One call at a time: a busy rep auto-rejects so the server's routing chain
  // moves to the next fallback rather than stalling. Never reject an invite
  // from one of our own numbers — that is a Telnyx server leg (ours or another
  // softphone's). Hangup/reject sends SipHangupCause=486 and can cancel the
  // fork the answering client is trying to take, which is the "outbound dies
  // in ~1s, seller never rings" failure.
  if (call.from && ownNumbers.has(last10(call.from))) {
    if (!activeCall && snapshot.phase !== 'connecting' && snapshot.phase !== 'ringing') {
      void isOwnOutboundLeg(call.from).then((ours) => {
        if (!ours) ringIncoming(call);
      });
    }
    return;
  }
  if (activeCall || snapshot.phase === 'connecting' || snapshot.phase === 'ringing') {
    call.reject();
    return;
  }
  if (!call.from) {
    ringIncoming(call);
    return;
  }
  // A caller who hangs up while we ask the server must not leave a ring behind.
  let gone = false;
  const mark = () => {
    gone = true;
  };
  call.on('cancel', mark);
  call.on('disconnect', mark);
  // Not rejected when it is ours: that would end the leg the other softphone is answering.
  void isOwnOutboundLeg(call.from).then((ours) => {
    if (!ours && !gone) ringIncoming(call);
  });
}

function ringIncoming(call: EngineCall): void {
  // Do not disturb: declined, so the caller reaches voicemail and nothing
  // rings over what the rep is doing.
  if (activeCall || incomingCall || snapshot.presence === 'dnd') {
    call.reject();
    return;
  }
  incomingCall = call;
  const from = call.from ?? 'Unknown';
  patch({ incoming: { from, contactName: null } });
  // Rings even with the popup shut: the service worker raises the
  // notification, and this is the sound (offscreen may play audio).
  startRingtone();
  void api
    .lookupPhone(from)
    .then((ctx) => {
      if (snapshot.incoming?.from === from) {
        patch({ incoming: { from, contactName: ctx.contact?.display_name ?? null } });
      }
    })
    .catch(() => undefined);
  const clearIncoming = () => {
    stopRingtone();
    if (incomingCall !== call) return;
    incomingCall = null;
    patch({ incoming: null });
  };
  call.on('cancel', clearIncoming);
  call.on('disconnect', clearIncoming);
  call.on('reject', clearIncoming);
}

/** Wire the media leg's lifecycle into the snapshot. */
function bindCall(call: EngineCall, onEnd: () => void): void {
  call.on('accept', () => patch({ phase: 'in_call', startedAt: Date.now() }));
  call.on('ringing', () => {
    if (snapshot.phase === 'connecting') patch({ phase: 'ringing' });
  });
  call.on('mute', (muted: boolean) => patch({ muted }));
  const end = () => {
    if (activeCall !== call) return;
    activeCall = null;
    stopPolling();
    onEnd();
  };
  call.on('disconnect', end);
  call.on('cancel', end);
  // answer() failed (almost always mic denied): drop to idle with the words,
  // not wrap-up — the seller was never dialed.
  call.on('error', (arg?: { message?: string }) => {
    if (activeCall !== call) return;
    activeCall = null;
    stopPolling();
    if (arg?.message) {
      patch({
        phase: 'idle',
        callId: null,
        counterparty: null,
        callerId: null,
        direction: null,
        startedAt: null,
        muted: false,
        onHold: false,
        merged: false,
        participants: [],
        incoming: null,
        error: arg.message,
      });
      return;
    }
    onEnd();
  });
}

async function placeCall(toNumber: string): Promise<void> {
  if (!engine) throw new Error('softphone not enabled');
  if (activeCall) throw new Error('a call is already active');
  // Fail before the server record exists: without a mic the browser leg will
  // never answer and the rep only hears an inbound ring spam.
  await ensureMic();
  cancelRequested = false;
  patch({ phase: 'connecting', counterparty: toNumber, direction: 'outbound', error: null });

  // The server creates the authoritative record first (suppression-gated),
  // then the browser opens the media leg for it.
  const { call } = await api.createCall({ to_number: toNumber });
  placedHere.add(call.id);
  // Cancel pressed while the record was being created: never ring anyone.
  if (cancelRequested) throw new Error(CANCELLED);
  patch({
    phase: 'connecting',
    callId: call.id,
    counterparty: call.to_number,
    callerId: call.from_number,
    direction: 'outbound',
    startedAt: null,
    muted: false,
    onHold: false,
    merged: false,
    participants: [],
    error: null,
  });

  // The server rings this browser; the engine answers the invite that arrives
  // from our caller ID. Race the invite against the call record: when the
  // browser leg dies as busy/no-answer (SipHangupCause=486 from a second
  // softphone rejecting the fork, or the mic refusing answer) the seller is
  // never dialed and waiting the full 30s for the carrier timeout is worse
  // than saying so immediately.
  let browserLegError: Error | null = null;
  try {
    const leg = await Promise.race([
      engine.connect(call.id, {
        ringServer: () => api.ringBrowserLeg(call.id),
        expectFrom: call.from_number,
      }),
      watchBrowserLeg(call.id, (err) => {
        browserLegError = err;
        engine?.cancelPending();
      }),
    ]);
    activeCall = leg;
    startPolling();
    bindCall(leg, () => patch({ phase: 'wrapup' }));
    // A Cancel that landed as the leg came up found nothing to disconnect yet.
    if (cancelRequested) leg.disconnect();
  } catch (err) {
    throw browserLegError ?? err;
  }
}

/**
 * Resolve only when the server says the browser leg ended before we answered.
 * Never resolves on success — the invite path wins then. `onDead` runs with a
 * clear error so the caller can replace the CANCELLED that cancelPending emits.
 */
function watchBrowserLeg(callId: string, onDead: (err: Error) => void): Promise<EngineCall> {
  return new Promise((_resolve, reject) => {
    const started = Date.now();
    const tick = async () => {
      if (cancelRequested || activeCall) return;
      try {
        const { call } = await api.getCall(callId);
        const terminal = ['busy', 'no_answer', 'failed', 'canceled', 'completed'].includes(call.status);
        // completed with no answer means the client leg died before a PSTN dial.
        if (terminal && !call.answered_at) {
          const err =
            call.status === 'busy'
              ? new Error(
                  'The softphone rejected the carrier ring-back (busy). Close any other Talkr softphone (CLOZR tab or web dialer) registered on this account and try again.',
                )
              : call.status === 'no_answer'
                ? new Error(
                    'The carrier rang this browser but nothing answered. Open the Talkr popup, press Enable softphone, and allow the microphone. Also make sure only one softphone is registered.',
                  )
                : new Error(`The call ended before it could ring (${call.status}).`);
          onDead(err);
          reject(err);
          return;
        }
      } catch {
        /* transient read failure — keep waiting for the invite */
      }
      if (Date.now() - started < 35_000 && !activeCall && !cancelRequested) {
        setTimeout(() => void tick(), 500);
      }
    };
    setTimeout(() => void tick(), 400);
  });
}

function acceptIncoming(): void {
  const call = incomingCall;
  const info = snapshot.incoming;
  stopRingtone();
  if (!call || !info) return;
  incomingCall = null;
  activeCall = call;
  patch({
    incoming: null,
    phase: 'in_call',
    direction: 'inbound',
    counterparty: info.from,
    startedAt: Date.now(),
    muted: false,
  });
  const adopt = (talkrCallId: string) => {
    if (activeCall !== call) return; // hung up before the answer came back
    patch({ callId: talkrCallId });
    startPolling();
  };
  if (call.talkrCallId) {
    adopt(call.talkrCallId);
  } else if (info.from) {
    // A Telnyx invite names the caller, not our call: ask which call is ringing
    // from that number, so wrap-up, hold and transfer work on inbound calls.
    void api
      .ringingCall(info.from)
      .then((r) => adopt(r.call.id))
      .catch(() => undefined);
  }
  bindCall(call, () =>
    // With no Talkr record there is nothing to wrap up; leave nothing of the call behind either.
    patch(
      snapshot.callId ? { phase: 'wrapup' } : { phase: 'idle', counterparty: null, direction: null, startedAt: null },
    ),
  );
  call.accept();
}

/** Run a server-side control, then re-read the roster it changed. */
async function control(fn: (callId: string) => Promise<unknown>): Promise<void> {
  if (!snapshot.callId) return;
  patch({ error: null });
  try {
    await fn(snapshot.callId);
  } catch (err) {
    // A refusal is a mis-click, not a crash: say so and re-sync.
    patch({ error: err instanceof ApiError ? err.message : (err as Error).message });
  }
  await refreshRoster();
}

async function handle(command: Command): Promise<void> {
  switch (command.type) {
    case 'init':
      await initDevice();
      return;
    case 'getSnapshot':
      patch({});
      return;
    case 'call':
      // One call at a time. Without this a second tap while the first is still
      // connecting wiped the first call's id, and hold, transfer and wrap-up with it.
      if (activeCall || !['idle', 'wrapup'].includes(snapshot.phase)) {
        patch({ error: 'Finish the current call first.' });
        return;
      }
      try {
        await placeCall(command.toNumber);
      } catch (err) {
        // A call that is up after all (answered some other way) stays on screen.
        if (activeCall) return;
        const cancelled = (err as Error).message === CANCELLED;
        patch({
          phase: 'idle',
          callId: null,
          counterparty: null,
          callerId: null,
          direction: null,
          error: cancelled ? null : (err as Error).message,
        });
      }
      return;
    case 'hangup':
      if (activeCall) {
        activeCall.disconnect();
      } else if (snapshot.phase === 'connecting' || snapshot.phase === 'ringing') {
        // Nothing to disconnect yet: the carrier has not rung this browser back.
        cancelRequested = true;
        engine?.cancelPending();
      }
      return;
    case 'acceptIncoming':
      acceptIncoming();
      return;
    case 'rejectIncoming':
      stopRingtone();
      incomingCall?.reject();
      incomingCall = null;
      patch({ incoming: null });
      return;
    case 'toggleMute':
      if (activeCall) activeCall.mute(!activeCall.isMuted());
      return;
    case 'digit':
      activeCall?.sendDigits(command.digit);
      return;
    case 'setHold':
      await control((id) => api.setHold(id, command.hold));
      return;
    case 'addParticipant':
      await control((id) =>
        api.addParticipant(id, {
          user_id: command.userId,
          to_number: command.toNumber,
          consult: command.consult,
        }),
      );
      return;
    case 'merge':
      await control((id) => api.mergeCall(id));
      return;
    case 'dropParticipant':
      await control((id) => api.removeParticipant(id, command.providerParticipantId));
      return;
    case 'transfer':
      await control((id) =>
        api.transferCall(id, {
          mode: command.mode,
          user_id: command.userId,
          to_number: command.toNumber,
        }),
      );
      return;
    case 'completeTransfer':
      await control((id) => api.completeTransfer(id));
      return;
    case 'setAudio':
      // The engine owns the media leg, so device selection has to happen here;
      // the UIs only enumerate and ask.
      if (!engine) return;
      try {
        if (command.kind === 'input') {
          await engine.setInputDevice(command.deviceId);
          patch({ audioInputId: command.deviceId, error: null });
        } else {
          await engine.setOutputDevice(command.deviceId);
          patch({ audioOutputId: command.deviceId, error: null });
        }
      } catch (err) {
        patch({ error: `Could not switch audio: ${(err as Error).message}` });
      }
      return;
    case 'setPresence':
      if (command.presence === snapshot.presence) return;
      patch({ presence: command.presence });
      // Talkr hears it now, not at the next 30 s beat, while the phone is up.
      if (engine) beat();
      // Turned on mid-ring: that call goes to voicemail too.
      if (command.presence === 'dnd' && incomingCall) {
        stopRingtone();
        incomingCall.reject();
        incomingCall = null;
        patch({ incoming: null });
      }
      return;
    case 'finishWrapup':
      stopPolling();
      patch({
        phase: 'idle',
        callId: null,
        counterparty: null,
        callerId: null,
        direction: null,
        startedAt: null,
        muted: false,
        onHold: false,
        merged: false,
        participants: [],
        error: null,
      });
      return;
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!isEnvelope<Command>(message, COMMAND_TARGET)) return false;
  // Always answer with the current snapshot so a just-opened UI paints
  // immediately rather than waiting for the next broadcast.
  void handle(message.payload)
    .then(() => sendResponse({ snapshot }))
    .catch((err: Error) => {
      patch({ error: err.message });
      sendResponse({ snapshot });
    });
  return true; // async response
});

/**
 * Follow the session. Signing in brings the softphone up so the first
 * incoming call can ring without the popup being opened; signing out tears
 * it down so a shared machine does not keep ringing for the previous rep.
 */
const bumpInbox = () => patch({ inboxTick: snapshot.inboxTick + 1 });

onSessionChanged((s) => {
  if (s) {
    if (!engine && snapshot.device !== 'initializing') void initDevice();
    startLive(bumpInbox);
    return;
  }
  stopLive();
  stopRingtone();
  if (activeCall) activeCall.disconnect();
  engine?.destroy();
  engine = null;
  activeCall = null;
  incomingCall = null;
  if (heartbeat) clearInterval(heartbeat);
  heartbeat = null;
  clearTimers();
  reregisterAttempt = 0;
  stopPolling();
  patch({ ...EMPTY_SNAPSHOT, presence: snapshot.presence });
});

// Enabling the softphone on load means the first incoming call can ring the
// rep without them having opened the popup first. Without a session this fails
// fast with 'unauthenticated' and the sign-in broadcast retries it.
void initDevice();
// Texts and voicemail alert whether or not the softphone came up (no mic yet).
startLive(bumpInbox);
