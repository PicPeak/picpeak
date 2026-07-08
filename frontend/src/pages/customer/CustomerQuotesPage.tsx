/**
 * Customer-side Quotes list. Read-only view of every quote the
 * photographer has sent this customer. Open links straight back to
 * the public quote response page when the quote is still in the
 * accept/decline window — saves the customer from digging through
 * email to find the original link.
 *
 * Adds client-side sort + status filter controls (newest, oldest,
 * price ↑/↓; status: all / sent / accepted / declined / expired /
 * converted). All client-side because the API doesn't paginate.
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { FileText, ExternalLink, Download } from 'lucide-react';
import { customerService, type CustomerQuote } from '../../services/customer.service';
import { Card, Loading } from '../../components/common';
import { toast } from 'react-toastify';
import { formatMoney } from '../../utils/money';
import { formatShortDate } from '../../utils/dateShort';

type SortKey = 'newest' | 'oldest' | 'price_desc' | 'price_asc';
type StatusFilter = 'all' | 'sent' | 'accepted' | 'declined' | 'expired' | 'converted';

const SORT_OPTIONS: { value: SortKey; key: string; fallback: string }[] = [
  { value: 'newest',     key: 'customer.sort.newest',    fallback: 'Newest first' },
  { value: 'oldest',     key: 'customer.sort.oldest',    fallback: 'Oldest first' },
  { value: 'price_desc', key: 'customer.sort.priceDesc', fallback: 'Price (high to low)' },
  { value: 'price_asc',  key: 'customer.sort.priceAsc',  fallback: 'Price (low to high)' },
];
const STATUS_OPTIONS: { value: StatusFilter; key: string; fallback: string }[] = [
  { value: 'all',       key: 'customer.filter.all',       fallback: 'All' },
  { value: 'sent',      key: 'quotes.status.sent',        fallback: 'Open / sent' },
  { value: 'accepted',  key: 'quotes.status.accepted',    fallback: 'Accepted' },
  { value: 'declined',  key: 'quotes.status.declined',    fallback: 'Declined' },
  { value: 'expired',   key: 'quotes.status.expired',     fallback: 'Expired' },
  { value: 'converted', key: 'quotes.status.converted',   fallback: 'Converted' },
];

export const CustomerQuotesPage: React.FC = () => {
  const { t } = useTranslation();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['customer-quotes'],
    queryFn: () => customerService.listQuotes(),
  });

  const [sort, setSort] = useState<SortKey>('newest');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const visible = useMemo(() => {
    const rows = data || [];
    const filtered = statusFilter === 'all'
      ? rows
      : rows.filter((q) => q.status === statusFilter);
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
          <h1 className="text-2xl font-bold mb-2">{t('customer.quotes.title', 'Quotes')}</h1>
          <p className="text-muted-theme">
            {t('customer.quotes.disabled',
              'This feature is currently disabled for your account. Please contact your photographer if you expected to see quotes here.')}
          </p>
        </div>
      );
    }
    return (
      <div className="container py-8">
        <p className="text-red-600">{t('customer.quotes.loadError', 'Could not load quotes.')}</p>
      </div>
    );
  }
  const allQuotes = data || [];

  return (
    <div className="container py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-theme flex items-center gap-2">
          <FileText className="w-6 h-6" />
          {t('customer.quotes.title', 'Quotes')}
        </h1>
        <p className="text-sm text-muted-theme mt-1">
          {t('customer.quotes.subtitle',
            'Every quote your photographer has sent you. Click an open quote to accept or decline.')}
        </p>
      </div>

      {allQuotes.length === 0 ? (
        <Card padding="lg">
          <p className="text-center text-muted-theme py-8">
            {t('customer.quotes.empty', 'No quotes yet.')}
          </p>
        </Card>
      ) : (
        <>
          <FilterSortBar
            sort={sort} onSortChange={setSort}
            statusFilter={statusFilter} onStatusChange={setStatusFilter}
            statusOptions={STATUS_OPTIONS}
            totalRowCount={allQuotes.length}
            visibleRowCount={visible.length}
          />
          <Card padding="none">
            <ul className="divide-y" style={{ borderColor: 'var(--color-surface-border)' }}>
              {visible.map((q: CustomerQuote) => (
                <QuoteRow key={q.id} q={q} />
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

const QuoteRow: React.FC<{ q: CustomerQuote }> = ({ q }) => {
  const { t } = useTranslation();
  // Open the public response page when the quote is still actionable.
  // Once locked (responded_at + 15 min) or converted/expired the page
  // becomes a read-only view of the locked state.
  const canRespond = q.status === 'sent' || (
    !!q.respondedAt && !!q.responseLockedAt && new Date(q.responseLockedAt).getTime() > Date.now()
  );
  const linkHref = q.responseToken ? `/quote/${q.responseToken}` : null;

  const handleDownloadPdf = async (e: React.MouseEvent) => {
    // Don't bubble to the row-wide link wrapper.
    e.preventDefault();
    e.stopPropagation();
    // Sync-open the window so the popup blocker treats this as a
    // user gesture (same trick as the Bills page).
    const win = window.open('about:blank', '_blank');
    if (!win) {
      toast.error(t('customer.quotes.popupBlocked', 'Allow pop-ups for this site to view the quote PDF.'));
      return;
    }
    try {
      const url = await customerService.quotePdfUrl(q.id);
      win.location.href = url;
    } catch (err: any) {
      win.close();
      toast.error(err?.response?.data?.error || err.message || 'Failed to load quote PDF');
    }
  };

  const statusClass =
    q.status === 'accepted' || q.status === 'converted' ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300'
      : q.status === 'declined' ? 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300'
        : q.status === 'sent' ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300'
          : 'bg-neutral-100 text-neutral-700 dark:bg-neutral-700 dark:text-neutral-300';

  const body = (
    <div className="flex items-center justify-between gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-sm">{q.quoteNumber}</span>
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusClass}`}>
            {t(`quotes.status.${q.status}`, q.status)}
          </span>
        </div>
        <div className="text-sm text-muted-theme mt-1 truncate">
          {q.eventName || t('customer.quotes.noEventName', '—')}
          {q.eventDate ? ` · ${formatShortDate(q.eventDate)}` : ''}
          {q.validUntil && canRespond ? ` · ${t('quoteResponse.validUntil', 'valid until')} ${formatShortDate(q.validUntil)}` : ''}
        </div>
      </div>
      <div className="text-right">
        <div className="font-medium tabular-nums">
          {formatMoney(Number(q.totalAmountMinor) / 100, q.currency)}
        </div>
        <div className="mt-1 flex items-center justify-end gap-3 text-xs">
          <button type="button" onClick={handleDownloadPdf}
            className="text-primary-600 dark:text-primary-400 inline-flex items-center gap-1 hover:underline">
            <Download className="w-3 h-3" />
            {t('customer.quotes.viewPdf', 'View PDF')}
          </button>
          {canRespond && linkHref && (
            <span className="text-primary-600 dark:text-primary-400 inline-flex items-center gap-1">
              {t('customer.quotes.openToRespond', 'Open to respond')}
              <ExternalLink className="w-3 h-3" />
            </span>
          )}
        </div>
      </div>
    </div>
  );

  return (
    <li>
      {linkHref ? (
        <a href={linkHref} target={canRespond ? '_blank' : '_self'} rel="noopener noreferrer"
          className="block hover:bg-neutral-50 dark:hover:bg-neutral-800">
          {body}
        </a>
      ) : body}
    </li>
  );
};

export default CustomerQuotesPage;
