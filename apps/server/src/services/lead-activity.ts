/**
 * Everything that has happened to one lead, in one list.
 *
 * The dialer's Lead tab (design 1c) shows a seller's property beside a single
 * timeline — calls, texts, dispositions, tasks and the speed-to-lead
 * milestones — so a rep picking up a lead cold can read the last week in ten
 * seconds. Each of those already exists in its own table; nothing is stored
 * twice. This merges them at read time and caps the result, because a lead
 * that has been worked for a year still only needs its recent past on screen.
 */

import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { schema, type DbLike } from '@talkr/db';
import { buildLeadCard, type LeadCard } from './dial-sessions.js';

export type ActivityKind = 'call' | 'message' | 'task' | 'milestone';

export interface ActivityEvent {
  /** Stable across reads: `<kind>:<source row id>` (milestones use the field). */
  id: string;
  kind: ActivityKind;
  /** ISO timestamp the event is sorted on. */
  at: string;
  /** One line: "Outbound call · answered", "Text received", "Task due". */
  title: string;
  /** Optional second line: the note, the message body, the task title. */
  detail: string | null;
  /** The teammate who did it, when one did. Null for the seller's actions. */
  actor: string | null;
  /** Kind-specific extras the UI may render (duration, disposition, status). */
  meta: Record<string, string | number | boolean | null>;
}

export interface LeadActivity {
  card: LeadCard;
  assigned_user: { id: string; display_name: string } | null;
  received_at: string | null;
  open_tasks: number;
  timeline: ActivityEvent[];
}

const DEFAULT_LIMIT = 50;

function iso(d: Date | string | null | undefined): string | null {
  if (!d) return null;
  return typeof d === 'string' ? d : d.toISOString();
}

