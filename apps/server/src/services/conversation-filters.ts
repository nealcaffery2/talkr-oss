/**
 * Inbox query parsing (docs/sms.md §6, `GET /v1/conversations`). Pure — no
 * database, no Fastify — so the awkward parts (repeated `type` params, a
 * `from` that is either an org-local day or an ISO instant) are unit-tested
 * rather than discovered by a rep whose filter silently did nothing.
 *
 * Every parameter is optional and they combine with AND. An empty value
 * (`?type=`) means "not set", the same rule as the contacts list.
 */

import { z } from 'zod';
import { CONTACT_STATUSES, CONTACT_TYPES, TEMPERATURES } from '@talkr/core';

export const CONVERSATION_SORTS = ['recent', 'oldest', 'unread', 'temperature'] as const;
export type ConversationSort = (typeof CONVERSATION_SORTS)[number];

export const DEFAULT_CONVERSATION_LIMIT = 50;
export const MAX_CONVERSATION_LIMIT = 200;

/**
 * A `from`/`to` bound. A bare `YYYY-MM-DD` is a calendar day in the ORG's
 * timezone (`from` starts at its local midnight, `to` runs to the end of it);
 * anything else must be a full ISO instant and is used verbatim. The two are
 * genuinely different questions — "everything today" versus "everything since
 * 14:05" — and guessing between them is how an inbox loses a day of threads.
 */
export type TimeBound = { kind: 'day'; day: string } | { kind: 'instant'; at: Date };

export interface ConversationFilters {
  q: string | null;
  /** Contact types; empty = no type filter. */
  types: string[];
  temperature: string | null;
  /** Contact status. */
  status: string | null;
  tag: string | null;
  /** Conversation assignee. */
  userId: string | null;
  unread: boolean;
  direction: 'inbound' | 'outbound' | null;
  hasLead: boolean | null;
  from: TimeBound | null;
  to: TimeBound | null;
  /** Our number (a phone_numbers id). */
  numberId: string | null;
  sort: ConversationSort;
  limit: number;
  offset: number;
}

const BOOL = z.enum(['true', 'false']);
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `type` may repeat (`?type=seller&type=buyer`) or be a comma list. */
const typeParam = z.union([z.string(), z.array(z.string())]).optional();

export const conversationQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  type: typeParam,
  temperature: z.enum(TEMPERATURES).optional(),
  status: z.enum(CONTACT_STATUSES).optional(),
  tag: z.string().trim().min(1).max(60).optional(),
  user_id: z.string().uuid().optional(),
  unread: BOOL.optional(),
  direction: z.enum(['inbound', 'outbound']).optional(),
  has_lead: BOOL.optional(),
  from: z.string().trim().max(40).optional(),
  to: z.string().trim().max(40).optional(),
  number_id: z.string().uuid().optional(),
  sort: z.enum(CONVERSATION_SORTS).optional(),
  limit: z.coerce.number().int().min(1).max(MAX_CONVERSATION_LIMIT).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export type ConversationQuery = z.infer<typeof conversationQuerySchema>;

export class ConversationQueryError extends Error {
  constructor(
    public readonly code: 'invalid_type' | 'invalid_date',
    message: string,
  ) {
    super(message);
  }
}

/** Query params arrive as strings; an empty one means "not set". */
export function cleanQuery(query: unknown): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries((query ?? {}) as Record<string, unknown>).filter(([, v]) => {
      if (v == null || v === '') return false;
      if (Array.isArray(v)) return v.some((x) => x !== '' && x != null);
      return true;
    }),
  );
}

/** Repeated and comma-separated forms both land as a deduped list. */
export function parseTypeList(raw: string | string[] | undefined): string[] {
  if (raw == null) return [];
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap((v) => v.split(','))
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
  const out: string[] = [];
  for (const p of parts) {
    if (!(CONTACT_TYPES as readonly string[]).includes(p)) {
      throw new ConversationQueryError('invalid_type', `not a contact type: ${p}`);
    }
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** `YYYY-MM-DD` → an org-local day; anything else must parse as an instant. */
export function parseTimeBound(raw: string, param: 'from' | 'to'): TimeBound {
  const value = raw.trim();
  if (DAY_RE.test(value)) {
    const ms = Date.parse(`${value}T00:00:00Z`);
    if (Number.isNaN(ms) || new Date(ms).toISOString().slice(0, 10) !== value) {
      throw new ConversationQueryError('invalid_date', `${param}: not a real calendar date: ${value}`);
    }
    return { kind: 'day', day: value };
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new ConversationQueryError(
      'invalid_date',
      `${param}: expected YYYY-MM-DD or an ISO instant, got ${value}`,
    );
  }
  return { kind: 'instant', at: new Date(ms) };
}

/**
 * Raw query → filters, or the validation failure. Zod covers the closed sets;
 * the type list and the date bounds need their own parsing, and both report
 * the offending value rather than a generic 400.
 */
export function parseConversationQuery(
  query: unknown,
):
  | { ok: true; filters: ConversationFilters }
  | { ok: false; error: 'invalid_query'; issues: z.ZodIssue[] }
  | { ok: false; error: 'invalid_type' | 'invalid_date'; message: string } {
  const parsed = conversationQuerySchema.safeParse(cleanQuery(query));
  if (!parsed.success) return { ok: false, error: 'invalid_query', issues: parsed.error.issues };
  const q = parsed.data;
  try {
    return {
      ok: true,
      filters: {
        q: q.q && q.q.length > 0 ? q.q : null,
        types: parseTypeList(q.type),
        temperature: q.temperature ?? null,
        status: q.status ?? null,
        tag: q.tag ?? null,
        userId: q.user_id ?? null,
        unread: q.unread === 'true',
        direction: q.direction ?? null,
        hasLead: q.has_lead == null ? null : q.has_lead === 'true',
        from: q.from ? parseTimeBound(q.from, 'from') : null,
        to: q.to ? parseTimeBound(q.to, 'to') : null,
        numberId: q.number_id ?? null,
        sort: q.sort ?? 'recent',
        limit: q.limit ?? DEFAULT_CONVERSATION_LIMIT,
        offset: q.offset ?? 0,
      },
    };
  } catch (err) {
    if (err instanceof ConversationQueryError) {
      return { ok: false, error: err.code, message: err.message };
    }
    throw err;
  }
}

/** The filters an unfiltered inbox load uses — the shape callers can start from. */
export function emptyConversationFilters(): ConversationFilters {
  return {
    q: null,
    types: [],
    temperature: null,
    status: null,
    tag: null,
    userId: null,
    unread: false,
    direction: null,
    hasLead: null,
    from: null,
    to: null,
    numberId: null,
    sort: 'recent',
    limit: DEFAULT_CONVERSATION_LIMIT,
    offset: 0,
  };
}
