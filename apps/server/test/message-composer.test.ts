/**
 * The composer's gatekeepers, all pure (no database):
 *   - message-template validation (docs/sms.md §6) — a body that names a
 *     field nobody knows is rejected at WRITE time, with the names listed;
 *   - the inbox query parser (docs/sms.md §6.4) — repeated `type` params, the
 *     day-or-instant `from`/`to` bounds, the limit cap;
 *   - the inbox SQL those filters compile to, rendered through drizzle's own
 *     dialect: every filter the API advertises has to reach the WHERE clause,
 *     and a filter that silently does nothing is worse than a 400.
 */

import { describe, expect, it } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { AuthContext } from '../src/auth.js';
import {
  serializeTemplate,
  templateBodyProblem,
  templateCreateSchema,
  templateMergeFields,
  templatePatchSchema,
  TEMPLATE_BODY_MAX,
  TEMPLATE_NAME_MAX,
  type MessageTemplateRow,
} from '../src/services/message-templates.js';
import {
  DEFAULT_CONVERSATION_LIMIT,
  emptyConversationFilters,
  MAX_CONVERSATION_LIMIT,
  parseConversationQuery,
  parseTimeBound,
  parseTypeList,
  type ConversationFilters,
} from '../src/services/conversation-filters.js';
import {
  buildConversationListSql,
  type ConversationSqlOptions,
} from '../src/services/messages.js';

describe('template validation', () => {
  it('accepts a body using known fields in either grammar', () => {
    const parsed = templateCreateSchema.safeParse({
      name: 'intro',
      body: 'Hi {first_name}, this is {{rep_name}} with {org_name} about {address}.',
    });
    expect(parsed.success).toBe(true);
    expect(templateBodyProblem(parsed.success ? parsed.data.body : '')).toBeNull();
  });

  it('rejects a body whose merge fields are unknown, and says which', () => {
    const problem = templateBodyProblem('Hi {frist_name}, about {{addres}} in {city}.');
    expect(problem).not.toBeNull();
    expect(problem!.error).toBe('unknown_merge_field');
    expect(problem!.fields).toEqual(['frist_name', 'addres']);
    expect(problem!.message).toContain('{frist_name}');
    expect(problem!.message).toContain('{addres}');
  });

  it('does not treat non-identifier braces as merge fields', () => {
    expect(templateBodyProblem('We can do {50%} down')).toBeNull();
  });

  it('bounds the name at 1..120 and the body at 1..1600', () => {
    expect(templateCreateSchema.safeParse({ name: '', body: 'x' }).success).toBe(false);
    expect(
      templateCreateSchema.safeParse({ name: 'a'.repeat(TEMPLATE_NAME_MAX + 1), body: 'x' }).success,
    ).toBe(false);
    expect(templateCreateSchema.safeParse({ name: 'ok', body: '' }).success).toBe(false);
    expect(
      templateCreateSchema.safeParse({ name: 'ok', body: 'x'.repeat(TEMPLATE_BODY_MAX + 1) }).success,
    ).toBe(false);
    expect(
      templateCreateSchema.safeParse({ name: 'ok', body: 'x'.repeat(TEMPLATE_BODY_MAX) }).success,
    ).toBe(true);
  });

  it('rejects a whitespace-only body and trims the name', () => {
    expect(templateCreateSchema.safeParse({ name: 'ok', body: '   \n ' }).success).toBe(false);
    const parsed = templateCreateSchema.safeParse({ name: '  intro  ', body: 'hi' });
    expect(parsed.success && parsed.data.name).toBe('intro');
  });

  it('a patch must change something, and may clear the category', () => {
    expect(templatePatchSchema.safeParse({}).success).toBe(false);
    expect(templatePatchSchema.safeParse({ is_active: false }).success).toBe(true);
    expect(templatePatchSchema.safeParse({ category: null }).success).toBe(true);
  });

  it('serializes the fields a template card needs', () => {
    const row = {
      id: 'tmpl-1',
      orgId: 'org-1',
      name: 'intro',
      body: 'Hi {first_name} — {rep_name}',
      category: 'cold',
      isActive: true,
      createdBy: 'user-1',
      createdAt: new Date('2026-08-25T12:00:00Z'),
    } as unknown as MessageTemplateRow;
    expect(serializeTemplate(row, 34)).toEqual({
      id: 'tmpl-1',
      name: 'intro',
      body: 'Hi {first_name} — {rep_name}',
      category: 'cold',
      is_active: true,
      use_count: 34,
      merge_fields: ['first_name', 'rep_name'],
      created_at: new Date('2026-08-25T12:00:00Z'),
    });
    expect(templateMergeFields('no fields here')).toEqual([]);
  });
});