/** First ~90 chars of a text, on a word boundary, for a timeline row. */
function excerpt(body: string, max = 90): string {
  const one = body.replace(/\s+/g, ' ').trim();
  if (one.length <= max) return one;
  const cut = one.slice(0, max);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), 40))}…`;
}

function callTitle(c: typeof schema.calls.$inferSelect): string {
  const dir = c.direction === 'inbound' ? 'Inbound' : 'Outbound';
  if (c.answeredAt) return `${dir} call · answered`;
  if (c.status === 'no_answer' || c.status === 'busy') return `${dir} call · ${c.status.replace('_', ' ')}`;
  if (c.status === 'completed' || c.status === 'failed' || c.status === 'canceled') return `${dir} call · ${c.status}`;
  return `${dir} call · ${c.status.replace(/_/g, ' ')}`;
}

/**
 * The lead, its card, and its merged timeline — or null when the lead is not
 * in this org. Org scoping is on every query, not just the first: a message
 * or task row can only be reached through a lead that already passed it.
 */
export async function leadActivity(
  db: DbLike,
  orgId: string,
  leadId: string,
  opts: { limit?: number } = {},
): Promise<LeadActivity | null> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), 200);

  const card = await buildLeadCard(db, orgId, leadId);
  if (!card) return null;

  const lead = (
    await db
      .select()
      .from(schema.leads)
      .where(and(eq(schema.leads.id, leadId), eq(schema.leads.orgId, orgId)))
      .limit(1)
  )[0]!;

  // Every source, newest first, each already capped so a busy lead cannot
  // pull thousands of rows to show fifty.
  const [calls, conversations, tasks] = await Promise.all([
    db
      .select()
      .from(schema.calls)
      .where(and(eq(schema.calls.orgId, orgId), eq(schema.calls.leadId, leadId)))
      .orderBy(desc(schema.calls.createdAt))
      .limit(limit),
    db
      .select({ id: schema.conversations.id })
      .from(schema.conversations)
      .where(and(eq(schema.conversations.orgId, orgId), eq(schema.conversations.leadId, leadId))),
    db
      .select()
      .from(schema.tasks)
      .where(and(eq(schema.tasks.orgId, orgId), eq(schema.tasks.leadId, leadId)))
      .orderBy(desc(schema.tasks.createdAt))
      .limit(limit),
  ]);

  const conversationIds = conversations.map((c) => c.id);
  const messages = conversationIds.length
    ? await db
        .select()
        .from(schema.messages)
        .where(
          and(
            eq(schema.messages.orgId, orgId),
            inArray(schema.messages.conversationId, conversationIds),
          ),
        )
        .orderBy(desc(schema.messages.createdAt))
        .limit(limit)
    : [];

  // Names for everyone referenced, in one query. Reps show as themselves on
  // the timeline; the seller never has a user row and shows as no actor.
  const userIds = new Set<string>();
  if (lead.assignedUserId) userIds.add(lead.assignedUserId);
  for (const c of calls) if (c.userId) userIds.add(c.userId);
  for (const m of messages) if (m.createdBy) userIds.add(m.createdBy);
  for (const t of tasks) {
    if (t.assignedUserId) userIds.add(t.assignedUserId);
    if (t.createdBy) userIds.add(t.createdBy);
  }
  const users = userIds.size
    ? await db
        .select({ id: schema.users.id, displayName: schema.users.displayName })
        .from(schema.users)
        .where(inArray(schema.users.id, [...userIds]))
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.displayName]));

  const dispositionIds = [...new Set(calls.map((c) => c.dispositionId).filter((v): v is string => Boolean(v)))];
  const dispositions = dispositionIds.length
    ? await db
        .select({ id: schema.callDispositions.id, name: schema.callDispositions.name })
        .from(schema.callDispositions)
        .where(inArray(schema.callDispositions.id, dispositionIds))
    : [];
  const dispositionName = new Map(dispositions.map((d) => [d.id, d.name]));

  const events: ActivityEvent[] = [];

  for (const c of calls) {
    const raw = (c.raw ?? {}) as { dispositionNote?: string | null; voicemailLeft?: boolean };
    const disposition = c.dispositionId ? dispositionName.get(c.dispositionId) ?? null : null;
    events.push({
      id: `call:${c.id}`,
      kind: 'call',
      at: iso(c.initiatedAt ?? c.createdAt)!,
      title: callTitle(c),
      detail: raw.dispositionNote?.trim() || null,
      actor: c.userId ? nameOf.get(c.userId) ?? null : null,
      meta: {
        direction: c.direction,
        status: c.status,
        duration_seconds: c.durationSeconds ?? null,
        disposition,
        voicemail_left: raw.voicemailLeft === true,
        follow_up_at: iso(c.followUpAt),
      },
    });
  }

  for (const m of messages) {
    const media = Array.isArray(m.mediaUrls) ? (m.mediaUrls as unknown[]).length : 0;
    const body = m.body.trim();
    events.push({
      id: `message:${m.id}`,
      kind: 'message',
      at: iso(m.createdAt)!,
      title: m.direction === 'inbound' ? 'Text received' : m.isAutoReply ? 'Auto-reply sent' : 'Text sent',
      detail: body ? excerpt(body) : media ? `${media} photo${media === 1 ? '' : 's'}` : null,
      actor: m.createdBy ? nameOf.get(m.createdBy) ?? null : null,
      meta: {
        direction: m.direction,
        status: m.status,
        media_count: media,
        template_id: m.templateId ?? null,
      },
    });
  }

  for (const t of tasks) {
    const done = t.status === 'done';
    events.push({
      id: `task:${t.id}`,
      kind: 'task',
      // A completed task sits where it was completed; an open one where it
      // was created, so "what is still owed" reads in the order it was owed.
      at: iso(done ? t.completedAt ?? t.createdAt : t.createdAt)!,
      title: done ? 'Task completed' : t.status === 'canceled' ? 'Task canceled' : 'Task created',
      detail: t.title,
      actor: (t.createdBy && nameOf.get(t.createdBy)) ?? (t.assignedUserId && nameOf.get(t.assignedUserId)) ?? null,
      meta: {
        status: t.status,
        due_at: iso(t.dueAt),
        source: t.source,
        assigned_to: t.assignedUserId ? nameOf.get(t.assignedUserId) ?? null : null,
      },
    });
  }

  // Speed-to-lead ladder, straight from the first-write-wins columns. These
  // are the moments a manager asks about, so they get their own rows.
  const milestones: Array<[keyof typeof lead, string]> = [
    ['receivedAt', 'Lead received'],
    ['assignedAt', 'Assigned'],
    ['firstAttemptAt', 'First attempt'],
    ['firstAnswerAt', 'First answer'],
    ['firstConversationAt', 'First conversation'],
  ];
  for (const [field, title] of milestones) {
    const at = iso(lead[field] as Date | null);
    if (!at) continue;
    events.push({
      id: `milestone:${String(field)}`,
      kind: 'milestone',
      at,
      title,
      detail:
        field === 'assignedAt' && lead.assignedUserId
          ? `to ${nameOf.get(lead.assignedUserId) ?? 'a rep'}`
          : field === 'receivedAt' && lead.source
            ? `via ${lead.source}`
            : null,
      actor: null,
      meta: { field: String(field) },
    });
  }

  // Newest first. On a tie the concrete event outranks the milestone it
  // produced — "first attempt" is stamped from the call, so the call reads
  // first and the milestone underneath it, never the other way round.
  const rank: Record<ActivityKind, number> = { call: 0, message: 0, task: 0, milestone: 1 };
  events.sort(
    (a, b) =>
      (a.at < b.at ? 1 : a.at > b.at ? -1 : 0) ||
      rank[a.kind] - rank[b.kind] ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );

  const openTasks = (
    await db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.tasks)
      .where(
        and(eq(schema.tasks.orgId, orgId), eq(schema.tasks.leadId, leadId), eq(schema.tasks.status, 'open')),
      )
  )[0]?.n ?? 0;

  return {
    card,
    assigned_user: lead.assignedUserId
      ? { id: lead.assignedUserId, display_name: nameOf.get(lead.assignedUserId) ?? 'Unknown' }
      : null,
    received_at: iso(lead.receivedAt),
    open_tasks: openTasks,
    timeline: events.slice(0, limit),
  };
}
