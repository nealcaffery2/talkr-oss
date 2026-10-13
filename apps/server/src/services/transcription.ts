/**
 * Transcription + AI call notes (docs/transcription.md).
 *
 * Two vendor calls, both over the global fetch: each is a single endpoint,
 * and pulling an SDK into the serverless bundle for one POST apiece is not
 * worth the weight.
 *   1. Deepgram prerecorded (nova-3) turns recording audio into speaker turns.
 *   2. Claude turns those turns into the acquisitions summary a manager reads
 *      instead of the audio.
 * Both are pure functions of their inputs; the transcribe-recording job owns
 * the database side (worker/transcribe-handlers.ts).
 */

import { z } from 'zod';

export type Speaker = 'rep' | 'contact' | 'unknown';

export interface TranscriptSegment {
  /** Seconds from the start of the recording. */
  start: number;
  end: number;
  speaker: Speaker;
  text: string;
  /** Deepgram's 0–1 confidence for the utterance. */
  confidence: number;
}

export interface TranscriptionResult {
  model: string;
  language: string | null;
  durationSeconds: number | null;
  segments: TranscriptSegment[];
  /** "[m:ss] Rep: …" lines — what the summary model reads. */
  fullText: string;
}

// ---------------------------------------------------------------------------
// Deepgram
// ---------------------------------------------------------------------------

export const DEEPGRAM_URL = 'https://api.deepgram.com/v1/listen';

/** The subset of Deepgram's prerecorded response this pipeline reads. */
export interface DeepgramUtterance {
  start: number;
  end: number;
  confidence: number;
  channel: number;
  transcript: string;
  /** Present only when diarize=true. */
  speaker?: number;
}

interface DeepgramResponse {
  metadata?: { duration?: number };
  results?: {
    channels?: Array<{ detected_language?: string }>;
    utterances?: DeepgramUtterance[];
  };
}

export interface TranscribeOptions {
  apiKey: string;
  audio: Uint8Array;
  /** MIME type of `audio` (Twilio .mp3 → audio/mpeg). */
  contentType: string;
  /** Recording channel count; 2 = one party per channel, anything else = mixed mono. */
  channels: number | null;
  /** Who speaks first on a mono recording (see mapMonoSpeakers). */
  firstSpeaker: Exclude<Speaker, 'unknown'>;
  fetchImpl?: typeof fetch;
}

