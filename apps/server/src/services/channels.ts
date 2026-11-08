/**
 * iMessage (Sendblue) and RCS (Telnyx) next to SMS (docs/messaging-channels.md).
 *
 * Everything here is off until configured: no Sendblue keys means no Sendblue
 * client, no TELNYX_RCS_AGENT_ID means the carrier adapter reports no RCS
 * agent, and a line without its switch never asks. In every one of those
 * cases a text goes exactly as before, SMS through Telnyx.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  selectMessageChannel,
  type ChannelSelection,
  type ChannelSupport,
  type MessagingProvider,
} from '@talkr/core';
import { schema, type DbHandle } from '@talkr/db';
import { SendblueClient } from '@talkr/provider-sendblue';
import type { Config } from '../config.js';

type Db = DbHandle['db'];
type NumberRow = typeof schema.phoneNumbers.$inferSelect;

/** How long a capability answer is trusted. People switch phones; not hourly. */
const SUPPORTED_TTL_MS = 30 * 24 * 3600_000;
const UNSUPPORTED_TTL_MS = 7 * 24 * 3600_000;

const clients = new WeakMap<Config, SendblueClient | null>();

/** The Sendblue client for this deployment, or null when its keys are not set. */
export function sendblueClientFor(config: Config, fetchImpl?: typeof fetch): SendblueClient | null {
  if (!fetchImpl && clients.has(config)) return clients.get(config) ?? null;
  const client =
    config.SENDBLUE_API_KEY_ID && config.SENDBLUE_API_SECRET
      ? new SendblueClient(
          {
            apiKeyId: config.SENDBLUE_API_KEY_ID,
            apiSecret: config.SENDBLUE_API_SECRET,
            defaultFromNumber: config.SENDBLUE_FROM_NUMBER,
            webhookSecret: config.SENDBLUE_WEBHOOK_SECRET,
            apiBase: config.SENDBLUE_API_BASE,
          },
          fetchImpl,
        )
      : null;
  if (!fetchImpl) clients.set(config, client);
  return client;
}

/** Deps carry an injected client in tests; production builds it from config. */
export function resolveSendblue(deps: { config: Config; sendblue?: SendblueClient | null }): SendblueClient | null {
  return deps.sendblue !== undefined ? deps.sendblue : sendblueClientFor(deps.config);
}

/** The Sendblue number a Talkr line sends iMessage from, if it has one. */
export function sendblueFromFor(line: Pick<NumberRow, 'sendblueFromNumber'>, config: Config): string | null {
  return line.sendblueFromNumber || config.SENDBLUE_FROM_NUMBER || null;
}

/**
 * Cached capability answer, else ask and remember a definite answer. An
 * `unknown` is never stored, so the next send asks again.
 */
export async function probeCapability(
  db: Db,
  channel: 'imessage' | 'rcs',
  phoneE164: string,
  lookup: () => Promise<ChannelSupport>,
  now: Date = new Date(),
): Promise<ChannelSupport> {
  const cached = (
    await db
      .select()
      .from(schema.channelCapabilities)
      .where(and(eq(schema.channelCapabilities.phoneE164, phoneE164), eq(schema.channelCapabilities.channel, channel)))
      .limit(1)
  )[0];
  if (cached) {
    const ttl = cached.supported ? SUPPORTED_TTL_MS : UNSUPPORTED_TTL_MS;
    if (now.getTime() - cached.checkedAt.getTime() < ttl) return cached.supported ? 'supported' : 'unsupported';
  }
  const answer = await lookup();
  if (answer !== 'unknown') {
    await db
      .insert(schema.channelCapabilities)
      .values({ phoneE164, channel, supported: answer === 'supported', checkedAt: now })
      .onConflictDoUpdate({
        target: [schema.channelCapabilities.phoneE164, schema.channelCapabilities.channel],
        set: { supported: answer === 'supported', checkedAt: now },
      });
  }
  return answer;
}

export interface OutboundChannel extends ChannelSelection {
  /** Sendblue line to send from, when the channel is iMessage. */
  sendblueFrom?: string;
}

/**
 * Which channel one outbound message takes. Pure selection lives in core
 * (`selectMessageChannel`); this supplies the configuration and the cached
 * lookups.
 */
export async function chooseOutboundChannel(
  db: Db,
  args: {
    config: Config;
    provider: MessagingProvider;
    sendblue: SendblueClient | null;
    line: NumberRow | null;
    to: string;
    mediaCount: number;
  },
): Promise<OutboundChannel> {
  const { config, provider, sendblue, line, to, mediaCount } = args;
  const sendblueFrom = line ? sendblueFromFor(line, config) : null;
  const selection = await selectMessageChannel(
    {
      imessageConfigured: Boolean(sendblue),
      imessageLineEnabled: Boolean(line?.imessageEnabled && sendblueFrom),
      rcsConfigured: Boolean(provider.rcsAgentId && provider.sendRcsMessage && provider.checkRcsCapability),
      rcsLineEnabled: Boolean(line?.rcsEnabled),
      mediaCount,
    },
    (channel) =>
      channel === 'imessage'
        ? probeCapability(db, 'imessage', to, () => sendblue!.evaluateService(to))
        : probeCapability(db, 'rcs', to, () => provider.checkRcsCapability!(to)),
  );
  return selection.channel === 'imessage' ? { ...selection, sendblueFrom: sendblueFrom! } : selection;
}

