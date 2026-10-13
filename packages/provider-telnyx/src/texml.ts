/**
 * TeXML construction.
 *
 * TeXML is Telnyx's TwiML-compatible call-control dialect, so the documents
 * here are deliberately the same shape the Twilio adapter emits. It is written
 * out directly rather than through an SDK: the documents are small, and owning
 * the serializer means the escaping rules are visible instead of assumed.
 *
 * Verified against Telnyx's TeXML verb reference: Say, Play, Gather, Dial,
 * Number, Client, Conference, Record, Hangup, Reject, Enqueue and Pause are
 * supported. Attribute-level differences from TwiML are the residual risk and
 * are called out where they matter.
 */

export type Attrs = Record<string, string | number | boolean | undefined>;

/** XML text escaping. Attribute values additionally escape quotes. */
export function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeAttr(value: string): string {
  return escapeText(value).replace(/"/g, '&quot;');
}

function renderAttrs(attrs: Attrs): string {
  const parts: string[] = [];
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined) continue;
    parts.push(` ${key}="${escapeAttr(String(value))}"`);
  }
  return parts.join('');
}

/** A single element; `children` may be text, nested elements, or both. */
export function el(name: string, attrs: Attrs = {}, children?: string): string {
  const open = `<${name}${renderAttrs(attrs)}`;
  return children === undefined || children === '' ? `${open}/>` : `${open}>${children}</${name}>`;
}

/** Wrap elements in the TeXML document envelope. */
export function texml(...children: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${children.join('')}</Response>`;
}

export const CONTENT_TYPE = 'text/xml';

/**
 * Space-separated event lists (statusCallbackEvent) match TwiML's spelling.
 * Kept as a helper so every call site produces the same form.
 */
export function eventList(events: readonly string[]): string {
  return events.join(' ');
}
