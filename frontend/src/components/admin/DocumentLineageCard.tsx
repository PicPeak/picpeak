/**
 * <DocumentLineageCard> — flat list of every document sharing one
 * `deal_uuid` (migration 140), grouped by type. Renders on the three
 * detail pages (Quote / Contract / Bill) so the admin sees the
 * complete chain — quotes + contracts + invoices (incl. Storno /
 * reissue / installment siblings) — without walking individual FKs.
 *
 * Data comes from `GET /api/admin/deals/:uuid/documents` (commit #3).
 * The card is purely presentational; the parent passes the dealUuid
 * and a `currentId` so the row representing "the document you're
 * looking at" can be highlighted instead of linked.
 *
 * When no other documents share the deal (newly-created standalone
 * doc), the card renders a compact "no related documents" line
 * instead of three empty groups — keeps the detail page from looking
 * busy on the common case.
 */

import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { FileText, ScrollText, Receipt, AlertTriangle, Pencil } from 'lucide-react';
import { Button, Card } from '../common';
import { formatMoneyMinor } from '../../utils/money';
import { api } from '../../config/api';
import { EditInstallmentPlanModal } from './EditInstallmentPlanModal';

export interface DocumentLineageCardProps {
  dealUuid: string | null | undefined;
  /** Which document you're currently looking at. The matching row
   *  renders muted (not a link) so the admin doesn't navigate to the
   *  page they're already on. */
  current: { kind: 'quote' | 'contract' | 'invoice'; id: number };
  className?: string;
}

interface DealItemBase {
  id: number;
  number: string;
  status: string;
  currency?: string;
  totalAmountMinor?: number;
  issueDate?: string;
  eventName?: string | null;
  createdAt?: string;
}

interface DealQuoteItem extends DealItemBase { kind: 'quote'; validUntil?: string; }
interface DealContractItem extends DealItemBase { kind: 'contract'; title?: string | null; validUntil?: string; }
interface DealInvoiceItem extends DealItemBase {
  kind: 'invoice';
  invoiceKind: 'invoice' | 'storno';
  paidAmountMinor?: number;
  dueDate?: string;
  eventDate?: string | null;
  installmentIndex?: number;
  installmentTotal?: number;
  installmentLabel?: string | null;
  installmentTrigger?: string | null;
  installmentOffsetDays?: number;
  isMonthlyDraft?: boolean;
}

interface DealLineageResponse {
  dealUuid: string;
  quotes: DealQuoteItem[];
  contracts: DealContractItem[];
  invoices: DealInvoiceItem[];
}

const EDITABLE_PLAN_STATUSES = new Set(['scheduled', 'pending_delivery']);

