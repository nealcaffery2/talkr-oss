# Talkr Platform — Scripts & in-call context

**Status:** living document; matches `packages/core/src/scripts.ts`,
`packages/core/src/rbac.ts` (`scripts.read` / `scripts.write`),
`packages/db/src/schema.ts` (`scripts`),
`packages/db/migrations/0018_scripts.sql`,
`apps/server/src/services/scripts.ts`,
`apps/server/src/services/call-context.ts`,
`apps/server/src/routes/scripts.ts` and
`apps/server/src/playbook/example-scripts.json`.

A script is what a rep reads mid-call: the talk track (`kind = 'script'`) and
the objection rebuttals beside it (`kind = 'rebuttal'`). Scripts are org data,
editable in the app, seeded from a built-in playbook preset.

`GET /v1/call-context` is the other half. It is the **one** read the dialer
makes when a number is typed, a call rings, or a call connects: who is on the
other end, what has already happened with them, and the exact words to say,
with merge fields already substituted. One request, a fixed and bounded
number of batched queries, nothing written.

---

## 1. Data model

`scripts` (migration `0018_scripts.sql`):

| Column | Type | Meaning |
|---|---|---|
| `id` | uuid pk | |
| `org_id` | uuid → organizations | every read and write is org-scoped from the `AuthContext`, never the body |
| `kind` | text | `script` (talk track) · `rebuttal` (objection answer) |
| `title` | text | shown in the list and the picker; with `kind` it is the import match key |
| `category` | text, nullable | `opener` · `rapport` · `qualifying` · `motivation` · `condition` · `timeline` · `price` · `novation` · `close` · `voicemail` · `objection` · … |
| `tags` | text[], default `{}` | a rebuttal's trigger phrases ("not interested", "lowball") |
| `contact_types` | text[], default `{}` | narrows the script to contact types; **empty = any** |
| `campaign_id` | uuid → campaigns, `ON DELETE SET NULL` | pins the script to one campaign; null = every campaign |
| `body` | text | light markdown with merge fields (§6); never trimmed — indentation is meaning |
| `sort_order` | integer, default 0 | call order; lowest first |
| `enabled` | boolean, default true | a disabled script never reaches call-context |
| `created_by` | uuid → users, nullable | null for a preset imported by a system actor |
| `created_at`, `updated_at` | timestamptz | |

Indexes: `(org_id, kind, sort_order)` for the list and the call-context read,
`(org_id, campaign_id)` for campaign-pinned scripts.

`kind` and `category` are **text in the database**; the closed sets live in
code (`SCRIPT_KINDS` in `packages/core/src/scripts.ts`, `CONTACT_TYPES` in
`packages/core/src/contacts.ts` for `contact_types`). The API rejects a value
outside the list — adding one is a code review, not a migration. `category`
is deliberately open: an org can invent its own section name.

## 2. Permissions

Additive in `packages/core/src/rbac.ts`:

| Permission | rep | manager | admin/owner |
|---|---|---|---|
| `scripts.read` (list, read one, "I used this") | ✓ | ✓ | ✓ |
| `scripts.write` (create, edit, delete, reorder, import) | | ✓ | ✓ |

`GET /v1/call-context` is **not** on `scripts.read` — it is the dialer's
screen, so it takes either `leads.read` or `contacts.read`, whichever the
caller has. A rep who can dial can always fetch the context for the call.

## 3. API

All routes live under the `/v1` bearer-auth preHandler
(`registerScriptRoutes` is registered after `registerV1Routes` in `app.ts`,
after contacts because call-context reuses the `ContactDto` loader).

### ScriptDto

```json
{
  "id": "8b1e2c44-1f2e-4a9c-9d55-2a5c0f8f9a10",
  "kind": "script",
  "title": "Intro & intent (confirm they want to sell)",
  "category": "opener",
  "tags": [],
  "contact_types": [],
  "campaign_id": null,
  "body": "## 1. Intro & intent\n\n**“Hey {first_name}, this is {rep_first_name}. I’m calling about your property on {address}. …",
  "sort_order": 10,
  "enabled": true,
  "created_at": "2026-09-08T15:04:11.221Z",
  "updated_at": "2026-09-08T15:04:11.221Z"
}
```

