/**
 * Cross-process realtime bus over Postgres LISTEN/NOTIFY.
 * The worker publishes call-state changes; API processes subscribe and fan
 * out to SSE clients. Payloads are compact (NOTIFY caps at ~8KB) — clients
 * re-fetch details over the API if they need more than the delta.
 */

import pg from 'pg';

export interface BusEvent {
  type: string;
  orgId: string;
  userId?: string;
  callId?: string;
  status?: string;
  data?: Record<string, unknown>;
}

const CHANNEL = 'talkr_events';

export async function publishBusEvent(pool: pg.Pool, event: BusEvent): Promise<void> {
  await pool.query(`SELECT pg_notify($1, $2)`, [CHANNEL, JSON.stringify(event)]);
}

export interface BusSubscription {
  close(): Promise<void>;
}

export async function subscribeBus(
  connectionString: string,
  onEvent: (event: BusEvent) => void,
  onError?: (err: Error) => void,
): Promise<BusSubscription> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  client.on('notification', (msg) => {
    if (msg.channel !== CHANNEL || !msg.payload) return;
    try {
      onEvent(JSON.parse(msg.payload) as BusEvent);
    } catch (err) {
      onError?.(err as Error);
    }
  });
  client.on('error', (err) => onError?.(err));
  await client.query(`LISTEN ${CHANNEL}`);
  return {
    close: async () => {
      try {
        await client.end();
      } catch {
        // already closed
      }
    },
  };
}
