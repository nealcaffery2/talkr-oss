// Transcribe a recording stored in Supabase Storage (or by URL) and write the
// `transcripts` row. Returns the transcript so the caller can chain extraction.

import { admin } from "../lib/supabase.js";
import { transcribeBatch, transcribeMultichannel, type BatchTranscriptResult } from "../lib/deepgram.js";
import type { Database } from "../lib/database.types.js";

type TranscriptInsert = Database["public"]["Tables"]["transcripts"]["Insert"];

export async function transcribeCall(opts: {
  callId: string;
  source: { url: string } | { buffer: Buffer; mimetype: string };
  multichannel?: boolean;       // true if the audio is 2-ch tab+mic
}): Promise<BatchTranscriptResult> {
  const result = opts.multichannel
    ? await transcribeMultichannel({ source: opts.source })
    : await transcribeBatch({ source: opts.source });

  const row: TranscriptInsert = {
    call_id: opts.callId,
    provider: "deepgram",
    model: result.model,
    diarization_version: result.diarizationVersion,
    segments: result.segments as any,
    full_text: result.fullText,
  };

  const { error } = await admin().from("transcripts").insert(row);
  if (error) throw new Error(`Supabase insert: ${error.message}`);

  console.log(
    `[transcribe] call=${opts.callId} duration=${result.durationSeconds}s segments=${result.segments.length}`
  );
  return result;
}