### `GET /v1/scripts` (scripts.read)

Query: `kind` (`script` | `rebuttal`), `q` (substring over title, body,
category and tags — ILIKE, escaped), `include_disabled` (`true` | `false`,
default false). An empty param (`?kind=`) means "not set".

Ordered `kind`, then `sort_order`, then `title`. Returns
`{ "scripts": ScriptDto[] }`.

### `GET /v1/scripts/:id` (scripts.read)

Returns `{ "script": ScriptDto }`; `404 { "error": "not_found" }` for an id
in another org, an id that does not exist, or anything that is not a uuid.

This is how a client opens an **alternative** mid-call: `GET /v1/call-context`
returns `scripts.alternatives` as `{ id, title, category }` only, so the web
app and the extension fetch the body on demand when the rep picks one.
Disabled scripts are returned here (an editor deep-linking to one must see
it) even though call-context never offers them.

### `POST /v1/scripts` (scripts.write)

Body — the same schema every write path shares:

| Field | Required | Notes |
|---|---|---|
| `kind` | ✓ | `script` \| `rebuttal` |
| `title` | ✓ | trimmed, 1–160 chars |
| `category` | | ≤ 60 chars, nullable |
| `tags` | | ≤ 50 entries, each ≤ 60 chars; trimmed, blanks dropped, deduped case-insensitively (first spelling wins), order kept |
| `contact_types` | | from `CONTACT_TYPES`; deduped. Empty = any |
| `campaign_id` | | must be a campaign in the caller's org |
| `body` | ✓ | ≤ 20 000 chars, must not be blank; stored verbatim |
| `sort_order` | | integer, default 0 |
| `enabled` | | default true |

`201 { "script": ScriptDto }`. `400 { "error": "invalid_body", issues }` on a
schema failure; `400 { "error": "invalid_campaign", campaign_id, message }`
when `campaign_id` is not one of the org's campaigns. Audited as
`script.created`.

### `PATCH /v1/scripts/:id` (scripts.write)

Every field above, all optional. Only the keys the body carries are written,
and the audit records exactly those (`{ changed: [...] }`). A body with no
known key is `400 { "error": "empty_update" }`; an unknown id is
`404 { "error": "not_found" }`. Returns `{ "script": ScriptDto }`. Audited as
`script.updated`.

### `DELETE /v1/scripts/:id` (scripts.write)

Hard delete, org-scoped. `204` on success, `404 { "error": "not_found" }`
otherwise. Audited as `script.deleted`.

### `POST /v1/scripts/reorder` (scripts.write)

```json
{ "ids": ["<uuid>", "<uuid>", "…"] }
```

1–500 ids, deduped. Each script's `sort_order` becomes **its position in the
list given** (0-based), in one transaction; ids outside the org update
nothing. Returns `{ "ok": true }`. Audited as `scripts.reordered`.

### `POST /v1/scripts/import` (scripts.write)

```json
{ "preset": "example", "mode": "skip" }
{ "scripts": [ /* 1–500 ScriptInput */ ], "mode": "replace" }
```

Exactly one of `preset` (`example` today) or `scripts` is required — both
or neither is `400 invalid_body`. `mode` defaults to `skip`.

Rows are matched against the org's existing scripts on **`kind` + `title`,
case-insensitively**:

- no match → **created**
- match, `mode: "skip"` → **skipped**, the existing row is untouched
- match, `mode: "replace"` → **updated** in place; every field is overwritten
  and the id survives, so anything referencing it keeps working
- a `kind` + `title` repeated inside the batch is **skipped** after its first
  occurrence

Returns `{ "created": n, "updated": n, "skipped": n }`. Runs in one
transaction with its `scripts.imported` audit row. Re-running the preset
import is therefore safe: `skip` is a no-op, `replace` resets the org's
scripts to the playbook without changing any ids.

```bash
curl -X POST https://api.talkr.example/v1/scripts/import \
  -H "authorization: Bearer $TALKR_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"preset":"example"}'
# {"created":40,"updated":0,"skipped":0}
```

