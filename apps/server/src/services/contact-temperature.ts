/**
 * Contact temperature (docs/contacts.md §4): a 0–100 score over the last 90
 * days of calls and texts, bucketed hot/warm/cold. The scorer itself is pure
 * (`scoreContactTemperature`) so the formula is unit-tested without a
 * database; the gatherers below turn rows into signals, in batches, so the
 * hourly sweep scans each org's recent calls once per batch rather than once
 * per contact.
 *
 * Activity is not the whole story, so it is not the whole score: the newest
 * AI seller read for the contact (docs/coaching.md — the Price x Motivation
 * grid Claude fills in from the transcript) moves it up or down. Answering
 * the phone a lot is engagement; saying you need to be out in sixty days is
 * intent, and only the second one predicts a close.
 *
 * Activity is matched to a contact three ways, because the schema links it
 * three ways: `calls.contact_id` / `conversations.contact_id`, the contact's
 * leads (`calls.lead_id` / `conversations.lead_id`), and the contact's phone
 * numbers against `calls.to_number` / `calls.from_number` /
 * `conversations.their_number`. Every query is org-scoped.
 */

import { and, desc, eq, gte, inArray, isNull, or, sql } from 'drizzle-orm';
import type { Temperature } from '@talkr/core';
import { schema, type DbLike } from '@talkr/db';

export const TEMPERATURE_WINDOW_DAYS = 90;
export const TEMPERATURE_HOT_MIN = 70;
export const TEMPERATURE_WARM_MIN = 30;
/** Decay starts after this many quiet days. */
export const TEMPERATURE_GRACE_DAYS = 7;
export const TEMPERATURE_DECAY_PER_DAY = 1.5;
/**
 * How far the AI seller read can move a score either way. Deliberately under
 * the activity caps: a great call should make a contact warm on its own, and
 * should need corroboration to make one hot.
 */
export const TEMPERATURE_SELLER_MAX = 20;
/** The highest a contact the model has written off is allowed to score. */
export const TEMPERATURE_COLD_MAX = TEMPERATURE_WARM_MIN - 1;
/** The rubric's neutral motivation: 5 of 10 is "average", so it scores zero. */
const SELLER_MOTIVATION_NEUTRAL = 5;
/** Each point of motivation away from neutral, before confidence weighting. */
const SELLER_MOTIVATION_WEIGHT = 4;
/** Buckets that say "this is not a seller at all", whatever the motivation. */
const SELLER_DISQUALIFYING = new Set(['wrong_number', 'unqualified']);
/** Buckets that say "they are not moving": the tire-kicker, however chatty. */
const SELLER_UNMOTIVATED = new Set(['unmotivated_priced_right', 'unmotivated_priced_high']);
/** Buckets that say "they need to sell". */
const SELLER_MOTIVATED = new Set(['motivated_priced_right', 'motivated_priced_high']);
/** The model's own verdict that more time here is wasted. */
const PLAY_WRITE_OFF = new Set(['drop']);
const PLAY_WALK_AWAY = new Set(['walk_away']);
/** A status a rep set that means this deal is live, whatever a call read like. */
const STATUS_ADVANCED = new Set(['appointment', 'offer', 'under_contract']);

export interface TemperatureSignals {
  inbound_sms: number;
  outbound_sms: number;
  calls_total: number;
  calls_answered: number;
  talk_seconds: number;
  positive_dispositions: number;
  negative_dispositions: number;
  /** contacts.status (docs/contacts.md vocabulary). */
  status: string;
  /** Whole days since the last call or text; null when there has never been one. */
  days_since_last_activity: number | null;
  /**
   * The newest completed AI seller read in the window, from `call_scores`.
   * Null throughout when no call of theirs has been scored — the score then
   * reads exactly as it did before this signal existed.
   */
  seller_motivation: number | null;
  /** 0–1. A hedged read moves the score less than a confident one. */
  seller_confidence: number | null;
  /** The Price x Motivation bucket (@talkr/core SELLER_BUCKETS). */
  seller_bucket: string | null;
  /** The play the grid prescribed (@talkr/core RECOMMENDED_PLAYS). */
  seller_play: string | null;
}

