/**
 * The deposit a client is charged for an estimate, as the backend computes
 * it (bookingDeposits.depositFor): percent of the estimate or a fixed amount
 * capped at it; below Stripe's minimum charge it is raised to the minimum,
 * at most to the estimate, and an estimate below the minimum takes none.
 * Amounts in minor units. Shown on the service form, so the studio sees
 * what is actually charged.
 */
// Stripe charges these in whole units; the backend rounds their deposits.
const ZERO_DECIMAL = new Set(['BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA', 'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF']);

export function effectiveDeposit(
  type: 'none' | 'percent' | 'fixed',
  { percent, fixedMinor, estimateMinor, minimumMinor, currency = '' }: { percent: number; fixedMinor: number; estimateMinor: number; minimumMinor: number; currency?: string },
): number {
  const total = Math.max(0, Number.isFinite(estimateMinor) ? estimateMinor : 0);
  let deposit = 0;
  if (type === 'percent') {
    const pct = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
    deposit = Math.round((total * pct) / 100);
  } else if (type === 'fixed') {
    deposit = Math.min(total, Math.max(0, Math.round(Number.isFinite(fixedMinor) ? fixedMinor : 0)));
  }
  if (ZERO_DECIMAL.has(currency.toUpperCase())) deposit = Math.round(deposit / 100) * 100;
  if (deposit <= 0) return 0;
  if (deposit >= minimumMinor) return deposit;
  return total >= minimumMinor ? minimumMinor : 0;
}
