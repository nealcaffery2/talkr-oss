/**
 * Shared UI primitives. Small on purpose — the design system's rules are
 * mostly about restraint (hairline borders, soft shadows, de-pilled status),
 * so these encode the rules rather than wrapping every element.
 */

import type { CSSProperties, InputHTMLAttributes, ReactNode, SelectHTMLAttributes, TextareaHTMLAttributes } from 'react';
import { Icon, type IconName } from './Icon';

/**
 * Status is de-pilled: a 6px square swatch plus an uppercase label, never a
 * colored pill (design system readme "Status rule").
 */
export function StatusMarker({
  color,
  label,
  className = '',
}: {
  color: string;
  label: string;
  className?: string;
}) {
  return (
    <span className={`inline-flex items-center gap-1.5 ${className}`}>
      <span style={{ width: 6, height: 6, background: color }} aria-hidden />
      <span
        style={{
          font: '600 9px/1 Inter',
          letterSpacing: '0.1em',
          textTransform: 'uppercase',
          color: 'var(--muted)',
        }}
      >
        {label}
      </span>
    </span>
  );
}

export function Eyebrow({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <span className={`eyebrow ${className}`}>{children}</span>;
}

/** White, hairline border, very soft shadow — no heavy borders, no accent bars. */
export function Card({
  children,
  className = '',
  style,
  padded = true,
  interactive = false,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  padded?: boolean;
  /**
   * The card is a control — the whole of it opens, selects or navigates. Adds
   * the hover lift (globals.css `.lift`). Never set it on a card that is only
   * a container: a surface that rises under the cursor and then does nothing
   * is a promise the app does not keep.
   */
  interactive?: boolean;
}) {
  return (
    <div
      className={`${padded ? 'p-4' : ''} ${interactive ? 'lift' : ''} ${className}`}
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-card)',
        boxShadow: 'var(--shadow-rest)',
        ...style,
      }}
    >
      {children}
    </div>
  );
}

/** Round avatar with initials — the roster's identity mark throughout. */
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
      className="inline-flex shrink-0 items-center justify-center rounded-full"
      style={{
        width: size,
        height: size,
        background: dark ? 'var(--dark-2)' : 'var(--panel-2)',
        color: dark ? '#fff' : 'var(--muted)',
        font: `600 ${Math.round(size * 0.37)}px/1 Inter`,
      }}
      aria-hidden
    >
      {initials(name)}
    </span>
  );
}

/** Up to two initials, skipping tokens that do not start with a letter. */
export function initials(name: string): string {
  return name
    .split(' ')
    .filter((w) => w.length > 0 && /[A-Za-z]/.test(w[0]!))
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
}

export type ButtonTone = 'accent' | 'dark' | 'ghost' | 'green' | 'red' | 'quiet';

const TONES: Record<ButtonTone, CSSProperties> = {
  accent: { background: 'var(--accent)', color: '#fff', border: '1px solid transparent' },
  dark: { background: 'var(--dark-1)', color: '#fff', border: '1px solid transparent' },
  ghost: { background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--line)' },
  green: { background: 'var(--green)', color: '#fff', border: '1px solid transparent' },
  red: { background: 'var(--red)', color: '#fff', border: '1px solid transparent' },
  quiet: { background: 'transparent', color: 'var(--muted)', border: '1px solid transparent' },
};

/** 10px-radius rectangle — the brand is de-pilled throughout. */
export function Button({
  tone = 'ghost',
  children,
  onClick,
  disabled,
  title,
  type = 'button',
  className = '',
  style,
}: {
  tone?: ButtonTone;
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
  type?: 'button' | 'submit';
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`inline-flex items-center justify-center gap-2 transition-transform duration-100 active:translate-y-px disabled:cursor-not-allowed disabled:opacity-45 ${className}`}
      style={{
        borderRadius: 'var(--r-btn)',
        padding: '9px 13px',
        font: '600 12.5px/1 Inter',
        cursor: 'pointer',
        ...TONES[tone],
        ...style,
      }}
    >
      {children}
    </button>
  );
}