export interface TemperatureBreakdown {
  answered_calls: number;
  inbound_sms: number;
  positive_dispositions: number;
  talk_time: number;
  status: number;
  negative_dispositions: number;
  seller_read: number;
  decay: number;
  /**
   * Which bound the seller read put on the total, if any. `written_off` and
   * `capped_cold` are how a chatty contact the model does not rate stays off
   * the follow-up list; `floored_warm` is how a motivated one that has gone
   * quiet stays on it.
   */
  seller_bound: 'none' | 'written_off' | 'capped_cold' | 'floored_warm';
}

export interface TemperatureScore {
  score: number;
  temperature: Temperature;
  breakdown: TemperatureBreakdown;
}

export function temperatureBucket(score: number): Temperature {
  if (score >= TEMPERATURE_HOT_MIN) return 'hot';
  if (score >= TEMPERATURE_WARM_MIN) return 'warm';
  return 'cold';
}

/**
 * The formula, in two parts.
 *
 * **Activity** is points, each capped so no single channel can make a contact
 * hot on its own; a status a rep set by hand outranks activity; a negative
 * disposition costs 30 once (not per occurrence — one "not interested" is the
 * information); dead/dnc are 0 whatever else happened; and everything decays
 * 1.5 points a day after a week of silence.
 *
 * **The seller read** then bounds that total, because the question this score
 * answers is "how likely is this to close", and activity alone answers a
 * different one. Somebody who picks up every time, texts back and keeps a rep
 * on the phone scores 76 on chat alone — hot — whether they are a motivated
 * seller or a tire-kicker enjoying the attention. So when the model has read
 * the call it decides the band and activity only moves the score inside it:
 * a seller it wrote off cannot be warm however talkative they are, and one it
 * read as motivated does not quietly decay off the list.
 *
 * The human always outranks the model, in both directions: `dead` / `dnc`
 * stays 0, a rep who has moved the deal to appointment/offer/under contract
 * cannot be capped cold, and a rep's own negative disposition is not
 * overridden by a floor.
 */
export function scoreContactTemperature(s: TemperatureSignals): TemperatureScore {
  const breakdown: TemperatureBreakdown = {
    answered_calls: 0,
    inbound_sms: 0,
    positive_dispositions: 0,
    talk_time: 0,
    status: 0,
    negative_dispositions: 0,
    seller_read: 0,
    decay: 0,
    seller_bound: 'none',
  };
  if (s.status === 'dead' || s.status === 'dnc') {
    return { score: 0, temperature: 'cold', breakdown };
  }
  breakdown.answered_calls = Math.min(nonNegative(s.calls_answered) * 15, 30);
  breakdown.inbound_sms = Math.min(nonNegative(s.inbound_sms) * 12, 36);
  breakdown.positive_dispositions = Math.min(nonNegative(s.positive_dispositions) * 20, 40);
  breakdown.talk_time = Math.min(Math.floor(nonNegative(s.talk_seconds) / 60), 10);
  if (s.status === 'appointment' || s.status === 'offer' || s.status === 'under_contract') {
    breakdown.status = 25;
  } else if (s.status === 'engaged') {
    breakdown.status = 10;
  }
  if (nonNegative(s.negative_dispositions) > 0) breakdown.negative_dispositions = -30;
  breakdown.seller_read = sellerReadPoints(s);
  if (s.days_since_last_activity != null && s.days_since_last_activity > TEMPERATURE_GRACE_DAYS) {
    breakdown.decay = -TEMPERATURE_DECAY_PER_DAY * (s.days_since_last_activity - TEMPERATURE_GRACE_DAYS);
  }
  const raw =
    breakdown.answered_calls +
    breakdown.inbound_sms +
    breakdown.positive_dispositions +
    breakdown.talk_time +
    breakdown.status +
    breakdown.negative_dispositions +
    breakdown.seller_read +
    breakdown.decay;
  let score = Math.max(0, Math.min(100, Math.round(raw)));

  const bound = sellerBound(s);
  breakdown.seller_bound = bound;
  if (bound === 'written_off') score = 0;
  else if (bound === 'capped_cold') score = Math.min(score, TEMPERATURE_COLD_MAX);
  else if (bound === 'floored_warm') score = Math.max(score, TEMPERATURE_WARM_MIN);

  return { score, temperature: temperatureBucket(score), breakdown };
}

