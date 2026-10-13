// Walk playbook/raw/ and chunk every supported file (.pdf .docx .md .txt).
//
// Usage:
//   npm run playbook                     # chunk all files in playbook/raw/
//   npm run playbook -- --file path.pdf  # chunk just one file
//   npm run playbook -- --dir some/dir   # chunk a different directory
//
// Idempotent: re-running deactivates previous chunks for each file and inserts
// fresh ones (so editing a script + re-running gives a clean update).

import { readdirSync, statSync } from "node:fs";
import { resolve, join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { chunkPlaybook } from "../workers/chunk-playbook.js";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../..");
const DEFAULT_DIR = resolve(REPO_ROOT, "playbook/raw");

const SUPPORTED = new Set([".pdf", ".docx", ".md", ".txt"]);

function parseArgs(argv: string[]): { file?: string; dir?: string } {
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
  return {
    file: typeof args.file === "string" ? args.file : undefined,
    dir: typeof args.dir === "string" ? args.dir : undefined,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();

  let files: string[] = [];
  if (args.file) {
    files = [resolve(args.file)];
  } else {
    const dir = args.dir ? resolve(args.dir) : DEFAULT_DIR;
    files = readdirSync(dir)
      .filter((f) => SUPPORTED.has(extname(f).toLowerCase()))
      .map((f) => join(dir, f))
      .filter((p) => statSync(p).isFile());
  }

  if (files.length === 0) {
    console.log(`[process-playbook] no supported files found`);
    return;
  }

  console.log(`[process-playbook] ${files.length} file(s) to chunk:\n  ${files.join("\n  ")}\n`);

  let total = 0;
  let failed = 0;
  for (const f of files) {
    try {
      const { inserted } = await chunkPlaybook({ filePath: f });
      total += inserted;
    } catch (err) {
      failed++;
      console.error(`[process-playbook] FAILED on ${f}:`, err instanceof Error ? err.message : err);
    }
  }

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n[process-playbook] done in ${elapsed}s. ${total} chunks inserted, ${failed} files failed.`);
}

main().catch((err) => {
  console.error("[process-playbook] FAILED:", err);
  process.exit(1);
});
