/**
 * MMS attachments (docs/sms.md §10).
 *
 * POST /v1/media   — authenticated upload (base64 JSON, so the same fetch
 *                    helper and auth path as every other /v1 call work).
 * GET  /media/:id  — public, immutable fetch. The carrier pulls the bytes from
 *                    here at send time, so this route deliberately has no
 *                    auth: the id is an unguessable uuid and the row is
 *                    write-once.
 */

import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Permission } from '@talkr/core';
import { schema } from '@talkr/db';
import type { AppDeps } from '../app.js';
import { hasPermission } from '../auth.js';

/** What US carriers reliably deliver over MMS. Extension doubles as the URL suffix. */
const ALLOWED_TYPES = new Map<string, string>([
  ['image/jpeg', 'jpg'],
  ['image/png', 'png'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['video/mp4', 'mp4'],
  ['video/3gpp', '3gp'],
  ['application/pdf', 'pdf'],
  ['text/vcard', 'vcf'],
  ['text/x-vcard', 'vcf'],
  // Voicemail and menu greetings (call flows): what <Play> accepts on both carriers.
  ['audio/mpeg', 'mp3'],
  ['audio/wav', 'wav'],
  ['audio/x-wav', 'wav'],
]);

/**
 * Carrier MMS ceiling is 5 MB for the whole message and most handsets choke
 * well below that; 3 MB per file keeps a photo plus text under the line and
 * stays inside the serverless request limit once base64-inflated.
 */
const MAX_BYTES = 3 * 1024 * 1024;
const BODY_LIMIT = 6 * 1024 * 1024;

const uploadSchema = z.object({
  content_type: z.string().min(3).max(80),
  data_base64: z.string().min(1),
  filename: z.string().max(160).optional(),
});

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

/** "IMG 0042 (final).HEIC" → "img-0042-final.jpg": safe in a URL and a header. */
function safeFilename(raw: string | undefined, ext: string): string {
  const stem = (raw ?? '')
    .replace(/\.[a-z0-9]+$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  return `${stem || 'attachment'}.${ext}`;
}

export function registerMediaRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { dbh, config } = deps;

  app.post(
    '/v1/media',
    { preHandler: requirePermission('messages.send'), bodyLimit: BODY_LIMIT },
    async (req, reply) => {
      const ctx = req.authCtx!;
      const parsed = uploadSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
      }
      const contentType = parsed.data.content_type.toLowerCase().split(';')[0]!.trim();
      const ext = ALLOWED_TYPES.get(contentType);
      if (!ext) {
        return reply.code(415).send({
          error: 'unsupported_media_type',
          message: 'Send a JPEG, PNG, GIF, WebP, MP4, PDF, vCard, MP3 or WAV.',
        });
      }
      const data = Buffer.from(parsed.data.data_base64, 'base64');
      if (data.length === 0) {
        return reply.code(400).send({ error: 'invalid_body', message: 'empty file' });
      }
      if (data.length > MAX_BYTES) {
        return reply.code(413).send({
          error: 'too_large',
          message: 'Attachments must be 3 MB or smaller (carrier MMS limit).',
        });
      }
      const filename = safeFilename(parsed.data.filename, ext);
      const row = (
        await dbh.db
          .insert(schema.mediaAssets)
          .values({
            orgId: ctx.orgId,
            uploadedBy: ctx.userId,
            contentType,
            byteSize: data.length,
            filename,
            data,
          })
          .returning({ id: schema.mediaAssets.id })
      )[0]!;
      return reply.code(201).send({
        id: row.id,
        url: `${config.PUBLIC_BASE_URL}/media/${row.id}/${filename}`,
        content_type: contentType,
        byte_size: data.length,
      });
    },
  );

  const serve = async (req: FastifyRequest, reply: FastifyReply) => {
    const { id } = req.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) {
      return reply.code(404).send({ error: 'not_found' });
    }
    const row = (
      await dbh.db.select().from(schema.mediaAssets).where(eq(schema.mediaAssets.id, id)).limit(1)
    )[0];
    if (!row) return reply.code(404).send({ error: 'not_found' });
    return reply
      .header('content-type', row.contentType)
      .header('content-length', String(row.byteSize))
      .header('cache-control', 'public, max-age=31536000, immutable')
      .header('x-content-type-options', 'nosniff')
      .header('content-disposition', `inline; filename="${row.filename ?? 'attachment'}"`)
      .send(row.data);
  };
  app.get('/media/:id', serve);
  app.get('/media/:id/:name', serve);
}
