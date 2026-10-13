# Talkr Platform — Contacts

**Status:** living document. Matches `packages/core/src/contacts.ts`,
`packages/db/src/schema.ts` (contacts), migration `0016_contacts_crm_fields.sql`,
`apps/server/src/routes/contacts.ts`, `apps/server/src/services/contacts.ts`,
`apps/server/src/services/contact-import.ts`,
`apps/server/src/services/contact-temperature.ts` and
`apps/server/src/worker/contact-temperature-sweep.ts`.

Contacts are the people (and companies) an org talks to. Before this module
a contact was a name hanging off a lead, created as a side effect of a lead
or an inbound call. Now it is a first-class CRM row: typed, statused, tagged,
assigned, scored hot/warm/cold from real activity, searchable, importable,
exportable, and the thing a rep selects to text or dial a list. The phone
book (`contact_phones`), the property (`leads` → `properties`) and every
call/message table stay exactly where they were — this module reads them,
it does not duplicate them.

---

## 1. Data model

`contacts` (additive columns, migration `0016_contacts_crm_fields.sql`):

| Column | Type | Meaning |
|---|---|---|
| `type` | text, default `seller` | `seller` · `buyer` · `title` · `company` · `vendor` · `other` |
| `status` | text, default `new` | `new` · `attempting` · `engaged` · `appointment` · `offer` · `under_contract` · `closed` · `dead` · `dnc` |
| `email`, `company`, `source`, `notes` | text | free text; email is stored lowercased |
| `tags` | text[], default `{}` | free-form labels; GIN indexed, searched with `@>` |
| `temperature` | text, default `cold` | `hot` · `warm` · `cold` — derived from the score unless locked |
| `temperature_score` | integer, default 0 | 0–100 (§4) |
| `temperature_locked` | boolean | a person set `temperature` by hand; the sweep leaves the bucket alone |
| `temperature_updated_at` | timestamptz | last recompute (null = never scored) |
| `last_activity_at` | timestamptz | max(call at, message at) across everything matched to the contact |
| `assigned_user_id`, `created_by` | uuid → users | |
| `updated_at` | timestamptz | bumped on every write |
| `deleted_at` | timestamptz | soft delete; deleted rows keep their name on call history |

Indexes: `(org_id, type)`, `(org_id, status)`, `(org_id, temperature_score DESC)`,
`(org_id, deleted_at)`, `(org_id, last_activity_at DESC)`, GIN on `tags`.

Vocabularies are closed sets in code (`CONTACT_TYPES`, `CONTACT_STATUSES`,
`TEMPERATURES` in `packages/core/src/contacts.ts`) and text in the database:
the API rejects values outside the list; adding one is a code review, not a
migration.

**Address and lead.** A contact has no address column. The address shown on
a contact is the property of the **newest lead whose `primary_contact_id` is
the contact**. Creating or editing a contact with an address creates (or
updates) that property + lead (`status 'new'`, `source` = the contact's
source or `contacts`). This keeps the dialer, the inbound lookup and the
lead activity timeline working unchanged — they already navigate lead →
contact → phone.

**Activity matching.** Calls and texts are matched to a contact three ways,
because the schema links them three ways: `calls.contact_id` /
`conversations.contact_id`; the contact's leads (`calls.lead_id` /
`conversations.lead_id`); and the contact's numbers against
`calls.to_number` / `calls.from_number` / `conversations.their_number`. A
number shared by two contacts credits both.

## 2. Permissions

Additive in `packages/core/src/rbac.ts`:

| Permission | rep | manager | admin/owner |
|---|---|---|---|
| `contacts.read` | ✓ | ✓ | ✓ |
| `contacts.write` | ✓ | ✓ | ✓ |
| `contacts.delete` (delete/restore) | | ✓ | ✓ |
| `contacts.import` | | ✓ | ✓ |
| `contacts.export` | | ✓ | ✓ |

Bulk SMS uses the existing `messages.send` (rep and up). A dial list uses
`contacts.write`: the campaign it creates is owned by the caller, so a rep
can build one without `campaigns.manage`.

## 3. API

Every route is under `/v1`, authenticated by the shared preHandler, and
org-scoped from the AuthContext. Every write is audited. All 404s are
org-blind (a contact in another org is "not found").

### ContactDto

```
{ id, display_name, type, status, email, company, tags: string[], source, notes,
  temperature, temperature_score, temperature_locked, last_activity_at,
  assigned_user_id, assigned_user_name,
  phones: [{ id, phone_e164, label, is_primary }], primary_phone,
  address: { line1, city, state, postal_code } | null,
  lead_id, lead_status, created_at, updated_at, deleted_at }
```