/**
 * What the AI made of the seller, as points.
 *
 * Motivation is scored against the rubric's own neutral (5 of 10), so a
 * lukewarm read is worth nothing rather than something, and weighted by the
 * model's stated confidence, so a read it hedged moves the score less. A
 * bucket of `wrong_number` or `unqualified` is the model saying this is not a
 * seller, which outranks whatever motivation it guessed at.
 *
 * No read, or an `unknown` bucket (the call was too short to tell), is no
 * opinion: zero, not a penalty.
 */
function sellerReadPoints(s: TemperatureSignals): number {
  if (s.seller_bucket && SELLER_DISQUALIFYING.has(s.seller_bucket)) return -TEMPERATURE_SELLER_MAX;
  if (s.seller_motivation == null || !Number.isFinite(s.seller_motivation)) return 0;
  // An absent confidence is taken at face value rather than as zero: the read
  // exists, the model just did not say how sure it was.
  const confidence =
    s.seller_confidence == null || !Number.isFinite(s.seller_confidence)
      ? 1
      : Math.max(0, Math.min(1, s.seller_confidence));
  const motivation = Math.max(0, Math.min(10, s.seller_motivation));
  const points = (motivation - SELLER_MOTIVATION_NEUTRAL) * SELLER_MOTIVATION_WEIGHT * confidence;
  return Math.round(Math.max(-TEMPERATURE_SELLER_MAX, Math.min(TEMPERATURE_SELLER_MAX, points)));
}

/**
 * Which bound the model's read puts on the score.
 *
 * `drop`, `wrong_number` and `unqualified` are the model saying there is no
 * deal here at all, so the contact scores 0 like a `dead` one. `walk_away`
 * and the unmotivated buckets are the model saying they are not moving: the
 * score is held in cold, which is the whole point — being fun to talk to is
 * not a reason to appear on a follow-up list. The motivated buckets floor the
 * score at warm, so a seller who told us they need out does not decay into
 * invisibility during a quiet fortnight.
 *
 * A rep can always overrule: a contact they have moved to appointment, offer
 * or under contract is never capped cold, and a floor never buries their own
 * "not interested".
 */
function sellerBound(s: TemperatureSignals): TemperatureBreakdown['seller_bound'] {
  const bucket = s.seller_bucket;
  const play = s.seller_play;
  const advanced = STATUS_ADVANCED.has(s.status);

  if (!advanced && ((bucket && SELLER_DISQUALIFYING.has(bucket)) || (play && PLAY_WRITE_OFF.has(play)))) {
    return 'written_off';
  }
  if (!advanced && ((bucket && SELLER_UNMOTIVATED.has(bucket)) || (play && PLAY_WALK_AWAY.has(play)))) {
    return 'capped_cold';
  }
  if (bucket && SELLER_MOTIVATED.has(bucket) && nonNegative(s.negative_dispositions) === 0) {
    return 'floored_warm';
  }
  return 'none';
}

function nonNegative(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

// ---------------------------------------------------------------------------
// Disposition polarity
// ---------------------------------------------------------------------------

const NEGATIVE_DISPOSITION = [/not\s*interested/, /wrong\s*number/, /\bdnc\b/, /do\s*not\s*call/, /\bdead\b/];
const POSITIVE_DISPOSITION = [/interested/, /appointment/, /offer/, /motivated/, /call\s*back/, /contract/];

/**
 * Which way a disposition points, from its slug and/or label. Negative
 * patterns are checked first because "not interested" contains "interested".
 * Null for the neutral ones (no answer, voicemail, other).
 */
export function classifyDisposition(
  ...parts: Array<string | null | undefined>
): 'positive' | 'negative' | null {
  const text = parts
    .filter((p): p is string => typeof p === 'string' && p.length > 0)
    .join(' ')
    .toLowerCase()
    .replace(/[_-]+/g, ' ');
  if (!text) return null;
  if (NEGATIVE_DISPOSITION.some((re) => re.test(text))) return 'negative';
  if (POSITIVE_DISPOSITION.some((re) => re.test(text))) return 'positive';
  return null;
}

export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / 86_400_000));
}