Add `"mode":"replace"` to overwrite the org's copies with the current
playbook.

### `POST /v1/scripts/:id/used` (scripts.read)

```json
{ "call_id": "<uuid>", "contact_id": "<uuid>" }
```

Both optional. Writes a `script.used` audit row (kind, title, category,
`call_id`, `contact_id`) and returns `204`. This is the ping the client sends
when a rep actually reads a script or a rebuttal; it is what coaching
analytics will aggregate later. `404` for an id outside the org.

## 4. In-call context

### `GET /v1/call-context` (leads.read **or** contacts.read)

Exactly one selector, plus an optional campaign hint:

| Param | Meaning |
|---|---|
| `phone` | a raw number the rep typed or the ring is from; normalized to E.164 |
| `contact_id` | the contact the rep clicked |
| `lead_id` | the lead the rep clicked |
| `call_id` | a call already in flight — the richest selector |
| `campaign_id` | optional hint: the campaign the dial session is working. Wins over inference |

Zero or two-plus selectors is
`400 { "error": "selector_required", "message": "exactly one of phone, contact_id, lead_id or call_id is required" }`.
A number that is not dialable (a `client:` identity, garbage) is
`400 { "error": "invalid_phone" }`. A `contact_id` / `lead_id` / `call_id`
outside the org is `404 { "error": "not_found", "message": "… not found" }`.

**How the other party is resolved.** `call_id` → the call's contact, lead,
the far-end number (`from_number` for inbound, `to_number` for outbound) and
the campaign recorded on the call. `lead_id` → the lead's primary contact.
`phone` with no contact given → the oldest live contact that owns that number
(the same rule as `findPhoneOwners`). From the contact, the lead and the
primary phone are filled in if still missing.

**What is gathered.** Activity (calls, texts, completed tasks) is matched to
the person three ways, because the schema links them three ways: by
`contact_id`, by any of the contact's leads, and by the numbers themselves —
so history survives a contact that was created after the first call. The
call in progress is excluded from its own history. Up to 10 activity items
(merged and sorted newest first), 20 open tasks.

When `campaign_id` is not given, the campaign is inferred: the newest
**active** campaign any of the person's leads is enrolled in (excluding
`removed` enrollments). That campaign is what campaign-pinned scripts match
against (§5).

`suggest_create` is non-null only when a dialable number resolved to no
contact — the client's "unknown number, create a contact?" prompt.

### Response shape

