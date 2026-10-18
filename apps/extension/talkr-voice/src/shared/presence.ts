/**
 * The rep's own presence: Available, Do not disturb or Away. CLOZR's picker
 * (Clozr-app lib/talkr-presence.ts), so both read the same three choices.
 *
 * Talkr's floor and transfer lists read presence from the heartbeat
 * (POST /v1/presence: available, away or offline). The offscreen document
 * beats what is picked here, so a rep who sets Away stays Away instead of
 * being flipped back to Available thirty seconds later. Do not disturb is
 * Away to Talkr, and the offscreen document declines a call that rings while
 * it is on, so the caller goes to voicemail. Dialling out still works.
 *
 * Kept in chrome.storage by the service worker (the offscreen document only
 * has chrome.runtime), which hands it to the document whenever it is created.
 */

export type Presence = 'available' | 'dnd' | 'away';

export const PRESENCE_OPTIONS: { value: Presence; label: string; hint: string; color: string }[] = [
  { value: 'available', label: 'Available', hint: 'Calls ring here and teammates can transfer to you', color: 'var(--green)' },
  { value: 'dnd', label: 'Do not disturb', hint: 'Calls go to voicemail; you can still dial out', color: 'var(--red)' },
  { value: 'away', label: 'Away', hint: 'Teammates see you as away; calls still ring', color: 'var(--amber)' },
];

/** The storage key, and the message the UIs send the worker to change it. */
export const PRESENCE_KEY = 'talkr_presence';
export const SET_PRESENCE = 'talkr.presence.set';

export function asPresence(value: unknown): Presence {
  return value === 'dnd' || value === 'away' ? value : 'available';
}

/** What the heartbeat tells Talkr: available only when picked and the phone can actually ring here. */
export function heartbeatStatus(p: Presence, phoneReady: boolean): 'available' | 'away' {
  return p === 'available' && phoneReady ? 'available' : 'away';
}

/** Ask the worker to keep a new presence and pass it to the softphone. */
export function setPresence(presence: Presence): Promise<unknown> {
  return chrome.runtime.sendMessage({ type: SET_PRESENCE, presence }).catch(() => undefined);
}
