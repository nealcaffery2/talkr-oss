/**
 * Org-level settings that live in the `organizations.settings` jsonb column.
 *
 * That column is already a grab-bag of per-org configuration (timezone,
 * business hours, the SMS send window, the dialer abandon message), so a new
 * setting is a new key rather than a new table — no migration, and one read
 * on the paths that need it.
 *
 * Everything here is pure (docs/architecture.md §4): validation happens at
 * *write* time, and the readers below never throw. A settings blob written by
 * an older build, hand-edited in psql, or corrupted must degrade to the
 * platform default rather than break a live call.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Hold music
// ---------------------------------------------------------------------------

export const HOLD_MUSIC_MODES = ['default', 'silence', 'url'] as const;

/**
 * `default` leaves the provider's own hold music (Twilio's classical loop).
 * `silence` plays nothing at all. `url` plays the org's own audio.
 */
export type HoldMusicMode = (typeof HOLD_MUSIC_MODES)[number];

/** Long enough for a signed CDN link, short enough to keep out of trouble. */
export const HOLD_MUSIC_URL_MAX = 500;

export interface HoldMusicSetting {
  mode: HoldMusicMode;
  /** Only meaningful — and only stored — when `mode` is `'url'`. */
  url?: string;
}

export const HOLD_MUSIC_DEFAULT: HoldMusicSetting = { mode: 'default' };

/**
 * Hosts the provider can never fetch from. The URL is dereferenced by the
 * carrier out on the public internet, not by us, so a loopback or private
 * address is not "maybe reachable" — it is guaranteed dead air on a live
 * call. Rejecting it at write time turns a silent call into a form error.
 */
function isUnreachableHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true;
  if (host === '::1' || host === '0.0.0.0') return true;
  // A bare host with no dot cannot resolve in public DNS.
  if (!host.includes('.') && !host.includes(':')) return true;
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!v4) return false;
  const [a, b] = [Number(v4[1]), Number(v4[2])];
  if (a === 127 || a === 10 || a === 0) return true;
  if (a === 169 && b === 254) return true; // link-local, incl. cloud metadata
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

/**
 * Is this something a carrier could actually play? `http(s)` only, an absolute
 * URL, a publicly resolvable host, no embedded credentials (they would end up
 * in the provider's request logs), and bounded length.
 *
 * This is deliberately a *shape* check, not a fetch: validating by request
 * would make saving a setting depend on a third party being up, and would
 * still say nothing about whether the URL works when the call happens.
 */
export function isPlayableHoldMusicUrl(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > HOLD_MUSIC_URL_MAX) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  if (!parsed.hostname) return false;
  if (parsed.username || parsed.password) return false;
  return !isUnreachableHost(parsed.hostname);
}

/**
 * The stored shape. `url` is dropped unless the mode actually uses it, so
 * switching to Silence cannot leave a stale URL behind to be resurrected by a
 * later edit that only changes the mode.
 */
export const holdMusicSettingSchema: z.ZodType<HoldMusicSetting, z.ZodTypeDef, unknown> = z
  .object({
    mode: z.enum(HOLD_MUSIC_MODES),
    url: z.string().max(HOLD_MUSIC_URL_MAX).nullish(),
  })
  .superRefine((value, ctx) => {
    if (value.mode !== 'url') return;
    if (!value.url || value.url.trim().length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: 'a url is required when hold music mode is "url"',
      });
      return;
    }
    if (!isPlayableHoldMusicUrl(value.url)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['url'],
        message: `must be a public http(s) url of at most ${HOLD_MUSIC_URL_MAX} characters`,
      });
    }
  })
  .transform((value): HoldMusicSetting =>
    value.mode === 'url' ? { mode: 'url', url: value.url!.trim() } : { mode: value.mode },
  );

// ---------------------------------------------------------------------------
// AI agent (Telnyx Voice AI + optional ElevenLabs voice id for docs/UI)
// ---------------------------------------------------------------------------

export interface AiAgentSetting {
  /** When false, POST /v1/ai-calls refuses. */
  enabled: boolean;
  /** Telnyx AI Assistant id (assistant-…). */
  assistant_id: string;
  /**
   * Optional ElevenLabs voice id shown in settings / logged on the call.
   * The Assistant itself must be configured in Telnyx Mission Control to use
   * ElevenLabs TTS (api_key_ref); this field is for CRM display and audits.
   */
  elevenlabs_voice_id?: string;
  /** Recording / disclosure line the AI should open with (also passed as dynamic variable). */
  consent_intro?: string;
  /** Prefer human takeover number (E.164) when the assistant transfers. */
  takeover_e164?: string;
}

export const AI_AGENT_DEFAULT: AiAgentSetting = {
  enabled: false,
  assistant_id: '',
};

export const aiAgentSettingSchema: z.ZodType<AiAgentSetting, z.ZodTypeDef, unknown> = z
  .object({
    enabled: z.boolean(),
    assistant_id: z.string().max(120),
    elevenlabs_voice_id: z.string().max(120).nullish(),
    consent_intro: z.string().max(500).nullish(),
    takeover_e164: z.string().max(32).nullish(),
  })
  .transform((v): AiAgentSetting => ({
    enabled: v.enabled,
    assistant_id: v.assistant_id.trim(),
    ...(v.elevenlabs_voice_id?.trim() ? { elevenlabs_voice_id: v.elevenlabs_voice_id.trim() } : {}),
    ...(v.consent_intro?.trim() ? { consent_intro: v.consent_intro.trim() } : {}),
    ...(v.takeover_e164?.trim() ? { takeover_e164: v.takeover_e164.trim() } : {}),
  }));

export function readAiAgent(settings: unknown): AiAgentSetting {
  if (typeof settings !== 'object' || settings === null) return AI_AGENT_DEFAULT;
  const raw = (settings as Record<string, unknown>).ai_agent;
  if (raw === undefined) return AI_AGENT_DEFAULT;
  const parsed = aiAgentSettingSchema.safeParse(raw);
  return parsed.success ? parsed.data : AI_AGENT_DEFAULT;
}

/** The org-settings keys this module owns. Everything else is passed through. */
export const orgSettingsPatchSchema = z
  .object({
    hold_music: holdMusicSettingSchema,
    ai_agent: aiAgentSettingSchema,
  })
  .partial()
  .strict();

export type OrgSettingsPatch = z.infer<typeof orgSettingsPatchSchema>;

/**
 * Read the hold-music setting out of a raw settings blob. Never throws and
 * never rejects a call: anything unrecognised is the platform default.
 */
export function readHoldMusic(settings: unknown): HoldMusicSetting {
  if (typeof settings !== 'object' || settings === null) return HOLD_MUSIC_DEFAULT;
  const raw = (settings as Record<string, unknown>).hold_music;
  if (raw === undefined) return HOLD_MUSIC_DEFAULT;
  const parsed = holdMusicSettingSchema.safeParse(raw);
  return parsed.success ? parsed.data : HOLD_MUSIC_DEFAULT;
}

/**
 * The `waitUrl` for `ConferenceDialParams`.
 *
 * `undefined` omits the attribute entirely, which leaves the provider's own
 * default hold music. An empty string is the documented "no wait music" value
 * — a participant alone in the room hears silence instead of the classical
 * loop. Anything else is the org's own audio or TwiML.
 */
export function holdMusicWaitUrl(setting: HoldMusicSetting): string | undefined {
  switch (setting.mode) {
    case 'silence':
      return '';
    case 'url':
      return setting.url;
    default:
      return undefined;
  }
}