```json
{
  "phone_e164": "+16145550134",
  "contact": {
    "id": "3f6c1b90-6a2b-4d5e-8f11-0c2b7d9e4a01",
    "display_name": "Jane Doe",
    "type": "seller",
    "status": "engaged",
    "email": "jane@example.com",
    "company": null,
    "tags": ["inherited"],
    "source": "podio",
    "notes": null,
    "temperature": "warm",
    "temperature_score": 58,
    "temperature_locked": false,
    "last_activity_at": "2026-09-05T18:22:04.000Z",
    "assigned_user_id": "b0d1e2f3-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
    "assigned_user_name": "Sam Rep",
    "phones": [
      { "id": "9c8b7a65-4321-4def-8abc-1234567890ab", "phone_e164": "+16145550134", "label": "mobile", "is_primary": true }
    ],
    "primary_phone": "+16145550134",
    "address": { "line1": "123 Rutger St", "city": "Columbus", "state": "OH", "postal_code": "43215" },
    "lead_id": "aa11bb22-cc33-4d44-8e55-ff6677889900",
    "lead_status": "working",
    "created_at": "2026-07-02T14:00:00.000Z",
    "updated_at": "2026-09-05T18:22:04.000Z",
    "deleted_at": null
  },
  "lead": {
    "id": "aa11bb22-cc33-4d44-8e55-ff6677889900",
    "status": "working",
    "source": "podio",
    "assigned_user_id": "b0d1e2f3-4a5b-4c6d-8e9f-0a1b2c3d4e5f",
    "assigned_user_name": "Sam Rep",
    "external_item_id": "2847761234",
    "crm_url": "https://podio.com/x/y/item/2847761234",
    "created_at": "2026-07-02T14:00:00.000Z"
  },
  "property": {
    "id": "dd44ee55-ff66-4a77-8b88-99cc00dd11ee",
    "line1": "123 Rutger St",
    "city": "Columbus",
    "state": "OH",
    "postal_code": "43215"
  },
  "activity": [
    {
      "kind": "call",
      "id": "11112222-3333-4444-8555-666677778888",
      "at": "2026-09-05T18:20:11.000Z",
      "direction": "outbound",
      "status": "completed",
      "duration_seconds": 214,
      "body": null,
      "disposition_label": "Interested",
      "note": "Wants 210k, mortgage payoff is 140k. Call back Tuesday.",
      "user_name": "Sam Rep"
    },
    {
      "kind": "sms",
      "id": "22223333-4444-5555-8666-777788889999",
      "at": "2026-09-05T18:22:04.000Z",
      "direction": "inbound",
      "status": "received",
      "duration_seconds": null,
      "body": "Tuesday after 4 works",
      "disposition_label": null,
      "note": null,
      "user_name": null
    },
    {
      "kind": "task",
      "id": "33334444-5555-6666-8777-888899990000",
      "at": "2026-08-28T13:00:00.000Z",
      "direction": null,
      "status": "done",
      "duration_seconds": null,
      "body": "Pull comps for 123 Rutger St",
      "disposition_label": null,
      "note": "ARV ~245k",
      "user_name": "Sam Rep"
    }
  ],
  "last_call_summary": {
    "call_id": "11112222-3333-4444-8555-666677778888",
    "at": "2026-09-05T18:20:11.000Z",
    "summary": "Seller is motivated by a job relocation in November. Asking 210k; open to a cash offer if closing costs are covered.",
    "next_steps": ["Send the contract and follow up Tuesday after 4pm"],
    "objections": ["price too low", "needs to talk to spouse"]
  },
  "open_tasks": [
    {
      "id": "44445555-6666-7777-8888-99990000aaaa",
      "title": "Send contract",
      "due_at": "2026-09-09T20:00:00.000Z",
      "assigned_user_name": "Sam Rep"
    }
  ],
  "sequences": [
    {
      "id": "55556666-7777-8888-9999-0000aaaabbbb",
      "run_id": "66667777-8888-9999-aaaa-bbbbccccdddd",
      "name": "Seller nurture — 5 touch",
      "run_status": "waiting",
      "step": 3,
      "step_count": 5,
      "resume_at": "2026-09-10T14:00:00.000Z"
    }
  ],
  "campaign": { "id": "77778888-9999-aaaa-bbbb-ccccddddeeee", "name": "Franklin County absentee" },
  "scripts": {
    "primary": {
      "id": "8b1e2c44-1f2e-4a9c-9d55-2a5c0f8f9a10",
      "kind": "script",
      "title": "Intro & intent (confirm they want to sell)",
      "category": "opener",
      "tags": [],
      "contact_types": [],
      "campaign_id": null,
      "body": "## 1. Intro & intent\n\n**“Hey {first_name}, this is {rep_first_name}. I’m calling about your property on {address}. …",
      "sort_order": 10,
      "enabled": true,
      "created_at": "2026-09-08T15:04:11.221Z",
      "updated_at": "2026-09-08T15:04:11.221Z",
      "rendered_body": "## 1. Intro & intent\n\n**“Hey Jane, this is Sam. I’m calling about your property on 123 Rutger St. …"
    },
    "alternatives": [
      { "id": "9c2f3d55-2e3f-4bad-8e66-3b6d1f0fab21", "title": "Initial price discovery", "category": "price" },
      { "id": "a1d3e466-3f40-4cbe-9f77-4c7e2a10bc32", "title": "Motivation (problem-solving mode)", "category": "motivation" }
    ],
    "rebuttals": [
      {
        "id": "b2e4f577-4051-4dcf-8088-5d8f3b21cd43",
        "kind": "rebuttal",
        "title": "I’m too busy",
        "category": "objection",
        "tags": ["too busy", "no time", "busy", "swamped"],
        "contact_types": [],
        "campaign_id": null,
        "body": "- Ask if the property is part of what’s making them busy. …",
        "sort_order": 10,
        "enabled": true,
        "created_at": "2026-09-08T15:04:11.221Z",
        "updated_at": "2026-09-08T15:04:11.221Z",
        "rendered_body": "- Ask if the property is part of what’s making them busy. …"
      }
    ]
  },
  "merge_fields": {
    "first_name": "Jane",
    "name": "Jane Doe",
    "address": "123 Rutger St",
    "city": "Columbus",
    "state": "OH",
    "postal_code": "43215",
    "company": "Your Company",
    "rep_name": "Sam Rep",
    "rep_first_name": "Sam",
    "phone": "(614) 555-0134"
  },
  "suggest_create": null
}
```

