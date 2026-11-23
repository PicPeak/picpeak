/**
 * Customer-side Quotes list. Read-only view of every quote the
 * photographer has sent this customer. Quotes still in the
 * accept/decline window link to the portal response page, which answers
 * through the portal session, so the portal never handles the emailed
 * response token.
 *
 * Adds client-side sort + status filter controls (newest, oldest,
 * price ↑/↓; status: all / sent / accepted / declined / expired /
 * converted). All client-side because the API doesn't paginate.
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { FileText, ExternalLink, Download } from 'lucide-react';
import { customerService, type CustomerQuote } from '../../services/customer.service';
import { Card, EmptyState, Loading } from '../../components/common';
import { toast } from 'react-toastify';
import { formatMoneyMinor } from '../../utils/money';
import { formatShortDate } from '../../utils/dateShort';
import { FilterSortBar, PortalLoadError, sortPortalRows, type SortKey } from './PortalListControls';

type StatusFilter = 'all' | 'sent' | 'accepted' | 'declined' | 'expired' | 'converted';

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
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
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
    return sortPortalRows(filtered, sort);
  }, [data, sort, statusFilter]);

  if (isLoading) return <Loading />;
  if (isError) {
    return (
      <PortalLoadError
        error={error}
        title={t('customer.quotes.title', 'Quotes')}
        disabledText={t('customer.quotes.disabled',
          'This feature is currently disabled for your account. Please contact your photographer if you expected to see quotes here.')}
        loadErrorTitle={t('customer.quotes.loadError', 'Could not load quotes.')}
        onRetry={() => { void refetch(); }}
        retrying={isFetching}
      />
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
          <EmptyState size="inline" title={t('customer.quotes.empty', 'No quotes yet.')} />
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
            <ul className="divide-y divide-border-token">
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

const QuoteRow: React.FC<{ q: CustomerQuote }> = ({ q }) => {
  const { t } = useTranslation();
  // The server decides whether the quote is still actionable; the response
  // page is the portal's own route, answered through the portal session.
  const canRespond = q.canRespond;
  const linkHref = canRespond ? `/customer/quotes/${q.id}/respond` : null;

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
    q.status === 'accepted' || q.status === 'converted' ? 'status-chip hue-success'
      : q.status === 'declined' ? 'status-chip hue-danger'
        : q.status === 'sent' ? 'status-chip hue-info'
          : 'status-chip hue-neutral';

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
          {formatMoneyMinor(Number(q.totalAmountMinor), q.currency)}
        </div>
        <div className="mt-1 flex items-center justify-end gap-3 text-xs">
          <button type="button" onClick={handleDownloadPdf}
            className="text-accent inline-flex items-center gap-1 hover:underline">
            <Download className="w-3 h-3" />
            {t('customer.quotes.viewPdf', 'View PDF')}
          </button>
          {canRespond && linkHref && (
            <span className="text-accent inline-flex items-center gap-1">
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
        <Link to={linkHref} className="block hover-surface">
          {body}
        </Link>
      ) : body}
    </li>
  );
};

export default CustomerQuotesPage;
