import { describe, expect, it } from 'vitest';
import { countedLines, isUnselectedOptional, resolveDiscountAmounts } from '../lineItemTotals';

const line = (position: number, extra: Record<string, unknown> = {}) => ({ position, parentPosition: null, ...extra });

describe('countedLines', () => {
  it('drops an unselected add-on and its sub-items', () => {
    const items = [
      line(1),
      line(2, { isOptional: true, selected: false }),
      line(3, { parentPosition: 2 }),
      line(4, { isOptional: true, selected: true }),
    ];
    expect(countedLines(items).map((li) => li.position)).toEqual([1, 4]);
  });

  it('treats a missing `selected` as selected', () => {
    expect(isUnselectedOptional(line(1, { isOptional: true }))).toBe(false);
  });
});

describe('resolveDiscountAmounts', () => {
  it('applies percentages first, then fixed amounts, from the regular subtotal', () => {
    const items = [
      line(1),
      line(2, { lineKind: 'discount', promotionSnapshot: { type: 'fixed', valueMinor: 30000 } }),
      line(3, { lineKind: 'discount', promotionSnapshot: { type: 'percent', percent: 10 } }),
    ];
    const amounts = resolveDiscountAmounts(items, 1000);
    expect(amounts.get(3)).toBe(100);
    expect(amounts.get(2)).toBe(300);
  });

  it('caps the combined discount at the subtotal', () => {
    const items = [line(1), line(2, { lineKind: 'discount', promotionSnapshot: { type: 'fixed', valueMinor: 90000 } })];
    expect(resolveDiscountAmounts(items, 200).get(2)).toBe(200);
  });

  it('keeps the typed amount of a discount line without a snapshot', () => {
    const items = [line(1), line(2, { lineKind: 'discount', unitPrice: -50 })];
    expect(resolveDiscountAmounts(items, 1000).get(2)).toBe(50);
  });
});
