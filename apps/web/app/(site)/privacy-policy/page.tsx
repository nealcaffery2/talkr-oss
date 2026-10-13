import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Container, Eyebrow } from '@/components/site';

export const metadata: Metadata = {
  title: 'Privacy Policy · Talkr',
  description:
    'What Talkr collects, how it is used, and how mobile numbers and SMS consent are handled. Mobile numbers and consent are never shared for marketing.',
};

const EFFECTIVE = 'September 23, 2026';

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

export default function PrivacyPolicyPage() {
  return (
    <Container className="flex max-w-[760px] flex-col gap-10 py-14 sm:py-20">
      <header className="flex flex-col gap-4">
        <Eyebrow>Legal</Eyebrow>
        <h1 className="text-[36px] font-semibold tracking-[-0.02em] sm:text-[44px]" style={{ color: 'var(--ink)' }}>
          Privacy Policy
        </h1>
        <p className="text-[15.5px] leading-[1.65]" style={{ color: 'var(--muted)' }}>
          Effective {EFFECTIVE}. Talkr is operated by Your Company LLC, 123 Example St,
          Anytown, ST 00000. This policy explains what we collect when you use Talkr or when a Talkr user calls
          or texts you, how we use it, and the choices you have.
        </p>
      </header>

      <Section id="who" title="Who this policy covers">
        <Bullets
          items={[
            <>
              <strong>Team members</strong> who sign in to Talkr to call, text and manage leads.
            </>,
            <>
              <strong>People our team members contact</strong>: homeowners, sellers and other contacts whose
              phone numbers a team member calls or texts through Talkr.
            </>,
          ]}
        />
      </Section>

      <Section id="collect" title="What we collect">
        <Bullets
          items={[
            <>
              <strong>Account information</strong>: name, email address, job title and time zone of team members.
            </>,
            <>
              <strong>Contact and lead records</strong> that team members add or import: names, phone numbers,
              property addresses, notes and call dispositions.
            </>,
            <>
              <strong>Communication records</strong>: call times, durations and outcomes; voicemails; call
              recordings where a team has turned recording on; text messages and any photos or files sent with
              them.
            </>,
            <>
              <strong>Technical data</strong>: browser type, IP address, device identifiers and application logs
              needed to run and secure the service.
            </>,
          ]}
        />
      </Section>

      <Section id="use" title="How we use it">
        <Bullets
          items={[
            'To place and receive calls and to send and receive text messages on behalf of team members.',
            'To show a team its shared call and message history so nobody contacts the same person twice.',
            'To enforce compliance rules: opt-out (STOP) lists, calling hours, suppression and do-not-call records.',
            'To produce reports on team activity, and to secure, support and improve the service.',
          ]}
        />
      </Section>

      <Section id="sms" title="SMS Messaging">
        <p>
          We use your mobile number only for the account and service messages you have asked for and for
          conversations you start with a member of our team. We do not share, sell, or provide your mobile
          phone number or SMS consent data to third parties or affiliates for marketing or promotional purposes.
          Message frequency varies. Message and data rates may apply. Reply STOP to opt out at any time or HELP
          for help.
        </p>
        <p>
          When you reply STOP, the number you texted stops messaging you immediately and the opt-out is recorded so
          it is honored across the whole team. Reply START to opt back in.
        </p>
      </Section>

      <Section id="sharing" title="When we share information">
        <p>We do not sell personal information, and we do not share it with anyone for their own marketing.</p>
        <Bullets
          items={[
            <>
              <strong>Service providers</strong> that run the service for us and may only use data on our
              instructions: our telephony carrier (Telnyx), our database and hosting providers (Supabase, Vercel),
              and a CRM when a team connects one.
            </>,
            <>
              <strong>Legal requirements</strong>: when required by law, subpoena or court order, or to protect
              the rights and safety of people using the service.
            </>,
          ]}
        />
      </Section>

      <Section id="recording" title="Call recording">
        <p>
          Teams can turn on call recording. Where it is on, calls are recorded and stored with the call record.
          Team members are responsible for giving any notice and obtaining any consent that the law where they
          and the other party are located requires.
        </p>
      </Section>

      <Section id="retention" title="How long we keep it">
        <p>
          We keep account and communication records for as long as the team&apos;s account is active and as
          needed for the purposes above, then delete or anonymize them. Opt-out records are kept so the opt-out
          keeps being honored.
        </p>
      </Section>

      <Section id="security" title="Security">
        <p>
          Data is encrypted in transit, access is limited to people who need it, and every action in the service
          is logged. No system is perfectly secure, so we cannot promise that information will never be accessed
          without authorization.
        </p>
      </Section>

      <Section id="choices" title="Your choices">
        <Bullets
          items={[
            'Text messages: reply STOP to any message to opt out, or HELP for help.',
            <>
              Access, correction or deletion: email{' '}
              <a href="mailto:contact@example.com" style={{ color: 'var(--accent)', fontWeight: 600 }}>
                contact@example.com
              </a>{' '}
              and we will respond within 30 days.
            </>,
            'Team members can update their own profile details on the Settings page inside Talkr.',
          ]}
        />
      </Section>

      <Section id="children" title="Children">
        <p>Talkr is a business tool for adults. We do not knowingly collect information from anyone under 18.</p>
      </Section>

      <Section id="changes" title="Changes to this policy">
        <p>
          When we change this policy we update the effective date at the top. Material changes are announced
          inside Talkr before they take effect.
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
        <p style={{ color: 'var(--muted)' }}>
          See also our{' '}
          <Link href="/terms-of-service" style={{ color: 'var(--accent)', fontWeight: 600 }}>
            Terms of Service
          </Link>
          .
        </p>
      </Section>
    </Container>
  );
}
