/**
 * The in-call "smart" surface a CRM embeds beside the softphone:
 *
 *   POST /v1/transcription/token    60-second Deepgram key for the browser
 *   POST /v1/calls/:id/intel        seller intelligence over the live transcript
 *
 * Talkr Coach did this as a Chrome extension against a smrtPhone tab. Now the
 * softphone is ours, so the browser streams both legs of the Twilio call to
 * Deepgram itself and asks here, on every seller turn, what the transcript so
 * far says: motivation, timeline, price expectation, objection, the next thing
 * to say. The same endpoint in `summary` mode writes the post-call card the
 * moment the call ends, before the recording has been fetched and transcribed
 * (`transcribe-recording` still runs and produces the durable notes).
 *
 * Secrets stay here: the Deepgram master key mints a short-lived one, and the
 * Anthropic key never leaves the server. Nothing in this file writes to the
 * database — a live read of a call in flight is not a record.
 */

import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { Permission } from '@talkr/core';
import { schema } from '@talkr/db';
import type { AppDeps } from '../app.js';
import { hasPermission } from '../auth.js';
import { ANTHROPIC_URL, ANTHROPIC_VERSION, supportsEffort } from '../services/transcription.js';

function requirePermission(permission: Permission) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    const ctx = req.authCtx;
    if (!ctx) return reply.code(401).send({ error: 'unauthenticated' });
    if (!hasPermission(ctx, permission)) {
      return reply.code(403).send({ error: 'forbidden', permission });
    }
  };
}

const DEEPGRAM_KEYS_URL = 'https://api.deepgram.com/v1/projects';
const TOKEN_TTL_SECONDS = 60;

/**
 * The Deepgram project the master key belongs to. DEEPGRAM_PROJECT_ID pins
 * it; otherwise it is read once from the key's own project list and cached,
 * so one env var is all the feature needs.
 */
let projectCache: { key: string; id: string } | null = null;
async function deepgramProjectId(apiKey: string, pinned: string | undefined, doFetch: typeof fetch): Promise<string> {
  if (pinned) return pinned;
  if (projectCache && projectCache.key === apiKey) return projectCache.id;
  const res = await doFetch(DEEPGRAM_KEYS_URL, { headers: { authorization: `Token ${apiKey}` } });
  if (!res.ok) throw new Error(`Deepgram ${res.status} listing projects`);
  const body = (await res.json()) as { projects?: Array<{ project_id?: string }> };
  const id = body.projects?.[0]?.project_id;
  if (!id) throw new Error('the Deepgram key belongs to no project');
  projectCache = { key: apiKey, id };
  return id;
}

const turnSchema = z.object({
  speaker: z.enum(['rep', 'seller']),
  text: z.string().min(1).max(4000),
});

const intelSchema = z.object({
  mode: z.enum(['live', 'summary']).default('live'),
  /** The transcript so far, oldest first. The last ~40 turns are what the model reads. */
  turns: z.array(turnSchema).min(1).max(400),
  /** What the CRM already knows, so the model does not re-ask it. */
  context: z
    .object({
      contact_name: z.string().max(200).nullable().optional(),
      address: z.string().max(300).nullable().optional(),
      stage: z.string().max(80).nullable().optional(),
      notes: z.string().max(2000).nullable().optional(),
      /** Our maximum allowable offer; the model must never voice it. */
      mao: z.string().max(60).nullable().optional(),
    })
    .optional(),
  elapsed_seconds: z.number().int().min(0).optional(),
});

const nullableString = { anyOf: [{ type: 'string' }, { type: 'null' }] } as const;

const LIVE_JSON_SCHEMA = {
  type: 'object',
  properties: {
    motivation: { ...nullableString, description: "Why the owner is selling, in their words so far. Null if not said yet." },
    timeline: { ...nullableString, description: 'When they need to close or move. Null if not said yet.' },
    price_expectation: { ...nullableString, description: 'Any number they named or reacted to, with the context (competing offer, mortgage payoff). Null if none yet.' },
    objection: { ...nullableString, description: 'Their current hesitation, if one is on the table. Null if none.' },
    condition: { ...nullableString, description: 'Repairs, occupancy, tenants mentioned. Null if not said yet.' },
    suggested_response: { type: 'string', description: 'One or two sentences the rep could say next, in quotes-free plain speech, responding to the latest seller turn. Empathetic, specific, moves toward certainty and next step.' },
    next_best_question: { type: 'string', description: 'The single most useful question to ask next. One sentence.' },
    coaching: { type: 'string', description: 'One or two sentences for the rep only: talk ratio, pacing, what to anchor, what not to say. Mention the MAO only to say not to disclose it.' },
    sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative', 'mixed'] },
  },
  required: ['motivation', 'timeline', 'price_expectation', 'objection', 'condition', 'suggested_response', 'next_best_question', 'coaching', 'sentiment'],
  additionalProperties: false,
} as const;

