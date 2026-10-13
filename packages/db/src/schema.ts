/**
 * Talkr Platform schema (Drizzle). Explained in docs/data-model.md.
 * Migrations are generated with `npm run db:generate` into packages/db/migrations
 * plus hand-written expression indexes in numbered custom migrations.
 */

import { sql } from 'drizzle-orm';
import {
  boolean,
  customType,
  index,
  integer,
  jsonb,
  numeric,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';

const now = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow();
const ts = (name: string) => timestamp(name, { withTimezone: true });

// ---------------------------------------------------------------------------
// Enums (stable closed sets only; evolving sets are text)
// ---------------------------------------------------------------------------
export const userRole = pgEnum('user_role', ['owner', 'admin', 'manager', 'rep']);
export const callDirection = pgEnum('call_direction', ['outbound', 'inbound']);
export const callStatus = pgEnum('call_status', [
  'queued', 'initiated', 'ringing', 'in_progress',
  'completed', 'no_answer', 'busy', 'failed', 'canceled',
]);
export const failureClass = pgEnum('failure_class', [
  'none', 'seller_no_answer', 'seller_busy', 'carrier_failure', 'platform_failure', 'canceled',
]);

// ---------------------------------------------------------------------------
// Identity & tenancy
// ---------------------------------------------------------------------------
export const organizations = pgTable('organizations', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  settings: jsonb('settings').notNull().default({}),
  /** {sms_gate, ten_dlc snapshot} — packages/core/src/reputation.ts (migration 0023). */
  reputation: jsonb('reputation').notNull().default({}),
  createdAt: now(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  authUserId: text('auth_user_id').unique(),
  email: text('email').notNull(),
  displayName: text('display_name').notNull(),
  role: userRole('role').notNull().default('rep'),
  /**
   * The job, not the permission: "Acquisitions", "Dispo", "Sales manager".
   * `role` is the RBAC boundary and is a terrible thing to show a person —
   * nobody's business card says "rep".
   */
  title: text('title'),
  status: text('status').notNull().default('active'), // active|invited|disabled
  /**
   * IANA zone the person actually works in. Transfers and the team roster are
   * useless without it — handing a seller to a teammate at 3am theirs is how
   * you lose both. Null means "unknown", which the UI shows as such rather
   * than guessing.
   */
  timezone: text('timezone'),
  /** Human label for that zone ("Cleveland, OH") — an IANA id is not a place. */
  city: text('city'),
  defaultPhoneNumberId: uuid('default_phone_number_id')
    .references((): AnyPgColumn => phoneNumbers.id),
  /**
   * 'dedicated' always dials out from the default number; 'local_presence'
   * picks an org number whose area code matches the destination first
   * (services/caller-id.ts). Text, not an enum, for the same reason as title.
   */
  callerIdMode: text('caller_id_mode').notNull().default('dedicated'),
  /** The rep's own phone: where a call flow forwards what they miss. */
  personalPhoneE164: text('personal_phone_e164'),
  /** Their voicemail greeting, {tts} or {audio_url} (core FlowGreeting). */
  voicemailGreeting: jsonb('voicemail_greeting'),
  createdAt: now(),
}, (t) => [
  uniqueIndex('users_org_email_uq').on(t.orgId, t.email),
  index('users_org_idx').on(t.orgId),
]);

export const teams = pgTable('teams', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  createdAt: now(),
});

export const teamMembers = pgTable('team_members', {
  teamId: uuid('team_id').notNull().references(() => teams.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.teamId, t.userId] })]);

// ---------------------------------------------------------------------------
// CRM linkage
// ---------------------------------------------------------------------------
export const crmConnections = pgTable('crm_connections', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  provider: text('provider').notNull(), // 'podio'
  status: text('status').notNull().default('active'), // active|degraded|disabled
  externalOrgId: text('external_org_id'),
  // Secret material is ciphertext-only here (docs/security.md §4).
  settings: jsonb('settings').notNull().default({}),
  createdAt: now(),
});

export const crmFieldMappings = pgTable('crm_field_mappings', {
  id: uuid('id').primaryKey().defaultRandom(),
  connectionId: uuid('connection_id').notNull().references(() => crmConnections.id, { onDelete: 'cascade' }),
  entity: text('entity').notNull(), // lead|contact|property
  externalAppId: text('external_app_id').notNull(),
  externalFieldId: text('external_field_id').notNull(),
  internalField: text('internal_field').notNull(),
  direction: text('direction').notNull().default('inbound'), // inbound|outbound|both
  transform: jsonb('transform').notNull().default({}),
}, (t) => [
  uniqueIndex('crm_field_mappings_uq').on(t.connectionId, t.externalAppId, t.externalFieldId, t.internalField),
]);

/**
 * A person or company the org talks to (docs/contacts.md). The CRM surface
 * hangs off this row; the phone book (`contact_phones`) and the property
 * (`leads` → `properties`) stay where they were. `type`, `status` and
 * `temperature` are text with vocabularies in packages/core/src/contacts.ts.
 * Deletes are soft (`deleted_at`) so call history keeps its name.
 */
export const contacts = pgTable('contacts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  displayName: text('display_name').notNull().default(''),
  raw: jsonb('raw').notNull().default({}),
  /** seller|buyer|title|company|vendor|other */
  type: text('type').notNull().default('seller'),
  /** new|attempting|engaged|appointment|offer|under_contract|closed|dead|dnc */
  status: text('status').notNull().default('new'),
  email: text('email'),
  company: text('company'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  source: text('source'),
  notes: text('notes'),
  /** hot|warm|cold — derived from temperature_score unless locked by a person. */
  temperature: text('temperature').notNull().default('cold'),
  temperatureScore: integer('temperature_score').notNull().default(0),
  temperatureLocked: boolean('temperature_locked').notNull().default(false),
  temperatureUpdatedAt: ts('temperature_updated_at'),
  /** max(call at, message at) across everything matched to this contact. */
  lastActivityAt: ts('last_activity_at'),
  assignedUserId: uuid('assigned_user_id').references((): AnyPgColumn => users.id),
  createdBy: uuid('created_by').references((): AnyPgColumn => users.id),
  createdAt: now(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
}, (t) => [
  index('contacts_org_idx').on(t.orgId),
  index('contacts_org_type_idx').on(t.orgId, t.type),
  index('contacts_org_status_idx').on(t.orgId, t.status),
  index('contacts_org_temperature_idx').on(t.orgId, t.temperatureScore.desc()),
  index('contacts_org_deleted_idx').on(t.orgId, t.deletedAt),
  index('contacts_org_activity_idx').on(t.orgId, t.lastActivityAt.desc()),
  index('contacts_tags_gin_idx').using('gin', t.tags),
]);

export const contactPhones = pgTable('contact_phones', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  contactId: uuid('contact_id').notNull().references(() => contacts.id, { onDelete: 'cascade' }),
  phoneE164: text('phone_e164').notNull(),
  label: text('label'),
  isPrimary: boolean('is_primary').notNull().default(false),
}, (t) => [
  uniqueIndex('contact_phones_uq').on(t.orgId, t.contactId, t.phoneE164),
  // Inbound caller recognition path — must stay indexed.
  index('contact_phones_lookup_idx').on(t.orgId, t.phoneE164),
]);

