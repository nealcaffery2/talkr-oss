# Talkr Platform — Podio Integration

**Status:** living document. Podio is mission-critical today and a vendor risk long-term (niche product, now owned by Progress Software after the 2024 Citrix/ShareFile divestiture; actively maintained, no announced API EOL as of 2026-08). The design below treats Podio as *one* `CRMConnection` implementation so the blast radius of a Podio exit is the adapter, not the platform.

## 1. Posture

- **Our DB is the source of truth for communications.** Podio holds CRM truth (deal status, seller relationship); we hold communication truth (what calls/texts actually happened). Sync moves *summaries* of our truth into Podio and *lead/contact/property data* from Podio into us.
- **Never spam Podio.** One activity comment per completed call. Low-level telecom events stay in `call_events`. SMS thread sync (Phase 4) is batched/summarized per configurable rules.
- **Never overwrite silently.** Outbound field updates only touch fields the org has explicitly mapped `outbound`/`both`, and AI-suggested values (Phase 8) are *suggestions* requiring confirmation, not writes.

## 2. Auth

- OAuth 2 server-side flow for user-context operations; **app authentication** (app ID + token) for app-scoped workers — this matches how the Coach already talks to the Communications/Acquisitions apps.
- Tokens (access + refresh) are stored via the secret indirection described in security.md, refreshed proactively before expiry; refresh failures raise an `integration_degraded` audit event and surface on the data-integrity dashboard (stale-integration alarm), instead of failing silently.
- Rate limits (Podio: per-hour buckets, drastically lower for some endpoints) are respected by a token-bucket in the Podio client; 420/429 responses trigger backoff-and-retry via the job queue, never tight loops.

## 3. Field mapping

Admin-configured, stored in `crm_field_mappings`:

```
Podio org → workspace → app → field  ⇒  internal entity.field, direction, transform
```

Example seed mapping for a real-estate acquisitions app (validate against the live workspace during Phase 2 setup — do not trust this table blindly):

| Podio (Acquisitions app) | Internal | Direction |
|---|---|---|
| Seller phone(s) | `contact_phones.phone_e164` | inbound |
| Seller name | `contacts.display_name` | inbound |
| Property address | `properties.address_*` | inbound |
| Lead source | `leads.source` | inbound |
| Assigned acquisitions rep | `leads.assigned_user_id` (via user mapping table) | inbound |
| Status | `leads.status` | both (guarded) |
| Item created on | `leads.external_created_at` | inbound |

Phone numbers normalize to E.164 at the boundary; un-parseable numbers are kept raw in `leads.raw` and flagged, never dropped.

## 4. Webhooks (lead sync in)

- Register `item.create` / `item.update` / `item.delete` hooks per mapped app; answer Podio's `hook.verify` challenge; monitor hook health (Podio silently disables hooks after repeated failures — a periodic job re-validates and re-registers, and a dead hook raises an integrity alarm).
- Inbound Podio webhooks flow through the same ingestion pipeline as telecom webhooks: raw persist → dedupe (`podio:{hook_id}:{item_id}:{type}:{revision}`) → async processing. Podio webhook payloads are thin (IDs only); the worker fetches the full item via REST, then upserts lead/contact/property through the mapping layer.
- **Speed-to-lead starts here:** `item.create` on the Acquisitions app stamps `leads.received_at` on arrival (ingestion time) and `external_created_at` from the item — the delta is our webhook latency, monitored.

## 5. Call activity (sync out)

On `call.completed` + wrap-up (or wrap-up timeout with auto-disposition `No Answer`/`Voicemail` for unanswered calls), the `podio.sync-call-activity` job posts **one** comment to the linked item:

```
📞 Outbound call — 8m 42s
Rep: Riley · Disposition: Follow Up (follow-up 8/28)
Recording: <platform deep link>
[correlation: 018f… — invisible-to-humans marker for loop prevention]
```

Optionally (org setting) it also updates mapped fields (e.g. Status → "Contacted"). The job is idempotent via `jobs.dedupe_key = podio-activity:{call_id}` and records the created Podio comment ID on the call's `raw` for traceability.

## 6. Loop prevention & conflict handling

- Every outbound write carries our correlation marker; the inbound webhook worker drops changes whose revision was authored by our own API identity (revision `created_by` check + marker), so our writes never boomerang into sync updates.
- Inbound lead upserts compare Podio `item_revision_id`; stale webhooks (revision ≤ last synced) are no-ops.
- True conflicts (both sides changed a `both`-direction field since last sync) resolve **Podio-wins for CRM fields, platform-wins for communication fields**, and always log an audit event with both values.

## 7. Failure visibility

Podio sync failures are jobs — so they retry with backoff, dead-letter after exhaustion, and show up on the data-integrity dashboard (`crm sync failures`, `stale integrations`, `auth errors`). A call whose Podio activity never posted is *visible*, not silent: the calls list exposes `crm_sync_status` derived from the job record.

## 8. What we deliberately do not build

- No bulk rewriting of Podio history.
- No per-event Podio comments (ringing/answered/etc.).
- No storing of Podio credentials in the browser or extension — the Chrome extension (Phase 9) talks only to our API.
