'use strict';

/**
 * Postal addresses in the convention of the country they belong to.
 *
 * The documents were written for Liechtenstein, Switzerland and Germany, where
 * the city line is "<CC>-<postal> <city>" ("FL-9494 Schaan") and the country
 * follows on its own. In the United States the city line is
 * "City, ST 12345", and a letter that stays inside the country carries no
 * country line. Every address on a PDF, in the email signature and in the
 * contract placeholders goes through here, so they agree with each other.
 */

function isUnitedStates(countryCode) {
  return String(countryCode || '').trim().toUpperCase() === 'US';
}

/**
 * The line under the street: "Denver, CO 80202" for a US address,
 * "LI-9494 Schaan" elsewhere ("9494 Schaan" with `prefixCountry: false`, the
 * form the window envelope's return-address line uses).
 */
function cityLine({ postalCode, city, state, countryCode } = {}, { prefixCountry = true } = {}) {
  const pc = postalCode ? String(postalCode).trim() : '';
  const town = city ? String(city).trim() : '';
  if (isUnitedStates(countryCode)) {
    const stateZip = [state ? String(state).trim() : '', pc].filter(Boolean).join(' ');
    return state ? [town, stateZip].filter(Boolean).join(', ') : [town, stateZip].filter(Boolean).join(' ');
  }
  const cc = prefixCountry && countryCode ? String(countryCode).trim().toUpperCase() : '';
  return [cc && pc ? `${cc}-${pc}` : (pc || cc), town].filter(Boolean).join(' ');
}

/**
 * Does the address get a country line? A US business leaves it out for an
 * address in the US (or one with no country), the way US mail is written.
 * Everyone else keeps printing it, as the documents always have.
 */
function printsCountryLine(addressCountryCode, issuerCountryCode) {
  if (!isUnitedStates(issuerCountryCode)) return true;
  return !!String(addressCountryCode || '').trim() && !isUnitedStates(addressCountryCode);
}

module.exports = { cityLine, printsCountryLine, isUnitedStates };
