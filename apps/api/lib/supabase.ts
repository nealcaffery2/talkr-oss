import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { env } from "./env.js";
import type { Database } from "./database.types.js";

let _admin: SupabaseClient<Database> | null = null;

// Server-side client using the service role key. Bypasses RLS.
// NEVER use in any browser/extension code.
export function admin(): SupabaseClient<Database> {
  if (_admin) return _admin;
  _admin = createClient<Database>(env.supabaseUrl, env.supabaseServiceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  return _admin;
}

// Format a number[] embedding as a pgvector literal: '[0.1,0.2,...]'
export function pgVector(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}