describe('inbox query parsing', () => {
  it('defaults to an unfiltered, newest-first page of 50', () => {
    const parsed = parseConversationQuery({});
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filters.sort).toBe('recent');
    expect(parsed.filters.limit).toBe(DEFAULT_CONVERSATION_LIMIT);
    expect(parsed.filters.offset).toBe(0);
    expect(parsed.filters.types).toEqual([]);
    expect(parsed.filters.unread).toBe(false);
    expect(parsed.filters.hasLead).toBeNull();
  });

  it('treats an empty param as "not set" rather than a bad value', () => {
    const parsed = parseConversationQuery({ type: '', q: '', temperature: '' });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filters.types).toEqual([]);
    expect(parsed.filters.q).toBeNull();
    expect(parsed.filters.temperature).toBeNull();
  });

  it('accepts repeated and comma-separated types, deduped', () => {
    expect(parseTypeList(['seller', 'buyer'])).toEqual(['seller', 'buyer']);
    expect(parseTypeList('seller,buyer,seller')).toEqual(['seller', 'buyer']);
    expect(parseTypeList(['seller,buyer', 'title'])).toEqual(['seller', 'buyer', 'title']);
    expect(parseTypeList(' Seller ')).toEqual(['seller']);
    expect(parseTypeList(undefined)).toEqual([]);
  });

  it('names the offending value when a type is not a contact type', () => {
    const parsed = parseConversationQuery({ type: 'seller,landlord' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe('invalid_type');
    expect('message' in parsed && parsed.message).toContain('landlord');
  });

  it('reads from/to as either an org-local day or an ISO instant', () => {
    expect(parseTimeBound('2026-08-25', 'from')).toEqual({ kind: 'day', day: '2026-08-25' });
    expect(parseTimeBound('2026-08-25T14:05:00Z', 'from')).toEqual({
      kind: 'instant',
      at: new Date('2026-08-25T14:05:00Z'),
    });
  });

  it('rejects a date that is not a real day, and unparseable junk', () => {
    expect(() => parseTimeBound('2026-02-30', 'from')).toThrowError(/not a real calendar date/);
    expect(() => parseTimeBound('last tuesday', 'to')).toThrowError(/ISO instant/);
    const parsed = parseConversationQuery({ from: '2026-13-01' });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe('invalid_date');
  });

  it('parses the whole filter set at once', () => {
    const parsed = parseConversationQuery({
      q: '614555',
      type: ['seller', 'buyer'],
      temperature: 'hot',
      status: 'engaged',
      tag: 'probate',
      user_id: '11111111-1111-4111-8111-111111111111',
      unread: 'true',
      direction: 'inbound',
      has_lead: 'false',
      from: '2026-08-01',
      to: '2026-08-25T23:59:59Z',
      number_id: '22222222-2222-4222-8222-222222222222',
      sort: 'temperature',
      limit: '25',
      offset: '50',
    });
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.filters).toEqual({
      q: '614555',
      types: ['seller', 'buyer'],
      temperature: 'hot',
      status: 'engaged',
      tag: 'probate',
      userId: '11111111-1111-4111-8111-111111111111',
      unread: true,
      direction: 'inbound',
      hasLead: false,
      from: { kind: 'day', day: '2026-08-01' },
      to: { kind: 'instant', at: new Date('2026-08-25T23:59:59Z') },
      numberId: '22222222-2222-4222-8222-222222222222',
      sort: 'temperature',
      limit: 25,
      offset: 50,
    });
  });

  it('rejects a limit past the cap rather than silently clamping', () => {
    const parsed = parseConversationQuery({ limit: String(MAX_CONVERSATION_LIMIT + 1) });
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error).toBe('invalid_query');
  });

  it('rejects an unknown sort, temperature or status', () => {
    expect(parseConversationQuery({ sort: 'hottest' }).ok).toBe(false);
    expect(parseConversationQuery({ temperature: 'tepid' }).ok).toBe(false);
    expect(parseConversationQuery({ status: 'maybe' }).ok).toBe(false);
  });
});

