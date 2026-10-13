'use client';

/**
 * The merge-field picker: type `/` mid-sentence and a list of the fields this
 * surface accepts opens at the caret, filtered as you keep typing, each row
 * showing what it will actually resolve to for the person you are writing to
 * ("Marisol", not "e.g. Marisol"). Enter, Tab or a click swaps the `/query`
 * for `{first_name}` and puts the caret straight after it.
 *
 * Self-contained: a textarea, a preview, a reference panel, and the pure
 * helpers behind them (lib/mergeFields.ts). No dependency, no portal, no
 * global state — drop `MergeTextArea` in wherever a `<textarea>` is today.
 *
 * The slash only counts at a word boundary, so `https://x/y` and `and/or`
 * never hijack ordinary typing, and a query nothing matches closes the list
 * silently rather than sitting in the way.
 */

import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { FIELD } from './ui';
import {
  MERGE_FIELD_GUIDE,
  insertMergeField,
  matchMergeFields,
  mergeFieldsFor,
  mergeSegments,
  slashQueryAt,
  unknownFieldsIn,
  type MergeFieldSpec,
} from '@/lib/mergeFields';

export {
  MERGE_FIELD_GUIDE,
  insertMergeField,
  matchMergeFields,
  mergeFieldsFor,
  mergeSegments,
  slashQueryAt,
  unknownFieldsIn,
};
export type { MergeFieldSpec, MergeSegment, SlashQuery } from '@/lib/mergeFields';

/** Widest the dropdown gets; it shrinks to the field at 375px. */
const MENU_WIDTH = 320;
const MENU_MAX_HEIGHT = 232;
/** The "?" panel's ceiling, and what it needs below the button to open down. */
const GUIDE_MAX_HEIGHT = 300;

/* ── Caret position ───────────────────────────────────────────────────────── */

/**
 * Layout properties a mirror div needs to wrap text exactly like the textarea
 * does. Kebab-case so they go straight through getPropertyValue/setProperty
 * without a cast.
 */
const MIRROR_PROPS = [
  'width',
  'border-top-width',
  'border-right-width',
  'border-bottom-width',
  'border-left-width',
  'padding-top',
  'padding-right',
  'padding-bottom',
  'padding-left',
  'font-style',
  'font-variant',
  'font-weight',
  'font-stretch',
  'font-size',
  'font-family',
  'line-height',
  'letter-spacing',
  'word-spacing',
  'text-transform',
  'text-indent',
  'text-align',
  'tab-size',
] as const;

interface CaretPoint {
  /** Pixels from the textarea's border box, before scroll is taken off. */
  left: number;
  top: number;
  /** One line, for dropping the menu below the caret's line. */
  height: number;
}

/**
 * Where character `index` sits inside a textarea. Measured by laying the same
 * text out in an off-screen div with the textarea's own metrics — the only
 * way to get a caret rect out of a textarea, and cheap enough to do on each
 * keystroke that opens the menu.
 */
function caretPoint(el: HTMLTextAreaElement, index: number): CaretPoint | null {
  if (typeof document === 'undefined') return null;
  const cs = window.getComputedStyle(el);
  const mirror = document.createElement('div');
  for (const prop of MIRROR_PROPS) mirror.style.setProperty(prop, cs.getPropertyValue(prop));
  // content-box + the copied width keeps the wrap identical whatever the
  // textarea's own box-sizing is; the copied padding/border keep the offsets
  // relative to the same origin.
  mirror.style.boxSizing = 'content-box';
  mirror.style.position = 'absolute';
  mirror.style.top = '0';
  mirror.style.left = '-9999px';
  mirror.style.visibility = 'hidden';
  mirror.style.whiteSpace = 'pre-wrap';
  mirror.style.overflowWrap = 'break-word';
  mirror.style.borderStyle = 'solid';
  mirror.style.height = 'auto';

  mirror.textContent = el.value.slice(0, index);
  const marker = document.createElement('span');
  // Real trailing text, so the marker wraps where the caret would.
  marker.textContent = el.value.slice(index) || '.';
  mirror.appendChild(marker);
  document.body.appendChild(mirror);
  const point: CaretPoint = {
    left: marker.offsetLeft,
    top: marker.offsetTop,
    height: parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.45 || 18,
  };
  document.body.removeChild(mirror);
  return point;
}

