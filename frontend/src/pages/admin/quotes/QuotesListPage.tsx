/**
 * Quotes list page. Filters by status / customer / search; sortable by
 * date / customer / value; paginated.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { FileText, Layers, Plus } from 'lucide-react';
import { TemplatePickerModal } from '../../../components/admin/quotes/TemplatePickerModal';
import { quotesService, type QuoteStatus, type QuoteSort } from '../../../services/quotes.service';
import { Button, Card, Loading, SortableHeader, type SortColumnMap } from '../../../components/common';
import { ListSearch, Pager, StatusChips, useDocumentListState } from '../../../components/admin/DocumentListControls';
import { formatMoneyMinor } from '../../../utils/money';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { PermissionGate } from '../../../components/admin/PermissionGate';
import { SectionPageHeader } from '../../../components/admin/SectionPageHeader';

const STATUSES: QuoteStatus[] = ['draft', 'sent', 'accepted', 'declined', 'expired', 'converted'];

// "#" sorts by creation order (newest/oldest); "Issued" sorts by the
// admin-controlled issue_date, which can drift from chronology.
const SORT_COLUMNS: SortColumnMap = {
  number: { asc: 'oldest', desc: 'newest', defaultDir: 'desc' },
  customer: { asc: 'customer_asc', desc: 'customer_desc' },
  issue: { asc: 'issue_asc', desc: 'issue_desc', defaultDir: 'desc' },
  value: { asc: 'value_asc', desc: 'value_desc', defaultDir: 'desc' },
};

export const QuotesListPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [pickerOpen, setPickerOpen] = useState(false);
  const { format: fmtDate } = useLocalizedDate();
  const {
    search, setSearch, statusFilter, toggleStatus, sort, activeKey, activeDir, onSort, page, setPage,
  } = useDocumentListState<QuoteStatus, QuoteSort>(SORT_COLUMNS, 'issue_desc');

  const { data, isLoading } = useQuery({
    queryKey: ['quotes', { search, statusFilter, sort, page }],
    queryFn: () => quotesService.list({
      q: search || undefined,
      status: statusFilter.length ? statusFilter : undefined,
      sort, page, pageSize: 25,
    }),
  });

  return (
    <div>
      <SectionPageHeader
        icon={FileText}
        title={t('quotes.title', 'Quotes')}
        feature="quotes"
        description={t('quotes.subtitle', 'Send, track and convert quotes into events.')}
        actions={(
          <>
            <Link to="/admin/clients/quotes/catalog">
              <Button variant="outline"><Layers className="w-4 h-4 mr-1" />{t('quotes.catalog.title', 'Catalogue & templates')}</Button>
            </Link>
            <PermissionGate permission="quotes.manage">
              <Button onClick={() => setPickerOpen(true)}><Plus className="w-4 h-4 mr-1" />{t('quotes.new', 'New quote')}</Button>
            </PermissionGate>
          </>
        )}
      />
      <TemplatePickerModal open={pickerOpen} onClose={() => setPickerOpen(false)} />

      <Card padding="lg">
        <ListSearch
          value={search}
          onChange={setSearch}
          placeholder={t('quotes.searchPlaceholder', 'Search by number, customer, event…') as string}
        />
        <StatusChips statuses={STATUSES} active={statusFilter} onToggle={toggleStatus} labelPrefix="quotes.status" />

        {/* Body of the same card — table or empty state. Matches the
            single-card layout used by Customers/Invitations. */}
        <div className="mt-4">
          {isLoading ? <Loading /> : !data || data.quotes.length === 0 ? (
            <p className="text-center text-muted py-8">{t('quotes.empty', 'No quotes yet.')}</p>
          ) : (
            <div className="rounded-lg border border-line overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-subtle text-body">
                    <tr>
                      <SortableHeader label="#" columnKey="number" activeKey={activeKey} activeDir={activeDir} onSort={onSort} />
                      <SortableHeader label={t('quotes.table.customer', 'Customer')} columnKey="customer" activeKey={activeKey} activeDir={activeDir} onSort={onSort} />
                      <th className="px-3 py-2 text-left">{t('quotes.table.event', 'Event')}</th>
                      <SortableHeader label={t('quotes.table.issueDate', 'Issued')} columnKey="issue" activeKey={activeKey} activeDir={activeDir} onSort={onSort} />
                      <SortableHeader label={t('quotes.table.total', 'Total')} columnKey="value" activeKey={activeKey} activeDir={activeDir} onSort={onSort} align="right" />
                      <th className="px-3 py-2 text-left">{t('quotes.table.status', 'Status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.quotes.map((q) => (
                      <tr key={q.id}
                        className="border-t border-line cursor-pointer hover:bg-hover-soft"
                        onClick={() => navigate(`/admin/clients/quotes/${q.id}`)}
                      >
                        <td className="px-3 py-2 font-mono text-xs">{q.quoteNumber}</td>
                        <td className="px-3 py-2">{q.customer.companyName || q.customer.displayName || q.customer.email}</td>
                        <td className="px-3 py-2 truncate max-w-xs">{q.eventName || '—'}</td>
                        <td className="px-3 py-2">{fmtDate(q.issueDate)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">
                          {formatMoneyMinor(Number(q.totalAmountMinor), q.currency)}
                        </td>
                        <td className="px-3 py-2">
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            q.status === 'accepted' || q.status === 'converted' ? 'bg-success-soft text-success-text'
                              : q.status === 'declined' ? 'bg-danger-soft text-danger-text'
                              : q.status === 'sent' ? 'bg-info-soft text-info-text'
                              : 'bg-inset text-body'
                          }`}>{t(`quotes.status.${q.status}`, q.status)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager
                page={page}
                totalPages={data.pagination.totalPages}
                onPageChange={setPage}
                label={t('quotes.pagination', 'Page {{page}} of {{total}} · {{count}} quotes', {
                  page: data.pagination.page, total: data.pagination.totalPages, count: data.pagination.total,
                })}
              />
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};
