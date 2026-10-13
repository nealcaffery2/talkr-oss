import type { Metadata } from 'next';
import Link from 'next/link';
import type { ReactNode } from 'react';
import { Icon } from '@/components/Icon';
import { Container, CtaBand, Eyebrow, Shot } from '@/components/site';

export const metadata: Metadata = {
  title: 'How to use Talkr',
  description: 'Open the app, make a call, text a lead, install the Chrome extension, run a campaign, read the reports.',
};

interface Step {
  id: string;
  title: string;
  body: ReactNode;
  bullets?: string[];
  shot?: { src: string; alt: string; width: number; height: number; tall?: boolean };
}

const STEPS: Step[] = [
  {
    id: 'open',
    title: 'Open Talkr',
    body: (
      <>
        Go to <Link href="/dialer" style={{ color: 'var(--accent)', fontWeight: 600 }}>the app</Link> in any browser, on a
        phone or a computer. There is no sign-in right now: you land straight on the dialer.
      </>
    ),
    bullets: [
      'On an iPhone, tap Share, then Add to Home Screen. It opens full-screen like a native app.',
      'On a computer, allow the microphone when the browser asks, or calls will have no audio.',
      'The green square by the phone button is your presence. Tap it to go away or come back.',
    ],
  },
  {
    id: 'call',
    title: 'Make a call',
    body: 'Open the Dialer tab. Type the number on the keypad, paste it, or pick it from Recent or Lead. Then press the green Call button.',
    bullets: [
      'Letters are fine. Typing a vanity number or a name-like string is turned into digits.',
      'While on the call: mute, keypad, hold, speaker and transfer sit under the timer.',
      'When you hang up, pick a disposition and leave a note. That is what the next rep sees.',
    ],
    shot: { src: '/site/dialer-phone.png', alt: 'The dialer with a number typed', width: 1170, height: 1992, tall: true },
  },
  {
    id: 'answer',
    title: 'Answer a call',
    body: 'Incoming calls show a banner at the top of whatever page you are on, with the caller and the lead if we know them. Accept or decline.',
    bullets: [
      'Calls ring the reps who are present, in the order set on the Team page, inside business hours.',
      'If nobody picks up, the caller goes to voicemail and the voicemail shows in Call history.',
    ],
  },
  {
    id: 'text',
    title: 'Text a lead',
    body: 'Open Messages. Pick a conversation, or start one with the plus button and a number. Type, or choose a template, then send.',
    bullets: [
      'Everyone on the team sees the same thread, so nobody double-texts a lead.',
      'A lead who replies STOP is opted out automatically. Talkr will not let you text them again.',
      'The phone button in the thread header calls the lead from the same screen.',
    ],
    shot: { src: '/site/messages-phone.png', alt: 'A text thread', width: 1170, height: 1992, tall: true },
  },
  {
    id: 'extension',
    title: 'Use it inside Chrome',
    body: 'The Chrome extension puts the same phone in a popup and a side panel, so you can call and text from the CRM tab you are already on.',
    bullets: [
      'Open chrome://extensions, switch on Developer mode, choose Load unpacked, and pick the talkr-voice dist folder.',
      'Pin Talkr to the toolbar. The popup is the dialer; the side panel opens during a call with the lead card next to it.',
      'The popup closes when you click away, but the call does not drop. It keeps running in the side panel.',
    ],
    shot: { src: '/site/extension-sidepanel.png', alt: 'The extension side panel during a call', width: 400, height: 780, tall: true },
  },
  {
    id: 'campaign',
    title: 'Run a campaign',
    body: 'Open Campaigns from More, create one, and load the leads. Start a session and Talkr hands you the next lead each time you finish one.',
    bullets: [
      'Preview mode shows the lead first; power mode dials as soon as you are ready.',
      'The disposition you pick decides the next attempt: no answer retries later, not interested drops the lead.',
      'Pause the session any time. Your place in the list is kept.',
    ],
    shot: { src: '/site/campaigns.png', alt: 'The campaigns page', width: 1280, height: 800 },
  },
  {
    id: 'automate',
    title: 'Automate the follow-up',
    body: 'Open Workflows from More. A workflow is a trigger, an optional condition, and one or more actions.',
    bullets: [
      'Example: when a call ends with the disposition "Interested", create a task for tomorrow and text the lead a thank-you.',
      'Tasks land on the Tasks page for the rep who owns the lead.',
    ],
  },
  {
    id: 'reports',
    title: 'Read the numbers',
    body: 'Reports shows calls, connects, talk time and outcomes by rep and by day. Floor shows who is on the phone right now.',
    bullets: [
      'Call history lists every call with its recording, notes and disposition.',
      'Costs shows what each call and text cost at the carrier.',
    ],
    shot: { src: '/site/calls.png', alt: 'Call history', width: 1280, height: 800 },
  },
];

