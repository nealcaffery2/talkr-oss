'use client';

/**
 * Emoji for the SMS composer.
 *
 * Sellers text with emoji, so reps have to be able to answer in kind — a
 * thumbs-up is half the replies in an acquisitions thread. This is deliberately
 * a curated set rather than a dependency: the full Unicode table is ~3,800
 * glyphs and a picker library is ~200 KB of JavaScript for a control that gets
 * used to say "👍".
 *
 * What a rep picks is remembered in `localStorage` (per browser, never sent
 * anywhere) and offered back on the top row, because in practice a rep reuses
 * the same six.
 *
 * Emoji is never iconography here — the product's own glyphs are in Icon.tsx.
 * These are message content, which is why they live in their own control.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Icon } from './Icon';

const RECENTS_KEY = 'talkr.emoji.recents';
const RECENTS_MAX = 16;

interface EmojiGroup {
  name: string;
  emoji: string[];
}

/** ~120 emoji: what a rep and a seller actually trade, in five plain groups. */
export const EMOJI_GROUPS: EmojiGroup[] = [
  {
    name: 'Smileys',
    emoji: [
      '😀', '😁', '😂', '🤣', '😊', '😇', '🙂', '😉',
      '😍', '🥰', '😘', '😎', '🤩', '🥳', '😏', '😌',
      '🤔', '🤨', '😐', '😑', '🙄', '😬', '😴', '😪',
      '😅', '😳', '🥺', '😢', '😭', '😤', '😡', '🤯',
    ],
  },
  {
    name: 'Gestures',
    emoji: [
      '👍', '👎', '👌', '🤙', '👏', '🙌', '🤝', '🙏',
      '👋', '✌️', '🤞', '💪', '☝️', '👉', '👈', '🫡',
    ],
  },
  {
    name: 'People',
    emoji: [
      '👨', '👩', '🧑', '👴', '👵', '👨‍👩‍👧', '👶', '🧔',
      '👨‍💼', '👩‍💼', '🧑‍🔧', '👷', '🕵️', '🧑‍⚖️', '🤵', '👰',
    ],
  },
  {
    name: 'Property',
    emoji: [
      '🏠', '🏡', '🏚️', '🏘️', '🏢', '🏗️', '🔑', '🚪',
      '🛠️', '🔨', '🪜', '🧰', '📐', '🚧', '🌳', '🚗',
      '📄', '📝', '📋', '📌', '📎', '💼', '🏦', '⚖️',
    ],
  },
  {
    name: 'Symbols',
    emoji: [
      '✅', '❌', '❗', '❓', '⚠️', '⭐', '🔥', '💯',
      '💰', '💵', '💸', '📈', '📉', '⏰', '📅', '⌛',
      '📞', '📲', '💬', '📧', '📍', '❤️', '🎉', '🎯',
    ],
  },
];

function readRecents(): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENTS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((e): e is string => typeof e === 'string').slice(0, RECENTS_MAX);
  } catch {
    return [];
  }
}

function writeRecents(list: string[]): void {
  try {
    window.localStorage.setItem(RECENTS_KEY, JSON.stringify(list.slice(0, RECENTS_MAX)));
  } catch {
    /* private mode: the picker still works, it just forgets */
  }
}

function EmojiCell({ emoji, onPick }: { emoji: string; onPick: (e: string) => void }) {
  return (
    <button
      type="button"
      aria-label={emoji}
      // A mousedown steals focus from the textarea before the click lands, and
      // the caret is what the insert is measured against — so hold it here.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => onPick(emoji)}
      className="inline-flex items-center justify-center"
      style={{
        width: 32,
        height: 32,
        borderRadius: 8,
        border: 'none',
        background: 'transparent',
        font: '20px/1 "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif',
        cursor: 'pointer',
      }}
    >
      {emoji}
    </button>
  );
}

/**
 * The composer's emoji control: a round button that opens a small panel above
 * it. Closes on Escape, on a click outside, and after a pick — a rep adding
 * three in a row reopens it, which is rarer than wanting the keyboard back.
 */
