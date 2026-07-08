/**
 * Admin → Ledger (Accounting Layer A) API client. Hits /api/admin/ledger/*.
 *
 * Chart of accounts + VAT codes CRUD, category/settings mappings, and the
 * Treuhänder collective-journal export (generic / Banana / bexio).
 */
import { api } from '../config/api';

export type AccountType = 'asset' | 'liability' | 'equity' | 'revenue' | 'expense';
export type VatDirection = 'output' | 'input';
export type ExportFormat = 'generic' | 'banana' | 'banana_ie' | 'bexio';

export interface LedgerAccount {
  id: number;
  number: string;
  name: string;
  type: AccountType;
  is_seed: boolean;
  active: boolean;
  display_order: number;
}

export interface VatCode {
  id: number;
  code: string;
  name: string;
  rate: number;
  direction: VatDirection;
  account_id: number | null;
  is_seed: boolean;
  active: boolean;
  display_order: number;
}

export interface LedgerCategory {
  id: number;
  name: string;
  color: string | null;
  ledger_account_id: number | null;
}

export interface LedgerSettings {
  ledger_account_debitoren?: string;
  ledger_account_kreditoren?: string;
  ledger_account_bank?: string;
  ledger_account_cash?: string;
  ledger_account_default_revenue?: string;
  ledger_account_default_expense?: string;
  ledger_account_mileage?: string;
  ledger_account_per_diem?: string;
  ledger_account_rebilled_revenue?: string;
  ledger_vat_map?: Record<string, string>;
  ledger_output_vat_map?: Record<string, string>;
}

export interface LedgerMappings { categories: LedgerCategory[]; settings: LedgerSettings; }

export interface ExportParams { from: string; to: string; currency: string; format: ExportFormat; }

export const ledgerService = {
  // ── accounts ──
  async listAccounts(): Promise<LedgerAccount[]> { const { data } = await api.get('/admin/ledger/accounts'); return data.items; },
  async createAccount(payload: { number: string; name: string; type: AccountType }): Promise<LedgerAccount> {
    const { data } = await api.post('/admin/ledger/accounts', payload); return data.account;
  },
  async updateAccount(id: number, payload: Partial<{ number: string; name: string; type: AccountType; active: boolean }>): Promise<LedgerAccount> {
    const { data } = await api.patch(`/admin/ledger/accounts/${id}`, payload); return data.account;
  },
  async deleteAccount(id: number): Promise<void> { await api.delete(`/admin/ledger/accounts/${id}`); },

  // ── VAT codes ──
  async listVatCodes(): Promise<VatCode[]> { const { data } = await api.get('/admin/ledger/vat-codes'); return data.items; },
  async createVatCode(payload: { code: string; name: string; rate: number; direction: VatDirection; accountId?: number | null }): Promise<VatCode> {
    const { data } = await api.post('/admin/ledger/vat-codes', payload); return data.vatCode;
  },
  async updateVatCode(id: number, payload: Partial<{ code: string; name: string; rate: number; direction: VatDirection; accountId: number | null; active: boolean }>): Promise<VatCode> {
    const { data } = await api.patch(`/admin/ledger/vat-codes/${id}`, payload); return data.vatCode;
  },
  async deleteVatCode(id: number): Promise<void> { await api.delete(`/admin/ledger/vat-codes/${id}`); },

  // ── mappings ──
  async getMappings(): Promise<LedgerMappings> { const { data } = await api.get('/admin/ledger/mappings'); return data; },
  async setCategoryAccount(id: number, ledgerAccountId: number | null): Promise<LedgerCategory> {
    const { data } = await api.patch(`/admin/ledger/mappings/category/${id}`, { ledgerAccountId }); return data.category;
  },
  async updateSettings(patch: Partial<LedgerSettings>): Promise<{ updated: string[] }> {
    const { data } = await api.patch('/admin/ledger/mappings/settings', patch); return data;
  },

  // ── export ──
  async downloadExportUrl(params: ExportParams): Promise<{ url: string; filename: string }> {
    const usp = new URLSearchParams({ from: params.from, to: params.to, currency: params.currency, format: params.format });
    const res = await api.get(`/admin/ledger/export?${usp.toString()}`, { responseType: 'blob' });
    const url = URL.createObjectURL(res.data);
    // Both Banana variants want a tab-separated .txt (its "Text file with column
    // headers" import); generic / bexio stay .csv. Matches the backend extension.
    const ext = (params.format === 'banana' || params.format === 'banana_ie') ? 'txt' : 'csv';
    const filename = `journal_${params.from}_to_${params.to}_${params.currency}_${params.format}.${ext}`;
    return { url, filename };
  },
};
