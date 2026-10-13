# Live transcription + AI calling (Clozr softphone)

## Live Deepgram (Phase 1)

Clozr streams call audio to Deepgram in the browser and asks Talkr for seller
intelligence. Talkr must expose:

| Method | Path | Env |
|--------|------|-----|
| POST | `/v1/transcription/token` | `DEEPGRAM_API_KEY`, optional `DEEPGRAM_PROJECT_ID` |
| POST | `/v1/calls/:id/intel` | `ANTHROPIC_API_KEY` |

Set these on the Talkr Platform API deployment, then place a call in Clozr with
**AI transcription** on. The Live card should show transcript lines and seller
intelligence without 404s. Missing keys return 503 (`transcription_not_configured`
/ `ai_not_configured`), not a client crash.

## AI calling — Telnyx + ElevenLabs (Phase 2)

1. In **ElevenLabs**, clone or pick a voice; create an API key.
2. In **Telnyx Mission Control**, create a Voice AI Assistant; set TTS to
   ElevenLabs and store the API key as an integration secret (`api_key_ref`).
3. On the production API deployment: set `TELNYX_API_KEY`
   and `TELNYX_TEXML_APP_ID` (AI Assistants dial through Telnyx TeXML; both
   are already set when `VOICE_PROVIDER=telnyx`). Optional: `DEEPGRAM_PROJECT_ID`
   (auto-discovered from the Deepgram key if unset).
4. In Clozr → Settings → Talkr → **Calling** → **AI calling**: enable, paste
   Assistant id, optional voice id / consent intro / human takeover E.164.
5. Dialer → enter a number → **AI call**.

Outbound AI dials reuse Talkr suppression (DNC), contact DNC status, and
caller-ID selection. Calls are logged on `calls` with `raw.ai_agent: true`.
Human takeover uses `takeover_e164` (assistant transfer tool) or the softphone.

## Deploy smoke (no auth)

Unauthenticated probes should be **401**, never **404**:

- `POST /v1/transcription/token`
- `POST /v1/calls/:id/intel`
- `GET /v1/ai-calls/config`
- `POST /v1/ai-calls`
