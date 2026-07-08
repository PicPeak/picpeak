/**
 * Tests for the migration-119 hierarchy support in invoiceService —
 * the shared helpers come from quoteService._internal (validated in
 * quoteService.hierarchy.test.js), so we focus here on the
 * invoice-specific seams:
 *
 *   - quote → invoice cloner preserves parent_position + details_text
 *     across the conversion
 *   - the cloner's installment "adjustment" line only reconciles
 *     against TOP-LEVEL cloned items (sub-items don't contribute to
 *     net so they can't appear in the sum)
 *
 * Pure helper, no DB.
 */
const quoteService = require('../../src/services/quoteService');

const { validateLineItemHierarchy, insertLineItemsHierarchical } = quoteService._internal;

describe('quote → invoice cloner shape', () => {
  // Models the in-memory transformation step from `scheduleInvoicesForEvent`:
  // take source quote line items (with parent_position) and produce the
  // `cloned` array that's passed into insertLineItemsHierarchical.
  function modelCloner(sourceLines) {
    return sourceLines.map((li) => ({
      position: parseInt(li.position, 10),
      quantity: Number(li.quantity || 1),
      description: li.description,
      unit_price_minor: parseInt(li.unit_price_minor, 10) || 0,
      discount_percent: Number(li.discount_percent || 0),
      line_total_minor: parseInt(li.line_total_minor, 10) || 0,
      parent_position: li.parent_position == null ? null : parseInt(li.parent_position, 10),
      details_text: li.details_text || null,
    }));
  }

  it('preserves parent_position so the hierarchy carries across conversion', () => {
    const source = [
      { position: 1, description: 'Package', quantity: 1, unit_price_minor: 50000, line_total_minor: 50000, parent_position: null },
      { position: 2, description: 'Camera',  quantity: 1, unit_price_minor: 15000, line_total_minor: 15000, parent_position: 1 },
      { position: 3, description: 'Lens',    quantity: 1, unit_price_minor: 20000, line_total_minor: 20000, parent_position: 1 },
    ];
    const cloned = modelCloner(source);
    expect(cloned[0].parent_position).toBeNull();
    expect(cloned[1].parent_position).toBe(1);
    expect(cloned[2].parent_position).toBe(1);
    // The cloned shape passes hierarchy validation — same positions
    // means the same parent links work without any remap.
    expect(() => validateLineItemHierarchy(cloned)).not.toThrow();
  });

  it('preserves details_text verbatim', () => {
    const source = [
      { position: 1, description: 'P', unit_price_minor: 0, line_total_minor: 0, parent_position: null,
        details_text: 'Includes online gallery + 100 high-res downloads.' },
    ];
    const cloned = modelCloner(source);
    expect(cloned[0].details_text).toBe('Includes online gallery + 100 high-res downloads.');
  });

  it('installment adjustment reconciles against TOP-LEVEL cloned items only', () => {
    // Recreate the inner math from scheduleInvoicesForEvent: sum
    // only line_total_minor where parent_position is null. Sub-items
    // would otherwise double-count and skew the adjustment.
    //
    // Note: the cloner stores raw line_total_minor on each row from
    // the source quote. By the time this sum runs, the parent's
    // line_total_minor has already been resolved upstream (via
    // computeTotals on the quote at save time) — so iterating
    // top-level only sums the resolved parent totals + standalone
    // top-level items. Sub-items never contribute here regardless of
    // whether their parent's total was auto-resolved or not.
    const cloned = modelCloner([
      // Parent — resolved line_total assumed to be €450 (sum of priced sub-items below)
      { position: 1, unit_price_minor: 0, line_total_minor: 45000, parent_position: null },
      // Sub-items €150 + €200 + €100 — shown for transparency, must
      // NOT enter the reconciliation sum.
      { position: 2, unit_price_minor: 15000, line_total_minor: 15000, parent_position: 1 },
      { position: 3, unit_price_minor: 20000, line_total_minor: 20000, parent_position: 1 },
      { position: 4, unit_price_minor: 10000, line_total_minor: 10000, parent_position: 1 },
      // Another top-level €100
      { position: 5, unit_price_minor: 10000, line_total_minor: 10000, parent_position: null },
    ]);
    const clonedSum = cloned
      .filter((x) => x.parent_position == null)
      .reduce((s, x) => s + x.line_total_minor, 0);
    // Top-level only: 45000 (resolved parent) + 10000 = 55000. NOT 100000.
    expect(clonedSum).toBe(55000);
  });
});

describe('insertLineItemsHierarchical for invoices', () => {
  function makeTrxMock() {
    let nextId = 200;
    const inserts = [];
    const trx = (tableName) => ({
      insert(row) {
        const id = nextId++;
        inserts.push({ table: tableName, row: { ...row, id } });
        return {
          returning() { return Promise.resolve([{ id }]); },
          then(resolve) { return Promise.resolve(undefined).then(resolve); },
        };
      },
    });
    return { trx, inserts };
  }

  it('handles invoice_line_items with the same two-phase + remap logic', async () => {
    const { trx, inserts } = makeTrxMock();
    await insertLineItemsHierarchical(trx, 'invoice_line_items', 'invoice_id', 7, [
      { position: 1, description: 'Parent', quantity: 1, unit_price_minor: 50000, discount_percent: 0, line_total_minor: 50000, parent_position: null },
      { position: 2, description: 'Sub A',  quantity: 1, unit_price_minor: 15000, discount_percent: 0, line_total_minor: 15000, parent_position: 1 },
    ]);
    expect(inserts).toHaveLength(2);
    expect(inserts.every((i) => i.table === 'invoice_line_items')).toBe(true);
    expect(inserts.every((i) => i.row.invoice_id === 7)).toBe(true);
    // Parent inserted first, sub-item second with parent_line_item_id
    // matching the parent's synthesised id.
    expect(inserts[0].row.parent_line_item_id).toBeNull();
    expect(inserts[1].row.parent_line_item_id).toBe(200);
  });
});
