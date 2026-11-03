/**
 * Amounts in the quote and invoice emails ({{total_amount}} and friends). A US
 * business's customers read "$175.00"; before, every English mail used en-GB,
 * which writes US dollars as "US$175.00". Other businesses are unchanged.
 */

describe('quote emails', () => {
  const { formatMajor } = require('../../src/services/quoteService')._internal;

  test('a US business writes dollars the US way', () => {
    expect(formatMajor(17500, 'USD', 'en', 'US')).toBe('$175.00');
  });

  test('a business elsewhere keeps its format', () => {
    expect(formatMajor(17500, 'USD', 'en', 'GB')).toBe('US$175.00');
  });
});

describe('invoice emails', () => {
  test('a US business writes dollars the US way', async () => {
    let helpers;
    jest.isolateModules(() => {
      jest.doMock('../../src/services/businessProfileService', () => ({
        getProfile: async () => ({ profile: { id: 1, country_code: 'US', default_currency: 'USD' }, bankAccounts: [] }),
      }));
      helpers = require('../../src/services/invoice/helpers');
    });
    // The first send warms the per-process cache with the business's country.
    helpers.formatMajor(0, 'USD', 'en');
    await new Promise((resolve) => setImmediate(resolve));

    expect(helpers.formatMajor(17500, 'USD', 'en')).toBe('$175.00');
  });
});
