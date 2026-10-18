/**
 * Which line a text goes out on (CLOZR's lib/thread-line.ts), the presence the
 * heartbeat reports, and the inbox's line filter.
 */

import { describe, expect, it } from 'vitest';
import { callLineId, fromLineOptions, inboxLineOptions, replyLine, threadLineId } from '../src/shared/lines';
import { asPresence, heartbeatStatus } from '../src/shared/presence';
import type { ConversationDto, HistoryItemDto, MeDto } from '../src/shared/api';

const ME = 'me-0000';
const DANA = 'dana-0000';
const MY_LINE = '+15125550101';
const MY_OTHER = '+15125550104';
const DANA_LINE = '+15125550102';
const SHARED = '+15125550103';
const SELLER = '+15125550199';

const org = [
  { id: 'n1', phone_e164: MY_LINE, label: 'Austin', area_code: '512', assigned_user_id: ME },
  { id: 'n2', phone_e164: DANA_LINE, label: null, area_code: '512', assigned_user_id: DANA },
  { id: 'n3', phone_e164: SHARED, label: 'Main', area_code: '512', assigned_user_id: null },
  { id: 'n4', phone_e164: MY_OTHER, label: null, area_code: '512', assigned_user_id: ME },
];

function rep(role: string | null = 'rep', defaultId: string | null = 'n4'): MeDto {
  return {
    id: ME,
    role,
    numbers: [org[0]!, org[3]!].map(({ id, phone_e164, label }) => ({ id, phone_e164, label })),
    org_numbers: org,
    default_phone_number_id: defaultId,
  } as unknown as MeDto;
}

const thread = (our: string, lineId: string | null = null): ConversationDto =>
  ({ id: `t-${our}`, our_number: our, their_number: SELLER, phone_number_id: lineId }) as unknown as ConversationDto;

describe('replyLine', () => {
  it('keeps a thread on the line already carrying it', () => {
    expect(replyLine(rep(), thread(MY_LINE, 'n1'))).toBe('n1');
    expect(replyLine(rep(), thread(SHARED, 'n3'))).toBe('n3');
  });

  it('finds the line by number on a server that does not send its id', () => {
    expect(replyLine(rep(), thread('(512) 555-0101'))).toBe('n1');
  });

  it("uses the rep's default on a new thread, else their first line", () => {
    expect(replyLine(rep(), null)).toBe('n4');
    expect(replyLine(rep('rep', null), null)).toBe('n1');
  });

  it("a TC texts as herself on a teammate's line, but not on a shared one", () => {
    expect(replyLine(rep('tc'), thread(DANA_LINE, 'n2'))).toBe('n4');
    expect(replyLine(rep('tc'), thread(SHARED, 'n3'))).toBe('n3');
    expect(replyLine(rep('rep'), thread(DANA_LINE, 'n2'))).toBe('n2');
  });
});

describe('fromLineOptions', () => {
  it("offers the rep's own lines, plus the thread's when it is not one of them", () => {
    expect(fromLineOptions(rep(), 'n1').map((n) => n.id)).toEqual(['n1', 'n4']);
    expect(fromLineOptions(rep(), 'n3').map((n) => n.id)).toEqual(['n1', 'n4', 'n3']);
  });

  it("keeps the thread's shared line after the rep switches to one of their own", () => {
    // thread line n3 (shared), live pick n1 (own): n3 must still be offered.
    expect(fromLineOptions(rep(), 'n3', 'n1').map((n) => n.id)).toEqual(['n1', 'n4', 'n3']);
  });
});

describe('inbox line filter', () => {
  it("lists the rep's lines and any line one of their threads is on", () => {
    const ids = inboxLineOptions(rep(), [thread(SHARED, 'n3'), thread(MY_LINE, 'n1')]).map((n) => n.id);
    expect(ids.sort()).toEqual(['n1', 'n3', 'n4']);
  });

  it('places threads and calls on a line', () => {
    expect(threadLineId(thread(MY_OTHER), rep())).toBe('n4');
    const call = (direction: 'inbound' | 'outbound') =>
      ({ direction, from_number: direction === 'inbound' ? SELLER : MY_LINE, to_number: direction === 'inbound' ? MY_OTHER : SELLER }) as HistoryItemDto;
    expect(callLineId(call('inbound'), rep())).toBe('n4');
    expect(callLineId(call('outbound'), rep())).toBe('n1');
  });
});

describe('presence', () => {
  it('beats available only when picked and the phone can ring', () => {
    expect(heartbeatStatus('available', true)).toBe('available');
    expect(heartbeatStatus('available', false)).toBe('away');
    expect(heartbeatStatus('dnd', true)).toBe('away');
    expect(heartbeatStatus('away', true)).toBe('away');
  });

  it('reads anything unknown as available', () => {
    expect(asPresence('dnd')).toBe('dnd');
    expect(asPresence(undefined)).toBe('available');
    expect(asPresence('busy')).toBe('available');
  });
});
