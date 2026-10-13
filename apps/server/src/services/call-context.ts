/**
 * In-call context (docs/scripts.md §3): the one read the dialer makes when a
 * number is typed, a call rings, or a call connects. Resolves the other party
 * from a phone, a contact, a lead or a call, then gathers — in a fixed,
 * bounded number of batched queries — the contact card, the lead and its
 * property, recent activity, the last AI call summary, open tasks, active
 * sequences, the campaign, and the scripts to read, rendered with merge
 * fields. Nothing here writes.
 */

import { and, desc, eq, inArray, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  actionsToSteps,
  firstWordOf,
  formatPhoneForSpeech,
  normalizePhone,
  renderScriptMergeFields,
  selectScripts,
  type ScriptMergeVars,
} from '@talkr/core';
import { schema, type DbLike } from '@talkr/db';
import type { AuthContext } from '../auth.js';
import { loadContactDto, type ContactDto } from './contacts.js';
import { toScriptDto, type ScriptDto } from './scripts.js';

export type CallContextSelector =
  | { phone: string }
  | { contact_id: string }
  | { lead_id: string }
  | { call_id: string };

export interface CallContextOptions {
  /** A campaign the caller already knows (the dial session's); wins over inference. */
  campaignId?: string | null;
}

export interface CallContextLead {
  id: string;
  status: string;
  source: string | null;
  assigned_user_id: string | null;
  assigned_user_name: string | null;
  external_item_id: string | null;
  crm_url: string | null;
  created_at: Date;
}

export interface CallContextProperty {
  id: string;
  line1: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
}

export interface CallContextActivity {
  kind: 'call' | 'sms' | 'task';
  id: string;
  at: Date;
  direction: string | null;
  status: string;
  duration_seconds: number | null;
  /** sms: the message text · task: the task title · call: null (see `note`). */
  body: string | null;
  disposition_label: string | null;
  /** call: the wrap-up note · task: the task note · sms: null. */
  note: string | null;
  user_name: string | null;
}

export interface CallContextSummary {
  call_id: string;
  at: Date;
  summary: string | null;
  next_steps: string[];
  objections: string[];
}

export interface CallContextTask {
  id: string;
  title: string;
  due_at: Date | null;
  assigned_user_name: string | null;
}

export interface CallContextSequence {
  /** The sequence (workflow) id — what enroll/unenroll address. */
  id: string;
  /** The run id, for the run table. */
  run_id: string;
  name: string;
  run_status: string;
  step: number;
  step_count: number;
  resume_at: Date | null;
}

export type RenderedScript = ScriptDto & { rendered_body: string };

export interface CallContext {
  phone_e164: string | null;
  contact: ContactDto | null;
  lead: CallContextLead | null;
  property: CallContextProperty | null;
  activity: CallContextActivity[];
  last_call_summary: CallContextSummary | null;
  open_tasks: CallContextTask[];
  sequences: CallContextSequence[];
  campaign: { id: string; name: string } | null;
  scripts: {
    primary: RenderedScript | null;
    alternatives: Array<{ id: string; title: string; category: string | null }>;
    rebuttals: RenderedScript[];
  };
  merge_fields: ScriptMergeVars;
  suggest_create: { phone_e164: string } | null;
}

export type CallContextResult =
  | { ok: true; context: CallContext }
  | { ok: false; status: 400 | 404; error: string; message: string };

const ACTIVITY_LIMIT = 10;
const OPEN_TASKS_LIMIT = 20;
const ACTIVE_RUN_STATUSES = ['pending', 'running', 'waiting'];

/** E.164 for a PSTN number; null for a browser identity or anything else. */
function dialable(value: string | null | undefined): string | null {
  if (!value) return null;
  const n = normalizePhone(value);
  return n.ok && !n.e164.startsWith('client:') ? n.e164 : null;
}

/**
 * Podio item link. The sync stores no link today, so this is the item-id
 * form; a `raw.link` written by a future sync wins when present.
 */
