/**
 * Caller reputation (packages/core/src/reputation.ts): what each line looks
 * like to carriers, and the per-line rules enforced where calls and texts are
 * placed.
 *
 * Three sources, kept apart so the page is honest about which is which:
 *  - Talkr's own history (calls, call_events, messages): always available.
 *  - The carrier (Telnyx CNAM listing, 10DLC, Number Reputation): cached on
 *    the rows (migration 0023), refreshed at most daily unless an admin asks.
 *  - Registrations nobody has an API for (Free Caller Registry, CTIA Branded
 *    Calling ID): a checklist, marked manual.
 *
 * Enforcement reads only cached state and columns already on loaded rows, so a
 * carrier outage can never stop a call or a text; an unknown is never a refusal.
 */

import { and, eq, ne, sql } from 'drizzle-orm';
import {
  attestationShare,
  decideSmsGate,
  isPauseWarning,
  readNumberProtection,
  readSmsGate,
  reputationGrade,
  reputationWarnings,
  type AttestationLevel,
  type NumberHealthMetrics,
  type SmsGateDecision,
} from '@talkr/core';
import { schema, type DbLike } from '@talkr/db';
import {
  TelnyxReputation,
  numberAssignedToApprovedCampaign,
  type CnamListing,
  type NumberReputationResult,
  type TenDlcSnapshot,
} from '@talkr/provider-telnyx';
import type { Config } from '../config.js';
import { validTimezone } from './reports.js';

type NumberRow = typeof schema.phoneNumbers.$inferSelect;
type OrgRow = typeof schema.organizations.$inferSelect;

/** What the carrier lookups give us; the route builds it once per request. */
export interface ReputationCarrier {
  getCnam(providerNumberId: string): Promise<CnamListing>;
  setCnam(providerNumberId: string, listing: CnamListing): Promise<CnamListing>;
  tenDlc(): Promise<TenDlcSnapshot>;
  numberReputation(phoneE164: string): Promise<NumberReputationResult>;
}

/** Telnyx's reputation reads; with no carrier, lines show Talkr's own signals only. */
export function reputationCarrierFor(config: Config, providerName: string, fetchImpl?: typeof fetch): ReputationCarrier | null {
  if (providerName !== 'telnyx' || !config.TELNYX_API_KEY) return null;
  return new TelnyxReputation(config.TELNYX_API_KEY, fetchImpl);
}

export const CHECK_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export interface NumberCheck {
  checked_at: string;
  cnam: CnamListing | null;
  spam: NumberReputationResult | null;
  error?: string;
}

export interface OrgTenDlc extends Partial<TenDlcSnapshot> {
  checked_at: string;
  error?: string;
}

export const readNumberCheck = (rep: unknown): NumberCheck | null => (rep as { check?: NumberCheck } | null)?.check ?? null;
export const readTenDlc = (rep: unknown): OrgTenDlc | null => (rep as { ten_dlc?: OrgTenDlc } | null)?.ten_dlc ?? null;

const stale = (checkedAt: string | undefined, now: Date) => !checkedAt || now.getTime() - Date.parse(checkedAt) > CHECK_MAX_AGE_MS;

/** Is this line assigned to an approved campaign? null when no snapshot exists (unknown). */
export function tenDlcAssigned(orgReputation: unknown, phoneE164: string): boolean | null {
  const t = readTenDlc(orgReputation);
  if (!t?.campaigns || !t.assignments) return null;
  return numberAssignedToApprovedCampaign(t as TenDlcSnapshot, phoneE164);
}

// ---------------------------------------------------------------------------
// Carrier refresh
// ---------------------------------------------------------------------------

/**
 * Refresh the org's 10DLC snapshot and each active line's CNAM + spam check
 * when older than a day (or `force`). Failures are stored next to the last good
 * value rather than thrown: the page shows "couldn't reach the carrier".
 */
