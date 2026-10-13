import { schema, type DbLike } from '@talkr/db';

export interface AuditInput {
  orgId?: string | null;
  actorType: 'user' | 'system' | 'api_key' | 'provider';
  actorId?: string | null;
  action: string;
  objectType?: string;
  objectId?: string;
  metadata?: Record<string, unknown>;
  correlationId?: string | null;
}

export async function writeAudit(db: DbLike, input: AuditInput): Promise<void> {
  await db.insert(schema.auditLog).values({
    orgId: input.orgId ?? null,
    actorType: input.actorType,
    actorId: input.actorId ?? null,
    action: input.action,
    objectType: input.objectType,
    objectId: input.objectId,
    metadata: input.metadata ?? {},
    correlationId: input.correlationId ?? null,
  });
}