/** The phone_numbers row a conversation sends from. */
export async function lineForConversation(
  db: Db,
  conversation: { orgId: string; phoneNumberId: string | null; ourNumber: string },
): Promise<NumberRow | null> {
  const rows = conversation.phoneNumberId
    ? await db.select().from(schema.phoneNumbers).where(eq(schema.phoneNumbers.id, conversation.phoneNumberId)).limit(1)
    : await db
        .select()
        .from(schema.phoneNumbers)
        .where(and(eq(schema.phoneNumbers.orgId, conversation.orgId), eq(schema.phoneNumbers.phoneE164, conversation.ourNumber)))
        .limit(1);
  return rows[0] ?? null;
}

/**
 * Which Talkr line an inbound iMessage belongs to. It arrives on a Sendblue
 * number, but the thread lives under the Talkr number so SMS and iMessage with
 * one person read as one conversation:
 *   1. the line that names this Sendblue number;
 *   2. for the shared SENDBLUE_FROM_NUMBER: the iMessage line this person was
 *      last texting with, else the only iMessage line using the default;
 *   3. a Talkr number that is itself the Sendblue number.
 * Null is an orphan; the caller records it rather than guessing.
 */
export async function resolveSendblueLine(
  db: Db,
  config: Config,
  sendblueNumber: string,
  theirNumber: string,
): Promise<NumberRow | null> {
  const named = (
    await db.select().from(schema.phoneNumbers).where(eq(schema.phoneNumbers.sendblueFromNumber, sendblueNumber)).limit(1)
  )[0];
  if (named) return named;

  if (config.SENDBLUE_FROM_NUMBER && sendblueNumber === config.SENDBLUE_FROM_NUMBER) {
    const recent = (
      await db
        .select({ line: schema.phoneNumbers })
        .from(schema.conversations)
        .innerJoin(schema.phoneNumbers, eq(schema.phoneNumbers.phoneE164, schema.conversations.ourNumber))
        .where(
          and(
            eq(schema.conversations.theirNumber, theirNumber),
            eq(schema.phoneNumbers.imessageEnabled, true),
            isNull(schema.phoneNumbers.sendblueFromNumber),
          ),
        )
        .orderBy(desc(sql`COALESCE(${schema.conversations.lastMessageAt}, ${schema.conversations.createdAt})`))
        .limit(1)
    )[0];
    if (recent) return recent.line;
    const defaults = await db
      .select()
      .from(schema.phoneNumbers)
      .where(
        and(
          eq(schema.phoneNumbers.imessageEnabled, true),
          isNull(schema.phoneNumbers.sendblueFromNumber),
          eq(schema.phoneNumbers.status, 'active'),
        ),
      )
      .limit(2);
    if (defaults.length === 1) return defaults[0]!;
  }

  const same = (
    await db.select().from(schema.phoneNumbers).where(eq(schema.phoneNumbers.phoneE164, sendblueNumber)).limit(1)
  )[0];
  return same ?? null;
}

/**
 * Which Talkr number an inbound RCS message files under. RCS arrives
 * addressed to the agent, so: the RCS line this person last texted with, else
 * TELNYX_RCS_INBOUND_NUMBER. Null is an orphan.
 */
export async function resolveRcsLine(db: Db, config: Config, theirNumber: string): Promise<string | null> {
  const recent = (
    await db
      .select({ ourNumber: schema.conversations.ourNumber })
      .from(schema.conversations)
      .innerJoin(schema.phoneNumbers, eq(schema.phoneNumbers.phoneE164, schema.conversations.ourNumber))
      .where(and(eq(schema.conversations.theirNumber, theirNumber), eq(schema.phoneNumbers.rcsEnabled, true)))
      .orderBy(desc(sql`COALESCE(${schema.conversations.lastMessageAt}, ${schema.conversations.createdAt})`))
      .limit(1)
  )[0];
  return recent?.ourNumber ?? config.TELNYX_RCS_INBOUND_NUMBER ?? null;
}

/**
 * Sendblue's per-message `status_callback` is a URL we choose, and its docs do
 * not say the webhook secret header rides on it. So the URL carries a token
 * only this deployment can make: HMAC of a fixed label under the webhook
 * secret (or the API secret when no webhook secret is set).
 */
export function sendblueCallbackToken(config: Config): string | null {
  const key = config.SENDBLUE_WEBHOOK_SECRET ?? config.SENDBLUE_API_SECRET;
  if (!key) return null;
  return createHmac('sha256', key).update('talkr:sendblue-status-callback:v1').digest('hex').slice(0, 40);
}

export function verifySendblueCallbackToken(config: Config, given: string | undefined): boolean {
  const expected = sendblueCallbackToken(config);
  if (!expected || !given) return false;
  const a = Buffer.from(given, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function sendblueStatusCallbackUrl(config: Config): string {
  const token = sendblueCallbackToken(config);
  return `${config.PUBLIC_BASE_URL}/webhooks/sendblue/status${token ? `?token=${token}` : ''}`;
}
