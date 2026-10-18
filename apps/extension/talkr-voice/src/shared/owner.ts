/**
 * Whose a text thread or a call is, so the extension shows the signed-in rep
 * their own and nobody else's. An owner or admin gets the whole office from
 * Talkr's lists; the extension is one rep's phone, so it keeps only theirs.
 *
 * The same rules as CLOZR's inbox (Clozr-app lib/inbox-owner.ts):
 * - A thread is the rep's whose line carries it. On a line nobody owns (a
 *   shared or main line) it is the assignee's.
 * - A call is the rep's who handled it. One nobody picked up (missed, a
 *   voicemail) is the owner's of the line it rang.
 */

import type { ConversationDto, HistoryItemDto, MeDto } from './api';

const ten = (p: string | null | undefined) => String(p ?? '').replace(/\D/g, '').slice(-10);

/** Every org line by its last ten digits: who owns it (null: a shared line). */
export function lineOwners(me: Pick<MeDto, 'org_numbers'> | null): Map<string, string | null> {
  const m = new Map<string, string | null>();
  for (const l of me?.org_numbers ?? []) {
    const k = ten(l.phone_e164);
    if (k) m.set(k, l.assigned_user_id ?? null);
  }
  return m;
}

export function threadOwner(
  c: Pick<ConversationDto, 'our_number' | 'assigned_user_id'>,
  owners: Map<string, string | null>,
): string | null {
  const line = owners.get(ten(c.our_number));
  if (line) return line;
  return c.assigned_user_id ?? null;
}

export function callOwner(
  h: Pick<HistoryItemDto, 'direction' | 'user_id' | 'from_number' | 'to_number'>,
  owners: Map<string, string | null>,
): string | null {
  if (h.user_id) return h.user_id;
  const ours = h.direction === 'inbound' ? h.to_number : h.from_number;
  return owners.get(ten(ours)) ?? null;
}

/** The rep's own threads, each once, newest first. */
export function ownThreads(lists: readonly (readonly ConversationDto[])[], me: MeDto): ConversationDto[] {
  const owners = lineOwners(me);
  const by = new Map<string, ConversationDto>();
  for (const list of lists) for (const c of list) if (!by.has(c.id)) by.set(c.id, c);
  const at = (c: ConversationDto) => Date.parse(c.last_message_at ?? '') || 0;
  return [...by.values()].filter((c) => threadOwner(c, owners) === me.id).sort((a, b) => at(b) - at(a));
}

/**
 * The rep's own calls. The server already narrows `user_id` to them; this also
 * covers a server older than the line rule, where an unanswered call on the
 * rep's line came back with no handler.
 */
export function ownCalls(items: readonly HistoryItemDto[], me: MeDto): HistoryItemDto[] {
  const owners = lineOwners(me);
  return items.filter((h) => {
    const who = callOwner(h, owners);
    // A voicemail for nobody in particular on a shared line still reaches the
    // rep the server routed it to; trust the server when it has no owner.
    return who === null || who === me.id;
  });
}
