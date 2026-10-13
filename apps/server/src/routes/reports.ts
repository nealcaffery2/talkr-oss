/**
 * Reporting API (docs/reporting.md §2-3). Org-scoped, manager-gated
 * (`reports.view.org`). All endpoints take from/to local-date params in the
 * org timezone; invalid ranges are a 400, never a silent clamp.
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Permission } from '@talkr/core';
import type { AppDeps } from '../app.js';
import { hasPermission } from '../auth.js';
import {
  byDayReport,
  byRepReport,
  costsReport,
  orgTimezone,
  overviewReport,
  qualityReport,
  queuesReport,
  ReportRangeError,
  resolveRange,
  type ReportRange,
} from '../services/reports.js';

function requirePermission(permission: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = req.authCtx;
    if (!ctx) return reply.code(401).send({ error: 'unauthenticated' });
    if (!hasPermission(ctx, permission)) {
      req.log.info({ userId: ctx.userId, permission }, 'permission denied');
      return reply.code(403).send({ error: 'forbidden', permission });
    }
  };
}

export function registerReportRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { dbh } = deps;

  /** Resolve + validate the range or reply 400; returns null after replying. */
  async function rangeOr400(req: FastifyRequest, reply: FastifyReply): Promise<ReportRange | null> {
    const ctx = req.authCtx!;
    const { from, to } = req.query as { from?: string; to?: string };
    const timezone = await orgTimezone(dbh.db, ctx.orgId);
    try {
      return resolveRange({ from, to }, timezone);
    } catch (err) {
      if (err instanceof ReportRangeError) {
        await reply.code(400).send({ error: err.code, message: err.message });
        return null;
      }
      throw err;
    }
  }

  const gate = { preHandler: requirePermission('reports.view.org') };

  app.get('/v1/reports/overview', gate, async (req, reply) => {
    const range = await rangeOr400(req, reply);
    if (!range) return reply;
    return overviewReport(dbh.db, req.authCtx!.orgId, range);
  });

  app.get('/v1/reports/by-rep', gate, async (req, reply) => {
    const range = await rangeOr400(req, reply);
    if (!range) return reply;
    return byRepReport(dbh.db, req.authCtx!.orgId, range);
  });

  app.get('/v1/reports/by-day', gate, async (req, reply) => {
    const range = await rangeOr400(req, reply);
    if (!range) return reply;
    return byDayReport(dbh.db, req.authCtx!.orgId, range);
  });

  app.get('/v1/reports/queues', gate, async (req, reply) => {
    const range = await rangeOr400(req, reply);
    if (!range) return reply;
    return queuesReport(dbh.db, req.authCtx!.orgId, range);
  });

  app.get('/v1/reports/quality', gate, async (req, reply) => {
    const range = await rangeOr400(req, reply);
    if (!range) return reply;
    return qualityReport(dbh.db, req.authCtx!.orgId, range);
  });

  app.get('/v1/reports/costs', gate, async (req, reply) => {
    const range = await rangeOr400(req, reply);
    if (!range) return reply;
    return costsReport(dbh.db, req.authCtx!.orgId, range);
  });
}