const SUMMARY_JSON_SCHEMA = {
  type: 'object',
  properties: {
    summary: { type: 'string', description: '2-4 plain past-tense sentences: what the seller wants and how the call ended.' },
    sentiment: { type: 'string', enum: ['positive', 'neutral', 'negative', 'mixed'] },
    motivation: { ...nullableString },
    timeline: { ...nullableString },
    price_expectation: { ...nullableString },
    objection: { ...nullableString },
    condition: { ...nullableString },
    follow_up: { ...nullableString, description: 'The agreed next contact: when and about what. Null if none agreed.' },
    suggested_task: { ...nullableString, description: 'One concrete task for the rep, imperative, under 12 words. Null if nothing to do.' },
  },
  required: ['summary', 'sentiment', 'motivation', 'timeline', 'price_expectation', 'objection', 'condition', 'follow_up', 'suggested_task'],
  additionalProperties: false,
} as const;

const SYSTEM_PROMPT = `You are the live call assistant for a real-estate acquisitions company that buys houses directly from owners. You read the running transcript of a phone call between an acquisitions rep ("Rep") and a property owner ("Seller") and return structured JSON only.

Rules:
- Report only what the seller actually said. Never invent a price, timeline or motivation. Unsaid means null.
- Keep amounts and dates the way they were spoken.
- The suggested response is what the rep says next, aloud, to the seller: short, warm, specific, and it moves toward certainty (close date, as-is, no repairs) before price.
- Never suggest disclosing the company's maximum allowable offer or internal numbers.
- Coaching is for the rep's eyes: one or two sentences, concrete.`;

interface AnthropicMessageResponse {
  model: string;
  stop_reason: string | null;
  content: Array<{ type: string; text?: string }>;
}

function talkRatio(turns: Array<{ speaker: 'rep' | 'seller'; text: string }>): { rep: number; seller: number } | null {
  let rep = 0;
  let seller = 0;
  for (const t of turns) {
    if (t.speaker === 'rep') rep += t.text.length;
    else seller += t.text.length;
  }
  const total = rep + seller;
  if (total === 0) return null;
  const r = Math.round((rep / total) * 100);
  return { rep: r, seller: 100 - r };
}