export async function refreshReputation(
  db: DbLike,
  carrier: ReputationCarrier | null,
  org: OrgRow,
  numbers: NumberRow[],
  opts: { force?: boolean; now?: Date } = {},
): Promise<void> {
  if (!carrier) return;
  const now = opts.now ?? new Date();
  const tenDlc = readTenDlc(org.reputation);
  if (opts.force || stale(tenDlc?.checked_at, now)) {
    let next: OrgTenDlc;
    try {
      next = { ...(await carrier.tenDlc()), checked_at: now.toISOString() };
    } catch (err) {
      next = { ...(tenDlc ?? {}), checked_at: now.toISOString(), error: (err as Error).message };
    }
    await db.execute(sql`UPDATE organizations SET reputation = reputation || jsonb_build_object('ten_dlc', ${JSON.stringify(next)}::jsonb) WHERE id = ${org.id}`);
    org.reputation = { ...(org.reputation as object), ten_dlc: next };
  }
  await Promise.all(
    numbers
      .filter((x) => x.status === 'active' && x.provider === 'telnyx' && x.providerNumberId)
      .filter((x) => opts.force || stale(readNumberCheck(x.reputation)?.checked_at, now))
      .map(async (x) => {
        const prev = readNumberCheck(x.reputation);
        const [cnam, spam] = await Promise.allSettled([carrier.getCnam(x.providerNumberId!), carrier.numberReputation(x.phoneE164)]);
        const errors = [cnam, spam].filter((r): r is PromiseRejectedResult => r.status === 'rejected').map((r) => (r.reason as Error).message);
        await saveNumberCheck(db, x, {
          checked_at: now.toISOString(),
          cnam: cnam.status === 'fulfilled' ? cnam.value : prev?.cnam ?? null,
          spam: spam.status === 'fulfilled' ? spam.value : prev?.spam ?? null,
          ...(errors.length ? { error: errors.join('; ') } : {}),
        });
      }),
  );
}

export async function saveNumberCheck(db: DbLike, row: NumberRow, check: NumberCheck): Promise<void> {
  await db.execute(sql`UPDATE phone_numbers SET reputation = reputation || jsonb_build_object('check', ${JSON.stringify(check)}::jsonb) WHERE id = ${row.id}`);
  row.reputation = { ...(row.reputation as object), check };
}

// ---------------------------------------------------------------------------
// Talkr's own history
// ---------------------------------------------------------------------------

export interface NumberActivity extends NumberHealthMetrics {
  answer_rate_7d: number | null;
  answer_rate_prior_7d: number | null;
  avg_talk_seconds_7d: number | null;
  short_call_rate_7d: number | null;
  sms_failure_rate_7d: number | null;
  attestation_7d: ReturnType<typeof attestationShare>;
}

const n = (v: unknown) => Number(v ?? 0);

const emptyActivity = (): NumberActivity => ({
  calls_today: 0, calls_7d: 0, calls_prior_7d: 0, answered_7d: 0, answered_prior_7d: 0, short_calls_7d: 0,
  sms_sent_7d: 0, sms_failed_7d: 0, sms_error_codes: {},
  attestation_7d: attestationShare({}), attestation_30d: attestationShare({}),
  answer_rate_7d: null, answer_rate_prior_7d: null, avg_talk_seconds_7d: null, short_call_rate_7d: null, sms_failure_rate_7d: null,
});

/** Start of the org-local day containing `at`, as SQL. */
const dayStart = (at: string, tz: string) => sql`(date_trunc('day', ${at}::timestamptz AT TIME ZONE ${tz}) AT TIME ZONE ${tz})`;

/**
 * Outbound calls (by phone_number_id), outbound texts (by our_number) and
 * attestation reported on outbound call callbacks, per line. Three grouped
 * queries for the whole org, whatever the number of lines.
 */