export const properties = pgTable('properties', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  addressLine1: text('address_line1'),
  city: text('city'),
  state: text('state'),
  postalCode: text('postal_code'),
  raw: jsonb('raw').notNull().default({}),
  createdAt: now(),
});

export const leads = pgTable('leads', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  crmConnectionId: uuid('crm_connection_id').references(() => crmConnections.id),
  externalItemId: text('external_item_id'),
  status: text('status').notNull().default('new'),
  source: text('source'),
  assignedUserId: uuid('assigned_user_id').references(() => users.id),
  propertyId: uuid('property_id').references(() => properties.id),
  primaryContactId: uuid('primary_contact_id').references(() => contacts.id),
  raw: jsonb('raw').notNull().default({}),
  // Speed-to-lead ladder — each written exactly once, first-write-wins.
  externalCreatedAt: ts('external_created_at'),
  receivedAt: ts('received_at'),
  assignedAt: ts('assigned_at'),
  firstAttemptAt: ts('first_attempt_at'),
  firstAnswerAt: ts('first_answer_at'),
  firstConversationAt: ts('first_conversation_at'),
  createdAt: now(),
}, (t) => [
  uniqueIndex('leads_external_uq').on(t.crmConnectionId, t.externalItemId),
  index('leads_org_status_idx').on(t.orgId, t.status),
  index('leads_assigned_idx').on(t.assignedUserId),
]);

// ---------------------------------------------------------------------------
// Numbers
// ---------------------------------------------------------------------------
export const phoneNumbers = pgTable('phone_numbers', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  provider: text('provider').notNull().default('telnyx'),
  providerNumberId: text('provider_number_id'),
  phoneE164: text('phone_e164').notNull().unique(),
  capabilities: jsonb('capabilities').notNull().default({ voice: true, sms: false, mms: false }),
  status: text('status').notNull().default('active'), // active|releasing|released
  assignedUserId: uuid('assigned_user_id').references((): AnyPgColumn => users.id),
  assignedTeamId: uuid('assigned_team_id').references(() => teams.id),
  areaCode: text('area_code'),
  label: text('label'),
  /** External phone forwarding target when no agent can take the call. */
  forwardToE164: text('forward_to_e164'),
  /** Queue this number feeds (marketing/team lines). */
  queueId: uuid('queue_id').references((): AnyPgColumn => queues.id),
  /** IVR digit menu config (core IvrConfig shape); null = no IVR. */
  ivr: jsonb('ivr'),
  /** {protection: caps, check: last CNAM / spam lookup} — packages/core/src/reputation.ts (migration 0023). */
  reputation: jsonb('reputation').notNull().default({}),
  /**
   * Default routing (no flow) tries the rep who last reached out to the caller
   * before the lead owner — for pool numbers outbound calls and RVMs rotate
   * through (docs/inbound-routing.md §10, migration 0027).
   */
  routeCallbacksToLastContact: boolean('route_callbacks_to_last_contact').notNull().default(false),
  purchasedAt: ts('purchased_at'),
  releasedAt: ts('released_at'),
  createdAt: now(),
}, (t) => [index('phone_numbers_org_idx').on(t.orgId, t.status)]);

/**
 * Call queues (docs/inbound-routing.md §9): ring strategy over members with a
 * hold-wait loop and overflow. Not a PBX hold queue — the caller hears the
 * wait message while the router re-evaluates availability each cycle.
 */
export const queues = pgTable('queues', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  strategy: text('strategy').notNull().default('simultaneous'), // simultaneous|round_robin|longest_idle
  maxWaitSeconds: integer('max_wait_seconds').notNull().default(90),
  waitMessage: text('wait_message'),
  overflow: text('overflow').notNull().default('voicemail'), // voicemail|forward
  overflowForwardE164: text('overflow_forward_e164'),
  createdAt: now(),
}, (t) => [uniqueIndex('queues_org_name_uq').on(t.orgId, t.name)]);

export const queueMembers = pgTable('queue_members', {
  queueId: uuid('queue_id').notNull().references(() => queues.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
}, (t) => [primaryKey({ columns: [t.queueId, t.userId] })]);

/**
 * Agent presence for inbound routing (docs/inbound-routing.md §2).
 * Availability = status 'available' AND last_seen_at within the freshness
 * window — a crashed browser goes stale and stops being rung automatically.
 */
export const agentPresence = pgTable('agent_presence', {
  userId: uuid('user_id').primaryKey().references(() => users.id, { onDelete: 'cascade' }),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  status: text('status').notNull().default('offline'), // available|away|offline
  lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
  /** Ring fairness: round_robin picks the member rung longest ago. */
  lastRungAt: ts('last_rung_at'),
  /** longest_idle picks the member whose last call ended longest ago. */
  lastCallEndedAt: ts('last_call_ended_at'),
}, (t) => [index('agent_presence_org_idx').on(t.orgId, t.status)]);

/**
 * A rep's browser credential with the voice provider.
 *
 * Telnyx generates the SIP username (`gencred…`) when the credential is
 * created, so the mapping from platform user to dialable address exists only
 * if we store it. Without this the address would have to be re-derived by
 * creating a fresh credential on every cold start, which both leaks
 * credentials and changes the address a rep is reachable at mid-shift.
 */
export const telephonyCredentials = pgTable('telephony_credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  userId: uuid('user_id').notNull().references((): AnyPgColumn => users.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull(),
  /** Provider-side credential id, used to remint short-lived tokens. */
  providerCredentialId: text('provider_credential_id').notNull(),
  /** The generated SIP username; the local part of the dialable SIP URI. */
  sipUsername: text('sip_username').notNull(),
  createdAt: now(),
}, (t) => [
  // One credential per rep per provider, so a migration between carriers keeps
  // both rows rather than fighting over one.
  uniqueIndex('telephony_credentials_user_provider_uq').on(t.userId, t.provider),
  index('telephony_credentials_org_idx').on(t.orgId),
]);

