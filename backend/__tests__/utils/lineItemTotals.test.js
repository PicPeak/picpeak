/**
 * Unit tests for utils/lineItemTotals (#1451, migration 215): line kinds,
 * optional add-ons and discount promotions. Pure helpers, no database.
 */
const {
  normalizeLineItems,
  countedLineItems,
  resolveDiscountLines,
  extendedLineColumns,
  lineItemFieldsFromApi,
  lineItemFieldsToApi,
  parsePromotionSnapshot,
} = require('../../src/utils/lineItemTotals');

const line = (position, total, extra = {}) => ({
  position, quantity: 1, unit_price_minor: total, discount_percent: 0, line_total_minor: total, ...extra,
});

describe('normalizeLineItems', () => {
  it('defaults the line kind and the add-on flags', () => {
    const [li] = normalizeLineItems([{ position: 1, description: 'Coverage' }]);
    expect(li.line_kind).toBe('item');
    expect(li.is_optional).toBe(false);
    expect(li.selected).toBe(true);
  });

  it('rejects an unknown line kind', () => {
    expect(() => normalizeLineItems([{ position: 1, line_kind: 'bonus' }]))
      .toThrow(expect.objectContaining({ code: 'LINE_ITEM_KIND_INVALID' }));
  });

  it('makes sub-items follow their parent\'s optional/selected state', () => {
    const out = normalizeLineItems([
      { position: 1, is_optional: true, selected: false },
      { position: 2, parent_position: 1, is_optional: false, selected: true },
    ]);
    expect(out[1].is_optional).toBe(true);
    expect(out[1].selected).toBe(false);
  });

  it('refuses a discount line as a sub-item', () => {
    expect(() => normalizeLineItems([
      { position: 1 },
      { position: 2, parent_position: 1, line_kind: 'discount', promotion_snapshot: { type: 'fixed', valueMinor: 100 } },
    ])).toThrow(expect.objectContaining({ code: 'LINE_ITEM_DISCOUNT_NESTED' }));
  });

  it('refuses nesting anything under a discount line', () => {
    expect(() => normalizeLineItems([
      { position: 1, line_kind: 'discount', promotion_snapshot: { type: 'fixed', valueMinor: 100 } },
      { position: 2, parent_position: 1 },
    ])).toThrow(expect.objectContaining({ code: 'LINE_ITEM_DISCOUNT_NESTED' }));
  });

  it('rejects an out-of-range percentage promotion', () => {
    expect(() => normalizeLineItems([
      { position: 1, line_kind: 'discount', promotion_snapshot: { type: 'percent', percent: 150 } },
    ])).toThrow(expect.objectContaining({ code: 'LINE_ITEM_PROMOTION_INVALID' }));
  });

  it('forces a discount line to quantity 1, not optional', () => {
    const [li] = normalizeLineItems([
      { position: 1, line_kind: 'discount', quantity: 3, is_optional: true, promotion_snapshot: '{"type":"fixed","valueMinor":500}' },
    ]);
    expect(li.quantity).toBe(1);
    expect(li.is_optional).toBe(false);
    expect(li.promotion_snapshot).toEqual(expect.objectContaining({ type: 'fixed', valueMinor: 500 }));
  });
});

describe('countedLineItems', () => {
  it('drops an unselected add-on and its sub-items, keeps a selected one', () => {
    const items = [
      line(1, 1000),
      line(2, 500, { is_optional: true, selected: false }),
      line(3, 200, { parent_position: 2, is_optional: true, selected: false }),
      line(4, 300, { is_optional: true, selected: true }),
    ];
    expect(countedLineItems(items).map((li) => li.position)).toEqual([1, 4]);
  });

  it('treats a missing `selected` as selected', () => {
    expect(countedLineItems([line(1, 100, { is_optional: true })])).toHaveLength(1);
  });

  it('understands SQLite 0/1 booleans', () => {
    expect(countedLineItems([line(1, 100, { is_optional: 1, selected: 0 })])).toHaveLength(0);
  });
});

