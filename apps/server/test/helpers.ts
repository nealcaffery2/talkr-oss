/**
 * Integration test harness: real Postgres, real Fastify app via inject(),
 * real Telnyx Ed25519 signature validation (a key pair made per run), fake
 * Podio + REST.
 */

import { generateKeyPairSync, sign } from 'node:crypto';
import pg from 'pg';
import { pino } from 'pino';
import type {
  AddParticipantParams,
  CreatePstnCallParams,
  ParticipantPatch,
  ProviderCallSnapshot,
  PurchaseNumberParams,
} from '@talkr/core';
import { createDb, migrate, type DbHandle } from '@talkr/db';
import { TelnyxVoiceProvider, SIGNATURE_HEADER, TIMESTAMP_HEADER, type TelnyxRestOverrides } from '@talkr/provider-telnyx';
import { eq } from 'drizzle-orm';
import { schema } from '@talkr/db';
import { credentialStore } from '../src/services/client-address.js';
import { provisionBrowserCredentials } from '../src/services/provision.js';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps } from '../src/app.js';
import type { Config } from '../src/config.js';
import { signTestToken } from '../src/auth.js';
import type { PodioClient } from '../src/services/podio.js';
import { JobRunner } from '../src/worker/runner.js';
import { HANDLERS } from '../src/worker/handlers.js';
import { seedDemoOrg, type SeedResult } from '../src/seed.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://postgres@127.0.0.1:5544/talkr_platform_test';

/**
 * The carrier's signing key for this run. Telnyx signs with a private key it
 * keeps and publishes the public half; the tests play Telnyx, so they hold both.
 */
const TELNYX_KEYS = generateKeyPairSync('ed25519');
/** Raw 32-byte public key, base64: the shape Telnyx publishes and TELNYX_PUBLIC_KEY holds. */
export const TEST_TELNYX_PUBLIC_KEY = Buffer.from(
  TELNYX_KEYS.publicKey.export({ format: 'der', type: 'spki' }),
).subarray(-32).toString('base64');

export const TEST_JWT_SECRET = 'test-jwt-secret-test-jwt-secret';
export const TEST_BASE_URL = 'https://talkr.test';

export function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    NODE_ENV: 'test',
    PORT: 0,
    LOG_LEVEL: 'silent',
    DATABASE_URL: TEST_DATABASE_URL,
    PUBLIC_BASE_URL: TEST_BASE_URL,
    // The CORS plugin rejects an undefined origin option outright; the schema
    // default never runs here because this bypasses parsing.
    WEB_ORIGIN: ['http://localhost:3100'],
    AUTH_JWT_SECRET: TEST_JWT_SECRET,
    RECORDINGS_DIR: './data/test-recordings',
    WORKER_INLINE: false,
    // Must match the production default, or tests silently exercise a path
    // real calls never take. Bridge-mode coverage passes it as an override.
    CALL_CONTROL_MODE: 'conference',
    RECONCILE_DELAY_MS: 0,
    JOB_BACKOFF_BASE_MS: 0,
    ...overrides,
  } as Config;
}

export class FakePodioClient implements PodioClient {
  readonly configured = true;
  comments: Array<{ itemId: string; text: string }> = [];
  failuresRemaining = 0;
  async addCommentToItem(itemId: string, text: string): Promise<{ commentId: string }> {
    if (this.failuresRemaining > 0) {
      this.failuresRemaining -= 1;
      throw new Error('podio 503 (simulated)');
    }
    this.comments.push({ itemId, text });
    return { commentId: `comment-${this.comments.length}` };
  }
}

export interface SentMessage {
  from: string;
  to: string;
  body: string;
  statusCallbackUrl?: string;
  providerMessageId: string;
}

/** Conference participant operations the fake provider was asked to perform. */
export interface ConferenceOps {
  added: Array<AddParticipantParams & { providerParticipantId: string }>;
  updated: Array<{ roomName: string; participantId: string; patch: ParticipantPatch }>;
  removed: Array<{ roomName: string; participantId: string }>;
}

export interface TestContext {
  app: FastifyInstance;
  deps: AppDeps;
  dbh: DbHandle;
  runner: JobRunner;
  podio: FakePodioClient;
  provider: TelnyxVoiceProvider;
  /** Provider REST responses for reconcile tests, keyed by provider call id. */
  providerCalls: Map<string, ProviderCallSnapshot>;
  /** SMS sends recorded by the fake provider (Phase 4). */
  sentMessages: SentMessage[];
  /** Make the next N fake SMS sends throw (retry/dead-letter tests). */
  smsFailures: { remaining: number };
  /** REST dials recorded by the fake provider (Phase 5 parallel mode). */
  providerDials: Array<CreatePstnCallParams & { providerCallId: string }>;
  /** Provider call ids the fake provider was asked to cancel (Phase 5). */
  canceledCalls: string[];
  /** Call redirects recorded by the fake provider (Telnyx client-leg recovery). */
  redirectedCalls: Array<{ providerCallId: string; url: string }>;
  /** Conference participant operations recorded by the fake provider (§9). */
  conferenceOps: ConferenceOps;
  /** Numbers the fake carrier sold and released (routes/numbers.ts). */
  numberOps: { purchased: Array<PurchaseNumberParams & { providerNumberId: string }>; released: string[] };
  seed: SeedResult;
  close(): Promise<void>;
}