// ---------------------------------------------------------------------------
// Calls
// ---------------------------------------------------------------------------
export const callDispositions = pgTable('call_dispositions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  slug: text('slug').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  isSystem: boolean('is_system').notNull().default(false),
  isActive: boolean('is_active').notNull().default(true),
  requiresFollowUp: boolean('requires_follow_up').notNull().default(false),
  treatAsConversation: boolean('treat_as_conversation').notNull().default(false),
  /** Selecting this disposition writes a suppression record (e.g. DNC). */
  addsSuppression: boolean('adds_suppression').notNull().default(false),
}, (t) => [uniqueIndex('call_dispositions_uq').on(t.orgId, t.slug)]);

export const calls = pgTable('calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  correlationId: uuid('correlation_id').notNull().defaultRandom(),
  direction: callDirection('direction').notNull(),
  status: callStatus('status').notNull().default('queued'),
  userId: uuid('user_id').references(() => users.id),
  leadId: uuid('lead_id').references(() => leads.id),
  contactId: uuid('contact_id').references(() => contacts.id),
  phoneNumberId: uuid('phone_number_id').references(() => phoneNumbers.id),
  fromNumber: text('from_number').notNull(),
  toNumber: text('to_number').notNull(),
  provider: text('provider').notNull().default('telnyx'),
  /** Parent-leg provider SID; set when provider first tells us about the call. */
  providerCallId: text('provider_call_id').unique(),
  initiatedAt: ts('initiated_at'),
  ringingAt: ts('ringing_at'),
  answeredAt: ts('answered_at'),
  endedAt: ts('ended_at'),
  durationSeconds: integer('duration_seconds'),
  failureClass: failureClass('failure_class').notNull().default('none'),
  failureDetail: text('failure_detail'),
  dispositionId: uuid('disposition_id').references(() => callDispositions.id),
  dispositionNote: text('disposition_note'),
  followUpAt: ts('follow_up_at'),
  wrapupCompletedAt: ts('wrapup_completed_at'),
  priceCents: integer('price_cents'),
  priceCurrency: text('price_currency'),
  crmSyncStatus: text('crm_sync_status').notNull().default('none'), // none|pending|synced|failed
  raw: jsonb('raw').notNull().default({}),
  createdAt: now(),
}, (t) => [
  index('calls_org_created_idx').on(t.orgId, t.createdAt),
  index('calls_org_user_idx').on(t.orgId, t.userId),
  index('calls_lead_idx').on(t.leadId),
  index('calls_status_idx').on(t.status),
  index('calls_number_from_created_idx').on(t.phoneNumberId, t.fromNumber, t.createdAt),
  index('calls_org_to_created_idx').on(t.orgId, t.toNumber, t.createdAt),
]);

export const callLegs = pgTable('call_legs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  callId: uuid('call_id').notNull().references(() => calls.id, { onDelete: 'cascade' }),
  legRole: text('leg_role').notNull(), // client|pstn|other
  provider: text('provider').notNull().default('telnyx'),
  providerCallId: text('provider_call_id').notNull().unique(),
  status: text('status').notNull().default('initiated'),
  fromNumber: text('from_number'),
  toNumber: text('to_number'),
  startedAt: ts('started_at'),
  answeredAt: ts('answered_at'),
  endedAt: ts('ended_at'),
  durationSeconds: integer('duration_seconds'),
  raw: jsonb('raw').notNull().default({}),
}, (t) => [index('call_legs_call_idx').on(t.callId)]);

export const callEvents = pgTable('call_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  callId: uuid('call_id').notNull().references(() => calls.id, { onDelete: 'cascade' }),
  legId: uuid('leg_id').references(() => callLegs.id),
  eventType: text('event_type').notNull(),
  occurredAt: ts('occurred_at').notNull(),
  source: text('source').notNull(), // webhook|api|client|reconciliation|system
  webhookEventId: uuid('webhook_event_id'),
  sequenceNumber: integer('sequence_number'),
  /**
   * Applier-computed idempotency token (e.g. "CAxxx:call.ringing:3").
   * Partial unique index (custom migration) makes double-apply impossible
   * even across distinct webhook deliveries describing the same fact.
   */
  dedupeToken: text('dedupe_token'),
  payload: jsonb('payload').notNull().default({}),
  createdAt: now(),
}, (t) => [
  index('call_events_call_idx').on(t.callId, t.occurredAt),
]);

/**
 * Who is in a call's conference room (docs/telephony-events.md §9). One row per
 * party per call: the rep's browser leg, the customer's PSTN leg, and anyone
 * added mid-call by add-call / merge / transfer. `provider_participant_id` is
 * that party's own leg SID — what the provider's participant API addresses —
 * and is unique so a duplicate join callback cannot double-insert.
 */
export const callParticipants = pgTable('call_participants', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  callId: uuid('call_id').notNull().references(() => calls.id, { onDelete: 'cascade' }),
  /** Room the party joined (`talkr-{callId}`). */
  roomName: text('room_name').notNull(),
  provider: text('provider').notNull().default('telnyx'),
  providerConferenceId: text('provider_conference_id'),
  providerParticipantId: text('provider_participant_id').notNull().unique(),
  role: text('role').notNull(), // agent|customer|teammate|external
  state: text('state').notNull().default('ringing'), // ringing|joined|on_hold|left
  /** Platform user, when the party is one of ours (agent or teammate). */
  userId: uuid('user_id').references(() => users.id),
  /** Dialed address: E.164 for PSTN, client:identity for a browser. */
  address: text('address'),
  label: text('label'),
  joinedAt: ts('joined_at'),
  leftAt: ts('left_at'),
  raw: jsonb('raw').notNull().default({}),
  createdAt: now(),
}, (t) => [
  index('call_participants_call_idx').on(t.callId),
  index('call_participants_room_idx').on(t.roomName),
]);

export const callNotes = pgTable('call_notes', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  callId: uuid('call_id').notNull().references(() => calls.id, { onDelete: 'cascade' }),
  userId: uuid('user_id').references(() => users.id),
  body: text('body').notNull(),
  createdAt: now(),
});