export function EmojiButton({
  onPick,
  disabled,
}: {
  /** Called with the chosen emoji; the caller inserts it at its own caret. */
  onPick: (emoji: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>([]);
  const host = useRef<HTMLSpanElement | null>(null);

  // Read after mount: localStorage does not exist while the shell renders.
  useEffect(() => {
    if (open) setRecents(readRecents());
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      if (host.current && e.target instanceof Node && host.current.contains(e.target)) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  const pick = useCallback(
    (emoji: string) => {
      const next = [emoji, ...readRecents().filter((e) => e !== emoji)].slice(0, RECENTS_MAX);
      writeRecents(next);
      setRecents(next);
      setOpen(false);
      onPick(emoji);
    },
    [onPick],
  );

  return (
    <span ref={host} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        aria-label="Emoji"
        aria-expanded={open}
        title="Emoji"
        disabled={disabled}
        onClick={() => setOpen((v) => !v)}
        className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-full disabled:cursor-not-allowed disabled:opacity-45"
        style={{
          border: '1px solid var(--line)',
          background: open ? 'var(--accent-soft)' : 'var(--panel)',
          color: open ? 'var(--accent)' : 'var(--muted)',
          cursor: 'pointer',
        }}
      >
        <Icon name="smile" size={16} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Pick an emoji"
          className="flex flex-col"
          style={{
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            left: 0,
            // Never wider than a phone: 375px minus the composer's own gutters.
            width: 'min(304px, calc(100vw - 28px))',
            maxHeight: 268,
            background: 'var(--panel)',
            border: '1px solid var(--line)',
            borderRadius: 'var(--r-card)',
            boxShadow: 'var(--shadow-lift)',
            zIndex: 40,
            overflow: 'hidden',
          }}
        >
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            {recents.length > 0 && (
              <>
                <GroupLabel>Recent</GroupLabel>
                <div className="flex flex-wrap">
                  {recents.map((e) => (
                    <EmojiCell key={`recent-${e}`} emoji={e} onPick={pick} />
                  ))}
                </div>
              </>
            )}
            {EMOJI_GROUPS.map((g) => (
              <div key={g.name}>
                <GroupLabel>{g.name}</GroupLabel>
                <div className="flex flex-wrap">
                  {g.emoji.map((e) => (
                    <EmojiCell key={`${g.name}-${e}`} emoji={e} onPick={pick} />
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p
            className="px-3 py-2"
            style={{ borderTop: '1px solid var(--line)', font: '400 10px/1.35 Inter', color: 'var(--muted-2)' }}
          >
            An emoji switches the message to UCS-2 — 70 characters a segment instead of 160.
          </p>
        </div>
      )}
    </span>
  );
}

function GroupLabel({ children }: { children: string }) {
  return (
    <div
      className="sticky top-0 px-1 pb-1 pt-2"
      style={{
        background: 'var(--panel)',
        font: '600 9px/1 Inter',
        letterSpacing: '0.1em',
        textTransform: 'uppercase',
        color: 'var(--muted-2)',
      }}
    >
      {children}
    </div>
  );
}

/**
 * Insert `text` at the caret of a textarea and leave the caret after it, with
 * focus still in the field. Returns the new value; the caller owns the state.
 */
export function insertAtCaret(el: HTMLTextAreaElement | null, value: string, text: string): string {
  // A textarea that was never focused reports a caret at 0, which would put
  // the emoji in front of everything the rep typed. Unfocused means "append".
  const focused = typeof document !== 'undefined' && el !== null && document.activeElement === el;
  const start = focused ? el.selectionStart : value.length;
  const end = focused ? el.selectionEnd : value.length;
  const next = `${value.slice(0, start)}${text}${value.slice(end)}`;
  if (el) {
    // After React has written the new value, put the caret back where the rep
    // was typing — otherwise every insert jumps them to the end. Twice, because
    // a controlled textarea can be re-assigned its value after the frame, and
    // re-applying the same selection is free.
    const pos = start + text.length;
    const restore = () => {
      el.focus();
      el.setSelectionRange(pos, pos);
    };
    requestAnimationFrame(restore);
    setTimeout(restore, 0);
  }
  return next;
}
