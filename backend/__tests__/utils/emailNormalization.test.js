/**
 * Regression coverage for the identity-preserving email normalization
 * options (#574).
 *
 * express-validator's `.normalizeEmail()` applies provider-specific
 * canonicalization by default — Gmail dot-stripping, +tag stripping,
 * googlemail → gmail folding, etc. That breaks identity because login
 * lookups expect the address as the user was invited with, not the
 * canonicalized form.
 *
 * The tests below run validator.js's `normalizeEmail` (the same
 * implementation express-validator delegates to) through the
 * `IDENTITY_PRESERVING_NORMALIZE_EMAIL` options object and pin the
 * behaviour we depend on:
 *   - dots preserved on Gmail
 *   - +tags preserved on Gmail / Outlook / Yahoo / iCloud
 *   - googlemail.com domain preserved (not folded to gmail.com)
 *   - local-part lowercased (still the default — safe and consistent)
 */
const validator = require('validator');
const { IDENTITY_PRESERVING_NORMALIZE_EMAIL } = require('../../src/utils/emailNormalization');

const norm = (email) => validator.normalizeEmail(email, IDENTITY_PRESERVING_NORMALIZE_EMAIL);

describe('IDENTITY_PRESERVING_NORMALIZE_EMAIL', () => {
  it('preserves dots in the Gmail local-part (the #574 root cause)', () => {
    expect(norm('john.doe@gmail.com')).toBe('john.doe@gmail.com');
    expect(norm('j.o.h.n@gmail.com')).toBe('j.o.h.n@gmail.com');
  });

  it('preserves Gmail +tags (subaddresses)', () => {
    expect(norm('john.doe+invoices@gmail.com')).toBe('john.doe+invoices@gmail.com');
  });

  it('does not fold googlemail.com to gmail.com', () => {
    expect(norm('john.doe@googlemail.com')).toBe('john.doe@googlemail.com');
  });

  it('preserves Outlook +tags', () => {
    expect(norm('jane+work@outlook.com')).toBe('jane+work@outlook.com');
  });

  it('preserves Yahoo -tags', () => {
    expect(norm('jane-work@yahoo.com')).toBe('jane-work@yahoo.com');
  });

  it('preserves iCloud +tags', () => {
    expect(norm('jane+receipts@icloud.com')).toBe('jane+receipts@icloud.com');
  });

  it('lowercases the local-part (default behaviour we keep)', () => {
    // all_lowercase defaults true in validator.js. Local-parts are
    // case-insensitive in practice on every major provider, and
    // lowercasing keeps login lookup consistent.
    expect(norm('John.Doe@Gmail.com')).toBe('john.doe@gmail.com');
  });
});
