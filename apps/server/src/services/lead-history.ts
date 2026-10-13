/**
 * The lead's history as a short brief (docs/sequences.md §11-12): what the
 * agent step and the completion router read before deciding. One query per
 * table, bounded, newest first; rendered as plain lines so the same brief
 * serves both prompts and the run history.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, type DbLike } from '@talkr/db';

export interface LeadHistory {
  lead: { id: string; status: string; source: string | null; created_at: Date; assigned: boolean };
  contact: { name: string | null } | null;
  property: { address: string | null; city: string | null; state: string | null } | null;
  /** Newest first, at most `limit`. */
  messages: Array<{ direction: string; body: string; at: Date }>;
  calls: Array<{ direction: string; answered: boolean; duration_seconds: number | null; at: Date }>;
  /** Every sequence run for this lead, newest first, with the plan's name. */
  runs: Array<{ workflow_id: string; name: string; status: string; stopped_reason: string | null; at: Date }>;
  /** Open tasks for this lead. */
  open_tasks: number;
}

export async function loadLeadHistory(db: DbLike, leadId: string, limit = 12): Promise<LeadHistory | null> {
  const lead = (await db.select().from(schema.leads).where(eq(schema.leads.id, leadId)).limit(1))[0];
  if (!lead) return null;

  const [contact, property, conversations, calls, runs, openTasks] = await Promise.all([
    lead.primaryContactId
      ? db.select().from(schema.contacts).where(eq(schema.contacts.id, lead.primaryContactId)).limit(1)
      : Promise.resolve([]),
    lead.propertyId
      ? db.select().from(schema.properties).where(eq(schema.properties.id, lead.propertyId)).limit(1)
      : Promise.resolve([]),
    db.select({ id: schema.conversations.id }).from(schema.conversations).where(eq(schema.conversations.leadId, leadId)),
    db
      .select({
        direction: schema.calls.direction,
        answeredAt: schema.calls.answeredAt,
        durationSeconds: schema.calls.durationSeconds,
        at: schema.calls.createdAt,
      })
      .from(schema.calls)
      .where(eq(schema.calls.leadId, leadId))
      .orderBy(desc(schema.calls.createdAt))
      .limit(limit),
    db
      .select({
        workflowId: schema.workflowRuns.workflowId,
        name: schema.workflows.name,
        status: schema.workflowRuns.status,
        stoppedReason: schema.workflowRuns.stoppedReason,
        at: schema.workflowRuns.createdAt,
      })
      .from(schema.workflowRuns)
      .innerJoin(schema.workflows, eq(schema.workflows.id, schema.workflowRuns.workflowId))
      .where(and(eq(schema.workflowRuns.leadId, leadId), eq(schema.workflows.kind, 'sequence')))
      .orderBy(desc(schema.workflowRuns.createdAt))
      .limit(limit),
    db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.tasks)
      .where(and(eq(schema.tasks.leadId, leadId), eq(schema.tasks.status, 'open'))),
  ]);

  const conversationIds = conversations.map((c) => c.id);
  const messages =
    conversationIds.length === 0
      ? []
      : await db
          .select({ direction: schema.messages.direction, body: schema.messages.body, at: schema.messages.createdAt })
          .from(schema.messages)
          .where(inArray(schema.messages.conversationId, conversationIds))
          .orderBy(desc(schema.messages.createdAt))
          .limit(limit);

  return {
    lead: {
      id: lead.id,
      status: lead.status,
      source: lead.source,
      created_at: lead.createdAt,
      assigned: lead.assignedUserId != null,
    },
    contact: contact[0] ? { name: contact[0].displayName ?? null } : null,
    property: property[0]
      ? { address: property[0].addressLine1 ?? null, city: property[0].city ?? null, state: property[0].state ?? null }
      : null,
    messages: messages.map((m) => ({ direction: m.direction, body: m.body ?? '', at: m.at })),
    calls: calls.map((c) => ({
      direction: c.direction,
      answered: c.answeredAt != null,
      duration_seconds: c.durationSeconds ?? null,
      at: c.at,
    })),
    runs: runs.map((r) => ({
      workflow_id: r.workflowId,
      name: r.name,
      status: r.status,
      stopped_reason: r.stoppedReason,
      at: r.at,
    })),
    open_tasks: openTasks[0]?.n ?? 0,
  };
}

function ago(at: Date, now: Date): string {
  const days = Math.floor((now.getTime() - at.getTime()) / 86_400_000);
  if (days <= 0) return 'today';
  if (days === 1) return '1 day ago';
  return `${days} days ago`;
}

/** The brief as prompt lines. Bodies are clipped so one long text cannot crowd out the rest. */
export function renderLeadHistory(h: LeadHistory, now = new Date()): string {
  const lines: string[] = [];
  const who = h.contact?.name?.trim() || 'Unknown name';
  const where = h.property ? [h.property.address, h.property.city, h.property.state].filter(Boolean).join(', ') : '';
  lines.push(`Lead: ${who}${where ? ` at ${where}` : ''}`);
  lines.push(`Status: ${h.lead.status}; source: ${h.lead.source ?? 'unknown'}; received ${ago(h.lead.created_at, now)}; ${h.lead.assigned ? 'assigned to a rep' : 'unassigned'}; open tasks: ${h.open_tasks}`);

  const inbound = h.messages.filter((m) => m.direction === 'inbound').length;
  lines.push(`Texts (newest first, ${inbound} inbound of ${h.messages.length} shown):`);
  if (h.messages.length === 0) lines.push('  none');
  for (const m of h.messages) {
    lines.push(`  ${m.direction === 'inbound' ? 'THEM' : 'US'} (${ago(m.at, now)}): ${m.body.replace(/\s+/g, ' ').slice(0, 200)}`);
  }

  const answered = h.calls.filter((c) => c.answered).length;
  lines.push(`Calls (newest first, ${answered} answered of ${h.calls.length} shown):`);
  if (h.calls.length === 0) lines.push('  none');
  for (const c of h.calls) {
    lines.push(`  ${c.direction} ${c.answered ? `answered, ${c.duration_seconds ?? 0}s` : 'not answered'} (${ago(c.at, now)})`);
  }

  lines.push('Plans this lead has been through (newest first):');
  if (h.runs.length === 0) lines.push('  none');
  for (const r of h.runs) {
    lines.push(`  "${r.name}": ${r.status}${r.stopped_reason ? ` (${r.stopped_reason})` : ''}, enrolled ${ago(r.at, now)}`);
  }
  return lines.join('\n');
}
