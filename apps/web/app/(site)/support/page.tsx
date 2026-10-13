import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Container, Eyebrow } from '@/components/site';

export const metadata: Metadata = {
  title: 'Support',
  description:
    'Get help with Talkr and the Talkr Chrome extension: signing in, allowing the microphone, calls and texts, and how to reach us.',
};

const LINK = { color: 'var(--accent)', fontWeight: 600 } as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="flex flex-col gap-3 scroll-mt-24">
      <h2 className="text-[20px] font-semibold tracking-[-0.01em]" style={{ color: 'var(--ink)' }}>
        {title}
      </h2>
      <div className="flex flex-col gap-3 text-[15.5px] leading-[1.65]" style={{ color: 'var(--text)' }}>
        {children}
      </div>
    </section>
  );
}

function Bullets({ items }: { items: ReactNode[] }) {
  return (
    <ul className="flex list-disc flex-col gap-1.5 pl-5">
      {items.map((it, i) => (
        <li key={i}>{it}</li>
      ))}
    </ul>
  );
}

function Contact() {
  return (
    <p>
      Email{' '}
      <a href="mailto:contact@example.com" style={LINK}>
        contact@example.com
      </a>{' '}
      or call{' '}
      <a href="tel:+18305550193" style={LINK}>
        (830) 555-0193
      </a>
      . Tell us your name, your workspace, what you were doing and what you saw. A screenshot helps.
    </p>
  );
}

export default function SupportPage() {
  return (
    <Container className="flex max-w-[760px] flex-col gap-10 py-14 sm:py-20">
      <header className="flex flex-col gap-4">
        <Eyebrow>Support</Eyebrow>
        <h1 className="text-[36px] font-semibold tracking-[-0.02em] sm:text-[44px]" style={{ color: 'var(--ink)' }}>
          Talkr support
        </h1>
        <p className="text-[15.5px] leading-[1.65]" style={{ color: 'var(--muted)' }}>
          Help with Talkr and the Talkr Chrome extension. Most questions are answered below; if yours is not, reach
          us directly.
        </p>
      </header>

      <Section id="contact" title="Contact us">
        <Contact />
      </Section>

      <Section id="setup" title="Set up the Chrome extension">
        <Bullets
          items={[
            'Add Talkr from the Chrome Web Store, then pin it to the toolbar.',
            <>
              Sign in with Google or your email and password. Already signed in to CLOZR? Open a CLOZR tab and Talkr
              signs itself in with the same account.
            </>,
            <>
              Press <strong>Allow mic</strong> in the popup. A Talkr tab opens and Chrome asks for the microphone:
              choose Allow. The tab closes itself and the phone is ready.
            </>,
          ]}
        />
      </Section>

      <Section id="mic" title="“Microphone blocked” or calls with no audio">
        <Bullets
          items={[
            <>
              Open the Talkr popup and press <strong>Allow mic</strong>. If Chrome has already blocked the
              microphone, the Talkr tab that opens has a button to Talkr’s Chrome settings: set Microphone to Allow,
              then go back to that tab. It finishes on its own.
            </>,
            'Check that the right headset is chosen under Audio in the popup’s settings, and that no other app is holding the microphone.',
            'Still nothing? Reload Talkr at chrome://extensions and try again.',
          ]}
        />
      </Section>

      <Section id="signin" title="Can’t sign in">
        <Bullets
          items={[
            'Use the same email your team invited. An invite that has not been accepted yet is claimed by your first Google sign-in.',
            <>
              Forgot your password? Use <strong>Forgot password?</strong> on the{' '}
              <Link href="/login" style={LINK}>
                sign-in page
              </Link>
              .
            </>,
            'Signed in to CLOZR but the extension is not? Switch to the CLOZR tab, then reopen the Talkr popup.',
          ]}
        />
      </Section>

      <Section id="calls" title="Calls and texts">
        <Bullets
          items={[
            'Click any phone number on a web page, or highlight one and press Call, to dial it from your line.',
            'Calls appear on the matching seller or buyer record in CLOZR within a couple of minutes. The recording, transcript and notes follow once they are processed.',
            'A contact who replies STOP is opted out automatically and cannot be texted again from Talkr.',
            'Texts are not sent during quiet hours; Talkr tells you when it holds one back.',
          ]}
        />
      </Section>

      <Section id="policies" title="Privacy and terms">
        <p>
          Read our{' '}
          <Link href="/privacy-policy" style={LINK}>
            Privacy Policy
          </Link>{' '}
          and{' '}
          <Link href="/terms-of-service" style={LINK}>
            Terms of Service
          </Link>
          . To ask what data we hold about you, or to have it deleted, contact us at the address above.
        </p>
        <p style={{ color: 'var(--muted)' }}>
          Talkr is operated by Your Company LLC, 123 Example St, Anytown, ST 00000.
        </p>
      </Section>
    </Container>
  );
}
