/**
 * Which line a text goes out on, and which line a thread or call is on.
 *
 * A thread stays on the line already carrying it, so the seller keeps one
 * conversation (CLOZR's lib/thread-line.ts). The transaction coordinator is
 * the exception: she texts as herself, so a teammate's line gives way to her
 * own default; a shared line or her own stays.
 */

import type { ConversationDto, HistoryItemDto, MeDto } from './api';

type Line = { id: string; phone_e164: string; label: string | null };
type LineMe = Pick<MeDto, 'id' | 'role' | 'numbers' | 'org_numbers' | 'default_phone_number_id'>;

const ten = (p: string | null | undefined) => String(p ?? '').replace(/\D/g, '').slice(-10);

/** Roles that text as themselves rather than on the thread's line. */
export const textsAsSelf = (role: string | null | undefined) => role === 'tc';

/** The org line a thread is on: its line id, else the line its number belongs to. */
export function threadLineId(
  c: Pick<ConversationDto, 'phone_number_id' | 'our_number'>,
  me: Pick<MeDto, 'org_numbers'> | null,
): string | null {
  if (c.phone_number_id) return c.phone_number_id;
  const k = ten(c.our_number);
  return (k && me?.org_numbers?.find((n) => ten(n.phone_e164) === k)?.id) || null;
}

/** The org line a call used: the one it rang in on, or the one it went out from. */
export function callLineId(
  h: Pick<HistoryItemDto, 'direction' | 'from_number' | 'to_number'>,
  me: Pick<MeDto, 'org_numbers'> | null,
): string | null {
  const k = ten(h.direction === 'inbound' ? h.to_number : h.from_number);
  return (k && me?.org_numbers?.find((n) => ten(n.phone_e164) === k)?.id) || null;
}

/** The line a reply goes out on: the thread's own, or the rep's default on a new one. */
export function replyLine(me: LineMe, thread: Pick<ConversationDto, 'phone_number_id' | 'our_number'> | null): string | null {
  const own = me.default_phone_number_id ?? me.numbers?.[0]?.id ?? null;
  if (!thread) return own ?? me.org_numbers?.[0]?.id ?? null;
  const id = threadLineId(thread, me);
  if (!id) return own;
  const line = me.org_numbers?.find((n) => n.id === id) ?? null;
  const teammates = !!line?.assigned_user_id && line.assigned_user_id !== me.id;
  return textsAsSelf(me.role) && teammates && own ? own : id;
}

/**
 * The lines a text can go out on: the rep's own, plus any of `keep` that is
 * not one of them. Callers pass the thread's own line as well as the live
 * pick, so switching off a shared line onto one's own never removes the
 * thread's line from the list.
 */
export function fromLineOptions(me: LineMe, ...keep: Array<string | null | undefined>): Line[] {
  const out: Line[] = [...(me.numbers ?? [])];
  for (const id of keep) {
    if (!id || out.some((n) => n.id === id)) continue;
    const line = me.org_numbers?.find((n) => n.id === id);
    if (line) out.push(line);
  }
  return out;
}

/** The lines the inbox can be narrowed to: the rep's own and any line one of their threads is on. */
export function inboxLineOptions(me: LineMe | null, threads: readonly ConversationDto[]): Line[] {
  if (!me) return [];
  const ids = new Set<string>((me.numbers ?? []).map((n) => n.id));
  for (const c of threads) {
    const id = threadLineId(c, me);
    if (id) ids.add(id);
  }
  const byId = new Map<string, Line>();
  for (const n of me.org_numbers ?? []) byId.set(n.id, n);
  for (const n of me.numbers ?? []) if (!byId.has(n.id)) byId.set(n.id, n);
  return [...ids].map((id) => byId.get(id)).filter((n): n is Line => !!n);
}

export function lineLabel(n: Line, format: (e164: string) => string): string {
  return n.label ? `${n.label} · ${format(n.phone_e164)}` : format(n.phone_e164);
}
