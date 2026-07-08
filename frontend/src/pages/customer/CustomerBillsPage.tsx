/**
 * Customer-side Invoices list. Read-only view of every invoice that
 * has been sent (or is overdue / paid). Scheduled drafts and
 * cancelled invoices are hidden server-side so the customer never
 * sees admin's in-progress work.
 *
 * Each row exposes a "View PDF" link that opens the rendered invoice
 * in a new tab via a popup-blocker-safe sync window.open.
 *
 * Adds client-side sort + status filter controls (newest, oldest,
 * price ↑/↓; status: all / sent / paid / overdue / outstanding).
 * "outstanding" rolls up everything still owing (sent + overdue).
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Receipt, Download } from 'lucide-react';
import { customerService, type CustomerInvoice } from '../../services/customer.service';
import { Card, Loading } from '../../components/common';
import { toast } from 'react-toastify';
import { formatMoney } from '../../utils/money';
import { formatShortDate } from '../../utils/dateShort';

type SortKey = 'newest' | 'oldest' | 'price_desc' | 'price_asc';
type StatusFilter = 'all' | 'sent' | 'paid' | 'overdue' | 'outstanding';

const SORT_OPTIONS: { value: SortKey; key: string; fallback: string }[] = [
  { value: 'newest',     key: 'customer.sort.newest',    fallback: 'Newest first' },
  { value: 'oldest',     key: 'customer.sort.oldest',    fallback: 'Oldest first' },
  { value: 'price_desc', key: 'customer.sort.priceDesc', fallback: 'Price (high to low)' },
  { value: 'price_asc',  key: 'customer.sort.priceAsc',  fallback: 'Price (low to high)' },
];
const STATUS_OPTIONS: { value: StatusFilter; key: string; fallback: string }[] = [
  { value: 'all',         key: 'customer.filter.all',           fallback: 'All' },
  { value: 'sent',        key: 'bills.status.sent',             fallback: 'Open / sent' },
  { value: 'paid',        key: 'bills.status.paid',             fallback: 'Paid' },
  { value: 'overdue',     key: 'bills.status.overdue',          fallback: 'Overdue' },
  { value: 'outstanding', key: 'customer.bills.filter.outstanding', fallback: 'Outstanding (sent + overdue)' },
];

export const CustomerBillsPage: React.FC = () => {
  const { t } = useTranslation();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['customer-invoices'],
    queryFn: () => customerService.listInvoices(),
  });

  const [sort, setSort] = useState<SortKey>('newest');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const visible = useMemo(() => {
    const rows = data || [];
    const filtered = rows.filter((inv) => {
      if (statusFilter === 'all') return true;
      if (statusFilter === 'outstanding') {
        return inv.status === 'sent' || inv.status === 'overdue';
      }
      return inv.status === statusFilter;
    });
    const sorted = [...filtered].sort((a, b) => {
      switch (sort) {
      case 'oldest':
        return new Date(a.issueDate).getTime() - new Date(b.issueDate).getTime();
      case 'price_desc':
        return Number(b.totalAmountMinor || 0) - Number(a.totalAmountMinor || 0);
      case 'price_asc':
        return Number(a.totalAmountMinor || 0) - Number(b.totalAmountMinor || 0);
      case 'newest':
      default:
        return new Date(b.issueDate).getTime() - new Date(a.issueDate).getTime();
      }
    });
    return sorted;
  }, [data, sort, statusFilter]);

  if (isLoading) return <Loading />;
  if (isError) {
    const status = (error as any)?.response?.status;
    if (status === 403) {
      return (
        <div className="container py-8">
          <h1 className="text-2xl font-bold mb-2">{t('customer.bills.title', 'Invoices')}</h1>
          <p className="text-muted-theme">
            {t('customer.bills.disabled',
              'This feature is currently disabled for your account. Please contact your photographer if you expected to see invoices here.')}
          </p>
        </div>
      );
    }
    return (
      <div className="container py-8">
        <p className="text-red-600">{t('customer.bills.loadError', 'Could not load invoices.')}</p>
      </div>
    );
  }
  const invoices = data || [];

  const handleViewPdf = async (inv: CustomerInvoice) => {
    // Sync-open the window so the popup blocker treats this as a
    // user gesture, then redirect to the blob URL once it's ready.
    const win = window.open('about:blank', '_blank');
    if (!win) {
      toast.error(t('customer.bills.popupBlocked', 'Allow pop-ups for this site to view the invoice PDF.'));
      return;
    }
    try {
      const url = await customerService.invoicePdfUrl(inv.id);
      win.location.href = url;
    } catch (err: any) {
      win.close();
      toast.error(err?.response?.data?.error || err.message || 'Failed to load invoice PDF');
    }
  };

  return (
    <div className="container py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-theme flex items-center gap-2">
          <Receipt className="w-6 h-6" />
          {t('customer.bills.title', 'Invoices')}
        </h1>
        <p className="text-sm text-muted-theme mt-1">
          {t('customer.bills.subtitle',
            'Every invoice your photographer has sent you. Click "View PDF" to download.')}
        </p>
      </div>

      {invoices.length === 0 ? (
        <Card padding="lg">
          <p className="text-center text-muted-theme py-8">
            {t('customer.bills.empty', 'No invoices yet.')}
          </p>
        </Card>
      ) : (
        <>
          <FilterSortBar
            sort={sort} onSortChange={setSort}
            statusFilter={statusFilter} onStatusChange={setStatusFilter}
            statusOptions={STATUS_OPTIONS}
            totalRowCount={invoices.length}
            visibleRowCount={visible.length}
          />
          <Card padding="none">
            <ul className="divide-y" style={{ borderColor: 'var(--color-surface-border)' }}>
              {visible.map((inv) => (
                <InvoiceRow key={inv.id} inv={inv} onViewPdf={() => handleViewPdf(inv)} />
              ))}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
};

interface FilterSortBarProps<S extends string> {
  sort: SortKey;
  onSortChange: (v: SortKey) => void;
  statusFilter: S;
  onStatusChange: (v: S) => void;
  statusOptions: { value: S; key: string; fallback: string }[];
  totalRowCount: number;
  visibleRowCount: number;
}
function FilterSortBar<S extends string>({
  sort, onSortChange, statusFilter, onStatusChange, statusOptions,
  totalRowCount, visibleRowCount,
}: FilterSortBarProps<S>) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
      <div className="flex flex-wrap items-center gap-2">
        <label className="text-xs text-muted-theme uppercase tracking-wider">
          {t('customer.filter.label', 'Filter')}
        </label>
        <select
          value={statusFilter}
          onChange={(e) => onStatusChange(e.target.value as S)}
          className="text-sm px-2 py-1 rounded border"
          style={{
            backgroundColor: 'var(--color-surface)',
            borderColor: 'var(--color-surface-border)',
            color: 'var(--color-text)',
          }}
        >
          {statusOptions.map((o) => (
            <option key={o.value} value={o.value}>{t(o.key, o.fallback)}</option>
          ))}
        </select>
        <label className="text-xs text-muted-theme uppercase tracking-wider ml-2">
          {t('customer.sort.label', 'Sort')}
        </label>
        <select
          value={sort}
          onChange={(e) => onSortChange(e.target.value as SortKey)}
          className="text-sm px-2 py-1 rounded border"
          style={{
            backgroundColor: 'var(--color-surface)',
            borderColor: 'var(--color-surface-border)',
            color: 'var(--color-text)',
          }}
        >
          {SORT_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>{t(o.key, o.fallback)}</option>
          ))}
        </select>
      </div>
      <div className="text-xs text-muted-theme">
        {visibleRowCount === totalRowCount
          ? t('customer.filter.countAll', '{{count}} total', { count: totalRowCount })
          : t('customer.filter.countFiltered', '{{visible}} of {{total}}', { visible: visibleRowCount, total: totalRowCount })}
      </div>
    </div>
  );
}

const InvoiceRow: React.FC<{ inv: CustomerInvoice; onViewPdf: () => void }> = ({ inv, onViewPdf }) => {
  const { t } = useTranslation();
  const total = Number(inv.totalAmountMinor || 0) / 100;
  const lateFee = Number(inv.lateFeeAmountMinor || 0) / 100;
  const paid = Number(inv.paidAmountMinor || 0) / 100;
  // Server-side `status` is the source of truth — when it's 'paid',
  // outstanding MUST be 0 regardless of (total - paid). The Skonto
  // path (migration 126) intentionally flips status to 'paid' while
  // paid_amount_minor stays below total_amount_minor by the discount;
  // raw subtraction would otherwise leave the customer reading "you
  // still owe the Skonto amount".
  const isPaid = inv.status === 'paid';
  const outstanding = isPaid ? 0 : Math.max(0, total - paid);

  const isStorno = inv.kind === 'storno';
  const isCancelled = inv.status === 'cancelled';
  // Outstanding hidden for Storni (negative total → meaningless) and
  // cancelled invoices (no longer owed). Total still renders so the
  // customer's bookkeeper can match line totals between the document
  // pair.
  const showOutstanding = !isStorno && !isCancelled && outstanding > 0;

  const statusClass = isStorno
    ? 'bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300'
    : inv.status === 'paid' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
      : inv.status === 'overdue' ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
        : inv.status === 'cancelled' ? 'bg-neutral-200 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-300'
          : 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300';

  // Cancelled invoices and Storni display the absolute total. The
  // row-level totals on Storno rows are stored negative in the DB,
  // but the customer-facing list reads more naturally with the
  // amount and a sign-cue badge alongside ("Cancellation invoice")
  // than with a leading minus on the number itself.
  const displayTotal = Math.abs(total);

  return (
    <li className={`px-4 py-3 ${isStorno || isCancelled ? 'bg-neutral-50/50 dark:bg-neutral-800/30' : ''}`}>
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm">{inv.invoiceNumber}</span>
            <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusClass}`}>
              {isStorno
                ? t('customer.bills.kind.storno', 'Cancellation invoice')
                : t(`bills.status.${inv.status}`, inv.status)}
            </span>
            {inv.installmentTotal > 1 && !isStorno && (
              <span className="text-xs text-muted-theme">
                {inv.installmentIndex + 1}/{inv.installmentTotal}
                {inv.installmentLabel ? ` · ${inv.installmentLabel}` : ''}
              </span>
            )}
          </div>
          {/* Event label (migration 123 snapshot). Mirrors the customer
              quotes view so an invoice for the same event is visually
              grouped at a glance. Omit when no event is set rather than
              rendering a stray em-dash. */}
          {inv.eventName && (
            <div className="text-sm text-muted-theme mt-1 truncate">
              {inv.eventName}
              {inv.eventDate ? ` · ${formatShortDate(inv.eventDate)}` : ''}
            </div>
          )}
          <div className="text-sm text-muted-theme mt-1">
            {t('customer.bills.field.issueDate', 'Issued')}: {formatShortDate(inv.issueDate)}
            {!isStorno && inv.dueDate && (
              <> {' · '} {t('customer.bills.field.dueDate', 'Due')}: {formatShortDate(inv.dueDate)}</>
            )}
            {inv.paidAt && !isStorno && (
              <> {' · '} {t('customer.bills.field.paidAt', 'Paid')}: {formatShortDate(inv.paidAt)}</>
            )}
          </div>
          {/* Lineage hint — the legal pair must be discoverable from
              either end. Storno rows surface the invoice they cancel;
              cancelled invoices surface the Storno that reversed them
              (matching the PDF's reference line so the customer's
              bookkeeper can find both documents). */}
          {isStorno && inv.cancelsInvoiceId && (
            <div className="text-xs text-purple-700 dark:text-purple-300 mt-1">
              {t('customer.bills.cancelsLabel', 'Cancels invoice')}{' '}
              {inv.cancelsInvoiceNumber || `#${inv.cancelsInvoiceId}`}
            </div>
          )}
          {!isStorno && isCancelled && inv.cancellationStornoId && (
            <div className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
              {t('customer.bills.cancelledByLabel', 'Cancelled by cancellation invoice')}{' '}
              {inv.cancellationStornoNumber || `#${inv.cancellationStornoId}`}
            </div>
          )}
        </div>
        <div className="text-right">
          <div className={`font-medium tabular-nums ${isStorno ? 'text-purple-700 dark:text-purple-300' : ''}`}>
            {isStorno ? '-' : ''}{formatMoney(displayTotal, inv.currency)}
          </div>
          {showOutstanding && (
            <div className="text-xs text-red-700 dark:text-red-400 mt-0.5">
              {t('customer.bills.field.outstanding', 'Outstanding')}: {formatMoney(outstanding, inv.currency)}
            </div>
          )}
          {lateFee > 0 && !isStorno && (
            <div className="text-xs text-amber-700 dark:text-amber-400 mt-0.5">
              {t('customer.bills.field.lateFee', 'Late fee')}: {formatMoney(lateFee, inv.currency)}
            </div>
          )}
          <button type="button" onClick={onViewPdf}
            className="text-xs text-primary-600 dark:text-primary-400 mt-1 inline-flex items-center gap-1 hover:underline">
            <Download className="w-3 h-3" />
            {t('customer.bills.viewPdf', 'View PDF')}
          </button>
        </div>
      </div>
    </li>
  );
};

export default CustomerBillsPage;
