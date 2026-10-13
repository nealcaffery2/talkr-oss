/**
 * Finding phone numbers in ordinary page text.
 *
 * This is the whole risk of click-to-call. Miss numbers and the feature is a
 * gimmick; match too eagerly and every order number, invoice total and tracking
 * code on the web turns into a dial button that costs a rep a wrong call. So
 * the rules here are deliberately conservative and the module is pure, with no
 * DOM in it, because the only way to keep that balance honest is to test it.
 *
 * What counts as a number:
 *
 *  - **NANP** (US/Canada), the case that matters for acquisitions: ten digits,
 *    optionally led by 1 or +1, in the usual groupings. The plan's own rules do
 *    most of the filtering for us — an area code and an exchange both start
 *    2–9, and no exchange is N11 — which is what keeps a bare ten-digit run
 *    from matching an account number that happens to be ten digits long.
 *  - **E.164-ish international**: a leading `+`, then 8–15 digits with the
 *    usual separators. The `+` is the evidence; without it we do not guess.
 *
 * What never counts: anything welded to more digits on either side (so
 * `4155550101` inside `14155550101999` is not a match), anything a date or a
 * version string (`2024-05-10`, `1.2.3.4`), and anything whose grouping is not
 * one a person writing a phone number would use.
 */

/** The longest thing we will even consider, so a pathological line is cheap. */
const MAX_CANDIDATE = 24;

/**
 * Candidates, deliberately loose — `isPhoneNumber` does the judging. Kept as a
 * source string so each caller can build its own `RegExp` with its own
 * `lastIndex`; a shared global regex is stateful and a bug waiting to happen.
 */
const CANDIDATE_SOURCE = String.raw`\+?\(?\d[\d\s().\-‐-― /]{6,22}\d`;

export function candidateRegExp(): RegExp {
  return new RegExp(CANDIDATE_SOURCE, 'g');
}

/** Every separator a person might type, normalised away. */
function stripSeparators(raw: string): string {
  return raw.replace(/[\s().\-‐-― /]/g, '');
}

/** NANP: area code and exchange both 2–9, and no N11 exchange (911, 411, …). */
function isValidNanp(ten: string): boolean {
  if (ten.length !== 10) return false;
  const area = ten.slice(0, 3);
  const exchange = ten.slice(3, 6);
  if (!/^[2-9]\d\d$/.test(area)) return false;
  if (!/^[2-9]\d\d$/.test(exchange)) return false;
  // N11 is a service code (411, 611, 911), never a subscriber line.
  if (exchange[1] === '1' && exchange[2] === '1') return false;
  // 555-01xx is the reserved fictional range, but it is exactly what a demo
  // page and our own seed data use, so it stays dialable.
  return true;
}

/**
 * Groupings a person actually writes. A phone number is punctuated in 3-3-4,
 * or not punctuated at all; `2024-05-10` and `1.2.3.4` are neither, and this is
 * what rejects them without having to special-case dates.
 */
function hasPlausibleGrouping(raw: string): boolean {
  const trimmed = raw.trim();
  if (/^\+/.test(trimmed)) return true; // an explicit + is evidence enough
  const groups = trimmed.split(/[\s().\-‐-― /]+/).filter(Boolean);
  if (groups.length === 1) return true; // a bare digit run, judged by NANP rules
  const shape = groups.map((g) => g.length).join('-');
  return NANP_SHAPES.has(shape);
}

/** 3-3-4 and the ways a leading country code is written in front of it. */
const NANP_SHAPES = new Set([
  '3-3-4', // 210 555-0101
  '1-3-3-4', // 1 210 555 0101
  '3-4', // 555-0101 with the area code elsewhere — rejected later for length
  '10', // 2105550101
  '1-10', // 1 2105550101
  '11', // 12105550101
  '3-7', // 210 5550101
  '1-3-7', // 1 210 5550101
]);

export interface PhoneMatch {
  /** Exactly the text that matched, as it appears on the page. */
  text: string;
  /** Index of `text` within the string it was found in. */
  index: number;
  /** E.164, ready to dial. */
  e164: string;
}