/** Toggle switch used across settings. */
export function Toggle({
  on,
  onChange,
  label,
}: {
  on: boolean;
  onChange: (next: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      onClick={() => onChange(!on)}
      style={{
        width: 42,
        height: 24,
        borderRadius: 12,
        border: 'none',
        background: on ? 'var(--accent)' : 'var(--line)',
        cursor: 'pointer',
        position: 'relative',
        transition: 'background .16s',
      }}
    >
      <span
        style={{
          position: 'absolute',
          top: 3,
          left: on ? 21 : 3,
          width: 18,
          height: 18,
          borderRadius: '50%',
          background: '#fff',
          transition: 'left .16s cubic-bezier(.22,1,.36,1)',
        }}
      />
    </button>
  );
}

/** Small segmented control (warm/blind, ring order). */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (next: T) => void;
}) {
  return (
    <div className="flex gap-1 p-0.5" style={{ borderRadius: 8, background: 'var(--panel-2)' }}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          onClick={() => onChange(o.value)}
          style={{
            padding: '5px 9px',
            borderRadius: 6,
            border: 'none',
            cursor: 'pointer',
            font: '600 10.5px/1 Inter',
            background: value === o.value ? 'var(--dark-1)' : 'transparent',
            color: value === o.value ? '#fff' : 'var(--muted)',
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/* ── Form + layout primitives shared by the workspace pages ─────────────── */

/** The one text-field look: hairline border, 10px radius, 12.5px Inter. */
export const FIELD: CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-btn)',
  padding: '9px 11px',
  font: '500 12.5px/1 Inter',
  background: 'var(--panel)',
  color: 'var(--text)',
  outline: 'none',
};

export function Input({
  className = '',
  style,
  ...rest
}: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`min-w-0 ${className}`} style={{ ...FIELD, ...style }} {...rest} />;
}

export function Select({
  className = '',
  style,
  children,
  ...rest
}: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={`min-w-0 ${className}`} style={{ ...FIELD, ...style }} {...rest}>
      {children}
    </select>
  );
}

export function TextArea({
  className = '',
  style,
  ...rest
}: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return (
    <textarea
      className={`min-w-0 ${className}`}
      style={{ ...FIELD, lineHeight: 1.45, resize: 'vertical', ...style }}
      {...rest}
    />
  );
}

/** Eyebrow label stacked over a field. */
export function Labeled({
  label,
  children,
  className = '',
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <label className={`flex min-w-0 flex-col gap-1.5 ${className}`}>
      <Eyebrow>{label}</Eyebrow>
      {children}
    </label>
  );
}

/** KPI tile: eyebrow caption, large tabular number, one-line context. */
export function Kpi({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'amber' | 'red' | 'green';
}) {
  const color = tone === 'amber' ? 'var(--amber)' : tone === 'red' ? 'var(--red)' : tone === 'green' ? 'var(--green)' : 'var(--text)';
  return (
    <Card className="flex flex-col gap-2">
      <Eyebrow>{label}</Eyebrow>
      <span className="display truncate" style={{ font: '700 22px/1 Inter', color }}>
        {value}
      </span>
      {sub && (
        <span className="truncate" style={{ font: '500 10.5px/1.3 Inter', color: 'var(--muted)' }}>
          {sub}
        </span>
      )}
    </Card>
  );
}

/** Card header row: accent icon, title, optional right-hand slot. */
export function SectionTitle({
  icon,
  children,
  right,
}: {
  icon?: ReactNode;
  children: ReactNode;
  right?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-2.5 gap-y-2">
      {icon && <span style={{ color: 'var(--accent)', display: 'inline-flex' }}>{icon}</span>}
      <span className="mr-auto" style={{ font: '700 13.5px/1 Inter', letterSpacing: '-0.01em' }}>
        {children}
      </span>
      {right}
    </div>
  );
}

