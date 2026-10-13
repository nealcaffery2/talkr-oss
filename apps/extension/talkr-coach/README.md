# Talkr Coach (Production Extension v0.1)

Real-time coaching overlay for smrtPhone calls. The extension captures the smrtPhone tab's audio + your microphone, streams transcripts to Deepgram in real time, retrieves relevant historical patterns + playbook chunks for each seller utterance, and renders a 1-2 sentence Haiku 4.5 suggestion in an orange overlay before you have to respond.

This is the production extension, separate from `spike-a` (which only captured WAV files for diarization validation).

## Install (one time)

1. Open `brave://extensions` (or `chrome://extensions`).
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked**.
4. Select this folder: `apps/extension/talkr-coach` in your checkout.
5. The Talkr Coach icon appears in the toolbar.

## Configure (one time per browser)

1. Click the Talkr Coach toolbar icon to open the popup.
2. Expand **Settings**.
3. Fill in:
   - **API base URL**: where the backend is deployed.
     - For local dev: `http://localhost:3000`
     - For Vercel deploy: `https://talkr-coach.example.com` (or whatever you deploy it as)
   - **Talkr API key**: paste the value of `TALKR_API_KEY` from `apps/api/.env.local`.
   - **Agent ID**: your Supabase user uuid (run `select id from auth.users where email = 'you@example.com'` in the Supabase SQL editor; for now, can be any consistent uuid string).
4. Click **Save settings**.

## Use

There are two ways to start a session:

1. **Manual (popup)**: Click the toolbar icon, then **Start session**. A timer appears. The overlay (bottom-right of the smrtPhone tab) starts listening.
2. **Auto (content script)**: Open the smrtPhone web app. When the content script detects a call going active, it auto-starts the session. (Detection heuristic is generic until tuned to smrtPhone's actual DOM — see `content_script.js`.)

During a call:
- The overlay shows the live seller utterance at the bottom (italics).
- When the seller pauses (Deepgram emits `speech_final`), the overlay shows the suggested next line streaming in token by token.
- Click **Used / Partial / Wrong / Dismiss** to log the action (telemetry feeds back into review).

## What runs where

```
   smrtPhone tab (Brave)
   ├── content_script.js       (DOM watcher + overlay iframe)
   ├── overlay.html iframe     (renders streaming suggestions)
   └── tab audio MediaStream
              │
              ▼ chrome.tabCapture
   service_worker.js
              │ getMediaStreamId
              ▼ delegates
   offscreen.html (background context)
   ├── Tab + mic MediaStream → 16kHz mono Int16 PCM, 2-channel
   ├── WebSocket → Deepgram Nova-3 streaming (multichannel)
   ├── On speech_final from seller channel:
   │     POST /api/suggest (SSE)
   │     Forward token deltas → overlay
   └── Maintains rolling 8-turn context for stage detection
```

## Permissions explained

- `tabCapture` - capture audio of the smrtPhone tab
- `offscreen` - hold MediaStream + WebSocket beyond service worker lifetime
- `storage` - settings + session state
- `scripting`, `activeTab` - content script + tab id queries
- `alarms` - service worker keepalive during long calls
- Host: `*.smrtphone.io`, `*.smrtphone.com`, `api.deepgram.com`, your API host

## Known limits + roadmap (v0.1)

- DOM call-active detection is heuristic; may need tuning per smrtPhone version.
- Overlay action telemetry currently console-logs only (next: PATCH `live_suggestions.agent_action`).
- Overlay isn't draggable yet.
- No "show different angle" button yet (re-query patterns excluding last batch).
- Cost dashboard isn't surfaced in the popup yet.

## Troubleshooting

- **"Open the popup and fill in API base, API key, agent ID first"**: hit the toolbar icon, expand Settings, fill in.
- **No suggestions appearing**: check the popup status. Most common: API key mismatch (401) or backend not running.
- **Mic prompt doesn't appear**: check Brave's address bar for a tiny mic icon. Allow once per origin.
- **Overlay invisible**: scroll to bottom-right of the smrtPhone tab. If still missing, check browser console on the smrtPhone tab for errors loading the overlay iframe.
- **Stop button does nothing after popup reopen**: should be fixed via `chrome.storage.session` state; if it bugs, reload the extension at `brave://extensions`.
