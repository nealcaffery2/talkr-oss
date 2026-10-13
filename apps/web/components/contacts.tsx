/**
 * The vocabulary the Contacts list and detail pages share: labels and colours
 * for type / status / temperature, the small badges that render them, and the
 * merge-field rules a bulk text is previewed with.
 */

import { useState, type CSSProperties, type ReactNode } from 'react';
import {
  ApiError,
  type ContactAddressDto,
  type ContactDto,
  type ContactStatus,
  type ContactType,
  type Temperature,
} from '@/lib/api';
import { Icon, type IconName } from './Icon';
import { FIELD } from './ui';

export const TYPE_LABEL: Record<ContactType, string> = {
  seller: 'Seller',
  buyer: 'Buyer',
  title: 'Title',
  company: 'Company',
  vendor: 'Vendor',
  other: 'Other',
};

export const STATUS_LABEL: Record<ContactStatus, string> = {
  new: 'New',
  attempting: 'Attempting',
  engaged: 'Engaged',
  appointment: 'Appointment',
  offer: 'Offer',
  under_contract: 'Under contract',
  closed: 'Closed',
  dead: 'Dead',
  dnc: 'DNC',
};

export const STATUS_COLOR: Record<ContactStatus, string> = {
  new: 'var(--accent)',
  attempting: 'var(--amber)',
  engaged: 'var(--green)',
  appointment: 'var(--green)',
  offer: 'var(--green)',
  under_contract: 'var(--green)',
  closed: 'var(--muted)',
  dead: 'var(--muted-2)',
  dnc: 'var(--red)',
};

export const TEMP_LABEL: Record<Temperature, string> = { hot: 'Hot', warm: 'Warm', cold: 'Cold' };

/** Hot red, warm amber, cold slate — the same language the message templates use. */
export const TEMP_COLOR: Record<Temperature, string> = {
  hot: 'var(--red)',
  warm: 'var(--amber)',
  cold: '#64748b',
};

/* ── Temperature as a temperature ─────────────────────────────────────────── */

/**
 * The score is a temperature, so it is read as one: `85°`, not `85`. The server
 * still stores and returns a plain 0–100 integer — this is purely how it reads.
 */
export function degrees(score: number): string {
  return `${Math.round(score)}°`;
}

/**
 * The rendering bands. `hot | warm | cold` are the server's own three, with
 * their thresholds and colours untouched; `scalding` is a fourth *display*
 * band sitting on top of hot, for the lead a rep should stop what they are
 * doing and call.
 */
export type TempBand = Temperature | 'scalding';

/** A hot lead at or above this reads as scalding. Display only — nothing server-side moves. */
export const SCALDING_SCORE = 80;

/**
 * Scalding is deliberately a *narrowing* of hot, never of warm or cold: a
 * temperature set by hand must not be overruled by a score that no longer
 * drives it. A hand-locked "Cold" at 95 stays cold, and stays believable.
 */
export function tempBand(temperature: Temperature, score: number): TempBand {
  return temperature === 'hot' && Math.round(score) >= SCALDING_SCORE ? 'scalding' : temperature;
}

export const BAND_LABEL: Record<TempBand, string> = { ...TEMP_LABEL, scalding: 'Scalding' };

/**
 * Scalding takes the brand red — brighter and more saturated than the semantic
 * red "hot" wears, so the two are separable at a glance in a column of badges
 * without adding a fifth hue to the system.
 */
export const BAND_COLOR: Record<TempBand, string> = { ...TEMP_COLOR, scalding: 'var(--accent)' };

/** Types that are an organisation first and a person second. */
export function isOrgType(type: ContactType): boolean {
  return type === 'title' || type === 'company' || type === 'vendor';
}

export function firstName(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? '';
}

/** "1207 Elm St, Austin, TX 78702" — or nothing, never a row of commas. */
export function oneLineAddress(a: ContactAddressDto | null): string {
  if (!a) return '';
  const cityState = [a.city, a.state].filter(Boolean).join(', ');
  const tail = [cityState, a.postal_code].filter(Boolean).join(' ');
  return [a.line1, tail].filter(Boolean).join(', ');
}

export function isForbidden(e: unknown): boolean {
  return e instanceof ApiError && e.status === 403;
}

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : 'Something went wrong';
}

/* ── Badges ───────────────────────────────────────────────────────────────── */

const CHIP: CSSProperties = {
  padding: '2.5px 6px',
  borderRadius: 5,
  font: '700 8.5px/1 Inter',
  letterSpacing: '0.07em',
  textTransform: 'uppercase',
  whiteSpace: 'nowrap',
};

