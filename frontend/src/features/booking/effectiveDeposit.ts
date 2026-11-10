/**
 * The deposit a client is charged for an estimate, as the backend computes
 * it (bookingDeposits.depositFor): percent of the estimate or a fixed amount
 * capped at it; below Stripe's minimum charge it is raised to the minimum,
 * at most to the estimate, and an estimate below the minimum takes none.
 * Amounts in minor units. Shown on the service form, so the studio sees
 * what is actually charged.
 */
export function effectiveDeposit(
  type: 'none' | 'percent' | 'fixed',
  { percent, fixedMinor, estimateMinor, minimumMinor }: { percent: number; fixedMinor: number; estimateMinor: number; minimumMinor: number },
): number {
  const total = Math.max(0, Number.isFinite(estimateMinor) ? estimateMinor : 0);
  let deposit = 0;
  if (type === 'percent') {
    const pct = Math.min(100, Math.max(0, Number.isFinite(percent) ? percent : 0));
    deposit = Math.round((total * pct) / 100);
  } else if (type === 'fixed') {
    deposit = Math.min(total, Math.max(0, Math.round(Number.isFinite(fixedMinor) ? fixedMinor : 0)));
  }
  if (deposit <= 0) return 0;
  if (deposit >= minimumMinor) return deposit;
  return total >= minimumMinor ? minimumMinor : 0;
}
