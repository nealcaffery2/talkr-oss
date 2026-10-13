import Link from 'next/link';
import { Container } from '@/components/site';

const NAV = [
  { href: '/features', label: 'Features' },
  { href: '/how-to', label: 'How to' },
  { href: '/pricing', label: 'Pricing' },
];

/** The marketing site: a plain header, the page, a plain footer. No workspace chrome. */
export default function SiteLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col" style={{ background: 'var(--bg)' }}>
      <header
        className="sticky top-0 z-20"
        style={{ background: 'rgba(250,250,250,0.86)', backdropFilter: 'blur(10px)', borderBottom: '1px solid var(--line-soft)' }}
      >
        <Container className="flex h-16 items-center justify-between">
          <Link href="/" className="flex items-center gap-2.5" aria-label="Talkr home">
            {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset */}
            <img src="/logo-mark.png" alt="" width={30} height={30} />
            <span className="text-[19px] font-semibold tracking-[-0.02em]" style={{ color: 'var(--ink)' }}>
              Talkr
            </span>
          </Link>
          <nav className="flex items-center gap-1 sm:gap-2" aria-label="Site">
            {NAV.map((n) => (
              <Link
                key={n.href}
                href={n.href}
                className="px-3 py-2 text-[14px] font-medium"
                style={{ color: 'var(--text)', borderRadius: 'var(--r-btn)' }}
              >
                {n.label}
              </Link>
            ))}
            <Link
              href="/dialer"
              className="ml-1 inline-flex h-10 items-center px-4 text-[14px] font-semibold"
              style={{ background: 'var(--accent)', color: '#fff', borderRadius: 'var(--r-btn)' }}
            >
              Open app
            </Link>
          </nav>
        </Container>
      </header>

      <main className="flex-1">{children}</main>

      <footer style={{ borderTop: '1px solid var(--line)' }}>
        <Container className="flex flex-col gap-6 py-10 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center gap-2.5">
            {/* eslint-disable-next-line @next/next/no-img-element -- static brand asset */}
            <img src="/logo-mark.png" alt="" width={22} height={22} />
            <span className="text-[14px]" style={{ color: 'var(--muted)' }}>
              Talkr · the phone for sales teams
            </span>
          </div>
          <nav className="flex flex-wrap gap-5 text-[14px]" style={{ color: 'var(--muted)' }} aria-label="Footer">
            <Link href="/features">Features</Link>
            <Link href="/how-to">How to</Link>
            <Link href="/pricing">Pricing</Link>
            <Link href="/privacy-policy">Privacy Policy</Link>
            <Link href="/terms-of-service">Terms of Service</Link>
            <Link href="/support">Support</Link>
            <Link href="/dialer">Open app</Link>
          </nav>
        </Container>
      </footer>
    </div>
  );
}
