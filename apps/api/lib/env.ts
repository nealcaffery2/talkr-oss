// Centralized env loader. Reads from process.env (Vercel injects from project
// env vars; locally we rely on `vercel dev` or a node loader like `dotenv-cli`).

function required(key: string): string {
  const v = process.env[key];
  if (!v) throw new Error(`Missing required env var: ${key}`);
  return v;
}

function optional(key: string): string | undefined {
  return process.env[key];
}

export const env = {
  supabaseUrl: required("SUPABASE_URL"),
  supabaseServiceRoleKey: required("SUPABASE_SERVICE_ROLE_KEY"),
  supabaseAnonKey: optional("SUPABASE_ANON_KEY"),

  anthropicApiKey: required("ANTHROPIC_API_KEY"),
  deepgramApiKey: required("DEEPGRAM_API_KEY"),
  voyageApiKey: required("VOYAGE_API_KEY"),

  smrtphoneApiKey: optional("SMRTPHONE_API_KEY"),
  smrtphoneWebhookSecret: optional("SMRTPHONE_WEBHOOK_SIGNING_SECRET"),

  podioClientId: optional("PODIO_CLIENT_ID"),
  podioClientSecret: optional("PODIO_CLIENT_SECRET"),
  podioDealsAppId: optional("PODIO_DEALS_APP_ID"),
  podioDealsAppToken: optional("PODIO_DEALS_APP_TOKEN"),
};
