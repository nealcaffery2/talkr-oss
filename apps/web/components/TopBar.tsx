'use client';

/**
 * Workspace header (design 1c): what you are looking at, a search field, the
 * rep's presence, their own local time, and the one primary action.
 *
 * The clock is here because every other time in the app is somebody else's;
 * this is the anchor the rep reads them against.
 */

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon } from './Icon';
import { Button } from './ui';
import { localZone, tzAbbr, tzTime } from '@/lib/time';

const PRESENCES = [
  { label: 'Available', color: 'var(--green)', api: 'available' as const },
  { label: 'On a call', color: 'var(--accent)', api: 'available' as const },
  { label: 'Do not disturb', color: 'var(--red)', api: 'away' as const },
  { label: 'Away', color: 'var(--amber)', api: 'away' as const },
];

export function TopBar({
  title,
  subtitle,
  onPresenceChange,
}: {
  title: string;
  subtitle: string;
  onPresenceChange?: (status: 'available' | 'away') => void;
}) {
  const router = useRouter();
  const [presence, setPresence] = useState(0);
  const [now, setNow] = useState<number | null>(null);

  // Rendered only after mount: the server has no idea what zone the rep is in,
  // and a mismatched first paint is a hydration error.
  useEffect(() => {
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const zone = localZone();
  const current = PRESENCES[presence % PRESENCES.length]!;

  return (
    <header
      className="flex shrink-0 items-center gap-2 px-3 py-2.5 md:gap-3.5 md:px-5 md:py-3.5"
      style={{ borderBottom: '1px solid var(--line)', background: 'var(--panel)' }}
    >
      <div className="flex min-w-0 flex-col gap-0.5 md:min-w-[190px]">
        <h1 className="truncate" style={{ font: '700 15px/1 Inter', letterSpacing: '-0.015em' }}>{title}</h1>
        <p className="truncate" style={{ font: '500 11px/1 Inter', color: 'var(--muted)' }}>{subtitle}</p>
      </div>

      <div
        className="hidden max-w-[420px] flex-1 items-center gap-2 px-3 py-2 md:flex"
        style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-btn)', background: 'var(--bg)' }}
      >
        <Icon name="search" size={15} style={{ color: 'var(--muted-2)' }} />
        <input
          placeholder="Search people, numbers, messages"
          aria-label="Search"
          className="min-w-0 flex-1 bg-transparent outline-none"
          style={{ font: '400 12.5px/1 Inter' }}
        />
      </div>

      <div className="ml-auto flex items-center gap-2">
        <button
          type="button"
          onClick={() => {
            const next = (presence + 1) % PRESENCES.length;
            setPresence(next);
            onPresenceChange?.(PRESENCES[next]!.api);
          }}
          className="inline-flex items-center gap-2 px-3 py-2"
          style={{
            border: '1px solid var(--line)',
            borderRadius: 'var(--r-btn)',
            background: 'var(--panel)',
            font: '600 12px/1 Inter',
            cursor: 'pointer',
          }}
        >
          <span style={{ width: 6, height: 6, background: current.color }} aria-hidden />
          <span className="hidden sm:inline">{current.label}</span>
          <Icon name="chevron-down" size={13} style={{ color: 'var(--muted-2)' }} />
        </button>

        <div
          className="hidden items-center gap-2 px-3 py-2 lg:flex"
          style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-btn)', font: '600 12px/1 Inter' }}
        >
          <Icon name="clock" size={13} style={{ color: 'var(--accent)' }} />
          <span suppressHydrationWarning>
            {now === null ? '—' : `${tzTime(zone, now)} ${tzAbbr(zone, now)}`}
          </span>
        </div>

        <Button tone="accent" onClick={() => router.push('/dialer')} style={{ boxShadow: '0 6px 16px rgba(255,35,59,.28)' }}>
          <Icon name="phone" size={14} />
          <span className="hidden sm:inline">New call</span>
        </Button>
      </div>
    </header>
  );
}
