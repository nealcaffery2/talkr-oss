// POST /api/session?action=start  -> { session_id }
// POST /api/session?action=end    -> { ok: true }
//
// Wraps live_sessions table operations. Auth via TALKR_API_KEY shared secret.
// Agent identity comes from the X-Agent-Id header (Supabase user uuid).

import { admin } from "../lib/supabase.js";

export const config = { runtime: "edge" };

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!process.env.TALKR_API_KEY || token !== process.env.TALKR_API_KEY) {
    return new Response("Unauthorized", { status: 401 });
  }

  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const agentId = req.headers.get("x-agent-id");
  if (!agentId) return new Response("Missing X-Agent-Id", { status: 400 });

  if (action === "start") {
    const body = await safeJson(req);
    const { data, error } = await admin().from("live_sessions").insert({
      agent_id: agentId,
      raw_smrtphone_call_id: body?.smrtphone_call_id ?? null,
    }).select("id").single();
    if (error) return new Response(`Insert failed: ${error.message}`, { status: 500 });
    return new Response(JSON.stringify({ session_id: data.id }), {
      headers: { "content-type": "application/json" },
    });
  }

  if (action === "end") {
    const body = await safeJson(req);
    const sessionId = body?.session_id;
    if (!sessionId) return new Response("Missing session_id", { status: 400 });
    const { error } = await admin().from("live_sessions")
      .update({ ended_at: new Date().toISOString() })
      .eq("id", sessionId)
      .eq("agent_id", agentId);
    if (error) return new Response(`Update failed: ${error.message}`, { status: 500 });
    return new Response(JSON.stringify({ ok: true }), {
      headers: { "content-type": "application/json" },
    });
  }

  return new Response("Unknown action", { status: 400 });
}

async function safeJson(req: Request): Promise<any> {
  try { return await req.json(); } catch { return null; }
}
