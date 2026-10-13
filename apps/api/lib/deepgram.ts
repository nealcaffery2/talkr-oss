import { createClient, type DeepgramClient } from "@deepgram/sdk";
import { env } from "./env.js";

let _client: DeepgramClient | null = null;

export function deepgram(): DeepgramClient {
  if (_client) return _client;
  _client = createClient(env.deepgramApiKey);
  return _client;
}

export interface TranscriptSegment {
  start: number;          // seconds
  end: number;
  speaker: string;        // 'agent' | 'seller' (mapped from diarization)
  text: string;
  confidence: number;
}

export interface BatchTranscriptResult {
  model: string;
  diarizationVersion: string | null;
  segments: TranscriptSegment[];
  fullText: string;
  durationSeconds: number;
}

// Transcribe a recording (URL or local buffer) with Nova-3 + diarization.
// agentSpeaker: which Deepgram speaker label maps to "agent". For dual-channel
// recordings, channel 1 is the agent (mic) and channel 0 is the seller (tab),
// so we map by channel index instead. See `multichannel` in transcribeMulti.
export async function transcribeBatch(opts: {
  source: { url: string } | { buffer: Buffer; mimetype: string };
  agentSpeakerHint?: number;   // diarized speaker index that's most likely the agent
}): Promise<BatchTranscriptResult> {
  const dg = deepgram();
  const params = {
    model: "nova-3",
    smart_format: true,
    diarize: true,
    punctuate: true,
    utterances: true,
    paragraphs: false,
    detect_language: false,
    language: "en-US" as const,
  };

  let res;
  if ("url" in opts.source) {
    res = await dg.listen.prerecorded.transcribeUrl({ url: opts.source.url }, params);
  } else {
    res = await dg.listen.prerecorded.transcribeFile(opts.source.buffer, {
      ...params,
      mimetype: opts.source.mimetype,
    });
  }

  if (res.error) throw new Error(`Deepgram: ${res.error.message || res.error}`);
  const result = res.result;
  if (!result) throw new Error("Deepgram returned no result");

  const channel = result.results.channels[0];
  if (!channel) throw new Error("Deepgram returned no channels");

  const utterances = result.results.utterances ?? [];
  const segments: TranscriptSegment[] = utterances.map((u) => ({
    start: u.start,
    end: u.end,
    speaker: mapSpeaker(u.speaker, opts.agentSpeakerHint),
    text: u.transcript,
    confidence: u.confidence,
  }));

  const fullText = segments.map((s) => `[${fmtTime(s.start)}] ${s.speaker}: ${s.text}`).join("\n");

  return {
    model: "nova-3",
    diarizationVersion: result.metadata?.model_info?.[result.metadata.models?.[0] ?? ""]?.version ?? null,
    segments,
    fullText,
    durationSeconds: result.metadata?.duration ?? 0,
  };
}

// Multichannel: tab=channel 0 (seller), mic=channel 1 (agent). Cleaner than
// diarization when the live extension feeds us two channels.
export async function transcribeMultichannel(opts: {
  source: { url: string } | { buffer: Buffer; mimetype: string };
}): Promise<BatchTranscriptResult> {
  const dg = deepgram();
  const params = {
    model: "nova-3",
    smart_format: true,
    multichannel: true,
    channels: 2,
    punctuate: true,
    utterances: true,
    language: "en-US" as const,
  };

  let res;
  if ("url" in opts.source) {
    res = await dg.listen.prerecorded.transcribeUrl({ url: opts.source.url }, params);
  } else {
    res = await dg.listen.prerecorded.transcribeFile(opts.source.buffer, {
      ...params,
      mimetype: opts.source.mimetype,
    });
  }

  if (res.error) throw new Error(`Deepgram: ${res.error.message || res.error}`);
  const result = res.result;
  if (!result) throw new Error("Deepgram returned no result");

  const utterances = result.results.utterances ?? [];
  const segments: TranscriptSegment[] = utterances
    .map((u: any) => ({
      start: u.start,
      end: u.end,
      speaker: u.channel === 0 ? "seller" : "agent",
      text: u.transcript,
      confidence: u.confidence,
    }))
    .sort((a, b) => a.start - b.start);

  const fullText = segments.map((s) => `[${fmtTime(s.start)}] ${s.speaker}: ${s.text}`).join("\n");

  return {
    model: "nova-3-multichannel",
    diarizationVersion: null,
    segments,
    fullText,
    durationSeconds: result.metadata?.duration ?? 0,
  };
}

function mapSpeaker(diarSpeaker: number | undefined, agentHint?: number): string {
  if (diarSpeaker === undefined) return "unknown";
  if (agentHint !== undefined) return diarSpeaker === agentHint ? "agent" : "seller";
  // Fallback: speaker 0 is the most-talking speaker, which in outbound calls
  // is usually the agent. Reviewer can correct downstream.
  return diarSpeaker === 0 ? "agent" : "seller";
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}
