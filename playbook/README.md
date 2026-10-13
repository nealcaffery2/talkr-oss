# Playbook

Drop your scripts, objection rebuttals, opening lines, closing techniques, and any other "house rules" the live coach should reference here. The chunker (`apps/api/scripts/process-playbook.ts`) reads everything in `raw/`, runs it through Claude to break it into discrete chunks (objection_label, stage, recommended_response), embeds each with Voyage-3, and stores them in the `playbook_chunks` table in Supabase.

The live coach (`/api/suggest`) retrieves the top 1-2 most relevant chunks per detected stage on every seller utterance and stuffs them into the system prompt alongside historical winning responses.

## What to drop in `raw/`

Anything. The chunker is format-agnostic. Common shapes:

- **Master script** — the full opening-to-close call flow (Google Doc exported as PDF, .docx, .md, or .txt).
- **Objection cheat sheets** — "if seller says X, you say Y" lists.
- **Stage-specific guides** — opener scripts, price anchoring, close attempts, post-contract.
- **Tribal knowledge** — voice memos transcribed, Slack messages from your top closer, anything that lives in someone's head today.

Filename convention (helps the chunker but not required): prefix with the stage or use clear titles.

```
playbook/raw/
  master-script-v3.pdf
  objections-price-too-low.md
  objections-not-motivated.md
  opener-script.md
  close-techniques.md
  top-closer-notes.md
```

## Supported formats

- `.md`, `.txt` — read directly
- `.pdf` — text extracted with pdf-parse
- `.docx` — text extracted with mammoth
- Google Docs — export as PDF or paste into a `.md` file

## What the chunker produces

Each input file becomes N rows in `playbook_chunks`. Schema:

```
section            text       e.g. "price_anchoring"
objection_label    text|null  e.g. "too_low", "going_with_realtor"
stage              call_stage e.g. "price"
recommended_response text     the actual line(s) the agent should say
embedding          vector(1024) for retrieval
```

Re-running the chunker is idempotent on file content hash — only changed files get re-processed. Bumping a chunk's `version` lets you A/B-test alternate phrasings.

## Privacy

`raw/example-objections.md` is a made-up example. Your own scripts are usually
proprietary: if you keep them in a public fork, put them in `raw/.private/`
(gitignored) instead of `raw/`.

## What's in `parsed/`

The chunker writes the structured JSON output here so you can inspect what it extracted before it lands in Supabase. Files in `parsed/` are gitignored (regenerable).
