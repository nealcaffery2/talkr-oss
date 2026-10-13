/**
 * Contacts import/export helpers (docs/contacts.md §5–6): spreadsheet row →
 * contact mapping, phone/tag normalization, bulk-message merge fields, and
 * CSV cells with formula injection neutralized. Pure — no database.
 */

import { describe, expect, it } from 'vitest';
import {
  CSV_BOM,
  csvCell,
  firstNameOf,
  mapImportRow,
  normalizeContactPhone,
  normalizeEmail,
  normalizePhoneList,
  normalizeTags,
  renderMergeFields,
  splitTags,
  toCsv,
} from '../src/services/contact-import.js';
import { likeContains, searchDigits } from '../src/services/contacts.js';

describe('normalizeContactPhone / normalizeEmail', () => {
  it('normalizes to E.164 and rejects what is not a dialable number', () => {
    expect(normalizeContactPhone('(614) 555-0134')).toBe('+16145550134');
    expect(normalizeContactPhone(' 1 614 555 0134 ')).toBe('+16145550134');
    expect(normalizeContactPhone('N/A')).toBeNull();
    expect(normalizeContactPhone('client:rep-1')).toBeNull();
    expect(normalizeContactPhone('')).toBeNull();
    expect(normalizeContactPhone(undefined)).toBeNull();
  });
  it('lowercases emails and drops non-emails', () => {
    expect(normalizeEmail(' Jane@Example.COM ')).toBe('jane@example.com');
    expect(normalizeEmail('not an email')).toBeNull();
    expect(normalizeEmail('')).toBeNull();
  });
});

