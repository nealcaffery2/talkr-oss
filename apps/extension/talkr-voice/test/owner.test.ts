/**
 * The extension is one rep's phone: an owner or admin's Talkr lists are the
 * whole office's, and these rules keep only the signed-in rep's threads and
 * calls (the same rules as CLOZR's lib/inbox-owner.ts).
 */

import { describe, expect, it } from 'vitest';
import { ownCalls, ownThreads } from '../src/shared/owner';
import type { ConversationDto, HistoryItemDto, MeDto } from '../src/shared/api';

const ME = 'me-0000';
const DANA = 'dana-0000';
const MY_LINE = '+15125550101';
const DANA_LINE = '+15125550102';
const SHARED = '+15125550103';
const SELLER = '+15125550199';

const me = {
  id: ME,
  org_numbers: [
    { id: 'n1', phone_e164: MY_LINE, label: null, area_code: '512', assigned_user_id: ME },
    { id: 'n2', phone_e164: DANA_LINE, label: null, area_code: '512', assigned_user_id: DANA },
    { id: 'n3', phone_e164: SHARED, label: null, area_code: '512', assigned_user_id: null },
  ],
} as unknown as MeDto;

function thread(id: string, our: string, assigned: string | null, at: string): ConversationDto {
  return {
    id,
    our_number: our,
    their_number: SELLER,
    contact_name: null,
    lead_id: null,
    lead_status: null,
    last_message_at: at,
    last_message: null,
    unread_count: 0,
    assigned_user_id: assigned,
  };
}

function call(id: string, user: string | null, to: string): HistoryItemDto {
  return {
    kind: 'call',
    id,
    direction: 'inbound',
    status: 'completed',
    at: '2026-10-16T00:00:00Z',
    duration_seconds: null,
    from_number: SELLER,
    to_number: to,
    contact_name: null,
    address: null,
    user_id: user,
    user_name: null,
    disposition_label: null,
    note: null,
    has_recording: false,
    body: null,
    lead_id: null,
    contact_id: null,
    conversation_id: null,
  };
}

describe('ownThreads', () => {
  it('keeps threads on my line and shared-line threads assigned to me, newest first, once each', () => {
    const a = thread('a', MY_LINE, null, '2026-10-16T01:00:00Z');
    const b = thread('b', SHARED, ME, '2026-10-16T03:00:00Z');
    const onDanaLineAssignedToMe = thread('c', DANA_LINE, ME, '2026-10-16T04:00:00Z');
    const sharedUnassigned = thread('d', SHARED, null, '2026-10-16T05:00:00Z');
    const sharedDana = thread('e', SHARED, DANA, '2026-10-16T06:00:00Z');
    const got = ownThreads([[a, onDanaLineAssignedToMe, sharedUnassigned], [b, a, sharedDana]], me);
    expect(got.map((t) => t.id)).toEqual(['b', 'a']);
  });
});

describe('ownCalls', () => {
  it('keeps calls I handled and unanswered calls on my line', () => {
    const got = ownCalls(
      [
        call('handled', ME, SHARED),
        call('missedMine', null, MY_LINE),
        call('danaHandled', DANA, MY_LINE),
        call('missedDana', null, DANA_LINE),
      ],
      me,
    );
    expect(got.map((c) => c.id)).toEqual(['handled', 'missedMine']);
  });
});