export function TypeBadge({ type }: { type: ContactType }) {
  const org = isOrgType(type);
  return (
    <span style={{ ...CHIP, background: org ? 'var(--panel-2)' : 'var(--accent-soft)', color: org ? 'var(--muted)' : 'var(--accent)' }}>
      {TYPE_LABEL[type]}
    </span>
  );
}

/** De-pilled status: swatch plus uppercase label. */
export function StatusMark({ status }: { status: ContactStatus }) {
  return (
    <span className="inline-flex items-center gap-1.5" style={{ whiteSpace: 'nowrap' }}>
      <span style={{ width: 6, height: 6, background: STATUS_COLOR[status], flexShrink: 0 }} aria-hidden />
      <span style={{ font: '600 9px/1 Inter', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--muted)' }}>
        {STATUS_LABEL[status]}
      </span>
    </span>
  );
}

/**
 * The temperature swatch. Pass `score` and a scalding lead gets the brand red
 * plus a thin halo — the same dot, one step louder, so it still reads as one
 * mark in a dense row rather than a second badge.
 */
export function TempDot({
  temperature,
  size = 8,
  score,
}: {
  temperature: Temperature;
  size?: number;
  /** Optional: without it the dot shows the plain three-band colour. */
  score?: number;
}) {
  const band = score === undefined ? temperature : tempBand(temperature, score);
  const color = BAND_COLOR[band];
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: color,
        flexShrink: 0,
        display: 'inline-block',
        // The accent (#ff233b) at 22%: a halo, not a second ring to read.
        boxShadow: band === 'scalding' ? '0 0 0 2px rgba(255, 35, 59, 0.22)' : undefined,
      }}
      aria-hidden
    />
  );
}

export function TemperatureBadge({
  temperature,
  score,
  locked,
}: {
  temperature: Temperature;
  score: number;
  locked?: boolean;
}) {
  const band = tempBand(temperature, score);
  const color = BAND_COLOR[band];
  const scalding = band === 'scalding';
  return (
    <span
      className="inline-flex items-center gap-1.5"
      title={
        locked
          ? `Temperature set by hand at ${degrees(score)} — the score no longer moves it`
          : scalding
            ? `${degrees(score)} — scalding, call this one first`
            : `${degrees(score)} engagement score`
      }
      style={{ whiteSpace: 'nowrap' }}
    >
      <TempDot temperature={temperature} score={score} />
      <span style={{ font: '700 11px/1 Inter', color }}>{BAND_LABEL[band]}</span>
      {/* The number is the point, so a scalding lead states it in its own
          colour instead of the usual quiet grey. */}
      <span style={{ font: `${scalding ? 700 : 500} 10.5px/1 Inter`, color: scalding ? color : 'var(--muted-2)' }}>
        {degrees(score)}
      </span>
      {locked && (
        <span aria-label="Locked" title="Locked" style={{ font: '600 8.5px/1 Inter', letterSpacing: '0.08em', color: 'var(--muted-2)' }}>
          LOCK
        </span>
      )}
    </span>
  );
}

