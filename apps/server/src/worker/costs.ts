/**
 * Cost ledger extraction (docs/reporting.md §3.2). A periodic idempotent
 * sweep that reads what the write side already persisted — raw webhook
 * payloads carrying Twilio Price/PriceUnit, and calls whose price the
 * reconciliation job backfilled from the provider REST snapshot — and turns
 * them into provider_costs rows. It never touches apply-events or the
 * reconcile internals; idempotency is structural (unique provider/item/ref +
 * ON CONFLICT DO NOTHING), so re-running over the same data is a no-op.
 */

import { sql } from 'drizzle-orm';
import type { DbHandle } from '@talkr/db';
import type { HandlerDeps, JobHandler } from './handlers.js';

const DEFAULT_LOOKBACK_DAYS = 7;

export interface CostSweepResult {
  webhookRows: number;
  reconciledRows: number;
}

/**
 * Prices arrive as signed decimal strings (Twilio reports charges negative,
 * e.g. "-0.0085"); the ledger stores magnitude. Returns null for anything
 * that is not a finite number — absent prices must never become fake $0 rows.
 * The SQL sweep below enforces the same contract with its price regex; this
 * function is the unit-testable statement of that parsing rule.
 */
export function parsePriceMagnitude(price: unknown): string | null {
  if (typeof price !== 'string' && typeof price !== 'number') return null;
  if (typeof price === 'string' && price.trim() === '') return null; // Number('') is 0 — never a fake $0
  const n = Number(price);
  if (!Number.isFinite(n)) return null;
  return Math.abs(n).toFixed(6);
}

export async function sweepProviderCosts(
  dbh: DbHandle,
  opts: { lookbackDays?: number } = {},
): Promise<CostSweepResult> {
  const lookbackDays = Math.max(1, Math.floor(opts.lookbackDays ?? DEFAULT_LOOKBACK_DAYS));
  const lookback = sql`now() - make_interval(days => ${lookbackDays})`;

  // 1. Webhook-carried prices: one ledger row per priced leg SID, resolved to
  //    the internal call via call_legs first, then the parent provider id.
  //    Unresolvable SIDs are skipped (no org to scope them to) and retried on
  //    the next sweep once the call materializes.
  const webhookInsert = await dbh.db.execute(sql`
    WITH priced AS (
      SELECT DISTINCT ON (we.parsed ->> 'CallSid')
        we.id AS webhook_event_id,
        we.parsed ->> 'CallSid' AS provider_ref,
        we.parsed ->> 'Price' AS price,
        we.parsed ->> 'PriceUnit' AS price_unit,
        we.received_at
      FROM webhook_events we
      WHERE we.provider IN ('twilio', 'telnyx')
        AND we.parsed ->> 'Price' IS NOT NULL
        AND we.parsed ->> 'CallSid' IS NOT NULL
        AND we.received_at >= ${lookback}
      ORDER BY we.parsed ->> 'CallSid', we.received_at DESC
    ),
    resolved AS (
      SELECT p.*, c.id AS call_id, c.org_id,
             COALESCE(c.ended_at, c.created_at) AS occurred_at
      FROM priced p
      JOIN LATERAL (
        SELECT c.* FROM call_legs l JOIN calls c ON c.id = l.call_id
        WHERE l.provider_call_id = p.provider_ref
        UNION ALL
        SELECT c.* FROM calls c WHERE c.provider_call_id = p.provider_ref
        LIMIT 1
      ) c ON true
      WHERE (p.price ~ '^-?[0-9]+(\\.[0-9]+)?$')
    )
    INSERT INTO provider_costs
      (org_id, call_id, provider, item_type, amount, currency, provider_ref, occurred_at, raw)
    SELECT r.org_id, r.call_id, 'telnyx', 'call',
           abs(r.price::numeric), COALESCE(r.price_unit, 'USD'), r.provider_ref, r.occurred_at,
           jsonb_build_object('source', 'webhook', 'webhookEventId', r.webhook_event_id)
    FROM resolved r
    -- Rows written before the carrier label changed say 'twilio'; the
    -- conflict target alone would let the same leg in twice.
    WHERE NOT EXISTS (
      SELECT 1 FROM provider_costs pc WHERE pc.item_type = 'call' AND pc.provider_ref = r.provider_ref)
    ON CONFLICT (provider, item_type, provider_ref) DO NOTHING`);

  // 2. Reconciliation-backfilled prices: the reconcile job stores the truth
  //    leg's price on the call (pstn leg if present, else the parent). Emit
  //    the ledger row under that same leg SID so it collapses with any
  //    webhook-derived row for the same leg instead of double-counting.
  const reconciledInsert = await dbh.db.execute(sql`
    WITH priced_calls AS (
      SELECT c.id AS call_id, c.org_id,
             c.price_cents, COALESCE(c.price_currency, 'USD') AS currency,
             COALESCE(c.ended_at, c.created_at) AS occurred_at,
             COALESCE(
               (SELECT l.provider_call_id FROM call_legs l
                 WHERE l.call_id = c.id AND l.leg_role = 'pstn' LIMIT 1),
               c.provider_call_id
             ) AS provider_ref
      FROM calls c
      WHERE c.price_cents IS NOT NULL
        AND COALESCE(c.ended_at, c.created_at) >= ${lookback}
    )
    INSERT INTO provider_costs
      (org_id, call_id, provider, item_type, amount, currency, provider_ref, occurred_at, raw)
    SELECT p.org_id, p.call_id, 'telnyx', 'call',
           (p.price_cents::numeric / 100), p.currency, p.provider_ref, p.occurred_at,
           jsonb_build_object('source', 'reconciliation', 'priceCents', p.price_cents)
    FROM priced_calls p
    WHERE p.provider_ref IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM provider_costs pc WHERE pc.item_type = 'call' AND pc.provider_ref = p.provider_ref)
    ON CONFLICT (provider, item_type, provider_ref) DO NOTHING`);

  return {
    webhookRows: webhookInsert.rowCount ?? 0,
    reconciledRows: reconciledInsert.rowCount ?? 0,
  };
}

export const extractProviderCosts: JobHandler = async (deps: HandlerDeps, job) => {
  const { lookbackDays } = job.payload as { lookbackDays?: number };
  const result = await sweepProviderCosts(deps.dbh, { lookbackDays });
  deps.logger.info(
    { jobId: job.id, ...result },
    'provider cost sweep complete',
  );
};
