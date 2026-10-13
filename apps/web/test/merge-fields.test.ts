/**
 * The DOM-free half of the merge-field picker: where a `/query` starts and
 * ends, what a chosen field does to the body and the caret, and which fields
 * a typed query surfaces. Everything the composer's behaviour rests on.
 */

import { describe, expect, it } from 'vitest';
import {
  MERGE_FIELD_GUIDE,
  insertMergeField,
  matchMergeFields,
  mergeSegments,
  slashQueryAt,
  unknownFieldsIn,
} from '../lib/mergeFields';

describe('slashQueryAt', () => {
  it('opens on a slash at the start of the body', () => {
    expect(slashQueryAt('/', 1)).toEqual({ start: 0, query: '' });
    expect(slashQueryAt('/sel', 4)).toEqual({ start: 0, query: 'sel' });
  });

  it('opens on a slash after whitespace or a newline', () => {
    expect(slashQueryAt('hey /seller', 11)).toEqual({ start: 4, query: 'seller' });
    expect(slashQueryAt('line one\n/addr', 14)).toEqual({ start: 9, query: 'addr' });
    expect(slashQueryAt('hey\t/city', 9)).toEqual({ start: 4, query: 'city' });
  });

  it('never opens inside a word', () => {
    expect(slashQueryAt('and/or', 6)).toBeNull();
    expect(slashQueryAt('24/7', 4)).toBeNull();
  });

  it('never opens inside a URL', () => {
    expect(slashQueryAt('https://x/y', 11)).toBeNull();
    expect(slashQueryAt('see https://talkr.app/offers', 28)).toBeNull();
    // The `//` of a scheme is not a word boundary either.
    expect(slashQueryAt('https://', 8)).toBeNull();
  });

  it('closes once the query runs into whitespace or punctuation', () => {
    expect(slashQueryAt('hey / there', 11)).toBeNull();
    expect(slashQueryAt('hey /seller, hi', 15)).toBeNull();
  });

  it('gives up on a query too long to be a field name', () => {
    expect(slashQueryAt(`/${'a'.repeat(25)}`, 26)).toBeNull();
  });

  it('reads the query at the caret, not at the end of the body', () => {
    expect(slashQueryAt('hey /sel this is Riley', 8)).toEqual({ start: 4, query: 'sel' });
  });

  it('returns null for an out-of-range caret', () => {
    expect(slashQueryAt('hey', 0)).toBeNull();
    expect(slashQueryAt('hey', 9)).toBeNull();
  });
});

describe('insertMergeField', () => {
  it('swaps the typed query for the token and parks the caret after it', () => {
    const r = insertMergeField('hey /seller this is Riley', 11, 'first_name', 'seller');
    expect(r.value).toBe('hey {first_name} this is Riley');
    expect(r.caret).toBe(16);
    expect(r.value.slice(0, r.caret)).toBe('hey {first_name}');
  });

  it('handles the bare slash with no query typed yet', () => {
    expect(insertMergeField('hey /', 5, 'first_name', '')).toEqual({
      value: 'hey {first_name}',
      caret: 16,
    });
  });

  it('inserts at the caret when the text there is not the query we were told about', () => {
    // A stale event: the caret moved off the query before the click landed.
    const r = insertMergeField('hello world', 5, 'city', 'seller');
    expect(r.value).toBe('hello{city} world');
    expect(r.caret).toBe(11);
  });

  it('clamps a caret past the end of the body', () => {
    expect(insertMergeField('hi', 99, 'city', '')).toEqual({ value: 'hi{city}', caret: 8 });
  });
});

describe('matchMergeFields', () => {
  const top = (q: string) => matchMergeFields(q)[0]?.field;

  it('lists everything for an empty query', () => {
    expect(matchMergeFields('')).toHaveLength(MERGE_FIELD_GUIDE.length);
  });

  it('surfaces the first name for every way a rep says it', () => {
    for (const q of ['seller', 'sellername', 'seller_name', 'fname', 'first', 'firstname']) {
      expect(top(q)).toBe('first_name');
    }
  });

  it('surfaces the address for street and addr', () => {
    expect(top('street')).toBe('address');
    expect(top('addr')).toBe('address');
    expect(top('property')).toBe('address');
  });

  it('prefers an exact field name over a partial one', () => {
    expect(top('name')).toBe('name');
    expect(top('state')).toBe('state');
    expect(top('zip')).toBe('postal_code');
  });

  it('matches on the label as well as the token', () => {
    expect(matchMergeFields('workspace').map((s) => s.field)).toContain('org_name');
  });

  it('returns nothing for a query no field answers — that is what closes the list', () => {
    expect(matchMergeFields('qqzz')).toEqual([]);
  });

  it('narrows to the tokens a surface accepts', () => {
    const allowed = ['first_name', 'address'] as const;
    expect(matchMergeFields('', allowed).map((s) => s.field)).toEqual(['first_name', 'address']);
    // postal_code exists in the catalogue but this surface would reject it.
    expect(matchMergeFields('zip', allowed)).toEqual([]);
  });
});

describe('mergeSegments', () => {
  it('substitutes what it has and keeps the rest visible', () => {
    const segs = mergeSegments('Hi {first_name}, about {address}.', { first_name: 'Marisol' });
    expect(segs).toEqual([
      { kind: 'text', text: 'Hi ' },
      { kind: 'value', text: 'Marisol', field: 'first_name' },
      { kind: 'text', text: ', about ' },
      { kind: 'empty', text: '{address}', field: 'address', known: true },
      { kind: 'text', text: '.' },
    ]);
  });

  it('treats a whitespace-only value as no value', () => {
    const segs = mergeSegments('{city}', { city: '   ' });
    expect(segs).toEqual([{ kind: 'empty', text: '{city}', field: 'city', known: true }]);
  });

  it('accepts double braces and inner whitespace, the way the server does', () => {
    expect(mergeSegments('{{ first_name }}', { first_name: 'Marisol' })).toEqual([
      { kind: 'value', text: 'Marisol', field: 'first_name' },
    ]);
  });

  it('marks a field nobody knows', () => {
    expect(mergeSegments('{nope}', {})).toEqual([{ kind: 'empty', text: '{nope}', field: 'nope', known: false }]);
  });
});

describe('unknownFieldsIn', () => {
  it('lists each unknown field once, in order', () => {
    expect(unknownFieldsIn('{first_name} {nope} {city} {nope} {huh}')).toEqual(['nope', 'huh']);
  });

  it('is relative to the surface, not the whole catalogue', () => {
    expect(unknownFieldsIn('{postal_code}')).toEqual([]);
    expect(unknownFieldsIn('{postal_code}', ['first_name', 'city'])).toEqual(['postal_code']);
  });
});
