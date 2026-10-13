/**
 * Conference call control: hold, add call, merge, warm/blind transfer
 * (docs/telephony-events.md §9).
 *
 * Every operation is a participant operation on the call's room. Our rows are
 * an optimistic view — the provider's conference callbacks are authoritative
 * and reconcile the state a moment later, exactly as call status callbacks are
 * authoritative for the call itself. That is why each control writes its own
 * `call_events` entry: the journal records what the rep asked for, the
 * callbacks record what the room did.
 */

import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import {
  canAddParticipant,
  canHold,
  canMonitor,
  canMerge,
  canRemove,
  canTransfer,
  canUnhold,
  conferenceRoomName,
  isTerminal,
  monitorPatch,
  type MonitorMode,
  type ControlContext,
  type ControlRefusal,
  type ParticipantRole,
  type TransferMode,
  type VoiceProvider,
} from '@talkr/core';
import { publishBusEvent, schema, type DbHandle } from '@talkr/db';
import type { Config } from '../config.js';
import type { AuthContext } from '../auth.js';
import { writeAudit } from './audit.js';
import { clientAddressFor } from './client-address.js';

export class ConferenceError extends Error {
  constructor(
    public readonly code: ControlRefusal | 'not_found' | 'forbidden' | 'invalid_target',
    message: string,
  ) {
    super(message);
  }
}

type CallRow = typeof schema.calls.$inferSelect;
type ParticipantRow = typeof schema.callParticipants.$inferSelect;

