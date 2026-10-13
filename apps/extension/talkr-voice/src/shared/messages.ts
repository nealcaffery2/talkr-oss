/**
 * The protocol between the three contexts.
 *
 * MV3 destroys a popup the moment it closes and can evict the service worker
 * at any time, so neither can own a phone call. The carrier client lives in an
 * offscreen document — the one context that survives both — and the popup and
 * side panel are thin views that send commands to it and render the snapshots
 * it broadcasts back.
 */

import type { ParticipantDto } from './api';
import type { EngineKind } from '@/offscreen/engine';

export type CallPhase = 'idle' | 'connecting' | 'ringing' | 'in_call' | 'wrapup';
export type DeviceStatus = 'uninitialized' | 'initializing' | 'ready' | 'error';

/** Everything both UIs render. One shape, broadcast on every change. */
export interface CallSnapshot {
  device: DeviceStatus;
  deviceError: string | null;
  /** The carrier the server chose, once a token has said so. */
  provider: EngineKind | null;
  phase: CallPhase;
  /** Our call id, once the server has one. */
  callId: string | null;
  /** The number on the other end, E.164. */
  counterparty: string | null;
  /** Caller ID we are presenting. */
  callerId: string | null;
  direction: 'inbound' | 'outbound' | null;
  muted: boolean;
  onHold: boolean;
  merged: boolean;
  /** Epoch ms the media leg connected, for the timer. */
  startedAt: number | null;
  participants: ParticipantDto[];
  /** Set when a control was refused; cleared on the next successful one. */
  error: string | null;
  incoming: { from: string; contactName: string | null } | null;
  /** Selected devices, or null for the browser default. */
  audioInputId: string | null;
  audioOutputId: string | null;
}

export const EMPTY_SNAPSHOT: CallSnapshot = {
  device: 'uninitialized',
  deviceError: null,
  provider: null,
  phase: 'idle',
  callId: null,
  counterparty: null,
  callerId: null,
  direction: null,
  muted: false,
  onHold: false,
  merged: false,
  startedAt: null,
  participants: [],
  error: null,
  incoming: null,
  audioInputId: null,
  audioOutputId: null,
};

/** UI → offscreen. */
export type Command =
  | { type: 'init' }
  | { type: 'getSnapshot' }
  | { type: 'call'; toNumber: string }
  | { type: 'hangup' }
  | { type: 'acceptIncoming' }
  | { type: 'rejectIncoming' }
  | { type: 'toggleMute' }
  | { type: 'digit'; digit: string }
  | { type: 'setHold'; hold: boolean }
  | { type: 'addParticipant'; userId?: string; toNumber?: string; consult: boolean }
  | { type: 'merge' }
  | { type: 'dropParticipant'; providerParticipantId: string }
  | { type: 'transfer'; mode: 'warm' | 'blind'; userId?: string; toNumber?: string }
  | { type: 'completeTransfer' }
  | { type: 'finishWrapup' }
  /** Route the call's audio to a different microphone or speaker. */
  | { type: 'setAudio'; kind: 'input' | 'output'; deviceId: string };

/** Offscreen → everyone. */
export interface SnapshotBroadcast {
  type: 'snapshot';
  snapshot: CallSnapshot;
}

/** Service worker → offscreen, to make sure the document exists first. */
export interface EnsureOffscreen {
  type: 'ensureOffscreen';
}

export type RuntimeMessage = Command | SnapshotBroadcast | EnsureOffscreen;

/** Commands are addressed to the offscreen document, never handled elsewhere. */
export const COMMAND_TARGET = 'talkr-offscreen';

export interface Envelope<T> {
  target: string;
  payload: T;
}

export function envelope<T>(payload: T, target = COMMAND_TARGET): Envelope<T> {
  return { target, payload };
}

export function isEnvelope<T>(value: unknown, target: string): value is Envelope<T> {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Envelope<T>).target === target &&
    'payload' in value
  );
}