describe('inbox SQL composition', () => {
  const dialect = new PgDialect();
  const ctx = {
    userId: '99999999-9999-4999-8999-999999999999',
    orgId: '88888888-8888-4888-8888-888888888888',
    role: 'manager',
    email: 'riley@example.com',
    displayName: 'Riley Rep',
  } as AuthContext;

  function build(filters: Partial<ConversationFilters> = {}, opts: Partial<ConversationSqlOptions> = {}) {
    const built = buildConversationListSql(ctx, {
      seeOrg: true,
      timezone: 'America/New_York',
      numberE164: null,
      ...opts,
      filters: { ...emptyConversationFilters(), ...filters },
    });
    return {
      page: dialect.sqlToQuery(built.page),
      counts: dialect.sqlToQuery(built.counts),
    };
  }

  /** Both statements must be parseable-shaped: balanced parens, no stray commas. */
  function assertWellFormed(text: string) {
    let depth = 0;
    for (const ch of text) {
      if (ch === '(') depth++;
      if (ch === ')') depth--;
      expect(depth).toBeGreaterThanOrEqual(0);
    }
    expect(depth).toBe(0);
    expect(text).not.toMatch(/,\s*(FROM|WHERE|ORDER BY)/);
    expect(text).not.toMatch(/(WHERE|AND|OR)\s+(AND|OR)\b/);
  }

  it('scopes to the org, pages, and orders by recent activity by default', () => {
    const { page, counts } = build();
    assertWellFormed(page.sql);
    assertWellFormed(counts.sql);
    expect(page.sql).toContain('cv.org_id =');
    expect(page.sql).toContain('LEFT JOIN LATERAL');
    expect(page.sql).toContain('ORDER BY COALESCE(cv.last_message_at, cv.created_at) DESC');
    expect(page.params).toContain(ctx.orgId);
    expect(page.params).toContain(50);
    expect(counts.sql).toContain('WITH filtered AS');
    expect(counts.sql).toContain('jsonb_object_agg');
  });

  it('own-scope adds the shared-inbox clause; org-scope does not', () => {
    expect(build({}, { seeOrg: false }).page.sql).toContain('cv.assigned_user_id IS NULL');
    expect(build({}, { seeOrg: true }).page.sql).not.toContain('cv.assigned_user_id IS NULL');
  });

  it('binds a type list as ONE array parameter, not a row constructor', () => {
    const { page } = build({ types: ['seller', 'buyer'] });
    // `ANY(($1, $2)::text[])` would be a record cast — invalid SQL at runtime.
    expect(page.sql).toContain('ct.type = ANY($');
    expect(page.sql).not.toMatch(/ANY\(\(\$\d+, \$\d+\)/);
    expect(page.params).toContainEqual(['seller', 'buyer']);
  });

  it('puts every filter it advertises into the WHERE clause', () => {
    const { page, counts } = build({
      q: '614555',
      types: ['seller'],
      temperature: 'hot',
      status: 'engaged',
      tag: 'probate',
      userId: '11111111-1111-4111-8111-111111111111',
      unread: true,
      direction: 'inbound',
      hasLead: true,
      numberId: '22222222-2222-4222-8222-222222222222',
      sort: 'temperature',
      limit: 10,
      offset: 20,
    }, { numberE164: '+16145550006' });
    assertWellFormed(page.sql);
    assertWellFormed(counts.sql);
    for (const fragment of [
      'ct.display_name ILIKE',
      'ct.company ILIKE',
      'lm.body ILIKE',
      'cv.their_number LIKE',
      'ct.type = ANY(',
      'ct.temperature =',
      'ct.status =',
      'ct.tags @>',
      'cv.assigned_user_id =',
      'cv.unread_count > 0',
      'lm.direction =',
      'cv.lead_id IS NOT NULL',
      'cv.phone_number_id =',
      'cv.our_number =',
    ]) {
      expect(page.sql, fragment).toContain(fragment);
      expect(counts.sql, fragment).toContain(fragment);
    }
    expect(page.sql).toContain('ORDER BY ct.temperature_score DESC NULLS LAST');
    expect(page.params).toContain(10);
    expect(page.params).toContain(20);
  });

  it('has_lead=false is a different clause from has_lead unset', () => {
    expect(build({ hasLead: false }).page.sql).toContain('cv.lead_id IS NULL');
    expect(build({}).page.sql).not.toContain('cv.lead_id IS NULL');
  });

  it('a day bound becomes org-local midnight; an instant is bound as-is', () => {
    const day = build({ from: { kind: 'day', day: '2026-08-25' }, to: { kind: 'day', day: '2026-08-25' } });
    expect(day.page.sql).toContain("::date)::timestamp AT TIME ZONE");
    expect(day.page.sql).toContain("::date + 1)::timestamp AT TIME ZONE");
    expect(day.page.params).toContain('America/New_York');
    expect(day.page.params).toContain('2026-08-25');

    const at = new Date('2026-08-25T14:05:00Z');
    const instant = build({ from: { kind: 'instant', at } });
    expect(instant.page.sql).not.toContain('AT TIME ZONE');
    expect(instant.page.params).toContain(at);
  });

  it('falls back to phone_number_id alone when number_id names nothing we own', () => {
    const { page } = build({ numberId: '22222222-2222-4222-8222-222222222222' }, { numberE164: null });
    expect(page.sql).toContain('cv.phone_number_id =');
    expect(page.sql).not.toContain('cv.our_number =');
  });

  it('a short q searches text only — two digits are not a phone match', () => {
    const { page } = build({ q: 'ab' });
    expect(page.sql).toContain('ct.display_name ILIKE');
    expect(page.sql).not.toContain('cv.their_number LIKE');
  });

  it('sorts oldest and unread the way the API says', () => {
    expect(build({ sort: 'oldest' }).page.sql).toContain(
      'ORDER BY COALESCE(cv.last_message_at, cv.created_at) ASC',
    );
    expect(build({ sort: 'unread' }).page.sql).toContain('ORDER BY cv.unread_count DESC');
  });
});