Every key is always present. `contact`, `lead`, `property`, `campaign`,
`last_call_summary`, `scripts.primary` and `suggest_create` are `null` when
they do not apply; `activity`, `open_tasks`, `sequences`,
`scripts.alternatives` and `scripts.rebuttals` are `[]`.

An unknown number returns the same envelope with everything null or empty.
`merge_fields` always has all ten keys; on an unknown number only `company`,
`rep_name`, `rep_first_name` and `phone` are filled and the rest are empty
strings — which the renderer handles (§6). The generic scripts are still
selected, and `suggest_create` is `{ "phone_e164": "+16145550134" }`.

**Why `alternatives` is thin.** The primary and every rebuttal come back
rendered because the rep may need them in the next second. The alternatives
are a picker, not a script, so they carry `{ id, title, category }` only —
the client fetches the body from `GET /v1/scripts/:id` when the rep picks
one, and renders the merge fields from the `merge_fields` object it already
has.

## 5. Selection rules

`selectScripts` in `packages/core/src/scripts.ts` — pure, unit-tested, no
I/O. Call-context loads only `enabled = true` scripts for the org and hands
them here with `{ campaignId, contactType }` (the resolved campaign from §4
and `contact.type`, either of which may be null).

A script is **excluded entirely** when:

1. it is disabled, or
2. `campaign_id` is set and is not the call's campaign, or
3. `contact_types` is non-empty and the contact's type is not in it (a call
   with no contact excludes every typed script)

Everything left is ranked by tier:

| Tier | Rule |
|---|---|
| 0 | `campaign_id` matches the call's campaign |
| 1 | everything else that applies |

Within a tier: `sort_order` ascending, then `title`, then `id` — so the order
is stable and a reorder is the only thing that moves a script.

`contact_types` only **filters**; it never promotes. A script written for
sellers is not automatically what a rep opens a seller call with — the
novation pitch is a seller script, but it belongs late in the call, and the
playbook's own order says so. Pinning a script to a campaign is the one
explicit instruction that jumps the queue.

Then:

- **`primary`** — the first `kind = 'script'` in that order. This is the talk
  track the client opens on.
- **`alternatives`** — every other applicable `kind = 'script'`, same order:
  the rest of the primary's tier, then each lower tier.
- **`rebuttals`** — every applicable `kind = 'rebuttal'`, same ranking.
  Rebuttals are not "the next thing to say", so they are all returned
  rendered and the client filters them by `tags` as it hears the objection.

### Campaign-specific scripts

Pin a script to a campaign by setting `campaign_id`. It then appears **only**
on calls for that campaign, and when it does it outranks every generic
script — which is the whole point: a campaign gets its own opener without
anyone touching the org's default one.

The mechanics:

- `campaign_id` must be a campaign in the caller's org, on create, patch and
  import alike — otherwise `400 invalid_campaign`.
- The campaign a call belongs to is the `campaign_id` query param if given,
  else the campaign on the in-flight call's `raw`, else the newest active
  campaign the lead is enrolled in. Pass the dial session's campaign
  explicitly whenever the client knows it; inference is the fallback.
- Deleting a campaign does not delete its scripts —
  `ON DELETE SET NULL` turns them back into generic org scripts.
- A campaign-pinned script can also carry `contact_types`; the campaign wins
  for tier, and the contact-type filter still applies as an exclusion.

