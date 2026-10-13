import type { Metadata } from 'next';
import { Icon } from '@/components/Icon';
import { Container, Cta, CtaBand, Eyebrow, Shot, Tile } from '@/components/site';

export const metadata: Metadata = {
  title: 'Talkr · The phone for acquisitions teams',
  description:
    'Browser calling, texting, sales dialers, workflows and reporting for real estate acquisitions, with a Chrome extension that follows you into your CRM.',
};

export default function HomePage() {
  return (
    <>
      {/* ── Hero ─────────────────────────────────────────────────────── */}
      <section className="overflow-hidden pb-16 pt-12 sm:pb-24 sm:pt-20">
        <Container className="grid items-center gap-12 lg:grid-cols-[1.05fr_1fr]">
          <div className="max-w-[560px]">
            <Eyebrow>The phone for acquisitions teams</Eyebrow>
            <h1
              className="mt-5 text-[40px] font-semibold leading-[1.02] tracking-[-0.03em] sm:text-[60px]"
              style={{ color: 'var(--ink)' }}
            >
              Every call and every text, on one screen.
            </h1>
            <p className="mt-6 text-[17px] leading-7 sm:text-[19px] sm:leading-8" style={{ color: 'var(--muted)' }}>
              Talkr is the browser phone built for real estate acquisitions. Dial, text, route and report from one
              workspace, then take the same phone into your CRM with the Chrome extension.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Cta href="/dialer" size="lg">
                Open Talkr
                <Icon name="chevron-right" size={16} />
              </Cta>
              <Cta href="/how-to" tone="ghost" size="lg">
                See how it works
              </Cta>
            </div>
            <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-[14px]" style={{ color: 'var(--muted)' }}>
              {['Works on your phone', 'No install to start', 'Chrome extension included'].map((t) => (
                <li key={t} className="flex items-center gap-2">
                  <Icon name="check" size={15} style={{ color: 'var(--accent)' }} />
                  {t}
                </li>
              ))}
            </ul>
          </div>

          <div className="relative mx-auto w-full max-w-[560px] lg:max-w-none">
            <div
              className="overflow-hidden"
              style={{ borderRadius: 'var(--r-lg)', background: 'var(--panel-2)', border: '1px solid var(--line)' }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element -- static marketing asset */}
              <img src="/site/hero.jpg" alt="" width={1600} height={1000} className="block h-auto w-full" />
            </div>
            <Shot
              src="/site/dialer-phone.png"
              alt="The Talkr dialer on a phone, with a number typed and a large red Call button"
              width={1170}
              height={1992}
              className="absolute -bottom-8 right-4 w-[34%] sm:-bottom-10 sm:right-8"
              style={{ transform: 'rotate(-3deg)' }}
            />
          </div>
        </Container>
      </section>

      {/* ── What's inside ────────────────────────────────────────────── */}
      <section className="py-16 sm:py-24" style={{ borderTop: '1px solid var(--line-soft)' }}>
        <Container>
          <div className="max-w-[640px]">
            <Eyebrow>What&apos;s inside</Eyebrow>
            <h2 className="mt-4 text-[30px] font-semibold leading-tight tracking-[-0.02em] sm:text-[40px]" style={{ color: 'var(--ink)' }}>
              One workspace, the whole day.
            </h2>
          </div>
          <div className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            <Tile icon="phone" title="Browser calling">
              Dial from any browser with live mute, hold, keypad and transfer. Wrap up with a disposition and a note.
            </Tile>
            <Tile icon="msg" title="Team texting">
              One thread per lead, shared by the team, with templates and automatic STOP handling.
            </Tile>
            <Tile icon="transfer" title="Sales dialers">
              Campaigns that hand you the next lead, schedule retries by outcome and skip the answering machines.
            </Tile>
            <Tile icon="template" title="Workflows">
              When a call ends or a text arrives, create the task, send the follow-up, tag the lead. No code.
            </Tile>
            <Tile icon="grid" title="Reporting and floor">
              Calls, connects and talk time by rep and by day, plus a live floor view of who is on the phone.
            </Tile>
            <Tile icon="globe" title="Chrome extension">
              The same phone in a popup and a side panel, with the lead card beside the call.
            </Tile>
          </div>
        </Container>
      </section>

      {/* ── Why Talkr ────────────────────────────────────────────────── */}
      <section className="py-16 sm:py-24" style={{ background: 'var(--panel)', borderTop: '1px solid var(--line-soft)' }}>
        <Container className="grid gap-12 lg:grid-cols-[1fr_1.1fr] lg:items-center">
          <div>
            <Eyebrow>Why Talkr</Eyebrow>
            <h2 className="mt-4 text-[30px] font-semibold leading-tight tracking-[-0.02em] sm:text-[40px]" style={{ color: 'var(--ink)' }}>
              Built around the deal, not the call center.
            </h2>
            <p className="mt-5 text-[16px] leading-7" style={{ color: 'var(--muted)' }}>
              Most phone systems are made for support desks. Talkr is made for a team that buys houses over the phone
              and needs every conversation to land in the deal.
            </p>
            <div className="mt-8 flex flex-col gap-6">
              {[
                {
                  t: 'Your CRM in the call',
                  b: 'Two-way Podio sync keeps the lead, the property and the call history in one place, with no loops and no double entry.',
                },
                {
                  t: 'Numbers you can reconcile',
                  b: 'Every carrier event is stored raw, processed once and checked back against the carrier. When revenue meets call logs, they match.',
                },
                {
                  t: 'Own your cost',
                  b: 'Direct carrier pricing with a per-call cost ledger, instead of a per-seat bundle with a markup.',
                },
              ].map(({ t, b }) => (
                <div key={t} className="flex gap-4">
                  <span
                    className="mt-0.5 inline-flex h-8 w-8 shrink-0 items-center justify-center"
                    style={{ borderRadius: 9, background: 'var(--accent)', color: '#fff' }}
                  >
                    <Icon name="check" size={16} />
                  </span>
                  <div>
                    <h3 className="text-[17px] font-semibold" style={{ color: 'var(--text)' }}>
                      {t}
                    </h3>
                    <p className="mt-1 text-[15px] leading-6" style={{ color: 'var(--muted)' }}>
                      {b}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>
          <Shot
            src="/site/dialer-desktop.png"
            alt="The Talkr workspace on a desktop: dark rail on the left, dialer and recent calls in the middle"
            width={1280}
            height={800}
            caption="The workspace on a desktop. The rail stays out of the way; the call gets the width."
          />
        </Container>
      </section>

      {/* ── Screens ──────────────────────────────────────────────────── */}
      <section className="py-16 sm:py-24" style={{ borderTop: '1px solid var(--line-soft)' }}>
        <Container>
          <div className="max-w-[640px]">
            <Eyebrow>On your phone</Eyebrow>
            <h2 className="mt-4 text-[30px] font-semibold leading-tight tracking-[-0.02em] sm:text-[40px]" style={{ color: 'var(--ink)' }}>
              Thumb-sized, from the driveway.
            </h2>
            <p className="mt-5 text-[16px] leading-7" style={{ color: 'var(--muted)' }}>
              The dialer fills the screen with keys you can hit while walking. Messages read like the phone you already
              use, one thread per lead, with the whole team in it.
            </p>
          </div>
          <div className="mt-12 grid items-start gap-8 sm:grid-cols-2 lg:grid-cols-3">
            <Shot src="/site/dialer-phone.png" alt="Dialer on a phone" width={1170} height={1992} caption="The dialer" />
            <Shot src="/site/messages-phone.png" alt="A text thread on a phone" width={1170} height={1992} caption="Messages" />
            <div className="grid grid-cols-2 gap-4 sm:col-span-2 lg:col-span-1 lg:grid-cols-1">
              <Shot src="/site/extension-popup.png" alt="The Chrome extension popup dialer" width={400} height={620} caption="Extension popup" />
              <Shot src="/site/extension-sidepanel.png" alt="The Chrome extension side panel during a call" width={400} height={780} caption="Side panel" />
            </div>
          </div>
        </Container>
      </section>

      <CtaBand title="Pick up where the lead left off." body="Open Talkr in any browser. No sign-in to get started today." />
    </>
  );
}
