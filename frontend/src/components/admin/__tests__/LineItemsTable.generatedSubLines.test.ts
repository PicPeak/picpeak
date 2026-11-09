import { describe, expect, it } from 'vitest';
import { generatedSubLines, type EditableLineItem } from '../LineItemsTable';

// Which sub-lines under a factor-priced service the last pricing made (and
// re-pricing may replace) versus lines the admin added or changed (#2440).
const line = (position: number, over: Partial<EditableLineItem> = {}): EditableLineItem => ({
  position, quantity: 1, description: '', unitPrice: 0, discountPercent: 0, parentPosition: 1, ...over,
});

const parent = (lines: Array<{ description: string; quantity: number; unitPriceMinor: number }>): EditableLineItem =>
  line(1, { parentPosition: null, description: 'Wedding', pricingFactors: { lines } as any });

describe('generatedSubLines', () => {
  it('keeps a sub-line whose typed price was changed by hand', () => {
    const items = [
      parent([{ description: 'Base', quantity: 1, unitPriceMinor: 100000 }, { description: 'Travel', quantity: 1, unitPriceMinor: 5000 }]),
      line(2, { description: 'Base', unitPrice: 1000 }),
      line(3, { description: 'Travel', unitPrice: 75 }),
    ];
    expect([...generatedSubLines(items, 1)]).toEqual([2]);
  });

  it('still replaces a rate-priced line whose price moved with "Apply current rates"', () => {
    const items = [
      parent([{ description: 'Base', quantity: 4, unitPriceMinor: 20000 }]),
      line(2, { description: 'Base', quantity: 4, unitPrice: 220, priceMode: 'hour', rateSource: 'auto' }),
    ];
    expect([...generatedSubLines(items, 1)]).toEqual([2]);
  });

  it('keeps a rate-priced line whose hours were changed by hand', () => {
    const items = [
      parent([{ description: 'Base', quantity: 4, unitPriceMinor: 20000 }]),
      line(2, { description: 'Base', quantity: 6, unitPrice: 200, priceMode: 'hour', rateSource: 'auto' }),
    ];
    expect([...generatedSubLines(items, 1)]).toEqual([]);
  });
});