### `GET /v1/contacts` (contacts.read)

Query: `q` (ILIKE over name, email, company, notes, tags; plus a phone-digit
match when `q` contains ≥3 digits; LIKE metacharacters escaped), `type`,
`status`, `temperature`, `tag`, `user_id` (assigned), `has_phone=true|false`,
`include_deleted=true`, `sort=recent|name|temperature|created` (default
`recent` = `last_activity_at DESC NULLS LAST, created_at DESC`), `limit`
(50, max 200), `offset`. An empty query value means "not set".

Response: `{ contacts: ContactDto[], total, counts: { by_type, by_status,
by_temperature }, limit, offset }`. Counts are for the current filter set.

### `POST /v1/contacts` (contacts.write)

Body: `{ display_name (1..160), type = 'seller', status?, phone? (raw),
phones?: [{ phone, label?, is_primary? }], email?, company?, tags?, source?,
notes?, assigned_user_id?, address?: { line1, city, state, postal_code },
merge?: boolean }`. At least one phone or email is required
(`400 phone_or_email_required`); an un-normalizable phone is
`400 invalid_phone` naming it; `assigned_user_id` must be a member of the
org (`400 invalid_user`). Phones are normalized to E.164; exactly one is
primary (the flagged one, else the first).

If any phone already belongs to a live contact in the org: `409
{ error: 'duplicate_phone', contact_id, phone }` — unless `merge: true`, in
which case empty fields on the existing contact are filled, tags unioned,
missing phones added (never made primary when one exists), an address lands
only if the contact has no lead yet, and the reply is `200 { contact,
merged: true }` (audit `contact.merged`). Otherwise `201 { contact }`
(audit `contact.created`). A new contact is scored immediately, because its
numbers may already have call history.

### `GET /v1/contacts/:id` (contacts.read)

`{ contact, activity: [{ kind: 'call'|'sms', id, at, direction, status,
duration_seconds, body, disposition_label, user_name }] }` — the newest 25
across calls and texts matched as in §1. For a call `body` is the
disposition note; for a text it is the message body. Deleted contacts are
still readable (the DTO carries `deleted_at`).

### `PATCH /v1/contacts/:id` (contacts.write)

Any POST field. `phones`/`phone` replace the phone list wholesale (a list
that would leave the contact with no phone and no email is refused;
duplicates against other live contacts are `409 duplicate_phone`).
`address` writes onto the newest lead's property (or creates one).
`temperature` sets the bucket **and** `temperature_locked = true`;
`temperature_locked: false` unlocks and hands the bucket back to the
formula. `email: ""` clears the email. A status change, an unlock or a
phone change rescores inline. Audit `contact.updated` with `changed` keys
(and the status from/to when it changed). `400 empty_update` when nothing
was given.

### `DELETE /v1/contacts/:id` (contacts.delete)

Soft delete → `204`; already-deleted is also `204`. Audit `contact.deleted`.
Restore via bulk.

### `POST /v1/contacts/bulk` (contacts.write; `delete`/`restore` need contacts.delete)

`{ ids: uuid[] (1..500), action: 'delete'|'restore'|'set_status'|'set_type'|
'add_tag'|'remove_tag'|'assign', value?: string|null }` → `{ affected }`.
`set_status`/`set_type` validate `value` against the vocabulary; tag actions
need a non-empty tag; `assign` takes a member's id or `null`. One audit row
`contacts.bulk` `{ action, value, requested, count }`. `set_status` queues a
targeted rescore of the affected contacts.

### `POST /v1/contacts/bulk/message` (messages.send)

`{ ids: uuid[] (1..200), body?: string, template_id?: uuid, media_urls?:
string[] }` — exactly one of `body`/`template_id` (or media only). Each
contact with a primary phone is sent through `sendMessage`, the same path as
`POST /v1/messages`: suppression, quiet hours, from-number choice, queueing
and the `message.create` audit all apply per message. In `body` the merge
fields `{first_name}`, `{name}`, `{address}`, `{city}`, `{rep_name}` are
replaced (unknown braces are left alone). A template renders its own
`{{variables}}` as usual. Nothing throws per contact; the reply is
`{ sent, skipped: [{ id, reason, message? }] }` with reasons `not_found`,
`no_phone`, `suppressed` (status `dnc` or the suppression list),
`quiet_hours` (once the org window refuses one send, the rest are skipped
without trying), `error`. Audit `contacts.bulk_message`.

### `POST /v1/contacts/bulk/dial-list` (contacts.write)

