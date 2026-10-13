// Segment a training-video transcript into "actual cold call" ranges and
// "host commentary" ranges. Used when ingesting public training videos, where
// the video splices host narration around real call audio.
//
// Returns a TRIMMED transcript that contains only the call portions, ready to
// hand to extract-patterns and review-call.

import { generateJson, MODELS } from "../lib/anthropic.js";
import { loadPromptCached } from "../lib/prompts.js";
import type { TranscriptSegment } from "../lib/deepgram.js";

interface SegmentationResult {
  call_ranges: { start_seconds: number; end_seconds: number; confidence: number; reason: string }[];
  rejected_segments: { start_seconds: number; end_seconds: number; reason: string }[];
}

export async function segmentTrainingTranscript(opts: {
  segments: TranscriptSegment[];
  fullText: string;
  durationSeconds: number;
}): Promise<{
  trimmedSegments: TranscriptSegment[];
  trimmedFullText: string;
  callDurationSeconds: number;
  result: SegmentationResult;
}> {
  const systemPrompt = await loadPromptCached("segment_training.system.md");

  const userPrompt =
    `Total duration: ${Math.round(opts.durationSeconds)}s\n\n=== TRANSCRIPT ===\n${opts.fullText}`;

  const { data: result } = await generateJson<SegmentationResult>({
    model: MODELS.sonnet,           // segmentation needs reasoning, but not Opus-level
    systemPrompt,
    userPrompt,
    maxTokens: 8000,                 // long videos can have many call ranges + reject ranges
  });

  if (!Array.isArray(result.call_ranges)) {
    throw new Error(`segmenter returned malformed result: ${JSON.stringify(result).slice(0, 200)}`);
  }

  const trimmedSegments = opts.segments.filter((s) =>
    result.call_ranges.some((r) => s.start >= r.start_seconds && s.end <= r.end_seconds + 1)
  );

  const callDurationSeconds = result.call_ranges.reduce(
    (sum, r) => sum + (r.end_seconds - r.start_seconds),
    0
  );

  const trimmedFullText = trimmedSegments
    .map((s) => `[${fmtTime(s.start)}] ${s.speaker}: ${s.text}`)
    .join("\n");

  console.log(
    `[segment-training] kept ${trimmedSegments.length}/${opts.segments.length} segments`,
    `(${Math.round(callDurationSeconds)}s of ${Math.round(opts.durationSeconds)}s = `,
    `${Math.round((callDurationSeconds / opts.durationSeconds) * 100)}% call content)`
  );
  for (const r of result.call_ranges) {
    console.log(
      `  call: ${fmtTime(r.start_seconds)}-${fmtTime(r.end_seconds)} (conf ${r.confidence}) - ${r.reason}`
    );
  }
  for (const r of result.rejected_segments.slice(0, 3)) {
    console.log(`  reject: ${fmtTime(r.start_seconds)}-${fmtTime(r.end_seconds)} - ${r.reason}`);
  }

  return { trimmedSegments, trimmedFullText, callDurationSeconds, result };
}

function fmtTime(s: number): string {
  const m = Math.floor(s / 60).toString().padStart(2, "0");
  const sec = Math.floor(s % 60).toString().padStart(2, "0");
  return `${m}:${sec}`;
}
