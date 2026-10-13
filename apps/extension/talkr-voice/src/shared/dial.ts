/**
 * Click-to-call: the protocol between a page and the call.
 *
 * A content script cannot place a call — it has no session, no carrier client,
 * and Chrome would tear it down with the tab. So it does the one thing it is
 * good at, which is spotting a number under the rep's cursor, and asks the
 * service worker to do the rest. The worker is also where the honest refusals
 * come from: no session, no microphone, a call already up. A page that asked
 * to dial deserves to be told which of those happened, because each one has a
 * different next step for the rep.
 */

export const DIAL_REQUEST = 'talkr.dial' as const;

export interface DialRequest {
  type: typeof DIAL_REQUEST;
  /** E.164, already normalised by the detector. */
  e164: string;
  /** How the rep asked, for the toast wording and nothing else. */
  source: 'link' | 'text' | 'selection' | 'context-menu';
}

export type DialRefusal =
  /** Nobody is signed in: the popup's sign-in screen is the fix. */
  | 'signed-out'
  /** Signed in, but the softphone has never been enabled on this profile. */
  | 'no-softphone'
  /** A call is already up; a second one would drop the first. */
  | 'busy'
  /** The server or the carrier said no, with its own words in `message`. */
  | 'refused';

export interface DialResult {
  ok: boolean;
  refusal?: DialRefusal;
  /** Always set when `ok` is false: what to put in front of the rep. */
  message?: string;
}

export function isDialRequest(value: unknown): value is DialRequest {
  const v = value as Partial<DialRequest> | null;
  return v?.type === DIAL_REQUEST && typeof v.e164 === 'string' && v.e164.length > 0;
}

/** What a refusal should say on a page, where there is room for one line. */
export function refusalSentence(result: DialResult): string {
  if (result.message) return result.message;
  switch (result.refusal) {
    case 'signed-out':
      return 'Sign in to Talkr first — open the Talkr toolbar button.';
    case 'no-softphone':
      return 'Enable the softphone once from the Talkr toolbar button, then try again.';
    case 'busy':
      return 'You are already on a call.';
    default:
      return 'Talkr could not place that call.';
  }
}
