/**
 * Admin → Contracts list page.
 *
 * Lists every contract (filterable by status + customer + search) with
 * a "New contract" button and a "Block library" shortcut. Visual
 * shape mirrors BillsListPage / QuotesListPage so the three lists
 * under /admin/clients feel like one product — same container wrapper,
 * same h1 + BETA badge, same Button component for actions, same table
 * head + row-hover + click-row-to-open behaviour. Contract-specific
 * columns (Number, Customer, Title, Issued, Status) and the per-status
 * badge palette are preserved.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ScrollText, Plus, BookOpen } from 'lucide-react';
import { Button, Card, Loading, SortableHeader, type SortColumnMap } from '../../../components/common';
import { ListSearch, Pager, StatusChips, useDocumentListState } from '../../../components/admin/DocumentListControls';
import {
  contractsService,
  type ContractStatus,
  type ContractSort,
} from '../../../services/contracts.service';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';
import { contractStatusLabel } from '../../../utils/contractStatus';
import { SectionPageHeader } from '../../../components/admin/SectionPageHeader';

const STATUSES: ContractStatus[] = [
  'draft', 'sent', 'signed_by_customer', 'signed_by_admin', 'fully_signed', 'declined', 'cancelled', 'expired', 'awaiting_data',
];

// "Number" sorts by creation order (newest/oldest); "Issued" sorts by
// the admin-controlled issue_date, which can drift from chronology.
const SORT_COLUMNS: SortColumnMap = {
  number: { asc: 'oldest', desc: 'newest', defaultDir: 'desc' },
  customer: { asc: 'customer_asc', desc: 'customer_desc' },
  issue: { asc: 'issue_asc', desc: 'issue_desc', defaultDir: 'desc' },
};

export const ContractsListPage: React.FC = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { format } = useLocalizedDate();
  const {
    search, setSearch, statusFilter, toggleStatus, sort, activeKey, activeDir, onSort, page, setPage,
  } = useDocumentListState<ContractStatus, ContractSort>(SORT_COLUMNS, 'issue_desc');

  const { data, isLoading } = useQuery({
    queryKey: ['contracts', { search, statusFilter, sort, page }],
    queryFn: () => contractsService.list({
      q: search || undefined,
      status: statusFilter.length ? statusFilter : undefined,
      sort, page, pageSize: 25,
    }),
  });

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div>
      <SectionPageHeader
        icon={ScrollText}
        title={t('contracts.title', 'Contracts')}
        feature="contracts"
        description={t('contracts.subtitle', 'Compose contracts from reusable blocks and have customers sign in-browser or upload a wet-signed PDF.')}
        actions={(
          <>
            <Link to="/admin/clients/contracts/templates">
              <Button variant="outline">{t('contracts.list.templates', 'Templates')}</Button>
            </Link>
            <Link to="/admin/clients/contracts/attachments">
              <Button variant="outline">{t('contracts.list.attachments', 'Attachments')}</Button>
            </Link>
            <Link to="/admin/clients/contracts/blocks">
              <Button variant="outline">
                <BookOpen className="w-4 h-4 mr-1" />
                {t('contracts.list.blocksLibrary', 'Block library')}
              </Button>
            </Link>
            <Link to="/admin/clients/contracts/new">
              <Button>
                <Plus className="w-4 h-4 mr-1" />
                {t('contracts.list.new', 'New contract')}
              </Button>
            </Link>
          </>
        )}
      />

      <Card padding="lg">
        <ListSearch
          value={search}
          onChange={setSearch}
          placeholder={t('contracts.list.searchPlaceholder', 'Search by number, title or customer…') as string}
        />

        <StatusChips statuses={STATUSES} active={statusFilter} onToggle={toggleStatus} labelPrefix="contracts.status" />

        {/* Body of the same card — table or empty state. Matches the
            single-card layout used by Customers / Quotes / Invoices. */}
        <div className="mt-4">
          {isLoading ? <Loading /> : !data || data.contracts.length === 0 ? (
            <p className="text-center text-muted py-8">{t('contracts.list.empty', 'No contracts yet.')}</p>
          ) : (
            <div className="rounded-lg border border-line overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-subtle text-body">
                    <tr>
                      <SortableHeader label={t('contracts.list.table.number', 'Number')} columnKey="number" activeKey={activeKey} activeDir={activeDir} onSort={onSort} />
                      <SortableHeader label={t('contracts.list.table.customer', 'Customer')} columnKey="customer" activeKey={activeKey} activeDir={activeDir} onSort={onSort} />
                      <th className="px-3 py-2 text-left">{t('contracts.list.table.title', 'Title')}</th>
                      <SortableHeader label={t('contracts.list.table.issueDate', 'Issued')} columnKey="issue" activeKey={activeKey} activeDir={activeDir} onSort={onSort} />
                      <th className="px-3 py-2 text-left">{t('contracts.list.table.status', 'Status')}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.contracts.map((c) => (
                      <tr key={c.id}
                        className="border-t border-line cursor-pointer hover:bg-hover-soft"
                        onClick={() => navigate(`/admin/clients/contracts/${c.id}`)}
                      >
                        <td className="px-3 py-2 font-mono text-xs">{c.contractNumber}</td>
                        <td className="px-3 py-2">
                          {c.customer.companyName
                            || [c.customer.firstName, c.customer.lastName].filter(Boolean).join(' ')
                            || c.customer.displayName
                            || c.customer.email
                            || '—'}
                        </td>
                        <td className="px-3 py-2 truncate max-w-xs">{c.title || '—'}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{c.issueDate ? format(c.issueDate) : '—'}</td>
                        <td className="px-3 py-2">
                          {/* Per-status palette preserved — green for the
                              terminal "fully_signed", blue for either-side
                              signed, amber for sent (awaiting customer),
                              grey for cancelled, neutral for draft. */}
                          <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                            c.status === 'fully_signed' ? 'bg-success-soft text-success-text'
                              : c.status === 'signed_by_customer' || c.status === 'signed_by_admin' ? 'bg-info-soft text-info-text'
                              : c.status === 'sent' || c.status === 'awaiting_data' ? 'bg-warning-soft text-warning-text'
                              : c.status === 'declined' ? 'bg-danger-soft text-danger-text'
                              : c.status === 'cancelled' || c.status === 'expired' ? 'bg-fill text-soft'
                              : 'bg-inset text-body'
                          }`}>{contractStatusLabel(t, c.status, c.signerProgress)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager
                page={page}
                totalPages={totalPages}
                onPageChange={setPage}
                label={t('contracts.list.pagination', 'Page {{page}} of {{total}} · {{count}} contracts', {
                  page, total: totalPages, count: data.total,
                })}
              />
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};
