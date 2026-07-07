/**
 * Customer-side Contracts list. Read-only view of every contract the
 * photographer has sent. Mirrors CustomerQuotesPage in shape:
 *   - status filter + sort
 *   - "Open & sign" link on `sent` rows (deep-link to the public page)
 *   - "Download PDF" on any non-cancelled row — prefers the signed PDF
 *     when present, otherwise the system-rendered copy
 */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { ScrollText, ExternalLink, Download } from 'lucide-react';
import { customerService, type CustomerContract } from '../../services/customer.service';
import { Card, Loading } from '../../components/common';
import { toast } from 'react-toastify';

import { formatShortDate } from '../../utils/dateShort';

type SortKey = 'newest' | 'oldest';
type StatusFilter =
  | 'all'
  | 'sent'
  | 'signed_by_customer'
  | 'signed_by_admin'
  | 'fully_signed'
  | 'cancelled';

const STATUS_OPTIONS: { value: StatusFilter; key: string; fallback: string }[] = [
  { value: 'all',                 key: 'customer.filter.all',                    fallback: 'All' },
  { value: 'sent',                key: 'contracts.status.sent',                  fallback: 'Awaiting signature' },
  { value: 'signed_by_customer',  key: 'contracts.status.signed_by_customer',   fallback: 'Signed by customer' },
  { value: 'signed_by_admin',     key: 'contracts.status.signed_by_admin',      fallback: 'Counter-signed' },
  { value: 'fully_signed',        key: 'contracts.status.fully_signed',         fallback: 'Fully signed' },
  { value: 'cancelled',           key: 'contracts.status.cancelled',            fallback: 'Cancelled' },
];

export const CustomerContractsPage: React.FC = () => {
  const { t } = useTranslation();
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['customer-contracts'],
    queryFn: () => customerService.listContracts(),
  });

  const [sort, setSort] = useState<SortKey>('newest');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');

  const visible = useMemo(() => {
    const rows = data || [];
    const filtered = statusFilter === 'all' ? rows : rows.filter((c) => c.status === statusFilter);
    return [...filtered].sort((a, b) => {
      const da = new Date(a.issueDate).getTime();
      const db = new Date(b.issueDate).getTime();
      return sort === 'oldest' ? da - db : db - da;
    });
  }, [data, sort, statusFilter]);

  if (isLoading) return <Loading />;
  if (isError) {
    const status = (error as any)?.response?.status;
    if (status === 403) {
      return (
        <div className="container py-8">
          <h1 className="text-2xl font-bold mb-2">{t('customer.contracts.title', 'Contracts')}</h1>
          <p className="text-muted-theme">
            {t('customer.contracts.disabled',
              'This feature is currently disabled for your account.')}
          </p>
        </div>
      );
    }
    return (
      <div className="container py-8">
        <p className="text-red-600">{t('customer.contracts.loadError', 'Could not load contracts.')}</p>
      </div>
    );
  }

  const all = data || [];
  return (
    <div className="container py-6">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-theme flex items-center gap-2">
          <ScrollText className="w-6 h-6" />
          {t('customer.contracts.title', 'Contracts')}
        </h1>
        <p className="text-sm text-muted-theme mt-1">
          {t('customer.contracts.subtitle',
            'Every contract your photographer has sent you. Open the signing link on awaiting-signature contracts, or download the signed PDF once both parties have signed.')}
        </p>
      </div>

      {all.length === 0 ? (
        <Card padding="lg">
          <p className="text-center text-muted-theme py-8">
            {t('customer.contracts.empty', 'No contracts yet.')}
          </p>
        </Card>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-3">
            <div className="flex flex-wrap items-center gap-2">
              <label className="text-xs text-muted-theme uppercase tracking-wider">
                {t('customer.filter.label', 'Filter')}
              </label>
              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
                className="text-sm px-2 py-1 rounded border"
                style={{
                  backgroundColor: 'var(--color-surface)',
                  borderColor: 'var(--color-surface-border)',
                  color: 'var(--color-text)',
                }}
              >
                {STATUS_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{t(o.key, o.fallback)}</option>
                ))}
              </select>
              <label className="text-xs text-muted-theme uppercase tracking-wider ml-2">
                {t('customer.sort.label', 'Sort')}
              </label>
              <select
                value={sort}
                onChange={(e) => setSort(e.target.value as SortKey)}
                className="text-sm px-2 py-1 rounded border"
                style={{
                  backgroundColor: 'var(--color-surface)',
                  borderColor: 'var(--color-surface-border)',
                  color: 'var(--color-text)',
                }}
              >
                <option value="newest">{t('customer.sort.newest', 'Newest first')}</option>
                <option value="oldest">{t('customer.sort.oldest', 'Oldest first')}</option>
              </select>
            </div>
            <div className="text-xs text-muted-theme">
              {visible.length === all.length
                ? t('customer.filter.countAll', '{{count}} total', { count: all.length })
                : t('customer.filter.countFiltered', '{{visible}} of {{total}}', { visible: visible.length, total: all.length })}
            </div>
          </div>
          <Card padding="none">
            <ul className="divide-y" style={{ borderColor: 'var(--color-surface-border)' }}>
              {visible.map((c) => <ContractRow key={c.id} c={c} />)}
            </ul>
          </Card>
        </>
      )}
    </div>
  );
};

