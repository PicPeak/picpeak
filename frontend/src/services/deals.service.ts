/**
 * dealsService — typed wrappers for the `/api/admin/deals/:uuid/...`
 * routes (migration 140's deal_uuid grouping). Read surface lives in
 * `DocumentLineageCard` via inline `useQuery`; mutations land here so
 * call sites stay tidy.
 */

import { api } from '../config/api';
import type { PaymentTermInstallment } from './quotes.service';

export interface UpdateInstallmentPlanResult {
  invoiceIds: number[];
  kept: number[];
  created: number[];
  deleted: number[];
}

export const dealsService = {
  /**
   * Atomically reshape an installment plan after siblings have spawned.
   * See backend invoiceService.updateInstallmentPlan for the full
   * guard/reuse/grow/trim semantics. 409 responses carry one of:
   *   - INVOICE_LOCKED — at least one sibling is past scheduled
   *   - PLAN_HAS_STORNO — a Storno already exists on the deal
   * 400 responses carry NOT_INSTALLMENT_PLAN or PERCENT_SUM_INVALID.
   */
  async updateInstallmentPlan(
    dealUuid: string,
    installments: PaymentTermInstallment[],
  ): Promise<UpdateInstallmentPlanResult> {
    const res = await api.put(`/admin/deals/${dealUuid}/installment-plan`, {
      installments,
    });
    return (res.data?.data || res.data) as UpdateInstallmentPlanResult;
  },
};

export default dealsService;
