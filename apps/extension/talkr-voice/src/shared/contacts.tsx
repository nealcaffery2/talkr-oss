/**
 * The contact vocabulary — labels and colours for type / status / temperature
 * and the small badges that render them. Kept in step with
 * apps/web/components/contacts.tsx by hand so a "hot" seller looks the same
 * in the CRM and in the panel beside it; the extension cannot import across
 * app boundaries.
 */

import type { CSSProperties, ReactNode } from 'react';
import type { ContactAddressDto, ContactStatus, ContactType, Temperature } from './api';

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

/** Types that are an organisation first and a person second. */
export function isOrgType(type: ContactType): boolean {
  return type === 'title' || type === 'company' || type === 'vendor';
}

/** "1207 Elm St, Austin, TX 78702" — or nothing, never a row of commas. */
export function oneLineAddress(a: ContactAddressDto | null | undefined): string {
  if (!a) return '';
  const cityState = [a.city, a.state].filter(Boolean).join(', ');
  const tail = [cityState, a.postal_code].filter(Boolean).join(' ');
  return [a.line1, tail].filter(Boolean).join(', ');
}

/** "under_contract" → "Under contract", for anything the server sends as an enum. */
export function humanize(value: string): string {
  const s = value.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/* ── Badges ───────────────────────────────────────────────────────────────── */

const CHIP: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
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
    <span
      style={{
        ...CHIP,
        background: org ? 'var(--panel-2)' : 'var(--accent-soft)',
        color: org ? 'var(--muted)' : 'var(--accent)',
      }}
    >
      {TYPE_LABEL[type] ?? humanize(type)}
    </span>
  );
}

/** De-pilled status: swatch plus uppercase label. */
export function StatusMark({ status }: { status: ContactStatus }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}>
      <span
        style={{ width: 6, height: 6, background: STATUS_COLOR[status] ?? 'var(--muted-2)', flexShrink: 0 }}
        aria-hidden
      />
      <span style={{ font: '600 9px/1 Inter', letterSpacing: '0.1em', textTransform: 'uppercase', color: 'var(--muted)' }}>
        {STATUS_LABEL[status] ?? humanize(status)}
      </span>
    </span>
  );
}

export function TempDot({ temperature, size = 8 }: { temperature: Temperature; size?: number }) {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: TEMP_COLOR[temperature] ?? 'var(--muted-2)',
        flexShrink: 0,
        display: 'inline-block',
      }}
      aria-hidden
    />
  );
}

export function TemperatureBadge({
  temperature,
  score,
  locked,
  onDark = false,
}: {
  temperature: Temperature;
  score?: number;
  locked?: boolean;
  onDark?: boolean;
}) {
  const color = TEMP_COLOR[temperature] ?? 'var(--muted-2)';
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, whiteSpace: 'nowrap' }}
      title={locked ? 'Temperature set by hand — the score no longer moves it' : score != null ? `Score ${Math.round(score)}` : undefined}
    >
      <TempDot temperature={temperature} />
      <span style={{ font: '700 11px/1 Inter', color: onDark && temperature === 'cold' ? '#94a3b8' : color }}>
        {TEMP_LABEL[temperature] ?? humanize(temperature)}
      </span>
      {score != null && (
        <span style={{ font: '500 10.5px/1 Inter', color: 'var(--muted-2)' }}>{Math.round(score)}</span>
      )}
      {locked && (
        <span
          aria-label="Locked"
          title="Locked"
          style={{ font: '600 8.5px/1 Inter', letterSpacing: '0.08em', color: 'var(--muted-2)' }}
        >
          LOCK
        </span>
      )}
    </span>
  );
}

/** A tag as it appears everywhere: quiet, rectangular. */
export function TagChip({
  children,
  active = false,
  onClick,
}: {
  children: ReactNode;
  active?: boolean;
  onClick?: () => void;
}) {
  const style: CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 4,
    padding: '3px 8px',
    borderRadius: 6,
    border: `1px solid ${active ? 'var(--dark-1)' : 'var(--line)'}`,
    background: active ? 'var(--dark-1)' : 'var(--panel)',
    font: '600 10.5px/1 Inter',
    color: active ? '#fff' : 'var(--text)',
    whiteSpace: 'nowrap',
  };
  if (onClick) {
    return (
      <button type="button" onClick={onClick} aria-pressed={active} style={style}>
        {children}
      </button>
    );
  }
  return <span style={style}>{children}</span>;
}