// ---------------------------------------------------------------------------
// Recordings
// ---------------------------------------------------------------------------
export const recordings = pgTable('recordings', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  callId: uuid('call_id').notNull().references(() => calls.id, { onDelete: 'cascade' }),
  provider: text('provider').notNull().default('telnyx'),
  providerRecordingId: text('provider_recording_id').notNull().unique(),
  status: text('status').notNull().default('processing'), // processing|completed|failed|absent|deleted
  durationSeconds: integer('duration_seconds'),
  channels: integer('channels'),
  providerUrl: text('provider_url'),
  storagePath: text('storage_path'),
  errorCode: text('error_code'),
  startedAt: ts('started_at'),
  completedAt: ts('completed_at'),
  raw: jsonb('raw').notNull().default({}),
  createdAt: now(),
}, (t) => [index('recordings_call_idx').on(t.callId)]);

/**
 * One transcript per recording (docs/transcription.md): Deepgram speaker
 * turns plus the Claude call notes a manager reads instead of the audio.
 * Beside `recordings` rather than on it because it is a different pipeline
 * that fails, retries and is re-run on its own.
 */
export const transcripts = pgTable('transcripts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  callId: uuid('call_id').notNull().references(() => calls.id, { onDelete: 'cascade' }),
  recordingId: uuid('recording_id').references(() => recordings.id, { onDelete: 'set null' }),
  provider: text('provider').notNull().default('deepgram'),
  /** nova-3 | nova-3-multichannel */
  model: text('model'),
  status: text('status').notNull().default('queued'), // queued|processing|completed|failed|not_configured
  language: text('language'),
  durationSeconds: integer('duration_seconds'),
  /** [{ start, end, speaker: rep|contact|unknown, text, confidence }], seconds, time-ordered. */
  segments: jsonb('segments').notNull().default([]),
  /** "[m:ss] Rep: …" lines — what the summary model reads. */
  fullText: text('full_text'),
  summary: text('summary'),
  /** { key_points[], seller_motivation, timeline, asking_price, property_condition, objections[], next_step, sentiment, rep_talk_ratio } */
  ai: jsonb('ai').notNull().default({}),
  /** The Claude model id the API reported back. */
  aiModel: text('ai_model'),
  /** Why a failed row failed; on a completed row, why the notes are missing. */
  error: text('error'),
  /**
   * How many times the media-failure sweep has re-queued this row
   * (worker/transcribe-handlers.ts). Bounds the retry of a carrier's
   * pre-signed URL expiring or its storage being briefly unreadable.
   */
  retryCount: integer('retry_count').notNull().default(0),
  createdAt: now(),
  completedAt: ts('completed_at'),
}, (t) => [
  uniqueIndex('transcripts_recording_uq').on(t.recordingId),
  index('transcripts_status_idx').on(t.status),
  index('transcripts_call_idx').on(t.callId),
  index('transcripts_org_created_idx').on(t.orgId, t.createdAt),
]);

/**
 * AI call scoring + coaching (docs/coaching.md). One row per call, upserted
 * by `call_id`, so a call has exactly one current score and a re-run replaces
 * it in place rather than stacking. Beside `transcripts` rather than on it
 * because scoring is a second Claude pass over a finished transcript, with
 * its own model, its own failures and its own manual re-run.
 *
 * The rubric behind `categories` and `seller` is the house one in
 * prompts/review_call.system.md; the vocabularies live in
 * packages/core/src/coaching.ts, so adding a category needs no migration.
 */
export const callScores = pgTable('call_scores', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  callId: uuid('call_id').notNull().references(() => calls.id, { onDelete: 'cascade' }),
  transcriptId: uuid('transcript_id').references(() => transcripts.id, { onDelete: 'set null' }),
  /** The Claude model id the API reported back. */
  model: text('model'),
  status: text('status').notNull().default('queued'), // queued|running|completed|failed
  /** 0–100; the model answers 0–10 on the house scale and core multiplies once. */
  overall: integer('overall'),
  /** Rep share of speaking time, 0–1. Computed from the segments, never asked of the model. */
  repTalkRatio: numeric('rep_talk_ratio', { precision: 4, scale: 3 }),
  /** `{ <category>: { score: 0–10 | null, reason } }` over COACHING_CATEGORIES. */
  categories: jsonb('categories').notNull().default({}),
  /** string[] — what the rep did well, each with a verbatim quote. */
  strengths: jsonb('strengths').notNull().default([]),
  /** string[] — what to fix, each with what to say instead. */
  gaps: jsonb('gaps').notNull().default([]),
  /** `[{ moment, quote, instead }]` — doors the seller opened that the rep passed. */
  missedOpportunities: jsonb('missed_opportunities').notNull().default([]),
  nextAction: text('next_action'),
  /** The Price × Motivation read-out (see @talkr/core SellerRead). */
  seller: jsonb('seller').notNull().default({}),
  /** Why a failed row failed. */
  error: text('error'),
  createdAt: now(),
  completedAt: ts('completed_at'),
}, (t) => [
  uniqueIndex('call_scores_call_uq').on(t.callId),
  index('call_scores_org_created_idx').on(t.orgId, t.createdAt),
]);

// ---------------------------------------------------------------------------
// Compliance primitives
// ---------------------------------------------------------------------------
export const suppressionRecords = pgTable('suppression_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  phoneE164: text('phone_e164').notNull(),
  scope: text('scope').notNull().default('org'), // org|campaign
  campaignId: uuid('campaign_id'),
  channel: text('channel').notNull().default('all'), // voice|sms|all
  reason: text('reason').notNull(), // stop|dnc_disposition|manual|complaint|legal
  source: text('source'),
  note: text('note'),
  createdAt: now(),
  expiresAt: ts('expires_at'),
}, (t) => [
  index('suppression_lookup_idx').on(t.orgId, t.phoneE164),
  // Expression unique (coalesce campaign) in custom migration 0002.
]);

export const consentRecords = pgTable('consent_records', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  contactId: uuid('contact_id').references(() => contacts.id),
  phoneE164: text('phone_e164').notNull(),
  channel: text('channel').notNull().default('all'),
  consentType: text('consent_type').notNull().default('unknown'), // express|implied|unknown
  capturedBy: uuid('captured_by').references(() => users.id),
  capturedAt: ts('captured_at').notNull().defaultNow(),
  evidence: jsonb('evidence').notNull().default({}),
});

