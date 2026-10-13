import Anthropic from "@anthropic-ai/sdk";
import { env } from "./env.js";

let _client: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (_client) return _client;
  _client = new Anthropic({ apiKey: env.anthropicApiKey });
  return _client;
}

export const MODELS = {
  opus: "claude-opus-4-7" as const,           // premium: highest quality, ~25x cost of Haiku
  sonnet: "claude-sonnet-4-6" as const,       // standard: 5x cheaper than Opus, near-Opus quality
  haiku: "claude-haiku-4-5-20251001" as const // fast: live suggestion + bulk pattern extraction
};

// Cost-conscious defaults. Override per-call by passing { model: MODELS.opus }.
// Per 30-min call (12k input / 3k output tokens):
//   Opus:   ~$0.40 extract + $0.45 review = $0.85
//   Sonnet: ~$0.05 extract + $0.06 review = $0.11
//   Haiku:  ~$0.015 extract + $0.020 review = $0.035
export const TIER = {
  // Pattern extraction: Haiku is sufficient for "find utterances and pair with responses".
  // Override to Opus when bootstrapping the knowledge base from your top 20 closed deals.
  extract: (process.env.MODEL_TIER_EXTRACT as keyof typeof MODELS) || "haiku",
  // Call review: Sonnet for the linguistic nuance + bucket placement. Opus for contracts only.
  review: (process.env.MODEL_TIER_REVIEW as keyof typeof MODELS) || "sonnet",
} as const;

export function modelFor(task: keyof typeof TIER): string {
  const tier = TIER[task];
  return MODELS[tier as keyof typeof MODELS] ?? MODELS.haiku;
}

// Wrap a system prompt with a cache breakpoint. Use for the static portion of
// any prompt that gets reused in subsequent calls (system instructions, playbook).
export function cached(text: string) {
  return [
    { type: "text" as const, text, cache_control: { type: "ephemeral" as const } }
  ];
}

// Call Opus / Sonnet for a JSON-mode response. Strips any accidental markdown
// fence and returns the parsed JSON.
// Always streams (avoids the SDK's 10-minute non-streaming timeout when
// generating large outputs on long transcripts).
export async function generateJson<T = unknown>(opts: {
  model: string;
  systemPrompt: string;       // cached
  userPrompt: string;         // not cached
  maxTokens?: number;
  temperature?: number;
}): Promise<{ data: T; usage: Anthropic.Messages.Usage }> {
  const params: Anthropic.Messages.MessageCreateParamsStreaming = {
    model: opts.model,
    max_tokens: opts.maxTokens ?? 8192,
    system: cached(opts.systemPrompt),
    messages: [{ role: "user", content: opts.userPrompt }],
    stream: true,
  };
  if (opts.temperature !== undefined) params.temperature = opts.temperature;

  const stream = anthropic().messages.stream(params);
  const res = await stream.finalMessage();

  const block = res.content[0];
  if (!block || block.type !== "text") {
    throw new Error(`Unexpected response from ${opts.model}: ${JSON.stringify(res.content)}`);
  }
  const raw = block.text.trim().replace(/^```json\s*/i, "").replace(/```\s*$/i, "");
  let data: T;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    throw new Error(`Model ${opts.model} returned non-JSON: ${raw.slice(0, 500)}`);
  }
  return { data, usage: res.usage };
}