export const DocumentLineageCard: React.FC<DocumentLineageCardProps> = ({
  dealUuid, current, className = '',
}) => {
  const { t } = useTranslation();
  const [showEditPlan, setShowEditPlan] = useState(false);
  const { data, isLoading, error } = useQuery({
    queryKey: ['deal-lineage', dealUuid],
    queryFn: async () => {
      const res = await api.get(`/admin/deals/${dealUuid}/documents`);
      return (res.data.data || res.data) as DealLineageResponse;
    },
    enabled: !!dealUuid,
    staleTime: 30_000,
  });

  if (!dealUuid) return null;

  if (isLoading) {
    return (
      <Card padding="md" className={className}>
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {t('dealLineage.loading', 'Loading related documents…')}
        </p>
      </Card>
    );
  }
  if (error) {
    return (
      <Card padding="md" className={className}>
        <p className="text-sm text-red-700 dark:text-red-300 flex items-center gap-2">
          <AlertTriangle className="w-4 h-4" />
          {t('dealLineage.error', 'Could not load related documents.')}
        </p>
      </Card>
    );
  }
  if (!data) return null;

  const { quotes, contracts, invoices } = data;
  const totalCount = quotes.length + contracts.length + invoices.length;

  // Reshape gesture is offered when this deal holds a multi-installment
  // plan AND every invoice is still pre-customer. Server re-checks on
  // save; if a sibling shipped between render and click, the 409 path
  // in the modal handles the race.
  const hasMultiInstallment = invoices.some((i) => (i.installmentTotal || 0) > 1);
  const allInvoicesEditable = invoices.length > 0
    && invoices.every((i) => i.invoiceKind !== 'storno'
      && EDITABLE_PLAN_STATUSES.has(i.status));
  const canEditPlan = hasMultiInstallment && allInvoicesEditable;
  // Only ONE doc total = the current one. No siblings to surface.
  if (totalCount <= 1) {
    return (
      <Card padding="md" className={className}>
        <h2 className="font-semibold mb-1 flex items-center gap-2">
          {t('dealLineage.title', 'Related documents')}
        </h2>
        <p className="text-xs text-neutral-500 dark:text-neutral-400">
          {t('dealLineage.empty', 'No other documents share this deal yet. New invoices, contracts, or installments will show up here once created.')}
        </p>
      </Card>
    );
  }

  return (
    <Card padding="md" className={className}>
      <h2 className="font-semibold mb-3">
        {t('dealLineage.title', 'Related documents')}
      </h2>

      {quotes.length > 0 && (
        <Group
          icon={<FileText className="w-4 h-4" />}
          label={t('dealLineage.quotes', 'Quotes')}
          count={quotes.length}
        >
          {quotes.map((q) => (
            <Row
              key={`q-${q.id}`}
              isCurrent={current.kind === 'quote' && current.id === q.id}
              href={`/admin/clients/quotes/${q.id}`}
              number={q.number}
              statusKey={`quotes.status.${q.status}`}
              statusFallback={q.status}
              right={q.totalAmountMinor != null && q.currency
                ? formatMoneyMinor(q.totalAmountMinor, q.currency)
                : null}
              meta={q.eventName || undefined}
            />
          ))}
        </Group>
      )}

      {contracts.length > 0 && (
        <Group
          icon={<ScrollText className="w-4 h-4" />}
          label={t('dealLineage.contracts', 'Contracts')}
          count={contracts.length}
        >
          {contracts.map((c) => (
            <Row
              key={`c-${c.id}`}
              isCurrent={current.kind === 'contract' && current.id === c.id}
              href={`/admin/clients/contracts/${c.id}`}
              number={c.number}
              statusKey={`contracts.status.${c.status}`}
              statusFallback={c.status}
              meta={c.title || c.eventName || undefined}
            />
          ))}
        </Group>
      )}

      {invoices.length > 0 && (
        <Group
          icon={<Receipt className="w-4 h-4" />}
          label={t('dealLineage.invoices', 'Invoices')}
          count={invoices.length}
          action={canEditPlan ? (
            <Button
              variant="outline"
              size="sm"
              onClick={() => setShowEditPlan(true)}
              leftIcon={<Pencil className="w-3.5 h-3.5" />}
              className="ml-auto"
            >
              {t('dealLineage.editPlan', 'Edit plan')}
            </Button>
          ) : undefined}
        >
          {invoices.map((i) => {
            const isStorno = i.invoiceKind === 'storno';
            const installmentTag = i.installmentTotal && i.installmentTotal > 1
              ? ` · ${i.installmentLabel || `${i.installmentIndex! + 1}/${i.installmentTotal}`}`
              : '';
            return (
              <Row
                key={`i-${i.id}`}
                isCurrent={current.kind === 'invoice' && current.id === i.id}
                href={`/admin/clients/bills/${i.id}`}
                number={i.number}
                statusKey={`bills.status.${i.status}`}
                statusFallback={i.status}
                right={i.totalAmountMinor != null && i.currency
                  ? formatMoneyMinor(i.totalAmountMinor, i.currency)
                  : null}
                badge={isStorno ? t('bills.kind.storno', 'Storno') as string : undefined}
                meta={installmentTag.replace(/^ · /, '') || undefined}
              />
            );
          })}
        </Group>
      )}

      {canEditPlan && dealUuid && (
        <EditInstallmentPlanModal
          isOpen={showEditPlan}
          onClose={() => setShowEditPlan(false)}
          dealUuid={dealUuid}
          siblings={invoices.map((i) => ({
            id: i.id,
            number: i.number,
            status: i.status,
            totalAmountMinor: i.totalAmountMinor,
            installmentIndex: i.installmentIndex,
            installmentTotal: i.installmentTotal,
            installmentLabel: i.installmentLabel,
            installmentTrigger: i.installmentTrigger,
            installmentOffsetDays: i.installmentOffsetDays,
          }))}
          eventDate={invoices.find((i) => i.eventDate)?.eventDate || null}
        />
      )}
    </Card>
  );
};

const Group: React.FC<{
  icon: React.ReactNode;
  label: string;
  count: number;
  children: React.ReactNode;
  action?: React.ReactNode;
}> = ({ icon, label, count, children, action }) => (
  <div className="mb-3 last:mb-0">
    <div className="flex items-center gap-2 text-xs uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-1">
      {icon}
      <span>{label}</span>
      <span>({count})</span>
      {action}
    </div>
    <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
      {children}
    </ul>
  </div>
);

const Row: React.FC<{
  isCurrent: boolean;
  href: string;
  number: string;
  statusKey: string;
  statusFallback: string;
  right?: string | null;
  meta?: string;
  badge?: string;
}> = ({ isCurrent, href, number, statusKey, statusFallback, right, meta, badge }) => {
  const { t } = useTranslation();
  const inner = (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <span className={`font-mono text-sm ${isCurrent ? 'text-neutral-500 dark:text-neutral-400' : ''}`}>{number}</span>
        {badge && (
          <span className="text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold bg-purple-100 text-purple-800 dark:bg-purple-900/40 dark:text-purple-300">
            {badge}
          </span>
        )}
        {meta && (
          <span className="text-xs text-neutral-500 dark:text-neutral-400 truncate">{meta}</span>
        )}
      </div>
      <div className="flex items-center gap-2 shrink-0 text-xs">
        {right && <span className="tabular-nums">{right}</span>}
        <span className="text-neutral-500 dark:text-neutral-400">{t(statusKey, statusFallback)}</span>
      </div>
    </div>
  );
  if (isCurrent) {
    return <li className="opacity-60">{inner}</li>;
  }
  return (
    <li>
      <Link to={href} className="block hover:bg-neutral-50 dark:hover:bg-neutral-800/40 -mx-2 px-2 rounded">
        {inner}
      </Link>
    </li>
  );
};

export default DocumentLineageCard;