/** Inline message strip. Errors are red text on white, never a red box. */
export function Notice({
  tone = 'info',
  children,
  className = '',
  action,
}: {
  tone?: 'info' | 'error' | 'warn';
  children: ReactNode;
  className?: string;
  action?: ReactNode;
}) {
  const color = tone === 'error' ? 'var(--red)' : tone === 'warn' ? 'var(--amber)' : 'var(--muted)';
  return (
    <Card className={`flex flex-wrap items-center gap-3 ${className}`} style={{ padding: '11px 14px' }}>
      <span style={{ width: 6, height: 6, background: color, flexShrink: 0 }} aria-hidden />
      <span className="min-w-0 flex-1" style={{ font: '500 12px/1.45 Inter', color: tone === 'info' ? 'var(--text)' : color }}>
        {children}
      </span>
      {action}
    </Card>
  );
}

/**
 * Empty state that reads as "new", not "broken". The one shape every "there is
 * nothing here yet" in the app takes: a quiet glyph, a bold line, a muted hint
 * that says what will fill it, and an optional way to start.
 *
 * `compact` is for an empty state inside a card that already has a heading —
 * same voice, less air, so it does not push a small panel to 200px tall.
 */
export function EmptyState({
  icon = 'template',
  title,
  hint,
  action,
  compact = false,
}: {
  /** The glyph above the title. `null` drops it entirely. */
  icon?: IconName | null;
  title: string;
  hint?: string;
  action?: ReactNode;
  compact?: boolean;
}) {
  return (
    <div
      className={`flex flex-col items-center gap-2 text-center ${compact ? 'px-4 py-6' : 'px-6 py-12'}`}
    >
      {icon && (
        <span
          className="inline-flex items-center justify-center"
          style={{
            width: compact ? 26 : 34,
            height: compact ? 26 : 34,
            borderRadius: 10,
            background: 'var(--panel-2)',
            color: 'var(--muted-2)',
          }}
          aria-hidden
        >
          <Icon name={icon} size={compact ? 13 : 16} />
        </span>
      )}
      <span style={{ font: '600 13px/1 Inter' }}>{title}</span>
      {hint && (
        <span className="max-w-sm" style={{ font: '400 12px/1.5 Inter', color: 'var(--muted)' }}>
          {hint}
        </span>
      )}
      {action && <div className="mt-2">{action}</div>}
    </div>
  );
}

/** Table header strip used above grid rows (same recipe as call history). */
export function GridHead({ cols, minWidth, children }: { cols: string; minWidth?: number; children: ReactNode }) {
  return (
    <div
      className="grid items-center gap-3.5 px-4 py-3"
      style={{ gridTemplateColumns: cols, minWidth, borderBottom: '1px solid var(--line)', background: 'var(--bg)' }}
    >
      {children}
    </div>
  );
}

export function GridRow({
  cols,
  minWidth,
  children,
  className = '',
  style,
}: {
  cols: string;
  minWidth?: number;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div
      className={`grid items-center gap-3.5 px-4 py-3 ${className}`}
      style={{ gridTemplateColumns: cols, minWidth, borderBottom: '1px solid var(--panel-2)', ...style }}
    >
      {children}
    </div>
  );
}

/** Centered modal on a dimmed near-black scrim. */
export function Modal({ title, children, onClose, width = 560 }: { title: string; children: ReactNode; onClose: () => void; width?: number }) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      style={{ background: 'rgba(17,17,17,0.45)' }}
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[90vh] w-full flex-col overflow-hidden"
        style={{ maxWidth: width, background: 'var(--panel)', borderRadius: 'var(--r-lg)', boxShadow: 'var(--shadow-lift)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-5 py-4" style={{ borderBottom: '1px solid var(--line)' }}>
          <span className="mr-auto" style={{ font: '700 14.5px/1 Inter', letterSpacing: '-0.01em' }}>
            {title}
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="inline-flex h-7 w-7 items-center justify-center"
            style={{ borderRadius: 8, border: '1px solid var(--line)', background: 'var(--panel)', color: 'var(--muted)', cursor: 'pointer' }}
          >
            <Icon name="x" size={13} />
          </button>
        </div>
        <div className="min-h-0 overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>
  );
}
