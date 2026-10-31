/**
 * Postal addresses in the convention of their country. A US address reads
 * "Denver, CO 80202" and a letter that stays inside the US carries no country
 * line; everywhere else keeps the "<CC>-<postal> <city>" form the documents
 * have always printed.
 */

const { cityLine, printsCountryLine, isUnitedStates } = require('../../src/utils/postalAddress');

describe('cityLine', () => {
  test('a US address reads city, state and ZIP', () => {
    expect(cityLine({ city: 'Denver', state: 'CO', postalCode: '80202', countryCode: 'US' })).toBe('Denver, CO 80202');
  });

  test('a US address without a state still reads cleanly', () => {
    expect(cityLine({ city: 'Denver', postalCode: '80202', countryCode: 'us' })).toBe('Denver 80202');
  });

  test('a US address never gets the country-code prefix', () => {
    expect(cityLine({ city: 'Denver', state: 'CO', postalCode: '80202', countryCode: 'US' })).not.toMatch(/US-/);
  });

  test('a European address keeps its country-code prefix and postal-code-first order', () => {
    expect(cityLine({ city: 'Schaan', postalCode: '9494', countryCode: 'LI' })).toBe('LI-9494 Schaan');
    expect(cityLine({ city: 'Berlin', postalCode: '10115', countryCode: 'de', state: 'Berlin' })).toBe('DE-10115 Berlin');
  });

  test('missing pieces drop out instead of leaving separators behind', () => {
    expect(cityLine({ city: 'Vaduz', countryCode: 'LI' })).toBe('LI Vaduz');
    expect(cityLine({ postalCode: '9490' })).toBe('9490');
    expect(cityLine({ city: 'Denver', state: 'CO', countryCode: 'US' })).toBe('Denver, CO');
    expect(cityLine({})).toBe('');
  });
});

describe('printsCountryLine', () => {
  test('a US business writing to a US address leaves the country out', () => {
    expect(printsCountryLine('US', 'US')).toBe(false);
  });

  test('a US business leaves it out when the address has no country either', () => {
    expect(printsCountryLine(null, 'US')).toBe(false);
    expect(printsCountryLine('', 'us')).toBe(false);
  });

  test('a US business writing abroad names the country', () => {
    expect(printsCountryLine('CA', 'US')).toBe(true);
  });

  test('a business outside the US always names the country, as before', () => {
    expect(printsCountryLine('LI', 'LI')).toBe(true);
    expect(printsCountryLine('US', 'CH')).toBe(true);
    expect(printsCountryLine(null, null)).toBe(true);
  });
});

describe('isUnitedStates', () => {
  test('matches the US country code however it was typed', () => {
    expect(isUnitedStates('US')).toBe(true);
    expect(isUnitedStates(' us ')).toBe(true);
    expect(isUnitedStates('USA')).toBe(false);
    expect(isUnitedStates('CH')).toBe(false);
    expect(isUnitedStates(null)).toBe(false);
  });
});
