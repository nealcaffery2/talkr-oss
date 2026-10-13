/**
 * Deployment settings from the database (`runtime_settings`), for a host where
 * environment variables cannot be edited from where the operator is sitting.
 *
 * Precedence is deliberately boring: a real environment variable wins over the
 * row of the same name, so nothing in the database can quietly override what
 * the host was configured with. The rows fill in what the environment leaves
 * unset — which is how a carrier swap is done without touching the host:
 * `VOICE_PROVIDER` is unset there, so the row decides, and the `TELNYX_*`
 * rows supply the rest.
 *
 * Only the keys below are read. Anything else in the table is ignored, so a
 * stray row can never rename the database or turn sign-in off.
 */

import { sql } from 'drizzle-orm';
import { schema, type DbHandle } from '@talkr/db';
import { loadConfig, type Config } from '../config.js';

export const RUNTIME_SETTING_KEYS = [
  'VOICE_PROVIDER',
  'TELNYX_API_KEY',
  'TELNYX_PUBLIC_KEY',
  'TELNYX_ACCOUNT_ID',
  'TELNYX_TEXML_APP_ID',
  'TELNYX_SIP_CONNECTION_ID',
  'TELNYX_MESSAGING_PROFILE_ID',
  'TELNYX_SIP_DOMAIN',
  'DEEPGRAM_API_KEY',
  'DEEPGRAM_PROJECT_ID',
  'ANTHROPIC_API_KEY',
  'CALL_CONTROL_MODE',
] as const;

export type RuntimeSettingKey = (typeof RUNTIME_SETTING_KEYS)[number];

const ALLOWED = new Set<string>(RUNTIME_SETTING_KEYS);

export interface RuntimeSettingsResult {
  config: Config;
  /** Keys the rows supplied (the environment had them unset). */
  applied: RuntimeSettingKey[];
  /** Keys with a row that the environment already set; the row was ignored. */
  shadowed: RuntimeSettingKey[];
}

/**
 * When the rows last changed, as an opaque string; a booted instance compares
 * it on each tick and re-boots when it moves, so a row inserted from a
 * database console takes effect within a minute on every instance.
 */
export async function runtimeSettingsVersion(dbh: DbHandle): Promise<string> {
  try {
    const [row] = await dbh.db
      .select({ v: sql<string>`coalesce(max(${schema.runtimeSettings.updatedAt})::text, '')` })
      .from(schema.runtimeSettings);
    return row?.v ?? '';
  } catch {
    return '';
  }
}

/**
 * Re-read the configuration with the rows filling the environment's gaps. A
 * missing table (migration pending) or an unreachable read leaves the
 * environment's configuration exactly as it was.
 */
export async function applyRuntimeSettings(
  dbh: DbHandle,
  env: NodeJS.ProcessEnv = process.env,
): Promise<RuntimeSettingsResult> {
  let rows: Array<{ key: string; value: string }> = [];
  try {
    rows = await dbh.db.select({ key: schema.runtimeSettings.key, value: schema.runtimeSettings.value }).from(schema.runtimeSettings);
  } catch {
    return { config: loadConfig(env), applied: [], shadowed: [] };
  }
  const merged: NodeJS.ProcessEnv = { ...env };
  const applied: RuntimeSettingKey[] = [];
  const shadowed: RuntimeSettingKey[] = [];
  for (const row of rows) {
    if (!ALLOWED.has(row.key)) continue;
    const key = row.key as RuntimeSettingKey;
    if (env[key] !== undefined && env[key] !== '') {
      shadowed.push(key);
      continue;
    }
    merged[key] = row.value;
    applied.push(key);
  }
  if (applied.length === 0) return { config: loadConfig(env), applied, shadowed };
  return { config: loadConfig(merged), applied, shadowed };
}
