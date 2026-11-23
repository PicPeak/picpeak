/**
 * The invoice helpers the clean-up shared between create, the PUT re-total
 * and the preview: computeInvoiceTotals, composePaymentTermSnapshot and
 * parseJsonObject. The integration suites cover each caller; these pin the
 * helpers on their own.
 *
 * Pure helpers, no DB.
 */
const {
  computeInvoiceTotals, composePaymentTermSnapshot, parseJsonObject,
} = require('../../src/services/invoice/helpers');

const opts = { vatRate: 0, shippingMinor: 0, roundTotal: false, roundVatDown: false };

describe('computeInvoiceTotals', () => {
  it('sums top-level lines only and adds VAT and shipping', () => {
    const items = [
      { position: 1, line_total_minor: 10000, parent_position: null },
      { position: 2, line_total_minor: 5050, parent_position: null },
    ];
    expect(computeInvoiceTotals(items, { ...opts, vatRate: 8.1, shippingMinor: 1500 }))
      .toMatchObject({ netMinor: 15050, vatMinor: 1219, totalMinor: 15050 + 1219 + 1500 });
  });

  it('resolves a parent from its priced sub-items and does not count them twice', () => {
    const items = [
      { position: 1, unit_price_minor: 0, quantity: 1, line_total_minor: 0, parent_position: null },
      { position: 2, unit_price_minor: 3000, quantity: 1, line_total_minor: 3000, parent_position: 1 },
      { position: 3, unit_price_minor: 2000, quantity: 1, line_total_minor: 2000, parent_position: 1 },
    ];
    const out = computeInvoiceTotals(items, opts);
    expect(out.netMinor).toBe(5000);
    expect(items[0].line_total_minor).toBe(5000);
  });

  it('treats an empty parent_position from an unsaved preview as top level', () => {
    const items = [{ position: 1, line_total_minor: 4200, parent_position: '' }];
    expect(computeInvoiceTotals(items, opts).netMinor).toBe(4200);
  });

  it('rounds VAT down for a UK issuer', () => {
    const items = [{ position: 1, line_total_minor: 999, parent_position: null }];
    expect(computeInvoiceTotals(items, { ...opts, vatRate: 20 }).vatMinor).toBe(200);
    expect(computeInvoiceTotals(items, { ...opts, vatRate: 20, roundVatDown: true }).vatMinor).toBe(199);
  });
});

describe('composePaymentTermSnapshot', () => {
  const netDays = { description: 'Net 30', net_days: 30, skonto_percent: 2, skonto_within_days: 10 };

  it('takes net days and Skonto from one template and the plan from the other', () => {
    const timing = { description: 'Half now', installments: '[{"percent":50},{"percent":50}]' };
    expect(JSON.parse(composePaymentTermSnapshot(netDays, timing))).toEqual({
      description: 'Half now', net_days: 30, skonto_percent: 2, skonto_within_days: 10,
      installments: [{ percent: 50 }, { percent: 50 }],
    });
  });

  it('falls back to the net-days description and keeps a parsed plan as it is', () => {
    const plan = [{ percent: 100 }];
    expect(JSON.parse(composePaymentTermSnapshot(netDays, { description: null, installments: plan })))
      .toMatchObject({ description: 'Net 30', installments: plan });
  });
});

describe('parseJsonObject', () => {
  it.each([
    ['{"a":1}', { a: 1 }],
    ['[1,2]', [1, 2]],
    ['not json', null],
    ['', null],
    [null, null],
    [undefined, null],
  ])('%p', (input, expected) => {
    expect(parseJsonObject(input)).toEqual(expected);
  });

  it('returns a parsed value as it is', () => {
    const value = { b: 2 };
    expect(parseJsonObject(value)).toBe(value);
  });
});
