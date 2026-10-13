/**
 * The marketing site's few primitives. Same tokens as the workspace (brand red
 * as the only accent, charcoal for dark surfaces, hairline borders), so the
 * pages read as the same product the app is.
 */

import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { Icon, type IconName } from './Icon';

export function Container({ children, className = '' }: { children: ReactNode; className?: string }) {
  return <div className={`mx-auto w-full max-w-[1120px] px-5 sm:px-8 ${className}`}>{children}</div>;
}

export function Eyebrow({ children, light = false }: { children: ReactNode; light?: boolean }) {
  return (
    <span
      className="inline-flex items-center gap-2"
      style={{
        font: '600 11px/1 Inter',
        letterSpacing: '0.14em',
        textTransform: 'uppercase',
        color: light ? 'var(--accent-light)' : 'var(--accent)',
      }}
    >
      <span style={{ width: 6, height: 6, background: 'currentColor' }} aria-hidden />
      {children}
    </span>
  );
}

export function Cta({
  href,
  children,
  tone = 'accent',
  size = 'md',
}: {
  href: string;
  children: ReactNode;
  tone?: 'accent' | 'ghost' | 'light';
  size?: 'md' | 'lg';
}) {
  const tones: Record<string, CSSProperties> = {
    accent: { background: 'var(--accent)', color: '#fff', border: '1px solid transparent' },
    ghost: { background: 'var(--panel)', color: 'var(--text)', border: '1px solid var(--line)' },
    light: { background: '#fff', color: 'var(--ink)', border: '1px solid transparent' },
  };
  return (
    <Link
      href={href}
      className={`inline-flex items-center justify-center gap-2 font-semibold transition-colors ${
        size === 'lg' ? 'h-13 px-6 text-[16px]' : 'h-11 px-5 text-[14px]'
      }`}
      style={{ borderRadius: 'var(--r-btn)', ...tones[tone] }}
    >
      {children}
    </Link>
  );
}

export function Tile({ icon, title, children }: { icon: IconName; title: string; children: ReactNode }) {
  return (
    <div
      className="flex flex-col gap-3 p-5"
      style={{
        background: 'var(--panel)',
        border: '1px solid var(--line)',
        borderRadius: 'var(--r-card)',
        boxShadow: 'var(--shadow-rest)',
      }}
    >
      <span
        className="inline-flex h-10 w-10 items-center justify-center"
        style={{ borderRadius: 11, background: 'var(--accent-soft)', color: 'var(--accent)' }}
      >
        <Icon name={icon} size={19} />
      </span>
      <div>
        <h3 className="text-[16px] font-semibold" style={{ color: 'var(--text)' }}>
          {title}
        </h3>
        <p className="mt-1 text-[14px] leading-6" style={{ color: 'var(--muted)' }}>
          {children}
        </p>
      </div>
    </div>
  );
}

/** A product screenshot with a hairline frame and a caption underneath. */
export function Shot({
  src,
  alt,
  caption,
  width,
  height,
  className = '',
  style,
}: {
  src: string;
  alt: string;
  caption?: string;
  width: number;
  height: number;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <figure className={`m-0 ${className}`} style={style}>
      <div
        className="overflow-hidden"
        style={{
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-lg)',
          boxShadow: 'var(--shadow-lift)',
          background: 'var(--panel)',
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element -- static marketing asset */}
        <img src={src} alt={alt} width={width} height={height} className="block h-auto w-full" />
      </div>
      {caption && (
        <figcaption className="mt-3 text-center text-[13px]" style={{ color: 'var(--muted)' }}>
          {caption}
        </figcaption>
      )}
    </figure>
  );
}

/** Charcoal closing band with one red action. */
export function CtaBand({ title, body, href = '/dialer', label = 'Open Talkr' }: { title: string; body: string; href?: string; label?: string }) {
  return (
    <section className="py-16 sm:py-24" style={{ background: 'var(--ink)', color: '#fff' }}>
      <Container className="flex flex-col items-start gap-6 sm:flex-row sm:items-center sm:justify-between">
        <div className="max-w-[560px]">
          <h2 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-[36px]">{title}</h2>
          <p className="mt-3 text-[16px] leading-7" style={{ color: 'var(--muted-2)' }}>
            {body}
          </p>
        </div>
        <Cta href={href} size="lg">
          {label}
          <Icon name="chevron-right" size={16} />
        </Cta>
      </Container>
    </section>
  );
}
