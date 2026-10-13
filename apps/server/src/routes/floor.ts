/**
 * Live floor view snapshot (docs/reporting.md §4). Live updates ride the
 * existing SSE stream (`/v1/events/stream`); this endpoint is the state the
 * wallboard refetches when `call.updated` / `presence.updated` events arrive.
 */

import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app.js';
import { hasPermission } from '../auth.js';
import { floorSnapshot } from '../services/reports.js';

export function registerFloorRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { dbh } = deps;

  app.get('/v1/floor/state', async (req, reply) => {
    const ctx = req.authCtx;
    if (!ctx) return reply.code(401).send({ error: 'unauthenticated' });
    if (!hasPermission(ctx, 'floor.view')) {
      req.log.info({ userId: ctx.userId, permission: 'floor.view' }, 'permission denied');
      return reply.code(403).send({ error: 'forbidden', permission: 'floor.view' });
    }
    return floorSnapshot(dbh.db, ctx.orgId);
  });
}