describe('normalizePhoneList', () => {
  it('dedupes and makes the first flagged (else the first) primary', () => {
    const r = normalizePhoneList([
      { phone: '614-555-0134', label: 'home' },
      { phone: '(614) 555-0134' },
      { phone: '614-555-0199', is_primary: true, label: ' cell ' },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.phones).toEqual([
      { phoneE164: '+16145550134', label: 'home', isPrimary: false },
      { phoneE164: '+16145550199', label: 'cell', isPrimary: true },
    ]);
    const first = normalizePhoneList([{ phone: '614-555-0134' }, { phone: '614-555-0199' }]);
    expect(first.ok && first.phones.map((p) => p.isPrimary)).toEqual([true, false]);
  });
  it('fails the whole list on an invalid number, naming it', () => {
    const r = normalizePhoneList([{ phone: '614-555-0134' }, { phone: 'call me' }]);
    expect(r).toEqual({ ok: false, invalid: 'call me' });
  });
  it('an empty list is fine (email-only contacts)', () => {
    expect(normalizePhoneList([])).toEqual({ ok: true, phones: [] });
  });
});

describe('tags', () => {
  it('trims, dedupes case-insensitively and keeps order', () => {
    expect(normalizeTags([' Probate ', 'probate', '', null, 'Absentee', undefined])).toEqual(['Probate', 'Absentee']);
  });
  it('splits a spreadsheet cell on , ; |', () => {
    expect(splitTags('probate, absentee; tax lien|probate')).toEqual(['probate', 'absentee', 'tax lien']);
    expect(splitTags(null)).toEqual([]);
  });
});

describe('mapImportRow', () => {
  const mapping = {
    first_name: 'First',
    last_name: 'Last',
    phone: 'Phone',
    phone2: 'Mobile',
    email: 'Email',
    company: 'Company',
    address_line1: 'Address',
    city: 'City',
    state: 'State',
    postal_code: 'Zip',
    tags: 'Tags',
    notes: 'Notes',
    status: 'Status',
    type: 'Type',
  };

  it('maps a full row', () => {
    const r = mapImportRow(
      {
        First: 'Jane',
        Last: 'Doe',
        Phone: '614-555-0134',
        Mobile: '(614) 555-0199',
        Email: 'Jane@Example.com',
        Company: 'Doe Holdings',
        Address: '12 Main St',
        City: 'Columbus',
        State: 'oh',
        Zip: '43215',
        Tags: 'probate, absentee',
        Notes: 'Call after 5',
        Status: 'Engaged',
        Type: 'Seller',
      },
      mapping,
      { tags: ['import-2026'], source: 'county list' },
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.contact).toEqual({
      displayName: 'Jane Doe',
      type: 'seller',
      status: 'engaged',
      phones: [
        { phoneE164: '+16145550134', label: null, isPrimary: true },
        { phoneE164: '+16145550199', label: null, isPrimary: false },
      ],
      email: 'jane@example.com',
      company: 'Doe Holdings',
      address: { line1: '12 Main St', city: 'Columbus', state: 'OH', postal_code: '43215' },
      tags: ['import-2026', 'probate', 'absentee'],
      notes: 'Call after 5',
      source: 'county list',
    });
  });

  it('prefers an explicit display_name column', () => {
    const r = mapImportRow({ Name: 'J. Doe', First: 'Jane', Phone: '6145550134' }, { ...mapping, display_name: 'Name' });
    expect(r.ok && r.contact.displayName).toBe('J. Doe');
  });

  it('falls back through company, email and phone for the name', () => {
    expect(mapImportRow({ Company: 'Acme', Phone: '6145550134' }, mapping)).toMatchObject({
      ok: true,
      contact: { displayName: 'Acme' },
    });
    expect(mapImportRow({ Email: 'x@y.co' }, mapping)).toMatchObject({ ok: true, contact: { displayName: 'x@y.co', phones: [] } });
    expect(mapImportRow({ Phone: '6145550134' }, mapping)).toMatchObject({ ok: true, contact: { displayName: '+16145550134' } });
  });

  it('drops an invalid phone but keeps the row when another contact method exists', () => {
    const r = mapImportRow({ First: 'Jo', Phone: 'N/A', Mobile: '614 555 0199' }, mapping);
    expect(r.ok && r.contact.phones).toEqual([{ phoneE164: '+16145550199', label: null, isPrimary: true }]);
  });

  it('skips rows with no usable phone or email, and empty rows', () => {
    expect(mapImportRow({ First: 'Jo', Phone: 'N/A', Email: 'nope' }, mapping)).toEqual({ ok: false, reason: 'no_phone_or_email' });
    expect(mapImportRow({ First: '', Phone: ' ' }, mapping)).toEqual({ ok: false, reason: 'empty_row' });
    expect(mapImportRow({}, mapping)).toEqual({ ok: false, reason: 'empty_row' });
  });

  it('uses defaults for type/status and ignores unknown vocabulary', () => {
    const r = mapImportRow({ Phone: '6145550134', Status: 'Hot lead!!', Type: 'Buyer' }, mapping, { type: 'vendor', status: 'attempting' });
    expect(r.ok && [r.contact.type, r.contact.status]).toEqual(['buyer', 'attempting']);
    const d = mapImportRow({ Phone: '6145550134', Status: 'Under Contract' }, mapping);
    expect(d.ok && [d.contact.type, d.contact.status, d.contact.source]).toEqual(['seller', 'under_contract', 'import']);
  });

  it('leaves address null when no address column has a value', () => {
    const r = mapImportRow({ Phone: '6145550134', City: '' }, mapping);
    expect(r.ok && r.contact.address).toBeNull();
  });

  it('tolerates non-string cells', () => {
    const r = mapImportRow({ Phone: 6145550134, Zip: 43215, First: 'Num' } as Record<string, unknown>, mapping);
    expect(r.ok && r.contact.phones[0]?.phoneE164).toBe('+16145550134');
    expect(r.ok && r.contact.address?.postal_code).toBe('43215');
  });
});

describe('renderMergeFields', () => {
  it('replaces the five fields, leaves unknown braces, tidies gaps', () => {
    const out = renderMergeFields('Hi {first_name}, this is {rep_name} about {address} in {city}. {unknown} {name}', {
      first_name: 'Jane',
      name: 'Jane Doe',
      address: '12 Main St',
      city: 'Columbus',
      rep_name: 'Alex',
    });
    expect(out).toBe('Hi Jane, this is Alex about 12 Main St in Columbus. {unknown} Jane Doe');
    expect(renderMergeFields('Hi {first_name}, about {address} — still interested?', { first_name: 'Jane', address: null })).toBe(
      'Hi Jane, about — still interested?',
    );
    expect(renderMergeFields('Hi { First_Name }!', { first_name: 'Jo' })).toBe('Hi Jo!');
  });
  it('first name is the first word unless the name is a company', () => {
    expect(firstNameOf('Jane Doe')).toBe('Jane');
    expect(firstNameOf('  Jane ')).toBe('Jane');
    expect(firstNameOf('Doe Holdings LLC')).toBe('Doe Holdings LLC');
    expect(firstNameOf('')).toBeNull();
    expect(firstNameOf(null)).toBeNull();
  });
});

describe('csv', () => {
  it('quotes commas, quotes and newlines', () => {
    expect(csvCell('plain')).toBe('plain');
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('say "hi"')).toBe('"say ""hi"""');
    expect(csvCell('line\nbreak')).toBe('"line\nbreak"');
    expect(csvCell(null)).toBe('');
    expect(csvCell(42)).toBe('42');
    expect(csvCell(['a', 'b'])).toBe('"a, b"');
    expect(csvCell(new Date('2026-09-08T12:00:00Z'))).toBe('2026-09-08T12:00:00.000Z');
  });
  it('neutralizes spreadsheet formulas', () => {
    expect(csvCell('=HYPERLINK("http://x")')).toBe(`"'=HYPERLINK(""http://x"")"`);
    expect(csvCell('+1 614')).toBe("'+1 614");
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell('@cmd')).toBe("'@cmd");
    expect(csvCell('\tx')).toBe("'\tx");
    expect(csvCell('+16145550134')).toBe("'+16145550134");
  });
  it('writes a BOM, a header, CRLF rows', () => {
    const out = toCsv(['name', 'id'], [['Jane, Doe', 'abc'], ['=x', null]]);
    expect(CSV_BOM).toBe('﻿');
    expect(out.startsWith(CSV_BOM)).toBe(true);
    expect(out.slice(1)).toBe('name,id\r\n"Jane, Doe",abc\r\n\'=x,\r\n');
  });
});

describe('search helpers', () => {
  it('escapes LIKE metacharacters', () => {
    expect(likeContains('50%_off\\')).toBe('%50\\%\\_off\\\\%');
    expect(likeContains('jane')).toBe('%jane%');
  });
  it('extracts digits for a phone match only when there are at least three', () => {
    expect(searchDigits('(614) 555')).toBe('614555');
    expect(searchDigits('jane 42')).toBe('');
    expect(searchDigits('jane')).toBe('');
  });
});
