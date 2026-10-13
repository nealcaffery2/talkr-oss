/**
 * Outbound AI calls via Telnyx TeXML AI Assistants
 * (POST /v2/texml/ai_calls/:connection_id).
 *
 * The Assistant must already use ElevenLabs (or another voice) in Mission
 * Control; we pass AIAssistantId + From/To and enforce Talkr suppression +
 * org ai_agent settings before dialing.
 */

import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { normalizePhone, readAiAgent } from '@talkr/core';
import { publishBusEvent, schema, type DbHandle } from '@talkr/db';
import type { Config } from '../config.js';
import type { AuthContext } from '../auth.js';
import { writeAudit } from './audit.js';
import { chooseCallerId } from './caller-id.js';

export class AiCallError extends Error {
  constructor(
    public readonly code:
      | 'not_configured'
      | 'disabled'
      | 'suppressed'
      | 'invalid_number'
      | 'no_caller_id'
      | 'telnyx_failed'
      | 'not_found',
    message: string,
  ) {
    super(message);
  }
}

export interface CreateAiCallInput {
  toNumber?: string;
  contactId?: string;
  fromPhoneNumberId?: string;
  /** Extra dynamic variables for the assistant (name, address, …). */
  variables?: Record<string, string>;
}

export interface AiCallResult {
  call: typeof schema.calls.$inferSelect;
  provider_call_id: string | null;
  assistant_id: string;
  takeover_e164: string | null;
}

export async function createOutboundAiCall(
  dbh: DbHandle,
  ctx: AuthContext,
  config: Config,
  input: CreateAiCallInput,
  opts: { fetchImpl?: typeof fetch } = {},
): Promise<AiCallResult> {
  const { db } = dbh;
  const apiKey = config.TELNYX_API_KEY?.trim();
  const texmlAppId = config.TELNYX_TEXML_APP_ID?.trim();
  if (!apiKey || !texmlAppId) {
    throw new AiCallError(
      'not_configured',
      'AI calling needs TELNYX_API_KEY and TELNYX_TEXML_APP_ID on the Talkr server.',
    );
  }

  const org = (
    await db
      .select({ settings: schema.organizations.settings })
      .from(schema.organizations)
      .where(eq(schema.organizations.id, ctx.orgId))
      .limit(1)
  )[0];
  const agent = readAiAgent(org?.settings);
  if (!agent.enabled || !agent.assistant_id) {
    throw new AiCallError(
      'disabled',
      'Enable AI calling under org settings and set a Telnyx Assistant id.',
    );
  }

  let toNumber = input.toNumber;
  let contactId = input.contactId ?? null;
  if (!toNumber && contactId) {
    const phone = (
      await db
        .select()
        .from(schema.contactPhones)
        .where(
          and(eq(schema.contactPhones.contactId, contactId), eq(schema.contactPhones.orgId, ctx.orgId)),
        )
        .orderBy(sql`${schema.contactPhones.isPrimary} DESC`)
        .limit(1)
    )[0];
    toNumber = phone?.phoneE164 ?? undefined;
  }
  if (!toNumber) throw new AiCallError('invalid_number', 'destination number is required');
  const normalized = normalizePhone(toNumber);
  if (!normalized.ok) throw new AiCallError('invalid_number', `invalid phone: ${toNumber}`);
  toNumber = normalized.e164;

  if (contactId) {
    const contact = (
      await db
        .select({ status: schema.contacts.status })
        .from(schema.contacts)
        .where(and(eq(schema.contacts.id, contactId), eq(schema.contacts.orgId, ctx.orgId)))
        .limit(1)
    )[0];
    if (contact?.status === 'dnc') {
      throw new AiCallError('suppressed', 'contact is marked DNC');
    }
  }

  const suppressed = (
    await db
      .select({ id: schema.suppressionRecords.id })
      .from(schema.suppressionRecords)
      .where(
        and(
          eq(schema.suppressionRecords.orgId, ctx.orgId),
          eq(schema.suppressionRecords.phoneE164, toNumber),
          eq(schema.suppressionRecords.scope, 'org'),
          or(
            eq(schema.suppressionRecords.channel, 'voice'),
            eq(schema.suppressionRecords.channel, 'all'),
          ),
          or(isNull(schema.suppressionRecords.expiresAt), sql`${schema.suppressionRecords.expiresAt} > now()`),
        ),
      )
      .limit(1)
  )[0];
  if (suppressed) {
    throw new AiCallError('suppressed', 'destination is on the voice suppression list');
  }

  const user = (
    await db.select().from(schema.users).where(eq(schema.users.id, ctx.userId)).limit(1)
  )[0];
  const fromNumber = await chooseCallerId(db, ctx, {
    toNumber,
    overridePhoneNumberId: input.fromPhoneNumberId ?? null,
    user: user ?? null,
  });
  if (!fromNumber) throw new AiCallError('no_caller_id', 'org has no active phone number');

  const doFetch = opts.fetchImpl ?? fetch;
  const url = `https://api.telnyx.com/v2/texml/ai_calls/${encodeURIComponent(texmlAppId)}`;
  const body: Record<string, unknown> = {
    From: fromNumber.phoneE164,
    To: toNumber,
    AIAssistantId: agent.assistant_id,
    MachineDetection: 'Enable',
    AsyncAmd: true,
    DetectionMode: 'Premium',
  };
  if (agent.consent_intro || agent.takeover_e164 || input.variables) {
    body.AIAssistantDynamicVariables = {
      ...(agent.consent_intro ? { consent_intro: agent.consent_intro } : {}),
      ...(agent.takeover_e164 ? { takeover_e164: agent.takeover_e164 } : {}),
      ...(input.variables ?? {}),
    };
  }

  const res = await doFetch(url, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new AiCallError('telnyx_failed', `Telnyx ${res.status}: ${text.slice(0, 400)}`);
  }
  const payload = (await res.json()) as {
    data?: { call_control_id?: string; call_session_id?: string; call_leg_id?: string };
    call_control_id?: string;
  };
  const providerCallId =
    payload.data?.call_control_id ??
    payload.data?.call_session_id ??
    payload.call_control_id ??
    null;

  const call = (
    await db
      .insert(schema.calls)
      .values({
        orgId: ctx.orgId,
        userId: ctx.userId,
        direction: 'outbound',
        status: 'queued',
        contactId,
        phoneNumberId: fromNumber.id,
        fromNumber: fromNumber.phoneE164,
        toNumber,
        provider: 'telnyx',
        providerCallId,
        initiatedAt: new Date(),
        raw: {
          ai_agent: true,
          assistant_id: agent.assistant_id,
          elevenlabs_voice_id: agent.elevenlabs_voice_id ?? null,
          takeover_e164: agent.takeover_e164 ?? null,
          consent_intro: agent.consent_intro ?? null,
        },
      })
      .returning()
  )[0]!;

  await writeAudit(db, {
    orgId: ctx.orgId,
    actorType: 'user',
    actorId: ctx.userId,
    action: 'ai_call.create',
    objectType: 'call',
    objectId: call.id,
    metadata: {
      to_last4: toNumber.slice(-4),
      assistant_id: agent.assistant_id,
      provider_call_id: providerCallId,
    },
    correlationId: call.correlationId,
  });

  await publishBusEvent(dbh.pool, {
    type: 'call.initiated',
    orgId: ctx.orgId,
    userId: ctx.userId,
    callId: call.id,
    data: { ai_agent: true, to_last4: toNumber.slice(-4) },
  });

  return {
    call,
    provider_call_id: providerCallId,
    assistant_id: agent.assistant_id,
    takeover_e164: agent.takeover_e164 ?? null,
  };
}
