/**
 * Contacts vocabulary (docs/contacts.md). Text columns in the database, closed
 * sets in code: adding a value is a code review, not a migration, and the API
 * rejects anything outside these lists.
 */

export const CONTACT_TYPES = ['seller', 'buyer', 'title', 'company', 'vendor', 'other'] as const;
export type ContactType = (typeof CONTACT_TYPES)[number];

export const CONTACT_STATUSES = [
  'new',
  'attempting',
  'engaged',
  'appointment',
  'offer',
  'under_contract',
  'closed',
  'dead',
  'dnc',
] as const;
export type ContactStatus = (typeof CONTACT_STATUSES)[number];

export const TEMPERATURES = ['hot', 'warm', 'cold'] as const;
export type Temperature = (typeof TEMPERATURES)[number];

export function isContactType(value: string): value is ContactType {
  return (CONTACT_TYPES as readonly string[]).includes(value);
}

export function isContactStatus(value: string): value is ContactStatus {
  return (CONTACT_STATUSES as readonly string[]).includes(value);
}

export function isTemperature(value: string): value is Temperature {
  return (TEMPERATURES as readonly string[]).includes(value);
}
