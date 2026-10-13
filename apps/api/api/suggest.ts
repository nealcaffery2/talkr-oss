// POST /api/suggest
//
// The hot path. The Chrome extension fires this on every committed seller
// utterance during a live call. We:
//   1. Embed the utterance via Voyage-3
//   2. Detect call stage via the heuristic
//   3. Retrieve top-k winning + losing patterns + playbook chunks
//   4. Assemble user prompt + cached system prompt
//   5. Stream Haiku 4.5 response back as Server-Sent Events
//   6. After the stream completes, async-log to live_suggestions
//
// Latency budget for first visible token: 800ms total
// (we typically see 450-650ms in practice).

import Anthropic from "@anthropic-ai/sdk";
import { admin, pgVector } from "../lib/supabase.js";
import { embed } from "../lib/voyage.js";
import { detectStage } from "../lib/stage-detector.js";
import { anthropic, MODELS, cached } from "../lib/anthropic.js";
import { loadPromptCached, fill } from "../lib/prompts.js";
import type { Database } from "../lib/database.types.js";

export const config = { runtime: "nodejs" };  // Edge can't import 'node:fs' (prompts.ts)

type CallStage = Database["public"]["Enums"]["call_stage"];

interface SuggestRequest {
  session_id: string;
  utterance: string;            // current seller utterance
  last_4_turns?: { speaker: "agent" | "seller"; text: string }[];
  elapsed_seconds?: number;
  stage_hint?: CallStage;       // override the stage detector
  previous_stage?: CallStage;   // for monotonic stage detection
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!process.env.TALKR_API_KEY || token !== process.env.TALKR_API_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const t0 = Date.now();
  let body: SuggestRequest;
  try {
    body = (await req.json()) as SuggestRequest;
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }
  if (!body?.utterance || !body.session_id) {
    return new Response("Missing utterance or session_id", { status: 400 });
  }

  // Filter trivial utterances (filler/backchannel) before spending cycles.
  if (isFiller(body.utterance)) {
    return sse((controller) => {
      enqueue(controller, { type: "delta", text: "PASS" });
      enqueue(controller, { type: "done", reason: "filler" });
      controller.close();
    });
  }

  // 1. Stage detection (cheap, runs synchronously)
  const stage = body.stage_hint ?? detectStage({
    turns: body.last_4_turns ?? [],
    elapsedSeconds: body.elapsed_seconds ?? 0,
    previousStage: body.previous_stage,
  });

  // 2. Embed seller utterance + retrieve in parallel
  const tEmbedStart = Date.now();
  const vec = await embed(body.utterance);
  const queryEmbedding = pgVector(vec);
  const tEmbedMs = Date.now() - tEmbedStart;

  const tRetrieveStart = Date.now();
  const [patternsRes, playbookRes] = await Promise.all([
    admin().rpc("match_patterns", {
      query_embedding: queryEmbedding,
      match_stage: stage,
      winners_k: 3,
      losers_k: 2,
    }),
    admin().rpc("match_playbook", {
      query_embedding: queryEmbedding,
      match_stage: stage,
      k: 2,
    }),
  ]);
  const tRetrieveMs = Date.now() - tRetrieveStart;

  if (patternsRes.error) return new Response(`match_patterns: ${patternsRes.error.message}`, { status: 500 });
  if (playbookRes.error) return new Response(`match_playbook: ${playbookRes.error.message}`, { status: 500 });

  const winners = (patternsRes.data ?? []).filter((p) => p.outcome_label === "winning");
  const losers = (patternsRes.data ?? []).filter((p) => p.outcome_label === "losing");
  const playbookChunks = playbookRes.data ?? [];

  // 3. Assemble prompts
  const systemTemplate = await loadPromptCached("live_suggest.system.md");
  const userTemplate = await loadPromptCached("live_suggest.user.template.md");

  const playbookBlock = playbookChunks.length > 0
    ? playbookChunks.map((p) => `- ${p.section}: ${p.recommended_response}`).join("\n")
    : "(no playbook entries matched this stage)";

  const systemPrompt = fill(systemTemplate, { PLAYBOOK_CHUNKS: playbookBlock });

