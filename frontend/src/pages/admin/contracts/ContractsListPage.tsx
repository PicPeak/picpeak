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
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Plus, Search, BookOpen } from 'lucide-react';
import { Button, Card, Loading, SortableHeader, useColumnSort, type SortColumnMap } from '../../../components/common';
import {
  contractsService,
  type ContractStatus,
  type ContractSort,
} from '../../../services/contracts.service';
import { useLocalizedDate } from '../../../hooks/useLocalizedDate';

const STATUSES: ContractStatus[] = [
  'draft', 'sent', 'signed_by_customer', 'signed_by_admin', 'fully_signed', 'cancelled',
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
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<ContractStatus[]>([]);
  const { sort, activeKey, activeDir, toggle } = useColumnSort<ContractSort>(SORT_COLUMNS, 'issue_desc');
  const [page, setPage] = useState(1);

  const onSort = (key: string) => { toggle(key); setPage(1); };

  const { data, isLoading } = useQuery({
    queryKey: ['contracts', { search, statusFilter, sort, page }],
    queryFn: () => contractsService.list({
      q: search || undefined,
      status: statusFilter.length ? statusFilter : undefined,
      sort, page, pageSize: 25,
    }),
  });

  const toggleStatus = (s: ContractStatus) => {
    setStatusFilter((prev) => prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]);
    setPage(1);
  };

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div className="container py-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{t('contracts.title', 'Contracts')}</h1>
            {/* Beta badge — matches Customers + Quotes + Invoices. */}
            <span
              className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
              title="Beta — feature is functional but still evolving"
            >
              {t('navigation.betaTag', 'Beta')}
            </span>
          </div>
          <p className="text-sm text-neutral-500 dark:text-neutral-400 mt-1">
            {t('contracts.subtitle', 'Compose contracts from reusable blocks and have customers sign in-browser or upload a wet-signed PDF.')}
          </p>
        </div>
        <div className="flex gap-2">
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
        </div>
      </div>

      <Card padding="lg">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative flex-1 min-w-[200px]">
            <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" />
            <input
              type="text"
              placeholder={t('contracts.list.searchPlaceholder', 'Search by number, title or customer…') as string}
              className="w-full pl-9 pr-3 py-2 rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 text-sm"
              value={search}
              onChange={(e) => { setSearch(e.target.value); setPage(1); }}
            />
          </div>
        </div>

        <div className="mt-3 flex flex-wrap gap-1">
          {STATUSES.map((s) => {
            const active = statusFilter.includes(s);
            return (
              <button key={s} type="button" onClick={() => toggleStatus(s)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  active
                    ? 'bg-accent-dark text-white border-accent-dark'
                    : 'bg-white dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300 border-neutral-300 dark:border-neutral-600'
                }`}
              >{t(`contracts.status.${s}`, s)}</button>
            );
          })}
        </div>

        {/* Body of the same card — table or empty state. Matches the
            single-card layout used by Customers / Quotes / Invoices. */}
        <div className="mt-4">
          {isLoading ? <Loading /> : !data || data.contracts.length === 0 ? (
            <p className="text-center text-neutral-500 dark:text-neutral-400 py-8">{t('contracts.list.empty', 'No contracts yet.')}</p>
          ) : (
            <div className="rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-neutral-50 dark:bg-neutral-800 text-neutral-700 dark:text-neutral-300">
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
                        className="border-t border-neutral-200 dark:border-neutral-700 cursor-pointer hover:bg-neutral-50 dark:hover:bg-neutral-800"
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
                            c.status === 'fully_signed' ? 'bg-green-100 text-green-800'
                              : c.status === 'signed_by_customer' || c.status === 'signed_by_admin' ? 'bg-blue-100 text-blue-800'
                              : c.status === 'sent' ? 'bg-amber-100 text-amber-800'
                              : c.status === 'cancelled' ? 'bg-neutral-200 text-neutral-600'
                              : 'bg-neutral-100 text-neutral-700'
                          }`}>{t(`contracts.status.${c.status}`, c.status)}</span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {totalPages > 1 && (
                <div className="flex justify-between items-center px-3 py-2 border-t border-neutral-200 dark:border-neutral-700 text-sm">
                  <span className="text-neutral-500 dark:text-neutral-400">
                    {t('contracts.list.pagination', 'Page {{page}} of {{total}} · {{count}} contracts', {
                      page, total: totalPages, count: data.total,
                    })}
                  </span>
                  <div className="flex gap-2">
                    <Button variant="outline" size="sm" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                      {t('common.previous', 'Previous')}
                    </Button>
                    <Button variant="outline" size="sm" disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}>
                      {t('common.next', 'Next')}
                    </Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};