// ---------------------------------------------------------------------------
// Gathering signals from the database (batched)
// ---------------------------------------------------------------------------

export interface GatheredSignals {
  contactId: string;
  signals: TemperatureSignals;
  lastActivityAt: Date | null;
  temperatureLocked: boolean;
}

interface Tally {
  inbound_sms: number;
  outbound_sms: number;
  calls_total: number;
  calls_answered: number;
  talk_seconds: number;
  positive_dispositions: number;
  negative_dispositions: number;
  lastActivityAt: Date | null;
  /** The newest completed seller read, and the call time it came from. */
  seller: {
    motivation: number | null;
    confidence: number | null;
    bucket: string | null;
    play: string | null;
  } | null;
  sellerAt: Date | null;
}

function emptyTally(): Tally {
  return {
    inbound_sms: 0,
    outbound_sms: 0,
    calls_total: 0,
    calls_answered: 0,
    talk_seconds: 0,
    positive_dispositions: 0,
    negative_dispositions: 0,
    lastActivityAt: null,
    seller: null,
    sellerAt: null,
  };
}

function later(a: Date | null, b: Date | null | undefined): Date | null {
  if (!b) return a;
  if (!a) return b;
  return b.getTime() > a.getTime() ? b : a;
}

function addTo(map: Map<string, Set<string>>, key: string | null | undefined, contactId: string): void {
  if (!key) return;
  const set = map.get(key) ?? new Set<string>();
  set.add(contactId);
  map.set(key, set);
}

/**
 * Signals for a batch of contacts in one org, over the trailing window. Four
 * queries regardless of batch size. Contacts that are not in the org (or do
 * not exist) are simply absent from the result.
 */