/**
 * True when `raw` reads as a phone number. `defaultCountryCode` is the code a
 * bare ten-digit NANP number is dialled with; anything international must
 * carry its own `+`.
 */
export function isPhoneNumber(raw: string): boolean {
  return toE164(raw) !== null;
}

/**
 * `raw` as E.164, or null when it is not a phone number at all. The single
 * place the rules above are applied, so the detector and the dialer can never
 * disagree about what a match means.
 */
export function toE164(raw: string): string | null {
  if (raw.length > MAX_CANDIDATE) return null;
  if (!hasPlausibleGrouping(raw)) return null;
  const trimmed = raw.trim();
  const plus = trimmed.startsWith('+');
  const digits = stripSeparators(plus ? trimmed.slice(1) : trimmed);
  if (!/^\d+$/.test(digits)) return null;

  if (plus) {
    // International, on the strength of the +. E.164 allows up to 15 digits;
    // fewer than 8 is a product code with a plus in front of it, not a number.
    if (digits.length < 8 || digits.length > 15) return null;
    if (digits.startsWith('1')) return isValidNanp(digits.slice(1)) ? `+${digits}` : null;
    return `+${digits}`;
  }
  if (digits.length === 10) return isValidNanp(digits) ? `+1${digits}` : null;
  if (digits.length === 11 && digits.startsWith('1')) {
    return isValidNanp(digits.slice(1)) ? `+${digits}` : null;
  }
  // No country code and not ten digits: we are guessing, so we do not.
  return null;
}

/** True when the character cannot sit next to a phone number. */
function isBoundary(ch: string | undefined): boolean {
  if (ch === undefined) return true;
  // A digit means we cut a longer run in half. The rest are the characters
  // that turn a number into an identifier: 1.2.3.4, ref#2105550101, x2105550101.
  return !/[\d#x]/i.test(ch);
}

/**
 * Every phone number in a run of text, left to right and non-overlapping.
 *
 * Boundaries are checked against the *original* string rather than the match,
 * because the interesting failure is a valid-looking number that is really the
 * middle of something longer.
 */
export function findPhoneNumbers(text: string): PhoneMatch[] {
  if (text.length < 7) return [];
  const out: PhoneMatch[] = [];
  const re = candidateRegExp();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    // The candidate pattern ends on a digit, so the full stop closing a
    // sentence is never part of the match and needs no trimming here.
    const candidate = m[0];
    const start = m.index;
    const end = start + candidate.length;
    if (!isBoundary(text[start - 1]) || !isBoundary(text[end])) {
      // Resume just past this run rather than inside it: the tail of a
      // rejected identifier is not a fresh candidate.
      re.lastIndex = end;
      continue;
    }
    const e164 = toE164(candidate);
    re.lastIndex = end;
    if (e164) out.push({ text: candidate, index: start, e164 });
  }
  return out;
}

/** `tel:` href → E.164, or null. The href is the page telling us outright. */
export function telHrefToE164(href: string): string | null {
  const raw = href.replace(/^tel:/i, '').split(/[;?]/)[0] ?? '';
  const decoded = (() => {
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  })();
  const cleaned = decoded.trim();
  const direct = toE164(cleaned);
  if (direct) return direct;
  // A tel: href is an explicit statement that this is a number, so accept a
  // shape we would not have guessed from prose — but still insist it is one.
  const digits = stripSeparators(cleaned.replace(/^\+/, ''));
  if (!/^\d{7,15}$/.test(digits)) return null;
  return cleaned.startsWith('+') ? `+${digits}` : digits.length === 10 ? `+1${digits}` : `+${digits}`;
}

/** How a number reads back to a person: +1 (210) 555-0101 stays a US number. */
export function formatE164(e164: string): string {
  const m = /^\+1(\d{3})(\d{3})(\d{4})$/.exec(e164);
  return m ? `(${m[1]}) ${m[2]}-${m[3]}` : e164;
}