/** Drop + recreate the public schema, run migrations, seed a demo org. */
export async function createTestContext(
  opts: {
    config?: Partial<Config>;
    fetchImpl?: typeof fetch;
    /**
     * Mint every seeded user's SIP credential, as the boot sweep does in
     * production; a rep without one cannot be rung. Off for tests of the
     * minting itself.
     */
    provisionCredentials?: boolean;
  } = {},
): Promise<TestContext> {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  await admin.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await admin.end();

  const dbh = createDb(TEST_DATABASE_URL, { max: 5 });
  await migrate(dbh.pool);

  const config = testConfig(opts.config);
  // TEST_LOG=error to see what a 500 in a test was about.
  const logger = pino({ level: process.env.TEST_LOG ?? 'silent' });
  const podio = new FakePodioClient();
  const providerCalls = new Map<string, ProviderCallSnapshot>();
  const sentMessages: SentMessage[] = [];
  const smsFailures = { remaining: 0 };
  const providerDials: Array<CreatePstnCallParams & { providerCallId: string }> = [];
  const canceledCalls: string[] = [];
  const redirectedCalls: Array<{ providerCallId: string; url: string }> = [];
  const conferenceOps: ConferenceOps = { added: [], updated: [], removed: [] };
  const numberOps: TestContext['numberOps'] = { purchased: [], released: [] };
  /** Fake room state, keyed by participant id. */
  const room = new Map<string, { hold: boolean; endConferenceOnExit: boolean }>();
  // Recorded instead of sent: these tests are about what the server asks the carrier for.
  const fakes: TelnyxRestOverrides = {
      fetchCall: async (sid) => providerCalls.get(sid) ?? null,
      hangupCall: async () => undefined,
      redirectCall: async (providerCallId, url) => {
        redirectedCalls.push({ providerCallId, url });
      },
      sendMessage: async (params) => {
        if (smsFailures.remaining > 0) {
          smsFailures.remaining -= 1;
          throw new Error('carrier 503 (simulated)');
        }
        const providerMessageId = `SM_fake_${sentMessages.length + 1}`;
        sentMessages.push({ ...params, providerMessageId });
        return { providerMessageId };
      },
      // Phase 5 dialers: record REST dials + cancels instead of hitting Twilio.
      createCall: async (params) => {
        const providerCallId = `CA_fake_dial_${providerDials.length + 1}`;
        providerDials.push({ ...params, providerCallId });
        return { providerCallId };
      },
      cancelCall: async (providerCallId) => {
        canceledCalls.push(providerCallId);
      },
      // Conference control (§9): record participant operations instead of
      // hitting Twilio. The room is modelled well enough that hold, merge and
      // transfer can be asserted end to end.
      addParticipant: async (params) => {
        const providerParticipantId = `CA_fake_part_${conferenceOps.added.length + 1}`;
        conferenceOps.added.push({ ...params, providerParticipantId });
        room.set(providerParticipantId, { hold: false, endConferenceOnExit: params.endConferenceOnExit ?? false });
        return { providerParticipantId, hold: false, muted: false, raw: { callSid: providerParticipantId } };
      },
      updateParticipant: async (roomName, participantId, patch) => {
        conferenceOps.updated.push({ roomName, participantId, patch });
        const cur = room.get(participantId) ?? { hold: false, endConferenceOnExit: true };
        room.set(participantId, {
          hold: patch.hold ?? cur.hold,
          endConferenceOnExit: patch.endConferenceOnExit ?? cur.endConferenceOnExit,
        });
      },
      removeParticipant: async (roomName, participantId) => {
        conferenceOps.removed.push({ roomName, participantId });
        room.delete(participantId);
      },
      listParticipants: async () =>
        [...room.entries()].map(([providerParticipantId, s]) => ({
          providerParticipantId,
          hold: s.hold,
          muted: false,
          raw: {},
        })),
      // Number inventory: a fixed San Antonio shelf, purchases and releases
      // recorded instead of billed.
      searchAvailableNumbers: async (params) =>
        ['+12105550101', '+12105550102', '+12105550103']
          .filter((n) => !params.areaCode || n.startsWith(`+1${params.areaCode}`))
          .filter((n) => !params.contains || n.includes(params.contains))
          .slice(0, params.limit ?? 10)
          .map((n) => ({
            phoneE164: n,
            locality: 'San Antonio',
            region: 'TX',
            areaCode: n.slice(2, 5),
            capabilities: { voice: true, sms: true, mms: true },
          })),
      purchaseNumber: async (params) => {
        const providerNumberId = `PN_fake_${numberOps.purchased.length + 1}`;
        numberOps.purchased.push({ ...params, providerNumberId });
        return { providerNumberId, phoneE164: params.phoneE164, capabilities: { voice: true, sms: true, mms: true } };
      },
      releaseNumber: async (providerNumberId) => {
        numberOps.released.push(providerNumberId);
      },
  };
  const provider = new TelnyxVoiceProvider(
          {
            apiKey: 'telnyx-test-key',
            publicKey: TEST_TELNYX_PUBLIC_KEY,
            accountId: 'telnyx-acct-test',
            texmlApplicationId: 'texml-app-test',
            sipConnectionId: 'sip-conn-test',
          },
          {
            ...fakes,
            // No round-trip to Telnyx for a credential token in tests.
            mintClientToken: async (identity, ttlSeconds) => ({ token: `telnyx-fake-${identity}`, identity, ttlSeconds }),
            // Credentials persist like production (telephony_credentials) and
            // creation answers like Telnyx would: a generated SIP username.
            credentialStore: credentialStore(dbh, async (userId) => {
              const row = (await dbh.db.select({ orgId: schema.users.orgId }).from(schema.users).where(eq(schema.users.id, userId)).limit(1))[0];
              return row?.orgId ?? null;
            }),
            fetchImpl: (async (url: string | URL | Request, init?: RequestInit) => {
              if (String(url).endsWith('/telephony_credentials') && init?.method === 'POST') {
                const body = JSON.parse(String(init.body)) as { name: string };
                const id = `cred-${body.name.replace('talkr-', '')}`;
                return new Response(JSON.stringify({ data: { id, sip_username: `gencred${id.slice(5, 13)}` } }), { status: 201 });
              }
              return new Response('unexpected telnyx call in test', { status: 599 });
            }) as typeof fetch,
          },
        );

  const deps: AppDeps = { config, dbh, provider, podio, logger, fetchImpl: opts.fetchImpl };
  const app = buildApp(deps);
  const runner = new JobRunner(
    { dbh, provider, podio, config, logger, fetchImpl: opts.fetchImpl },
    HANDLERS,
    { backoffBaseMs: 0 },
  );

  const seed = await seedDemoOrg(dbh.db, { slug: 'test-org', externalItemId: 'podio-item-42' });
  if (opts.provisionCredentials !== false) await provisionBrowserCredentials(dbh, provider);

  return {
    app,
    deps,
    dbh,
    runner,
    podio,
    provider,
    providerCalls,
    sentMessages,
    smsFailures,
    providerDials,
    canceledCalls,
    redirectedCalls,
    conferenceOps,
    numberOps,
    seed,
    close: async () => {
      await app.close();
      await dbh.close();
    },
  };
}

