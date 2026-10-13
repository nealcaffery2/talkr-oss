/**
 * Telnyx self-provisioning: from one API key to a working carrier.
 *
 * When the configuration says `telnyx` and has the API key but not the ids of
 * the resources Telnyx needs (TeXML application, credential SIP connection,
 * messaging profile) or the account's webhook public key, the server creates
 * or finds them at boot and writes the results into `runtime_settings`. The
 * next boot finds the rows and does nothing. The operator's whole job is two
 * rows: `VOICE_PROVIDER = telnyx` and `TELNYX_API_KEY`.
 *
 * Idempotent by name: a resource already present with our name is reused,
 * so an interrupted boot or two instances booting at once cannot create
 * duplicates. If anything the carrier needs cannot be obtained, the server
 * boots with no carrier and the reason is written to `TELNYX_BOOTSTRAP_ERROR`,
 * because an API that will not start is worse than one that serves everything
 * but calls and texts.
 *
 * The browser credential connection must accept SIP-URI invites from our own
 * TeXML app (`sip_uri_calling_preference: internal`). Without that, server-
 * dialed browser legs hang up with SipHangupCause=403 and the call looks
 * "busy" in ~1s. Create and reconcile both set it.
 */

import { sql } from 'drizzle-orm';
import { schema, type DbHandle } from '@talkr/db';
import type { Config } from '../config.js';
import type { Logger } from '../logger.js';

const API = 'https://api.telnyx.com/v2';
const NAME = 'talkr';
/** Where carrier webhooks are served; the legacy prefix is still served too (routes/webhooks.ts). */
const WEBHOOK_PREFIX = '/webhooks/telnyx/';
const LEGACY_WEBHOOK_PREFIX = '/webhooks/twilio/';

/** Required so TeXML can dial sip:gencred…@sip.telnyx.com on this connection. */
const SIP_URI_CALLING_PREFERENCE = 'internal' as const;

type Fetch = typeof fetch;

interface Row {
  id: string;
  [k: string]: unknown;
}

class TelnyxApi {
  constructor(
    private readonly key: string,
    private readonly http: Fetch,
  ) {}