export async function numberActivity(db: DbLike, org: OrgRow, numbers: NumberRow[], now: Date = new Date()): Promise<Map<string, NumberActivity>> {
  const out = new Map(numbers.map((x) => [x.id, emptyActivity()]));
  if (numbers.length === 0) return out;
  const tz = validTimezone((org.settings as { timezone?: string } | null)?.timezone);
  const ids = sql.join(numbers.map((x) => sql`${x.id}::uuid`), sql`, `);
  const at = now.toISOString();
  const week = sql`${at}::timestamptz - interval '7 days'`;

  const calls = await db.execute(sql`
    SELECT c.phone_number_id AS id,
      count(*) FILTER (WHERE c.created_at >= ${dayStart(at, tz)})::int AS today,
      count(*) FILTER (WHERE c.created_at >= ${week})::int AS calls_7d,
      count(*) FILTER (WHERE c.created_at < ${week})::int AS calls_prior,
      count(*) FILTER (WHERE c.created_at >= ${week} AND c.answered_at IS NOT NULL)::int AS answered_7d,
      count(*) FILTER (WHERE c.created_at < ${week} AND c.answered_at IS NOT NULL)::int AS answered_prior,
      count(*) FILTER (WHERE c.created_at >= ${week} AND c.answered_at IS NOT NULL AND c.ended_at IS NOT NULL
        AND EXTRACT(EPOCH FROM c.ended_at - c.answered_at) < 10)::int AS short_7d,
      avg(EXTRACT(EPOCH FROM c.ended_at - c.answered_at)) FILTER (WHERE c.created_at >= ${week}
        AND c.answered_at IS NOT NULL AND c.ended_at IS NOT NULL)::float8 AS avg_talk
    FROM calls c
    WHERE c.org_id = ${org.id} AND c.direction = 'outbound' AND c.phone_number_id IN (${ids})
      AND c.created_at >= ${at}::timestamptz - interval '14 days'
    GROUP BY c.phone_number_id`);
  for (const r of calls.rows as Array<Record<string, unknown>>) {
    const a = out.get(String(r.id));
    if (!a) continue;
    Object.assign(a, {
      calls_today: n(r.today), calls_7d: n(r.calls_7d), calls_prior_7d: n(r.calls_prior),
      answered_7d: n(r.answered_7d), answered_prior_7d: n(r.answered_prior), short_calls_7d: n(r.short_7d),
      avg_talk_seconds_7d: r.avg_talk == null ? null : Math.round(n(r.avg_talk)),
    });
  }

  // TeXML sends ShakenStirAttestation only "if shaken_stir_data is available"
  // (in practice on inbound calls with shaken_stir_enabled), so an empty share
  // here means "not reported", never "unsigned". call_events.payload already
  // holds every raw callback, so nothing new is stored for this.
  const att = await db.execute(sql`
    SELECT c.phone_number_id AS id, e.level, (c.created_at >= ${week}) AS recent, count(*)::int AS calls
    FROM calls c
    JOIN LATERAL (
      SELECT upper(ce.payload->>'ShakenStirAttestation') AS level
      FROM call_events ce WHERE ce.call_id = c.id AND ce.payload ? 'ShakenStirAttestation' LIMIT 1
    ) e ON true
    WHERE c.org_id = ${org.id} AND c.direction = 'outbound' AND c.phone_number_id IN (${ids})
      AND c.created_at >= ${at}::timestamptz - interval '30 days'
    GROUP BY 1, 2, 3`);
  const counts = new Map<string, { d7: Partial<Record<AttestationLevel, number>>; d30: Partial<Record<AttestationLevel, number>> }>();
  for (const r of att.rows as Array<Record<string, unknown>>) {
    const level = String(r.level) as AttestationLevel;
    if (!['A', 'B', 'C'].includes(level)) continue;
    const c = counts.get(String(r.id)) ?? { d7: {}, d30: {} };
    c.d30[level] = (c.d30[level] ?? 0) + n(r.calls);
    if (r.recent === true) c.d7[level] = (c.d7[level] ?? 0) + n(r.calls);
    counts.set(String(r.id), c);
  }

  const byPhone = new Map(numbers.map((x) => [x.phoneE164, x.id]));
  const phones = sql.join(numbers.map((x) => sql`${x.phoneE164}`), sql`, `);
  const sms = await db.execute(sql`
    SELECT cv.our_number AS phone, m.error_code,
      count(*)::int AS sent,
      count(*) FILTER (WHERE m.status IN ('failed', 'undelivered'))::int AS failed
    FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
    WHERE m.org_id = ${org.id} AND cv.our_number IN (${phones}) AND m.direction = 'outbound' AND NOT m.is_auto_reply
      AND m.failure_class <> 'suppressed' AND m.created_at >= ${week}
    GROUP BY cv.our_number, m.error_code`);
  for (const r of sms.rows as Array<Record<string, unknown>>) {
    const a = out.get(byPhone.get(String(r.phone)) ?? '');
    if (!a) continue;
    a.sms_sent_7d += n(r.sent);
    a.sms_failed_7d += n(r.failed);
    if (r.error_code && n(r.failed) > 0) a.sms_error_codes[String(r.error_code)] = (a.sms_error_codes[String(r.error_code)] ?? 0) + n(r.failed);
  }

  for (const [id, a] of out) {
    const c = counts.get(id);
    a.attestation_7d = attestationShare(c?.d7 ?? {});
    a.attestation_30d = attestationShare(c?.d30 ?? {});
    a.answer_rate_7d = a.calls_7d ? a.answered_7d / a.calls_7d : null;
    a.answer_rate_prior_7d = a.calls_prior_7d ? a.answered_prior_7d / a.calls_prior_7d : null;
    a.short_call_rate_7d = a.answered_7d ? a.short_calls_7d / a.answered_7d : null;
    a.sms_failure_rate_7d = a.sms_sent_7d ? a.sms_failed_7d / a.sms_sent_7d : null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// The per-line report
// ---------------------------------------------------------------------------

export function numberReport(number: NumberRow, org: OrgRow, activity: NumberActivity, carrierConnected: boolean) {
  const protection = readNumberProtection(number.reputation);
  const check = readNumberCheck(number.reputation);
  const tenDlc = readTenDlc(org.reputation);
  const assignment = tenDlc?.assignments?.[number.phoneE164] ?? null;
  const campaign = assignment?.campaign_id ? tenDlc?.campaigns?.find((c) => c.id === assignment.campaign_id) ?? null : null;
  const brand = campaign ? tenDlc?.brands?.find((b) => b.id === campaign.brand_id) ?? null : null;
  const assigned = tenDlcAssigned(org.reputation, number.phoneE164);
  const spam = check?.spam ?? null;
  const warnings = reputationWarnings({
    metrics: activity,
    sms_assigned: (number.capabilities as { sms?: boolean } | null)?.sms ? assigned : null,
    flagged_spam: spam?.status === 'ok' ? spam.spam_risk === 'high' : null,
    cnam_enabled: check?.cnam ? check.cnam.enabled : null,
    daily_call_cap: protection.daily_call_cap,
  });
  return {
    id: number.id,
    phone_e164: number.phoneE164,
    label: number.label,
    carrier: number.provider,
    status: number.status,
    grade: reputationGrade(warnings),
    warnings,
    paused: protection.pause_on_warning && warnings.some(isPauseWarning),
    attestation: {
      // Telnyx signs calls from a number you own A; a verified non-owned
      // caller ID gets B (developers.telnyx.com/docs/voice/stir-shaken/attestation-behavior).
      expected: number.status === 'active' ? ('A' as const) : null,
      observed_7d: activity.attestation_7d,
      observed_30d: activity.attestation_30d,
    },
    cnam: check?.cnam ?? null,
    spam,
    ten_dlc: {
      assigned,
      assignment_status: assignment?.status ?? null,
      campaign: campaign ? { id: campaign.id, usecase: campaign.usecase, status: campaign.status, campaign_status: campaign.campaign_status, approved: campaign.approved } : null,
      brand: brand ? { id: brand.id, name: brand.name, status: brand.status, identity_status: brand.identity_status } : null,
    },
    protection,
    metrics: {
      calls_today: activity.calls_today,
      calls_7d: activity.calls_7d,
      calls_prior_7d: activity.calls_prior_7d,
      answer_rate_7d: activity.answer_rate_7d,
      answer_rate_prior_7d: activity.answer_rate_prior_7d,
      avg_talk_seconds_7d: activity.avg_talk_seconds_7d,
      short_call_rate_7d: activity.short_call_rate_7d,
      sms_sent_7d: activity.sms_sent_7d,
      sms_failed_7d: activity.sms_failed_7d,
      sms_failure_rate_7d: activity.sms_failure_rate_7d,
      sms_error_codes: activity.sms_error_codes,
    },
    carrier_connected: carrierConnected,
    checked_at: check?.checked_at ?? null,
    check_error: check?.error ?? null,
  };
}

export type NumberReport = ReturnType<typeof numberReport>;

type ItemStatus = 'done' | 'partial' | 'pending' | 'todo' | 'manual' | 'unknown';

export interface ChecklistItem {
  key: string;
  title: string;
  status: ItemStatus;
  detail: string;
  action: string | null;
  link: string | null;
  /** No API: someone has to do it by hand, and Talkr cannot see whether they did. */
  manual: boolean;
}

/** The registrations that reduce spam labelling, each with its state and the next step. */
export function registrationChecklist(org: OrgRow, reports: NumberReport[], carrierConnected: boolean): ChecklistItem[] {
  const active = reports.filter((r) => r.status === 'active');
  const t = readTenDlc(org.reputation);
  const known = carrierConnected && Boolean(t?.brands);
  const cnamOn = active.filter((r) => r.cnam?.enabled).length;
  const cnamKnown = active.filter((r) => r.cnam).length;
  const goodBrand = t?.brands?.find((b) => b.status === 'OK');
  const firstBrand = t?.brands?.[0];
  const approved = t?.campaigns?.filter((c) => c.approved) ?? [];
  const firstCampaign = t?.campaigns?.[0];
  const texting = active.filter((r) => r.ten_dlc.assigned !== null);
  const assignedCount = texting.filter((r) => r.ten_dlc.assigned).length;
  const enrolled = active.some((r) => r.spam?.status === 'ok');
  const notChecked = 'Not checked yet.';
  return [
    {
      key: 'stir_shaken', title: 'STIR/SHAKEN attestation', status: active.length ? 'done' : 'todo', manual: false,
      detail: 'The carrier signs every call from a number you own on it with A (full) attestation. Calling out with a number you do not own drops to B.',
      action: null, link: 'https://developers.telnyx.com/docs/voice/stir-shaken/attestation-behavior',
    },
    {
      key: 'cnam', title: 'Caller name (CNAM)', manual: false,
      status: !carrierConnected || cnamKnown === 0 ? 'unknown' : cnamOn === active.length ? 'done' : cnamOn > 0 ? 'partial' : 'todo',
      detail: carrierConnected
        ? `${cnamOn} of ${active.length} lines list an outbound caller name. Carriers show it on landlines and some mobiles; changes take days to propagate.`
        : 'Connect the Telnyx carrier to read and set caller names.',
      action: cnamOn === active.length && active.length ? null : 'Set a business name (up to 15 letters, digits, spaces) on each line below.', link: null,
    },
    {
      key: 'free_caller_registry', title: 'Free Caller Registry', status: 'manual', manual: true,
      detail: 'One free form registers your outbound numbers with the analytics engines behind "Spam Likely" labels (Hiya, TNS, First Orion). There is no API, so Talkr cannot see whether it is done.',
      action: 'Register every line at freecallerregistry.com, and again whenever you add one.', link: 'https://freecallerregistry.com/',
    },
    {
      key: 'ten_dlc_brand', title: '10DLC brand', manual: false,
      status: !known ? 'unknown' : goodBrand ? 'done' : t?.brands?.some((b) => b.status === 'REGISTRATION_PENDING') ? 'pending' : 'todo',
      detail: !known ? notChecked
        : goodBrand ? `${goodBrand.name} is registered (identity ${goodBrand.identity_status ?? 'unknown'}).`
        : firstBrand ? `Brand ${firstBrand.name}: ${firstBrand.status ?? 'status unknown'}${firstBrand.failure_reasons ? ` (${firstBrand.failure_reasons})` : ''}.`
        : 'No 10DLC brand is registered. US carriers filter or block texts from unregistered local numbers.',
      action: goodBrand ? null : 'Register the business in the Telnyx portal: Messaging, 10DLC, Brands.', link: 'https://portal.telnyx.com/',
    },
    {
      key: 'ten_dlc_campaign', title: '10DLC campaign', manual: false,
      status: !known ? 'unknown' : approved.length ? 'done' : firstCampaign ? 'pending' : 'todo',
      detail: !known ? notChecked
        : approved.length ? `${approved.length} campaign${approved.length === 1 ? '' : 's'} provisioned on the carriers.`
        : firstCampaign ? `Campaign ${firstCampaign.campaign_status ?? 'submitted'}; texts deliver once it reaches MNO_PROVISIONED.`
        : 'No campaign yet. It describes what you text (use case, sample messages, opt-in) and takes days to weeks to approve.',
      action: approved.length ? null : 'Create a campaign under the brand in the Telnyx portal.', link: 'https://portal.telnyx.com/',
    },
    {
      key: 'ten_dlc_numbers', title: 'Lines on the campaign', manual: false,
      status: !known ? 'unknown' : texting.length > 0 && assignedCount === texting.length ? 'done' : assignedCount > 0 ? 'partial' : 'todo',
      detail: !known ? notChecked : `${assignedCount} of ${texting.length} texting lines are assigned to an approved campaign.`,
      action: texting.length > 0 && assignedCount === texting.length ? null : 'Assign each texting line to the approved campaign in the Telnyx portal.', link: 'https://portal.telnyx.com/',
    },
    {
      key: 'number_reputation', title: 'Spam-label monitoring', manual: !enrolled,
      status: !carrierConnected ? 'unknown' : enrolled ? 'done' : 'manual',
      detail: enrolled
        ? 'Telnyx Number Reputation reports each line\'s spam risk; Talkr reads the cached result (no per-check charge) at most daily or when you refresh.'
        : 'Telnyx Number Reputation checks whether analytics engines flag your lines. It needs an enterprise profile, a signed LOA and approval ($100/month plus $0.10 per scheduled check), set up in the portal.',
      action: enrolled ? null : 'Enable Number Reputation in the Telnyx portal and add your lines to it.', link: 'https://developers.telnyx.com/docs/number-reputation/overview',
    },
    {
      key: 'branded_calling', title: 'Branded calling', status: 'manual', manual: true,
      detail: 'Shows your verified business name (and logo on supported phones) on outbound calls. Paid, and needs an approved display identity. Talkr does not enroll you.',
      action: 'Apply through Telnyx Branded Calling or a CTIA Branded Calling ID partner (brandedcallingid.com).', link: 'https://telnyx.com/products/branded-calling',
    },
  ];
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

async function sentToday(db: DbLike, org: OrgRow, kind: 'calls' | 'sms', number: NumberRow): Promise<number> {
  const tz = validTimezone((org.settings as { timezone?: string } | null)?.timezone);
  const start = dayStart(new Date().toISOString(), tz);
  const r = kind === 'calls'
    ? await db.execute(sql`SELECT count(*)::int AS n FROM calls WHERE phone_number_id = ${number.id} AND direction = 'outbound' AND created_at >= ${start}`)
    : await db.execute(sql`SELECT count(*)::int AS n FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
        WHERE cv.org_id = ${org.id} AND cv.our_number = ${number.phoneE164} AND m.direction = 'outbound' AND NOT m.is_auto_reply
          AND m.failure_class <> 'suppressed' AND m.created_at >= ${start}`);
  return n((r.rows[0] as { n?: number } | undefined)?.n);
}

/**
 * Why an outbound call from this line must not be placed, or null. Costs no
 * query for a line with no protection set (the default).
 */
export async function callRefusal(db: DbLike, orgId: string, number: NumberRow): Promise<string | null> {
  const p = readNumberProtection(number.reputation);
  if (p.daily_call_cap === null && !p.pause_on_warning) return null;
  const org = (await db.select().from(schema.organizations).where(eq(schema.organizations.id, orgId)).limit(1))[0]!;
  if (p.daily_call_cap !== null && (await sentToday(db, org, 'calls', number)) >= p.daily_call_cap) {
    return `${number.phoneE164} reached its daily cap of ${p.daily_call_cap} outbound calls. Call from another line, or raise the cap under Settings, Phone numbers, Reputation.`;
  }
  if (p.pause_on_warning) {
    const report = numberReport(number, org, (await numberActivity(db, org, [number])).get(number.id)!, true);
    if (report.paused) {
      return `${number.phoneE164} is resting: ${report.warnings.find(isPauseWarning)!.message} Turn off "pause on warning" for this line to override.`;
    }
  }
  return null;
}

/** The daily text cap, then the 10DLC gate, for a send from `fromE164`. */
export async function smsDecision(db: DbLike, org: OrgRow, fromE164: string, toE164: string): Promise<SmsGateDecision> {
  const number = (
    await db.select().from(schema.phoneNumbers)
      .where(and(eq(schema.phoneNumbers.orgId, org.id), eq(schema.phoneNumbers.phoneE164, fromE164), ne(schema.phoneNumbers.status, 'released')))
      .limit(1)
  )[0];
  const cap = number ? readNumberProtection(number.reputation).daily_sms_cap : null;
  if (number && cap !== null && (await sentToday(db, org, 'sms', number)) >= cap) {
    return { action: 'block', reason: `${fromE164} reached its daily cap of ${cap} texts. Send from another line, or raise the cap under Settings, Phone numbers, Reputation.` };
  }
  const t = readTenDlc(org.reputation);
  const decision = decideSmsGate({
    mode: readSmsGate(org.reputation),
    toE164,
    numberAssigned: tenDlcAssigned(org.reputation, fromE164),
    orgHasApprovedCampaign: Boolean(t?.campaigns?.some((c) => c.approved)),
  });
  // The snapshot is a cache: say how old it is, so a line assigned since then gets re-checked instead of worked around.
  if (decision.action === 'allow') return decision;
  return { ...decision, reason: `${decision.reason} (registration last checked ${t?.checked_at?.slice(0, 16).replace('T', ' ') ?? 'never'} UTC; refresh under Settings, Phone numbers, Caller reputation).` };
}