export async function gatherContactSignals(
  db: DbLike,
  orgId: string,
  contactIds: string[],
  now: Date = new Date(),
): Promise<Map<string, GatheredSignals>> {
  const out = new Map<string, GatheredSignals>();
  if (contactIds.length === 0) return out;

  const contacts = await db
    .select({
      id: schema.contacts.id,
      status: schema.contacts.status,
      lastActivityAt: schema.contacts.lastActivityAt,
      temperatureUpdatedAt: schema.contacts.temperatureUpdatedAt,
      temperatureLocked: schema.contacts.temperatureLocked,
    })
    .from(schema.contacts)
    .where(and(eq(schema.contacts.orgId, orgId), inArray(schema.contacts.id, contactIds)));
  if (contacts.length === 0) return out;
  const ids = contacts.map((c) => c.id);

  const [phoneRows, leadRows] = await Promise.all([
    db
      .select({ contactId: schema.contactPhones.contactId, phoneE164: schema.contactPhones.phoneE164 })
      .from(schema.contactPhones)
      .where(and(eq(schema.contactPhones.orgId, orgId), inArray(schema.contactPhones.contactId, ids))),
    db
      .select({ id: schema.leads.id, contactId: schema.leads.primaryContactId })
      .from(schema.leads)
      .where(and(eq(schema.leads.orgId, orgId), inArray(schema.leads.primaryContactId, ids))),
  ]);

  // phone → contacts, lead → contacts. A number shared by two contacts credits
  // both; that is the honest answer when the data cannot tell them apart.
  const byPhone = new Map<string, Set<string>>();
  for (const p of phoneRows) addTo(byPhone, p.phoneE164, p.contactId);
  const byLead = new Map<string, Set<string>>();
  for (const l of leadRows) if (l.contactId) addTo(byLead, l.id, l.contactId);
  const idSet = new Set(ids);
  const phones = [...byPhone.keys()];
  const leadIds = [...byLead.keys()];

  const since = new Date(now.getTime() - TEMPERATURE_WINDOW_DAYS * 86_400_000);
  const tallies = new Map<string, Tally>(ids.map((id) => [id, emptyTally()]));

  const attribute = (
    direct: string | null,
    leadId: string | null,
    numbers: Array<string | null>,
  ): Set<string> => {
    const hit = new Set<string>();
    if (direct && idSet.has(direct)) hit.add(direct);
    if (leadId) for (const c of byLead.get(leadId) ?? []) hit.add(c);
    for (const n of numbers) if (n) for (const c of byPhone.get(n) ?? []) hit.add(c);
    return hit;
  };

  const callRows = await db
    .select({
      contactId: schema.calls.contactId,
      leadId: schema.calls.leadId,
      toNumber: schema.calls.toNumber,
      fromNumber: schema.calls.fromNumber,
      answeredAt: schema.calls.answeredAt,
      durationSeconds: schema.calls.durationSeconds,
      createdAt: schema.calls.createdAt,
      dispositionSlug: schema.callDispositions.slug,
      dispositionName: schema.callDispositions.name,
      // The AI seller read rides along on the call it was made from, so no
      // extra query and no second pass at attribution.
      scoreStatus: schema.callScores.status,
      seller: schema.callScores.seller,
    })
    .from(schema.calls)
    .leftJoin(schema.callDispositions, eq(schema.callDispositions.id, schema.calls.dispositionId))
    .leftJoin(schema.callScores, eq(schema.callScores.callId, schema.calls.id))
    .where(
      and(
        eq(schema.calls.orgId, orgId),
        gte(schema.calls.createdAt, since),
        or(
          inArray(schema.calls.contactId, ids),
          leadIds.length ? inArray(schema.calls.leadId, leadIds) : undefined,
          phones.length ? inArray(schema.calls.toNumber, phones) : undefined,
          phones.length ? inArray(schema.calls.fromNumber, phones) : undefined,
        ),
      ),
    );
  for (const call of callRows) {
    const polarity = classifyDisposition(call.dispositionSlug, call.dispositionName);
    for (const contactId of attribute(call.contactId, call.leadId, [call.toNumber, call.fromNumber])) {
      const t = tallies.get(contactId)!;
      t.calls_total += 1;
      if (call.answeredAt) {
        t.calls_answered += 1;
        t.talk_seconds += call.durationSeconds ?? 0;
      }
      if (polarity === 'positive') t.positive_dispositions += 1;
      if (polarity === 'negative') t.negative_dispositions += 1;
      t.lastActivityAt = later(t.lastActivityAt, call.createdAt);
      // Only the newest read counts: a seller who was lukewarm in March and
      // motivated last week is motivated.
      if (call.scoreStatus === 'completed' && (!t.sellerAt || call.createdAt > t.sellerAt)) {
        const read = readSeller(call.seller);
        if (read) {
          t.seller = read;
          t.sellerAt = call.createdAt;
        }
      }
    }
  }

  const messageRows = await db
    .select({
      direction: schema.messages.direction,
      isAutoReply: schema.messages.isAutoReply,
      createdAt: schema.messages.createdAt,
      contactId: schema.conversations.contactId,
      leadId: schema.conversations.leadId,
      theirNumber: schema.conversations.theirNumber,
    })
    .from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
    .where(
      and(
        eq(schema.messages.orgId, orgId),
        gte(schema.messages.createdAt, since),
        or(
          inArray(schema.conversations.contactId, ids),
          leadIds.length ? inArray(schema.conversations.leadId, leadIds) : undefined,
          phones.length ? inArray(schema.conversations.theirNumber, phones) : undefined,
        ),
      ),
    );
  for (const m of messageRows) {
    // Compliance auto-replies are the platform talking, not the rep.
    if (m.isAutoReply) continue;
    for (const contactId of attribute(m.contactId, m.leadId, [m.theirNumber])) {
      const t = tallies.get(contactId)!;
      if (m.direction === 'inbound') t.inbound_sms += 1;
      else t.outbound_sms += 1;
      t.lastActivityAt = later(t.lastActivityAt, m.createdAt);
    }
  }

  for (const c of contacts) {
    const t = tallies.get(c.id)!;
    let lastActivityAt = later(c.lastActivityAt, t.lastActivityAt);
    // First-ever score for a contact with nothing in the window: look past the
    // window once, so an old contact's last_activity_at is not left null.
    if (!lastActivityAt && !c.temperatureUpdatedAt) {
      lastActivityAt = await latestActivityAllTime(db, orgId, c.id, {
        leadIds: leadRows.filter((l) => l.contactId === c.id).map((l) => l.id),
        phones: phoneRows.filter((p) => p.contactId === c.id).map((p) => p.phoneE164),
      });
    }
    out.set(c.id, {
      contactId: c.id,
      temperatureLocked: c.temperatureLocked,
      lastActivityAt,
      signals: {
        inbound_sms: t.inbound_sms,
        outbound_sms: t.outbound_sms,
        calls_total: t.calls_total,
        calls_answered: t.calls_answered,
        talk_seconds: t.talk_seconds,
        positive_dispositions: t.positive_dispositions,
        negative_dispositions: t.negative_dispositions,
        status: c.status,
        days_since_last_activity: lastActivityAt ? daysBetween(lastActivityAt, now) : null,
        seller_motivation: t.seller?.motivation ?? null,
        seller_confidence: t.seller?.confidence ?? null,
        seller_bucket: t.seller?.bucket ?? null,
        seller_play: t.seller?.play ?? null,
      },
    });
  }
  return out;
}

