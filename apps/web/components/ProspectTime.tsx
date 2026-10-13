'use client';

/**
 * The other party's local time, wherever their number is on screen.
 *
 * A rep who can see it is 6:40am where the seller is opens the call
 * differently — or does not place it at all. The data has been in `lib/time.ts`
 * since the beginning (`zoneForNumber` + `tzTime`); this is the one component
 * that puts it in front of the rep on every call surface, worded the same way
 * each time so "their time" is never mistaken for ours.
 *
 * Two rules:
 *  - An unknown zone renders NOTHING. `zoneForNumber` is an area-code guess and
 *    number portability makes it a hint, never a fact; a wrong clock beside a
 *    seller's number is worse than no clock at all.
 *  - The time is rendered only after mount. The server has no browser clock,
 *    so a server-rendered time would hydrate into a mismatch.
 */

import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { callWindow, tzCity, tzTime, zoneForNumber } from '@/lib/time';

/**
 * `Date.now()`, refreshed on the minute boundary rather than every 60s from
 * mount — the displayed minute changes when the minute changes. Null until the
 * component has mounted in a browser.
 */
export function useMinuteTick(active = true): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      // +50ms so we land just after the boundary, never just before it.
      timer = setTimeout(() => {
        setNow(Date.now());
        schedule();
      }, 60_000 - (Date.now() % 60_000) + 50);
    };
    schedule();
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, [active]);
  return now;
}

export interface ProspectTimeProps {
  /** The other party's number, E.164. Anything without a known zone renders nothing. */
  e164: string | null | undefined;
  /** 'dark' for the near-black call hero and call bar; 'light' everywhere else. */
  tone?: 'light' | 'dark';
  /** A clock the parent is already ticking. Omit and this component runs its own. */
  now?: number | null;
  size?: number;
  /** Hide the clock glyph where the row is already crowded (the call bar). */
  icon?: boolean;
  className?: string;
}

/**
 * "🕐 6:40 AM their time" — amber when it is outside the 9a–8p calling window,
 * because that is the moment the rep needs to notice it.
 */
export function ProspectTime({
  e164,
  tone = 'light',
  now: nowProp,
  size = 12,
  icon = true,
  className = '',
}: ProspectTimeProps) {
  const ticked = useMinuteTick(nowProp === undefined);
  const now = nowProp === undefined ? ticked : nowProp;
  const zone = e164 ? zoneForNumber(e164) : null;

  if (!zone || now === null) return null;

  const city = tzCity(zone);
  const w = callWindow(zone, now, city);
  const dark = tone === 'dark';
  const timeColor = w.safe ? (dark ? '#e4e4e7' : 'var(--text)') : 'var(--amber)';
  const labelColor = dark ? 'var(--muted-2)' : 'var(--muted)';

  return (
    <span
      className={`inline-flex items-center gap-1.5 ${className}`}
      title={
        w.safe
          ? `${tzTime(zone, now)} in ${city} — inside the 9a–8p calling window`
          : `${tzTime(zone, now)} in ${city} — quiet hours where they are`
      }
      style={{ whiteSpace: 'nowrap', font: `500 ${size}px/1 Inter` }}
    >
      {icon && (
        <Icon
          name="clock"
          size={Math.round(size * 0.95)}
          style={{ color: w.safe ? (dark ? 'var(--accent-light)' : 'var(--accent)') : 'var(--amber)' }}
        />
      )}
      <span style={{ color: timeColor, fontWeight: 600 }}>{tzTime(zone, now)}</span>
      <span style={{ color: labelColor }}>their time</span>
    </span>
  );
}
