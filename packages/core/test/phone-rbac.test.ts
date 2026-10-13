import { describe, expect, it } from 'vitest';
import { maskPhone, normalizePhone } from '../src/phone.js';
import { permissionsForRole, roleHas } from '../src/rbac.js';

describe('normalizePhone', () => {
  it('normalizes common US formats to E.164', () => {
    expect(normalizePhone('(614) 555-0134').e164).toBe('+16145550134');
    expect(normalizePhone('614-555-0134').e164).toBe('+16145550134');
    expect(normalizePhone('16145550134').e164).toBe('+16145550134');
    expect(normalizePhone('+16145550134').e164).toBe('+16145550134');
  });
  it('flags un-normalizable input without dropping it', () => {
    const r = normalizePhone('call me maybe');
    expect(r.ok).toBe(false);
    expect(r.raw).toBe('call me maybe');
  });
  it('masks phones for logs', () => {
    expect(maskPhone('+16145550134')).toBe('…0134');
  });
});

describe('rbac', () => {
  it('reps get own-scope only', () => {
    expect(roleHas('rep', 'calls.read.own')).toBe(true);
    expect(roleHas('rep', 'calls.read.org')).toBe(false);
    expect(roleHas('rep', 'admin.events')).toBe(false);
  });
  it('managers see the org but not admin surfaces', () => {
    expect(roleHas('manager', 'calls.read.org')).toBe(true);
    expect(roleHas('manager', 'admin.events')).toBe(false);
  });
  it('admins and owners get admin surfaces', () => {
    expect(roleHas('admin', 'admin.events')).toBe(true);
    expect(permissionsForRole('owner').has('admin.integrations')).toBe(true);
  });
});
