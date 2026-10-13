import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

// Resolve to repo-root prompts/ directory regardless of where the worker runs from.
const here = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(here, "../../../prompts");

export async function loadPrompt(name: string): Promise<string> {
  return readFile(resolve(PROMPTS_DIR, name), "utf8");
}

// Substitute {{KEY}} tokens in a template.
export function fill(template: string, vars: Record<string, string | number | null | undefined>): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = vars[key];
    if (v === null || v === undefined) return "";
    return String(v);
  });
}

// Cached prompt strings, loaded lazily.
const cache = new Map<string, string>();
export async function loadPromptCached(name: string): Promise<string> {
  const hit = cache.get(name);
  if (hit !== undefined) return hit;
  const text = await loadPrompt(name);
  cache.set(name, text);
  return text;
}
