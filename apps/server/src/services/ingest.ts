/**
 * Webhook ingestion (docs/telephony-events.md §1): raw persist → dedupe →
 * transactional enqueue → fast ack. No provider/CRM/AI calls on this path.
 */

import { sql } from 'drizzle-orm';
import { enqueueJob, schema, type Db } from '@talkr/db';

export interface IngestInput {
  provider: string;
  endpoint: string;
  idempotencyKey: string;
  signatureValid: boolean;
  headers: Record<string, unknown>;
  rawBody: string;
  /** Body params merged with our own query params (call id hints etc.). */
  parsed: Record<string, string>;
  providerObjectId?: string;
  providerEventType?: string;
  /** Enqueue the async processing job (false for rejected signatures). */
  enqueueProcessing?: boolean;
  /** Processing job type (default 'process-webhook'; SMS uses its own — docs/sms.md §3). */
  jobType?: string;
}

export interface IngestResult {
  webhookEventId: string;
  duplicate: boolean;
}

export async function ingestWebhook(db: Db, input: IngestInput): Promise<IngestResult> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .insert(schema.webhookEvents)
      .values({
        provider: input.provider,
        endpoint: input.endpoint,
        idempotencyKey: input.idempotencyKey,
        signatureValid: input.signatureValid,
        headers: input.headers,
        rawBody: input.rawBody,
        parsed: input.parsed,
        providerObjectId: input.providerObjectId,
        providerEventType: input.providerEventType,
        status: input.signatureValid ? 'received' : 'rejected',
      })
      .onConflictDoUpdate({
        target: schema.webhookEvents.idempotencyKey,
        set: { duplicateCount: sql`${schema.webhookEvents.duplicateCount} + 1` },
      })
      .returning({
        id: schema.webhookEvents.id,
        // xmax = 0 ⟺ the row was freshly inserted (not a conflict-update).
        inserted: sql<boolean>`(xmax = 0)`,
      });

    const row = rows[0];
    if (!row) throw new Error('ingest insert returned no row');

    if (row.inserted && input.signatureValid && input.enqueueProcessing !== false) {
      const jobType = input.jobType ?? 'process-webhook';
      await enqueueJob(tx, {
        jobType,
        payload: { webhookEventId: row.id },
        dedupeKey: `${jobType}:${row.id}`,
      });
    }
    // Duplicates don't rewrite the original row's lifecycle status;
    // duplicate_count carries the signal for the integrity dashboard.
    return { webhookEventId: row.id, duplicate: !row.inserted };
  });
}
