/**
 * Bills (invoices) list. Mirrors QuotesListPage shape; adds an
 * "unpaid only" toggle and sorts including by due-date.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Upload, X } from 'lucide-react';
import { billsService, isDraftInvoice, type InvoiceStatus, type InvoiceSort } from '../../../services/bills.service';
import { Button, Card, Input, Loading, LocalizedDateInput, SortableHeader, useColumnSort, type SortColumnMap } from '../../../components/common';
import { formatMoney } from '../../../components/admin/LineItemsTable';
import { customerAdminService } from '../../../services/customerAdmin.service';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { toast } from 'react-toastify';

const STATUSES: InvoiceStatus[] = ['scheduled', 'pending_delivery', 'sent', 'paid', 'overdue', 'cancelled', 'skipped'];

// Maps each clickable column to its server-side sort enum pair. The "#"
// column sorts by creation order (newest/oldest) since that's how the
// invoice sequence is assigned; "Issued" sorts the admin-controlled
// issue_date and is the default (newest issued first).
const SORT_COLUMNS: SortColumnMap = {
  number: { asc: 'oldest', desc: 'newest', defaultDir: 'desc' },
  customer: { asc: 'customer_asc', desc: 'customer_desc' },
  issue: { asc: 'issue_asc', desc: 'issue_desc', defaultDir: 'desc' },
  due: { asc: 'due_asc', desc: 'due_desc' },
  value: { asc: 'value_asc', desc: 'value_desc', defaultDir: 'desc' },
};

export const BillsListPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { format: fmtDate } = useLocalizedDate();
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus[]>([]);
  const [unpaidOnly, setUnpaidOnly] = useState(false);
  const { sort, activeKey, activeDir, toggle } = useColumnSort<InvoiceSort>(SORT_COLUMNS, 'issue_desc');
  const [page, setPage] = useState(1);
  const [importOpen, setImportOpen] = useState(false);

  const onSort = (key: string) => { toggle(key); setPage(1); };

  const { data, isLoading } = useQuery({
    queryKey: ['invoices', { search, statusFilter, unpaidOnly, sort, page }],
    queryFn: () => billsService.list({
      q: search || undefined,
      status: statusFilter.length ? statusFilter : undefined,
      unpaidOnly,
      // Surface the running monthly/manual accumulator drafts here (they're
      // badged "Draft"); they're hidden from pickers/sub-lists by default.
      includeDrafts: true,
      sort, page, pageSize: 25,
    }),
  });

  const toggleStatus = (s: InvoiceStatus) => {
    setStatusFilter((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]);
    setPage(1);
  };

  return (
    <div className="container py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{t('bills.title', 'Invoices')}</h1>
            {/* Beta badge — matches the Customers + Quotes pages. */}
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
              title="Beta — feature is functional but still evolving"
            >
              {t('navigation.betaTag', 'Beta')}
            </span>
          </div>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            {t('bills.subtitle', 'Schedule, send, track payments and chase late invoices.')}
          </p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" onClick={() => setImportOpen(true)}>
            <Upload className="w-4 h-4 mr-1" />
            {t('bills.import', 'Import historical')}
          </Button>
          <Link to="/admin/clients/bills/new">
            <Button><Plus className="w-4 h-4 mr-1" />{t('bills.new', 'New invoice')}</Button>
          </Link>
        </div>
      </div>

      {importOpen && (
        <ImportHistoricalInvoiceModal onClose={() => setImportOpen(false)} />
      )}

      <Card padding="lg">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              type="text"
              placeholder={t('bills.searchPlaceholder', 'Search by number or customer…') as string}
              className="w-full pl-9 pr-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={unpaidOnly} onChange={(e) => setUnpaidOnly(e.target.checked)} />
            {t('bills.filter.unpaidOnly', 'Unpaid only')}
          </label>
        </div>
        <div className="mt-3 flex flex-wrap gap-1">
          {STATUSES.map((s) => {
            const active = statusFilter.includes(s);
            return (
              <button key={s} type="button" onClick={() => toggleStatus(s)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  active ? 'bg-accent-dark text-white border-accent-dark' : 'bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 border-neutral-300 dark:border-neutral-600'
                }`}
              >{t(`bills.status.${s}`, s)}</button>
            );
          })}
        </div>

        {/* Body inside the same card (matches Customers + Quotes). */}
        <div className="mt-4">
          {isLoading ? <Loading /> : !data || data.invoices.length === 0 ? (
            <p className="text-center text-neutral-500 dark:text-neutral-400 py-8">{t('bills.empty', 'No invoices yet.')}</p>
          ) : (
            <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-neutral-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
                    <tr>
                      <SortableHeader label="#" columnKey="number" activeKey={activeKey} activeDir={activeDir} onSort={onSort} />
                      <SortableHeader label={t('bills.table.customer', 'Customer')} columnKey="customer" activeKey={activeKey} activeDir={activeDir} onSort={onSort} />
                      <th className="px-3 py-2 text-left">{t('bills.table.event', 'Event')}</th>
                      <th className="px-3 py-2 text-left">{t('bills.table.installment', 'Installment')}</th>
                      <SortableHeader label={t('bills.table.issueDate', 'Issued')} columnKey="issue" activeKey={activeKey} activeDir={activeDir} onSort={onSort} />
                      <SortableHeader label={t('bills.table.dueDate', 'Due')} columnKey="due" activeKey={activeKey} activeDir={activeDir} onSort={onSort} />
                      <SortableHeader label={t('bills.table.total', 'Total')} columnKey="value" activeKey={activeKey} activeDir={activeDir} onSort={onSort} align="right" />
                      <th className="px-3 py-2 text-left">{t('bills.table.status', 'Status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.invoices.map((inv) => (
                      <tr key={inv.id}
                        className="border-t border-neutral-200 dark:border-neutral-700 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800"
                        onClick={() => navigate(`/admin/clients/bills/${inv.id}`)}
                      >
                        <td className="px-3 py-2 font-mono text-xs">
                          {inv.invoiceNumber}
                          {/* Storno discriminator badge — list rows
                              don't have a kind column today, so
                              tucking it inline with the number keeps
                              the table layout stable while making
                              cancellation documents instantly
                              recognisable. */}
                          {inv.kind === 'storno' && (
                            <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-purple-100 text-purple-800 uppercase tracking-wide">
                              {t('bills.kind.storno', 'Storno')}
                            </span>
                          )}
                          {/* Reissue marker — kind='invoice' rows with
                              replacesInvoiceId set were created from a
                              Cancel & reissue flow. Distinct colour
                              from Storno (blue vs purple) so the two
                              kinds are visually unambiguous. */}
                          {inv.kind !== 'storno' && inv.replacesInvoiceId && (
                            <span className="ml-2 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-blue-100 text-blue-800 uppercase tracking-wide">
                              {t('bills.kind.reissue', 'Reissue')}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2">{inv.customer.companyName || inv.customer.displayName || inv.customer.email}</td>
                        <td className="px-3 py-2 truncate max-w-xs">
                          {inv.eventName
                            ? (inv.eventId
                                ? <Link to={`/admin/events/${inv.eventId}`} className="text-neutral-900 dark:text-neutral-100 hover:underline" onClick={(e) => e.stopPropagation()}>{inv.eventName}</Link>
                                : inv.eventName)
                            : '—'}
                        </td>
                        <td className="px-3 py-2 text-xs text-neutral-500 dark:text-neutral-400">
                          {inv.installmentTotal > 1 ? `${inv.installmentIndex + 1}/${inv.installmentTotal} · ${inv.installmentLabel || ''}` : '—'}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">{inv.issueDate ? fmtDate(inv.issueDate) : '—'}</td>
                        <td className="px-3 py-2">{fmtDate(inv.dueDate)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatMoney(Number(inv.totalAmountMinor) / 100, inv.currency)}
                        </td>
                        <td className="px-3 py-2">
                          {isDraftInvoice(inv) ? (
                            // Held invoice: 'scheduled' with no send date (incl. the
                            // monthly/manual accumulator) never auto-ships, so badge it
                            // honestly as "Draft" rather than "Scheduled".
                            <span className="px-2 py-0.5 rounded text-xs font-medium bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-200">
                              {t('bills.status.draft', 'Draft')}
                            </span>
                          ) : (
                            <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                              inv.status === 'paid' ? 'bg-green-100 text-green-800'
                                : inv.status === 'overdue' ? 'bg-red-100 text-red-800'
                                : inv.status === 'sent' ? 'bg-blue-100 text-blue-800'
                                : inv.status === 'cancelled' ? 'bg-neutral-200 text-neutral-600'
                                : inv.status === 'skipped' ? 'bg-neutral-100 text-neutral-500 italic'
                                : 'bg-amber-100 text-amber-800'
                            }`}>{t(`bills.status.${inv.status}`, inv.status)}</span>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};

/**
 * Modal for attaching a historical invoice PDF to a customer's
 * account. Stores the original document on disk; the customer sees
 * the same bytes via their portal's "View PDF" button. Useful when
 * migrating from a previous billing system — invoice number, date,
 * and total are entered by hand exactly as they appeared in the
 * source system (sequential numbering is the admin's responsibility
 * for this path; the renderer's auto-numbering doesn't apply).
 */
interface ImportModalProps { onClose: () => void }
const ImportHistoricalInvoiceModal: React.FC<ImportModalProps> = ({ onClose }) => {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const [customerSearch, setCustomerSearch] = useState('');
  const [customerId, setCustomerId] = useState<number | null>(null);
  const [customerLabel, setCustomerLabel] = useState('');
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [eventName, setEventName] = useState('');
  const [eventDate, setEventDate] = useState('');
  const [issueDate, setIssueDate] = useState(new Date().toISOString().slice(0, 10));
  const [dueDate, setDueDate] = useState('');
  const [totalMajor, setTotalMajor] = useState('');
  const [currency, setCurrency] = useState('CHF');
  const [status, setStatus] = useState<'sent' | 'paid' | 'overdue'>('paid');
  const [paidMajor, setPaidMajor] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const { data: customerOptions } = useQuery({
    queryKey: ['customer-search', customerSearch],
    queryFn: () => customerAdminService.search(customerSearch),
    enabled: customerSearch.length >= 2,
  });

  const canSubmit = customerId && invoiceNumber && issueDate && totalMajor && file && !submitting;

  const onSubmit = async () => {
    if (!canSubmit || !customerId || !file) return;
    setSubmitting(true);
    try {
      await billsService.importHistorical({
        customerAccountId: customerId,
        invoiceNumber,
        eventName: eventName.trim() || undefined,
        eventDate: eventDate || undefined,
        issueDate,
        dueDate: dueDate || undefined,
        totalAmountMinor: Math.round(Number(totalMajor) * 100),
        currency: currency || undefined,
        status,
        paidAmountMinor: status === 'paid' && paidMajor
          ? Math.round(Number(paidMajor) * 100)
          : undefined,
        file,
      });
      toast.success(t('bills.importedToast', 'Invoice imported.'));
      qc.invalidateQueries({ queryKey: ['invoices'] });
      onClose();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || t('bills.importError', 'Import failed'));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50"
      onClick={onClose}>
      <div className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl max-w-2xl w-full max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b border-neutral-200 dark:border-neutral-700">
          <h2 className="text-lg font-semibold">
            {t('bills.importTitle', 'Import historical invoice')}
          </h2>
          <button type="button" onClick={onClose} className="p-1 hover:bg-neutral-100 dark:hover:bg-neutral-800 rounded">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-xs text-neutral-500">
            {t('bills.importHelp',
              'Attach a PDF from a previous billing system. The customer sees this original document in their portal — picpeak does not regenerate it.')}
          </p>

          {/* Customer picker */}
          <div>
            <label className="block text-sm font-medium mb-1">
              {t('bills.field.customer', 'Customer')}
            </label>
            {customerId ? (
              <div className="flex items-center gap-2 text-sm">
                <span className="px-2 py-1 rounded bg-neutral-100 dark:bg-neutral-800">{customerLabel}</span>
                <button type="button" onClick={() => { setCustomerId(null); setCustomerLabel(''); }}
                  className="text-xs text-neutral-500 hover:underline">
                  {t('common.change', 'Change')}
                </button>
              </div>
            ) : (
              <>
                <Input placeholder={t('bills.customerSearch', 'Search by email or company…') as string}
                  value={customerSearch}
                  onChange={(e) => setCustomerSearch(e.target.value)} />
                {customerSearch.length >= 2 && customerOptions && (
                  <ul className="mt-1 max-h-40 overflow-y-auto border border-neutral-200 dark:border-neutral-700 rounded">
                    {(customerOptions as any[]).map((c) => (
                      <li key={c.id}>
                        <button type="button"
                          onClick={() => {
                            setCustomerId(c.id);
                            setCustomerLabel(c.companyName || c.displayName || c.email);
                          }}
                          className="w-full text-left px-3 py-1.5 text-sm hover:bg-neutral-100 dark:hover:bg-neutral-800">
                          {c.companyName || c.displayName || c.email}
                          <span className="text-xs text-neutral-500 ml-2">{c.email}</span>
                        </button>
                      </li>
                    ))}
                    {(customerOptions as any[]).length === 0 && (
                      <li className="px-3 py-2 text-xs text-neutral-500">{t('bills.noMatch', 'No matches')}</li>
                    )}
                  </ul>
                )}
              </>
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="md:col-span-2">
              <Input label={t('bills.field.eventName', 'Event / occasion (optional)') as string}
                value={eventName}
                placeholder={t('bills.field.eventNamePlaceholder', 'e.g. Smith wedding 2024') as string}
                onChange={(e) => setEventName(e.target.value)} />
            </div>
            <LocalizedDateInput
              label={t('bills.field.eventDate', 'Event date (optional)') as string}
              value={eventDate}
              onChange={setEventDate}
            />
            <Input label={t('bills.field.invoiceNumber', 'Invoice number') as string}
              value={invoiceNumber}
              placeholder="R-2024-0001"
              onChange={(e) => setInvoiceNumber(e.target.value)} />
            <Input label={t('bills.field.currency', 'Currency') as string}
              value={currency}
              maxLength={3}
              onChange={(e) => setCurrency(e.target.value.toUpperCase())} />
            <LocalizedDateInput
              label={t('bills.field.issueDate', 'Issued') as string}
              value={issueDate}
              onChange={setIssueDate}
            />
            <LocalizedDateInput
              label={t('bills.field.dueDate', 'Due') as string}
              value={dueDate}
              onChange={setDueDate}
            />
            <Input type="number" step="0.01" min="0"
              label={t('bills.field.total', 'Total') as string}
              value={totalMajor}
              placeholder="543.00"
              onChange={(e) => setTotalMajor(e.target.value)} />
            <div>
              <label className="block text-sm font-medium mb-1">{t('bills.field.status', 'Status')}</label>
              <select value={status}
                onChange={(e) => setStatus(e.target.value as any)}
                className="w-full px-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm">
                <option value="paid">{t('bills.status.paid', 'Paid')}</option>
                <option value="sent">{t('bills.status.sent', 'Sent')}</option>
                <option value="overdue">{t('bills.status.overdue', 'Overdue')}</option>
              </select>
            </div>
            {status === 'paid' && (
              <Input type="number" step="0.01" min="0"
                label={t('bills.field.paidAmount', 'Paid amount (optional)') as string}
                value={paidMajor}
                placeholder={totalMajor || '0.00'}
                onChange={(e) => setPaidMajor(e.target.value)} />
            )}
          </div>

          {/* PDF picker */}
          <div>
            <label className="block text-sm font-medium mb-1">
              {t('bills.field.pdfFile', 'PDF file')}
            </label>
            <input
              type="file"
              accept="application/pdf"
              onChange={(e) => setFile(e.target.files?.[0] || null)}
              className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-primary-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-primary-700"
            />
            {file && (
              <p className="text-xs text-neutral-500 mt-1">{file.name} · {(file.size / 1024).toFixed(1)} KB</p>
            )}
          </div>
        </div>
        <div className="flex justify-end gap-2 px-5 py-4 border-t border-neutral-200 dark:border-neutral-700">
          <Button variant="outline" onClick={onClose} disabled={submitting}>
            {t('common.cancel', 'Cancel')}
          </Button>
          <Button onClick={onSubmit} disabled={!canSubmit}>
            <Upload className="w-4 h-4 mr-1" />
            {submitting ? t('bills.importing', 'Importing…') : t('bills.import', 'Import')}
          </Button>
        </div>
      </div>
    </div>
  );
};
