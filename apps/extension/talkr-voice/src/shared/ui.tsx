/**
 * UI primitives for the extension surfaces. Deliberately tiny: two fixed
 * panels do not need a component library, they need the design system's rules
 * (hairlines, de-pilled status, 10px-radius buttons) applied consistently.
 */

import type { CSSProperties, ReactNode } from 'react';

export function initials(name: string): string {
  return name
    .split(' ')
    .filter((w) => w.length > 0 && /[A-Za-z]/.test(w[0]!))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

export function Avatar({
  name,
  size = 30,
  dark = false,
}: {
  name: string;
  size?: number;
  dark?: boolean;
}) {
  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: '50%',
        background: dark ? 'var(--dark-2)' : 'var(--panel-2)',
        color: dark ? '#fff' : 'var(--muted)',
        font: `600 ${Math.round(size * 0.37)}px/1 Inter`,
      }}
    >
      {initials(name)}
    </span>
  );
}

/** Status is a 6px square swatch plus an uppercase label — never a pill. */
export function StatusMarker({
  color,
  label,
  onDark = false,
}: {
  color: string;
  label: string;
  onDark?: boolean;
}) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
      <span style={{ width: 5, height: 5, background: color }} aria-hidden />
      <span
        style={{
          font: '600 9px/1 Inter',
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: onDark ? 'var(--muted)' : 'var(--muted)',
        }}
      >
        {label}
      </span>
    </span>
  );
}

export function Eyebrow({ children }: { children: ReactNode }) {
  return <span className="eyebrow">{children}</span>;
}

export type Tone = 'accent' | 'green' | 'red' | 'ghost' | 'dark';

const TONES: Record<Tone, CSSProperties> = {
  accent: { background: 'var(--accent)', color: '#fff', border: '1px solid transparent' },
  green: { background: 'var(--green)', color: '#fff', border: '1px solid transparent' },
  red: { background: 'var(--red)', color: '#fff', border: '1px solid transparent' },
  ghost: { background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--line)' },
  dark: { background: 'rgba(255,255,255,.04)', color: '#e4e4e7', border: '1px solid var(--dark-2)' },
};

/**
 * `type` defaults to `button` because almost every button here sits outside a
 * form and a bare `<button>` inside one would submit it by accident. The one
 * button that *is* a form's submit (sign-in) has to say so: without it the
 * form has no submit button at all, so neither the click nor Enter submits.
 */
export function Button({
  tone = 'ghost',
  children,
  onClick,
  disabled,
  title,
  style,
  ariaPressed,
  type = 'button',
}: {
  tone?: Tone;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  style?: CSSProperties;
  ariaPressed?: boolean;
  type?: 'button' | 'submit';
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-pressed={ariaPressed}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        borderRadius: 10,
        padding: '9px 12px',
        font: '600 12px/1 Inter',
        opacity: disabled ? 0.45 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
        ...TONES[tone],
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/**
 * A control in the dark call grid: icon over label, lit blue when engaged.
 * Used by both the popup's 3-across grid and the panel's 4-across one.
 */
export function ControlTile({
  icon,
  label,
  active,
  onClick,
  disabled,
  danger,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick: () => void;
  disabled?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      aria-pressed={active}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 6,
        padding: '10px 3px',
        borderRadius: 12,
        border: danger ? 'none' : '1px solid var(--dark-2)',
        background: danger ? 'var(--red)' : active ? 'var(--accent)' : 'rgba(255,255,255,.04)',
        color: danger || active ? '#fff' : '#e4e4e7',
        font: '600 9.5px/1 Inter',
        opacity: disabled ? 0.4 : 1,
        cursor: disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {icon}
      {label}
    </button>
  );
}

/** One fact about a lead — its status, address, condition. A hairline, never a colored pill. */
export function Chip({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        height: 24,
        padding: '0 9px',
        borderRadius: 8,
        border: '1px solid var(--line)',
        background: 'var(--panel)',
        font: '500 11px/1 Inter',
        color: 'var(--text)',
        whiteSpace: 'nowrap',
      }}
    >
      {children}
    </span>
  );
}

export function Card({
  children,
  style,
}: {
  children: ReactNode;
  style?: CSSProperties;
}) {
  return (
    <div
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 12,
        ...style,
      }}
    >
      {children}
    </div>
  );
}