// ---------------------------------------------------------------------------
// Event ingestion, jobs, audit, integrity
// ---------------------------------------------------------------------------
export const webhookEvents = pgTable('webhook_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  provider: text('provider').notNull(),
  endpoint: text('endpoint').notNull(),
  idempotencyKey: text('idempotency_key').notNull().unique(),
  orgId: uuid('org_id'),
  signatureValid: boolean('signature_valid').notNull().default(false),
  headers: jsonb('headers').notNull().default({}),
  rawBody: text('raw_body').notNull(),
  parsed: jsonb('parsed').notNull().default({}),
  providerObjectId: text('provider_object_id'),
  providerEventType: text('provider_event_type'),
  status: text('status').notNull().default('received'),
  // received|processing|processed|failed|dead_letter|skipped_duplicate|rejected
  attempts: integer('attempts').notNull().default(0),
  duplicateCount: integer('duplicate_count').notNull().default(0),
  lastError: text('last_error'),
  receivedAt: ts('received_at').notNull().defaultNow(),
  processedAt: ts('processed_at'),
}, (t) => [
  index('webhook_events_status_idx').on(t.status, t.receivedAt),
  index('webhook_events_object_idx').on(t.providerObjectId),
]);

export const jobs = pgTable('jobs', {
  id: uuid('id').primaryKey().defaultRandom(),
  queue: text('queue').notNull().default('default'),
  jobType: text('job_type').notNull(),
  payload: jsonb('payload').notNull().default({}),
  dedupeKey: text('dedupe_key').unique(),
  status: text('status').notNull().default('pending'), // pending|running|succeeded|failed|dead
  priority: integer('priority').notNull().default(0),
  runAt: ts('run_at').notNull().defaultNow(),
  attempts: integer('attempts').notNull().default(0),
  maxAttempts: integer('max_attempts').notNull().default(8),
  lastError: text('last_error'),
  lockedAt: ts('locked_at'),
  lockedBy: text('locked_by'),
  correlationId: uuid('correlation_id'),
  createdAt: now(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [
  index('jobs_claim_idx').on(t.status, t.runAt, t.priority),
]);

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id'),
  actorType: text('actor_type').notNull(), // user|system|api_key|provider
  actorId: text('actor_id'),
  action: text('action').notNull(),
  objectType: text('object_type'),
  objectId: text('object_id'),
  metadata: jsonb('metadata').notNull().default({}),
  correlationId: uuid('correlation_id'),
  createdAt: now(),
}, (t) => [
  index('audit_org_created_idx').on(t.orgId, t.createdAt),
  index('audit_object_idx').on(t.objectType, t.objectId),
]);

export const reconciliationMismatches = pgTable('reconciliation_mismatches', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id'),
  objectType: text('object_type').notNull(), // call|recording|orphan_provider_call|...
  objectId: uuid('object_id'),
  provider: text('provider').notNull(),
  providerObjectId: text('provider_object_id'),
  field: text('field').notNull(),
  internalValue: text('internal_value'),
  providerValue: text('provider_value'),
  detectedAt: ts('detected_at').notNull().defaultNow(),
  resolvedAt: ts('resolved_at'),
  resolution: text('resolution'),
}, (t) => [index('recon_open_idx').on(t.resolvedAt, t.detectedAt)]);

export const providerAccounts = pgTable('provider_accounts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  provider: text('provider').notNull(),
  externalAccountId: text('external_account_id'),
  label: text('label'),
  status: text('status').notNull().default('active'),
  /** Non-secret config only; secrets live in env / encrypted columns. */
  config: jsonb('config').notNull().default({}),
  createdAt: now(),
});

// ---------------------------------------------------------------------------
// ── SMS (Phase 4) — conversations, messages, templates (docs/sms.md)
// ---------------------------------------------------------------------------
export const messageDirection = pgEnum('message_direction', ['outbound', 'inbound']);
export const messageStatus = pgEnum('message_status', [
  'queued', 'sending', 'sent', 'delivered', 'undelivered', 'failed', 'received',
]);

export const messageTemplates = pgTable('message_templates', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  /** Body with {{variable}} placeholders (docs/sms.md §6). */
  body: text('body').notNull(),
  /**
   * Display grouping for the template rail — cold|warm|hot|compliance today.
   * Text, not an enum: the set will grow, and an unknown value must still
   * render rather than fail a read.
   */
  category: text('category'),
  isActive: boolean('is_active').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: now(),
}, (t) => [uniqueIndex('message_templates_org_name_uq').on(t.orgId, t.name)]);

/** One row per (org, our number, their number) thread — docs/sms.md §1. */
/**
 * Outreach Talkr did not carry itself (a partner's ringless voicemail drops,
 * emails), posted through POST /v1/outreach so a callback can ring the rep
 * who last reached out (docs/inbound-routing.md §10). `ref` is the partner's
 * idempotency key, unique per org; phone_e164 is normalized exactly like the
 * inbound caller number it is matched against.
 */
export const outreachEvents = pgTable('outreach_events', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  phoneE164: text('phone_e164').notNull(),
  channel: text('channel').notNull(), // rvm|email|other
  occurredAt: ts('occurred_at').notNull(),
  ref: text('ref'),
  /** Who posted it: the user whose token made the request. */
  createdBy: uuid('created_by').references(() => users.id, { onDelete: 'set null' }),
  createdAt: now(),
}, (t) => [
  uniqueIndex('outreach_events_org_ref_uq').on(t.orgId, t.ref),
  index('outreach_events_org_phone_idx').on(t.orgId, t.phoneE164, t.occurredAt),
]);

export const conversations = pgTable('conversations', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  contactId: uuid('contact_id').references(() => contacts.id),
  leadId: uuid('lead_id').references(() => leads.id),
  /** Our number's phone_numbers row (nullable: number could be released later). */
  phoneNumberId: uuid('phone_number_id').references(() => phoneNumbers.id),
  ourNumber: text('our_number').notNull(),
  theirNumber: text('their_number').notNull(),
  assignedUserId: uuid('assigned_user_id').references(() => users.id),
  lastMessageAt: ts('last_message_at'),
  /** Inbound messages since the last mark-read. */
  unreadCount: integer('unread_count').notNull().default(0),
  createdAt: now(),
}, (t) => [
  uniqueIndex('conversations_thread_uq').on(t.orgId, t.ourNumber, t.theirNumber),
  index('conversations_org_recent_idx').on(t.orgId, t.lastMessageAt),
  index('conversations_org_their_idx').on(t.orgId, t.theirNumber),
]);

