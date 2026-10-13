/**
 * The product's only icon system: Feather/Lucide-style stroke glyphs on a
 * 24-unit grid, stroke-width 2, round caps and joins, no fills, currentColor
 * (design system readme "Iconography"). Emoji is never iconography.
 *
 * This is the exact set the Talkr design uses. Anything outside it
 * should come from Lucide rather than being invented here.
 */

import type { CSSProperties, ReactNode } from 'react';

type Glyph = { d?: string[]; extra?: ReactNode; filled?: boolean };

const C = (cx: number, cy: number, r: number) => <circle key={`c${cx}-${cy}`} cx={cx} cy={cy} r={r} />;

const GLYPHS = {
  phone: {
    d: [
      'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.79 19.79 0 0 1 2.12 4.18 2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7A2 2 0 0 1 22 16.92z',
    ],
  },
  mic: {
    d: ['M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z', 'M19 10v2a7 7 0 0 1-14 0v-2M12 19v4M8 23h8'],
  },
  'mic-off': {
    d: ['M1 1l22 22M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6', 'M17 16.95A7 7 0 0 1 5 12v-2M12 19v4M8 23h8'],
  },
  pause: { d: ['M7 4v16M17 4v16'] },
  grid: { d: ['M6 6h.01M12 6h.01M18 6h.01M6 12h.01M12 12h.01M18 12h.01M6 18h.01M12 18h.01M18 18h.01'] },
  transfer: { d: ['M8 3 4 7l4 4M4 7h16M16 21l4-4-4-4M20 17H4'] },
  plus: { d: ['M12 5v14M5 12h14'] },
  speaker: { d: ['M11 5 6 9H2v6h4l5 4V5z', 'M15.54 8.46a5 5 0 0 1 0 7.07M19.07 4.93a10 10 0 0 1 0 14.14'] },
  msg: { d: ['M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z'] },
  x: { d: ['M18 6 6 18M6 6l12 12'] },
  settings: { d: ['M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6'] },
  template: { d: ['M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z', 'M14 2v6h6M16 13H9M16 17H9'] },
  send: { d: ['M12 19V5M5 12l7-7 7 7'] },
  'chevron-down': { d: ['M6 9l6 6 6-6'] },
  'chevron-right': { d: ['M9 18l6-6-6-6'] },
  'chevron-left': { d: ['M15 18l-6-6 6-6'] },
  backspace: { d: ['M21 4H8l-7 8 7 8h13a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2z', 'M18 9l-6 6M12 9l6 6'] },
  forward: { d: ['M15 14l5-5-5-5M4 20v-7a4 4 0 0 1 4-4h12'] },
  more: { d: ['M5 12h.01M12 12h.01M19 12h.01'] },
  check: { d: ['M20 6L9 17l-5-5'] },
  copy: {
    d: ['M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2'],
    extra: <rect key="r" x="8" y="8" width="14" height="14" rx="2" />,
  },

  users: {
    d: ['M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2', 'M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75'],
    extra: C(9, 7, 4),
  },
  user: { d: ['M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'], extra: C(12, 7, 4) },
  clock: { d: ['M12 6v6l4 2'], extra: C(12, 12, 10) },
  voicemail: { d: ['M5.5 16h13'], extra: [C(5.5, 11.5, 4.5), C(18.5, 11.5, 4.5)] },
  search: { d: ['M21 21l-4.35-4.35'], extra: C(11, 11, 8) },
  globe: { d: ['M2 12h20M12 2a15.3 15.3 0 0 1 0 20 15.3 15.3 0 0 1 0-20z'], extra: C(12, 12, 10) },
  camera: {
    d: ['M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z'],
    extra: C(12, 13, 4),
  },
  pin: { d: ['M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z'], extra: C(12, 10, 3) },
  image: {
    d: ['M21 15l-5-5L5 21'],
    extra: [<rect key="r" x="3" y="3" width="18" height="18" rx="2" />, C(8.5, 8.5, 1.5)],
  },
  play: { d: ['M6 3l14 9-14 9z'], filled: true },
  smile: { d: ['M8 14s1.5 2 4 2 4-2 4-2M9 9h.01M15 9h.01'], extra: C(12, 12, 10) },
  edit: { d: ['M17 3a2.828 2.828 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z'] },
  trash: {
    d: ['M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2', 'M10 11v6M14 11v6'],
  },
  filter: { d: ['M22 3H2l8 9.46V19l4 2v-8.54L22 3z'] },
  // Lucide `award`: the coaching surfaces (a scored call, the coaching view).
  sparkle: { d: ['M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8'] },
  award: { d: ['M8.21 13.89 7 23l5-3 5 3-1.21-9.12'], extra: C(12, 8, 6) },
} satisfies Record<string, Glyph>;

export type IconName = keyof typeof GLYPHS;
export const ICON_NAMES = Object.keys(GLYPHS) as IconName[];

export interface IconProps {
  name: IconName;
  size?: number;
  className?: string;
  strokeWidth?: number;
  style?: CSSProperties;
}

export function Icon({ name, size = 16, className, strokeWidth = 2, style }: IconProps) {
  const glyph: Glyph = GLYPHS[name];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={glyph.filled ? 'currentColor' : 'none'}
      stroke={glyph.filled ? 'none' : 'currentColor'}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      style={style}
      aria-hidden
    >
      {glyph.extra}
      {glyph.d?.map((d, i) => <path key={i} d={d} />)}
    </svg>
  );
}

/** The hang-up glyph is the phone rotated — the universal convention. */
export function HangupIcon({ size = 16 }: { size?: number }) {
  return <Icon name="phone" size={size} style={{ transform: 'rotate(135deg)' }} />;
}
