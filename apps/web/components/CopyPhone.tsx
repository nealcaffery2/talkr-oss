'use client';

/**
 * Copying a number, everywhere a number is shown.
 *
 * A rep who has just found the seller's line should not have to drag a
 * selection across ten pixels of 11px Inter to paste it into the CRM, the
 * skip-trace tab or a text to their manager. One click, one confirmation,
 * done — so `PhoneText` is the way a number is rendered from here on and
 * `CopyButton` is the same affordance for anything else worth copying.
 *
 * What lands on the clipboard is the E.164 form by default: every other
 * system a rep pastes into wants `+12105550134`, not `(210) 555-0134`.
 * `copyFormat="display"` is the exception, for the rare place a human is
 * going to read the paste.
 *
 * Clipboard access is best-effort by design. `navigator.clipboard` needs a
 * secure context, so a rep on a plain-HTTP staging box falls through to the
 * old `execCommand` path, and if even that is refused the control says
 * "Press Ctrl+C" rather than failing silently. It never throws.
 */

import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon } from './Icon';
import { formatPhone } from '@/lib/time';

/** `dark` is for the near-black call surfaces; everything else is `light`. */
export type CopyTone = 'light' | 'dark';

type CopyState = 'idle' | 'copied' | 'failed';

/** How long the check stays up before the control goes back to itself. */
const COPIED_MS = 1200;
/** The failure hint is read, not glanced at, so it lingers. */
const FAILED_MS = 2600;

const SR_ONLY: CSSProperties = {
  position: 'absolute',
  width: 1,
  height: 1,
  margin: -1,
  padding: 0,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  clipPath: 'inset(50%)',
  whiteSpace: 'nowrap',
  border: 0,
};

const TONES: Record<CopyTone, { idle: string; done: string; border: string; background: string }> = {
  light: {
    idle: 'var(--muted)',
    done: 'var(--green)',
    border: 'var(--line)',
    background: 'var(--panel)',
  },
  dark: {
    idle: '#d4d4d8',
    // The system green is too dark against near-black; this is the same hue, lifted.
    done: '#4ade80',
    border: 'var(--dark-2)',
    background: 'rgba(255, 255, 255, 0.06)',
  },
};

/**
 * The last-resort copy: a throwaway textarea, selected and copied, with the
 * rep's own selection put back afterwards so a half-highlighted transcript is
 * not silently thrown away.
 */
function execCommandCopy(value: string): boolean {
  if (typeof document === 'undefined') return false;
  const area = document.createElement('textarea');
  area.value = value;
  area.setAttribute('readonly', '');
  area.setAttribute('aria-hidden', 'true');
  area.style.position = 'fixed';
  area.style.top = '0';
  area.style.left = '0';
  area.style.width = '1px';
  area.style.height = '1px';
  area.style.padding = '0';
  area.style.border = 'none';
  area.style.opacity = '0';
  document.body.appendChild(area);

  const selection = document.getSelection();
  const previous = selection && selection.rangeCount > 0 ? selection.getRangeAt(0) : null;
  try {
    area.select();
    area.setSelectionRange(0, value.length);
    return document.execCommand('copy');
  } catch {
    return false;
  } finally {
    area.remove();
    if (selection && previous) {
      selection.removeAllRanges();
      selection.addRange(previous);
    }
  }
}

/** True when the value reached the clipboard. Never throws. */
export async function copyText(value: string): Promise<boolean> {
  if (!value) return false;
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Insecure context, a denied permission, or no user gesture — try the old way.
  }
  return execCommandCopy(value);
}

export interface CopyButtonProps {
  /** Exactly what lands on the clipboard. */
  value: string;
  /** Accessible name and tooltip. Defaults to `Copy <value>`. */
  label?: string;
  /** Edge of the square button, in px. The glyph scales with it. */
  size?: number;
  tone?: CopyTone;
}

/**
 * Icon button that copies `value` and flips to a check for ~1.2s. The
 * confirmation is announced too, because the visual flip is invisible to a
 * rep driving the page from the keyboard.
 */
export function CopyButton({ value, label, size = 22, tone = 'light' }: CopyButtonProps) {
  const [state, setState] = useState<CopyState>('idle');
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  const copy = useCallback(() => {
    void copyText(value).then((ok) => {
      setState(ok ? 'copied' : 'failed');
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => setState('idle'), ok ? COPIED_MS : FAILED_MS);
    });
  }, [value]);

  const colors = TONES[tone];
  const name = label ?? (value ? `Copy ${value}` : 'Copy');
  const announcement = state === 'copied' ? 'Copied' : state === 'failed' ? 'Press Ctrl+C to copy' : '';

  return (
    <span style={{ position: 'relative', display: 'inline-flex', flexShrink: 0 }}>
      <button
        type="button"
        className="copy-affordance inline-flex shrink-0 items-center justify-center"
        data-state={state}
        aria-label={name}
        title={state === 'failed' ? 'Copying is blocked here — press Ctrl+C' : name}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          copy();
        }}
        style={{
          width: size,
          height: size,
          borderRadius: Math.max(6, Math.round(size * 0.3)),
          border: `1px solid ${colors.border}`,
          background: colors.background,
          color: state === 'copied' ? colors.done : colors.idle,
          cursor: 'pointer',
          padding: 0,
        }}
      >
        <Icon name={state === 'copied' ? 'check' : 'copy'} size={Math.max(10, Math.round(size * 0.55))} />
      </button>
      {state === 'failed' && (
        <span
          role="presentation"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 5px)',
            left: '50%',
            transform: 'translateX(-50%)',
            padding: '4px 7px',
            borderRadius: 6,
            background: 'var(--ink)',
            color: '#fff',
            font: '600 10px/1.2 Inter',
            whiteSpace: 'nowrap',
            pointerEvents: 'none',
            zIndex: 20,
            boxShadow: 'var(--shadow-lift)',
          }}
        >
          Press Ctrl+C
        </span>
      )}
      <span aria-live="polite" style={SR_ONLY}>
        {announcement}
      </span>
    </span>
  );
}

export interface PhoneTextProps {
  /** The stored number, `+12105550134`. Also what gets copied by default. */
  e164: string;
  /** Override the rendered text; the default is `formatPhone(e164)`. */
  display?: string;
  /** Off for the few places the control would not fit. Defaults to on. */
  showCopy?: boolean;
  /** Reps paste into other systems, so E.164 unless told otherwise. */
  copyFormat?: 'e164' | 'display';
  /** Edge of the copy button, in px. */
  size?: number;
  tone?: CopyTone;
  className?: string;
  style?: CSSProperties;
}

/**
 * A number as the product shows it — "(210) 555-0134" — with the copy control
 * beside it. The number never wraps: it truncates and the button holds its
 * place, so a narrow table column loses characters rather than layout.
 */
export function PhoneText({
  e164,
  display,
  showCopy = true,
  copyFormat = 'e164',
  size = 22,
  tone = 'light',
  className = '',
  style,
}: PhoneTextProps) {
  const text = display ?? formatPhone(e164) ?? e164;
  const value = copyFormat === 'display' ? text : e164;

  return (
    <span className={`copy-host inline-flex min-w-0 max-w-full items-center gap-1.5 ${className}`} style={style}>
      <span className="truncate" style={{ whiteSpace: 'nowrap' }}>
        {text}
      </span>
      {showCopy && e164 ? <CopyButton value={value} label={`Copy ${text}`} size={size} tone={tone} /> : null}
    </span>
  );
}
