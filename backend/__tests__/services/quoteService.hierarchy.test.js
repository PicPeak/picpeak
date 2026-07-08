/**
 * Tests for the migration-119 hierarchy support in quoteService:
 * computeTotals, validateLineItemHierarchy, and the two-phase
 * insertLineItemsHierarchical helper. All pure / db-mocked so the
 * suite runs fast and is deterministic.
 */
const quoteService = require('../../src/services/quoteService');
const {
  computeTotals,
  validateLineItemHierarchy,
  insertLineItemsHierarchical,
} = quoteService._internal;

describe('computeTotals — hierarchy + parent auto-resolve rule', () => {
  it('parent total auto-resolves to sum of priced sub-items (parent unit_price ignored)', () => {
    const items = [
      // Parent with its own price €500 — should be IGNORED because
      // sub-items have prices. Parent's effective line_total becomes
      // sum of priced sub-items.
      { position: 1, quantity: 1, unit_price_minor: 50000, discount_percent: 0 },
      // Priced sub-items €150 + €200 = €350
      { position: 2, quantity: 1, unit_price_minor: 15000, discount_percent: 0, parent_position: 1 },
      { position: 3, quantity: 1, unit_price_minor: 20000, discount_percent: 0, parent_position: 1 },
      // Another top-level item: €100
      { position: 4, quantity: 2, unit_price_minor: 5000, discount_percent: 0 },
    ];
    const out = computeTotals(items, 0, 0);
    // Net = 35000 (parent 1, auto-resolved) + 10000 (row 4) = 45000.
    // Parent's own €500 is silently overridden.
    expect(out.netAmountMinor).toBe(45000);
    // Parent's stored line_total_minor reflects the resolved sum.
    expect(out.lineItems[0].line_total_minor).toBe(35000);
  });

  it('priceless sub-items leave the parent\'s own line_total intact', () => {
    const items = [
      // Parent €500 with three priceless transparency-bullets — the
      // €500 stands.
      { position: 1, quantity: 1, unit_price_minor: 50000, discount_percent: 0 },
      { position: 2, quantity: 1, unit_price_minor: 0, discount_percent: 0, parent_position: 1 },
      { position: 3, quantity: 1, unit_price_minor: 0, discount_percent: 0, parent_position: 1 },
    ];
    const out = computeTotals(items, 0, 0);
    expect(out.netAmountMinor).toBe(50000);
    expect(out.lineItems[0].line_total_minor).toBe(50000);
  });

  it('mixed priced + priceless sub-items: only priced contribute, parent\'s own price still overridden', () => {
    const items = [
      // Parent €500 → overridden because at least one sub-item is priced.
      { position: 1, quantity: 1, unit_price_minor: 50000, discount_percent: 0 },
      { position: 2, quantity: 1, unit_price_minor: 15000, discount_percent: 0, parent_position: 1 },
      // Priceless bullet — doesn't add anything
      { position: 3, quantity: 1, unit_price_minor: 0, discount_percent: 0, parent_position: 1 },
    ];
    const out = computeTotals(items, 0, 0);
    // Parent resolves to €150 (only priced sub-item).
    expect(out.netAmountMinor).toBe(15000);
    expect(out.lineItems[0].line_total_minor).toBe(15000);
  });

  it('still computes line_total_minor on sub-items so the renderer can show it', () => {
    const out = computeTotals([
      { position: 1, quantity: 1, unit_price_minor: 50000, discount_percent: 0 },
      { position: 2, quantity: 2, unit_price_minor: 15000, discount_percent: 10, parent_position: 1 },
    ], 0);
    expect(out.lineItems[1].line_total_minor).toBe(27000); // 2 × 150.00 × 0.9 = 270.00
  });

  it('applies VAT to the resolved parent total', () => {
    const out = computeTotals([
      // Parent €1000 overridden by priced €800 sub-item
      { position: 1, quantity: 1, unit_price_minor: 100000, discount_percent: 0 },
      { position: 2, quantity: 1, unit_price_minor: 80000, discount_percent: 0, parent_position: 1 },
    ], 7.7);
    // Resolved net = 80000, VAT 7.7% = 6160.
    expect(out.netAmountMinor).toBe(80000);
    expect(out.vatAmountMinor).toBe(6160);
    expect(out.totalAmountMinor).toBe(86160);
  });

  it('treats empty-string parent_position as top-level (frontend may send "")', () => {
    const out = computeTotals([
      { position: 1, quantity: 1, unit_price_minor: 50000, discount_percent: 0, parent_position: '' },
      { position: 2, quantity: 1, unit_price_minor: 50000, discount_percent: 0, parent_position: null },
    ], 0);
    expect(out.netAmountMinor).toBe(100000);
  });
});

