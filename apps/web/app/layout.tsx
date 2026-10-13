import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: { default: 'Talkr', template: '%s · Talkr' },
  description: 'The phone for acquisitions teams: browser calling, texting, dialers and reporting in one place.',
};

/** Edge to edge on phones, so the app's tab bar can sit inside the home-indicator inset. */
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  themeColor: '#ff233b',
};

/**
 * Only the document. The workspace shell lives in app/(app)/layout.tsx and the
 * marketing site in app/(site)/layout.tsx, so the two never share chrome.
 */
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
