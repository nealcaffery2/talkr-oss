// POST /api/deepgram-token
// Mints a 60-second Deepgram temporary key the extension uses to open a
// streaming WebSocket directly to Deepgram. The master key NEVER leaves
// the server.
//
// Auth: requires the TALKR_API_KEY shared secret as Bearer token.

import { env } from "../lib/env.js";

export const config = { runtime: "edge" };

interface TokenResponse {
  api_key_id: string;
  key: string;
  expires_at: string;
}

export default async function handler(req: Request): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const auth = req.headers.get("authorization") || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const sharedSecret = process.env.TALKR_API_KEY;
  if (!sharedSecret || token !== sharedSecret) {
    return new Response("Unauthorized", { status: 401 });
  }

  const dgRes = await fetch(
    `https://api.deepgram.com/v1/projects/${process.env.DEEPGRAM_PROJECT_ID || "self"}/keys`,
    {
      method: "POST",
      headers: {
        authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        comment: "talkr-extension-temp-key",
        scopes: ["usage:write"],
        time_to_live_in_seconds: 60,
      }),
    }
  );

  if (!dgRes.ok) {
    const body = await dgRes.text();
    return new Response(`Deepgram ${dgRes.status}: ${body}`, { status: 502 });
  }

  const data = (await dgRes.json()) as TokenResponse;
  return new Response(JSON.stringify({
    key: data.key,
    expires_at: data.expires_at,
  }), {
    headers: { "content-type": "application/json" },
  });
}
