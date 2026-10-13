import type { Metadata } from 'next';
import { Icon, type IconName } from '@/components/Icon';
import { Container, CtaBand, Eyebrow, Shot } from '@/components/site';

export const metadata: Metadata = {
  title: 'Features',
  description: 'Everything in Talkr: calling, texting, dialers, workflows, reporting, integrations and the platform underneath.',
};

interface Group {
  id: string;
  icon: IconName;
  eyebrow: string;
  title: string;
  lead: string;
  items: { name: string; body: string }[];
  shot?: { src: string; alt: string; width: number; height: number };
}

const GROUPS: Group[] = [
  {
    id: 'calling',
    icon: 'phone',
    eyebrow: 'Calling',
    title: 'A real phone in the browser.',
    lead: 'Outbound and inbound over WebRTC, with the controls a rep reaches for on every call.',
    items: [
      { name: 'Click to dial', body: 'Type, paste or pick from recents. Letters are fine; the keypad is thumb-sized on a phone.' },
      { name: 'Live call controls', body: 'Mute, hold, keypad, speaker and transfer without leaving the page.' },
      { name: 'Inbound routing', body: 'Calls ring the reps who are present and available, in the order you set, inside business hours.' },
      { name: 'Queues and IVR', body: 'Hold callers in a queue or offer a menu, then hand them to the right team.' },
      { name: 'Voicemail and recordings', body: 'Missed calls land as voicemail. Recordings attach to the call record.' },
      { name: 'Wrap-up', body: 'Every call ends with a disposition and a note, so the next rep knows what happened.' },
    ],
    shot: { src: '/site/dialer-desktop.png', alt: 'The dialer on a desktop', width: 1280, height: 800 },
  },
  {
    id: 'messaging',
    icon: 'msg',
    eyebrow: 'Messaging',
    title: 'Texting the whole team can see.',
    lead: 'One conversation per lead, shared across the team, with the compliance handled for you.',
    items: [
      { name: 'Team inbox', body: 'Threads sorted by the latest message, with unread counts and who replied last.' },
      { name: 'Templates', body: 'Saved messages by category, filled in with the lead and property details.' },
      { name: 'STOP and consent', body: 'Opt-outs are honored automatically and recorded. Consent is tracked per number.' },
      { name: 'Delivery status', body: 'Sent, delivered, failed: the state of every message, straight from the carrier.' },
    ],
    shot: { src: '/site/messages-phone.png', alt: 'A message thread on a phone', width: 1170, height: 1992 },
  },
  {
    id: 'dialers',
    icon: 'transfer',
    eyebrow: 'Sales dialers',
    title: 'Campaigns that hand you the next lead.',
    lead: 'Load a list, start a session, and Talkr keeps the calls coming.',
    items: [
      { name: 'Preview and power modes', body: 'See the lead before you dial, or let the session dial for you.' },
      { name: 'Retry scheduling', body: 'No answer, busy and voicemail each schedule the next attempt on their own rules.' },
      { name: 'Answering machine detection', body: 'Machines are skipped so reps only talk to people.' },
      { name: 'Compliance built in', body: 'Suppression lists, calling hours and consent are enforced on every dial.' },
    ],
    shot: { src: '/site/campaigns.png', alt: 'The campaigns page', width: 1280, height: 800 },
  },
  {
    id: 'workflows',
    icon: 'template',
    eyebrow: 'Workflows and tasks',
    title: 'Automate the follow-up.',
    lead: 'When something happens on the phone, Talkr does the next thing.',
    items: [
      { name: 'Triggers', body: 'Call ended, text received, disposition set, lead created and more.' },
      { name: 'Conditions', body: 'Only when the disposition is "interested", only during business hours, only for this campaign.' },
      { name: 'Actions', body: 'Create a task, send a text, tag the lead, notify the team, update the CRM.' },
      { name: 'Tasks', body: 'A to-do list per rep with due dates, so nothing that came out of a call gets lost.' },
    ],
  },
  {
    id: 'reporting',
    icon: 'grid',
    eyebrow: 'Reporting and floor',
    title: 'Know what the phones did today.',
    lead: 'Numbers defined once at the database level, so every screen agrees.',
    items: [
      { name: 'Overview and by rep', body: 'Calls, connects, talk time and outcomes, for the team and per person.' },
      { name: 'By day', body: 'Trends over any range, bucketed in your time zone.' },
      { name: 'Queues and quality', body: 'Wait times, abandons and call quality with the cause attributed: network, device or carrier.' },
      { name: 'Cost ledger', body: 'Per-call carrier cost pulled from the provider, so you know what each conversation cost.' },
      { name: 'Live floor', body: 'Who is on a call, who is available and who is away, updating as it happens.' },
    ],
    shot: { src: '/site/calls.png', alt: 'Call history', width: 1280, height: 800 },
  },
  {
    id: 'integrations',
    icon: 'globe',
    eyebrow: 'Integrations',
    title: 'It goes where you work.',
    lead: 'The phone follows the rep into the CRM, and the data flows both ways.',
    items: [
      { name: 'Podio sync', body: 'Field-mapped, two-way and loop-safe. Calls and texts land on the deal; deal changes come back.' },
      { name: 'Chrome extension', body: 'A popup dialer and a side-panel call console with the lead card beside the call.' },
      { name: 'Public API and webhooks', body: 'Everything the app can do, with API keys and signed webhook deliveries.' },
      { name: 'Runs on Telnyx', body: 'Calls, texts and numbers on Telnyx. Talkr sits behind a carrier adapter, so the carrier can change.' },
    ],
    shot: { src: '/site/extension-sidepanel.png', alt: 'The Chrome extension side panel', width: 400, height: 780 },
  },
  {
    id: 'platform',
    icon: 'settings',
    eyebrow: 'Platform',
    title: 'Data you can trust.',
    lead: 'Underneath, Talkr is built like a ledger.',
    items: [
      { name: 'Event-sourced calls', body: 'Every call is a sequence of carrier events you can replay. Nothing is overwritten.' },
      { name: 'Reconciliation', body: 'Records are checked against the carrier, and mismatches are surfaced instead of hidden.' },
      { name: 'Roles and audit', body: 'Owner, admin, manager and rep roles, with an audit log of who changed what.' },
      { name: 'Team time zones', body: 'Reps work from where they are. Business hours and reports follow each team.' },
    ],
  },
];