/** A tag as it appears everywhere: quiet, rectangular, optionally removable. */
export function TagChip({ children, onRemove }: { children: ReactNode; onRemove?: () => void }) {
  return (
    <span
      className="inline-flex items-center gap-1"
      style={{
        padding: onRemove ? '3px 4px 3px 8px' : '3px 8px',
        borderRadius: 6,
        border: '1px solid var(--line)',
        background: 'var(--panel)',
        font: '600 10.5px/1 Inter',
        color: 'var(--text)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
      {onRemove && (
        <button
          type="button"
          onClick={onRemove}
          aria-label="Remove tag"
          className="inline-flex h-4 w-4 items-center justify-center"
          style={{ borderRadius: 4, color: 'var(--muted)', cursor: 'pointer' }}
        >
          ×
        </button>
      )}
    </span>
  );
}

/** Filter chip: a small rectangular toggle with an optional count. */
export function FilterChip({
  active,
  onClick,
  children,
  count,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
  count?: number;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className="inline-flex items-center gap-1.5"
      style={{
        padding: '6px 10px',
        borderRadius: 8,
        border: `1px solid ${active ? 'var(--dark-1)' : 'var(--line)'}`,
        background: active ? 'var(--dark-1)' : 'var(--panel)',
        color: active ? '#fff' : 'var(--text)',
        font: '600 11px/1 Inter',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
      {count !== undefined && (
        <span style={{ font: '600 10px/1 Inter', color: active ? 'rgba(255,255,255,.7)' : 'var(--muted-2)' }}>{count}</span>
      )}
    </button>
  );
}

/** 28px square icon button — the row-level action everywhere in the table. */
export function IconButton({
  label,
  icon,
  onClick,
  disabled,
  title,
  accent = false,
  danger = false,
}: {
  label: string;
  icon: IconName;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  accent?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      disabled={disabled}
      onClick={onClick}
      className="inline-flex h-7 w-7 shrink-0 items-center justify-center disabled:cursor-not-allowed disabled:opacity-40"
      style={{
        borderRadius: 8,
        border: '1px solid var(--line)',
        background: 'var(--panel)',
        color: danger ? 'var(--red)' : accent ? 'var(--accent)' : 'var(--muted)',
        cursor: 'pointer',
      }}
    >
      <Icon name={icon} size={13} />
    </button>
  );
}

/** Tags as chips plus an input; Enter or a comma commits, Backspace on empty pops. */
export function TagsField({
  tags,
  onChange,
  placeholder = 'Add a tag',
  disabled,
}: {
  tags: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  const [draft, setDraft] = useState('');

  const commit = (raw: string) => {
    const next = raw
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0 && !tags.includes(t));
    if (next.length > 0) onChange([...tags, ...next]);
    setDraft('');
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5" style={{ ...FIELD, padding: '5px 8px' }}>
      {tags.map((t) => (
        <TagChip key={t} onRemove={disabled ? undefined : () => onChange(tags.filter((x) => x !== t))}>
          {t}
        </TagChip>
      ))}
      <input
        value={draft}
        disabled={disabled}
        onChange={(e) => {
          if (e.target.value.includes(',')) commit(e.target.value);
          else setDraft(e.target.value);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit(draft);
          } else if (e.key === 'Backspace' && draft === '' && tags.length > 0) {
            onChange(tags.slice(0, -1));
          }
        }}
        onBlur={() => {
          if (draft.trim()) commit(draft);
        }}
        placeholder={tags.length === 0 ? placeholder : ''}
        aria-label="Tags"
        className="min-w-[80px] flex-1 bg-transparent outline-none"
        style={{ font: '500 12.5px/1 Inter', padding: '4px 2px' }}
      />
    </div>
  );
}

/* ── Merge fields ─────────────────────────────────────────────────────────── */

export const MERGE_FIELDS: Array<{ token: string; label: string }> = [
  { token: '{first_name}', label: 'First name' },
  { token: '{name}', label: 'Name' },
  { token: '{address}', label: 'Address' },
  { token: '{city}', label: 'City' },
  { token: '{rep_name}', label: 'Rep' },
];

/** What the server will send, as best the browser can tell. */
export function renderMergeFields(body: string, c: ContactDto | null, repName: string | null): string {
  const values: Record<string, string> = {
    first_name: c ? firstName(c.display_name) : '',
    name: c?.display_name ?? '',
    address: c?.address?.line1 ?? '',
    city: c?.address?.city ?? '',
    rep_name: c?.assigned_user_name ?? repName ?? '',
  };
  return body.replace(/\{(first_name|name|address|city|rep_name)\}/g, (_m, key: string) => values[key] ?? '');
}

/**
 * GSM-7 packs 160 into one segment (153 each after); anything else is UCS-2 at
 * 70/67. `chars` counts UTF-16 units, which is what a carrier counts too — an
 * emoji outside the BMP is two of them, so one 😀 in a 90-character message is
 * the difference between one segment and two.
 */
// eslint-disable-next-line no-control-regex -- the GSM basic set is mostly ASCII
const GSM7_CHAR = /^[\x00-\x7F£¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ¤¡ÄÖÑÜ§¿äöñüà€]$/;

/**
 * The first character that will not fit GSM-7, or null when the whole message
 * does. It is what a counter should name when a text quietly doubles in price:
 * an emoji, a smart quote a word processor introduced, an em dash.
 */
export function firstNonGsmChar(text: string): string | null {
  for (const ch of text) if (!GSM7_CHAR.test(ch)) return ch;
  return null;
}

export function smsSegments(text: string): {
  chars: number;
  segments: number;
  encoding: 'gsm7' | 'ucs2';
} {
  const chars = text.length;
  if (chars === 0) return { chars: 0, segments: 0, encoding: 'gsm7' };
  const gsm = firstNonGsmChar(text) === null;
  const single = gsm ? 160 : 70;
  const multi = gsm ? 153 : 67;
  return {
    chars,
    segments: chars <= single ? 1 : Math.ceil(chars / multi),
    encoding: gsm ? 'gsm7' : 'ucs2',
  };
}