To seed a campaign's scripts, copy the org's and pin the copies:
`POST /v1/scripts/import` with `{"scripts":[…], "mode":"skip"}`, each entry
carrying the `campaign_id` and a title distinct from the generic one (the
match key is `kind` + `title`, so an identical title would collide with the
org default).

## 6. Merge fields

Bodies carry merge fields; `renderScriptMergeFields` substitutes them for
`rendered_body`. Both `{field}` and `{{ field }}` work, with any inner
whitespace and any case.

| Field | Source |
|---|---|
| `first_name` | first word of the contact's display name (a company-looking name — LLC, Inc, Trust — stays whole) |
| `name` | the contact's display name |
| `address` | the lead's property address line 1, else the contact's address |
| `city`, `state`, `postal_code` | same precedence: property, then contact |
| `company` | the org's name |
| `rep_name` | the signed-in user's display name |
| `rep_first_name` | first word of it |
| `phone` | the far-end number formatted for reading aloud — `+16145550134` → `(614) 555-0134` |

The renderer is **deliberately lenient**, because a rep reading mid-call must
never see a raw `{brace}`:

- a field with no value renders as an empty string
- a field nobody knows renders as an empty string too
- the double space that leaves behind is collapsed, and a space stranded
  before `,.!?;:` is dropped — so "Hey {first_name}, this is {rep_first_name}."
  with no contact reads "Hey, this is Sam."
- collapsing never touches leading whitespace, where markdown indentation
  lives

`unknownScriptMergeFields(body)` reports fields outside the list — the
editor uses it to warn, and the preset test asserts the playbook uses none.
This is looser than the SMS merge fields in `packages/core/src/sequences.ts`
on purpose: a bad SMS goes out wrong forever, a bad script is read by a human
who can skip a word.

## 7. The example playbook preset

`apps/server/src/playbook/example-scripts.json` holds a short, made-up
playbook (`preset: "example"`): nine talk-track scripts and three rebuttals.
It exists so a new org has something to look at and so the import path is
tested. Replace it with your own team's scripts. Every entry is a valid
`POST /v1/scripts` body; `apps/server/test/scripts-preset.test.ts` asserts
that, plus the call order and the merge fields.

Talk track, in `sort_order`: opener (10), rapport (20), qualifying (30),
motivation (40), condition (50), timeline (60), price (70), close (80),
voicemail (90). The rebuttals are all `category: "objection"`, each with 2–4
trigger tags the client matches on ("not interested" / "no thanks"; "call me
back" / "later"; "spouse" / "wife").

Out of the box nothing is disabled, nothing is campaign-pinned, and every
entry applies to any contact type.

**Bundling.** The preset is a static
`import examplePreset from '../playbook/example-scripts.json' with { type: 'json' }`.
`tsconfig.base.json` sets `resolveJsonModule`, and
`apps/server/scripts/bundle-serverless.mjs` runs esbuild with `bundle: true`,
which **inlines the JSON into `api/index.mjs`** as an object literal — the
`workspace-only` plugin only externalizes bare specifiers, and this one is
relative. There is no file read at runtime, so the preset does not need to be
in `vercel.json`'s `includeFiles` (which stays `{config,migrations}/**`).
Adding or editing a preset entry is a rebuild, not a deploy artifact change.

## 8. Documented assumptions

- **Hard delete.** Scripts have no `deleted_at`. Nothing references a script
  by id except audit rows, which keep the title. Import `replace` exists so
  an org can restore the playbook without deleting anything.
- **No versioning.** An edit overwrites; the audit row records which keys
  changed, not the old body. If script A/B testing ever lands it needs a
  versions table, like workflows.
- **`script.used` is audit-only.** It writes an audit row and nothing else —
  no counter on the script, no aggregate table. Coaching analytics will read
  the audit log; if that gets slow, the fix is a rollup job, not a column.
- **Call-context never writes.** Not a "last viewed" timestamp, not a lazily
  created contact. `suggest_create` hands the decision back to the client so
  a wrong number never leaves a row behind.
- **`crm_url` is derived.** The Podio sync stores no item link today, so the
  URL is built from `external_item_id`; a `raw.link` written by a future sync
  wins when present.