const ContractRow: React.FC<{ c: CustomerContract }> = ({ c }) => {
  const { t } = useTranslation();

  async function handleDownload() {
    // Sync-open BEFORE await so the popup-blocker accepts the gesture
    // — same pattern bills/quotes use.
    const w = window.open('about:blank', '_blank');
    if (!w) {
      toast.error(t('customer.contracts.popupBlocked',
        'Allow pop-ups for this site to download the contract PDF.') as string);
      return;
    }
    try {
      const url = await customerService.contractPdfUrl(c.id);
      w.location.href = url;
    } catch (err: any) {
      w.close();
      toast.error(err?.response?.data?.error || 'Download failed');
    }
  }

  const statusBadge =
    c.status === 'fully_signed' ? 'bg-green-100 text-green-800'
      : c.status === 'signed_by_customer' || c.status === 'signed_by_admin' ? 'bg-blue-100 text-blue-800'
      : c.status === 'sent' ? 'bg-amber-100 text-amber-800'
      : c.status === 'cancelled' ? 'bg-neutral-200 text-neutral-600'
      : 'bg-neutral-100 text-neutral-700';

  return (
    <li className="p-4 flex items-center justify-between gap-3 flex-wrap">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-sm">{c.contractNumber}</span>
          <span className={`px-2 py-0.5 rounded text-xs font-medium ${statusBadge}`}>
            {t(`contracts.status.${c.status}`, c.status)}
          </span>
        </div>
        {c.title && (
          <p className="text-sm text-theme mt-1">{c.title}</p>
        )}
        <p className="text-xs text-muted-theme mt-0.5">
          {t('customer.contracts.issued', 'Issued')}: {formatShortDate(c.issueDate)}
          {c.signedByCustomerAt && (
            <>
              {' · '}
              {t('customer.contracts.signedByYou', 'Signed by you')}: {formatShortDate(c.signedByCustomerAt)}
            </>
          )}
          {c.signedByAdminAt && (
            <>
              {' · '}
              {t('customer.contracts.counterSigned', 'Counter-signed')}: {formatShortDate(c.signedByAdminAt)}
            </>
          )}
        </p>
      </div>
      <div className="flex items-center gap-2">
        {c.status === 'sent' && c.responseToken && (
          <a
            href={`/contract/${c.responseToken}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-sm bg-accent-dark text-white hover:opacity-90"
          >
            <ExternalLink className="w-4 h-4" />
            {t('customer.contracts.openSign', 'Open & sign')}
          </a>
        )}
        {(c.hasPdf || c.hasSignedPdf) && (
          <button
            type="button"
            onClick={handleDownload}
            className="inline-flex items-center gap-1 px-3 py-1.5 rounded text-sm border"
            style={{
              backgroundColor: 'var(--color-surface)',
              borderColor: 'var(--color-surface-border)',
              color: 'var(--color-text)',
            }}
          >
            <Download className="w-4 h-4" />
            {c.hasSignedPdf
              ? t('customer.contracts.downloadSigned', 'Download signed PDF')
              : t('customer.contracts.download', 'Download PDF')}
          </button>
        )}
      </div>
    </li>
  );
};

export default CustomerContractsPage;
