'use client';

/**
 * The 64px near-black rail (design 1c). Icon-only, because the workspace's
 * value is the width it leaves for the call.
 *
 * On a phone there is no width to leave, so the same destinations become a
 * tab bar along the bottom: the four a rep reaches for all day, and a More
 * sheet for the rest.
 */

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Icon, type IconName } from './Icon';
import { getSessionUser } from '@/lib/api';

interface Nav {
  href: string;
  label: string;
  icon: IconName;
}

const PRIMARY: Nav[] = [
  { href: '/dialer', label: 'Dialer', icon: 'phone' },
  { href: '/messages', label: 'Messages', icon: 'msg' },
  { href: '/contacts', label: 'Contacts', icon: 'user' },
  { href: '/calls', label: 'History', icon: 'clock' },
  { href: '/team', label: 'Team', icon: 'users' },
  { href: '/settings', label: 'Settings', icon: 'settings' },
];

/** Reached from the rail's overflow rather than the primary five. */
const SECONDARY: Nav[] = [
  { href: '/campaigns', label: 'Campaigns', icon: 'transfer' },
  { href: '/reports', label: 'Reports', icon: 'grid' },
  { href: '/coaching', label: 'Coaching', icon: 'award' },
  { href: '/floor', label: 'Floor', icon: 'globe' },
  { href: '/workflows', label: 'Workflows', icon: 'template' },
  { href: '/sequences', label: 'Sequences', icon: 'forward' },
  { href: '/scripts', label: 'Scripts', icon: 'mic' },
  { href: '/tasks', label: 'Tasks', icon: 'check' },
];

/** What fits across a phone: the first four, then More. */
const TABS = PRIMARY.slice(0, 4);
const MORE: Nav[] = [...PRIMARY.slice(4), ...SECONDARY, { href: '/login', label: 'Account', icon: 'user' }];

/** Initials of the signed-in rep for the rail's account button; null when signed out. */
function useInitials(): string | null {
  const [value, setValue] = useState<string | null>(null);
  useEffect(() => {
    const u = getSessionUser();
    const name = u?.display_name ?? u?.email ?? null;
    setValue(
      name
        ? name
            .split(' ')
            .filter(Boolean)
            .slice(0, 2)
            .map((w) => w[0]!.toUpperCase())
            .join('')
        : null,
    );
  }, []);
  return value;
}

export function RailNav() {
  const initials = useInitials();
  const pathname = usePathname();
  const [moreOpen, setMoreOpen] = useState(false);

  // Navigating closes the sheet, whichever way it happened.
  useEffect(() => setMoreOpen(false), [pathname]);

  const isActive = (href: string) => pathname === href || pathname.startsWith(`${href}/`);
  const moreActive = MORE.some((n) => isActive(n.href));

  const railItem = ({ href, label, icon }: Nav) => {
    const active = isActive(href);
    return (
      <Link
        key={href}
        href={href}
        title={label}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        className="flex h-10 w-10 items-center justify-center transition-colors"
        style={{
          borderRadius: 11,
          background: active ? 'var(--accent)' : 'transparent',
          color: active ? '#fff' : 'var(--muted)',
        }}
      >
        <Icon name={icon} size={19} />
      </Link>
    );
  };

  const tabStyle = (active: boolean) => ({
    color: active ? '#fff' : 'var(--muted-2)',
    font: '600 9.5px/1 Inter',
  });

  return (
    <>
      {/* ── Desktop: the rail ─────────────────────────────────────────── */}
      <nav
        className="hidden w-16 shrink-0 flex-col items-center gap-1.5 py-3.5 md:order-first md:flex"
        style={{ background: 'var(--ink)' }}
        aria-label="Primary"
      >
        <Link href="/dialer" aria-label="Talkr" className="mb-2 inline-flex h-9 w-9 items-center justify-center">
          {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset */}
          <img src="/logo-mark.png" alt="" width={34} height={34} />
        </Link>
        {PRIMARY.map(railItem)}
        <div className="my-1 h-px w-6" style={{ background: 'var(--dark-3)' }} />
        {SECONDARY.map(railItem)}
        <Link
          href="/login"
          title="Account"
          aria-label="Account"
          className="mt-auto inline-flex h-8 w-8 items-center justify-center rounded-full"
          style={{ background: 'var(--dark-2)', color: '#fff', font: '600 12px/1 Inter' }}
        >
          {initials ?? <Icon name="user" size={15} />}
        </Link>
      </nav>

      {/* ── Phone: the tab bar ────────────────────────────────────────── */}
      <nav
        className="relative order-last flex shrink-0 items-stretch md:hidden"
        style={{
          background: 'var(--ink)',
          borderTop: '1px solid var(--dark-2)',
          paddingBottom: 'env(safe-area-inset-bottom)',
        }}
        aria-label="Primary"
      >
        {TABS.map(({ href, label, icon }) => {
          const active = isActive(href);
          return (
            <Link
              key={href}
              href={href}
              aria-label={label}
              aria-current={active ? 'page' : undefined}
              className="flex flex-1 flex-col items-center gap-1 pb-1.5 pt-2"
              style={tabStyle(active)}
            >
              <Icon name={icon} size={21} style={{ color: active ? 'var(--accent-light)' : undefined }} />
              {label}
            </Link>
          );
        })}
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          aria-expanded={moreOpen}
          aria-label="More"
          className="flex flex-1 flex-col items-center gap-1 pb-1.5 pt-2"
          style={{ ...tabStyle(moreActive || moreOpen), background: 'transparent', border: 'none' }}
        >
          <Icon name="more" size={21} style={{ color: moreActive || moreOpen ? 'var(--accent-light)' : undefined }} />
          More
        </button>

        {moreOpen && (
          <div
            className="absolute inset-x-2 bottom-full mb-2 grid grid-cols-4 gap-1 p-2"
            style={{
              borderRadius: 14,
              background: 'var(--panel)',
              border: '1px solid var(--line)',
              boxShadow: 'var(--shadow-lift)',
            }}
          >
            {MORE.map(({ href, label, icon }) => {
              const active = isActive(href);
              return (
                <Link
                  key={href}
                  href={href}
                  className="flex flex-col items-center gap-1.5 py-2.5 text-center"
                  style={{
                    borderRadius: 10,
                    background: active ? 'var(--accent-soft)' : 'transparent',
                    color: active ? 'var(--accent)' : 'var(--text)',
                    font: '600 10px/1 Inter',
                  }}
                >
                  {href === '/login' && initials ? (
                    <span
                      className="inline-flex h-6 w-6 items-center justify-center rounded-full"
                      style={{ background: 'var(--dark-2)', color: '#fff', font: '600 10px/1 Inter' }}
                    >
                      {initials}
                    </span>
                  ) : (
                    <Icon name={icon} size={18} />
                  )}
                  {label}
                </Link>
              );
            })}
          </div>
        )}
      </nav>
    </>
  );
}