/**
 * POST a TeXML-style form body the way Telnyx delivers it: Ed25519 over
 * `{timestamp}|{raw body}`, valid or deliberately broken.
 */
export async function webhookPost(
  ctx: TestContext,
  path: string,
  params: Record<string, string>,
  opts: { tamperSignature?: boolean } = {},
) {
  const body = new URLSearchParams(params).toString();
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signed = sign(null, Buffer.from(`${timestamp}|${body}`, 'utf8'), TELNYX_KEYS.privateKey);
  // Flip a byte rather than append: the length must stay valid for the check to reach the maths.
  if (opts.tamperSignature) signed.writeUInt8(signed.readUInt8(0) ^ 0xff, 0);
  return ctx.app.inject({
    method: 'POST',
    url: path,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      [SIGNATURE_HEADER]: signed.toString('base64'),
      [TIMESTAMP_HEADER]: timestamp,
    },
    payload: body,
  });
}

/** The SIP URI Telnyx rings a rep's browser at: the credential the harness minted for them. */
export async function repAddress(ctx: TestContext, userId: string): Promise<string> {
  const [cred] = await ctx.dbh.db
    .select()
    .from(schema.telephonyCredentials)
    .where(eq(schema.telephonyCredentials.userId, userId))
    .limit(1);
  if (!cred?.sipUsername) throw new Error(`no SIP credential for ${userId}`);
  return `sip:${cred.sipUsername}@sip.telnyx.com`;
}

/** The reps a TeXML answer rings, as user ids, in document order. */
export async function rungUsers(ctx: TestContext, body: string): Promise<string[]> {
  const creds = await ctx.dbh.db.select().from(schema.telephonyCredentials);
  const byUsername = new Map(creds.map((c) => [c.sipUsername, c.userId]));
  return [...body.matchAll(/<Sip[^>]*>sip:([^@<]+)@[^<]*<\/Sip>/g)].map((m) => byUsername.get(m[1]!) ?? `unknown:${m[1]}`);
}

export async function authHeader(authUserId: string): Promise<Record<string, string>> {
  const token = await signTestToken(TEST_JWT_SECRET, authUserId);
  return { authorization: `Bearer ${token}` };
}
