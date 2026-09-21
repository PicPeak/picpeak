import { describe, expect, it } from 'vitest';
import { creditGroups, creditKeyOf, CREDIT_KEY_GUEST, CREDIT_KEY_PHOTOGRAPHER } from '../photoCredits';

describe('photo credit grouping (#1561)', () => {
  it('keys a named photo by name, a nameless guest upload and the photographer apart', () => {
    expect(creditKeyOf({ credit_name: 'Anna' })).toBe('name:Anna');
    expect(creditKeyOf({ credit_name: null, uploaded_by_guest: true })).toBe(CREDIT_KEY_GUEST);
    expect(creditKeyOf({ credit_name: null, uploaded_by_guest: false })).toBe(CREDIT_KEY_PHOTOGRAPHER);
  });

  it('a guest called "photographer" cannot collide with the built-in group', () => {
    expect(creditKeyOf({ credit_name: 'kind:photographer' })).not.toBe(CREDIT_KEY_PHOTOGRAPHER);
  });

  it('counts, names first alphabetically, then unnamed guests, then the photographer', () => {
    const groups = creditGroups([
      { credit_name: null },
      { credit_name: 'zoe' },
      { credit_name: 'Anna', uploaded_by_guest: true },
      { credit_name: null, uploaded_by_guest: true },
      { credit_name: 'Anna', uploaded_by_guest: true },
    ], 'en');
    expect(groups.map((g) => [g.kind, g.name, g.count])).toEqual([
      ['name', 'Anna', 2],
      ['name', 'zoe', 1],
      ['guest', null, 1],
      ['photographer', null, 1],
    ]);
  });

  it('offers no filter when nobody is named', () => {
    expect(creditGroups([{ credit_name: null }, { credit_name: null, uploaded_by_guest: true }])).toEqual([]);
  });
});
