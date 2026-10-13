/**
 * Telnyx reputation reads against a fake transport: the exact v2 paths and
 * bodies from Telnyx's OpenAPI spec, the 10DLC `{records}` wrapper, and the
 * "not enrolled" answer for Number Reputation.
 */

import { describe, expect, it } from 'vitest';
import { TelnyxReputation, isApprovedCampaign, numberAssignedToApprovedCampaign } from '../src/index.js';

type Call = { url: string; method: string; body: string; auth: string };

function client(route: (url: string, method: string) => { status?: number; json: unknown }) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    calls.push({ url: String(url), method: init?.method ?? 'GET', body: String(init?.body ?? ''), auth: headers.authorization ?? '' });
    const r = route(String(url), init?.method ?? 'GET');
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200 });
  }) as typeof fetch;
  return { rep: new TelnyxReputation('KEY', fetchImpl), calls };
}

describe('CNAM listing', () => {
  it('reads and sets cnam_listing on the number voice settings', async () => {
    const { rep, calls } = client((_url, method) => ({
      json: { data: { cnam_listing: { cnam_listing_enabled: method === 'PATCH', cnam_listing_details: 'YOUR COMPANY' } } },
    }));
    expect(await rep.getCnam('pn-1')).toEqual({ enabled: false, name: 'YOUR COMPANY' });
    expect(await rep.setCnam('pn-1', { enabled: true, name: 'YOUR COMPANY' })).toEqual({ enabled: true, name: 'YOUR COMPANY' });
    expect(calls[0]).toMatchObject({ url: 'https://api.telnyx.com/v2/phone_numbers/pn-1/voice', method: 'GET', auth: 'Bearer KEY' });
    expect(calls[1]!.method).toBe('PATCH');
    expect(JSON.parse(calls[1]!.body)).toEqual({ cnam_listing: { cnam_listing_enabled: true, cnam_listing_details: 'YOUR COMPANY' } });
  });
});

describe('10DLC snapshot', () => {
  it('walks brands → campaigns (brandId required) → number assignments', async () => {
    const { rep, calls } = client((url) => {
      if (url.includes('/10dlc/brand')) return { json: { records: [{ brandId: 'B1', displayName: 'Your Company', status: 'OK', identityStatus: 'VERIFIED' }], totalRecords: 1 } };
      if (url.includes('/10dlc/campaign')) {
        return { json: { records: [
          { campaignId: 'C1', brandId: 'B1', usecase: 'LOW_VOLUME', campaignStatus: 'MNO_PROVISIONED', status: 'ACTIVE' },
          { campaignId: 'C2', brandId: 'B1', campaignStatus: 'TCR_PENDING', status: 'ACTIVE' },
        ], totalRecords: 2 } };
      }
      return { json: { records: [
        { phoneNumber: '+12105550100', campaignId: 'C1', assignmentStatus: 'ASSIGNED' },
        { phoneNumber: '+12105550101', campaignId: 'C2', assignmentStatus: 'ASSIGNED' },
        { phoneNumber: '+12105550102', campaignId: 'C1', assignmentStatus: 'PENDING_ASSIGNMENT' },
      ], totalRecords: 3 } };
    });
    const snap = await rep.tenDlc();
    expect(calls.map((c) => c.url)).toEqual([
      'https://api.telnyx.com/v2/10dlc/brand?page=1&recordsPerPage=100',
      'https://api.telnyx.com/v2/10dlc/campaign?brandId=B1&page=1&recordsPerPage=100',
      'https://api.telnyx.com/v2/10dlc/phone_number_campaigns?page=1&recordsPerPage=100',
    ]);
    expect(snap.brands).toEqual([{ id: 'B1', name: 'Your Company', status: 'OK', identity_status: 'VERIFIED', failure_reasons: null }]);
    expect(snap.campaigns.map((c) => [c.id, c.approved])).toEqual([['C1', true], ['C2', false]]);
    expect(numberAssignedToApprovedCampaign(snap, '+12105550100')).toBe(true);
    expect(numberAssignedToApprovedCampaign(snap, '+12105550101')).toBe(false); // campaign not provisioned
    expect(numberAssignedToApprovedCampaign(snap, '+12105550102')).toBe(false); // assignment pending
    expect(numberAssignedToApprovedCampaign(snap, '+12105550199')).toBe(false);
  });

  it('skips the assignment list when there are no campaigns', async () => {
    const { rep, calls } = client(() => ({ json: { records: [], totalRecords: 0 } }));
    expect(await rep.tenDlc()).toEqual({ brands: [], campaigns: [], assignments: {} });
    expect(calls).toHaveLength(1);
  });

  it('an expired campaign is not approved', () => {
    expect(isApprovedCampaign({ campaignStatus: 'MNO_PROVISIONED', status: 'EXPIRED' })).toBe(false);
  });
});

describe('Number Reputation', () => {
  it('reads the cached check (fresh=false, + encoded) and maps reputation_data', async () => {
    const { rep, calls } = client(() => ({
      json: { data: { phone_number: '+12105550100', reputation_data: { spam_risk: 'high', spam_category: 'Telemarketer', maturity_score: 40, connection_score: null, engagement_score: 12, sentiment_score: 5, last_refreshed_at: '2026-09-12T10:00:00Z' } } },
    }));
    expect(await rep.numberReputation('+12105550100')).toEqual({
      status: 'ok', spam_risk: 'high', spam_category: 'Telemarketer',
      scores: { maturity: 40, connection: null, engagement: 12, sentiment: 5 }, last_refreshed_at: '2026-09-12T10:00:00Z',
    });
    expect(calls[0]!.url).toBe('https://api.telnyx.com/v2/reputation/numbers/%2B12105550100?fresh=false');
  });

  it('404 / 403 mean not enrolled; other errors throw', async () => {
    expect(await client(() => ({ status: 404, json: {} })).rep.numberReputation('+1')).toEqual({ status: 'not_enrolled' });
    expect(await client(() => ({ status: 403, json: {} })).rep.numberReputation('+1')).toEqual({ status: 'not_enrolled' });
    await expect(client(() => ({ status: 500, json: {} })).rep.numberReputation('+1')).rejects.toThrow(/500/);
  });
});
