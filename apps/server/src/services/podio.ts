/**
 * Minimal Podio client for Phase 2: app-auth + one comment per completed call.
 * Full mapping/webhook sync arrives with the Podio integration milestone
 * (docs/podio-integration.md). Injectable so tests never hit the network.
 */

import type { Logger } from '../logger.js';

export interface PodioClient {
  readonly configured: boolean;
  addCommentToItem(itemId: string, text: string): Promise<{ commentId: string }>;
}

export class NullPodioClient implements PodioClient {
  readonly configured = false;
  constructor(private readonly logger?: Logger) {}
  async addCommentToItem(itemId: string, text: string): Promise<{ commentId: string }> {
    this.logger?.info({ itemId, preview: text.slice(0, 80) }, 'podio not configured; comment skipped');
    return { commentId: 'null' };
  }
}

export interface RealPodioConfig {
  clientId: string;
  clientSecret: string;
  appId: string;
  appToken: string;
}

/** App-authenticated Podio REST client (grant_type=app). */
export class RealPodioClient implements PodioClient {
  readonly configured = true;
  private accessToken: string | null = null;
  private tokenExpiresAt = 0;

  constructor(
    private readonly config: RealPodioConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async token(): Promise<string> {
    if (this.accessToken && Date.now() < this.tokenExpiresAt - 60_000) return this.accessToken;
    const res = await this.fetchImpl('https://api.podio.com/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'app',
        app_id: this.config.appId,
        app_token: this.config.appToken,
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }).toString(),
    });
    if (!res.ok) throw new Error(`podio auth failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { access_token: string; expires_in: number };
    this.accessToken = body.access_token;
    this.tokenExpiresAt = Date.now() + body.expires_in * 1000;
    return this.accessToken;
  }

  async addCommentToItem(itemId: string, text: string): Promise<{ commentId: string }> {
    const token = await this.token();
    const res = await this.fetchImpl(`https://api.podio.com/comment/item/${itemId}/`, {
      method: 'POST',
      headers: {
        authorization: `OAuth2 ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ value: text }),
    });
    if (res.status === 401) {
      this.accessToken = null; // force refresh on next attempt (job retry)
    }
    if (!res.ok) throw new Error(`podio comment failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { comment_id: number };
    return { commentId: String(body.comment_id) };
  }
}

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}
