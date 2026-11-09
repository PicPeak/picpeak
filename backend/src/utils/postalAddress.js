'use strict';

/**
 * Postal addresses in the convention of the country they belong to.
 *
 * The documents were written for Liechtenstein, Switzerland and Germany, where
 * the city line is "<CC>-<postal> <city>" ("FL-9494 Schaan") and the country
 * follows on its own. In the United States the city line is
 * "City, ST 12345", and a letter that stays inside the country carries no
 * country line. A UK address puts the post town and the postcode on lines of
 * their own (Royal Mail), and a UK letter to a UK address has no country line
 * either. Every address on a PDF, in the email signature and in the
 * contract placeholders goes through here, so they agree with each other.
 */

function isUnitedStates(countryCode) {
  return String(countryCode || '').trim().toUpperCase() === 'US';
}

/** A business in the United Kingdom (ISO code GB; "UK" is accepted too). */
function isUnitedKingdom(countryCode) {
  const cc = String(countryCode || '').trim().toUpperCase();
  return cc === 'GB' || cc === 'UK';
}

/**
 * Is this address written the UK way? Only by a business in the UK: a
 * business elsewhere keeps printing a UK customer's address as it always
 * has ("GB-SW1A 1AA London"). Without `issuerCountryCode` the address is the
 * business's own, so its own country decides.
 */
function writesUkForm(countryCode, issuerCountryCode) {
  return isUnitedKingdom(countryCode)
    && (issuerCountryCode === undefined || isUnitedKingdom(issuerCountryCode));
}

/**
 * The line under the street, for a one-line address: "Denver, CO 80202" for
 * a US address, "Glasgow G1 1AA" for a UK one written by a UK business,
 * "LI-9494 Schaan" elsewhere. Pass `issuerCountryCode` for a customer's
 * address.
 */
function cityLine({ postalCode, city, state, countryCode } = {}, { issuerCountryCode } = {}) {
  const pc = postalCode ? String(postalCode).trim() : '';
  const town = city ? String(city).trim() : '';
  if (writesUkForm(countryCode, issuerCountryCode)) return [town, pc.toUpperCase()].filter(Boolean).join(' ');
  if (isUnitedStates(countryCode)) {
    const stateZip = [state ? String(state).trim() : '', pc].filter(Boolean).join(' ');
    return state ? [town, stateZip].filter(Boolean).join(', ') : [town, stateZip].filter(Boolean).join(' ');
  }
  const cc = countryCode ? String(countryCode).trim().toUpperCase() : '';
  return [cc && pc ? `${cc}-${pc}` : (pc || cc), town].filter(Boolean).join(' ');
}

/**
 * The lines under the street, for an address set out line by line (a letter).
 * A UK address written by a UK business gets the post town and the postcode
 * on lines of their own; `postTownCaps` writes the town in capitals, as Royal
 * Mail asks for on the envelope. Everywhere else this is the one line of
 * cityLine. Pass `issuerCountryCode` for a customer's address.
 */
function cityLines(parts = {}, { postTownCaps = false, issuerCountryCode } = {}) {
  if (!writesUkForm(parts.countryCode, issuerCountryCode)) {
    const line = cityLine(parts, { issuerCountryCode });
    return line ? [line] : [];
  }
  const town = parts.city ? String(parts.city).trim() : '';
  const pc = parts.postalCode ? String(parts.postalCode).trim().toUpperCase() : '';
  return [postTownCaps ? town.toUpperCase() : town, pc].filter(Boolean);
}

/**
 * Does the address get a country line? A US business leaves it out for an
 * address in the US (or one with no country), the way US mail is written,
 * and a UK business does the same for an address in the UK. Everyone else
 * keeps printing it, as the documents always have.
 */
function printsCountryLine(addressCountryCode, issuerCountryCode) {
  const domestic = isUnitedStates(issuerCountryCode) ? isUnitedStates
    : isUnitedKingdom(issuerCountryCode) ? isUnitedKingdom : null;
  if (!domestic) return true;
  return !!String(addressCountryCode || '').trim() && !domestic(addressCountryCode);
}

/**
 * The country a customer address without one belongs to: a US or UK
 * business's customer with no country is a domestic address. Null
 * elsewhere, which keeps the country code off the city line.
 */
function domesticCountryFor(issuerCountryCode) {
  if (isUnitedStates(issuerCountryCode)) return 'US';
  if (isUnitedKingdom(issuerCountryCode)) return 'GB';
  return null;
}

module.exports = {
  cityLine, cityLines, printsCountryLine, domesticCountryFor, isUnitedStates, isUnitedKingdom,
};
