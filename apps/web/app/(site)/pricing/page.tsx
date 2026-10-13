import type { Metadata } from 'next';
import { Container, Cta, Eyebrow } from '@/components/site';

export const metadata: Metadata = {
  title: 'Pricing',
  description: 'Talkr is $99 per user per month: the browser dialer, the Chrome extension, texting, campaigns and AI call notes for your whole team.',
};

/**
 * Checkout is a Stripe Payment Link (subscription, adjustable seat count), so
 * this site holds no Stripe keys. Until the link is configured the button asks
 * people to get in touch instead of pointing at nothing.
 */
const CHECKOUT = process.env.NEXT_PUBLIC_STRIPE_PAYMENT_LINK || null;
const CONTACT = 'mailto:contact@example.com?subject=Talkr%20for%20my%20team';

const INCLUDED = [
  'Browser dialer on any computer or phone, plus the Talkr Chrome extension',
  'Click any phone number on a web page to call it',
  'Two-way texting with templates, opt-outs and quiet hours handled',
  'Local presence and named team lines for caller ID',
  'Dialer campaigns with parallel lines and voicemail drop',
  'Call recording, transcripts and AI call notes',
  'Automated text sequences',
  'Built-in sync with CLOZR',
];

export default function PricingPage() {
  return (
    <Container className="flex max-w-[960px] flex-col items-center gap-10 py-14 sm:py-20">
      <header className="flex max-w-[620px] flex-col items-center gap-4 text-center">
        <Eyebrow>Pricing</Eyebrow>
        <h1 className="text-[36px] font-semibold tracking-[-0.02em] sm:text-[48px]" style={{ color: 'var(--ink)' }}>
          One plan. Everything included.
        </h1>
        <p className="text-[16px] leading-[1.6]" style={{ color: 'var(--muted)' }}>
          Every rep gets the full phone: calling, texting, campaigns and call intelligence. Add or remove seats any time.
        </p>
      </header>

      <section
        className="flex w-full max-w-[460px] flex-col gap-6 p-8"
        style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 18, boxShadow: '0 20px 50px -30px rgba(24,24,27,.35)' }}
        aria-label="Talkr plan"
      >
        <div className="flex flex-col gap-1">
          <span className="text-[15px] font-semibold" style={{ color: 'var(--accent)' }}>
            Talkr
          </span>
          <div className="flex items-baseline gap-2">
            <span className="text-[52px] font-semibold tracking-[-0.03em]" style={{ color: 'var(--ink)' }}>
              $99
            </span>
            <span className="text-[15px]" style={{ color: 'var(--muted)' }}>
              per user / month
            </span>
          </div>
          <span className="text-[13.5px]" style={{ color: 'var(--muted)' }}>
            Billed monthly. Cancel any time.
          </span>
        </div>

        <ul className="flex flex-col gap-2.5 text-[15px] leading-[1.45]" style={{ color: 'var(--text)' }}>
          {INCLUDED.map((item) => (
            <li key={item} className="flex gap-2.5">
              <span aria-hidden style={{ color: 'var(--accent)', fontWeight: 700 }}>
                ✓
              </span>
              {item}
            </li>
          ))}
        </ul>

        <Cta href={CHECKOUT ?? CONTACT} size="lg">
          {CHECKOUT ? 'Start now' : 'Talk to us'}
        </Cta>
        <p className="text-center text-[13px]" style={{ color: 'var(--muted)' }}>
          {CHECKOUT ? 'Choose your number of seats at checkout. Payments are handled securely by Stripe.' : 'Checkout opens soon. Email us and we will set your team up.'}
        </p>
      </section>

      <p className="max-w-[560px] text-center text-[14px] leading-[1.6]" style={{ color: 'var(--muted)' }}>
        Large team or high-volume dialing?{' '}
        <a href={CONTACT} style={{ color: 'var(--accent)', fontWeight: 600 }}>
          Talk to us
        </a>
        .
      </p>
    </Container>
  );
}
