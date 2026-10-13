// One-command YouTube ingestion: take a URL (single video or playlist),
// download audio via yt-dlp, then run each through the standard pipeline
// with --training flag. Cleans up MP3s after processing by default.
//
// Usage:
//   npm run youtube -- --url "https://www.youtube.com/watch?v=..." --source youtube-channel --agent "Channel Host" --outcome contract
//   npm run youtube -- --url "https://www.youtube.com/playlist?list=..." --source youtube-channel --agent "Channel Host" --outcome contract
//   npm run youtube -- --url "..." ... --keep-audio    # don't delete MP3s after

import { spawnSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, unlinkSync, statSync } from "node:fs";
import { resolve, join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(here, "../../..");
const RECORDINGS = resolve(REPO_ROOT, "recordings/training");

// Resolve yt-dlp + ffmpeg binaries (PATH first, then winget-known location).
function resolveBin(name: string, wingetSubpath: string): string {
  const which = spawnSync(process.platform === "win32" ? "where" : "which", [name], { encoding: "utf8" });
  if (which.status === 0 && which.stdout.trim()) {
    return which.stdout.trim().split(/\r?\n/)[0]!;
  }
  const local = process.env.LOCALAPPDATA;
  if (local) {
    const guess = join(local, "Microsoft", "WinGet", "Packages", wingetSubpath);
    if (existsSync(guess)) return guess;
  }
  throw new Error(`Cannot find ${name}. Run: winget install ${name}`);
}

const YT_DLP = resolveBin("yt-dlp", "yt-dlp.yt-dlp_Microsoft.Winget.Source_8wekyb3d8bbwe/yt-dlp.exe");
const FFMPEG_BIN = resolveBin("ffmpeg", "Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1-full_build/bin/ffmpeg.exe");
const FFMPEG_DIR = dirname(FFMPEG_BIN);

interface Args {
  url: string;
  source: string;
  agent: string;
  outcome: string;
  phone: string;
  keepAudio: boolean;
  maxVideos: number;
  maxDurationSec: number;        // skip videos longer than this (default 30 min)
  minDurationSec: number;        // skip videos shorter than this (default 60 sec)
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
  if (typeof args.url !== "string") throw new Error("--url is required");
  if (typeof args.source !== "string") throw new Error("--source is required (e.g. youtube-channel)");
  if (typeof args.agent !== "string") throw new Error("--agent is required (e.g. \"Channel Host\")");
  return {
    url: args.url,
    source: args.source,
    agent: args.agent,
    outcome: typeof args.outcome === "string" ? args.outcome : "contract",
    phone: typeof args.phone === "string" ? args.phone : "+10000000000",
    keepAudio: !!args["keep-audio"],
    maxVideos: typeof args["max-videos"] === "string" ? Number(args["max-videos"]) : Infinity,
    maxDurationSec: typeof args["max-duration"] === "string" ? Number(args["max-duration"]) * 60 : 30 * 60,
    minDurationSec: typeof args["min-duration"] === "string" ? Number(args["min-duration"]) * 60 : 60,
  };
}

function run(cmd: string, cmdArgs: string[], opts: { cwd?: string } = {}): Promise<number> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn(cmd, cmdArgs, { cwd: opts.cwd, stdio: "inherit" });
    child.on("error", rejectP);
    child.on("exit", (code) => resolveP(code ?? -1));
  });
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const channelDir = resolve(RECORDINGS, args.source);
  mkdirSync(channelDir, { recursive: true });

  console.log(`[youtube] yt-dlp:  ${YT_DLP}`);
  console.log(`[youtube] ffmpeg: ${FFMPEG_BIN}`);
  console.log(`[youtube] dest:   ${channelDir}`);
  console.log(`[youtube] url:    ${args.url}`);

  // Snapshot which files exist before download so we can identify new ones.
  const before = new Set(readdirSync(channelDir).filter((f) => f.endsWith(".mp3")));

  // Download. yt-dlp handles single videos AND playlists transparently.
  // -x = audio only, --audio-format mp3 at 32kbps mono (Deepgram's preferred
  // format, keeps file size manageable on long calls).
  // --match-filter pre-filters by duration BEFORE download, so long
  // compilations get skipped without burning bandwidth.
  const matchFilter = `duration >= ${args.minDurationSec} & duration <= ${args.maxDurationSec}`;
  const ytArgs = [
    "-x", "--audio-format", "mp3",
    "--audio-quality", "32K",
    "--postprocessor-args", "ffmpeg:-ac 1 -ar 16000",
    "--ffmpeg-location", FFMPEG_DIR,
    "--no-playlist-reverse",
    "--match-filter", matchFilter,
    "-o", join(channelDir, "%(playlist_index|0)s_%(title).100B.%(ext)s"),
  ];
  // --max-downloads counts only items that pass the filter (vs --playlist-end
  // which caps the search space to the first N items pre-filter).
  if (Number.isFinite(args.maxVideos)) {
    ytArgs.push("--max-downloads", String(args.maxVideos));
  }
  ytArgs.push(args.url);

  console.log(
    `[youtube] filter: ${args.minDurationSec}s <= duration <= ${args.maxDurationSec}s ` +
    `(${(args.maxDurationSec / 60).toFixed(0)} min cap), max-downloads: ${args.maxVideos}`
  );

  console.log(`\n[youtube] downloading...`);
  const dlExit = await run(YT_DLP, ytArgs);
  // yt-dlp exits 101 when --max-downloads triggers (intentional early stop).
  // Treat that as success; only bail on other non-zero codes IF no files came down.
  if (dlExit !== 0 && dlExit !== 101) {
    const beforeCount = before.size;
    const afterCount = readdirSync(channelDir).filter((f) => f.endsWith(".mp3")).length;
    if (afterCount === beforeCount) {
      console.error(`[youtube] yt-dlp exited ${dlExit} with no new files`);
      process.exit(dlExit);
    }
    console.warn(`[youtube] yt-dlp exited ${dlExit} but produced ${afterCount - beforeCount} files; continuing`);
  }

  const after = readdirSync(channelDir).filter((f) => f.endsWith(".mp3"));
  const newFiles = after.filter((f) => !before.has(f)).sort();
  if (newFiles.length === 0) {
    console.log(`[youtube] no new files downloaded (already had: ${after.length})`);
    return;
  }

  console.log(`\n[youtube] downloaded ${newFiles.length} file(s):`);
  for (const f of newFiles) {
    const sizeMB = (statSync(join(channelDir, f)).size / 1024 / 1024).toFixed(1);
    console.log(`  ${f} (${sizeMB}MB)`);
  }

  // Process each file through the existing process-call CLI with --training.
  const processScript = resolve(here, "process-call.ts");
  let succeeded = 0;
  let failed = 0;
  for (const f of newFiles) {
    const fullPath = join(channelDir, f);
    console.log(`\n[youtube] === processing ${f} ===`);
    const procArgs = [
      "--env-file=.env.local",
      "--import", "tsx",
      processScript,
      "--file", fullPath,
      "--training",
      "--source", args.source,
      "--outcome", args.outcome,
      "--agent", args.agent,
      "--phone", args.phone,
    ];
    const exit = await run("node", procArgs, { cwd: resolve(here, "..") });
    if (exit === 0) {
      succeeded++;
      if (!args.keepAudio) {
        try {
          unlinkSync(fullPath);
          console.log(`[youtube] removed ${f}`);
        } catch (err) {
          console.warn(`[youtube] could not remove ${f}:`, err);
        }
      }
    } else {
      failed++;
      console.error(`[youtube] FAILED on ${f} (exit ${exit}); keeping audio file for inspection`);
    }
  }

  console.log(`\n[youtube] done. ${succeeded} succeeded, ${failed} failed.`);
}

main().catch((err) => {
  console.error("[youtube] FAILED:", err);
  process.exit(1);
});