export function registerLiveIntelRoutes(app: FastifyInstance, deps: AppDeps): void {
  const { config, dbh } = deps;
  const doFetch = deps.fetchImpl ?? fetch;

  /**
   * A Deepgram key that dies in a minute. The browser opens its WebSocket with
   * it; the socket outlives the key. Requires DEEPGRAM_API_KEY + _PROJECT_ID.
   */
  app.post('/v1/transcription/token', { preHandler: requirePermission('calls.place') }, async (req, reply) => {
    if (!config.DEEPGRAM_API_KEY) {
      return reply.code(503).send({
        error: 'transcription_not_configured',
        message: 'Set DEEPGRAM_API_KEY on the Talkr server.',
      });
    }
    const ctx = req.authCtx!;
    let res: Response;
    try {
      const projectId = await deepgramProjectId(config.DEEPGRAM_API_KEY, config.DEEPGRAM_PROJECT_ID, doFetch);
      res = await doFetch(`${DEEPGRAM_KEYS_URL}/${encodeURIComponent(projectId)}/keys`, {
        method: 'POST',
        headers: { authorization: `Token ${config.DEEPGRAM_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          comment: `talkr live transcript ${ctx.userId}`,
          scopes: ['usage:write'],
          time_to_live_in_seconds: TOKEN_TTL_SECONDS,
        }),
      });
    } catch (err) {
      return reply.code(502).send({ error: 'deepgram_unreachable', message: (err as Error).message });
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      req.log.warn({ status: res.status, detail }, 'deepgram key mint failed');
      return reply.code(502).send({ error: 'deepgram_error', message: `Deepgram ${res.status}` });
    }
    const body = (await res.json()) as { key?: string; api_key_id?: string };
    if (!body.key) return reply.code(502).send({ error: 'deepgram_error', message: 'no key in response' });
    return {
      key: body.key,
      expires_at: new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toISOString(),
      ttl_seconds: TOKEN_TTL_SECONDS,
    };
  });

  /** Seller intelligence over the transcript so far, or the post-call card. */
  app.post('/v1/calls/:id/intel', { preHandler: requirePermission('calls.read.own') }, async (req, reply) => {
    const ctx = req.authCtx!;
    const { id } = req.params as { id: string };
    const parsed = intelSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: 'invalid_body', issues: parsed.error.issues });
    if (!config.ANTHROPIC_API_KEY) {
      return reply.code(503).send({ error: 'ai_not_configured', message: 'Set ANTHROPIC_API_KEY on the Talkr server.' });
    }
    if (!z.string().uuid().safeParse(id).success) return reply.code(404).send({ error: 'not_found' });
    const call = (
      await dbh.db
        .select({ id: schema.calls.id, userId: schema.calls.userId, direction: schema.calls.direction })
        .from(schema.calls)
        .where(and(eq(schema.calls.id, id), eq(schema.calls.orgId, ctx.orgId)))
        .limit(1)
    )[0];
    if (!call) return reply.code(404).send({ error: 'not_found' });
    if (call.userId !== ctx.userId && !hasPermission(ctx, 'calls.read.org')) {
      return reply.code(403).send({ error: 'forbidden' });
    }

    const { mode, context, elapsed_seconds } = parsed.data;
    const turns = parsed.data.turns.slice(-40);
    const header = [
      `Call: ${call.direction}`,
      context?.contact_name ? `Seller: ${context.contact_name}` : null,
      context?.address ? `Property: ${context.address}` : null,
      context?.stage ? `CRM stage: ${context.stage}` : null,
      context?.notes ? `CRM notes: ${context.notes}` : null,
      context?.mao ? `Internal MAO (never disclose): ${context.mao}` : null,
      elapsed_seconds != null ? `Elapsed: ${Math.floor(elapsed_seconds / 60)}m ${elapsed_seconds % 60}s` : null,
    ]
      .filter(Boolean)
      .join('\n');
    const transcript = turns.map((t) => `${t.speaker === 'rep' ? 'Rep' : 'Seller'}: ${t.text}`).join('\n');
    const ask =
      mode === 'live'
        ? 'Read the transcript so far and return the live intelligence JSON.'
        : 'The call has ended. Return the post-call summary JSON.';

    const model = config.AI_SUMMARY_MODEL;
    let res: Response;
    try {
      res = await doFetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'x-api-key': config.ANTHROPIC_API_KEY,
          'anthropic-version': ANTHROPIC_VERSION,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model,
          max_tokens: 4000,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: `${header}\n\nTranscript so far:\n${transcript}\n\n${ask}` }],
          output_config: {
            // A live nudge has to land while the seller is still talking about
            // it; low effort keeps the adaptive-thinking spend near zero.
            ...(supportsEffort(model) ? { effort: 'low' } : {}),
            format: { type: 'json_schema', schema: mode === 'live' ? LIVE_JSON_SCHEMA : SUMMARY_JSON_SCHEMA },
          },
        }),
      });
    } catch (err) {
      return reply.code(502).send({ error: 'ai_unreachable', message: (err as Error).message });
    }
    if (!res.ok) {
      const detail = (await res.text().catch(() => '')).slice(0, 300);
      req.log.warn({ status: res.status, detail }, 'live intel failed');
      return reply.code(502).send({ error: 'ai_error', message: `Anthropic ${res.status}` });
    }
    const msg = (await res.json()) as AnthropicMessageResponse;
    if (msg.stop_reason === 'refusal') return reply.code(502).send({ error: 'ai_refused' });
    const text = msg.content.find((b) => b.type === 'text')?.text;
    if (!text) return reply.code(502).send({ error: 'ai_error', message: 'no text block' });
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return reply.code(502).send({ error: 'ai_error', message: 'response was not JSON' });
    }
    return { mode, model: msg.model, talk_ratio: talkRatio(turns), ...data };
  });
}
