/**
 * CRM → Tax / Steuer Report sub-page.
 *
 * Period-scoped revenue listing for tax filing. Filters live in the
 * URL? No — they live in component state for now (kept simple). Three
 * actions on the page:
 *
 *   1. Filter: period preset + currency  → react-query refetch
 *   2. Export PDF (landscape A4, company letterhead)
 *   3. Export CSV (RFC 4180, accountant-friendly)
 *
 * The table shows cancelled invoices in grey + a "Storniert" badge so
 * the invoice-number sequence stays gap-free (DE/CH/AT audit trail
 * requirement). Their amounts are visible but excluded from the
 * totals card on the right.
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Calculator, Download, FileDown, FileSpreadsheet, AlertCircle } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Button, Card, Loading, LocalizedDateInput } from '../../../components/common';

// Lightweight native select styled to match Input — the common barrel
// doesn't export a Select component, and the form pieces here are
// small enough that a plain styled <select> is the right call.
const selectClassName =
  'w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500';
import { taxReportService, type TaxReportParams } from '../../../services/taxReport.service';
import { ledgerService, type ExportFormat } from '../../../services/ledger.service';
import { useFeatureFlags } from '../../../contexts/FeatureFlagsContext';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { toast } from 'react-toastify';

const LEDGER_FORMATS: ExportFormat[] = ['generic', 'banana', 'banana_ie', 'bexio'];

type PeriodPreset = 'thisYear' | 'lastYear' | 'thisQuarter' | 'lastQuarter' | 'custom';

function isoDate(d: Date): string {
  // YYYY-MM-DD in local time. Tax reports are user-facing — a Swiss
  // admin asking for "this quarter" means their local Q, not UTC.
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function periodForPreset(preset: PeriodPreset, today = new Date()): { from: string; to: string } {
  const y = today.getFullYear();
  if (preset === 'thisYear') return { from: `${y}-01-01`, to: `${y}-12-31` };
  if (preset === 'lastYear') return { from: `${y - 1}-01-01`, to: `${y - 1}-12-31` };
  const quarter = Math.floor(today.getMonth() / 3); // 0..3
  if (preset === 'thisQuarter') {
    const startMonth = quarter * 3;
    const endMonth = startMonth + 2;
    const lastDay = new Date(y, endMonth + 1, 0).getDate();
    return {
      from: `${y}-${String(startMonth + 1).padStart(2, '0')}-01`,
      to:   `${y}-${String(endMonth + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
    };
  }
  // lastQuarter — handle Q1 rollover into previous year's Q4.
  let lastQYear = y;
  let lastQ = quarter - 1;
  if (lastQ < 0) { lastQ = 3; lastQYear = y - 1; }
  const startMonth = lastQ * 3;
  const endMonth = startMonth + 2;
  const lastDay = new Date(lastQYear, endMonth + 1, 0).getDate();
  return {
    from: `${lastQYear}-${String(startMonth + 1).padStart(2, '0')}-01`,
    to:   `${lastQYear}-${String(endMonth + 1).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`,
  };
}

function formatMinor(minor: number, currency: string, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2,
  }).format((minor || 0) / 100);
}

function triggerBrowserDownload(url: string, filename: string) {
  // Off-DOM anchor + click is the cross-browser idiom for blob
  // downloads. The blob URL is revoked after a short delay so Safari
  // has time to start the actual download (revoking too early breaks it).
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

export const TaxReportPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const { flags } = useFeatureFlags();
  const { format: fmtDate } = useLocalizedDate();
  const [preset, setPreset] = useState<PeriodPreset>('thisYear');
  const initialPeriod = useMemo(() => periodForPreset('thisYear'), []);
  const [from, setFrom] = useState(initialPeriod.from);
  const [to,   setTo]   = useState(initialPeriod.to);
  const [currency, setCurrency] = useState<string>('CHF');
  const [isExporting, setIsExporting] = useState<'pdf' | 'csv' | 'ledger' | null>(null);
  // Export-only scope (income/cost split). The on-screen report stays complete.
  const [exportScope, setExportScope] = useState<'all' | 'income' | 'cost'>('all');
  // Treuhänder (collective-journal) export — same period/currency as the
  // report; target tool picks the import format (generic / Banana / bexio).
  const [ledgerFormat, setLedgerFormat] = useState<ExportFormat>('generic');
  // Unified-ledger sort (#5). Defaults to date ascending — matches the
  // server-side order so the first paint is stable.
  const [sort, setSort] = useState<{ key: string; dir: 'asc' | 'desc' }>({ key: 'date', dir: 'asc' });

  const onPresetChange = (next: PeriodPreset) => {
    setPreset(next);
    if (next !== 'custom') {
      const p = periodForPreset(next);
      setFrom(p.from);
      setTo(p.to);
    }
  };

  const params: TaxReportParams = { from, to, currency, locale: i18n.language };

  const { data: report, isLoading, isError, error, refetch } = useQuery({
    queryKey: ['tax-report', params],
    queryFn: () => taxReportService.getReport(params),
    enabled: Boolean(from && to && currency),
    // Tax data is slow-moving — no need to re-fetch on focus.
    staleTime: 60_000,
    refetchOnWindowFocus: false,
  });

  const handleExport = async (format: 'pdf' | 'csv') => {
    setIsExporting(format);
    try {
      const exportParams = { ...params, scope: exportScope };
      const { url, filename } = format === 'pdf'
        ? await taxReportService.downloadPdfUrl(exportParams)
        : await taxReportService.downloadCsvUrl(exportParams);
      triggerBrowserDownload(url, filename);
    } catch (err) {
      toast.error(t('taxReport.exportFailed', 'Export failed. Please try again.'));
      // eslint-disable-next-line no-console
      console.error(err);
    } finally {
      setIsExporting(null);
    }
  };

  // Treuhänder collective-journal export (double-entry postings with account +
  // VAT codes) — reuses the page's period/currency, adds the target-tool format.
  const handleLedgerExport = async () => {
    setIsExporting('ledger');
    try {
      const { url, filename } = await ledgerService.downloadExportUrl({ from, to, currency, format: ledgerFormat });
      triggerBrowserDownload(url, filename);
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('taxReport.exportFailed', 'Export failed. Please try again.'));
      // eslint-disable-next-line no-console
      console.error(err);
    } finally {
      setIsExporting(null);
    }
  };

  // Per maintainer: every CH/LI/DE/AT-based business writes 1'000.00
  // regardless of document language, so we default to de-CH (the only
  // Intl locale producing apostrophe thousands). Non-DACH operators
  // can override later if needed.
  const intlLocale = 'de-CH';

  // Show the per-VAT-rate breakdown only when there are 2+ distinct
  // rates in the period. With a single rate the breakdown is just a
  // restatement of the grand totals — pure noise.
  const showPerRateBreakdown = (report?.totalsByVatRate.length || 0) > 1;
  const hasCosts = (report?.costs?.rows.length || 0) > 0;
  const hasAnyData = !!report && (report.rows.length > 0 || hasCosts);
  const exportsDisabled = isLoading || isExporting !== null || !hasAnyData;

  // Whether the disclaimer + the "tax treatment" semantics apply: any
  // cost row in the ledger (type !== 'outgoing').
  const ledgerHasCosts = !!report && report.ledger.some((r) => r.type !== 'outgoing');

  // Sorted COPY of the ledger. Numeric sort for the signed amount
  // columns (so income sits above costs ascending), localeCompare for
  // date / party / type. Toggling a header flips the direction.
  const sortedLedger = useMemo(() => {
    if (!report) return [];
    const copy = [...report.ledger];
    const { key, dir } = sort;
    const factor = dir === 'asc' ? 1 : -1;
    const numericKeys: Record<string, 'netMinor' | 'vatMinor' | 'totalMinor'> = {
      net: 'netMinor', vat: 'vatMinor', gross: 'totalMinor',
    };
    copy.sort((a, b) => {
      if (key in numericKeys) {
        const f = numericKeys[key];
        return (a[f] - b[f]) * factor;
      }
      const av = key === 'party' ? a.party : key === 'type' ? a.type : a.date;
      const bv = key === 'party' ? b.party : key === 'type' ? b.type : b.date;
      return String(av || '').localeCompare(String(bv || '')) * factor;
    });
    return copy;
  }, [report, sort]);

  const toggleSort = (key: string) => {
    setSort((prev) => prev.key === key
      ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
      : { key, dir: 'asc' });
  };
  const sortIndicator = (key: string) => (sort.key === key ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : '');

  return (
    <div className="space-y-6">
      {/* Top row — filter card on the left (stacked rows, narrower
          footprint), compact totals card on the right. Both cards sit
          above the table so the table gets the full content width. */}
      <div className="grid grid-cols-1 lg:grid-cols-[1fr_300px] gap-6 items-start">
        {/* Filter card (left) */}
        <Card padding="md">
          <div className="flex items-start gap-3 mb-4">
            <div className="w-10 h-10 rounded-lg bg-accent-soft text-on-accent-soft flex items-center justify-center flex-shrink-0">
              <Calculator className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h1 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                {t('taxReport.title', 'Tax report')}
              </h1>
              <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-0.5">
                {t(
                  'taxReport.intro',
                  'Period-scoped revenue list with net + VAT breakdown grouped by VAT rate. Cancelled invoices stay visible for audit-trail continuity but are excluded from totals.',
                )}
              </p>
            </div>
          </div>

          {/* Filters stacked vertically per the agreed layout:
              Row 1: period preset (full width)
              Row 2: from / to (side-by-side)
              Row 3: currency (full width)
              Row 4: export buttons (right-aligned) */}
          <div className="space-y-3">
            <div>
              <label htmlFor="period-preset" className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('taxReport.filters.period', 'Period')}
              </label>
              <select
                id="period-preset"
                value={preset}
                onChange={(e) => onPresetChange(e.target.value as PeriodPreset)}
                className={selectClassName}
              >
                <option value="thisYear">{t('taxReport.filters.thisYear', 'This year')}</option>
                <option value="lastYear">{t('taxReport.filters.lastYear', 'Last year')}</option>
                <option value="thisQuarter">{t('taxReport.filters.thisQuarter', 'This quarter')}</option>
                <option value="lastQuarter">{t('taxReport.filters.lastQuarter', 'Last quarter')}</option>
                <option value="custom">{t('taxReport.filters.custom', 'Custom range')}</option>
              </select>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('taxReport.filters.from', 'From')}
                </label>
                <LocalizedDateInput
                  value={from}
                  onChange={(iso) => { setFrom(iso); setPreset('custom'); }}
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('taxReport.filters.to', 'To')}
                </label>
                <LocalizedDateInput
                  value={to}
                  onChange={(iso) => { setTo(iso); setPreset('custom'); }}
                />
              </div>
            </div>

            <div>
              <label htmlFor="currency" className="block text-xs font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('taxReport.filters.currency', 'Currency')}
              </label>
              <select
                id="currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value)}
                className={selectClassName}
              >
                <option value="CHF">CHF</option>
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
                <option value="GBP">GBP</option>
              </select>
            </div>

            {/* Export area — two clearly-separated groups so it's obvious
                what each file is and who it's for: the human-readable Report
                (PDF/CSV) and the accounting Journal (for the Treuhänder). The
                Journal group only shows when the accounting layer is on, since
                it needs the Chart-of-accounts mapping. */}
            <div className="pt-3 mt-1 border-t border-neutral-200 dark:border-neutral-700 space-y-3">
              {/* Group 1 — Report (for you) */}
              <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
                <div className="min-w-0">
                  <div className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                    {t('taxReport.export.reportTitle', 'Report')}
                  </div>
                  <div className="text-[11px] text-neutral-400 dark:text-neutral-500">
                    {t('taxReport.export.reportHint', 'Readable list — for your own records.')}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1.5 text-xs font-medium text-neutral-500 dark:text-neutral-400">
                    {t('taxReport.export.scopeLabel', 'Scope')}
                    <select
                      value={exportScope}
                      onChange={(e) => setExportScope(e.target.value as 'all' | 'income' | 'cost')}
                      disabled={exportsDisabled}
                      className={`${selectClassName} w-auto min-w-[140px]`}
                    >
                      <option value="all">{t('taxReport.export.scopeAll', 'Complete')}</option>
                      <option value="income">{t('taxReport.export.scopeIncome', 'Income only')}</option>
                      <option value="cost">{t('taxReport.export.scopeCost', 'Cost only')}</option>
                    </select>
                  </label>
                  <Button
                    className="min-w-[150px]"
                    variant="outline"
                    onClick={() => handleExport('csv')}
                    disabled={exportsDisabled}
                    isLoading={isExporting === 'csv'}
                    leftIcon={<FileDown className="w-4 h-4" />}
                  >
                    {t('taxReport.exportCsv', 'Export CSV')}
                  </Button>
                  <Button
                    className="min-w-[150px]"
                    variant="primary"
                    onClick={() => handleExport('pdf')}
                    disabled={exportsDisabled}
                    isLoading={isExporting === 'pdf'}
                    leftIcon={<Download className="w-4 h-4" />}
                  >
                    {t('taxReport.exportPdf', 'Export PDF')}
                  </Button>
                </div>
              </div>

              {/* Group 2 — Accounting journal (for your accountant). Solid
                  divider above to separate it from the Report group. */}
              {flags.accounting && (
                <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 pt-3 border-t border-neutral-200 dark:border-neutral-700">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                      {t('taxReport.export.journalTitle', 'Accounting journal')}
                    </div>
                    <div className="text-[11px] text-neutral-400 dark:text-neutral-500">
                      {t('taxReport.ledgerExportHint', 'Double-entry postings for your accountant, mapped via your Chart of accounts.')}{' '}
                      <Link to="/admin/settings?tab=accounting" className="underline hover:text-neutral-600 dark:hover:text-neutral-300">
                        {t('taxReport.ledgerExportConfigure', 'Configure →')}
                      </Link>
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <select
                      value={ledgerFormat}
                      onChange={(e) => setLedgerFormat(e.target.value as ExportFormat)}
                      disabled={exportsDisabled}
                      aria-label={t('ledger.export.format', 'Target tool') as string}
                      className={`${selectClassName} min-w-[150px] w-auto`}
                    >
                      {LEDGER_FORMATS.map((f) => (
                        <option key={f} value={f}>{t(`ledger.export.format_${f}`, f)}</option>
                      ))}
                    </select>
                    <Button
                      className="min-w-[150px]"
                      variant="outline"
                      onClick={handleLedgerExport}
                      disabled={exportsDisabled}
                      isLoading={isExporting === 'ledger'}
                      leftIcon={<FileSpreadsheet className="w-4 h-4" />}
                    >
                      {t('taxReport.ledgerExport', 'Accountant export')}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </Card>

        {/* Totals card (right) — compact summary. Headline is the
            grand totals; the per-VAT-rate breakdown appears only when
            there are 2+ rates in the period (otherwise it duplicates
            the grand totals). Cancelled footnote at the bottom when
            applicable. */}
        {hasAnyData && report && (
          <Card padding="md">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-2">
              {t('taxReport.summary.outgoingTitle', 'Outgoing invoices')}
            </h2>
            <div className="space-y-1.5 text-sm">
              <div className="flex justify-between gap-3">
                <span className="text-neutral-700 dark:text-neutral-300">{t('taxReport.grandTotalNet', 'Total net')}</span>
                <span className="tabular-nums font-medium text-neutral-900 dark:text-neutral-100">
                  {formatMinor(report.grandTotalNet, report.currency, intlLocale)}
                </span>
              </div>
              <div className="flex justify-between gap-3">
                <span className="text-neutral-700 dark:text-neutral-300">{t('taxReport.grandTotalVat', 'Total VAT')}</span>
                <span className="tabular-nums font-medium text-neutral-900 dark:text-neutral-100">
                  {formatMinor(report.grandTotalVat, report.currency, intlLocale)}
                </span>
              </div>
              <div className="flex justify-between gap-3 pt-1.5 border-t border-neutral-200 dark:border-neutral-700">
                <span className="font-semibold text-neutral-900 dark:text-neutral-100">{t('taxReport.grandTotalGross', 'Total gross')}</span>
                <span className="tabular-nums font-semibold text-neutral-900 dark:text-neutral-100">
                  {formatMinor(report.grandTotal, report.currency, intlLocale)}
                </span>
              </div>
            </div>

            {/* Einnahmen-Ausgaben summary (#4): income vs costs vs result.
                Always shown when the cost side loaded (even with zero costs)
                so the result/income is visible, not just revenue. Hidden only
                if the cost side errored (a banner explains that separately). */}
            {report.summary && !report.costsError && (
              <div className="mt-4 pt-3 border-t border-neutral-200 dark:border-neutral-700">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-2">
                  {t('taxReport.summary.title', 'Income / costs')}
                </h2>
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="text-neutral-700 dark:text-neutral-300">{t('taxReport.summary.income', 'Income')}</span>
                    <span className="tabular-nums text-emerald-700 dark:text-emerald-400">
                      {formatMinor(report.summary.incomeGrossMinor, report.currency, intlLocale)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3">
                    <span className="text-neutral-700 dark:text-neutral-300">{t('taxReport.summary.costs', 'Costs')}</span>
                    <span className="tabular-nums text-rose-700 dark:text-rose-400">
                      −{formatMinor(report.summary.costGrossMinor, report.currency, intlLocale)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3 pt-1.5 border-t border-neutral-200 dark:border-neutral-700">
                    <span className="font-semibold text-neutral-900 dark:text-neutral-100">{t('taxReport.summary.result', 'Result')}</span>
                    <span className="tabular-nums font-semibold text-neutral-900 dark:text-neutral-100">
                      {formatMinor(report.summary.resultGrossMinor, report.currency, intlLocale)}
                    </span>
                  </div>
                  <div className="flex justify-between gap-3 text-xs text-neutral-500 dark:text-neutral-400">
                    <span>{t('taxReport.summary.vatPayable', 'VAT payable (output − input)')}</span>
                    <span className="tabular-nums">
                      {report.summary.vatRegistrationConfigured === false || report.summary.vatPayableMinor == null
                        ? '—'
                        : formatMinor(report.summary.vatPayableMinor, report.currency, intlLocale)}
                    </span>
                  </div>
                  {report.summary.vatRegistrationConfigured === false && (
                    <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-400 pt-1">
                      <AlertCircle className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                      <span>{t('taxReport.summary.vatUnconfigured', 'VAT registration isn’t configured, so VAT payable can’t be computed. Set it under Settings → Accounting.')}</span>
                    </p>
                  )}
                </div>
              </div>
            )}

            {showPerRateBreakdown && (
              <div className="mt-4 pt-3 border-t border-neutral-200 dark:border-neutral-700">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-2">
                  {t('taxReport.totalsByVatRate', 'Totals by VAT rate')}
                </h2>
                <div className="space-y-2 text-sm">
                  {report.totalsByVatRate.map((b) => (
                    <div key={b.vatRate}>
                      <div className="text-xs text-neutral-500 dark:text-neutral-400">
                        {Number(b.vatRate).toFixed(1)}%
                      </div>
                      <div className="flex justify-between gap-3 tabular-nums">
                        <span className="text-neutral-700 dark:text-neutral-300">{t('taxReport.col.net', 'Net')}</span>
                        <span>{formatMinor(b.netMinor, report.currency, intlLocale)}</span>
                      </div>
                      <div className="flex justify-between gap-3 tabular-nums">
                        <span className="text-neutral-700 dark:text-neutral-300">{t('taxReport.col.vat', 'VAT')}</span>
                        <span>{formatMinor(b.vatMinor, report.currency, intlLocale)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {report.cancelledCount > 0 && (
              <p className="mt-3 pt-3 border-t border-neutral-200 dark:border-neutral-700 text-xs text-neutral-500 dark:text-neutral-400">
                {t('taxReport.cancelledFootnote', '{{count}} cancelled invoice(s) — amounts excluded from totals (shown for audit-trail continuity).', { count: report.cancelledCount })}
              </p>
            )}
          </Card>
        )}
      </div>

      {/* Non-fatal: the revenue report loaded but the cost side errored. */}
      {report?.costsError && (
        <Card padding="md">
          <div className="flex items-start gap-3 text-amber-700 dark:text-amber-400">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">{t('taxReport.costsErrorTitle', 'Costs could not be loaded')}</p>
              <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1 break-words">{report.costsError}</p>
            </div>
          </div>
        </Card>
      )}

      {/* Results */}
      {isLoading ? (
        <Card padding="lg"><Loading /></Card>
      ) : isError ? (
        <Card padding="lg">
          <div className="flex items-start gap-3 text-amber-700 dark:text-amber-400">
            <AlertCircle className="w-5 h-5 flex-shrink-0 mt-0.5" />
            <div>
              <p className="font-medium">{t('taxReport.errorTitle', 'Could not load tax report')}</p>
              <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
                {(error as Error)?.message || String(error)}
              </p>
              <Button variant="outline" size="sm" onClick={() => refetch()} className="mt-3">
                {t('common.retry', 'Retry')}
              </Button>
            </div>
          </div>
        </Card>
      ) : !hasAnyData ? (
        <Card padding="lg">
          <p className="text-center text-sm text-neutral-600 dark:text-neutral-400">
            {t('taxReport.empty', 'No invoices in this period.')}
          </p>
        </Card>
      ) : (
        <>
          {report && report.ledger.length > 0 && (
          /* Unified ledger (#5) — one typed, signed, sortable table.
              Outgoing invoices are positive; incoming invoices + expenses
              negative so the amount columns net toward the Result. */
          <Card padding="none">
            {/* Two nested wrappers: the OUTER clips the header row's
                solid fill so the top corners stay rounded (matches
                the Card's own rounded-xl). The INNER provides
                horizontal scroll when the table is wider than the
                viewport. Combining `overflow-hidden` + `overflow-x-auto`
                on a single element would cancel the auto-scroll. */}
            <div className="rounded-xl overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                <thead className="bg-neutral-50 dark:bg-neutral-900 text-neutral-700 dark:text-neutral-300">
                  <tr>
                    <th className="px-2 py-2 text-right font-medium w-10">#</th>
                    <th className="px-2 py-2 text-left font-medium whitespace-nowrap">
                      <button type="button" onClick={() => toggleSort('type')} className="font-medium hover:text-primary-600 dark:hover:text-primary-400">
                        {t('taxReport.col.type', 'Type')}{sortIndicator('type')}
                      </button>
                    </th>
                    <th className="px-2 py-2 text-left font-medium whitespace-nowrap">
                      <button type="button" onClick={() => toggleSort('date')} className="font-medium hover:text-primary-600 dark:hover:text-primary-400">
                        {t('taxReport.col.date', 'Date')}{sortIndicator('date')}
                      </button>
                    </th>
                    <th className="px-2 py-2 text-left font-medium whitespace-nowrap">{t('taxReport.col.reference', 'Reference')}</th>
                    <th className="px-2 py-2 text-left font-medium">
                      <button type="button" onClick={() => toggleSort('party')} className="font-medium hover:text-primary-600 dark:hover:text-primary-400">
                        {t('taxReport.col.party', 'Customer / supplier')}{sortIndicator('party')}
                      </button>
                    </th>
                    <th className="px-2 py-2 text-left font-medium">{t('taxReport.col.event', 'Event')}</th>
                    <th className="px-2 py-2 text-left font-medium whitespace-nowrap">{t('taxReport.col.tax', 'Tax')}</th>
                    <th className="px-2 py-2 text-right font-medium whitespace-nowrap">
                      <button type="button" onClick={() => toggleSort('net')} className="font-medium hover:text-primary-600 dark:hover:text-primary-400">
                        {t('taxReport.col.net', 'Net')}{sortIndicator('net')}
                      </button>
                    </th>
                    <th className="px-2 py-2 text-right font-medium whitespace-nowrap">
                      <button type="button" onClick={() => toggleSort('vat')} className="font-medium hover:text-primary-600 dark:hover:text-primary-400">
                        {t('taxReport.col.vat', 'VAT')}{sortIndicator('vat')}
                      </button>
                    </th>
                    <th className="px-2 py-2 text-right font-medium whitespace-nowrap">
                      <button type="button" onClick={() => toggleSort('gross')} className="font-medium hover:text-primary-600 dark:hover:text-primary-400">
                        {t('taxReport.col.total', 'Gross')}{sortIndicator('gross')}
                      </button>
                    </th>
                    <th className="px-2 py-2 text-right font-medium whitespace-nowrap">{t('taxReport.col.skonto', 'Skonto')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-200 dark:divide-neutral-800">
                  {sortedLedger.map((row, i) => (
                    <tr
                      key={row.key}
                      className={row.isCancelled
                        ? 'text-neutral-400 dark:text-neutral-500 italic'
                        : 'text-neutral-900 dark:text-neutral-100'}
                    >
                      <td className="px-2 py-1.5 text-right tabular-nums">{i + 1}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <span className={`inline-block px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded font-semibold not-italic ${
                          row.type === 'outgoing'
                            ? 'bg-teal-100 text-teal-800 dark:bg-teal-900/40 dark:text-teal-300'
                            : row.type === 'incoming'
                              ? 'bg-indigo-100 text-indigo-800 dark:bg-indigo-900/40 dark:text-indigo-300'
                              : 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300'
                        }`}>
                          {t(`taxReport.type.${row.type}`, row.type)}
                        </span>
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap tabular-nums">{fmtDate(String(row.date).slice(0, 10))}</td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        <span className="font-medium">{row.reference}</span>
                        {row.isCancelled && (
                          <span className="ml-2 inline-block px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded bg-neutral-200 dark:bg-neutral-700 text-neutral-700 dark:text-neutral-300 font-semibold not-italic">
                            {t('taxReport.statusCancelled', 'Cancelled')}
                          </span>
                        )}
                        {/* Storno + Reissue lineage markers — parity
                            with the admin invoices list so the same
                            colour scheme distinguishes the row kinds at
                            a glance across both surfaces. */}
                        {row.kind === 'storno' && (
                          <span className="ml-2 inline-block px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded bg-purple-100 dark:bg-purple-900/40 text-purple-800 dark:text-purple-300 font-semibold not-italic">
                            {t('bills.kind.storno', 'Storno')}
                          </span>
                        )}
                        {row.isReissue && (
                          <span className="ml-2 inline-block px-1.5 py-0.5 text-[10px] uppercase tracking-wider rounded bg-blue-100 dark:bg-blue-900/40 text-blue-800 dark:text-blue-300 font-semibold not-italic">
                            {t('bills.kind.reissue', 'Reissue')}
                          </span>
                        )}
                      </td>
                      <td className="px-2 py-1.5 truncate max-w-[180px]" title={row.party}>{row.party}</td>
                      <td className="px-2 py-1.5 truncate max-w-[180px]" title={row.eventName}>
                        {row.eventName || (row.type !== 'outgoing'
                          ? <span className="text-neutral-400 dark:text-neutral-500">{t('taxReport.cost.company', 'Company')}</span>
                          : '')}
                      </td>
                      <td className="px-2 py-1.5 whitespace-nowrap">
                        {row.type === 'outgoing'
                          ? <span className="tabular-nums">{Number(row.vatRate).toFixed(1)}%</span>
                          : <span className="text-xs text-neutral-500 dark:text-neutral-400">{row.taxTreatment}</span>}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {formatMinor(row.netMinor, report.currency, intlLocale)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap">
                        {formatMinor(row.vatMinor, report.currency, intlLocale)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap font-medium">
                        {formatMinor(row.totalMinor, report.currency, intlLocale)}
                      </td>
                      <td className="px-2 py-1.5 text-right tabular-nums whitespace-nowrap"
                        title={row.skontoApplied
                          ? t('taxReport.skontoTooltip', 'Paid with Skonto') as string
                          : undefined}>
                        {row.skontoApplied ? (
                          <span className="text-teal-700 dark:text-teal-300">
                            −{formatMinor(row.skontoAmountMinor, report.currency, intlLocale)}
                          </span>
                        ) : ''}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            </div>
          </Card>
          )}

          {/* Legal disclaimer — tax figures are a guideline. Per project
              rule: any surface touching tax/financial output must point
              the user at a professional. Shown whenever the ledger holds
              any cost row. */}
          {ledgerHasCosts && (
            <p className="flex items-start gap-2 text-xs text-neutral-500 dark:text-neutral-400">
              <AlertCircle className="w-4 h-4 flex-shrink-0 mt-0.5" />
              <span>
                {t(
                  'taxReport.costsDisclaimer',
                  'This income/expense overview is a guideline for your records (Einnahmen-Ausgaben-Rechnung). VAT reclaimability and the result figure depend on each cost’s tax treatment — verify with your Treuhänder / tax authority before filing.',
                )}
              </span>
            </p>
          )}
        </>
      )}
    </div>
  );
};