/** Postgres bytea; node-postgres hands it back as a Buffer. */
const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * Outbound MMS attachments (docs/sms.md §10). Bytes live here so the API can
 * serve them to the carrier from a public URL without a second storage
 * system or another secret; volumes are small (a photo per message, capped
 * at 3 MB) and rows are immutable.
 */
export const mediaAssets = pgTable('media_assets', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  uploadedBy: uuid('uploaded_by').references(() => users.id),
  contentType: text('content_type').notNull(),
  byteSize: integer('byte_size').notNull(),
  /** Display name, already sanitized to [a-z0-9._-]. */
  filename: text('filename'),
  data: bytea('data').notNull(),
  createdAt: now(),
}, (t) => [index('media_assets_org_created_idx').on(t.orgId, t.createdAt)]);

export const messages = pgTable('messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  conversationId: uuid('conversation_id').notNull()
    .references(() => conversations.id, { onDelete: 'cascade' }),
  direction: messageDirection('direction').notNull(),
  status: messageStatus('status').notNull().default('queued'),
  body: text('body').notNull(),
  /** MMS media URLs (string array). */
  mediaUrls: jsonb('media_urls').notNull().default([]),
  numSegments: integer('num_segments'),
  provider: text('provider').notNull().default('telnyx'),
  /** Provider SID — the idempotency anchor for webhook applies. */
  providerMessageSid: text('provider_message_sid').unique(),
  errorCode: text('error_code'),
  /** none|carrier_failure|platform_failure|suppressed (evolving set → text). */
  failureClass: text('failure_class').notNull().default('none'),
  templateId: uuid('template_id').references(() => messageTemplates.id),
  /** Sending user (outbound, human-initiated). */
  createdBy: uuid('created_by').references(() => users.id),
  /** Compliance auto-reply (STOP/HELP/START response) — docs/sms.md §4. */
  isAutoReply: boolean('is_auto_reply').notNull().default(false),
  crmSyncStatus: text('crm_sync_status').notNull().default('none'), // none|pending|synced|failed
  // First-write-wins delivery timestamps (like calls).
  sentAt: ts('sent_at'),
  deliveredAt: ts('delivered_at'),
  failedAt: ts('failed_at'),
  createdAt: now(),
}, (t) => [
  index('messages_conversation_idx').on(t.conversationId, t.createdAt),
  index('messages_org_created_idx').on(t.orgId, t.createdAt),
]);
// ── Public API (Phase 10) ───────────────────────────────────────────────────
// docs/public-api.md. API keys are secrets: only the SHA-256 hash is stored;
// the prefix is display-only. Webhook signing secrets must stay recoverable
// (HMAC) — never logged, never returned after creation.

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  /** First 8 chars of the random segment, shown as `tk_live_<prefix>…`. */
  keyPrefix: text('key_prefix').notNull(),
  /** SHA-256 hex of the full `tk_live_…` string — the lookup column. */
  keyHash: text('key_hash').notNull().unique(),
  /** Scope strings (docs/public-api.md §2), e.g. ["calls:read"]. */
  scopes: jsonb('scopes').notNull().default([]),
  createdBy: uuid('created_by').references(() => users.id),
  /** Throttled stamp (≤ once/minute) — display field, not an audit field. */
  lastUsedAt: ts('last_used_at'),
  revokedAt: ts('revoked_at'),
  createdAt: now(),
}, (t) => [index('api_keys_org_idx').on(t.orgId)]);

export const webhookSubscriptions = pgTable('webhook_subscriptions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  url: text('url').notNull(),
  /** HMAC-SHA256 key for X-Talkr-Signature; returned once at creation. */
  signingSecret: text('signing_secret').notNull(),
  /** Subscribed public event types (jsonb array of strings). */
  eventTypes: jsonb('event_types').notNull().default([]),
  active: boolean('active').notNull().default(true),
  /** Consecutive dead deliveries; auto-disable at threshold (docs §7). */
  failureCount: integer('failure_count').notNull().default(0),
  disabledAt: ts('disabled_at'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: now(),
}, (t) => [index('webhook_subscriptions_org_idx').on(t.orgId)]);

