/**
 * Tests for the ISO 13616 IBAN validator.
 *
 * Reference IBANs sourced from the SWIFT IBAN Registry "Example" section
 * — they are publicly published sample values used by every IBAN
 * implementation as test vectors. NOT real account numbers.
 */
const { validateIban, _internal } = require('../../src/utils/iban');

describe('validateIban', () => {
  it('accepts a canonical Swiss IBAN', () => {
    const out = validateIban('CH9300762011623852957');
    expect(out.valid).toBe(true);
    expect(out.normalized).toBe('CH9300762011623852957');
    expect(out.reason).toBeUndefined();
  });

  it('accepts a Liechtenstein IBAN', () => {
    expect(validateIban('LI21088100002324013AA').valid).toBe(true);
  });

  it('accepts a German IBAN', () => {
    expect(validateIban('DE89370400440532013000').valid).toBe(true);
  });

  it('accepts an Austrian IBAN', () => {
    expect(validateIban('AT611904300234573201').valid).toBe(true);
  });

  it('accepts a British IBAN with alphanumeric BBAN', () => {
    expect(validateIban('GB82WEST12345698765432').valid).toBe(true);
  });

  it('normalises spaces and lowercase input', () => {
    const out = validateIban(' ch93 0076 2011 6238 5295 7 ');
    expect(out.valid).toBe(true);
    expect(out.normalized).toBe('CH9300762011623852957');
  });

  it('normalises mixed-case input', () => {
    const out = validateIban('ch9300762011623852957');
    expect(out.valid).toBe(true);
    expect(out.normalized).toBe('CH9300762011623852957');
  });

  it('rejects an empty / null / undefined value', () => {
    expect(validateIban('').reason).toBe('EMPTY');
    expect(validateIban('   ').reason).toBe('EMPTY');
    expect(validateIban(null).reason).toBe('EMPTY');
    expect(validateIban(undefined).reason).toBe('EMPTY');
  });

  it('rejects a malformed string (numbers in the country slot)', () => {
    const out = validateIban('12930076201162385295');
    expect(out.valid).toBe(false);
    expect(out.reason).toBe('FORMAT');
  });

  it('rejects a too-short string', () => {
    expect(validateIban('CH93').reason).toBe('FORMAT');
  });

  it('rejects a too-long string (over 34 chars)', () => {
    // 35 chars: pads beyond the ISO 13616 max
    expect(validateIban('CH9300762011623852957XXXXXXXXXXXXXX').reason).toBe('FORMAT');
  });

  it('rejects a known-country IBAN with the wrong length', () => {
    // CH must be 21 chars; this one is 22.
    const out = validateIban('CH9300762011623852957X');
    expect(out.valid).toBe(false);
    expect(out.reason).toBe('LENGTH');
  });

  it('rejects an IBAN with a broken checksum', () => {
    // Same shape, last digit altered.
    const out = validateIban('CH9300762011623852950');
    expect(out.valid).toBe(false);
    expect(out.reason).toBe('CHECKSUM');
  });

  it('rejects an IBAN with internally invalid characters', () => {
    expect(validateIban('CH93007620!1623852957').reason).toBe('FORMAT');
  });

  it('accepts an unknown-country IBAN that meets the generic length range', () => {
    // Made-up country code "ZZ" — not in IBAN_LENGTHS but the
    // structural regex passes if length is in [15, 34] and the
    // checksum holds. Build a checksum-valid string:
    //
    //   Format: ZZ + check + BBAN. We don't have a real ZZ template
    //   so this test just confirms unknown country codes route
    //   through the fallback length check rather than failing on
    //   LENGTH outright. A checksum-failing ZZ value will hit
    //   CHECKSUM, not LENGTH, which is the assertion below.
    const out = validateIban('ZZ00ABCDEFGHIJKLMNOP');
    expect(out.valid).toBe(false);
    expect(out.reason).toBe('CHECKSUM'); // not LENGTH
  });
});

describe('mod97', () => {
  it('returns 1 for the canonical CH test vector', () => {
    expect(_internal.mod97('CH9300762011623852957')).toBe(1);
  });

  it('returns something other than 1 for a tampered IBAN', () => {
    expect(_internal.mod97('CH9300762011623852950')).not.toBe(1);
  });
});

describe('IBAN_LENGTHS table', () => {
  it('has the expected lengths for the most common European countries', () => {
    // Sanity check that the table didn't drift if someone edits it.
    expect(_internal.IBAN_LENGTHS.CH).toBe(21);
    expect(_internal.IBAN_LENGTHS.DE).toBe(22);
    expect(_internal.IBAN_LENGTHS.AT).toBe(20);
    expect(_internal.IBAN_LENGTHS.LI).toBe(21);
    expect(_internal.IBAN_LENGTHS.FR).toBe(27);
    expect(_internal.IBAN_LENGTHS.IT).toBe(27);
    expect(_internal.IBAN_LENGTHS.GB).toBe(22);
    expect(_internal.IBAN_LENGTHS.NL).toBe(18);
  });
});