function crmUrl(lead: { externalItemId: string | null; raw: unknown }): string | null {
  if (!lead.externalItemId) return null;
  const raw = (lead.raw ?? {}) as { link?: unknown };
  if (typeof raw.link === 'string' && /^https:\/\/podio\.com\//.test(raw.link)) return raw.link;
  return `https://podio.com/x/y/item/${encodeURIComponent(lead.externalItemId)}`;
}

function notFound(what: string): CallContextResult {
  return { ok: false, status: 404, error: 'not_found', message: `${what} not found` };
}

export async function buildCallContext(
  db: DbLike,
  ctx: AuthContext,
  selector: CallContextSelector,
  opts: CallContextOptions = {},
): Promise<CallContextResult> {
  const orgId = ctx.orgId;
  let phoneE164: string | null = null;
  let contactId: string | null = null;
  let leadId: string | null = null;
  let campaignId: string | null = opts.campaignId ?? null;
  let currentCallId: string | null = null;

  // -- 1. Anchor: who is on the other end? ---------------------------------
  if ('phone' in selector) {
    const n = normalizePhone(selector.phone);
    if (!n.ok || n.e164.startsWith('client:')) {
      return { ok: false, status: 400, error: 'invalid_phone', message: 'not a dialable number' };
    }
    phoneE164 = n.e164;
  } else if ('call_id' in selector) {
    const call = (
      await db
        .select()
        .from(schema.calls)
        .where(and(eq(schema.calls.id, selector.call_id), eq(schema.calls.orgId, orgId)))
        .limit(1)
    )[0];
    if (!call) return notFound('call');
    currentCallId = call.id;
    phoneE164 = dialable(call.direction === 'inbound' ? call.fromNumber : call.toNumber);
    contactId = call.contactId;
    leadId = call.leadId;
    const raw = (call.raw ?? {}) as { campaignId?: unknown };
    if (!campaignId && typeof raw.campaignId === 'string' && raw.campaignId) campaignId = raw.campaignId;
  } else if ('lead_id' in selector) {
    const lead = (
      await db
        .select({ id: schema.leads.id, primaryContactId: schema.leads.primaryContactId })
        .from(schema.leads)
        .where(and(eq(schema.leads.id, selector.lead_id), eq(schema.leads.orgId, orgId)))
        .limit(1)
    )[0];
    if (!lead) return notFound('lead');
    leadId = lead.id;
    contactId = lead.primaryContactId;
  } else {
    contactId = selector.contact_id;
  }

  // A bare number → the live contact that owns it (oldest wins, like findPhoneOwners).
  if (!contactId && phoneE164) {
    const owner = (
      await db
        .select({ contactId: schema.contactPhones.contactId })
        .from(schema.contactPhones)
        .innerJoin(schema.contacts, eq(schema.contacts.id, schema.contactPhones.contactId))
        .where(
          and(
            eq(schema.contactPhones.orgId, orgId),
            eq(schema.contactPhones.phoneE164, phoneE164),
            isNull(schema.contacts.deletedAt),
          ),
        )
        .orderBy(schema.contacts.createdAt)
        .limit(1)
    )[0];
    contactId = owner?.contactId ?? null;
  }

  // -- 2. Contact card (the exact ContactDto the contacts API returns) ------
  const contact = contactId ? await loadContactDto(db, orgId, contactId) : null;
  if ('contact_id' in selector && !contact) return notFound('contact');
  if (contact) {
    if (!leadId) leadId = contact.lead_id;
    if (!phoneE164) phoneE164 = contact.primary_phone;
  }

  // -- 3. The lead (+ assignee, property) and every lead of the contact ----
  const leadRows =
    leadId || contact
      ? await db
          .select({ lead: schema.leads, assignedName: schema.users.displayName, property: schema.properties })
          .from(schema.leads)
          .leftJoin(schema.users, eq(schema.users.id, schema.leads.assignedUserId))
          .leftJoin(schema.properties, eq(schema.properties.id, schema.leads.propertyId))
          .where(
            and(
              eq(schema.leads.orgId, orgId),
              or(
                leadId ? eq(schema.leads.id, leadId) : undefined,
                contact ? eq(schema.leads.primaryContactId, contact.id) : undefined,
              ),
            ),
          )
          .orderBy(desc(schema.leads.createdAt))
      : [];
  const target = (leadId ? leadRows.find((r) => r.lead.id === leadId) : undefined) ?? leadRows[0] ?? null;
  const leadIds = [...new Set(leadRows.map((r) => r.lead.id))];
  const phones = [...new Set([...(contact?.phones.map((p) => p.phone_e164) ?? []), ...(phoneE164 ? [phoneE164] : [])])];
  const anchored = Boolean(contact || leadIds.length > 0 || phones.length > 0);

  // Calls that belong to this person: linked by contact, by lead, or by number.
  const callMatch = (): SQL | undefined =>
    and(
      or(
        contact ? eq(schema.calls.contactId, contact.id) : undefined,
        leadIds.length ? inArray(schema.calls.leadId, leadIds) : undefined,
        phones.length ? inArray(schema.calls.toNumber, phones) : undefined,
        phones.length ? inArray(schema.calls.fromNumber, phones) : undefined,
      ),
      // The call in progress is the present, not the history.
      currentCallId ? ne(schema.calls.id, currentCallId) : undefined,
    );

  // -- 4. Everything else, in one batch -------------------------------------
  const [calls, messages, doneTasks, openTasks, transcriptRows, runRows, campaignRows, scriptRows, orgRows] =
    await Promise.all([
      anchored
        ? db
            .select({
              id: schema.calls.id,
              createdAt: schema.calls.createdAt,
              initiatedAt: schema.calls.initiatedAt,
              direction: schema.calls.direction,
              status: schema.calls.status,
              durationSeconds: schema.calls.durationSeconds,
              dispositionNote: schema.calls.dispositionNote,
              userId: schema.calls.userId,
              dispositionName: schema.callDispositions.name,
            })
            .from(schema.calls)
            .leftJoin(schema.callDispositions, eq(schema.callDispositions.id, schema.calls.dispositionId))
            .where(and(eq(schema.calls.orgId, orgId), callMatch()))
            .orderBy(desc(schema.calls.createdAt))
            .limit(ACTIVITY_LIMIT)
        : Promise.resolve([]),
      anchored
        ? db
            .select({
              id: schema.messages.id,
              createdAt: schema.messages.createdAt,
              direction: schema.messages.direction,
              status: schema.messages.status,
              body: schema.messages.body,
              createdBy: schema.messages.createdBy,
              isAutoReply: schema.messages.isAutoReply,
            })
            .from(schema.messages)
            .innerJoin(schema.conversations, eq(schema.conversations.id, schema.messages.conversationId))
            .where(
              and(
                eq(schema.messages.orgId, orgId),
                or(
                  contact ? eq(schema.conversations.contactId, contact.id) : undefined,
                  leadIds.length ? inArray(schema.conversations.leadId, leadIds) : undefined,
                  phones.length ? inArray(schema.conversations.theirNumber, phones) : undefined,
                ),
              ),
            )
            .orderBy(desc(schema.messages.createdAt))
            .limit(ACTIVITY_LIMIT)
        : Promise.resolve([]),
      leadIds.length
        ? db
            .select()
            .from(schema.tasks)
            .where(
              and(eq(schema.tasks.orgId, orgId), inArray(schema.tasks.leadId, leadIds), eq(schema.tasks.status, 'done')),
            )
            .orderBy(desc(schema.tasks.completedAt), desc(schema.tasks.createdAt))
            .limit(ACTIVITY_LIMIT)
        : Promise.resolve([]),
      leadIds.length
        ? db
            .select()
            .from(schema.tasks)
            .where(
              and(eq(schema.tasks.orgId, orgId), inArray(schema.tasks.leadId, leadIds), eq(schema.tasks.status, 'open')),
            )
            .orderBy(sql`${schema.tasks.dueAt} ASC NULLS LAST`, schema.tasks.createdAt)
            .limit(OPEN_TASKS_LIMIT)
        : Promise.resolve([]),
      anchored
        ? db
            .select({
              callId: schema.transcripts.callId,
              summary: schema.transcripts.summary,
              ai: schema.transcripts.ai,
              callCreatedAt: schema.calls.createdAt,
              callInitiatedAt: schema.calls.initiatedAt,
            })
            .from(schema.transcripts)
            .innerJoin(schema.calls, eq(schema.calls.id, schema.transcripts.callId))
            .where(and(eq(schema.transcripts.orgId, orgId), eq(schema.transcripts.status, 'completed'), callMatch()))
            .orderBy(desc(schema.transcripts.createdAt))
            .limit(1)
        : Promise.resolve([]),
      leadIds.length
        ? db
            .select({
              run: schema.workflowRuns,
              workflowId: schema.workflows.id,
              name: schema.workflows.name,
              actions: schema.workflows.actions,
            })
            .from(schema.workflowRuns)
            .innerJoin(schema.workflows, eq(schema.workflows.id, schema.workflowRuns.workflowId))
            .where(
              and(
                eq(schema.workflowRuns.orgId, orgId),
                inArray(schema.workflowRuns.leadId, leadIds),
                inArray(schema.workflowRuns.status, ACTIVE_RUN_STATUSES),
                eq(schema.workflows.kind, 'sequence'),
              ),
            )
            .orderBy(desc(schema.workflowRuns.createdAt))
        : Promise.resolve([]),
      campaignId
        ? db
            .select({ id: schema.campaigns.id, name: schema.campaigns.name })
            .from(schema.campaigns)
            .where(and(eq(schema.campaigns.id, campaignId), eq(schema.campaigns.orgId, orgId)))
            .limit(1)
        : leadIds.length
          ? // No campaign named: the newest active campaign this lead is enrolled in.
            db
              .select({ id: schema.campaigns.id, name: schema.campaigns.name })
              .from(schema.campaignLeads)
              .innerJoin(schema.campaigns, eq(schema.campaigns.id, schema.campaignLeads.campaignId))
              .where(
                and(
                  eq(schema.campaignLeads.orgId, orgId),
                  inArray(schema.campaignLeads.leadId, leadIds),
                  eq(schema.campaigns.status, 'active'),
                  ne(schema.campaignLeads.status, 'removed'),
                ),
              )
              .orderBy(desc(schema.campaignLeads.createdAt))
              .limit(1)
          : Promise.resolve([]),
      db
        .select()
        .from(schema.scripts)
        .where(and(eq(schema.scripts.orgId, orgId), eq(schema.scripts.enabled, true)))
        .orderBy(schema.scripts.sortOrder, schema.scripts.title),
      db
        .select({ name: schema.organizations.name })
        .from(schema.organizations)
        .where(eq(schema.organizations.id, orgId))
        .limit(1),
    ]);

  // Names for everyone referenced, in one query.
  const userIds = new Set<string>();
  for (const c of calls) if (c.userId) userIds.add(c.userId);
  for (const m of messages) if (m.createdBy) userIds.add(m.createdBy);
  for (const t of [...doneTasks, ...openTasks]) {
    if (t.assignedUserId) userIds.add(t.assignedUserId);
    if (t.createdBy) userIds.add(t.createdBy);
  }
  const users = userIds.size
    ? await db
        .select({ id: schema.users.id, displayName: schema.users.displayName })
        .from(schema.users)
        .where(and(eq(schema.users.orgId, orgId), inArray(schema.users.id, [...userIds])))
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.displayName]));

  // -- 5. Assemble -----------------------------------------------------------
  const lead: CallContextLead | null = target
    ? {
        id: target.lead.id,
        status: target.lead.status,
        source: target.lead.source,
        assigned_user_id: target.lead.assignedUserId,
        assigned_user_name: target.assignedName ?? null,
        external_item_id: target.lead.externalItemId,
        crm_url: crmUrl(target.lead),
        created_at: target.lead.createdAt,
      }
    : null;
  const property: CallContextProperty | null = target?.property
    ? {
        id: target.property.id,
        line1: target.property.addressLine1,
        city: target.property.city,
        state: target.property.state,
        postal_code: target.property.postalCode,
      }
    : null;

  const activity: CallContextActivity[] = [
    ...calls.map((c) => ({
      kind: 'call' as const,
      id: c.id,
      at: c.initiatedAt ?? c.createdAt,
      direction: c.direction,
      status: c.status,
      duration_seconds: c.durationSeconds,
      body: null,
      disposition_label: c.dispositionName ?? null,
      note: c.dispositionNote?.trim() || null,
      user_name: c.userId ? (nameOf.get(c.userId) ?? null) : null,
    })),
    ...messages.map((m) => ({
      kind: 'sms' as const,
      id: m.id,
      at: m.createdAt,
      direction: m.direction,
      status: m.status,
      duration_seconds: null,
      body: m.body,
      disposition_label: null,
      note: null,
      user_name: m.createdBy ? (nameOf.get(m.createdBy) ?? null) : m.isAutoReply ? 'Auto-reply' : null,
    })),
    ...doneTasks.map((t) => ({
      kind: 'task' as const,
      id: t.id,
      at: t.completedAt ?? t.createdAt,
      direction: null,
      status: t.status,
      duration_seconds: null,
      body: t.title,
      disposition_label: null,
      note: t.note?.trim() || null,
      user_name:
        (t.assignedUserId && nameOf.get(t.assignedUserId)) || (t.createdBy && nameOf.get(t.createdBy)) || null,
    })),
  ];
  activity.sort((a, b) => b.at.getTime() - a.at.getTime());

  const transcript = transcriptRows[0];
  const ai = (transcript?.ai ?? {}) as { next_step?: unknown; objections?: unknown };
  const last_call_summary: CallContextSummary | null = transcript
    ? {
        call_id: transcript.callId,
        at: transcript.callInitiatedAt ?? transcript.callCreatedAt,
        summary: transcript.summary,
        next_steps: typeof ai.next_step === 'string' && ai.next_step.trim() ? [ai.next_step.trim()] : [],
        objections: Array.isArray(ai.objections) ? ai.objections.filter((o): o is string => typeof o === 'string') : [],
      }
    : null;

  const sequences: CallContextSequence[] = runRows.map((r) => {
    const steps = actionsToSteps(Array.isArray(r.actions) ? r.actions : []);
    const stepNumber = Math.min(r.run.currentActionIndex, Math.max(steps.length - 1, 0)) + 1;
    return {
      id: r.workflowId,
      run_id: r.run.id,
      name: r.name,
      run_status: r.run.status,
      step: stepNumber,
      step_count: steps.length,
      resume_at: r.run.resumeAt,
    };
  });

  const campaign = campaignRows[0] ?? null;

  const merge_fields: ScriptMergeVars = {
    first_name: firstWordOf(contact?.display_name),
    name: contact?.display_name?.trim() ?? '',
    address: property?.line1 ?? contact?.address?.line1 ?? '',
    city: property?.city ?? contact?.address?.city ?? '',
    state: property?.state ?? contact?.address?.state ?? '',
    postal_code: property?.postal_code ?? contact?.address?.postal_code ?? '',
    company: orgRows[0]?.name ?? '',
    rep_name: ctx.displayName,
    rep_first_name: firstWordOf(ctx.displayName),
    phone: formatPhoneForSpeech(phoneE164),
  };
  const render = (s: ScriptDto): RenderedScript => ({ ...s, rendered_body: renderScriptMergeFields(s.body, merge_fields) });
  const selection = selectScripts(scriptRows.map(toScriptDto), {
    campaignId: campaign?.id ?? null,
    contactType: contact?.type ?? null,
  });

  return {
    ok: true,
    context: {
      phone_e164: phoneE164,
      contact,
      lead,
      property,
      activity: activity.slice(0, ACTIVITY_LIMIT),
      last_call_summary,
      open_tasks: openTasks.map((t) => ({
        id: t.id,
        title: t.title,
        due_at: t.dueAt,
        assigned_user_name: t.assignedUserId ? (nameOf.get(t.assignedUserId) ?? null) : null,
      })),
      sequences,
      campaign,
      scripts: {
        primary: selection.primary ? render(selection.primary) : null,
        alternatives: selection.alternatives.map((s) => ({ id: s.id, title: s.title, category: s.category })),
        rebuttals: selection.rebuttals.map(render),
      },
      merge_fields,
      suggest_create: !contact && phoneE164 ? { phone_e164: phoneE164 } : null,
    },
  };
}