/**
 * The three fields the temperature cares about, out of the stored seller
 * jsonb. Defensive on purpose: the column is model output that has been
 * through zod once, but a row written by an older schema (or a failed score
 * that still wrote `{}`) must not throw the whole sweep.
 */
function readSeller(value: unknown): Tally['seller'] {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  const motivation = typeof v.motivation_score === 'number' ? v.motivation_score : null;
  const confidence = typeof v.bucket_confidence === 'number' ? v.bucket_confidence : null;
  const bucket = typeof v.bucket === 'string' ? v.bucket : null;
  const play = typeof v.recommended_play === 'string' ? v.recommended_play : null;
  if (motivation == null && bucket == null && play == null) return null;
  return { motivation, confidence, bucket, play };
}

async function latestActivityAllTime(
  db: DbLike,
  orgId: string,
  contactId: string,
  refs: { leadIds: string[]; phones: string[] },
): Promise<Date | null> {
  const [call] = await db
    .select({ at: schema.calls.createdAt })
    .from(schema.calls)
    .where(
      and(
        eq(schema.calls.orgId, orgId),
        or(
          eq(schema.calls.contactId, contactId),
          refs.leadIds.length ? inArray(schema.calls.leadId, refs.leadIds) : undefined,
          refs.phones.length ? inArray(schema.calls.toNumber, refs.phones) : undefined,
          refs.phones.length ? inArray(schema.calls.fromNumber, refs.phones) : undefined,
        ),
      ),
    )
    .orderBy(desc(schema.calls.createdAt))
    .limit(1);
  const [message] = await db
    .select({ at: schema.messages.createdAt })
    .from(schema.messages)
    .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
    .where(
      and(
        eq(schema.messages.orgId, orgId),
        eq(schema.messages.isAutoReply, false),
        or(
          eq(schema.conversations.contactId, contactId),
          refs.leadIds.length ? inArray(schema.conversations.leadId, refs.leadIds) : undefined,
          refs.phones.length ? inArray(schema.conversations.theirNumber, refs.phones) : undefined,
        ),
      ),
    )
    .orderBy(desc(schema.messages.createdAt))
    .limit(1);
  return later(call?.at ?? null, message?.at ?? null);
}

// ---------------------------------------------------------------------------
// Writing scores back
// ---------------------------------------------------------------------------

