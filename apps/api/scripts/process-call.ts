// Local CLI: process a single call recording end-to-end through the offline pipeline.
//
// Usage:
//   tsx scripts/process-call.ts \
//     --file ../recordings/some-call.mp3 \
//     --outcome contract \
//     --agent "Alex" \
//     --phone "+1-555-555-5555" \
//     --deal-value 42000     # optional, in dollars
//     --multichannel         # optional flag if the file has 2 channels (tab+mic)
//
// What it does:
// 1. Uploads the audio to Supabase Storage.
// 2. Inserts a `calls` row.
// 3. Inserts the matching `outcomes` row.
// 4. Transcribes via Deepgram.
// 5. Extracts patterns via Opus 4.6 + embeds with Voyage-3.
// 6. Reviews the call (rep score + seller bucket + linguistic observations).
//
// Use this on your existing 32 closed-deal recordings to bootstrap the
// knowledge base before smrtPhone webhook integration is wired up.

import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { admin } from "../lib/supabase.js";
import { transcribeCall } from "../workers/transcribe.js";
import { extractPatterns } from "../workers/extract-patterns.js";
import { reviewCall } from "../workers/review-call.js";
import { segmentTrainingTranscript } from "../workers/segment-training.js";
import type { Database } from "../lib/database.types.js";

type OutcomeStatus = Database["public"]["Enums"]["outcome_status"];

interface Args {
  file?: string;
  outcome: OutcomeStatus;
  agent: string;
  phone?: string;
  dealValueCents?: number;
  multichannel?: boolean;
  smrtphoneCallId?: string;
  resumeCallId?: string;        // skip upload + transcribe, run extract+review only
  training?: boolean;           // YouTube/training source: run segmentation pass before extract
  source?: string;              // "youtube-channel" | "manual" etc.
}