  async call<T = { data?: Row }>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.http(`${API}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.key}`,
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Telnyx ${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  /** The record named `value` in `field`, or a freshly created one. */
  async ensure(path: string, field: string, value: string, body: Record<string, unknown>): Promise<Row> {
    const { data } = await this.call<{ data?: Row[] }>('GET', `${path}?page[size]=250`);
    const found = (data ?? []).find((r) => r[field] === value);
    if (found) return found;
    const created = await this.call('POST', path, body);
    if (!created.data?.id) throw new Error(`Telnyx POST ${path} returned no id`);
    return created.data;
  }

  /**
   * Credential SIP connection for browser softphones. Reuses by name; always
   * enforces sip_uri_calling_preference=internal (create or PATCH).
   */
  async ensureBrowserCredentialConnection(ovpId: string): Promise<Row> {
    const path = '/credential_connections';
    const name = `${NAME}-browsers`;
    const body: Record<string, unknown> = {
      connection_name: name,
      active: true,
      // Server-dials-browser (TeXML → sip:gencred…@sip.telnyx.com). Default is
      // `disabled`, which answers 403 and Talkr maps to "busy".
      sip_uri_calling_preference: SIP_URI_CALLING_PREFERENCE,
      // The connection's own login is never used (reps get on-demand
      // credentials); Telnyx requires one to create the connection.
      user_name: `${NAME}${Math.random().toString(36).slice(2, 10)}`,
      password: Buffer.from(crypto.getRandomValues(new Uint8Array(18))).toString('base64url'),
      inbound: { dnis_number_format: 'sip_username', ani_number_format: '+E.164', codecs: ['OPUS', 'G722', 'G711U'] },
      outbound: { outbound_voice_profile_id: ovpId },
    };
    const { data } = await this.call<{ data?: Row[] }>('GET', `${path}?page[size]=250`);
    const found = (data ?? []).find((r) => r.connection_name === name);
    if (!found) {
      const created = await this.call('POST', path, body);
      if (!created.data?.id) throw new Error(`Telnyx POST ${path} returned no id`);
      return created.data;
    }
    if (found.sip_uri_calling_preference !== SIP_URI_CALLING_PREFERENCE) {
      const patched = await this.call<{ data?: Row }>('PATCH', `${path}/${found.id}`, {
        sip_uri_calling_preference: SIP_URI_CALLING_PREFERENCE,
      });
      return patched.data ?? { ...found, sip_uri_calling_preference: SIP_URI_CALLING_PREFERENCE };
    }
    return found;
  }

  /**
   * Move a resource's webhook from the legacy `/webhooks/twilio/` path to
   * `/webhooks/telnyx/`. Both are served, so this is safe to run on every boot;
   * it only writes when the old path is still what the resource points at.
   */
  async repointWebhook(path: string, field: string): Promise<boolean> {
    const { data } = await this.call<{ data?: Row }>('GET', path);
    const current = data?.[field];
    if (typeof current !== 'string' || !current.includes(LEGACY_WEBHOOK_PREFIX)) return false;
    await this.call('PATCH', path, { [field]: current.replace(LEGACY_WEBHOOK_PREFIX, WEBHOOK_PREFIX) });
    return true;
  }

  /** Fix a known connection id that may predate the preference requirement. */
  async reconcileBrowserSipUriPreference(connectionId: string): Promise<void> {
    const { data } = await this.call<{ data?: Row }>('GET', `/credential_connections/${connectionId}`);
    if (!data?.id) return;
    if (data.sip_uri_calling_preference === SIP_URI_CALLING_PREFERENCE) return;
    await this.call('PATCH', `/credential_connections/${connectionId}`, {
      sip_uri_calling_preference: SIP_URI_CALLING_PREFERENCE,
    });
  }
}

/** Everything the adapter needs that the API key alone does not give us. */
export function telnyxNeedsBootstrap(config: Config): boolean {
  return (
    config.VOICE_PROVIDER === 'telnyx' &&
    Boolean(config.TELNYX_API_KEY) &&
    !(config.TELNYX_TEXML_APP_ID && config.TELNYX_SIP_CONNECTION_ID && config.TELNYX_PUBLIC_KEY && config.TELNYX_ACCOUNT_ID)
  );
}

export async function provisionTelnyx(
  config: Config,
  http: Fetch = fetch,
): Promise<Record<string, string>> {
  const api = new TelnyxApi(config.TELNYX_API_KEY!, http);
  const base = config.PUBLIC_BASE_URL.replace(/\/$/, '');

  const ovp = await api.ensure('/outbound_voice_profiles', 'name', `${NAME}-outbound`, {
    name: `${NAME}-outbound`,
    // The only combination Telnyx accepts today (error 10015 otherwise).
    // `global` is the plan name; whitelisted_destinations still limits where
    // calls may go.
    traffic_type: 'conversational',
    service_plan: 'global',
    usage_payment_method: 'rate-deck',
    whitelisted_destinations: ['US', 'CA'],
  });
  const texml = await api.ensure('/texml_applications', 'friendly_name', `${NAME}-texml`, {
    friendly_name: `${NAME}-texml`,
    active: true,
    voice_url: `${base}/twiml/outbound-dial`,
    voice_method: 'post',
    status_callback: `${base}/webhooks/telnyx/voice-status`,
    status_callback_method: 'post',
    outbound: { outbound_voice_profile_id: ovp.id },
  });
  const sip = await api.ensureBrowserCredentialConnection(String(ovp.id));
  const msg = await api.ensure('/messaging_profiles', 'name', `${NAME}-messaging`, {
    name: `${NAME}-messaging`,
    enabled: true,
    whitelisted_destinations: ['US', 'CA'],
    webhook_url: `${base}/webhooks/telnyx/inbound-sms`,
    webhook_api_version: '2010-04-01',
  });

  const rows: Record<string, string> = {
    TELNYX_TEXML_APP_ID: String(texml.id),
    TELNYX_SIP_CONNECTION_ID: String(sip.id),
    TELNYX_MESSAGING_PROFILE_ID: String(msg.id),
  };

  if (!config.TELNYX_PUBLIC_KEY) {
    // Answers `{ data: { public: '…' } }` on the live API; `public_key` kept as a fallback.
    const r = await api.call<{ data?: { public?: string; public_key?: string } }>('GET', '/public_key');
    const publicKey = r.data?.public ?? r.data?.public_key;
    if (!publicKey) throw new Error('Telnyx GET /public_key carried no key; copy it from the portal into TELNYX_PUBLIC_KEY');
    rows.TELNYX_PUBLIC_KEY = publicKey;
  }
  if (!config.TELNYX_ACCOUNT_ID) {
    const r = await api.call<{ data?: Record<string, unknown> }>('GET', '/whoami');
    const id = r.data?.organization_id ?? r.data?.org_id ?? r.data?.user_id ?? r.data?.id;
    if (!id) throw new Error(`Telnyx GET /whoami carried no account id (keys: ${Object.keys(r.data ?? {}).join(',')})`);
    rows.TELNYX_ACCOUNT_ID = String(id);
  }
  return rows;
}

async function upsert(dbh: DbHandle, rows: Record<string, string>, note: string): Promise<void> {
  if (Object.keys(rows).length === 0) return;
  await dbh.db
    .insert(schema.runtimeSettings)
    .values(Object.entries(rows).map(([key, value]) => ({ key, value, note })))
    .onConflictDoUpdate({
      target: schema.runtimeSettings.key,
      set: { value: sql`excluded.value`, note, updatedAt: sql`now()` },
    });
}

/**
 * Boot-time hook: complete the Telnyx setup when the rows call for it, and
 * hand back the configuration the provider should be built from. Never
 * throws — a failed bootstrap keeps the previous carrier.
 *
 * Even when every id is already present, re-checks sip_uri_calling_preference
 * on the browser credential connection so a portal reset cannot silently
 * bring back the ~1s busy / 403 hangup.
 */
export async function bootstrapTelnyxIfNeeded(
  dbh: DbHandle,
  config: Config,
  logger: Logger,
  http: Fetch = fetch,
): Promise<Config> {
  if (telnyxNeedsBootstrap(config)) {
    try {
      const rows = await provisionTelnyx(config, http);
      await upsert(dbh, rows, 'created by telnyx-bootstrap at boot');
      await dbh.db.delete(schema.runtimeSettings).where(sql`${schema.runtimeSettings.key} = 'TELNYX_BOOTSTRAP_ERROR'`);
      logger.info({ keys: Object.keys(rows) }, 'telnyx provisioned from the API key');
      // The row keys are Config keys; the environment cannot have set them or
      // we would not be here, so merging is the same as re-reading.
      return { ...config, ...rows };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.error({ err: message }, 'telnyx bootstrap failed; running with no carrier');
      await upsert(dbh, { TELNYX_BOOTSTRAP_ERROR: message.slice(0, 500) }, 'last failure').catch(() => undefined);
      // No other carrier to fall back to: boot without one, so the app still
      // serves and every call or text names the missing carrier.
      return { ...config, VOICE_PROVIDER: 'none' };
    }
  }

  if (
    config.VOICE_PROVIDER === 'telnyx' &&
    config.TELNYX_API_KEY &&
    config.TELNYX_SIP_CONNECTION_ID
  ) {
    try {
      const api = new TelnyxApi(config.TELNYX_API_KEY, http);
      await api.reconcileBrowserSipUriPreference(config.TELNYX_SIP_CONNECTION_ID);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn({ err: message }, 'telnyx sip_uri_calling_preference reconcile failed; continuing');
    }
  }

  // Webhooks registered before the rename still point at /webhooks/twilio/.
  // Move them; if Telnyx refuses, the old path keeps working regardless.
  if (config.VOICE_PROVIDER === 'telnyx' && config.TELNYX_API_KEY) {
    const api = new TelnyxApi(config.TELNYX_API_KEY, http);
    const targets: Array<[string, string]> = [];
    if (config.TELNYX_TEXML_APP_ID) targets.push([`/texml_applications/${config.TELNYX_TEXML_APP_ID}`, 'status_callback']);
    if (config.TELNYX_MESSAGING_PROFILE_ID) targets.push([`/messaging_profiles/${config.TELNYX_MESSAGING_PROFILE_ID}`, 'webhook_url']);
    for (const [path, field] of targets) {
      try {
        if (await api.repointWebhook(path, field)) logger.info({ path, field }, 'telnyx webhook moved to /webhooks/telnyx/');
      } catch (err) {
        logger.warn({ path, err: err instanceof Error ? err.message : String(err) }, 'telnyx webhook repoint failed; the legacy path still works');
      }
    }
  }
  return config;
}
