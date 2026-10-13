// Retrieval test bench: paste a seller utterance, optionally specify a stage,
// and see what the live coach would retrieve from the knowledge base.
//
// Usage:
//   npm run retrieve -- "Your offer is way too low for what I've put into this place"
//   npm run retrieve -- "I need to talk to my husband first" --stage close
//   npm run retrieve -- "..." --winners 5 --losers 2 --playbook 2
//
// Output:
//   Top winning patterns + top losing patterns from `match_patterns`
//   Top playbook chunks from `match_playbook`
//   Each row shows similarity score, source, and the actual line.

import { admin, pgVector } from "../lib/supabase.js";
import { embed } from "../lib/voyage.js";
import type { Database } from "../lib/database.types.js";

type CallStage = Database["public"]["Enums"]["call_stage"];

function parseArgs(argv: string[]): { utterance: string; stage?: CallStage; winnersK: number; losersK: number; playbookK: number } {
  let utterance = "";
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    } else if (!utterance) {
      utterance = a;
    }
  }
  if (!utterance) throw new Error("Pass the seller utterance as the first positional arg.");
  return {
    utterance,
    stage: flags.stage as CallStage | undefined,
    winnersK: flags.winners ? Number(flags.winners) : 5,
    losersK: flags.losers ? Number(flags.losers) : 2,
    playbookK: flags.playbook ? Number(flags.playbook) : 2,
  };
}

function fmtSim(s: number | null): string {
  if (s === null || s === undefined) return "?.???";
  return s.toFixed(3);
}

function truncate(s: string, n: number): string {
  if (!s) return "";
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const t0 = Date.now();
  console.log(`[retrieve] utterance: "${args.utterance}"`);
  console.log(`[retrieve] stage filter: ${args.stage ?? "(none)"}`);

  const tEmbedStart = Date.now();
  const vec = await embed(args.utterance);
  const tEmbedMs = Date.now() - tEmbedStart;
  const queryEmbedding = pgVector(vec);

  // Patterns RPC
  const tPatStart = Date.now();
  const { data: patterns, error: patErr } = await admin().rpc("match_patterns", {
    query_embedding: queryEmbedding,
    match_stage: args.stage,
    winners_k: args.winnersK,
    losers_k: args.losersK,
  });
  const tPatMs = Date.now() - tPatStart;
  if (patErr) throw new Error(`match_patterns: ${patErr.message}`);

  // Playbook RPC
  const tPbStart = Date.now();
  const { data: playbook, error: pbErr } = await admin().rpc("match_playbook", {
    query_embedding: queryEmbedding,
    match_stage: args.stage,
    k: args.playbookK,
  });
  const tPbMs = Date.now() - tPbStart;
  if (pbErr) throw new Error(`match_playbook: ${pbErr.message}`);

  const winners = (patterns ?? []).filter((p) => p.outcome_label === "winning");
  const losers = (patterns ?? []).filter((p) => p.outcome_label === "losing");

  console.log(`\n=== WINNING patterns (${winners.length}) ===`);
  for (const p of winners) {
    console.log(`[${fmtSim(p.similarity)}] ${p.stage}/${p.pattern_type}`);
    console.log(`  seller:  ${truncate(p.seller_utterance_paraphrase ?? "", 120)}`);
    console.log(`  agent:   ${truncate(p.agent_response ?? "(no response captured)", 200)}`);
  }

  console.log(`\n=== LOSING patterns (${losers.length}) ===`);
  for (const p of losers) {
    console.log(`[${fmtSim(p.similarity)}] ${p.stage}/${p.pattern_type}`);
    console.log(`  seller:  ${truncate(p.seller_utterance_paraphrase ?? "", 120)}`);
    console.log(`  agent:   ${truncate(p.agent_response ?? "", 200)}`);
  }

  console.log(`\n=== PLAYBOOK chunks (${(playbook ?? []).length}) ===`);
  for (const pc of playbook ?? []) {
    console.log(`[${fmtSim(pc.similarity)}] ${pc.section} | stage=${pc.stage ?? "*"} | objection=${pc.objection_label ?? "-"}`);
    console.log(`  ${truncate(pc.recommended_response, 240)}`);
  }

  const total = Date.now() - t0;
  console.log(
    `\n[retrieve] timings:`,
    `embed=${tEmbedMs}ms`,
    `match_patterns=${tPatMs}ms`,
    `match_playbook=${tPbMs}ms`,
    `total=${total}ms`
  );
}

main().catch((err) => {
  console.error("[retrieve] FAILED:", err);
  process.exit(1);
});
