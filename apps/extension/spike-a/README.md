# Talkr Spike A

**Goal:** verify whether smrtPhone tab audio contains both call legs (seller + agent) or only the seller. The answer decides whether the live extension uses Deepgram diarization on a single channel, or sends Deepgram a 2-channel stream (tab=seller, mic=agent).

## Install (unpacked, ~30 seconds)

1. Open `brave://extensions` (or `chrome://extensions`).
2. Toggle **Developer mode** on (top right).
3. Click **Load unpacked**.
4. Select this folder: `apps/extension/spike-a` in your checkout.
5. The extension appears in the toolbar (orange "T" tile, no icon yet — that's fine for a spike).

## Run the test

1. Open the smrtPhone web app in this same browser, sign in.
2. Start a test call. **Use a phone you can talk into AND hear** (e.g. call your own cell, leave the call connected with you talking on both ends).
3. Click the Talkr Spike A toolbar icon.
4. Click **Start capture**. Allow the mic prompt when it appears.
5. Talk for ~30 seconds. Have the other end (your cell) talk too. Take turns clearly.
6. Click **Stop & save**.

Two WAVs land in your Downloads folder:

- `talkr-spike-tab-<timestamp>.wav` — what was playing through the smrtPhone tab.
- `talkr-spike-mic-<timestamp>.wav` — your local microphone.

## Listen and report back

Open both in any audio player. The verdict shapes Day 2:

| What you hear | Verdict | What we build |
|---|---|---|
| **tab.wav has both you AND the seller** | smrtPhone mixes both legs into tab audio | Single-channel Deepgram with diarization. Mic capture optional. |
| **tab.wav has only the seller, mic.wav has only you** | Clean separation | Send Deepgram a 2-channel stream. No diarization needed. Best case for accuracy. |
| **tab.wav is silent or empty** | tabCapture didn't reach the smrtPhone WebRTC | Need to dig: maybe smrtPhone runs in an iframe, or uses a separate audio element. Falls back to system-audio capture (BlackHole/VB-Cable) which is uglier. |

## Sanity check before the real test

Before testing on smrtPhone, verify the spike works at all:

1. Open `youtube.com`, play any video.
2. Toolbar -> Start capture. Talk into your mic. Stop after 10s.
3. `tab.wav` should have the YouTube audio. `mic.wav` should have your voice.

If that works, you know the extension is healthy and any smrtPhone weirdness is specific to smrtPhone.

## After updating the extension

If you reload the extension after pulling new code:
1. `brave://extensions` -> click the reload icon on the Talkr Spike A card.
2. **Close any open popup** (click somewhere else, then re-open by clicking the toolbar icon).
3. If a session was in progress before reload, it's gone. Start a fresh capture.

## Troubleshooting

- **"Stop button does nothing"**: should be fixed in v0.2. If it still happens, open the popup, right-click in it, choose Inspect, and check the Console tab for the actual error. Send me the message.
- **No mic prompt appears**: Brave/Chrome sometimes routes the prompt to the active tab's address bar instead of a dialog. Look for a small mic icon at the right end of the address bar.
- **`mic: NOT granted` even after allowing**: the extension needs to be reloaded after a permission change. `brave://extensions` -> reload icon.
- **WAV files are silent**: tab capture only works on tabs that are actually playing audio. If you click Start before the call connects, the first second or two will be silent. Sanity-check on YouTube first.

## Notes / known limits

- Sample rate is fixed at 16 kHz mono per file (matches what we'll send to Deepgram in production).
- Echo cancellation, noise suppression, and AGC are disabled on the mic to give us raw audio. This is intentional for the spike.
- The tab's audio is re-routed back to your speakers so the call sounds normal during capture. If you hear silence on the call when capturing, that's a bug, tell me.
- ScriptProcessorNode is deprecated. Production code will use AudioWorklet. Spike is fine.
- Popup state is now persistent (chrome.storage.session). Closing and re-opening the popup mid-recording shows the live timer and a working Stop button.
