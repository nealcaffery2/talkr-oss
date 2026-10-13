/**
 * Click-to-call lives or dies on this module. A missed number is a feature
 * nobody trusts; a false positive is a rep dialling an invoice total in front
 * of a seller. Both directions are tested, and the negative cases are the ones
 * worth keeping: they are the strings the web is actually full of.
 */

import { describe, expect, it } from 'vitest';
import {
  findPhoneNumbers,
  formatE164,
  isPhoneNumber,
  telHrefToE164,
  toE164,
} from '../src/content/phone-numbers';

describe('toE164', () => {
  it('takes the shapes people write NANP numbers in', () => {
    const expected = '+12105550101';
    for (const raw of [
      '2105550101',
      '210-555-0101',
      '210.555.0101',
      '210 555 0101',
      '(210) 555-0101',
      '(210)555-0101',
      '1-210-555-0101',
      '1 (210) 555-0101',
      '12105550101',
      '+1 210 555 0101',
      '+1 (210) 555-0101',
      '+12105550101',
      '210 5550101',
    ]) {
      expect(toE164(raw), raw).toBe(expected);
    }
  });

  it('accepts international numbers that carry their own +', () => {
    expect(toE164('+44 20 7946 0958')).toBe('+442079460958');
    expect(toE164('+52 55 1234 5678')).toBe('+525512345678');
  });

  it('refuses digit runs that are not numbers', () => {
    for (const raw of [
      '2024-05-10', // a date
      '1.2.3.4', // a version
      '12345-6789', // ZIP+4
      '0123456789', // NANP area codes never start with 0
      '1123456789', // …nor 1
      '2109110101', // N11 exchange
      '123456789', // nine digits
      '123456789012', // twelve, no +
      '+1234567', // too short even with a +
      '1234567890123456', // longer than E.164 allows
    ]) {
      expect(toE164(raw), raw).toBeNull();
    }
  });

  it('refuses a grouping nobody writes a phone number in', () => {
    expect(toE164('21-05-55-01-01')).toBeNull();
    expect(toE164('2105 5501 01')).toBeNull();
  });

  it('is the one rule isPhoneNumber answers from', () => {
    expect(isPhoneNumber('(210) 555-0101')).toBe(true);
    expect(isPhoneNumber('2024-05-10')).toBe(false);
  });
});

describe('findPhoneNumbers', () => {
  it('finds a number in a sentence and reports where it sits', () => {
    const text = 'Call the seller at (210) 555-0101 before noon.';
    const [match, ...rest] = findPhoneNumbers(text);
    expect(rest).toEqual([]);
    expect(match!.text).toBe('(210) 555-0101');
    expect(match!.e164).toBe('+12105550101');
    expect(text.slice(match!.index, match!.index + match!.text.length)).toBe('(210) 555-0101');
  });

  it('finds several, left to right, without overlapping', () => {
    const found = findPhoneNumbers('Mobile 210-555-0101, office +1 512 555 0142.');
    expect(found.map((f) => f.e164)).toEqual(['+12105550101', '+15125550142']);
  });

  it('leaves a number that is the middle of a longer digit run alone', () => {
    expect(findPhoneNumbers('order 99214155550101992')).toEqual([]);
    expect(findPhoneNumbers('ref#2105550101')).toEqual([]);
    expect(findPhoneNumbers('x2105550101')).toEqual([]);
  });

  it('keeps its hands off the strings a page is full of', () => {
    for (const text of [
      'Invoice 1,234,567.89 paid 2024-05-10',
      'Version 10.15.7 build 20240510',
      'SKU 4059821005512 shipped',
      'Lot 12345-6789, Austin TX 78701',
      '© 2024 Your Company. All rights reserved.',
      'Meeting at 10:30 on 05/10/2024',
    ]) {
      expect(findPhoneNumbers(text), text).toEqual([]);
    }
  });

  it('does not take a trailing full stop into the number', () => {
    const [match] = findPhoneNumbers('Reach me on 210-555-0101.');
    expect(match!.text).toBe('210-555-0101');
  });

  it('says nothing about text too short to hold a number', () => {
    expect(findPhoneNumbers('555')).toEqual([]);
    expect(findPhoneNumbers('')).toEqual([]);
  });
});

describe('telHrefToE164', () => {
  it('reads the number a page states outright', () => {
    expect(telHrefToE164('tel:+1-210-555-0101')).toBe('+12105550101');
    expect(telHrefToE164('tel:2105550101')).toBe('+12105550101');
    expect(telHrefToE164('tel:%2B442079460958')).toBe('+442079460958');
  });

  it('drops the extension and parameters a tel: URI may carry', () => {
    expect(telHrefToE164('tel:+12105550101;ext=42')).toBe('+12105550101');
  });

  it('still refuses an href with no number in it', () => {
    expect(telHrefToE164('tel:')).toBeNull();
    expect(telHrefToE164('tel:support')).toBeNull();
  });
});

describe('formatE164', () => {
  it('reads a US number back the way it was written', () => {
    expect(formatE164('+12105550101')).toBe('(210) 555-0101');
  });
  it('leaves a number it cannot lay out alone', () => {
    expect(formatE164('+442079460958')).toBe('+442079460958');
  });
});
