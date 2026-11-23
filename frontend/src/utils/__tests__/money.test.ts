import { describe, expect, it } from 'vitest';
import { formatMoney, formatMoneyMinor } from '../money';

// PostgreSQL returns bigint columns as strings, so `*_amount_minor` values
// can reach the UI as '12345' rather than 12345.
const opts = { locale: 'en-US' };

describe('formatMoneyMinor', () => {
  it('formats a numeric string like the same number', () => {
    expect(formatMoneyMinor('12345', 'CHF', opts)).toBe(formatMoneyMinor(12345, 'CHF', opts));
    expect(formatMoneyMinor('12345', 'CHF', opts)).toMatch(/^CHF\s123\.45$/);
    expect(formatMoneyMinor('-500', 'EUR', opts)).toBe(formatMoneyMinor(-500, 'EUR', opts));
  });

  it('keeps the 0 fallback for missing or non-numeric values', () => {
    const zero = formatMoneyMinor(0, 'CHF', opts);
    for (const v of [null, undefined, 'abc', '', '  ', NaN, Infinity]) {
      expect(formatMoneyMinor(v, 'CHF', opts)).toBe(zero);
    }
  });

  it('formats finite numbers as before', () => {
    expect(formatMoneyMinor(12345, 'CHF', opts)).toMatch(/^CHF\s123\.45$/);
    expect(formatMoneyMinor(0, 'CHF', opts)).toMatch(/^CHF\s0\.00$/);
  });
});

describe('formatMoney', () => {
  it('formats a numeric string like the same number', () => {
    expect(formatMoney('123.45', 'CHF', opts)).toBe(formatMoney(123.45, 'CHF', opts));
  });

  it('keeps the 0 fallback for missing or non-numeric values', () => {
    const zero = formatMoney(0, 'CHF', opts);
    for (const v of [null, undefined, 'abc', '', NaN]) {
      expect(formatMoney(v, 'CHF', opts)).toBe(zero);
    }
  });
});
