/**
 * Does this unissued invoice still need its GBP rate? A UK business's invoice
 * in another currency that carries VAT also states the VAT in GBP (issue
 * 2439); until the rate is entered it can't be sent, and the scheduler leaves
 * it waiting. The row's half of backend/src/utils/vatAmount.js lacksGbpRate;
 * the caller knows whether the business is in the UK.
 */
interface RateFields {
  status?: string;
  vatAmountMinor?: number | string | null;
  currency?: string | null;
  vatGbpRate?: number | null;
}

export function lacksGbpRate(inv: RateFields): boolean {
  return (inv.status === 'scheduled' || inv.status === 'pending_delivery')
    && Number(inv.vatAmountMinor) !== 0
    && String(inv.currency || '').toUpperCase() !== 'GBP'
    && !(Number(inv.vatGbpRate) > 0);
}
