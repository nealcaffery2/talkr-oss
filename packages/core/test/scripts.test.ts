/**
 * In-call scripts (docs/scripts.md): merge-field rendering that never leaves
 * a brace behind, and the campaign → contact-type → generic selection rule.
 * Pure — no database.
 */

import { describe, expect, it } from 'vitest';
import { permissionsForRole } from '../src/rbac.js';
import {
  compareScripts,
  emptyScriptMergeVars,
  findScriptMergeFields,
  firstWordOf,
  formatPhoneForSpeech,
  renderScriptMergeFields,
  scriptTier,
  selectScripts,
  unknownScriptMergeFields,
  type SelectableScript,
} from '../src/scripts.js';

describe('renderScriptMergeFields', () => {
  const vars = {
    ...emptyScriptMergeVars(),
    first_name: 'Jane',
    name: 'Jane Doe',
    address: '123 Rutger St',
    city: 'Columbus',
    state: 'OH',
    postal_code: '43215',
    company: 'Your Company',
    rep_name: 'Sam Rep',
    rep_first_name: 'Sam',
    phone: '(614) 555-0134',
  };

  it('substitutes every known field, single or double braces, any spacing or case', () => {
    expect(renderScriptMergeFields('Hey {first_name}, this is {rep_first_name} with {{ company }}.', vars)).toBe(
      'Hey Jane, this is Sam with Your Company.',
    );
    expect(renderScriptMergeFields('{Address}, {city} {state} {postal_code} — {phone}', vars)).toBe(
      '123 Rutger St, Columbus OH 43215 — (614) 555-0134',
    );
  });

  it('renders an unknown field as an empty string, never as braces', () => {
    const out = renderScriptMergeFields('Hi {first_name}, about {mystery_field} at {address}.', vars);
    expect(out).toBe('Hi Jane, about at 123 Rutger St.');
    expect(out).not.toContain('{');
    expect(out).not.toContain('}');
  });

  it('renders a known field with no value as empty and tidies the gap', () => {
    const out = renderScriptMergeFields('Hey {first_name}, this is {rep_first_name}.', {
      ...emptyScriptMergeVars(),
      rep_first_name: 'Sam',
    });
    expect(out).toBe('Hey, this is Sam.');
  });

  it('leaves markdown indentation and newlines alone', () => {
    const body = '## Opener\n\n- “Hi {first_name}”\n  - nested {city}\n\n> if they say…';
    expect(renderScriptMergeFields(body, vars)).toBe('## Opener\n\n- “Hi Jane”\n  - nested Columbus\n\n> if they say…');
  });

  it('finds and classifies the fields a body references', () => {
    expect(findScriptMergeFields('{first_name} {{name}} {first_name} {bogus}')).toEqual(['first_name', 'name', 'bogus']);
    expect(unknownScriptMergeFields('{first_name} {bogus} {Other}')).toEqual(['bogus', 'other']);
    expect(unknownScriptMergeFields('{first_name} {name} {address} {city} {state} {postal_code} {company} {rep_name} {rep_first_name} {phone}')).toEqual([]);
  });

  it('helpers: first word of a person, whole name of a company, spoken phone', () => {
    expect(firstWordOf('Jane Doe')).toBe('Jane');
    expect(firstWordOf('  Jane ')).toBe('Jane');
    expect(firstWordOf('Your Company LLC')).toBe('Your Company LLC');
    expect(firstWordOf(null)).toBe('');
    expect(formatPhoneForSpeech('+16145550134')).toBe('(614) 555-0134');
    expect(formatPhoneForSpeech('+442071234567')).toBe('+442071234567');
    expect(formatPhoneForSpeech(null)).toBe('');
  });
});

