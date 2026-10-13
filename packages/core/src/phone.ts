/**
 * E.164 normalization. US/NANP-centric v1 (the first deployment operated in the US);
 * numbers that can't be confidently normalized are returned as-is with
 * ok=false so callers can keep the raw value instead of dropping it.
 */

export interface NormalizedPhone {
  ok: boolean;
  e164: string;
  raw: string;
}

export function normalizePhone(input: string, defaultCountry: 'US' = 'US'): NormalizedPhone {
  const raw = input;
  const trimmed = input.trim();
  const digits = trimmed.replace(/[^\d+]/g, '');
  if (/^\+[1-9]\d{6,14}$/.test(digits)) {
    return { ok: true, e164: digits, raw };
  }
  const bare = digits.replace(/\D/g, '');
  if (defaultCountry === 'US') {
    if (bare.length === 10 && /^[2-9]/.test(bare)) {
      return { ok: true, e164: `+1${bare}`, raw };
    }
    if (bare.length === 11 && bare.startsWith('1') && /^[2-9]/.test(bare.slice(1))) {
      return { ok: true, e164: `+${bare}`, raw };
    }
  }
  return { ok: false, e164: trimmed, raw };
}

/** Last-4 masking for logs (docs/security.md §7). */
export function maskPhone(e164: string): string {
  if (e164.length <= 4) return '****';
  return `…${e164.slice(-4)}`;
}
