/**
 * Admin → Tax Report API client. Hits /api/admin/tax-report/*.
 *
 * Three endpoints, one query-string contract:
 *   from, to     YYYY-MM-DD (inclusive)
 *   currency     ISO 4217 alpha-3 (uppercased server-side)
 *   locale       optional, defaults to the business profile default
 */
import { api } from '../config/api';

export interface TaxReportRow {
  id: number;
  invoiceNumber: string;
  issueDate: string;
  currency: string;
  status: string;
  isCancelled: boolean;
  /** Document kind discriminator (migration 114). Drives the "Storno"
   *  badge on rows where kind='storno'. */
  kind: 'invoice' | 'storno';
  /** True when this invoice was created via Cancel & reissue
   *  (replaces_invoice_id is set on a non-cancelled row). Drives the
   *  "Reissue" badge. */
  isReissue: boolean;
  /** Replacement invoice number when this cancelled row was reissued. */
  replacedByInvoiceNumber: string | null;
  /** Aggregated from `invoice_payment_log` — true when any payment for
   *  this invoice was recorded as Skonto-applied (migration 126). */
  skontoApplied: boolean;
  /** Sum of discount in minor units across all Skonto-applied payments
   *  on this invoice. 0 when `skontoApplied` is false. */
  skontoAmountMinor: number;
  vatRate: number;
  customerLabel: string;
  eventName: string;
  /** Minor units (cents/Rappen). */
  netMinor: number;
  vatMinor: number;
  totalMinor: number;
}

export interface TaxReportBucket {
  vatRate: number;
  netMinor: number;
  vatMinor: number;
  totalMinor: number;
}

/** A single cost-side line (#4 — Einnahmen-Ausgaben). Either an external
 *  incoming invoice (`source: 'incoming'`) or an internal expense
 *  (`source: 'expense'`). Booked to an event (`eventName`) or the
 *  company (empty `eventName`). */
export interface TaxReportCostRow {
  id: number;
  source: 'incoming' | 'expense';
  date: string;
  supplierLabel: string;
  description: string;
  eventName: string;
  disposition: string;
  taxTreatment: string;
  status: string;
  netMinor: number;
  vatMinor: number;
  totalMinor: number;
}

export interface TaxReportCosts {
  rows: TaxReportCostRow[];
  totalNet: number;
  totalVat: number;
  totalGross: number;
}

/** Income vs cost vs result summary (minor units). `vatPayableMinor` =
 *  output VAT − input VAT (a guideline figure; actual MWST filing
 *  depends on each cost's tax treatment — verify with a Treuhänder). */
export interface TaxReportSummary {
  incomeNetMinor: number;
  incomeVatMinor: number;
  incomeGrossMinor: number;
  costNetMinor: number;
  costVatMinor: number;
  costGrossMinor: number;
  resultNetMinor: number;
  resultGrossMinor: number;
  /** Whether `accounting_vat_registered` is configured. When false, the
   *  report refuses to guess and `vatPayableMinor` is null. */
  vatRegistrationConfigured?: boolean;
  /** output VAT − reclaimable input VAT; `null` when VAT registration is
   *  unconfigured (the UI shows "—" + a warning instead of a guess). */
  vatPayableMinor: number | null;
}

/** A single row of the unified ledger (#5). Outgoing invoices carry
 *  POSITIVE amounts; incoming invoices + expenses are NEGATIVE so the
 *  amount columns net toward the Result and a value-sort runs
 *  income → costs. `type` is the discriminator. */
export interface TaxLedgerRow {
  key: string;
  type: 'outgoing' | 'incoming' | 'expense';
  date: string;
  reference: string;
  party: string;
  eventName: string;
  vatRate: number | null;
  taxTreatment: string | null;
  status: string;
  isCancelled: boolean;
  isReissue: boolean;
  kind: string | null;
  skontoApplied: boolean;
  skontoAmountMinor: number;
  netMinor: number;
  vatMinor: number;
  totalMinor: number;
}

export interface TaxReport {
  rows: TaxReportRow[];
  totalsByVatRate: TaxReportBucket[];
  grandTotalNet: number;
  grandTotalVat: number;
  grandTotal: number;
  cancelledCount: number;
  /** Cost side (#4). Present when the accounting tables exist; empty
   *  otherwise. */
  costs: TaxReportCosts;
  /** Non-fatal: set when the cost side failed to load (revenue still shown). */
  costsError?: string | null;
  /** Income/cost/result summary (#4). */
  summary: TaxReportSummary;
  /** Unified, signed, typed ledger (#5) — the canonical surface for the
   *  on-screen table + exports. Sorted by date ascending server-side. */
  ledger: TaxLedgerRow[];
  currency: string;
  period: { from: string; to: string };
}

export interface TaxReportParams {
  from: string;
  to: string;
  currency: string;
  locale?: string;
  /** Export-only scope: 'all' (default) | 'income' | 'cost'. Ignored by the
   *  on-screen report; the PDF/CSV exports filter the ledger + summary. */
  scope?: 'all' | 'income' | 'cost';
}

function buildQueryString(params: TaxReportParams): string {
  const usp = new URLSearchParams({
    from: params.from,
    to: params.to,
    currency: params.currency,
  });
  if (params.locale) usp.set('locale', params.locale);
  if (params.scope && params.scope !== 'all') usp.set('scope', params.scope);
  return usp.toString();
}

export const taxReportService = {
  async getReport(params: TaxReportParams): Promise<TaxReport> {
    const res = await api.get<{ report: TaxReport }>(
      `/admin/tax-report?${buildQueryString(params)}`,
    );
    return res.data.report;
  },

  /**
   * Trigger a browser download for the PDF. Returns the blob URL the
   * caller can either assign to `window.location` or open in a new tab.
   * The caller is responsible for revoking the URL when done.
   */
  async downloadPdfUrl(params: TaxReportParams): Promise<{ url: string; filename: string }> {
    const res = await api.get(`/admin/tax-report/pdf?${buildQueryString(params)}`, {
      responseType: 'blob',
    });
    const url = URL.createObjectURL(res.data);
    const scopeTag = params.scope && params.scope !== 'all' ? `${params.scope}_` : '';
    const filename = `tax_report_${scopeTag}${params.from}_to_${params.to}_${params.currency}.pdf`;
    return { url, filename };
  },

  async downloadCsvUrl(params: TaxReportParams): Promise<{ url: string; filename: string }> {
    const res = await api.get(`/admin/tax-report/csv?${buildQueryString(params)}`, {
      responseType: 'blob',
    });
    const url = URL.createObjectURL(res.data);
    const scopeTag = params.scope && params.scope !== 'all' ? `${params.scope}_` : '';
    const filename = `tax_report_${scopeTag}${params.from}_to_${params.to}_${params.currency}.csv`;
    return { url, filename };
  },
};