  const winnersBlock = winners.length > 0
    ? winners.map((p, i) => formatExample(i + 1, p)).join("\n\n")
    : "(no historical winners matched yet)";
  const losersBlock = losers.length > 0
    ? losers.map((p, i) => formatExample(i + 1, p)).join("\n\n")
    : "(no historical losers to avoid)";
  const turnsBlock = (body.last_4_turns ?? []).map((t) => `${t.speaker}: "${t.text}"`).join("\n");

  const userPrompt = fill(userTemplate, {
    WINNERS_BLOCK: winnersBlock,
    LOSERS_BLOCK: losersBlock,
    STAGE: stage,
    LAST_4_TURNS: turnsBlock || "(no prior turns captured)",
    SELLER_UTTERANCE: body.utterance,
  });

  // 4. Stream Haiku 4.5 response, accumulating for telemetry
  const tStreamStart = Date.now();
  let firstTokenAt: number | null = null;
  let suggestionText = "";
  let usage: Anthropic.Messages.Usage | null = null;

  return sse(async (controller) => {
    try {
      const stream = anthropic().messages.stream({
        model: MODELS.haiku,
        max_tokens: 200,                  // we want short suggestions
        system: cached(systemPrompt),
        messages: [{ role: "user", content: userPrompt }],
        stream: true,
      });

      stream.on("text", (delta) => {
        if (firstTokenAt === null) {
          firstTokenAt = Date.now();
          enqueue(controller, {
            type: "meta",
            stage,
            ttft_ms: firstTokenAt - t0,
            embed_ms: tEmbedMs,
            retrieve_ms: tRetrieveMs,
            winners_count: winners.length,
            losers_count: losers.length,
            playbook_count: playbookChunks.length,
          });
        }
        suggestionText += delta;
        enqueue(controller, { type: "delta", text: delta });
      });

      const final = await stream.finalMessage();
      usage = final.usage;
      const totalMs = Date.now() - t0;
      enqueue(controller, {
        type: "done",
        total_ms: totalMs,
        suggestion: suggestionText,
        retrieved_pattern_ids: [...winners.map((w) => w.id), ...losers.map((l) => l.id)],
      });
      controller.close();

      // Async telemetry write (don't block the response)
      if (firstTokenAt !== null) {
        admin().from("live_suggestions").insert({
          session_id: body.session_id,
          seller_utterance: body.utterance,
          retrieved_pattern_ids: [...winners.map((w) => w.id), ...losers.map((l) => l.id)],
          detected_stage: stage,
          prompt_tokens: usage.input_tokens,
          completion_tokens: usage.output_tokens,
          cached_input_tokens: usage.cache_read_input_tokens ?? 0,
          suggestion: suggestionText,
          model: MODELS.haiku,
          end_to_end_latency_ms: totalMs,
          ttft_ms: firstTokenAt - t0,
        }).then(({ error }) => {
          if (error) console.warn("[suggest] telemetry insert failed:", error.message);
        });
      }
    } catch (err) {
      enqueue(controller, { type: "error", message: String(err instanceof Error ? err.message : err) });
      controller.close();
    }
  });
}

const FILLER_RE = /^\s*(uh\s*huh|ok(ay)?|yeah|yep|right|hmm|mhm|mm|got it|alright|sure)\s*[.!?]*\s*$/i;

function isFiller(text: string): boolean {
  return FILLER_RE.test(text);
}

function formatExample(i: number, p: any): string {
  return `${i}. Stage: ${p.stage} | ${p.outcome_label}\n   Seller: "${p.seller_utterance_paraphrase}"\n   Agent: "${p.agent_response ?? "(no response captured)"}"`;
}

function sse(builder: (controller: ReadableStreamDefaultController<Uint8Array>) => void | Promise<void>): Response {
  const stream = new ReadableStream({
    async start(controller) {
      await builder(controller);
    },
  });
  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "connection": "keep-alive",
      "x-accel-buffering": "no",
    },
  });
}

const enc = new TextEncoder();
function enqueue(controller: ReadableStreamDefaultController<Uint8Array>, event: any) {
  controller.enqueue(enc.encode(`data: ${JSON.stringify(event)}\n\n`));
}