export type ContactRow = typeof schema.contacts.$inferSelect;

/**
 * Recompute and persist temperature for a batch of contacts in one org.
 * `last_activity_at` and the score are always refreshed; the hot/warm/cold
 * bucket is left alone while `temperature_locked` (a person decided).
 */
export async function rescoreContacts(
  db: DbLike,
  orgId: string,
  contactIds: string[],
  now: Date = new Date(),
): Promise<ContactRow[]> {
  const gathered = await gatherContactSignals(db, orgId, contactIds, now);
  const updated: ContactRow[] = [];
  for (const g of gathered.values()) {
    const result = scoreContactTemperature(g.signals);
    const patch: Partial<typeof schema.contacts.$inferInsert> = {
      temperatureScore: result.score,
      temperatureUpdatedAt: now,
      lastActivityAt: g.lastActivityAt,
    };
    if (!g.temperatureLocked) patch.temperature = result.temperature;
    const [row] = await db
      .update(schema.contacts)
      .set(patch)
      .where(and(eq(schema.contacts.id, g.contactId), eq(schema.contacts.orgId, orgId)))
      .returning();
    if (row) updated.push(row);
  }
  return updated;
}

/** One contact, inline (POST /v1/contacts/:id/rescore, status edits). */
export async function rescoreContact(
  db: DbLike,
  orgId: string,
  contactId: string,
  now: Date = new Date(),
): Promise<ContactRow | null> {
  const rows = await rescoreContacts(db, orgId, [contactId], now);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Sweep candidates (worker/contact-temperature-sweep)
// ---------------------------------------------------------------------------

/** Contacts whose score has never been computed or is older than `staleBefore`. */
export async function staleContactIds(
  db: DbLike,
  orgId: string,
  staleBefore: Date,
  limit: number,
): Promise<string[]> {
  const rows = await db
    .select({ id: schema.contacts.id })
    .from(schema.contacts)
    .where(
      and(
        eq(schema.contacts.orgId, orgId),
        isNull(schema.contacts.deletedAt),
        or(
          isNull(schema.contacts.temperatureUpdatedAt),
          sql`${schema.contacts.temperatureUpdatedAt} < ${staleBefore}`,
        ),
      ),
    )
    .orderBy(sql`${schema.contacts.temperatureUpdatedAt} ASC NULLS FIRST`)
    .limit(limit);
  return rows.map((r) => r.id);
}

/**
 * Contacts with a call or text since `since`, by direct linkage and by lead
 * (the paths that are indexed). Phone-only matches are picked up by the
 * stale pass instead — that is the price of not scanning contact_phones
 * against every recent call.
 */
export async function recentlyActiveContactIds(db: DbLike, orgId: string, since: Date): Promise<string[]> {
  const result = await db.execute(sql`
    SELECT DISTINCT contact_id FROM (
      SELECT k.contact_id
        FROM calls k
       WHERE k.org_id = ${orgId} AND k.created_at >= ${since} AND k.contact_id IS NOT NULL
      UNION ALL
      SELECT l.primary_contact_id AS contact_id
        FROM calls k JOIN leads l ON l.id = k.lead_id
       WHERE k.org_id = ${orgId} AND k.created_at >= ${since} AND l.primary_contact_id IS NOT NULL
      UNION ALL
      SELECT cv.contact_id
        FROM messages m JOIN conversations cv ON cv.id = m.conversation_id
       WHERE m.org_id = ${orgId} AND m.created_at >= ${since} AND cv.contact_id IS NOT NULL
      UNION ALL
      SELECT l.primary_contact_id AS contact_id
        FROM messages m
        JOIN conversations cv ON cv.id = m.conversation_id
        JOIN leads l ON l.id = cv.lead_id
       WHERE m.org_id = ${orgId} AND m.created_at >= ${since} AND l.primary_contact_id IS NOT NULL
    ) recent
    WHERE contact_id IS NOT NULL`);
  return (result.rows as Array<{ contact_id: string }>).map((r) => r.contact_id);
}
