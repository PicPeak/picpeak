const { cleanNetMinor, exactLineMinor } = require('../../src/utils/invoiceRounding');

// Sum the per-line ROUNDED totals the way computeTotals / createInvoice do,
// so each test can compare "sum of rounded lines" against cleanNetMinor.
function roundedNet(items, parentKey = 'parent_position') {
  return items
    .filter((li) => li[parentKey] == null || li[parentKey] === '')
    .reduce((s, li) => s + Math.round(li.line_total_minor), 0);
}

function mkLine(position, quantity, unitPriceMinor, extra = {}) {
  const discount = extra.discount_percent || 0;
  return {
    position,
    quantity,
    unit_price_minor: unitPriceMinor,
    discount_percent: discount,
    line_total_minor: Math.round(Math.round(quantity * unitPriceMinor) * (1 - discount / 100)),
    parent_position: extra.parent_position ?? null,
  };
}

describe('cleanNetMinor — sub-cent reconciliation', () => {
  it('reconciles the real 68h × 32.25 invoice (sum-of-lines 2193.02 → clean 2193.00)', () => {
    const qtys = [5.25, 3.25, 5.25, 2.75, 2, 1, 1.75, 5, 5.25, 5.25, 2.75,
      4.5, 3.5, 2.5, 4.5, 2, 1.75, 3.25, 1.75, 3.5, 1.25];
    const items = qtys.map((q, i) => mkLine(i + 1, q, 3225));
    expect(roundedNet(items)).toBe(219302); // sum of the 21 rounded lines
    expect(cleanNetMinor(items)).toBe(219300); // full-precision, rounded once
    expect(cleanNetMinor(items) - roundedNet(items)).toBe(-2); // the -0.02 drift
  });

  it('is a no-op when every line is already cent-exact (adjustment 0)', () => {
    const items = [mkLine(1, 2, 5000), mkLine(2, 3, 4000)];
    expect(cleanNetMinor(items)).toBe(roundedNet(items));
  });

  it('is rate-agnostic: mixed hourly rates reconcile to one clean net', () => {
    const items = [mkLine(1, 2.5, 3225), mkLine(2, 1.25, 3225), mkLine(3, 3.5, 4850), mkLine(4, 1.75, 4850)];
    // sum-of-lines = 80.63 + 40.31 + 169.75 + 84.88 = 375.57; clean = 375.56
    expect(roundedNet(items)).toBe(37557);
    expect(cleanNetMinor(items)).toBe(37556);
  });

  it('honours per-line discounts at full precision', () => {
    const items = [mkLine(1, 3, 1000, { discount_percent: 33 })];
    // exact = 3 × 1000 × 0.67 = 2010 exactly → clean 2010
    expect(cleanNetMinor(items)).toBe(2010);
  });

  it('migration-119 hierarchy: a parent with priced sub-items derives from the children', () => {
    // Parent (pos 1) has two priced sub-items; parent own price ignored.
    const parent = mkLine(1, 1, 9999); // own price should NOT count
    const subA = mkLine(2, 2.5, 3225, { parent_position: 1 });
    const subB = mkLine(3, 1.75, 3225, { parent_position: 1 });
    const items = [parent, subA, subB];
    // exact children = (2.5 + 1.75) × 3225 = 4.25 × 3225 = 13706.25 → 13706
    expect(cleanNetMinor(items)).toBe(13706);
    // parent's own 9999 must not leak in
    expect(cleanNetMinor(items)).not.toBe(9999);
  });

  it('exactLineMinor returns the un-rounded product', () => {
    expect(exactLineMinor({ quantity: 2.5, unit_price_minor: 3225 })).toBeCloseTo(8062.5, 5);
  });
});