describe('selectScripts', () => {
  const C1 = '11111111-1111-4111-8111-111111111111';
  const C2 = '22222222-2222-4222-8222-222222222222';
  const script = (over: Partial<SelectableScript> & { id: string }): SelectableScript => ({
    kind: 'script',
    title: over.id,
    enabled: true,
    campaign_id: null,
    contact_types: [],
    sort_order: 0,
    ...over,
  });

  const generic1 = script({ id: 'generic-1', sort_order: 10 });
  const generic2 = script({ id: 'generic-2', sort_order: 20 });
  const seller1 = script({ id: 'seller-1', sort_order: 100, contact_types: ['seller'] });
  const buyer1 = script({ id: 'buyer-1', sort_order: 5, contact_types: ['buyer'] });
  const camp1 = script({ id: 'camp-1', sort_order: 500, campaign_id: C1 });
  const camp1Buyer = script({ id: 'camp-1-buyer', sort_order: 1, campaign_id: C1, contact_types: ['buyer'] });
  const camp2 = script({ id: 'camp-2', sort_order: 1, campaign_id: C2 });
  const disabled = script({ id: 'disabled', sort_order: -100, enabled: false });
  const rebuttalA = script({ id: 'reb-a', kind: 'rebuttal', sort_order: 20 });
  const rebuttalB = script({ id: 'reb-b', kind: 'rebuttal', sort_order: 10 });
  const rebuttalCamp2 = script({ id: 'reb-camp2', kind: 'rebuttal', sort_order: 0, campaign_id: C2 });
  const all = [generic2, generic1, seller1, buyer1, camp1, camp1Buyer, camp2, disabled, rebuttalA, rebuttalB, rebuttalCamp2];

  it('tiers: a campaign script leads; typed and generic scripts share the rest', () => {
    const ctx = { campaignId: C1, contactType: 'seller' };
    expect(scriptTier(camp1, ctx)).toBe(0);
    expect(scriptTier(seller1, ctx)).toBe(1);
    expect(scriptTier(generic1, ctx)).toBe(1);
    expect(scriptTier(camp1Buyer, ctx)).toBeNull(); // right campaign, wrong contact type
    expect(scriptTier(camp2, ctx)).toBeNull(); // another campaign
    expect(scriptTier(buyer1, ctx)).toBeNull(); // wrong contact type
    expect(scriptTier(disabled, ctx)).toBeNull();
  });

  it('campaign known + seller: the campaign script wins even with a high sort_order', () => {
    const r = selectScripts(all, { campaignId: C1, contactType: 'seller' });
    expect(r.primary?.id).toBe('camp-1');
    expect(r.alternatives.map((a) => a.id)).toEqual(['generic-1', 'generic-2', 'seller-1']);
    expect(r.rebuttals.map((a) => a.id)).toEqual(['reb-b', 'reb-a']);
  });

  it('no campaign + seller: playbook order decides, a seller-typed script does not jump it', () => {
    // A script written for sellers (the novation pitch) is not what a rep
    // opens a seller call with; sort_order is the running order.
    const r = selectScripts(all, { campaignId: null, contactType: 'seller' });
    expect(r.primary?.id).toBe('generic-1');
    expect(r.alternatives.map((a) => a.id)).toEqual(['generic-2', 'seller-1']);
  });

  it('unknown caller (no contact): only generic scripts apply, lowest sort_order first', () => {
    const r = selectScripts(all, { campaignId: null, contactType: null });
    expect(r.primary?.id).toBe('generic-1');
    expect(r.alternatives.map((a) => a.id)).toEqual(['generic-2']);
    expect(r.rebuttals.map((a) => a.id)).toEqual(['reb-b', 'reb-a']);
  });

  it('campaign 2 + buyer: campaign-pinned rebuttals rise to the top', () => {
    const r = selectScripts(all, { campaignId: C2, contactType: 'buyer' });
    expect(r.primary?.id).toBe('camp-2');
    expect(r.alternatives.map((a) => a.id)).toEqual(['buyer-1', 'generic-1', 'generic-2']);
    expect(r.rebuttals.map((a) => a.id)).toEqual(['reb-camp2', 'reb-b', 'reb-a']);
  });

  it('nothing enabled: primary null, lists empty', () => {
    expect(selectScripts([disabled], { campaignId: null, contactType: 'seller' })).toEqual({
      primary: null,
      alternatives: [],
      rebuttals: [],
    });
  });

  it('ties on sort_order break on title, then id, deterministically', () => {
    const a = script({ id: 'b-id', title: 'Alpha' });
    const b = script({ id: 'a-id', title: 'Alpha' });
    const c = script({ id: 'z', title: 'Beta' });
    expect([c, a, b].sort(compareScripts).map((x) => x.id)).toEqual(['a-id', 'b-id', 'z']);
  });
});

describe('rbac: scripts', () => {
  it('everyone reads; manager and up write', () => {
    expect(permissionsForRole('rep').has('scripts.read')).toBe(true);
    expect(permissionsForRole('rep').has('scripts.write')).toBe(false);
    expect(permissionsForRole('manager').has('scripts.write')).toBe(true);
    expect(permissionsForRole('admin').has('scripts.write')).toBe(true);
    expect(permissionsForRole('owner').has('scripts.write')).toBe(true);
  });
});
