import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Container, Eyebrow } from '@/components/site';

export const metadata: Metadata = {
  title: 'Terms of Service · Talkr',
  description:
    'The terms for using Talkr, including the SMS program terms: message frequency, rates, and how to reply STOP or HELP.',
};

const EFFECTIVE = 'September 8, 2026';

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

export default function TermsOfServicePage() {
  return (
    <Container className="flex max-w-[760px] flex-col gap-10 py-14 sm:py-20">
      <header className="flex flex-col gap-4">
        <Eyebrow>Legal</Eyebrow>
        <h1 className="text-[36px] font-semibold tracking-[-0.02em] sm:text-[44px]" style={{ color: 'var(--ink)' }}>
          Terms of Service
        </h1>
        <p className="text-[15.5px] leading-[1.65]" style={{ color: 'var(--muted)' }}>
          Effective {EFFECTIVE}. These terms govern use of Talkr, a browser phone and messaging workspace for
          acquisitions teams, provided by Your Company LLC, 123 Example St, Anytown, ST
          00000 (&ldquo;we&rdquo;, &ldquo;us&rdquo;). By using Talkr you agree to them.
        </p>
      </header>

      <Section id="service" title="The service">
        <p>
          Talkr lets a team place and receive phone calls, send and receive text messages, keep a shared history
          of both, and run outbound calling campaigns from a web browser or a Chrome extension. Phone numbers are
          supplied through our telephony carrier and may be changed or released if the carrier requires it.
        </p>
        <p>
          <strong>Talkr does not support emergency calls.</strong> It is not a replacement for a traditional phone
          line. Do not rely on it to reach 911 or any other emergency service.
        </p>
      </Section>

      <Section id="accounts" title="Accounts">
        <Bullets
          items={[
            'You must be at least 18 and using Talkr for business purposes.',
            'You are responsible for what happens under your account and for keeping your sign-in private.',
            'Team administrators control who is on the team, which numbers ring whom, and whether calls are recorded.',
          ]}
        />
      </Section>

      <Section id="use" title="Acceptable use and compliance">
        <p>
          You are responsible for complying with all laws that apply to your calls and messages, including the
          TCPA, the Telemarketing Sales Rule, state telemarketing and recording laws, and the CTIA messaging
          principles. In particular you agree to:
        </p>
        <Bullets
          items={[
            'Text only people who have given you their consent to receive text messages, and keep a record of that consent.',
            'Honor every opt-out. Talkr blocks texts to numbers that reply STOP; do not try to work around that.',
            'Respect calling hours, do-not-call lists and any suppression records.',
            'Give any notice and obtain any consent that call recording requires where you and the other party are located.',
            'Not send content that carriers prohibit, including anything related to sex, hate, alcohol, firearms, tobacco, cannabis, gambling, loans, debt collection or third-party lead generation.',
            'Not use Talkr to send messages on behalf of any business other than your own.',
          ]}
        />
      </Section>

      <Section id="sms" title="SMS Terms">
        <p>
          <strong>Program:</strong> Talkr account and service messages. <strong>Description:</strong> sign-in and
          account notices you request, and conversational texts between you and a member of our team.{' '}
          <strong>Frequency:</strong> varies. <strong>Msg &amp; data rates may apply.</strong>{' '}
          <strong>Reply STOP to cancel. Reply HELP for help</strong>, or contact us at{' '}
          <a href="tel:+18305550193" style={{ color: 'var(--accent)', fontWeight: 600 }}>
            (830) 555-0193
          </a>{' '}
          or{' '}
          <a href="mailto:contact@example.com" style={{ color: 'var(--accent)', fontWeight: 600 }}>
            contact@example.com
          </a>
          . Carriers are not liable for delayed or undelivered messages. See our Privacy Policy:{' '}
          <Link href="/privacy-policy" style={{ color: 'var(--accent)', fontWeight: 600 }}>
            https://talkr.example.com/privacy-policy
          </Link>
        </p>
        <p>
          Mobile numbers and SMS consent are never shared with third parties or affiliates for marketing or
          promotional purposes.
        </p>
      </Section>

      <Section id="content" title="Your content">
        <p>
          Contacts, notes, recordings and messages you put into Talkr stay yours. You give us the right to store,
          transmit and display them only as needed to run the service for you. You confirm you have the right to
          use every phone number and record you add.
        </p>
      </Section>

      <Section id="fees" title="Fees">
        <p>
          Fees, if any, and carrier pass-through charges for calls and messages are set out in your agreement with
          us. Carrier charges for undeliverable or filtered messages are not refundable.
        </p>
      </Section>

      <Section id="termination" title="Suspension and termination">
        <p>
          We may suspend or close an account that violates these terms, puts our phone numbers or carrier
          relationship at risk, or is used unlawfully. You can stop using Talkr at any time; ask us to delete your
          data using the contact below.
        </p>
      </Section>

      <Section id="disclaimer" title="Disclaimers and limitation of liability">
        <p>
          Talkr is provided &ldquo;as is&rdquo;. We do not promise that calls or messages will always connect or
          be delivered; carriers, networks and browsers are outside our control. To the fullest extent the law
          allows, we are not liable for indirect, incidental or consequential damages, and our total liability for
          any claim is limited to the amount you paid us for Talkr in the twelve months before the claim.
        </p>
      </Section>

      <Section id="law" title="Governing law">
        <p>
          These terms are governed by the laws of the State of Texas. Any dispute will be brought in the state or
          federal courts located in Bexar County, Texas.
        </p>
      </Section>

      <Section id="changes" title="Changes to these terms">
        <p>
          When we change these terms we update the effective date at the top and announce material changes inside
          Talkr before they take effect. Continuing to use Talkr after that means you accept the new terms.
        </p>
      </Section>

      <Section id="contact" title="Contact">
        <p>
          Your Company LLC, 123 Example St, Anytown, ST 00000.{' '}
          <a href="tel:+18305550193" style={{ color: 'var(--accent)', fontWeight: 600 }}>
            (830) 555-0193
          </a>{' '}
          ·{' '}
          <a href="mailto:contact@example.com" style={{ color: 'var(--accent)', fontWeight: 600 }}>
            contact@example.com
          </a>
        </p>
      </Section>
    </Container>
  );
}