describe('resolveDiscountLines', () => {
  it('applies percentage promotions first, then fixed, from the regular subtotal', () => {
    const items = [
      line(1, 100000),
      line(2, 0, { line_kind: 'discount', promotion_snapshot: { type: 'fixed', valueMinor: 30000 } }),
      line(3, 0, { line_kind: 'discount', promotion_snapshot: { type: 'percent', percent: 10 } }),
    ];
    resolveDiscountLines(items);
    expect(items[2].line_total_minor).toBe(-10000); // 10 % of 1000.00
    expect(items[1].line_total_minor).toBe(-30000);
    expect(items[1].unit_price_minor).toBe(-30000);
    expect(items[1].quantity).toBe(1);
  });

  it('caps the combined discount at the subtotal', () => {
    const items = [
      line(1, 20000),
      line(2, 0, { line_kind: 'discount', promotion_snapshot: { type: 'fixed', valueMinor: 30000 } }),
    ];
    resolveDiscountLines(items);
    expect(items[1].line_total_minor).toBe(-20000);
  });

  it('ignores unselected add-ons when computing the subtotal', () => {
    const items = [
      line(1, 100000),
      line(2, 50000, { is_optional: true, selected: false }),
      line(3, 0, { line_kind: 'discount', promotion_snapshot: { type: 'percent', percent: 10 } }),
    ];
    resolveDiscountLines(items);
    expect(items[2].line_total_minor).toBe(-10000);
  });

  it('keeps the stored amount of a discount line without a snapshot', () => {
    const items = [line(1, 100000), line(2, -5000, { line_kind: 'discount' })];
    resolveDiscountLines(items);
    expect(items[1].line_total_minor).toBe(-5000);
  });

  it('uses the resolved parent total of priced sub-items as the subtotal', () => {
    const items = [
      line(1, 150000), // parent already resolved to the sum of its sub-items
      line(2, 100000, { parent_position: 1 }),
      line(3, 50000, { parent_position: 1 }),
      line(4, 0, { line_kind: 'discount', promotion_snapshot: { type: 'percent', percent: 10 } }),
    ];
    resolveDiscountLines(items);
    expect(items[3].line_total_minor).toBe(-15000);
  });
});

describe('column + API mapping', () => {
  it('stores the snapshot as JSON and invoice lines as plain selected lines', () => {
    const cols = extendedLineColumns({
      line_kind: 'discount', is_optional: true, selected: false,
      promotion_snapshot: { type: 'fixed', valueMinor: 100 },
    }, { invoice: true });
    expect(cols.line_kind).toBe('discount');
    expect(parsePromotionSnapshot(cols.promotion_snapshot)).toEqual({ type: 'fixed', valueMinor: 100 });
    expect([false, 0]).toContain(cols.is_optional);
    expect([true, 1]).toContain(cols.selected);
  });

  it('maps editor fields to service fields and back', () => {
    const svc = lineItemFieldsFromApi({
      lineKind: 'discount', unit: 'hour', isOptional: false, selected: true,
      priceMode: 'hour', rateSource: 'auto', boundTo: 'hours', promotionId: '7',
    });
    expect(svc).toEqual({
      line_kind: 'discount', unit: 'hour', is_optional: false, selected: true,
      price_mode: 'hour', rate_source: 'auto', bound_to: 'hours', promotion_id: 7,
    });
    const api = lineItemFieldsToApi({ line_kind: 'item', unit: 'day', is_optional: 1, selected: 0, promotion_snapshot: null });
    expect(api).toEqual(expect.objectContaining({ lineKind: 'item', unit: 'day', isOptional: true, selected: false }));
  });

  it('leaves fields the editor did not send untouched', () => {
    expect(lineItemFieldsFromApi({})).toEqual({});
  });
});
