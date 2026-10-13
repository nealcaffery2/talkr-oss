/**
 * Telnyx reputation reads: CNAM listing, 10DLC registration, Number Reputation.
 * Only endpoints in Telnyx's published OpenAPI spec (team-telnyx/openapi):
 *
 *   GET/PATCH /v2/phone_numbers/{id}/voice          cnam_listing
 *     https://developers.telnyx.com/api/numbers/update-phone-number-voice-settings
 *   GET /v2/10dlc/brand · /v2/10dlc/campaign?brandId · /v2/10dlc/phone_number_campaigns
 *     https://developers.telnyx.com/api/messaging/10dlc   ({records, page, totalRecords}; no `data`)
 *   GET /v2/reputation/numbers/{e164}?fresh=false   Number Reputation (enrolled enterprises)
 *     https://developers.telnyx.com/docs/number-reputation/overview
 *
 * `fresh=false` is deliberate: a cached read is free, a fresh one is billed
 * per check ($0.10). Telnyx refreshes on the enterprise's own schedule.
 *
 * Nothing here enrolls, agrees to terms, registers or submits — those are
 * paid, legal commitments an owner makes in the portal.
 */

import { TelnyxApiError } from './index.js';

const API = 'https://api.telnyx.com/v2';

export interface CnamListing {
  enabled: boolean;
  name: string | null;
}

export interface TenDlcBrand {
  id: string;
  name: string;
  /** OK | REGISTRATION_PENDING | REGISTRATION_FAILED */
  status: string | null;
  /** VERIFIED | UNVERIFIED | SELF_DECLARED | VETTED_VERIFIED */
  identity_status: string | null;
  failure_reasons: string | null;
}

export interface TenDlcCampaign {
  id: string;
  brand_id: string;
  usecase: string | null;
  /** TCR_* / TELNYX_* / MNO_* lifecycle. */
  campaign_status: string | null;
  /** ACTIVE | EXPIRED */
  status: string | null;
  approved: boolean;
  failure_reasons: string | null;
}

export interface TenDlcAssignment {
  campaign_id: string | null;
  /** ASSIGNED | PENDING_ASSIGNMENT | FAILED_ASSIGNMENT | PENDING_UNASSIGNMENT | FAILED_UNASSIGNMENT */
  status: string | null;
}

export interface TenDlcSnapshot {
  brands: TenDlcBrand[];
  campaigns: TenDlcCampaign[];
  /** Keyed by E.164. */
  assignments: Record<string, TenDlcAssignment>;
}

export type NumberReputationResult =
  | { status: 'ok'; spam_risk: 'low' | 'medium' | 'high' | null; spam_category: string | null; scores: Record<string, number | null>; last_refreshed_at: string | null }
  /** Number Reputation is not enabled, or this number was never added to it. */
  | { status: 'not_enrolled' };

/**
 * Carriers deliver texts only once the campaign is provisioned on the networks.
 * MNO_PROVISIONED is that state; everything earlier is still pending.
 */
export function isApprovedCampaign(c: { campaignStatus?: string | null; status?: string | null }): boolean {
  return c.campaignStatus === 'MNO_PROVISIONED' && c.status !== 'EXPIRED';
}

/** Is `phone` assigned (and live) on an approved campaign in this snapshot? null when not texting-registered at all is unknowable. */
export function numberAssignedToApprovedCampaign(snapshot: TenDlcSnapshot, phone: string): boolean {
  const a = snapshot.assignments[phone];
  if (!a || a.status !== 'ASSIGNED' || !a.campaign_id) return false;
  return snapshot.campaigns.some((c) => c.id === a.campaign_id && c.approved);
}