function parseArgs(argv: string[]): Args {
  const args: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) {
      args[key] = true;
    } else {
      args[key] = next;
      i++;
    }
  }
  const resume = typeof args["resume-call-id"] === "string" ? (args["resume-call-id"] as string) : undefined;
  if (!resume && typeof args.file !== "string") throw new Error("--file is required (or --resume-call-id)");
  if (typeof args.outcome !== "string") throw new Error("--outcome is required");
  if (typeof args.agent !== "string") throw new Error("--agent is required");
  if (!resume && typeof args.phone !== "string") throw new Error("--phone is required");

  const dealValue = typeof args["deal-value"] === "string" ? Number(args["deal-value"]) : undefined;

  return {
    file: typeof args.file === "string" ? args.file : undefined,
    outcome: args.outcome as OutcomeStatus,
    agent: args.agent as string,
    phone: typeof args.phone === "string" ? args.phone : undefined,
    dealValueCents: dealValue ? Math.round(dealValue * 100) : undefined,
    multichannel: !!args.multichannel,
    smrtphoneCallId: typeof args["smrtphone-id"] === "string" ? (args["smrtphone-id"] as string) : undefined,
    resumeCallId: resume,
    training: !!args.training,
    source: typeof args.source === "string" ? (args.source as string) : undefined,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();

  // RESUME path: skip upload + transcribe, fetch existing transcript, run extract+review.
  if (args.resumeCallId) {
    console.log(`[process-call] RESUME call_id=${args.resumeCallId}`);
    const { data: txn, error: txnErr } = await admin()
      .from("transcripts")
      .select("full_text, segments")
      .eq("call_id", args.resumeCallId)
      .single();
    if (txnErr || !txn) throw new Error(`No transcript for call ${args.resumeCallId}: ${txnErr?.message}`);
    const { data: callRow } = await admin()
      .from("calls")
      .select("duration_seconds")
      .eq("id", args.resumeCallId)
      .single();
    const durationSeconds = callRow?.duration_seconds ?? 0;

    const { patterns } = await extractPatterns({
      callId: args.resumeCallId,
      transcript: txn.full_text,
      outcome: args.outcome,
      durationSeconds,
      dealValueCents: args.dealValueCents,
    });
    const review = await reviewCall({
      callId: args.resumeCallId,
      agentName: args.agent,
      transcript: txn.full_text,
      outcome: args.outcome,
      durationSeconds,
      dealValueCents: args.dealValueCents,
      patternsJson: patterns,
    });

    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`\n[process-call] RESUME done in ${elapsed}s`);
    console.log(`  call_id:        ${args.resumeCallId}`);
    console.log(`  patterns:       ${patterns.length}`);
    console.log(`  rep score:      ${review.rep_overall_score}`);
    console.log(`  bucket:         ${review.seller_bucket} (conf ${review.bucket_confidence})`);
    console.log(`  motivation:     ${review.motivation_score}`);
    console.log(`  price align:    ${review.price_alignment_score}`);
    console.log(`  next action:    ${review.recommended_next_action}`);
    return;
  }

  console.log(`[process-call] file=${args.file} outcome=${args.outcome}`);

  // 1. Upload to Storage (skip for training videos: they're often huge
  // multi-call compilations, and we don't need the audio after processing)
  const fileBuffer = await readFile(args.file!);
  const fname = basename(args.file!);
  const fileSizeMB = fileBuffer.length / 1024 / 1024;
  const mimetype = fname.endsWith(".mp3") ? "audio/mpeg" :
    fname.endsWith(".wav") ? "audio/wav" :
    fname.endsWith(".m4a") ? "audio/mp4" : "application/octet-stream";

  let storagePath: string | null = null;
  if (args.training) {
    console.log(`[process-call] training mode: skipping storage upload (${fileSizeMB.toFixed(1)}MB)`);
  } else if (fileSizeMB > 45) {
    console.log(`[process-call] file is ${fileSizeMB.toFixed(1)}MB; skipping upload (Supabase Storage 50MB cap)`);
  } else {
    storagePath = `manual/${Date.now()}_${fname}`;
    const { error: uploadErr } = await admin().storage
      .from("recordings")
      .upload(storagePath, fileBuffer, { contentType: mimetype, upsert: false });
    if (uploadErr && uploadErr.message?.includes("Bucket not found")) {
      console.log("[process-call] creating recordings bucket");
      await admin().storage.createBucket("recordings", { public: false });
      const { error: retryErr } = await admin().storage
        .from("recordings")
        .upload(storagePath, fileBuffer, { contentType: mimetype, upsert: false });
      if (retryErr) throw new Error(`storage upload: ${retryErr.message}`);
    } else if (uploadErr) {
      throw new Error(`storage upload: ${uploadErr.message}`);
    }
    console.log(`[process-call] uploaded ${fileSizeMB.toFixed(2)}MB to ${storagePath}`);
  }

  // 2. Insert calls row
  const smrtphoneCallId = args.smrtphoneCallId ?? `manual_${Date.now()}_${fname}`;
  const { data: callRow, error: callErr } = await admin()
    .from("calls")
    .insert({
      smrtphone_call_id: smrtphoneCallId,
      contact_phone: args.phone!,
      direction: "outbound",
      started_at: new Date().toISOString(),
      recording_storage_path: storagePath,
      raw_metadata: {
        source: args.source ?? (args.training ? "training" : "manual_cli"),
        agent_name: args.agent,
        ...(args.training ? { training: true } : {}),
      },
    })
    .select()
    .single();
  if (callErr) throw new Error(`insert calls: ${callErr.message}`);
  const callId = callRow.id;
  console.log(`[process-call] call_id=${callId}`);

  // 3. Insert outcomes row
  const { error: outErr } = await admin().from("outcomes").insert({
    call_id: callId,
    source: "manual",
    status: args.outcome,
    deal_value_cents: args.dealValueCents ?? null,
  });
  if (outErr) throw new Error(`insert outcomes: ${outErr.message}`);

  // 4. Transcribe
  const transcript = await transcribeCall({
    callId,
    source: { buffer: fileBuffer, mimetype },
    multichannel: args.multichannel,
  });

  // Cost guard: skip extract + review for ultra-short or voicemail-style calls.
  // Default minimum: 60 seconds of conversation. Override with --min-duration 0.
  const MIN_DURATION = 60;
  if (transcript.durationSeconds < MIN_DURATION) {
    console.log(
      `[process-call] SKIP extract + review: duration ${Math.round(transcript.durationSeconds)}s ` +
      `< ${MIN_DURATION}s (likely voicemail / ringer / hangup). ` +
      `Re-run with --resume-call-id ${callId} if you want to process anyway.`
    );
    await admin().from("calls").update({
      duration_seconds: Math.round(transcript.durationSeconds),
    }).eq("id", callId);
    return;
  }

  // 4b. Training-mode segmentation: trim host commentary out of YouTube imports.
  let extractTranscript = transcript.fullText;
  let extractDuration = transcript.durationSeconds;
  if (args.training) {
    const seg = await segmentTrainingTranscript({
      segments: transcript.segments,
      fullText: transcript.fullText,
      durationSeconds: transcript.durationSeconds,
    });
    extractTranscript = seg.trimmedFullText;
    extractDuration = seg.callDurationSeconds;
    if (extractDuration < MIN_DURATION) {
      console.log(`[process-call] SKIP: segmentation found only ${Math.round(extractDuration)}s of call content`);
      return;
    }
    // Persist segmentation result to raw_metadata for traceability.
    await admin().from("calls").update({
      raw_metadata: {
        source: args.source ?? "training",
        agent_name: args.agent,
        training: true,
        segmentation: {
          original_duration_s: Math.round(transcript.durationSeconds),
          call_duration_s: Math.round(extractDuration),
          ranges: seg.result.call_ranges,
        },
      } as any,
    }).eq("id", callId);
  }

  // 5. Extract patterns
  const { patterns } = await extractPatterns({
    callId,
    transcript: extractTranscript,
    outcome: args.outcome,
    durationSeconds: extractDuration,
    dealValueCents: args.dealValueCents,
  });

  // 6. Review call
  const review = await reviewCall({
    callId,
    agentName: args.agent,
    transcript: extractTranscript,
    outcome: args.outcome,
    durationSeconds: extractDuration,
    dealValueCents: args.dealValueCents,
    patternsJson: patterns,
  });

  // Update call with duration
  await admin()
    .from("calls")
    .update({
      duration_seconds: Math.round(transcript.durationSeconds),
      ended_at: new Date(Date.now()).toISOString(),
    })
    .eq("id", callId);

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[process-call] done in ${elapsed}s`);
  console.log(`  call_id:        ${callId}`);
  console.log(`  duration:       ${Math.round(transcript.durationSeconds)}s`);
  console.log(`  segments:       ${transcript.segments.length}`);
  console.log(`  patterns:       ${patterns.length}`);
  console.log(`  rep score:      ${review.rep_overall_score}`);
  console.log(`  bucket:         ${review.seller_bucket} (conf ${review.bucket_confidence})`);
  console.log(`  motivation:     ${review.motivation_score}`);
  console.log(`  price align:    ${review.price_alignment_score}`);
  console.log(`  next action:    ${review.recommended_next_action}`);
}

main().catch((err) => {
  console.error("[process-call] FAILED:", err);
  process.exit(1);
});