`{ ids: uuid[] (1..500), name?: string }` → `201 { campaign_id,
campaign_name, enrolled, skipped: [{ id, reason }] }`. Builds a **power-mode
campaign** (docs/dialers.md §4 — the rep presses Next, one lead at a time,
nothing auto-dials) through the existing campaigns service
(`createCampaign` → status `active` → `attachLeads`), owned by the caller.
Every eligible contact gets a lead if it has none (`status 'new'`, `source
'contacts'`, assigned to the contact's rep); contacts are skipped with
`not_found`, `no_phone` or `dnc`. The default name is
`Dial list YYYY-MM-DD HH:MM · <rep>`; a taken name gets ` (2)`, ` (3)`… The
rep then starts a session on it from the Campaigns page
(`POST /v1/dial-sessions { campaign_id }`). Selection-time suppression,
calling windows and attempt caps are the campaign's, unchanged.
`422 no_dialable_contacts` when nothing could be enrolled.

### `POST /v1/contacts/import` (contacts.import)

```
{ rows: Array<Record<string, string>> (1..1000),
  mapping: { display_name?, first_name?, last_name?, phone?, phone2?, email?,
             company?, address_line1?, city?, state?, postal_code?, tags?,
             notes?, status?, type? },      // values are column names in rows
  defaults: { type?, status?, tags?: string[], source?: string },
  dedupe: 'skip' | 'merge' | 'create' }     // default merge
```

→ `{ created, merged, skipped: [{ row, reason }] }` (`row` is 1-based).
Rows are processed in transactions of 100. Per row (`mapImportRow`, pure):
phones are normalized and invalid ones dropped; a row with no valid phone
and no valid email is skipped (`no_phone_or_email`), an all-blank row
`empty_row`; the name is `display_name`, else `first + last`, else company,
email, phone; `type`/`status` cells are matched to the vocabulary
(case/space-insensitive) and fall back to `defaults`; tags split on `, ; |`
and union `defaults.tags`; `source` defaults to `import`. Duplicate phones
against live contacts (and against earlier rows in the same file) are
skipped, merged (§3 merge rules) or created per `dedupe`. Created contacts
are rescored by a queued job. One audit row `contacts.import`.

### `GET /v1/contacts/export.csv` (contacts.export)

Same filters and sort as the list, capped at 10,000 rows. UTF-8 with BOM,
CRLF, formula injection neutralized (cells starting with `= + - @` or a tab
get a leading apostrophe — which means E.164 numbers export as `'+1614…`,
deliberately). Columns: `name, type, status, temperature, score,
primary_phone, other_phones, email, company, address, city, state,
postal_code, tags, assigned_rep, last_activity, created, id`. Audit
`contacts.export` with the count and filters.

### `POST /v1/contacts/:id/rescore` (contacts.write)

Recompute now → `{ contact }`.

## 4. Temperature

`scoreContactTemperature(signals)` in `services/contact-temperature.ts` is
pure and unit-tested (`test/contact-temperature.test.ts`). Signals are
gathered over the trailing **90 days**:

| Signal | Points |
|---|---|
| answered call | +15 each, cap 30 |
| inbound text (auto-replies excluded) | +12 each, cap 36 |
| positive disposition | +20 each, cap 40 |
| talk time | +1 per whole minute, cap 10 |
| status `appointment` / `offer` / `under_contract` | +25 |
| status `engaged` | +10 |
| any negative disposition | −30 (once) |
| status `dead` / `dnc` | score 0, full stop |
| inactivity | −1.5 per day beyond 7 quiet days |
| **AI seller read** (newest scored call) | **±20, see below** |

**The AI seller read** (docs/coaching.md) is the one signal that is about
intent rather than engagement. Answering the phone three times makes a
contact look hot on activity alone; needing to be out in sixty days is what
actually predicts a close, and only the model reading the transcript knows
it. So the newest **completed** score attributed to the contact contributes
`(motivation_score − 5) × 4 × bucket_confidence`, clamped to ±20:

| The model said | Points |
|---|---|
| `motivation_score` 10, confidence 1.0 | +20 |
| `motivation_score` 8, confidence 1.0 | +12 |
| `motivation_score` 5 (the rubric's "average") | 0 |
| `motivation_score` 10, confidence 0.25 | +5 |
| `motivation_score` 0, confidence 1.0 | −20 |
| bucket `wrong_number` or `unqualified` | −20, whatever the motivation |
| bucket `unknown`, or no score yet | 0 — no opinion, not a penalty |

Centred on 5 because that is the rubric's own neutral, and weighted by the
model's stated confidence so a hedged read moves the score less.

### The read bounds the band

Points alone were not enough, because the question this score answers is
**how likely is this to close**, and activity answers a different one.
Somebody who picks up every time, texts back and happily stays on the phone
scores **76 — hot — on chat alone**, whether they are a motivated seller or
a tire-kicker enjoying the attention. Subtracting a few points does not fix
that; it just makes them warm.

So when the model has read the call, it decides the band and activity only
moves the score inside it:

| The model said | Bound | Why |
|---|---|---|
| bucket `wrong_number` / `unqualified`, or play `drop` | **score 0** | There is no deal here, same as `dead` |
| bucket `unmotivated_*`, or play `walk_away` | **held in cold** (≤ 29) | They are not moving. Being fun to talk to is not a reason to be on a follow-up list |
| bucket `motivated_*` | **floored at warm** (≥ 30) | They told us they need out; a quiet fortnight should not bury them |
| bucket `unknown`, or no scored call | none | No opinion — the score is exactly what it always was |

**The human outranks the model, in both directions.** `dead` / `dnc` still
score 0, so the model cannot rescue a contact a rep has closed out. A
contact a rep has moved to `appointment` / `offer` / `under_contract` is
never capped cold or written off. And a floor never buries a rep's own
"not interested" — they were on the call.

`breakdown.seller_bound` records which of these applied, so the reason a
contact is where it is can be shown rather than guessed at.

Only the newest read counts: a seller who was lukewarm in March and
motivated last week is motivated, and a later call is how a contact leaves
a cold cap.

Clamp 0–100, round. Buckets: **hot ≥ 70**, **warm ≥ 30**, else cold. A
contact that has never had a call or text does not decay (there is nothing
to decay from). A locked contact keeps its bucket; its score and
`last_activity_at` still update.

Disposition polarity (`classifyDisposition`, slug + label, negative checked
first): negative = *not interested*, *wrong number*, *dnc* / *do not call*,
*dead*; positive = *interested*, *appointment*, *offer*, *motivated*,
*callback* / *call back*, *contract*. Everything else (no answer,
voicemail, follow up, other) is neutral.

`last_activity_at` = max(call `created_at`, message `created_at`) over the
matched activity; the first-ever score of a contact with nothing in the
window looks back across all time once, so old contacts are not left null.

### The sweep

Job `contact-temperature-sweep` (`worker/contact-temperature-sweep.ts`,
registered in `HANDLERS`). Two payload shapes:

- targeted `{ orgId, contactIds }` — queued by `POST /v1/contacts/bulk
  set_status` and by import for the contacts they touched;
- empty — the hourly sweep. Per org: contacts with a call or text in the
  last 2 hours (via `contact_id` / lead linkage — the indexed paths) plus up
  to 500 contacts whose score is missing or older than 12 hours, oldest
  first. Scores are recomputed, never incremented, so re-runs are free.

A score landing is itself a trigger: `worker/score-handlers.ts` calls
`enqueueContactRescore` the moment a call is scored, so a fresh seller read
reaches the temperature in seconds rather than waiting up to twelve hours
for the stale-contact pass. It is best effort — a temperature a few hours
stale is not worth failing a score that succeeded, and the sweep is the
backstop.

Scheduling reuses the existing hourly mechanism: `worker-main.ts` enqueues
it on boot and every hour with dedupe key `contact-temperature-sweep:<hour>`
(next to the cost and workflow sweeps), and the serverless
`GET /internal/tick` enqueues the same deduped job on every tick
(`scheduleContactTemperatureSweep`). Status edits, unlocks and phone
changes on `PATCH`, plus `POST /v1/contacts`, rescore inline.

## 5. Web

`/contacts` in `apps/web` is built against §3 by a separate change; the
contract above is what it consumes.

## 6. Documented assumptions

1. Duplicate detection is **by phone only**, among live (not soft-deleted)
   contacts in the org. Email is not a duplicate key: many sellers share a
   family address.
2. A soft-deleted contact's numbers are free to be claimed by a new contact;
   restoring the old one then yields two contacts on one number, which the
   activity matcher credits to both.
3. Merge never overwrites: only empty fields are filled. "Which value is
   right" is a person's call, made on the contact page.
4. The dial list is a **power** campaign because it is the only mode in
   which nothing dials without the rep pressing Next — a hand-picked list
   from a CRM page is a preview-dial use case. Progressive/parallel remain
   available by editing the campaign.
5. Bulk SMS is sequential and bounded at 200 per request; each message is a
   normal outbound message with its own suppression/quiet-hours check and
   audit row, so the compliance posture is exactly that of one-to-one texts
   (docs/sms.md §4–5).
6. The `recently active` half of the sweep does not join `contact_phones`
   against recent calls (no index supports it at scale); phone-only matches
   are picked up by the stale half within 12 hours, and any contact can be
   rescored on demand.
