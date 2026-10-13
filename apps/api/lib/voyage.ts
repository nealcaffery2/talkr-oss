import { env } from "./env.js";

const VOYAGE_API = "https://api.voyageai.com/v1/embeddings";
const MODEL = "voyage-3";  // 1024 dim, matches the pgvector(1024) columns

interface VoyageResponse {
  data: { embedding: number[]; index: number }[];
  model: string;
  usage: { total_tokens: number };
}

// Embed a single string. For batches, use embedBatch.
export async function embed(text: string): Promise<number[]> {
  const [v] = await embedBatch([text]);
  if (!v) throw new Error("Voyage returned no embedding");
  return v;
}

// Embed up to 128 inputs in one call. Voyage handles up to 1000 per request
// but we cap at 128 to keep latency predictable.
export async function embedBatch(inputs: string[], inputType: "document" | "query" = "document"): Promise<number[][]> {
  if (inputs.length === 0) return [];
  if (inputs.length > 128) {
    const chunks: number[][] = [];
    for (let i = 0; i < inputs.length; i += 128) {
      const slice = inputs.slice(i, i + 128);
      chunks.push(...(await embedBatch(slice, inputType)));
    }
    return chunks;
  }

  const res = await fetch(VOYAGE_API, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.voyageApiKey}`,
    },
    body: JSON.stringify({
      input: inputs,
      model: MODEL,
      input_type: inputType,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Voyage ${res.status}: ${body}`);
  }

  const json = (await res.json()) as VoyageResponse;
  // Sort by index so output order matches input order.
  return json.data.sort((a, b) => a.index - b.index).map((d) => d.embedding);
}