export async function transcribeAudio(opts: TranscribeOptions): Promise<TranscriptionResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const dual = opts.channels === 2;
  const params = new URLSearchParams({
    model: 'nova-3',
    smart_format: 'true',
    punctuate: 'true',
    utterances: 'true',
    language: 'en-US',
  });
  // Dual-channel: the carrier already separated the parties, which beats any
  // voice-based guess. Mono: ask Deepgram to tell the voices apart.
  if (dual) params.set('multichannel', 'true');
  else params.set('diarize', 'true');

  const res = await doFetch(`${DEEPGRAM_URL}?${params.toString()}`, {
    method: 'POST',
    headers: { authorization: `Token ${opts.apiKey}`, 'content-type': opts.contentType },
    body: opts.audio,
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Deepgram ${res.status}: ${detail || res.statusText}`);
  }
  const body = (await res.json()) as DeepgramResponse;
  const utterances = body.results?.utterances ?? [];
  const segments = dual
    ? mapDualChannelSpeakers(utterances)
    : mapMonoSpeakers(utterances, opts.firstSpeaker);
  segments.sort((a, b) => a.start - b.start);
  return {
    model: dual ? 'nova-3-multichannel' : 'nova-3',
    language: body.results?.channels?.[0]?.detected_language ?? 'en-US',
    durationSeconds: body.metadata?.duration != null ? Math.round(body.metadata.duration) : null,
    segments,
    fullText: renderTranscript(segments),
  };
}

/**
 * Dual-channel recordings: Twilio puts the leg that started the recording on
 * channel 0 — on our outbound <Dial>/<Conference> that is the rep's browser
 * leg — and the dialed party on channel 1. This is the one place that
 * assumption lives; flip it here if a provider orders channels the other way.
 */
export function mapDualChannelSpeakers(utterances: DeepgramUtterance[]): TranscriptSegment[] {
  return utterances.map((u) => ({
    start: u.start,
    end: u.end,
    speaker: u.channel === 0 ? 'rep' : 'contact',
    text: u.transcript,
    confidence: u.confidence,
  }));
}

/**
 * Mono recordings: diarization numbers voices in order of first appearance,
 * so the label is decided by who speaks first. On an outbound call that is
 * the owner picking up ("Hello?"); on an inbound call it is the rep
 * answering. The second voice is the other party; a third voice (a spouse,
 * a voicemail greeting) stays unknown rather than being guessed.
 */
export function mapMonoSpeakers(
  utterances: DeepgramUtterance[],
  firstSpeaker: Exclude<Speaker, 'unknown'>,
): TranscriptSegment[] {
  const ordered = [...utterances].sort((a, b) => a.start - b.start);
  const second: Speaker = firstSpeaker === 'rep' ? 'contact' : 'rep';
  const byIndex = new Map<number, Speaker>();
  for (const u of ordered) {
    if (u.speaker == null || byIndex.has(u.speaker)) continue;
    byIndex.set(u.speaker, byIndex.size === 0 ? firstSpeaker : byIndex.size === 1 ? second : 'unknown');
  }
  return ordered.map((u) => ({
    start: u.start,
    end: u.end,
    speaker: u.speaker == null ? 'unknown' : (byIndex.get(u.speaker) ?? 'unknown'),
    text: u.transcript,
    confidence: u.confidence,
  }));
}

const SPEAKER_LABEL: Record<Speaker, string> = { rep: 'Rep', contact: 'Owner', unknown: 'Unknown' };

export function renderTranscript(segments: TranscriptSegment[]): string {
  return segments.map((s) => `[${fmtTime(s.start)}] ${SPEAKER_LABEL[s.speaker]}: ${s.text}`).join('\n');
}

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/**
 * Share of speaking time that was the rep's, 0–1. Null when nobody spoke, and
 * null when only one voice was ever identified — see below. Computed here
 * rather than asked of the model because it is arithmetic, and acquisitions
 * coaching wants the number, not an impression of it.
 */
export function repTalkRatio(segments: TranscriptSegment[]): number | null {
  let rep = 0;
  let total = 0;
  const heard = new Set<TranscriptSegment['speaker']>();
  for (const s of segments) {
    if (s.speaker === 'unknown') continue;
    heard.add(s.speaker);
    const d = Math.max(0, s.end - s.start);
    total += d;
    if (s.speaker === 'rep') rep += d;
  }
  if (total <= 0) return null;
  /**
   * One voice in the whole call means the speakers were never told apart, not
   * that one of them never spoke. On a mono conference mix that is Deepgram's
   * diarization giving up — short call, phone-band audio — and every utterance
   * then lands on whichever label the first speaker got.
   *
   * Reporting that as 0% was the worst of both: the card showed a confident
   * "Talk ratio 0", and the coaching prompt was handed "rep spoke 0% of the
   * talking time (measured, not estimated)" and graded the rep for saying
   * nothing on a call they ran. Unknown is the honest answer, and both the
   * card and the prompt already handle null by leaving it out.
   */
  if (heard.size < 2) return null;
  return Math.round((rep / total) * 100) / 100;
}

// ---------------------------------------------------------------------------
// Claude call notes
// ---------------------------------------------------------------------------

export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';

export const callNotesSchema = z.object({
  summary: z.string(),
  key_points: z.array(z.string()),
  seller_motivation: z.string().nullable(),
  timeline: z.string().nullable(),
  asking_price: z.string().nullable(),
  property_condition: z.string().nullable(),
  objections: z.array(z.string()),
  next_step: z.string().nullable(),
  sentiment: z.enum(['positive', 'neutral', 'negative', 'mixed']),
});
export type CallNotes = z.infer<typeof callNotesSchema>;

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;

/** Handed to structured outputs (`output_config.format`); must mirror callNotesSchema. */
const CALL_NOTES_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '2-4 plain past-tense sentences: what the call was and how it ended.' },
    key_points: { type: 'array', items: { type: 'string' }, description: 'Up to 6 short facts a manager needs.' },
    seller_motivation: { ...nullableString, description: "Why the owner is considering selling, in their words. Null if not discussed." },
    timeline: { ...nullableString, description: 'When they want or need to sell or close. Null if not discussed.' },
    asking_price: { ...nullableString, description: 'Any number the owner named or reacted to, with context. Null if none.' },
    property_condition: { ...nullableString, description: 'Repairs, occupancy, tenants, notable issues. Null if not discussed.' },
    objections: { type: 'array', items: { type: 'string' }, description: "The owner's stated hesitations or pushback." },
    next_step: { ...nullableString, description: 'The concrete agreed follow-up: who does what, by when. Null if nothing was agreed.' },
    sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative', 'mixed'], description: "The owner's attitude toward selling to the rep's company by the end of the call." },
  },
  required: [
    'summary', 'key_points', 'seller_motivation', 'timeline', 'asking_price',
    'property_condition', 'objections', 'next_step', 'sentiment',
  ],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You write post-call notes for a real-estate acquisitions company that buys houses directly from owners. You are given the transcript of a phone call between an acquisitions rep (labelled "Rep") and a property owner or their representative (labelled "Owner"). The speaker labels come from an automatic guess and can be swapped; use what is said to tell who is who.

Write for the acquisitions manager who will not listen to the audio. Report only what was actually said. Never infer a price, a timeline or a motivation the owner did not state. When the call did not cover a field, return null (or an empty list). Keep amounts and dates the way they were spoken ("around 185", "after the holidays"). If the call reached voicemail or nobody engaged, say so in the summary and leave the other fields empty.`;

export interface SummarizeOptions {
  apiKey: string;
  model: string;
  transcriptText: string;
  context: {
    direction: 'outbound' | 'inbound';
    durationSeconds: number | null;
    contactName: string | null;
  };
  fetchImpl?: typeof fetch;
}

export interface SummarizeResult extends CallNotes {
  /** The model id the API reports back — what actually ran. */
  model: string;
  usage: { input_tokens: number; output_tokens: number } | null;
}

interface AnthropicMessageResponse {
  model: string;
  stop_reason: string | null;
  content: Array<{ type: string; text?: string }>;
  usage?: { input_tokens: number; output_tokens: number };
}

export async function summarizeTranscript(opts: SummarizeOptions): Promise<SummarizeResult> {
  const doFetch = opts.fetchImpl ?? fetch;
  const { direction, durationSeconds, contactName } = opts.context;
  const header = [
    `Call: ${direction}`,
    contactName ? `with ${contactName}` : null,
    durationSeconds != null ? `${Math.max(1, Math.round(durationSeconds / 60))} min` : null,
  ]
    .filter(Boolean)
    .join(', ');

  const body = {
    model: opts.model,
    max_tokens: 16000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: `${header}.\n\nTranscript:\n${opts.transcriptText}` }],
    output_config: {
      // Extraction from one transcript is routine work: low effort keeps the
      // adaptive-thinking spend near zero. Haiku 4.5 rejects the field.
      ...(supportsEffort(opts.model) ? { effort: 'low' } : {}),
      format: { type: 'json_schema', schema: CALL_NOTES_JSON_SCHEMA },
    },
  };

  const res = await doFetch(ANTHROPIC_URL, {
    method: 'POST',
    headers: {
      'x-api-key': opts.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    throw new Error(`Anthropic ${res.status}: ${detail || res.statusText}`);
  }
  const msg = (await res.json()) as AnthropicMessageResponse;
  if (msg.stop_reason === 'refusal') throw new Error('Anthropic declined to summarize this call');
  if (msg.stop_reason === 'max_tokens') throw new Error('Anthropic summary was cut off (max_tokens)');
  const text = msg.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new Error('Anthropic returned no text block');

  const parsed = callNotesSchema.safeParse(JSON.parse(text));
  if (!parsed.success) {
    const fields = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Anthropic summary did not match the schema: ${fields}`);
  }
  return { ...parsed.data, model: msg.model, usage: msg.usage ?? null };
}

/** `output_config.effort` exists on Sonnet 5, Sonnet 4.6, Opus 4.5+ and Fable; Haiku 4.5 and Sonnet 4.5 reject it. */
export function supportsEffort(model: string): boolean {
  return !/haiku|sonnet-4-5/.test(model);
}