export interface ControlDeps {
  dbh: DbHandle;
  provider: VoiceProvider;
  config: Config;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/**
 * Load a call the actor is allowed to control, with its participants.
 * Controlling a call is stricter than reading one: it is the rep's own live
 * call, so org-wide read permission does not grant control.
 */
export async function loadControllableCall(
  dbh: DbHandle,
  ctx: AuthContext,
  callId: string,
): Promise<{ call: CallRow; participants: ParticipantRow[] }> {
  const call = (
    await dbh.db
      .select()
      .from(schema.calls)
      .where(and(eq(schema.calls.id, callId), eq(schema.calls.orgId, ctx.orgId)))
      .limit(1)
  )[0];
  if (!call) throw new ConferenceError('not_found', 'call not found');
  if (call.userId && call.userId !== ctx.userId) {
    throw new ConferenceError('forbidden', 'not your call');
  }
  const participants = await dbh.db
    .select()
    .from(schema.callParticipants)
    .where(eq(schema.callParticipants.callId, callId));
  return { call, participants };
}

function controlContext(call: CallRow, participants: ParticipantRow[]): ControlContext {
  return {
    callActive: !isTerminal(call.status),
    participants: participants.map((p) => ({
      providerParticipantId: p.providerParticipantId,
      role: p.role as ParticipantRole,
      state: p.state as ControlContext['participants'][number]['state'],
    })),
  };
}

function refuse(code: ControlRefusal | null): void {
  if (code) throw new ConferenceError(code, code.replace(/_/g, ' '));
}

function livePartiesWithRole(participants: ParticipantRow[], role: ParticipantRole): ParticipantRow[] {
  return participants.filter((p) => p.role === role && p.state !== 'left');
}

// ---------------------------------------------------------------------------
// Journal + notify
// ---------------------------------------------------------------------------

/**
 * Record a control action. `dedupeToken` is the action's identity, so a
 * retried request writes one entry: the same rep holding the same participant
 * twice in a second is one fact, not two.
 */
async function journalControl(
  dbh: DbHandle,
  call: CallRow,
  eventType: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const at = new Date();
  await dbh.db
    .insert(schema.callEvents)
    .values({
      orgId: call.orgId,
      callId: call.id,
      eventType,
      occurredAt: at,
      source: 'api',
      dedupeToken: `${call.id}:${eventType}:${at.getTime()}`,
      payload,
    })
    .onConflictDoNothing();
}

/** Nudge the rep's open surfaces (web app, extension popup, side panel). */
async function publishControl(dbh: DbHandle, call: CallRow): Promise<void> {
  await publishBusEvent(dbh.pool, {
    type: 'call.updated',
    orgId: call.orgId,
    userId: call.userId ?? undefined,
    callId: call.id,
    status: call.status,
  }).catch(() => undefined);
}

// ---------------------------------------------------------------------------
// Hold / resume
// ---------------------------------------------------------------------------

/**
 * Hold or resume the customer. Holding is what makes a private consultation
 * possible, so add-call and warm transfer both go through here first.
 */
export async function setHold(
  deps: ControlDeps,
  ctx: AuthContext,
  callId: string,
  hold: boolean,
): Promise<ParticipantRow[]> {
  const { dbh, provider } = deps;
  const { call, participants } = await loadControllableCall(dbh, ctx, callId);
  refuse(hold ? canHold(controlContext(call, participants)) : canUnhold(controlContext(call, participants)));

  const room = conferenceRoomName(call.id);
  const targets = livePartiesWithRole(participants, 'customer');
  for (const target of targets) {
    await provider.updateParticipant(room, target.providerParticipantId, { hold });
  }
  const updated = await markState(
    dbh,
    targets.map((t) => t.id),
    hold ? 'on_hold' : 'joined',
  );

  await journalControl(dbh, call, hold ? 'call.hold' : 'call.unhold', {
    participants: targets.map((t) => t.providerParticipantId),
  });
  await writeAudit(dbh.db, {
    orgId: call.orgId,
    actorType: 'user',
    actorId: ctx.userId,
    action: hold ? 'call.hold' : 'call.unhold',
    objectType: 'call',
    objectId: call.id,
    metadata: { participants: targets.length },
    correlationId: call.correlationId,
  });
  await publishControl(dbh, call);
  return updated;
}

/**
 * Optimistic local state. The conference callback confirms it moments later;
 * `left` is never overwritten, matching the sticky-terminal rule.
 */
async function markState(
  dbh: DbHandle,
  ids: string[],
  state: 'joined' | 'on_hold' | 'left',
): Promise<ParticipantRow[]> {
  if (ids.length === 0) return [];
  return dbh.db
    .update(schema.callParticipants)
    .set({ state, ...(state === 'left' ? { leftAt: new Date() } : {}) })
    .where(and(inArray(schema.callParticipants.id, ids), ne(schema.callParticipants.state, 'left')))
    .returning();
}

// ---------------------------------------------------------------------------
// Add a party
// ---------------------------------------------------------------------------

export interface AddPartyInput {
  /** Another platform user — dialed on their browser. */
  userId?: string;
  /** Any external number. */
  toNumber?: string;
  /**
   * Hold the customer while the new party joins, so the rep can speak to them
   * privately. This is what separates "add call" (a consultation the customer
   * must not hear) from "merge" (everyone together).
   */
  consult: boolean;
  /** False when the party must survive the agent leaving (transfer target). */
  endConferenceOnExit: boolean;
  role: ParticipantRole;
}

/**
 * Resolve who to dial. A teammate is addressed at the SIP URI built from their
 * stored credential (services/client-address.ts).
 */
async function resolveTarget(
  dbh: DbHandle,
  provider: VoiceProvider,
  orgId: string,
  input: AddPartyInput,
): Promise<{ address: string; label: string; userId: string | null }> {
  if (input.userId) {
    const user = (
      await dbh.db
        .select()
        .from(schema.users)
        .where(and(eq(schema.users.id, input.userId), eq(schema.users.orgId, orgId)))
        .limit(1)
    )[0];
    if (!user) throw new ConferenceError('invalid_target', 'teammate not found in this org');
    let address: string;
    try {
      address = await clientAddressFor(dbh, provider, user.id);
    } catch {
      // No credential means they have never enabled their softphone; dialing
      // would ring nothing, so say that rather than creating a dead leg.
      throw new ConferenceError(
        'invalid_target',
        `${user.displayName} has not enabled their softphone yet`,
      );
    }
    return { address, label: user.displayName, userId: user.id };
  }
  if (input.toNumber) {
    return { address: input.toNumber, label: input.toNumber, userId: null };
  }
  throw new ConferenceError('invalid_target', 'user_id or to_number is required');
}

export async function addParty(
  deps: ControlDeps,
  ctx: AuthContext,
  callId: string,
  input: AddPartyInput,
): Promise<ParticipantRow> {
  const { dbh, provider, config } = deps;
  const { call, participants } = await loadControllableCall(dbh, ctx, callId);
  refuse(canAddParticipant(controlContext(call, participants)));

  const target = await resolveTarget(dbh, provider, call.orgId, input);
  const room = conferenceRoomName(call.id);

  // Consultation first: a participant cannot be created already held, so the
  // customer is held *before* the third party is dialed, never after.
  if (input.consult) {
    const customers = livePartiesWithRole(participants, 'customer').filter((p) => p.state !== 'on_hold');
    for (const c of customers) {
      await provider.updateParticipant(room, c.providerParticipantId, { hold: true });
    }
    await markState(dbh, customers.map((c) => c.id), 'on_hold');
  }

  const q = `call=${call.id}`;
  const added = await provider.addParticipant({
    roomName: room,
    callerId: call.fromNumber,
    to: target.address,
    statusCallbackUrl: `${config.PUBLIC_BASE_URL}/webhooks/telnyx/voice-status?${q}&leg=other`,
    endConferenceOnExit: input.endConferenceOnExit,
  });

  const row = (
    await dbh.db
      .insert(schema.callParticipants)
      .values({
        orgId: call.orgId,
        callId: call.id,
        roomName: room,
        providerParticipantId: added.providerParticipantId,
        role: input.role,
        state: 'ringing',
        userId: target.userId,
        address: target.address,
        label: target.label,
        raw: added.raw,
      })
      .onConflictDoNothing({ target: schema.callParticipants.providerParticipantId })
      .returning()
  )[0];

  await journalControl(dbh, call, 'call.participant_added', {
    role: input.role,
    address: target.address,
    consult: input.consult,
    providerParticipantId: added.providerParticipantId,
  });
  await writeAudit(dbh.db, {
    orgId: call.orgId,
    actorType: 'user',
    actorId: ctx.userId,
    action: 'call.participant_added',
    objectType: 'call',
    objectId: call.id,
    metadata: { role: input.role, target_last4: target.address.slice(-4) },
    correlationId: call.correlationId,
  });
  await publishControl(dbh, call);

  return (
    row ??
    (
      await dbh.db
        .select()
        .from(schema.callParticipants)
        .where(eq(schema.callParticipants.providerParticipantId, added.providerParticipantId))
        .limit(1)
    )[0]!
  );
}

// ---------------------------------------------------------------------------
// Merge
// ---------------------------------------------------------------------------

/** Un-hold everyone: the consultation becomes a conference. */
export async function mergeCall(
  deps: ControlDeps,
  ctx: AuthContext,
  callId: string,
): Promise<ParticipantRow[]> {
  const { dbh, provider } = deps;
  const { call, participants } = await loadControllableCall(dbh, ctx, callId);
  refuse(canMerge(controlContext(call, participants)));

  const room = conferenceRoomName(call.id);
  const held = participants.filter((p) => p.state === 'on_hold');
  for (const p of held) {
    await provider.updateParticipant(room, p.providerParticipantId, { hold: false });
  }
  const updated = await markState(dbh, held.map((p) => p.id), 'joined');

  await journalControl(dbh, call, 'call.merged', {
    participants: participants.filter((p) => p.state !== 'left').length,
  });
  await publishControl(dbh, call);
  return updated;
}

// ---------------------------------------------------------------------------
// Remove a party
// ---------------------------------------------------------------------------

export async function removeParty(
  deps: ControlDeps,
  ctx: AuthContext,
  callId: string,
  providerParticipantId: string,
): Promise<void> {
  const { dbh, provider } = deps;
  const { call, participants } = await loadControllableCall(dbh, ctx, callId);
  refuse(canRemove(controlContext(call, participants), providerParticipantId));

  const room = conferenceRoomName(call.id);
  await provider.removeParticipant(room, providerParticipantId);
  const target = participants.find((p) => p.providerParticipantId === providerParticipantId)!;
  await markState(dbh, [target.id], 'left');

  await journalControl(dbh, call, 'call.participant_removed', { providerParticipantId });
  await publishControl(dbh, call);
}

// ---------------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------------

export interface TransferInput {
  mode: TransferMode;
  userId?: string;
  toNumber?: string;
}

/**
 * Warm: the target joins while the customer is held, and the rep stays until
 * they call `completeTransfer`. Blind: the target joins and the rep drops in
 * the same operation, so the customer is briefly alone in the room (hearing
 * hold audio, not silence) while the target's phone rings.
 *
 * Both flip the agent's `endConferenceOnExit` off first — otherwise the rep
 * hanging up would tear the room down and drop the customer mid-transfer.
 */
export async function transferCall(
  deps: ControlDeps,
  ctx: AuthContext,
  callId: string,
  input: TransferInput,
): Promise<ParticipantRow> {
  const { dbh, provider } = deps;
  const { call, participants } = await loadControllableCall(dbh, ctx, callId);
  refuse(canTransfer(controlContext(call, participants)));

  const room = conferenceRoomName(call.id);
  for (const agent of livePartiesWithRole(participants, 'agent')) {
    await provider.updateParticipant(room, agent.providerParticipantId, {
      endConferenceOnExit: false,
    });
  }

  const party = await addParty(deps, ctx, callId, {
    userId: input.userId,
    toNumber: input.toNumber,
    consult: input.mode === 'warm',
    endConferenceOnExit: false,
    role: input.userId ? 'teammate' : 'external',
  });

  await journalControl(dbh, call, 'call.transfer_initiated', {
    mode: input.mode,
    providerParticipantId: party.providerParticipantId,
  });
  await writeAudit(dbh.db, {
    orgId: call.orgId,
    actorType: 'user',
    actorId: ctx.userId,
    action: 'call.transfer',
    objectType: 'call',
    objectId: call.id,
    metadata: { mode: input.mode, to_user: input.userId ?? null },
    correlationId: call.correlationId,
  });

  if (input.mode === 'blind') await completeTransfer(deps, ctx, callId);
  return party;
}

/**
 * Hand over for real: un-hold the customer and drop the agent. Safe to call
 * twice — an agent already gone is the state this wanted.
 */
export async function completeTransfer(
  deps: ControlDeps,
  ctx: AuthContext,
  callId: string,
): Promise<void> {
  const { dbh, provider } = deps;
  const { call, participants } = await loadControllableCall(dbh, ctx, callId);
  const room = conferenceRoomName(call.id);

  const held = participants.filter((p) => p.state === 'on_hold' && p.role === 'customer');
  for (const p of held) {
    await provider.updateParticipant(room, p.providerParticipantId, { hold: false });
  }
  await markState(dbh, held.map((p) => p.id), 'joined');

  const agents = livePartiesWithRole(participants, 'agent');
  for (const agent of agents) {
    await provider.updateParticipant(room, agent.providerParticipantId, {
      endConferenceOnExit: false,
    });
    await provider.removeParticipant(room, agent.providerParticipantId);
  }
  await markState(dbh, agents.map((a) => a.id), 'left');

  await journalControl(dbh, call, 'call.transfer_completed', { agentsDropped: agents.length });
  await publishControl(dbh, call);
}

// ---------------------------------------------------------------------------
// Supervision: listen / whisper / barge
// ---------------------------------------------------------------------------

/**
 * A supervisor joins someone else's room, so this loads by org only (the
 * `calls.monitor` permission is the gate) and refuses the actor's own call.
 */
async function loadMonitorableCall(dbh: DbHandle, ctx: AuthContext, callId: string) {
  const call = (
    await dbh.db
      .select()
      .from(schema.calls)
      .where(and(eq(schema.calls.id, callId), eq(schema.calls.orgId, ctx.orgId)))
      .limit(1)
  )[0];
  if (!call) throw new ConferenceError('not_found', 'call not found');
  const participants = await dbh.db
    .select()
    .from(schema.callParticipants)
    .where(eq(schema.callParticipants.callId, callId));
  const refusal = canMonitor(controlContext(call, participants), call.userId, ctx.userId);
  if (refusal === 'own_call') throw new ConferenceError('forbidden', 'you cannot monitor your own call');
  refuse(refusal);
  const agent = livePartiesWithRole(participants, 'agent')[0]!;
  const mine = participants.filter(
    (p) => p.role === 'supervisor' && p.userId === ctx.userId && p.state !== 'left',
  );
  return { call, agent, mine };
}

/**
 * Dial the supervisor's browser into the room in `mode`. Re-joining replaces
 * any earlier supervisor leg of theirs (a ring they never answered, say).
 * No beep, never ends the room, and no call status callback — their leg
 * hanging up must not read as the call ending.
 */
export async function startMonitoring(
  deps: ControlDeps,
  ctx: AuthContext,
  callId: string,
  mode: MonitorMode,
): Promise<ParticipantRow> {
  const { dbh, provider } = deps;
  const { call, agent, mine } = await loadMonitorableCall(dbh, ctx, callId);
  const room = conferenceRoomName(call.id);
  for (const old of mine) await provider.removeParticipant(room, old.providerParticipantId);
  await markState(dbh, mine.map((m) => m.id), 'left');

  const target = await resolveTarget(dbh, provider, call.orgId, {
    userId: ctx.userId,
    consult: false,
    endConferenceOnExit: false,
    role: 'supervisor',
  });
  const added = await provider.addParticipant({
    roomName: room,
    callerId: call.fromNumber,
    to: target.address,
    endConferenceOnExit: false,
    beep: false,
    // The supervisor's softphone only auto-answers a ring for the call it asked to monitor.
    talkrCallId: call.id,
    ...monitorPatch(mode, agent.providerParticipantId),
  });
  const [row] = await dbh.db
    .insert(schema.callParticipants)
    .values({
      orgId: call.orgId,
      callId: call.id,
      roomName: room,
      providerParticipantId: added.providerParticipantId,
      role: 'supervisor',
      state: 'ringing',
      userId: ctx.userId,
      address: target.address,
      label: target.label,
      raw: { ...added.raw, monitorMode: mode },
    })
    .returning();

  await journalControl(dbh, call, 'call.monitor_started', { mode, supervisorUserId: ctx.userId });
  await writeAudit(dbh.db, {
    orgId: call.orgId,
    actorType: 'user',
    actorId: ctx.userId,
    action: 'call.monitor',
    objectType: 'call',
    objectId: call.id,
    metadata: { mode },
    correlationId: call.correlationId,
  });
  return row!;
}

/** Switch the supervisor's existing leg between listen, whisper and barge. */
export async function setMonitorMode(
  deps: ControlDeps,
  ctx: AuthContext,
  callId: string,
  mode: MonitorMode,
): Promise<ParticipantRow> {
  const { dbh, provider } = deps;
  const { call, agent, mine } = await loadMonitorableCall(dbh, ctx, callId);
  const leg = mine.at(-1);
  if (!leg) throw new ConferenceError('participant_not_found', 'you are not monitoring this call');
  await provider.updateParticipant(
    conferenceRoomName(call.id),
    leg.providerParticipantId,
    monitorPatch(mode, agent.providerParticipantId),
  );
  const [row] = await dbh.db
    .update(schema.callParticipants)
    .set({ raw: { ...(leg.raw as Record<string, unknown>), monitorMode: mode } })
    .where(eq(schema.callParticipants.id, leg.id))
    .returning();
  await journalControl(dbh, call, 'call.monitor_mode', { mode, supervisorUserId: ctx.userId });
  return row!;
}

/** Leave. Allowed on an ended call too — there is nothing left to refuse. */
export async function stopMonitoring(deps: ControlDeps, ctx: AuthContext, callId: string): Promise<void> {
  const { dbh, provider } = deps;
  const call = (
    await dbh.db
      .select()
      .from(schema.calls)
      .where(and(eq(schema.calls.id, callId), eq(schema.calls.orgId, ctx.orgId)))
      .limit(1)
  )[0];
  if (!call) throw new ConferenceError('not_found', 'call not found');
  const mine = await dbh.db
    .select()
    .from(schema.callParticipants)
    .where(
      and(
        eq(schema.callParticipants.callId, callId),
        eq(schema.callParticipants.role, 'supervisor'),
        eq(schema.callParticipants.userId, ctx.userId),
        ne(schema.callParticipants.state, 'left'),
      ),
    );
  for (const leg of mine) {
    await provider.removeParticipant(conferenceRoomName(call.id), leg.providerParticipantId);
  }
  await markState(dbh, mine.map((m) => m.id), 'left');
  if (mine.length) await journalControl(dbh, call, 'call.monitor_stopped', { supervisorUserId: ctx.userId });
}

/**
 * The org's live calls a supervisor can pick from: who is on it, with whom,
 * since when, and whether (and how) the requester is already monitoring it.
 */
export async function liveCallsForSupervisor(dbh: DbHandle, ctx: AuthContext) {
  const rows = (
    await dbh.db.execute(sql`
      SELECT c.id, c.direction::text AS direction, c.status::text AS status,
             c.from_number, c.to_number, c.answered_at, c.created_at,
             c.user_id, u.display_name AS rep_name, ct.display_name AS contact_name,
             s.raw ->> 'monitorMode' AS my_mode
      FROM calls c
      JOIN users u ON u.id = c.user_id
      LEFT JOIN contacts ct ON ct.id = c.contact_id
      LEFT JOIN LATERAL (
        SELECT p.raw FROM call_participants p
        WHERE p.call_id = c.id AND p.role = 'supervisor'
          AND p.user_id = ${ctx.userId} AND p.state <> 'left'
        ORDER BY p.created_at DESC LIMIT 1
      ) s ON true
      WHERE c.org_id = ${ctx.orgId} AND c.user_id <> ${ctx.userId}
        AND c.status IN ('ringing', 'in_progress')
      ORDER BY c.created_at`)
  ).rows as Array<Record<string, unknown>>;
  const now = Date.now();
  return rows.map((r) => {
    const since = (r.answered_at ?? r.created_at) as string | Date;
    return {
      call_id: String(r.id),
      direction: String(r.direction),
      status: String(r.status),
      rep: { user_id: String(r.user_id), display_name: String(r.rep_name) },
      counterparty: {
        name: r.contact_name ? String(r.contact_name) : null,
        number: String(r.direction === 'inbound' ? r.from_number : r.to_number),
      },
      answered_at: r.answered_at ? new Date(r.answered_at as string).toISOString() : null,
      duration_seconds: Math.max(0, Math.round((now - new Date(since).getTime()) / 1000)),
      monitoring: r.my_mode ? String(r.my_mode) : null,
    };
  });
}