export class TelnyxReputation {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = globalThis.fetch,
  ) {}

  private async get<T>(path: string, init: { method?: string; json?: unknown; allow404?: boolean } = {}): Promise<T | null> {
    const res = await this.fetchImpl(`${API}${path}`, {
      method: init.method ?? 'GET',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        accept: 'application/json',
        ...(init.json !== undefined ? { 'content-type': 'application/json' } : {}),
      },
      body: init.json !== undefined ? JSON.stringify(init.json) : undefined,
    });
    const text = await res.text();
    if (init.allow404 && (res.status === 404 || res.status === 403)) return null;
    if (!res.ok) throw new TelnyxApiError(res.status, text, `Telnyx ${init.method ?? 'GET'} ${path} → ${res.status}`);
    return (text ? JSON.parse(text) : {}) as T;
  }

  async getCnam(providerNumberId: string): Promise<CnamListing> {
    const body = await this.get<{ data?: { cnam_listing?: { cnam_listing_enabled?: boolean; cnam_listing_details?: string | null } } }>(
      `/phone_numbers/${encodeURIComponent(providerNumberId)}/voice`,
    );
    const c = body?.data?.cnam_listing;
    return { enabled: Boolean(c?.cnam_listing_enabled), name: c?.cnam_listing_details || null };
  }

  /** Telnyx requires the details whenever the listing is enabled; disabling keeps the name on file. */
  async setCnam(providerNumberId: string, listing: CnamListing): Promise<CnamListing> {
    const body = await this.get<{ data?: { cnam_listing?: { cnam_listing_enabled?: boolean; cnam_listing_details?: string | null } } }>(
      `/phone_numbers/${encodeURIComponent(providerNumberId)}/voice`,
      {
        method: 'PATCH',
        json: {
          cnam_listing: {
            cnam_listing_enabled: listing.enabled,
            ...(listing.name ? { cnam_listing_details: listing.name } : {}),
          },
        },
      },
    );
    const c = body?.data?.cnam_listing;
    return { enabled: Boolean(c?.cnam_listing_enabled ?? listing.enabled), name: c?.cnam_listing_details ?? listing.name };
  }

  /** 10DLC pages: `{records, page, totalRecords}`. ponytail: 5 pages of 100 each covers any account this size. */
  private async pages<T>(path: string): Promise<T[]> {
    const out: T[] = [];
    const sep = path.includes('?') ? '&' : '?';
    for (let page = 1; page <= 5; page++) {
      const body = await this.get<{ records?: T[]; totalRecords?: number }>(`${path}${sep}page=${page}&recordsPerPage=100`);
      const records = body?.records ?? [];
      out.push(...records);
      if (records.length < 100 || out.length >= (body?.totalRecords ?? 0)) break;
    }
    return out;
  }

  async tenDlc(): Promise<TenDlcSnapshot> {
    type RawBrand = { brandId: string; displayName?: string; companyName?: string; status?: string; identityStatus?: string; failureReasons?: string | null };
    type RawCampaign = { campaignId: string; brandId: string; usecase?: string; campaignStatus?: string; status?: string; failureReasons?: string | null };
    type RawAssignment = { phoneNumber: string; campaignId?: string | null; assignmentStatus?: string };
    const brands = await this.pages<RawBrand>('/10dlc/brand');
    const campaigns: RawCampaign[] = [];
    for (const b of brands) campaigns.push(...(await this.pages<RawCampaign>(`/10dlc/campaign?brandId=${encodeURIComponent(b.brandId)}`)));
    const assignments = campaigns.length ? await this.pages<RawAssignment>('/10dlc/phone_number_campaigns') : [];
    return {
      brands: brands.map((b) => ({
        id: b.brandId,
        name: b.displayName || b.companyName || b.brandId,
        status: b.status ?? null,
        identity_status: b.identityStatus ?? null,
        failure_reasons: b.failureReasons ?? null,
      })),
      campaigns: campaigns.map((c) => ({
        id: c.campaignId,
        brand_id: c.brandId,
        usecase: c.usecase ?? null,
        campaign_status: c.campaignStatus ?? null,
        status: c.status ?? null,
        approved: isApprovedCampaign(c),
        failure_reasons: c.failureReasons ?? null,
      })),
      assignments: Object.fromEntries(assignments.map((a) => [a.phoneNumber, { campaign_id: a.campaignId ?? null, status: a.assignmentStatus ?? null }])),
    };
  }

  async numberReputation(phoneE164: string): Promise<NumberReputationResult> {
    const body = await this.get<{
      data?: { reputation_data?: { spam_risk?: 'low' | 'medium' | 'high' | null; spam_category?: string | null; maturity_score?: number | null; connection_score?: number | null; engagement_score?: number | null; sentiment_score?: number | null; last_refreshed_at?: string | null } | null };
    }>(`/reputation/numbers/${encodeURIComponent(phoneE164)}?fresh=false`, { allow404: true });
    if (!body?.data) return { status: 'not_enrolled' };
    const r = body.data.reputation_data ?? {};
    return {
      status: 'ok',
      spam_risk: r.spam_risk ?? null,
      spam_category: r.spam_category ?? null,
      scores: {
        maturity: r.maturity_score ?? null,
        connection: r.connection_score ?? null,
        engagement: r.engagement_score ?? null,
        sentiment: r.sentiment_score ?? null,
      },
      last_refreshed_at: r.last_refreshed_at ?? null,
    };
  }
}