/* ── MergeTextArea ────────────────────────────────────────────────────────── */

export interface MergeTextAreaProps {
  value: string;
  /**
   * Gets the next body as a STRING, not a change event — the picker rewrites
   * the value itself, so there is no event to hand back.
   */
  onChange: (value: string) => void;
  /**
   * Real values for the person being written to, keyed by field. A field with
   * a value previews as that value; the rest fall back to the sample.
   */
  values?: Record<string, string>;
  /** Tokens this surface's server accepts. Defaults to the whole catalogue. */
  fields?: readonly string[];
  placeholder?: string;
  rows?: number;
  maxLength?: number;
  disabled?: boolean;
  /** Same as a textarea's: still selectable, but the picker stays shut. */
  readOnly?: boolean;
  id?: string;
  style?: CSSProperties;
  className?: string;
  /** Runs after the picker has had the key; it swallows nothing while closed. */
  onKeyDown?: (e: ReactKeyboardEvent<HTMLTextAreaElement>) => void;
  /**
   * Filled with the underlying element, so a page that already inserts at the
   * caret (the merge-field chips) keeps working unchanged.
   */
  textareaRef?: { current: HTMLTextAreaElement | null };
  'aria-label'?: string;
}

export function MergeTextArea({
  value,
  onChange,
  values,
  fields,
  placeholder,
  rows = 3,
  maxLength,
  disabled = false,
  readOnly = false,
  id,
  style,
  className = '',
  onKeyDown,
  textareaRef,
  'aria-label': ariaLabel,
}: MergeTextAreaProps) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const wrapRef = useRef<HTMLDivElement | null>(null);
  /** Set after an insert; applied once React has painted the new value. */
  const pendingCaret = useRef<number | null>(null);
  /** The `/` index of the run the caret is in, so a dismissal cannot outlive it. */
  const lastStart = useRef<number | null>(null);

  const [caret, setCaret] = useState(0);
  const [focused, setFocused] = useState(false);
  /** The `/` index the user pressed Escape on; suppressed until they move off it. */
  const [dismissed, setDismissed] = useState<number | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [menu, setMenu] = useState<{ left: number; top: number; above: boolean } | null>(null);
  /** Bumped on scroll/resize so the menu re-measures. */
  const [tick, setTick] = useState(0);

  const reactId = useId();
  const listId = `${id ?? reactId}-merge-list`;
  const hintId = `${id ?? reactId}-merge-hint`;

  const fieldsKey = fields ? fields.join(',') : '';
  const active = useMemo(
    () => (focused && !disabled && !readOnly ? slashQueryAt(value, caret) : null),
    [focused, disabled, readOnly, value, caret],
  );
  const matches = useMemo(
    () => (active ? matchMergeFields(active.query, fieldsKey ? fieldsKey.split(',') : undefined) : []),
    [active, fieldsKey],
  );
  const open = active !== null && matches.length > 0 && dismissed !== active.start;

  // A new query starts at the top of its own list.
  useEffect(() => {
    setHighlight(0);
  }, [active?.start, active?.query]);

  // Escape suppresses exactly one `/token`. Leaving that run — a space, a
  // click elsewhere, or a slash somewhere else in the body — arms the picker
  // again, so a dismissal can never get stuck on an index.
  useEffect(() => {
    if (active === null) {
      lastStart.current = null;
      setDismissed(null);
      return;
    }
    if (lastStart.current !== active.start) {
      lastStart.current = active.start;
      setDismissed(null);
    }
  }, [active]);

  // Put the caret back after an insert, and keep focus in the textarea.
  useEffect(() => {
    const next = pendingCaret.current;
    if (next == null) return;
    pendingCaret.current = null;
    const el = ref.current;
    if (!el) return;
    el.focus();
    el.setSelectionRange(next, next);
    setCaret(next);
  });

  useLayoutEffect(() => {
    const el = ref.current;
    const wrap = wrapRef.current;
    if (!open || !el || !wrap || active === null) {
      setMenu(null);
      return;
    }
    const point = caretPoint(el, active.start);
    const width = Math.min(MENU_WIDTH, wrap.clientWidth);
    // No measurement (jsdom, an exotic font stack) still gets a usable menu
    // under the field rather than none at all.
    const anchor = point ?? { left: 0, top: el.clientHeight, height: 0 };
    const left = Math.max(0, Math.min(anchor.left, wrap.clientWidth - width));
    const lineTop = anchor.top - el.scrollTop;
    const rect = el.getBoundingClientRect();
    const spaceBelow = document.documentElement.clientHeight - (rect.top + lineTop + anchor.height);
    const above = spaceBelow < MENU_MAX_HEIGHT && rect.top + lineTop > MENU_MAX_HEIGHT;
    setMenu({ left, top: above ? lineTop : lineTop + anchor.height + 4, above });
  }, [open, active, value, tick]);

  useEffect(() => {
    if (!open) return;
    const bump = () => setTick((t) => t + 1);
    window.addEventListener('resize', bump);
    window.addEventListener('scroll', bump, true);
    return () => {
      window.removeEventListener('resize', bump);
      window.removeEventListener('scroll', bump, true);
    };
  }, [open]);

  const syncCaret = useCallback(() => {
    const el = ref.current;
    if (el) setCaret(el.selectionStart ?? 0);
  }, []);

  const choose = useCallback(
    (spec: MergeFieldSpec) => {
      if (active === null) return;
      const next = insertMergeField(value, caret, spec.field, active.query);
      pendingCaret.current = next.caret;
      setDismissed(null);
      onChange(next.value);
    },
    [active, caret, value, onChange],
  );

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (open && active !== null) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => (h + 1) % matches.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => (h - 1 + matches.length) % matches.length);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setDismissed(active.start);
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const spec = matches[Math.min(highlight, matches.length - 1)];
        if (spec) choose(spec);
        return;
      }
    }
    onKeyDown?.(e);
  };

  const highlighted = matches[Math.min(highlight, matches.length - 1)];

  return (
    <div ref={wrapRef} className="relative min-w-0">
      <textarea
        ref={(el) => {
          ref.current = el;
          if (textareaRef) textareaRef.current = el;
        }}
        id={id}
        className={`min-w-0 w-full ${className}`}
        style={{ ...FIELD, lineHeight: 1.45, resize: 'vertical', ...style }}
        value={value}
        rows={rows}
        maxLength={maxLength}
        disabled={disabled}
        readOnly={readOnly}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-describedby={hintId}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-activedescendant={open && highlighted ? `${listId}-${highlighted.field}` : undefined}
        onChange={(e) => {
          setCaret(e.target.selectionStart ?? e.target.value.length);
          onChange(e.target.value);
        }}
        onSelect={syncCaret}
        onClick={syncCaret}
        onScroll={() => setTick((t) => t + 1)}
        onFocus={() => {
          setFocused(true);
          syncCaret();
        }}
        onBlur={() => setFocused(false)}
        onKeyDown={handleKeyDown}
      />
      <span id={hintId} className="sr-only">
        Type a slash to insert a merge field, for example slash seller for the seller&apos;s first name. Arrow keys
        choose, Enter inserts, Escape closes.
      </span>

      {open && menu && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Merge fields"
          className="absolute z-40 m-0 list-none overflow-y-auto p-1"
          style={{
            left: menu.left,
            ...(menu.above ? { bottom: `calc(100% - ${menu.top}px + 4px)` } : { top: menu.top }),
            width: MENU_WIDTH,
            maxWidth: '100%',
            maxHeight: MENU_MAX_HEIGHT,
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--r-md)',
            boxShadow: 'var(--shadow-lift)',
          }}
        >
          {matches.map((spec, i) => {
            const resolved = values?.[spec.field]?.trim();
            const on = i === Math.min(highlight, matches.length - 1);
            return (
              <li key={spec.field} id={`${listId}-${spec.field}`} role="option" aria-selected={on}>
                <button
                  type="button"
                  tabIndex={-1}
                  className="flex w-full flex-col gap-0.5 text-left"
                  // Keep focus in the textarea so the caret survives the click.
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setHighlight(i)}
                  onClick={() => choose(spec)}
                  style={{
                    padding: '6px 8px',
                    borderRadius: 8,
                    border: 'none',
                    cursor: 'pointer',
                    background: on ? 'var(--panel-2)' : 'transparent',
                  }}
                >
                  <span className="flex w-full min-w-0 items-baseline gap-2">
                    <span className="min-w-0 truncate" style={{ font: '600 12px/1.3 Inter', color: 'var(--text)' }}>
                      {spec.label}
                    </span>
                    <span
                      className="ml-auto shrink-0"
                      style={{ font: '500 10.5px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace', color: 'var(--muted-2)' }}
                    >
                      {`{${spec.field}}`}
                    </span>
                  </span>
                  <span
                    className="w-full truncate"
                    style={{
                      font: '500 11px/1.35 Inter',
                      color: resolved ? 'var(--accent)' : 'var(--muted)',
                    }}
                    title={resolved ?? spec.example}
                  >
                    {resolved ?? `e.g. ${spec.example}`}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/* ── MergePreview ─────────────────────────────────────────────────────────── */

export interface MergePreviewProps {
  body: string;
  values: Record<string, string>;
  /** Tokens this surface accepts; anything else is called out as unknown. */
  fields?: readonly string[];
  className?: string;
  style?: CSSProperties;
}

/**
 * The body as the recipient would read it. A field with no value keeps its
 * token in an amber chip — a visible hole beats a sentence with a gap in it —
 * and fields this surface does not know are listed underneath, because the
 * server rejects them on save.
 */
export function MergePreview({ body, values, fields, className = '', style }: MergePreviewProps) {
  const segments = useMemo(() => mergeSegments(body, values, fields), [body, values, fields]);
  const unknown = useMemo(() => unknownFieldsIn(body, fields), [body, fields]);

  return (
    <div className={`flex min-w-0 flex-col gap-2 ${className}`} style={style}>
      <p style={{ font: '400 12.5px/1.55 Inter', color: 'var(--text)', whiteSpace: 'pre-wrap', margin: 0 }}>
        {body.trim() ? (
          segments.map((seg, i) =>
            seg.kind === 'text' ? (
              <span key={i}>{seg.text}</span>
            ) : seg.kind === 'value' ? (
              <span key={i} style={{ color: 'var(--text)' }}>
                {seg.text}
              </span>
            ) : (
              <span
                key={i}
                title={seg.known ? 'No value for this recipient — it sends as nothing.' : 'Not a field this surface knows.'}
                style={{
                  padding: '1px 5px',
                  borderRadius: 5,
                  background: 'var(--panel-2)',
                  color: 'var(--amber)',
                  font: '600 11px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace',
                }}
              >
                {seg.text}
              </span>
            ),
          )
        ) : (
          <span style={{ color: 'var(--muted)' }}>Nothing to preview yet.</span>
        )}
      </p>
      {unknown.length > 0 && (
        <p style={{ font: '500 11px/1.45 Inter', color: 'var(--amber)', margin: 0 }}>
          Unknown {unknown.length === 1 ? 'field' : 'fields'}: {unknown.map((f) => `{${f}}`).join(', ')} — saving will be
          refused.
        </p>
      )}
    </div>
  );
}

/* ── MergeFieldGuide ──────────────────────────────────────────────────────── */

export interface MergeFieldGuideProps {
  /** Tokens this surface accepts. Defaults to the whole catalogue. */
  fields?: readonly string[];
  /** When given, a field with a value shows that instead of its sample. */
  values?: Record<string, string>;
  className?: string;
  style?: CSSProperties;
}

/** "What can I insert?" — the whole set, learnable without typing `/`. */
export function MergeFieldGuide({ fields, values, className = '', style }: MergeFieldGuideProps) {
  const rows = mergeFieldsFor(fields);
  return (
    <div className={`flex min-w-0 flex-col gap-2 ${className}`} style={style}>
      <p style={{ font: '400 11.5px/1.5 Inter', color: 'var(--muted)', margin: 0 }}>
        Type <code style={{ font: '600 11px/1 ui-monospace, monospace' }}>/</code> anywhere in the message — at the start
        of a word — and pick from the list. <code style={{ font: '600 11px/1 ui-monospace, monospace' }}>/seller</code>{' '}
        finds the first name.
      </p>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {rows.map((spec) => {
          const resolved = values?.[spec.field]?.trim();
          return (
            <li key={spec.field} className="flex min-w-0 flex-col gap-0.5">
              <span className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                <span style={{ font: '600 12px/1.3 Inter' }}>{spec.label}</span>
                <span
                  style={{
                    font: '500 10.5px/1.3 ui-monospace, SFMono-Regular, Menlo, monospace',
                    color: 'var(--muted-2)',
                  }}
                >
                  {`{${spec.field}}`}
                </span>
                <span className="ml-auto truncate" style={{ font: '500 11px/1.3 Inter', color: resolved ? 'var(--accent)' : 'var(--muted-2)' }}>
                  {resolved ?? `e.g. ${spec.example}`}
                </span>
              </span>
              <span style={{ font: '400 11px/1.45 Inter', color: 'var(--muted)' }}>{spec.hint}</span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ── MergeFieldHelp ───────────────────────────────────────────────────────── */

/**
 * The "?" affordance: one control that toggles MergeFieldGuide in an inline
 * popover. Nothing more than a convenience — pages that want the guide always
 * visible should render MergeFieldGuide directly.
 */
export function MergeFieldHelp({ fields, values, label = 'What can I insert?' }: MergeFieldGuideProps & { label?: string }) {
  const [open, setOpen] = useState(false);
  /** Where the panel sits relative to the button, and how wide it may be. */
  const [box, setBox] = useState({ left: 0, width: MENU_WIDTH, above: false });
  const [tick, setTick] = useState(0);
  const boxRef = useRef<HTMLSpanElement | null>(null);

  // The panel starts at the button and slides back inside the viewport — a "?"
  // anywhere on a 375px row keeps its whole panel on screen either way. It also
  // flips above the button when there is no room under it, which is where the
  // affordance sits on a composer pinned to the bottom of the screen.
  useLayoutEffect(() => {
    if (!open) return;
    const rect = boxRef.current?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(MENU_WIDTH, document.documentElement.clientWidth - 16);
    const clamped = Math.min(Math.max(rect.left, 8), Math.max(8, document.documentElement.clientWidth - width - 8));
    const below = document.documentElement.clientHeight - rect.bottom;
    setBox({ left: clamped - rect.left, width, above: below < GUIDE_MAX_HEIGHT && rect.top > below });
  }, [open, tick]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!boxRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const bump = () => setTick((t) => t + 1);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('resize', bump);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', bump);
    };
  }, [open]);

  return (
    <span ref={boxRef} className="relative inline-flex">
      <button
        type="button"
        aria-label={label}
        title={label}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-6 w-6 items-center justify-center"
        style={{
          borderRadius: 999,
          border: '1px solid var(--line)',
          background: open ? 'var(--panel-2)' : 'var(--panel)',
          color: 'var(--muted)',
          font: '700 11px/1 Inter',
          cursor: 'pointer',
        }}
      >
        ?
      </button>
      {open && (
        <div
          className="absolute z-40 overflow-y-auto p-3"
          style={{
            left: box.left,
            ...(box.above ? { bottom: 'calc(100% + 6px)' } : { top: 'calc(100% + 6px)' }),
            width: box.width,
            maxHeight: GUIDE_MAX_HEIGHT,
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--r-md)',
            boxShadow: 'var(--shadow-lift)',
          }}
        >
          <MergeFieldGuide fields={fields} values={values} />
        </div>
      )}
    </span>
  );
}
