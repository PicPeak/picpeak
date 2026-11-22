/**
 * Option sub-lines (migration 371): a sub-line flagged `adds_to_parent` adds
 * its amount to the parent's own price, where a regular priced sub-line
 * replaces it. Every totals path agrees: computeTotals (quotes),
 * resolveParentTotalsFromSubItems (invoice save + preview), cleanNetMinor
 * (sub-cent reconciliation) and the column helpers that copy lines between
 * documents.
 */
jest.mock('../../src/services/accountingHistory', () => ({
  auditedInsert: jest.fn(),
}));
const { computeTotals, resolveParentTotalsFromSubItems } = require('../../src/services/quoteService')._internal;
const { cleanNetMinor } = require('../../src/utils/invoiceRounding');
const {
  resolvedParentTotal, normalizeLineItems, extendedLineColumns, lineItemFieldsFromApi, lineItemFieldsToApi,
} = require('../../src/utils/lineItemTotals');

// "28.09.2024: Next-Step B" at 180.00 with the online gallery option at 30.00.
const shootWithGallery = () => [
  { position: 1, quantity: 1, unit_price_minor: 18000, discount_percent: 0, description: '28.09.2024: Next-Step B' },
  { position: 2, quantity: 1, unit_price_minor: 3000, discount_percent: 0, parent_position: 1, adds_to_parent: true, description: 'Online Galerie' },
];

describe('option sub-lines add to the parent', () => {
  it('computeTotals: parent keeps its own price and the option adds to it', () => {
    const out = computeTotals(shootWithGallery(), 0, 0);
    expect(out.lineItems[0].line_total_minor).toBe(21000);
    expect(out.lineItems[1].line_total_minor).toBe(3000);
    expect(out.netAmountMinor).toBe(21000);
  });

  it('a regular priced sub-line still replaces the parent, and an option adds to that sum', () => {
    const items = [
      { position: 1, quantity: 1, unit_price_minor: 50000, discount_percent: 0 },
      { position: 2, quantity: 1, unit_price_minor: 15000, discount_percent: 0, parent_position: 1 },
      { position: 3, quantity: 1, unit_price_minor: 3000, discount_percent: 0, parent_position: 1, adds_to_parent: 1 },
    ];
    expect(computeTotals(items, 0, 0).netAmountMinor).toBe(18000);
  });

  it('an unflagged priced sub-line keeps the old replace rule', () => {
    const items = shootWithGallery().map((li) => ({ ...li, adds_to_parent: false }));
    expect(computeTotals(items, 0, 0).netAmountMinor).toBe(3000);
  });

  it('a top-level line cannot be an option', () => {
    const [line] = normalizeLineItems([{ position: 1, quantity: 1, unit_price_minor: 100, adds_to_parent: true }]);
    expect(line.adds_to_parent).toBe(false);
  });

  it('honours the parent discount on its own amount, not on the option', () => {
    const items = shootWithGallery();
    items[0].discount_percent = 50;
    expect(computeTotals(items, 0, 0).netAmountMinor).toBe(9000 + 3000);
  });

  it('resolveParentTotalsFromSubItems matches, and resolving twice never adds the option twice', () => {
    const items = shootWithGallery().map((li) => ({ ...li, line_total_minor: li.unit_price_minor }));
    resolveParentTotalsFromSubItems(items);
    expect(items[0].line_total_minor).toBe(21000);
    // A stored invoice re-rendered: the parent's total is already resolved.
    resolveParentTotalsFromSubItems(items);
    expect(items[0].line_total_minor).toBe(21000);
  });

  it('resolvedParentTotal leaves a parent without priced sub-lines alone', () => {
    expect(resolvedParentTotal({ quantity: 1, unit_price_minor: 100 }, [
      { unit_price_minor: 0, line_total_minor: 0, adds_to_parent: true },
    ])).toBeNull();
  });

  it('cleanNetMinor counts the parent and its option at full precision', () => {
    // 1.5 × 33.33 twice: each line rounds 49.995 up to 50.00, together 99.99.
    const items = [
      { position: 1, quantity: 1.5, unit_price_minor: 3333, discount_percent: 0, line_total_minor: 5000 },
      { position: 2, quantity: 1.5, unit_price_minor: 3333, discount_percent: 0, parent_position: 1, adds_to_parent: true, line_total_minor: 5000 },
    ];
    expect(cleanNetMinor(items)).toBe(9999);
  });

  it('the flag survives the API mapping and copies between documents', () => {
    expect(lineItemFieldsFromApi({ addsToParent: true }).adds_to_parent).toBe(true);
    // A form-encoded "false" is not true.
    expect(lineItemFieldsFromApi({ addsToParent: 'false' }).adds_to_parent).toBe(false);
    expect(lineItemFieldsToApi({ adds_to_parent: 1 }).addsToParent).toBe(true);
    expect(lineItemFieldsToApi({}).addsToParent).toBe(false);
    expect([true, 1]).toContain(extendedLineColumns({ adds_to_parent: 1, parent_position: 1 }, { invoice: true }).adds_to_parent);
    expect([false, 0]).toContain(extendedLineColumns({}, { invoice: true }).adds_to_parent);
    // The invoice paths skip normalizeLineItems: a top-level line is never an option.
    expect([false, 0]).toContain(extendedLineColumns({ adds_to_parent: true, parent_position: null }, { invoice: true }).adds_to_parent);
    // A copied stored row names its parent by id, not by position.
    expect([true, 1]).toContain(extendedLineColumns({ adds_to_parent: 1, parent_line_item_id: 7 }, { invoice: true }).adds_to_parent);
  });
});
