// Chunk a single playbook document into discrete coachable chunks and write
// them into playbook_chunks with Voyage embeddings.
//
// Idempotent on (source_doc, version): re-running the same source_doc replaces
// all rows for that doc.

import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import mammoth from "mammoth";
import { admin, pgVector } from "../lib/supabase.js";
import { generateJson, MODELS } from "../lib/anthropic.js";
import { embedBatch } from "../lib/voyage.js";
import { loadPromptCached } from "../lib/prompts.js";
import type { Database } from "../lib/database.types.js";

type PlaybookInsert = Database["public"]["Tables"]["playbook_chunks"]["Insert"];
type CallStage = Database["public"]["Enums"]["call_stage"];

interface ExtractedChunk {
  section: string;
  objection_label: string | null;
  stage: CallStage | null;
  recommended_response: string;
}

const VALID_STAGES: ReadonlySet<CallStage> = new Set([
  "opener","qualifier","motivation","condition","price","close","post_close",
]);

async function extractText(filePath: string): Promise<string> {
  const ext = extname(filePath).toLowerCase();
  if (ext === ".md" || ext === ".txt") {
    return readFile(filePath, "utf8");
  }
  if (ext === ".docx") {
    const result = await mammoth.extractRawText({ path: filePath });
    return result.value;
  }
  if (ext === ".pdf") {
    // pdf-parse has a buggy default loader on import. Use the lib subpath directly.
    const pdfParse = (await import("pdf-parse/lib/pdf-parse.js")).default;
    const buf = await readFile(filePath);
    const result = await pdfParse(buf);
    return result.text;
  }
  throw new Error(`Unsupported file type: ${ext} (${filePath})`);
}

export async function chunkPlaybook(opts: {
  filePath: string;
  versionBumpIfChanged?: boolean;
}): Promise<{ inserted: number; skipped: number; chunks: ExtractedChunk[] }> {
  const sourceDoc = basename(opts.filePath);
  console.log(`[chunk-playbook] reading ${sourceDoc}`);

  const text = await extractText(opts.filePath);
  if (text.trim().length < 50) {
    console.warn(`[chunk-playbook] ${sourceDoc} has <50 chars; skipping`);
    return { inserted: 0, skipped: 0, chunks: [] };
  }

  const systemPrompt = await loadPromptCached("chunk_playbook.system.md");
  const userPrompt = `=== SOURCE DOCUMENT: ${sourceDoc} ===\n\n${text}`;

  const { data: chunks, usage } = await generateJson<ExtractedChunk[]>({
    model: MODELS.sonnet,        // chunking is interpretive; Sonnet earns its cost here
    systemPrompt,
    userPrompt,
    maxTokens: 16000,
  });

  if (!Array.isArray(chunks)) {
    throw new Error(`chunk_playbook returned non-array: ${JSON.stringify(chunks).slice(0, 200)}`);
  }

  // Validate + filter
  const usable = chunks.filter((c) => {
    if (!c.recommended_response || c.recommended_response.trim().length < 5) return false;
    if (c.stage !== null && !VALID_STAGES.has(c.stage)) {
      // coerce unknown stages to null rather than drop
      c.stage = null;
    }
    return true;
  });

  if (usable.length === 0) {
    console.warn(`[chunk-playbook] ${sourceDoc}: no usable chunks extracted`);
    return { inserted: 0, skipped: chunks.length, chunks: [] };
  }

  // Embed each chunk's recommended_response (what the live coach matches against)
  const embeddings = await embedBatch(
    usable.map((c) => `${c.section}: ${c.recommended_response}`),
    "document"
  );

  // Idempotent: deactivate prior chunks for this source_doc, then insert new.
  // Keeps history (active=false rows) for audit / rollback.
  await admin().from("playbook_chunks")
    .update({ active: false, updated_at: new Date().toISOString() })
    .eq("source_doc", sourceDoc)
    .eq("active", true);

  const rows: PlaybookInsert[] = usable.map((c, i) => ({
    source_doc: sourceDoc,
    section: c.section,
    objection_label: c.objection_label,
    stage: c.stage,
    recommended_response: c.recommended_response.trim(),
    embedding: pgVector(embeddings[i]!),
    active: true,
    version: 1,
  }));

  const { error, count } = await admin().from("playbook_chunks").insert(rows, { count: "exact" });
  if (error) throw new Error(`Supabase insert: ${error.message}`);

  console.log(
    `[chunk-playbook] ${sourceDoc}: extracted=${chunks.length} usable=${usable.length} inserted=${count}`,
    `tokens in/out=${usage.input_tokens}/${usage.output_tokens}`
  );
  return { inserted: count ?? 0, skipped: chunks.length - usable.length, chunks: usable };
}
