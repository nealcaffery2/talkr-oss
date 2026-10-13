/**
 * The one place Talkr can ask Chrome for the microphone.
 *
 * Neither the popup nor the offscreen document can: Chrome shows no permission
 * prompt in an action popup (getUserMedia there is "dismissed" unseen, and a
 * few dismissals become a hard block), and offscreen has no UI at all. An
 * ordinary tab on the extension's own origin can, and the grant it gets is the
 * one the offscreen softphone uses on every call after. So "Allow mic" opens
 * this page.
 *
 * When Chrome already blocks the mic, no prompt will ever show, so the page
 * says so and opens the exact settings screen; it watches the permission and
 * finishes by itself once the rep flips it to Allow.
 */

import '@/shared/styles.css';
import { send } from '@/shared/useCall';

const root = document.getElementById('root')!;
const SETTINGS_URL = `chrome://settings/content/siteDetails?site=${encodeURIComponent(`chrome-extension://${chrome.runtime.id}`)}`;

function render(title: string, body: string, actions: Array<{ label: string; primary?: boolean; onClick: () => void }> = []) {
  root.replaceChildren();
  const h = document.createElement('h1');
  h.textContent = title;
  const p = document.createElement('p');
  p.textContent = body;
  const row = document.createElement('div');
  row.className = 'actions';
  for (const a of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = a.label;
    if (a.primary) b.className = 'primary';
    b.onclick = a.onClick;
    row.append(b);
  }
  root.append(h, p, row);
}

let done = false;
let asking = false;

async function ask(): Promise<void> {
  if (done || asking) return;
  asking = true;
  render('Allow the microphone', 'Chrome is asking at the top of this window. Choose Allow so Talkr can place and take calls.');
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
  } catch (err) {
    asking = false;
    if (err instanceof DOMException && (err.name === 'NotFoundError' || err.name === 'OverconstrainedError')) {
      render('No microphone found', 'Plug in a headset or microphone, then try again.', [
        { label: 'Try again', primary: true, onClick: () => void ask() },
      ]);
      return;
    }
    render(
      'Chrome is blocking the microphone for Talkr',
      'Open Talkr’s Chrome settings, set Microphone to Allow, then come back to this tab. It finishes on its own.',
      [
        {
          label: 'Open Talkr’s Chrome settings',
          primary: true,
          onClick: () =>
            void chrome.tabs.create({ url: SETTINGS_URL }).catch(() =>
              render('Open this address in a new tab', `${SETTINGS_URL} — set Microphone to Allow, then come back here.`, [
                { label: 'Try again', primary: true, onClick: () => void ask() },
              ]),
            ),
        },
        { label: 'Try again', onClick: () => void ask() },
      ],
    );
    return;
  }
  done = true;
  // Bring the softphone up now, so the rep can dial straight from the popup.
  await send({ type: 'init' });
  render('Microphone allowed', 'Talkr can place and take calls. This tab closes in a moment.');
  setTimeout(() => window.close(), 1500);
}

// Flipping the setting to Allow in another tab finishes the job here.
void navigator.permissions
  ?.query({ name: 'microphone' as PermissionName })
  .then((status) => {
    status.onchange = () => {
      if (status.state === 'granted') void ask();
    };
  })
  .catch(() => undefined);

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !done) void ask();
});

const style = document.createElement('style');
style.textContent = `
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text); font: 400 14px/1.5 Inter, system-ui, sans-serif; }
  main { max-width: 440px; padding: 28px; background: var(--panel); border: 1px solid var(--line); border-radius: 14px; }
  h1 { font: 700 18px/1.25 Inter, system-ui, sans-serif; margin: 0 0 8px; }
  p { margin: 0 0 18px; color: var(--muted); }
  .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  button { font: 600 13px/1 Inter, system-ui, sans-serif; padding: 10px 14px; border-radius: 10px; border: 1px solid var(--line); background: var(--panel); color: var(--text); cursor: pointer; }
  button.primary { background: var(--accent); border-color: transparent; color: #fff; }
`;
document.head.append(style);

void ask();
