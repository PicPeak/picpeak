/**
 * Read-only VAT-code registry for the invoice/quote editors. Hits the un-gated
 * /admin/vat-codes endpoint (works without the accounting feature). Management
 * lives in Settings → Accounting (ledger.service).
 */
import { api } from '../config/api';

export interface VatCodeOption {
  id: number;
  code: string;
  name: string;
  rate: number;
  direction: 'output' | 'input';
}

export const vatCodesService = {
  async listOutput(): Promise<VatCodeOption[]> {
    const { data } = await api.get('/admin/vat-codes', { params: { direction: 'output' } });
    return (data?.items ?? []) as VatCodeOption[];
  },
};
