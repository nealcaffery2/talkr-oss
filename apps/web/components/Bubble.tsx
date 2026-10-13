'use client';

/**
 * iMessage-accurate SMS bubbles: 20px radius, a drawn tail on the last bubble
 * of a run, and the receipt line under outbound messages.
 *
 * The tail is two overlapping shapes — a rounded square in the bubble's own
 * color, then a cut-out in the thread background that carves the curve. That
 * is how iOS draws it, and why the cut-out must be told the background color
 * rather than assuming white.
 *
 * Outbound uses Talkr red rather than iOS blue, to stay in brand.
 */

import type { ReactNode } from 'react';

export function Bubble({
  mine,
  tail = true,
  background = 'var(--panel)',
  children,
  receipt,
  maxWidth = '60%',
}: {
  mine: boolean;
  /** Only the last bubble in a run gets a tail. */
  tail?: boolean;
  /** The thread's background — the tail cut-out has to match it exactly. */
  background?: string;
  children: ReactNode;
  receipt?: string;
  maxWidth?: string;
}) {
  const fill = mine ? 'var(--accent)' : '#e9e9eb';
  const color = mine ? '#fff' : 'var(--text)';
  const side = mine ? 'right' : 'left';

  return (
    <div
      className="mb-1.5 flex flex-col"
      style={{ alignSelf: mine ? 'flex-end' : 'flex-start', alignItems: mine ? 'flex-end' : 'flex-start', maxWidth }}
    >
      <div className="relative" style={{ padding: '9px 14px', borderRadius: 20, background: fill, color, font: '400 14px/1.35 Inter' }}>
        {children}
        {tail && (
          <>
            <span
              aria-hidden
              style={{
                position: 'absolute',
                [side]: -6,
                bottom: 0,
                width: 19,
                height: 19,
                background: fill,
                [`borderBottom${mine ? 'Left' : 'Right'}Radius`]: 16,
              } as React.CSSProperties}
            />
            <span
              aria-hidden
              style={{
                position: 'absolute',
                [side]: -9,
                bottom: 0,
                width: 11,
                height: 19,
                background,
                [`borderBottom${mine ? 'Left' : 'Right'}Radius`]: 11,
              } as React.CSSProperties}
            />
          </>
        )}
      </div>
      {receipt && (
        <span style={{ padding: mine ? '4px 4px 0 0' : '4px 0 0 4px', font: '500 10px/1 Inter', color: 'var(--muted-2)' }}>
          {receipt}
        </span>
      )}
    </div>
  );
}

/** The three-dot "they're typing" bubble. */
export function TypingBubble() {
  return (
    <div
      className="mb-1.5 flex items-center gap-1.5"
      style={{ alignSelf: 'flex-start', padding: '12px 16px', borderRadius: 20, background: '#e9e9eb' }}
      aria-label="Typing"
    >
      {[0, 0.18, 0.36].map((delay) => (
        <span
          key={delay}
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: '#8e8e93',
            animation: `typingdot 1.2s ease-in-out ${delay}s infinite`,
          }}
        />
      ))}
    </div>
  );
}