export default function HowToPage() {
  return (
    <>
      <section className="pb-10 pt-12 sm:pb-14 sm:pt-20">
        <Container>
          <div className="max-w-[680px]">
            <Eyebrow>How to</Eyebrow>
            <h1 className="mt-5 text-[38px] font-semibold leading-[1.05] tracking-[-0.03em] sm:text-[56px]" style={{ color: 'var(--ink)' }}>
              From open to first call in two minutes.
            </h1>
            <p className="mt-6 text-[17px] leading-7" style={{ color: 'var(--muted)' }}>
              Eight short steps. Most days you only need the first four.
            </p>
          </div>
          <ol className="mt-8 flex flex-wrap gap-2" aria-label="Steps">
            {STEPS.map((s, i) => (
              <li key={s.id}>
                <a
                  href={`#${s.id}`}
                  className="inline-flex h-9 items-center gap-2 px-3 text-[13px] font-medium"
                  style={{ background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: 'var(--r-btn)', color: 'var(--text)' }}
                >
                  <span style={{ color: 'var(--accent)', fontWeight: 700 }}>{i + 1}</span>
                  {s.title}
                </a>
              </li>
            ))}
          </ol>

          <div
            className="mt-8 flex items-start gap-3 p-4 text-[14px] leading-6"
            style={{ background: 'var(--accent-soft)', borderRadius: 'var(--r-card)', color: 'var(--text)' }}
          >
            <Icon name="clock" size={18} style={{ color: 'var(--accent)', marginTop: 3, flexShrink: 0 }} />
            <p className="m-0">
              <strong>Right now:</strong> the carrier connection is still being set up, so a live call or text shows a
              &ldquo;no carrier&rdquo; message. Everything else on these pages works today, and calling switches on the moment the
              carrier is connected.
            </p>
          </div>
        </Container>
      </section>

      {STEPS.map((s, i) => (
        <section
          key={s.id}
          id={s.id}
          className="scroll-mt-20 py-14 sm:py-20"
          style={{ borderTop: '1px solid var(--line-soft)', background: i % 2 ? 'var(--panel)' : 'transparent' }}
        >
          <Container className={`grid gap-10 ${s.shot ? 'lg:grid-cols-[1.15fr_1fr] lg:items-start' : ''}`}>
            <div className="flex gap-5">
              <span
                className="inline-flex h-11 w-11 shrink-0 items-center justify-center text-[18px] font-bold"
                style={{ borderRadius: 12, background: 'var(--accent)', color: '#fff' }}
              >
                {i + 1}
              </span>
              <div className="min-w-0">
                <h2 className="text-[26px] font-semibold leading-tight tracking-[-0.02em] sm:text-[32px]" style={{ color: 'var(--ink)' }}>
                  {s.title}
                </h2>
                <p className="mt-3 text-[16px] leading-7" style={{ color: 'var(--muted)' }}>
                  {s.body}
                </p>
                {s.bullets && (
                  <ul className="mt-5 flex flex-col gap-3">
                    {s.bullets.map((b) => (
                      <li key={b} className="flex gap-3 text-[15px] leading-6" style={{ color: 'var(--text)' }}>
                        <Icon name="check" size={16} style={{ color: 'var(--accent)', marginTop: 4, flexShrink: 0 }} />
                        {b}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
            {s.shot && (
              <Shot
                src={s.shot.src}
                alt={s.shot.alt}
                width={s.shot.width}
                height={s.shot.height}
                className={s.shot.tall ? 'mx-auto w-full max-w-[300px]' : ''}
              />
            )}
          </Container>
        </section>
      ))}

      <CtaBand title="Ready? Open the dialer." body="Step one takes ten seconds. The rest you will pick up on the first call." />
    </>
  );
}