export default function FeaturesPage() {
  return (
    <>
      <section className="pb-10 pt-12 sm:pb-14 sm:pt-20">
        <Container>
          <div className="max-w-[680px]">
            <Eyebrow>Features</Eyebrow>
            <h1 className="mt-5 text-[38px] font-semibold leading-[1.05] tracking-[-0.03em] sm:text-[56px]" style={{ color: 'var(--ink)' }}>
              Everything a calling team needs, nothing it has to work around.
            </h1>
            <p className="mt-6 text-[17px] leading-7" style={{ color: 'var(--muted)' }}>
              Talkr replaces the phone system, the texting tool and the dialer with one workspace that knows your leads.
            </p>
          </div>
          <nav className="mt-8 flex flex-wrap gap-2" aria-label="On this page">
            {GROUPS.map((g) => (
              <a
                key={g.id}
                href={`#${g.id}`}
                className="inline-flex h-9 items-center gap-2 px-3 text-[13px] font-medium"
                style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--r-btn)', color: 'var(--text)' }}
              >
                <Icon name={g.icon} size={14} style={{ color: 'var(--accent)' }} />
                {g.eyebrow}
              </a>
            ))}
          </nav>
        </Container>
      </section>

      {GROUPS.map((g, i) => (
        <section
          key={g.id}
          id={g.id}
          className="scroll-mt-20 py-14 sm:py-20"
          style={{ borderTop: '1px solid var(--line-soft)', background: i % 2 ? 'var(--panel)' : 'transparent' }}
        >
          <Container className={`grid gap-10 ${g.shot ? 'lg:grid-cols-[1.1fr_1fr] lg:items-start' : ''}`}>
            <div>
              <Eyebrow>{g.eyebrow}</Eyebrow>
              <h2 className="mt-4 text-[28px] font-semibold leading-tight tracking-[-0.02em] sm:text-[36px]" style={{ color: 'var(--ink)' }}>
                {g.title}
              </h2>
              <p className="mt-3 text-[16px] leading-7" style={{ color: 'var(--muted)' }}>
                {g.lead}
              </p>
              <dl className="mt-8 grid gap-x-8 gap-y-6 sm:grid-cols-2">
                {g.items.map((it) => (
                  <div key={it.name}>
                    <dt className="flex items-center gap-2 text-[15px] font-semibold" style={{ color: 'var(--text)' }}>
                      <span style={{ width: 6, height: 6, background: 'var(--accent)' }} aria-hidden />
                      {it.name}
                    </dt>
                    <dd className="mt-1.5 text-[14px] leading-6" style={{ color: 'var(--muted)' }}>
                      {it.body}
                    </dd>
                  </div>
                ))}
              </dl>
            </div>
            {g.shot && (
              <Shot
                src={g.shot.src}
                alt={g.shot.alt}
                width={g.shot.width}
                height={g.shot.height}
                className={g.shot.height > g.shot.width ? 'mx-auto w-full max-w-[320px]' : ''}
              />
            )}
          </Container>
        </section>
      ))}

      <CtaBand title="See it with your own leads." body="Open the workspace and place a call. The rest of the features are one tab away." />
    </>
  );
}
