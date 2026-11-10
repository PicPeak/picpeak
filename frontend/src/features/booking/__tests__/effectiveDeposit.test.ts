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
  });
});
