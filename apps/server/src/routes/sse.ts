/**
 * Server-Sent Events stream for realtime call state (docs/architecture.md §7).
 * Fan-out of the Postgres NOTIFY bus; reps see their own calls, managers the org.
 */

import type { FastifyInstance } from 'fastify';
import { subscribeBus, type BusEvent, type BusSubscription } from '@talkr/db';
import type { AppDeps } from '../app.js';
import { hasPermission } from '../auth.js';

interface SseClient {
  orgId: string;
  userId: string;
  seeOrg: boolean;
  write: (chunk: string) => void;
  end: () => void;
}

export function registerSseRoutes(app: FastifyInstance, deps: AppDeps): void {
  const clients = new Set<SseClient>();
  let subscription: BusSubscription | null = null;
  let subscribing: Promise<void> | null = null;

  async function ensureSubscribed(): Promise<void> {
    if (subscription) return;
    subscribing ??= subscribeBus(
      deps.config.DATABASE_URL,
      (event: BusEvent) => {
        const payload = `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`;
        for (const client of clients) {
          if (client.orgId !== event.orgId) continue;
          if (!client.seeOrg && event.userId && event.userId !== client.userId) continue;
          client.write(payload);
        }
      },
      (err) => deps.logger.warn({ err: err.message }, 'sse bus error'),
    ).then((sub) => {
      subscription = sub;
    });
    await subscribing;
  }

  app.get('/v1/events/stream', async (req, reply) => {
    const ctx = req.authCtx;
    if (!ctx) return reply.code(401).send({ error: 'unauthenticated' });
    await ensureSubscribed();

    // Written straight to the socket, so the CORS plugin's onSend hook never
    // runs for this response: without these two headers a browser on the web
    // app's origin refuses the stream and live call updates silently never
    // arrive. The token travels in the query, so no credentials header.
    // Same allowlist as the CORS plugin: the web app's origins and every
    // trusted partner's (CLOZR embeds the inbox and opens this stream too).
    const requestOrigin = req.headers.origin;
    const allowed = deps.partners
      ? await deps.partners.originAllowed(requestOrigin)
      : !!requestOrigin && deps.config.WEB_ORIGIN.includes(requestOrigin);
    const allowedOrigin = allowed && requestOrigin ? requestOrigin : deps.config.WEB_ORIGIN[0];
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
      'access-control-allow-origin': allowedOrigin,
      vary: 'origin',
    });
    reply.raw.write('retry: 3000\n\n');

    const client: SseClient = {
      orgId: ctx.orgId,
      userId: ctx.userId,
      seeOrg: hasPermission(ctx, 'calls.read.org'),
      write: (chunk) => reply.raw.write(chunk),
      end: () => reply.raw.end(),
    };
    clients.add(client);
    const heartbeat = setInterval(() => reply.raw.write(': hb\n\n'), 25_000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      clients.delete(client);
    });
    return reply;
  });

  app.addHook('onClose', async () => {
    for (const client of clients) client.end();
    clients.clear();
    await subscription?.close();
    subscription = null;
  });
}
