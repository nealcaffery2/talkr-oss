/**
 * The carrier-less deployment (`VOICE_PROVIDER=none`).
 *
 * Everything that is not a phone call — the inbox and its history, leads,
 * tasks, reports, the team board, workflows — is worth testing before a
 * carrier account exists, and a server that refuses to boot without carrier
 * keys makes that impossible. This provider lets the server boot instead: it
 * accepts no webhooks, mints no tokens, and turns every attempt to reach a
 * carrier into one plain error naming the switch, so "not configured" is
 * never mistaken for "broken".
 */

import type { MessagingProvider, VoiceProvider } from '@talkr/core';

export class NoCarrierError extends Error {
  readonly code = 'no_carrier';
  constructor() {
    super(
      'No carrier is configured on this server (VOICE_PROVIDER=none). ' +
        'Set VOICE_PROVIDER=telnyx with its credentials to place calls and send texts.',
    );
  }
}

export class NullProvider implements VoiceProvider, MessagingProvider {
  readonly name = 'none' as const;

  private refuse(): never {
    throw new NoCarrierError();
  }

  // A webhook nobody could have sent is never valid.
  validateWebhook(): boolean {
    return false;
  }
  idempotencyKey(): string {
    return this.refuse();
  }
  normalizeWebhook(): never {
    return this.refuse();
  }
  mintClientToken(): never {
    return this.refuse();
  }
  formatClientAddress(): never {
    return this.refuse();
  }
  buildOutboundDialResponse(): never {
    return this.refuse();
  }
  buildHangupResponse(): never {
    return this.refuse();
  }
  buildConferenceResponse(): never {
    return this.refuse();
  }
  async fetchCall(): Promise<never> {
    return this.refuse();
  }
  async hangupCall(): Promise<never> {
    return this.refuse();
  }
  async redirectCall(): Promise<never> {
    return this.refuse();
  }
  async createCall(): Promise<never> {
    return this.refuse();
  }
  async cancelCall(): Promise<never> {
    return this.refuse();
  }
  async addParticipant(): Promise<never> {
    return this.refuse();
  }
  async updateParticipant(): Promise<never> {
    return this.refuse();
  }
  async removeParticipant(): Promise<never> {
    return this.refuse();
  }
  async listParticipants(): Promise<never> {
    return this.refuse();
  }
  async sendMessage(): Promise<never> {
    return this.refuse();
  }
}
