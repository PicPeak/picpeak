/**
 * IBAN validation per ISO 13616.
 *
 * Three checks:
 *   1. Format — 2 uppercase letters (country) + 2 digits (check) +
 *      alphanumeric BBAN.
 *   2. Length — each country fixes a total IBAN length. We accept any
 *      country whose ISO code we recognise; unknown country codes
 *      fall back to a generic 15–34 char range (ISO 13616 caps every
 *      IBAN at 34 chars).
 *   3. Mod-97 checksum — rearrange the IBAN so the first four chars
 *      land at the end, expand letters to digits (A=10..Z=35), the
 *      result modulo 97 MUST equal 1. Catches single-digit typos and
 *      digit transpositions with high probability.
 *
 * The validator is pure (no IO, no DB, no network) and returns a
 * structured result so callers can surface a precise reason to the
 * user.
 *
 * What this does NOT do:
 *   - Confirm the bank itself exists (would require an external
 *     directory or a bank-routing API — out of scope here).
 *   - Validate the BBAN's internal structure beyond length + charset
 *     (country-specific BBAN rules are not enforced).
 *
 * Usage:
 *   const { valid, normalized, reason } = validateIban(' ch 93 0076  2011 6238 5295 7 ');
 *   if (!valid) throw new Error(reason);
 *   // normalized === 'CH9300762011623852957'
 */

// IBAN length per ISO country code (ISO 13616, public registry).
// Anything not in this table falls through to the 15–34 range check.
// Source: SWIFT IBAN Registry. Update when new countries are added.
const IBAN_LENGTHS = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28,
  BA: 20, BE: 16, BG: 22, BH: 22, BR: 29, BY: 28,
  CH: 21, CR: 22, CY: 28, CZ: 24,
  DE: 22, DK: 18, DO: 28,
  EE: 20, EG: 29, ES: 24,
  FI: 18, FO: 18, FR: 27,
  GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28,
  HR: 21, HU: 28,
  IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27,
  JO: 30,
  KW: 30, KZ: 20,
  LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25,
  MC: 27, MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30,
  NL: 18, NO: 15,
  PK: 24, PL: 28, PS: 29, PT: 25,
  QA: 29,
  RO: 24, RS: 22,
  SA: 24, SC: 31, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28,
  TL: 23, TN: 24, TR: 26,
  UA: 29,
  VA: 22, VG: 24,
  XK: 20,
};

/**
 * Rearrange + numerify the IBAN per ISO 13616 then take mod 97.
 * The whole-string-as-BigInt approach is acceptable here: max IBAN
 * length is 34 chars → numerified length is at most ~68 digits.
 * Native BigInt is plenty fast for one-off validation.
 */
function mod97(iban) {
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let expanded = '';
  for (const ch of rearranged) {
    if (ch >= '0' && ch <= '9') {
      expanded += ch;
    } else if (ch >= 'A' && ch <= 'Z') {
      // A=10, B=11, ..., Z=35
      expanded += String(ch.charCodeAt(0) - 55);
    } else {
      return -1; // invalid char — caller treats as failed checksum
    }
  }
  // Standard chunked mod-97 to avoid BigInt allocation cost.
  let remainder = 0;
  for (const digit of expanded) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder;
}

/**
 * Normalise + validate an IBAN string.
 *
 * @param {unknown} input  Raw user-typed value. Spaces and lowercase
 *                         letters are tolerated and stripped/uppercased
 *                         before checking.
 * @returns {{
 *   valid: boolean,
 *   normalized: string,           // empty when input wasn't a string
 *   reason?: 'EMPTY'              // nothing useful supplied
 *           | 'FORMAT'            // failed the structural regex
 *           | 'LENGTH'            // wrong length for the country
 *           | 'CHECKSUM'          // mod-97 didn't equal 1
 * }}
 */
function validateIban(input) {
  if (input == null) return { valid: false, normalized: '', reason: 'EMPTY' };
  const raw = String(input).replace(/\s+/g, '').toUpperCase();
  if (!raw) return { valid: false, normalized: '', reason: 'EMPTY' };

  // ISO 13616: starts with 2 letters (country) + 2 digits (check) +
  // 11..30 chars of alphanumeric BBAN. Total length 15..34.
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(raw)) {
    return { valid: false, normalized: raw, reason: 'FORMAT' };
  }

  const country = raw.slice(0, 2);
  const expectedLen = IBAN_LENGTHS[country];
  if (expectedLen != null) {
    if (raw.length !== expectedLen) {
      return { valid: false, normalized: raw, reason: 'LENGTH' };
    }
  } else if (raw.length < 15 || raw.length > 34) {
    return { valid: false, normalized: raw, reason: 'LENGTH' };
  }

  if (mod97(raw) !== 1) {
    return { valid: false, normalized: raw, reason: 'CHECKSUM' };
  }

  return { valid: true, normalized: raw };
}

module.exports = {
  validateIban,
  // Exposed for unit tests.
  _internal: { mod97, IBAN_LENGTHS },
};
