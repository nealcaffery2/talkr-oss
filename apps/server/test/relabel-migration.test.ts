/**
 * Migration 0026 relabels rows stamped 'twilio' as 'telnyx'. The cost ledger is
 * the case that can go wrong: (provider, item_type, provider_ref) is unique, so
 * a leg already recorded under both labels must end up as one row, not fail
 * the migration.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { createTestContext, type TestContext } from './helpers.js';

const MIGRATION = fileURLToPath(new URL('../../../packages/db/migrations/0026_relabel_twilio_rows.sql', import.meta.url));

let ctx: TestContext;
beforeAll(async () => {
  ctx = await createTestContext();
});
afterAll(async () => ctx.close());

describe('0026 relabel', () => {
  it('relabels twilio rows and collapses a cost leg recorded under both labels', async () => {
    const { db, pool } = ctx.dbh;
    const [event] = await db
      .insert(schema.webhookEvents)
      .values({ provider: 'twilio', endpoint: 'voice-status', idempotencyKey: 'twilio:legacy-1', rawBody: '' })
      .returning();
    const cost = (provider: string, ref: string) => ({
      orgId: ctx.seed.orgId,
      provider,
      itemType: 'call',
      amount: '0.01',
      providerRef: ref,
      occurredAt: new Date(),
    });
    await db.insert(schema.providerCosts).values([cost('twilio', 'CA_both'), cost('telnyx', 'CA_both'), cost('twilio', 'CA_old')]);

    for (const statement of readFileSync(MIGRATION, 'utf8').split('--> statement-breakpoint')) {
      if (statement.trim()) await pool.query(statement);
    }

    const [after] = await db.select().from(schema.webhookEvents).where(eq(schema.webhookEvents.id, event!.id));
    expect(after!.provider).toBe('telnyx');
    const costs = await db.select().from(schema.providerCosts);
    expect(costs.map((c) => [c.provider, c.providerRef]).sort()).toEqual([
      ['telnyx', 'CA_both'],
      ['telnyx', 'CA_old'],
    ]);
  });
});