describe('validateLineItemHierarchy', () => {
  it('accepts a flat list of top-level items', () => {
    expect(() => validateLineItemHierarchy([
      { position: 1 },
      { position: 2 },
      { position: 3 },
    ])).not.toThrow();
  });

  it('accepts one level of sub-items under valid parents', () => {
    expect(() => validateLineItemHierarchy([
      { position: 1 },
      { position: 2, parent_position: 1 },
      { position: 3, parent_position: 1 },
      { position: 4 },
      { position: 5, parent_position: 4 },
    ])).not.toThrow();
  });

  it('rejects duplicate positions', () => {
    expect(() => validateLineItemHierarchy([
      { position: 1 },
      { position: 1 },
    ])).toThrow(/Duplicate line item position/);
  });

  it('rejects a sub-item pointing at a missing parent', () => {
    expect(() => validateLineItemHierarchy([
      { position: 1, parent_position: 99 },
    ])).toThrow(/missing parent position/);
  });

  it('rejects a sub-item under another sub-item (max 1 level deep)', () => {
    expect(() => validateLineItemHierarchy([
      { position: 1 },
      { position: 2, parent_position: 1 },
      { position: 3, parent_position: 2 },
    ])).toThrow(/max one level deep/);
  });

  it('rejects an item whose parent is itself', () => {
    expect(() => validateLineItemHierarchy([
      { position: 5, parent_position: 5 },
    ])).toThrow(/cannot be its own parent/);
  });

  it('rejects an item without a positive position', () => {
    expect(() => validateLineItemHierarchy([
      { position: 0 },
    ])).toThrow(/positive position/);
  });

  it('is a no-op on empty / non-array input', () => {
    expect(() => validateLineItemHierarchy([])).not.toThrow();
    expect(() => validateLineItemHierarchy(null)).not.toThrow();
    expect(() => validateLineItemHierarchy(undefined)).not.toThrow();
  });
});

describe('insertLineItemsHierarchical', () => {
  // Tiny trx mock — captures insert calls so we can verify the
  // two-phase ordering and the parent-id remap. `.returning('id')`
  // returns a synthesised id matching the call order.
  function makeTrxMock() {
    let nextId = 100;
    const inserts = []; // [{ table, row }]
    const trx = (tableName) => ({
      insert(row) {
        const id = nextId++;
        inserts.push({ table: tableName, row: { ...row, id } });
        return {
          returning() { return Promise.resolve([{ id }]); },
          then(resolve) { return Promise.resolve(undefined).then(resolve); }, // bare await: no returning() call
        };
      },
    });
    return { trx, inserts };
  }

  it('inserts top-level items first, then sub-items with remapped parent_line_item_id', async () => {
    const { trx, inserts } = makeTrxMock();
    await insertLineItemsHierarchical(trx, 'quote_line_items', 'quote_id', 1, [
      { position: 1, description: 'Package', quantity: 1, unit_price_minor: 50000, discount_percent: 0, line_total_minor: 50000, parent_position: null },
      { position: 2, description: 'Camera',  quantity: 1, unit_price_minor: 15000, discount_percent: 0, line_total_minor: 15000, parent_position: 1 },
      { position: 3, description: 'Lens',    quantity: 1, unit_price_minor: 20000, discount_percent: 0, line_total_minor: 20000, parent_position: 1 },
      { position: 4, description: 'Travel',  quantity: 1, unit_price_minor: 10000, discount_percent: 0, line_total_minor: 10000, parent_position: null },
    ]);
    // 4 inserts, all into quote_line_items.
    expect(inserts).toHaveLength(4);
    expect(inserts.every((i) => i.table === 'quote_line_items')).toBe(true);
    // Order: top-level first (positions 1 and 4), then sub-items 2 and 3.
    expect(inserts.map((i) => i.row.position)).toEqual([1, 4, 2, 3]);
    // Top-level items have parent_line_item_id = null.
    expect(inserts[0].row.parent_line_item_id).toBeNull();
    expect(inserts[1].row.parent_line_item_id).toBeNull();
    // Sub-items reference the id returned for position-1 parent (100).
    expect(inserts[2].row.parent_line_item_id).toBe(100);
    expect(inserts[3].row.parent_line_item_id).toBe(100);
    // parent_position is stripped (wire-only field, not a DB column).
    expect(inserts[0].row).not.toHaveProperty('parent_position');
    expect(inserts[2].row).not.toHaveProperty('parent_position');
  });

  it('copies details_text through to the inserted row', async () => {
    const { trx, inserts } = makeTrxMock();
    await insertLineItemsHierarchical(trx, 'quote_line_items', 'quote_id', 1, [
      { position: 1, description: 'P', unit_price_minor: 0, details_text: 'Includes online gallery.', parent_position: null },
    ]);
    expect(inserts[0].row.details_text).toBe('Includes online gallery.');
  });

  it('is a no-op on empty items array', async () => {
    const { trx, inserts } = makeTrxMock();
    await insertLineItemsHierarchical(trx, 'quote_line_items', 'quote_id', 1, []);
    expect(inserts).toHaveLength(0);
  });

  it('uses the supplied ownerColumn so the same helper handles invoice_line_items', async () => {
    const { trx, inserts } = makeTrxMock();
    await insertLineItemsHierarchical(trx, 'invoice_line_items', 'invoice_id', 42, [
      { position: 1, description: 'X', unit_price_minor: 100, parent_position: null },
    ]);
    expect(inserts[0].table).toBe('invoice_line_items');
    expect(inserts[0].row.invoice_id).toBe(42);
    expect(inserts[0].row).not.toHaveProperty('quote_id');
  });
});
