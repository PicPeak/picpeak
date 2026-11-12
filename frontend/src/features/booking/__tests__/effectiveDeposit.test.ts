import { describe, expect, it } from 'vitest';
import { effectiveDeposit } from '../effectiveDeposit';

// Mirrors backend bookingDeposits.depositFor (bookingDeposits.test.js).
describe('effectiveDeposit', () => {
  const base = { percent: 10, fixedMinor: 20, minimumMinor: 50 };
  it('raises a deposit below the minimum, at most to the estimate', () => {
    expect(effectiveDeposit('percent', { ...base, estimateMinor: 300 })).toBe(50);
    expect(effectiveDeposit('percent', { ...base, estimateMinor: 40 })).toBe(0);
    expect(effectiveDeposit('percent', { ...base, estimateMinor: 100000 })).toBe(10000);
    expect(effectiveDeposit('fixed', { ...base, estimateMinor: 10000 })).toBe(50);
    expect(effectiveDeposit('fixed', { ...base, estimateMinor: 10000, minimumMinor: 0 })).toBe(20);
    expect(effectiveDeposit('none', { ...base, estimateMinor: 10000 })).toBe(0);
    expect(effectiveDeposit('percent', { percent: 25, fixedMinor: 0, estimateMinor: 1234567, minimumMinor: 5000, currency: 'JPY' })).toBe(308600);
  });
  it('rounds ISK and UGX to whole units, and never past the estimate', () => {
    expect(effectiveDeposit('percent', { percent: 10, fixedMinor: 0, estimateMinor: 123450, minimumMinor: 0, currency: 'ISK' })).toBe(12300);
    expect(effectiveDeposit('percent', { percent: 10, fixedMinor: 0, estimateMinor: 500000, minimumMinor: 0, currency: 'UGX' })).toBe(50000);
    expect(effectiveDeposit('fixed', { percent: 0, fixedMinor: 500000, estimateMinor: 12360, minimumMinor: 0, currency: 'JPY' })).toBe(12300);
  });
});