export const webhookDeliveries = pgTable('webhook_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  subscriptionId: uuid('subscription_id')
    .notNull()
    .references(() => webhookSubscriptions.id, { onDelete: 'cascade' }),
  /** Source event id (call_events.id, or `audit:<id>` for dispositions). */
  eventId: text('event_id').notNull(),
  eventType: text('event_type').notNull(),
  /** The full signed envelope {id, type, occurredAt, data} as POSTed. */
  payload: jsonb('payload').notNull().default({}),
  state: text('state').notNull().default('pending'), // pending|delivered|failed|dead
  attemptCount: integer('attempt_count').notNull().default(0),
  lastStatusCode: integer('last_status_code'),
  lastError: text('last_error'),
  deliveredAt: ts('delivered_at'),
  createdAt: now(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [
  // Exactly-once fan-out per (subscription, event) — the idempotency guard.
  uniqueIndex('webhook_deliveries_sub_event_uq').on(t.subscriptionId, t.eventId),
  index('webhook_deliveries_sub_idx').on(t.subscriptionId, t.createdAt),
  index('webhook_deliveries_org_idx').on(t.orgId, t.createdAt),
]);

/** Fan-out tail cursors per append-only source ('call_events', 'audit_dispositions'). */
export const webhookFanoutCursors = pgTable('webhook_fanout_cursors', {
  source: text('source').primaryKey(),
  cursorAt: ts('cursor_at').notNull(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
// ── Reporting (Phase 6) ─────────────────────────────────────────────────────

/**
 * Cost ledger (docs/reporting.md §3): one row per priced provider item,
 * extracted by the `extract-provider-costs` sweep from webhook payloads and
 * reconciliation-backfilled call prices. Idempotency is structural — the
 * unique (provider, item_type, provider_ref) key makes re-extraction a no-op.
 */
export const providerCosts = pgTable('provider_costs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  /** Nullable linkage: a ledger row may outlive or precede its object. */
  callId: uuid('call_id').references(() => calls.id, { onDelete: 'set null' }),
  recordingId: uuid('recording_id').references(() => recordings.id, { onDelete: 'set null' }),
  /** Plain uuid (no FK) — ledger rows outlive message pruning. */
  messageId: uuid('message_id'),
  provider: text('provider').notNull().default('telnyx'),
  itemType: text('item_type').notNull(), // call|recording|sms|...
  /** Magnitude in currency units (Twilio's negative prices are normalized). */
  amount: numeric('amount', { precision: 12, scale: 6 }).notNull(),
  currency: text('currency').notNull().default('USD'),
  /** Provider object the price belongs to (e.g. leg CallSid). */
  providerRef: text('provider_ref').notNull(),
  occurredAt: ts('occurred_at').notNull(),
  raw: jsonb('raw').notNull().default({}),
  createdAt: now(),
}, (t) => [
  uniqueIndex('provider_costs_ref_uq').on(t.provider, t.itemType, t.providerRef),
  index('provider_costs_org_occurred_idx').on(t.orgId, t.occurredAt),
  index('provider_costs_call_idx').on(t.callId),
]);
// ── Workflows (Phase 7) ─────────────────────────────────────────────────────
// docs/workflows.md. Trigger/condition/action shapes are validated in code
// (packages/core/src/workflows.ts) — evolving vocabularies stay text/jsonb.

export const workflows = pgTable('workflows', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  enabled: boolean('enabled').notNull().default(true),
  /** docs/workflows.md §2 vocabulary (text: adding a trigger needs no migration). */
  triggerType: text('trigger_type').notNull(),
  triggerConfig: jsonb('trigger_config').notNull().default({}),
  /** Condition DSL tree ({all/any/predicate}); null = always matches. */
  conditions: jsonb('conditions'),
  /** Ordered action array (docs/workflows.md §6). */
  actions: jsonb('actions').notNull().default([]),
  /** Loop-safety rate caps (docs/workflows.md §7) — hard requirements. */
  maxRunsPerLeadPerDay: integer('max_runs_per_lead_per_day').notNull().default(3),
  maxRunsPerDay: integer('max_runs_per_day').notNull().default(500),
  // ── Sequences (docs/sequences.md) ──────────────────────────────────────
  /** workflow | sequence. A sequence is a manual-trigger drip enrolled by hand. */
  kind: text('kind').notNull().default('workflow'),
  /** Builder-facing description; shown in the sequences list. */
  description: text('description'),
  /** {stop_on_reply, stop_on_statuses, stop_on_call_answered}; null = none. */
  exitRules: jsonb('exit_rules'),
  /** Soft delete: an archived sequence is hidden and enrolls nobody. */
  archivedAt: ts('archived_at'),
  /** {mode, sequence_id, candidate_ids, also_when_stopped} (docs/sequences.md §12); null = no routing. */
  onComplete: jsonb('on_complete'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: now(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [
  index('workflows_org_idx').on(t.orgId, t.enabled),
  index('workflows_org_kind_idx').on(t.orgId, t.kind),
]);

export const workflowRuns = pgTable('workflow_runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  workflowId: uuid('workflow_id').notNull()
    .references(() => workflows.id, { onDelete: 'cascade' }),
  /** Which feed produced the trigger (call.completed, message.received, …). */
  triggerSource: text('trigger_source').notNull(),
  /** Source row identity (call id, message id, audit:<id>, lead:<bucket>…). */
  triggerEventId: text('trigger_event_id').notNull(),
  /** Lead resolved at fan-out where the source knows it — drives rate caps. */
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  status: text('status').notNull().default('pending'),
  // pending|running|waiting|succeeded|failed|skipped|stopped
  /** Conditions result; null until evaluated. */
  matched: boolean('matched'),
  /** Why a skipped run was skipped (conditions_not_matched, rate_cap_*…). */
  skipReason: text('skip_reason'),
  /** Ordered per-action results; persisted after each action (idempotent retry). */
  actionResults: jsonb('action_results').notNull().default([]),
  error: text('error'),
  // ── Pause / resume (docs/sequences.md §3) ─────────────────────────────
  /** Index of the next action to execute; a parked run resumes here. */
  currentActionIndex: integer('current_action_index').notNull().default(0),
  /** When a `waiting` run is due to continue (the resume job's run_at). */
  resumeAt: ts('resume_at'),
  /** Why a `stopped` run ended early: unenrolled | replied | status:<x> | call_answered | … */
  stoppedReason: text('stopped_reason'),
  /** The run this one routed its lead into when it finished (docs/sequences.md §12). */
  routedRunId: uuid('routed_run_id'),
  /** The router's reason (or the fixed rule) for routedRunId, or why no plan was chosen. */
  routedReason: text('routed_reason'),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
  createdAt: now(),
}, (t) => [
  // The exactly-once backbone: one run per (workflow, trigger event) no
  // matter how often the overlap window is re-scanned.
  uniqueIndex('workflow_runs_trigger_uq').on(t.workflowId, t.triggerSource, t.triggerEventId),
  index('workflow_runs_workflow_idx').on(t.workflowId, t.createdAt),
  index('workflow_runs_org_idx').on(t.orgId, t.createdAt),
  // Rate-cap counting path: runs for (workflow, lead) in a day.
  index('workflow_runs_cap_idx').on(t.workflowId, t.leadId, t.createdAt),
  // Partial index on (status, resume_at) WHERE status = 'waiting' lives in
  // the custom migration (0017_sequences.sql) — not expressible in the DSL.
]);

export const tasks = pgTable('tasks', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  leadId: uuid('lead_id').references(() => leads.id, { onDelete: 'set null' }),
  assignedUserId: uuid('assigned_user_id').references(() => users.id),
  title: text('title').notNull(),
  note: text('note'),
  dueAt: ts('due_at'),
  status: text('status').notNull().default('open'), // open|done|canceled
  source: text('source').notNull().default('manual'), // workflow|manual
  workflowId: uuid('workflow_id').references(() => workflows.id, { onDelete: 'set null' }),
  /** Structural exactly-once for workflow-created tasks (run × action index). */
  workflowRunId: uuid('workflow_run_id').references(() => workflowRuns.id, { onDelete: 'set null' }),
  actionIndex: integer('action_index'),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: now(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  completedAt: ts('completed_at'),
}, (t) => [
  // My-open-tasks list: assignee + status, ordered by due date.
  index('tasks_assignee_idx').on(t.orgId, t.assignedUserId, t.status, t.dueAt),
  index('tasks_lead_idx').on(t.orgId, t.leadId),
  // Partial unique (workflow_run_id, action_index) lives in the custom
  // migration (0007_workflows.sql) — not expressible in the table DSL.
]);

// ── Dialers (Phase 5) ───────────────────────────────────────────────────────
// docs/dialers.md. Session calls are normal calls with campaign/session
// linkage stamped in calls.raw (the queueId precedent) — no calls columns.

/**
 * A campaign of leads to work through. `settings` is the core
 * CampaignSettings shape; compliance-critical values (parallel line count,
 * abandonment cap) are clamped in code (resolveCampaignSettings), never
 * trusted from storage.
 */
export const campaigns = pgTable('campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  status: text('status').notNull().default('draft'), // draft|active|paused|archived
  mode: text('mode').notNull().default('power'), // power|progressive|parallel|predictive
  settings: jsonb('settings').notNull().default({}),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: now(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [
  uniqueIndex('campaigns_org_name_uq').on(t.orgId, t.name),
  index('campaigns_org_status_idx').on(t.orgId, t.status),
]);

/** One lead's membership + dial state in one campaign (docs/dialers.md §1). */
export const campaignLeads = pgTable('campaign_leads', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id, { onDelete: 'cascade' }),
  leadId: uuid('lead_id').notNull().references(() => leads.id),
  // pending|in_progress|contacted|completed|suppressed|removed
  status: text('status').notNull().default('pending'),
  attempts: integer('attempts').notNull().default(0),
  lastAttemptAt: ts('last_attempt_at'),
  nextAttemptAt: ts('next_attempt_at'),
  priority: integer('priority').notNull().default(0),
  lastOutcome: text('last_outcome'),
  createdAt: now(),
}, (t) => [
  uniqueIndex('campaign_leads_uq').on(t.campaignId, t.leadId),
  // The selection query's index (status + retry timing + priority).
  index('campaign_leads_selection_idx').on(t.campaignId, t.status, t.nextAttemptAt, t.priority),
  index('campaign_leads_lead_idx').on(t.leadId),
]);

/**
 * One rep working one campaign. Counters are recomputed from the calls
 * table (never incremented) so event rescans cannot drift them. One active
 * session per rep via partial unique index (in 0008_dialers.sql):
 *   dial_sessions_one_active_uq ON (user_id) WHERE state = 'active'.
 */
export const dialSessions = pgTable('dial_sessions', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  campaignId: uuid('campaign_id').notNull().references(() => campaigns.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  /** Snapshot of the campaign mode at session start. */
  mode: text('mode').notNull(),
  state: text('state').notNull().default('active'), // active|paused|ended
  startedAt: ts('started_at').notNull().defaultNow(),
  endedAt: ts('ended_at'),
  dialedCount: integer('dialed_count').notNull().default(0),
  connectedCount: integer('connected_count').notNull().default(0),
  abandonedCount: integer('abandoned_count').notNull().default(0),
  /** Set to 1 when the abandonment cap trips (sticky for the session). */
  currentLineLimit: integer('current_line_limit'),
  meta: jsonb('meta').notNull().default({}),
  createdAt: now(),
}, (t) => [
  index('dial_sessions_campaign_idx').on(t.campaignId),
  index('dial_sessions_user_idx').on(t.userId, t.state),
]);

// ── Scripts (docs/scripts.md) ───────────────────────────────────────────────

/**
 * What a rep reads mid-call: talk-track sections (`kind = 'script'`) and
 * objection rebuttals (`kind = 'rebuttal'`). `tags` are a rebuttal's trigger
 * phrases; `contact_types` narrows a script to contact types (empty = any);
 * `campaign_id` pins it to one campaign. Vocabularies are text with the
 * closed sets in packages/core/src/scripts.ts; bodies are light markdown
 * with merge fields the call-context endpoint renders.
 */
export const scripts = pgTable('scripts', {
  id: uuid('id').primaryKey().defaultRandom(),
  orgId: uuid('org_id').notNull().references(() => organizations.id),
  /** script | rebuttal */
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  /** opener | rapport | qualifying | motivation | condition | price | novation | close | voicemail | objection | … */
  category: text('category'),
  tags: text('tags').array().notNull().default(sql`'{}'::text[]`),
  contactTypes: text('contact_types').array().notNull().default(sql`'{}'::text[]`),
  campaignId: uuid('campaign_id').references(() => campaigns.id, { onDelete: 'set null' }),
  body: text('body').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  enabled: boolean('enabled').notNull().default(true),
  createdBy: uuid('created_by').references(() => users.id),
  createdAt: now(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, (t) => [
  index('scripts_org_kind_idx').on(t.orgId, t.kind, t.sortOrder),
  index('scripts_org_campaign_idx').on(t.orgId, t.campaignId),
]);

/**
 * A partner app whose sign-in Talkr trusts (CLOZR). One row per issuer: the
 * `iss` its tokens carry, how to verify them (a JWKS URL for asymmetric keys
 * and/or an HS256 secret), and the browser origins it serves the phone from,
 * which join WEB_ORIGIN in the CORS allowlist. Rows are read by the API at
 * request time and cached briefly, so onboarding a partner is an insert, not
 * a redeploy. The PARTNER_* env vars remain as a zero-row fallback.
 */
export const partnerApps = pgTable('partner_apps', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  issuer: text('issuer').notNull().unique(),
  jwksUrl: text('jwks_url'),
  secret: text('secret'),
  /** Exact origins, or patterns with one `*` label such as `https://app-*-team.vercel.app`. */
  origins: text('origins').array().notNull().default(sql`'{}'::text[]`),
  enabled: boolean('enabled').notNull().default(true),
  createdAt: now(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/**
 * A partner-issued identity for a Talkr user: (issuer, subject) → user. The
 * same person signs in to Talkr with one Supabase Auth id and to CLOZR with
 * another, so `users.auth_user_id` cannot hold both. Created on the first
 * partner sign-in whose email matches exactly one user; never reassigned.
 */
export const partnerIdentities = pgTable('partner_identities', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id, { onDelete: 'cascade' }),
  issuer: text('issuer').notNull(),
  subject: text('subject').notNull(),
  createdAt: now(),
}, (t) => [
  uniqueIndex('partner_identities_iss_sub_uq').on(t.issuer, t.subject),
  index('partner_identities_user_idx').on(t.userId),
]);

/**
 * Deployment settings as rows, read once at boot for the allow-listed keys in
 * apps/server/src/services/runtime-settings.ts. A real environment variable
 * wins over the row of the same name; rows fill what the host leaves unset.
 */
export const runtimeSettings = pgTable('runtime_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  note: text('note'),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});
