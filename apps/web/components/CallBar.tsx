'use client';

/**
 * Persistent global call bar — visible on every page while a call is live, so
 * navigating away never hides (or drops) the call. It carries the controls a
 * rep reaches for without going back to the dialer: mute, hold, keypad, end.
 */

import { useEffect, useState } from 'react';
import { useSoftphone } from '@/lib/softphone';
import { Keypad } from './Keypad';
import { Icon, HangupIcon } from './Icon';
import { Button } from './ui';
import { PhoneText } from './CopyPhone';
import { ProspectTime } from './ProspectTime';
import { duration } from '@/lib/time';

export function CallBar() {
  const {
    callState,
    active,
    serverStatus,
    hangup,
    toggleMute,
    sendDigit,
    onHold,
    toggleHold,
    participants,
  } = useSoftphone();
  const [elapsed, setElapsed] = useState(0);
  const [keypadOpen, setKeypadOpen] = useState(false);

  const startedAt = active?.startedAt ?? null;
  useEffect(() => {
    if (callState !== 'in_call' || !startedAt) return;
    const t = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000);
    return () => clearInterval(t);
  }, [callState, startedAt]);

  if (callState === 'idle' || callState === 'wrapup' || !active) return null;

  const statusLabel = onHold
    ? 'On hold'
    : callState === 'connecting'
      ? serverStatus === 'ringing'
        ? 'Ringing…'
        : 'Connecting…'
      : 'Live';
  const counterparty =
    active.record.direction === 'outbound' ? active.record.to_number : active.record.from_number;
  const others = participants.filter((p) => p.state !== 'left' && p.role !== 'agent').length;

  return (
    <div
      // On a phone the tab bar owns the bottom edge; the call bar sits on it.
      className="fixed inset-x-0 bottom-[calc(3.6rem+env(safe-area-inset-bottom))] z-40 md:bottom-0"
      style={{ borderTop: '1px solid var(--dark-2)', background: 'var(--ink)' }}
    >
      <div className="flex items-center gap-2 px-3 py-2.5 md:gap-3.5 md:px-5 md:py-3">
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            background: onHold ? 'var(--amber)' : callState === 'in_call' ? 'var(--green)' : 'var(--amber)',
            animation: 'bluepulse 2.4s ease-in-out infinite',
          }}
          aria-hidden
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5" style={{ font: '600 13px/1.3 Inter', color: '#fff' }}>
            <PhoneText e164={counterparty} size={20} tone="dark" />
            {others > 1 && (
              <span className="truncate" style={{ color: 'var(--muted-2)', font: '500 12px/1 Inter' }}>
                · {others} on the line
              </span>
            )}
          </div>
          <div
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5"
            style={{ font: '500 11px/1.4 Inter', color: 'var(--muted-2)' }}
          >
            <span>
              {statusLabel}
              {active.startedAt ? ` · ${duration(elapsed)}` : ''}
            </span>
            {/* The bar follows the rep onto every page, so the seller's clock
                follows them too — it is the fact that changes how the next
                sentence is said. Silent when the area code has no zone. */}
            <ProspectTime e164={counterparty} tone="dark" size={11} />
          </div>
        </div>

        <Button
          tone="ghost"
          onClick={toggleMute}
          style={{
            background: active.muted ? 'var(--accent)' : 'rgba(255,255,255,.06)',
            border: '1px solid var(--dark-2)',
            color: '#e4e4e7',
          }}
        >
          <Icon name={active.muted ? 'mic-off' : 'mic'} size={15} />
          <span className="hidden sm:inline">{active.muted ? 'Unmute' : 'Mute'}</span>
        </Button>
        <Button
          tone="ghost"
          onClick={() => void toggleHold()}
          style={{
            background: onHold ? 'var(--accent)' : 'rgba(255,255,255,.06)',
            border: '1px solid var(--dark-2)',
            color: '#e4e4e7',
          }}
        >
          <Icon name="pause" size={15} />
          <span className="hidden sm:inline">{onHold ? 'Resume' : 'Hold'}</span>
        </Button>
        <Button
          tone="ghost"
          onClick={() => setKeypadOpen((v) => !v)}
          style={{
            background: keypadOpen ? 'var(--accent)' : 'rgba(255,255,255,.06)',
            border: '1px solid var(--dark-2)',
            color: '#e4e4e7',
          }}
        >
          <Icon name="grid" size={15} />
          <span className="hidden sm:inline">Keypad</span>
        </Button>
        <Button tone="red" onClick={hangup}>
          <HangupIcon size={15} />
          <span className="hidden sm:inline">End</span>
        </Button>
      </div>
      {keypadOpen && (
        <div className="p-3" style={{ borderTop: '1px solid var(--dark-2)' }}>
          <Keypad onDigit={sendDigit} />
        </div>
      )}
    </div>
  );
}
