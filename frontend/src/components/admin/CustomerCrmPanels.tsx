/**
 * Customer CRM panels — quotes + invoices history shown on the customer
 * detail page. Each panel:
 *   - is gated by its global feature flag (`quotes` / `bills`); when the
 *     flag is off the panel doesn't render at all (no empty space)
 *   - shows the 10 most recent rows for that customer, with status
 *     badge, total and a click-through to the full document
 *   - exposes a "New …" button + a "Show all" link to the global list
 *     pre-filtered by this customer
 *
 * Lives as a separate component so CustomerDetailPage doesn't need to
 * know about CRM types; the panels handle their own data fetching.
 */
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { FileText, Plus, Receipt, ScrollText, Repeat2, AlertTriangle } from 'lucide-react';
import { Card, Button, Loading } from '../common';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { usePermission } from '../../hooks/usePermission';
import { quotesService } from '../../services/quotes.service';
import { billsService, isDraftInvoice } from '../../services/bills.service';
import { contractsService } from '../../services/contracts.service';
import { accountingService, type CustomerRebillItem } from '../../services/accounting.service';
import { customerAdminService } from '../../services/customerAdmin.service';
import { CrossAddInvoiceDialog } from './CrossAddInvoiceDialog';
import { formatMoney } from './LineItemsTable';
import { useLocalizedDate } from '../../hooks/useLocalizedDate';

interface Props {
  customerAccountId: number;
}

export const CustomerCrmPanels: React.FC<Props> = ({ customerAccountId }) => {
  const { flags } = useFeatureFlags();

  return (
    <>
      {flags.quotes && <QuotesPanel customerAccountId={customerAccountId} />}
      {flags.contracts && <ContractsPanel customerAccountId={customerAccountId} />}
      {flags.bills && <InvoicesPanel customerAccountId={customerAccountId} />}
      {flags.incomingInvoices && <RebillsPanel customerAccountId={customerAccountId} />}
    </>
  );
};

const QuotesPanel: React.FC<Props> = ({ customerAccountId }) => {
  const { t } = useTranslation();
  const { format: fmtDate } = useLocalizedDate();
  const { data, isLoading } = useQuery({
    queryKey: ['customer-quotes', customerAccountId],
    queryFn: () => quotesService.list({ customerAccountId, page: 1, pageSize: 10, sort: 'newest' }),
    // Customer detail page mounts these three panels together. Without
    // staleTime they all refetch on every visit + every queryClient
    // touch elsewhere. 30s lets a quick tab-out/tab-in not re-hit the
    // API; admin mutations invalidate the cache explicitly when they
    // need fresh data.
    staleTime: 30_000,
  });

  return (
    <Card padding="lg">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
          <FileText className="w-5 h-5" /> {t('customers.detail.quotesSection', 'Quotes')}
        </h2>
        <div className="flex gap-2">
          <Link to={`/admin/clients/quotes?customerAccountId=${customerAccountId}`}>
            <Button variant="outline" size="sm">{t('common.showAll', 'Show all')}</Button>
          </Link>
          {/* "New quote" pre-fills via state on QuoteEditorPage when a
              customerAccountId search-param is present (cheap follow-up
              if you want it). For now the editor's customer picker
              starts empty. */}
          {/* Pre-fill this customer on the editor via search-param
              so the admin doesn't have to retype it. The editor picks
              it up on mount. */}
          <Link to={`/admin/clients/quotes/new?customerAccountId=${customerAccountId}`}>
            <Button size="sm"><Plus className="w-4 h-4 mr-1" />{t('quotes.new', 'New quote')}</Button>
          </Link>
        </div>
      </div>

      {isLoading ? <Loading /> : !data || data.quotes.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {t('customers.detail.noQuotes', 'No quotes for this customer yet.')}
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
          {data.quotes.map((q) => (
            <li key={q.id} className="py-2 flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <Link to={`/admin/clients/quotes/${q.id}`} className="text-neutral-900 dark:text-neutral-100 hover:underline font-mono text-sm">
                  {q.quoteNumber}
                </Link>
                <span className="text-xs text-neutral-500 dark:text-neutral-400 ml-2">{q.eventName || fmtDate(q.issueDate)}</span>
              </div>
              <span className="text-sm tabular-nums">{formatMoney(Number(q.totalAmountMinor) / 100, q.currency)}</span>
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                q.status === 'accepted' || q.status === 'converted' ? 'bg-green-100 text-green-800'
                  : q.status === 'declined' ? 'bg-red-100 text-red-800'
                  : q.status === 'sent' ? 'bg-blue-100 text-blue-800'
                  : 'bg-neutral-100 text-neutral-700'
              }`}>{t(`quotes.status.${q.status}`, q.status)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};

const ContractsPanel: React.FC<Props> = ({ customerAccountId }) => {
  const { t } = useTranslation();
  const { format: fmtDate } = useLocalizedDate();
  const { data, isLoading } = useQuery({
    queryKey: ['customer-contracts', customerAccountId],
    queryFn: () => contractsService.list({ customerAccountId, page: 1, pageSize: 10, sort: 'newest' }),
    staleTime: 30_000,
  });

  return (
    <Card padding="lg">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
          <ScrollText className="w-5 h-5" /> {t('customers.detail.contractsSection', 'Contracts')}
        </h2>
        <div className="flex gap-2">
          <Link to={`/admin/clients/contracts?customerAccountId=${customerAccountId}`}>
            <Button variant="outline" size="sm">{t('common.showAll', 'Show all')}</Button>
          </Link>
          <Link to={`/admin/clients/contracts/new?customerAccountId=${customerAccountId}`}>
            <Button size="sm"><Plus className="w-4 h-4 mr-1" />{t('contracts.list.new', 'New contract')}</Button>
          </Link>
        </div>
      </div>

      {isLoading ? <Loading /> : !data || data.contracts.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {t('customers.detail.noContracts', 'No contracts for this customer yet.')}
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
          {data.contracts.map((c) => (
            <li key={c.id} className="py-2 flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <Link to={`/admin/clients/contracts/${c.id}`} className="text-neutral-900 dark:text-neutral-100 hover:underline font-mono text-sm">
                  {c.contractNumber}
                </Link>
                <span className="text-xs text-neutral-500 dark:text-neutral-400 ml-2 truncate">{c.title || fmtDate(c.issueDate)}</span>
              </div>
              <span className={`px-2 py-0.5 rounded text-xs font-medium ${
                c.status === 'fully_signed' ? 'bg-green-100 text-green-800'
                  : c.status === 'signed_by_customer' || c.status === 'signed_by_admin' ? 'bg-blue-100 text-blue-800'
                  : c.status === 'sent' ? 'bg-amber-100 text-amber-800'
                  : c.status === 'cancelled' ? 'bg-neutral-200 text-neutral-600'
                  : 'bg-neutral-100 text-neutral-700'
              }`}>{t(`contracts.status.${c.status}`, c.status)}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};

const InvoicesPanel: React.FC<Props> = ({ customerAccountId }) => {
  const { t } = useTranslation();
  const { format: fmtDate } = useLocalizedDate();
  const { data, isLoading } = useQuery({
    queryKey: ['customer-invoices', customerAccountId],
    queryFn: () => billsService.list({ customerAccountId, page: 1, pageSize: 10, sort: 'newest' }),
    staleTime: 30_000,
  });

  return (
    <Card padding="lg">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
          <Receipt className="w-5 h-5" /> {t('customers.detail.billsSection', 'Invoices')}
        </h2>
        <div className="flex gap-2">
          <Link to={`/admin/clients/bills?customerAccountId=${customerAccountId}`}>
            <Button variant="outline" size="sm">{t('common.showAll', 'Show all')}</Button>
          </Link>
          {/* Same prefill trick as quotes — see comment in QuotesPanel. */}
          <Link to={`/admin/clients/bills/new?customerAccountId=${customerAccountId}`}>
            <Button size="sm"><Plus className="w-4 h-4 mr-1" />{t('bills.new', 'New invoice')}</Button>
          </Link>
        </div>
      </div>

      {isLoading ? <Loading /> : !data || data.invoices.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {t('customers.detail.noBills', 'No invoices for this customer yet.')}
        </p>
      ) : (
        <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
          {data.invoices.map((inv) => (
            <li key={inv.id} className="py-2 flex items-center justify-between gap-3">
              <div className="min-w-0 flex-1">
                <Link to={`/admin/clients/bills/${inv.id}`} className="text-neutral-900 dark:text-neutral-100 hover:underline font-mono text-sm">
                  {inv.invoiceNumber}
                </Link>
                <span className="text-xs text-neutral-500 dark:text-neutral-400 ml-2">
                  {fmtDate(inv.dueDate)}
                  {inv.installmentTotal > 1 ? ` · ${inv.installmentIndex + 1}/${inv.installmentTotal}` : ''}
                </span>
              </div>
              <span className="text-sm tabular-nums">{formatMoney(Number(inv.totalAmountMinor) / 100, inv.currency)}</span>
              {isDraftInvoice(inv) ? (
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
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
};

// ── Re-bills / passthrough panel (issue #866, Feature 2) ─────────────────────
// History-only, mirrors the Hours section pattern: grouped by derived status
// (Open / Sent / Paid) with a "Create invoice from re-bills" button up top for
// the open pool. When the customer also has open hours, the button opens the
// cross-add dialog first (Feature 3).
const REBILL_STATUS_ORDER: Array<CustomerRebillItem['status']> = ['open', 'sent', 'paid'];

const RebillsPanel: React.FC<Props> = ({ customerAccountId }) => {
  const { t } = useTranslation();
  const { flags } = useFeatureFlags();
  const { format: fmtDate } = useLocalizedDate();
  const navigate = useNavigate();
  const qc = useQueryClient();
  // Permission gating (#866 review). The endpoints require, respectively:
  //   view the panel            → accounting.view
  //   "Create invoice from re-bills" (billPendingRebills) → accounting.manage
  //   cross-add "Add both" (billCombined)                 → customers.edit
  const canView = usePermission('accounting.view');
  const canManage = usePermission('accounting.manage');
  const canCombine = usePermission('customers.edit');
  // The open-hours counter below reads GET /customers/:id/hour-entries, which
  // requires customers.view — a different permission from the customers.edit
  // that authorises the combined billing itself (#983).
  const canViewCustomers = usePermission('customers.view');
  const [crossAddOpen, setCrossAddOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  const { data: items = [], isLoading } = useQuery({
    queryKey: ['customer-rebills', customerAccountId],
    queryFn: () => accountingService.listCustomerRebills(customerAccountId),
    enabled: canView,
    staleTime: 30_000,
  });

  // Open hours count for the cross-add offer — only when hours logging is on,
  // the admin can actually create the combined invoice (customers.edit) AND can
  // read the hour entries the count comes from (customers.view). Both are
  // required: without the read permission the request just 403s on every
  // render (#983).
  const { data: openHours = 0 } = useQuery({
    queryKey: ['customer-open-hours-count', customerAccountId],
    queryFn: async () => (await customerAdminService.listHourEntries(customerAccountId, 'unbilled')).length,
    enabled: !!flags.hoursLogging && canCombine && canViewCustomers,
    staleTime: 30_000,
  });

  const openItems = items.filter((r) => r.status === 'open');

  const onSuccess = (invoiceId: number, msg: string) => {
    toast.success(msg);
    qc.invalidateQueries({ queryKey: ['customer-rebills', customerAccountId] });
    qc.invalidateQueries({ queryKey: ['customer-invoices', customerAccountId] });
    qc.invalidateQueries({ queryKey: ['admin-customer-hour-entries', customerAccountId] });
    qc.invalidateQueries({ queryKey: ['customer-open-hours-count', customerAccountId] });
    if (invoiceId) navigate(`/admin/clients/bills/${invoiceId}/edit`);
  };

  const runBill = async (includeHours: boolean) => {
    setBusy(true);
    try {
      if (includeHours) {
        const { invoiceId } = await customerAdminService.billCombined(customerAccountId, { includeHours: true, includeRebills: true });
        onSuccess(invoiceId, t('rebills.toast.billedCombined', 'Invoice created from re-bills and hours.'));
      } else {
        const { invoiceId } = await accountingService.billPendingRebills(customerAccountId);
        onSuccess(invoiceId, t('rebills.toast.billed', 'Invoice created from re-bills.'));
      }
      setCrossAddOpen(false);
    } catch (e: any) {
      toast.error(e?.response?.data?.error || t('rebills.toast.billFailed', 'Failed to create invoice'));
    } finally {
      setBusy(false);
    }
  };

  const handleCreateInvoice = () => {
    // Offer to fold in open hours only when the customer has both AND the admin
    // can create the combined invoice (customers.edit); otherwise bill the
    // re-bills directly.
    if (openHours > 0 && canCombine) setCrossAddOpen(true);
    else runBill(false);
  };

  // No accounting.view → don't render an empty card (query is disabled too).
  if (!canView) return null;

  return (
    <Card padding="lg">
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
          <Repeat2 className="w-5 h-5" /> {t('customers.detail.rebillsSection', 'Re-bills & passthrough')}
        </h2>
        {openItems.length > 0 && canManage && (
          <Button size="sm" disabled={busy} onClick={handleCreateInvoice}>
            <Plus className="w-4 h-4 mr-1" />{t('rebills.createInvoice', 'Create invoice from re-bills')}
          </Button>
        )}
      </div>

      {isLoading ? <Loading /> : items.length === 0 ? (
        <p className="text-sm text-neutral-500 dark:text-neutral-400">
          {t('customers.detail.noRebills', 'No re-billed or passed-through supplier invoices for this customer yet.')}
        </p>
      ) : (
        <div className="space-y-4">
          {REBILL_STATUS_ORDER.map((status) => {
            const group = items.filter((r) => r.status === status);
            if (group.length === 0) return null;
            return (
              <div key={status}>
                <h3 className="text-xs font-medium uppercase tracking-wider text-neutral-500 dark:text-neutral-400 mb-1">
                  {t(`rebills.status.${status}`, status)} · {group.length}
                </h3>
                <ul className="divide-y divide-neutral-200 dark:divide-neutral-700">
                  {group.map((r) => (
                    <li key={r.id} className="py-2 flex items-center justify-between gap-3">
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-neutral-900 dark:text-neutral-100 truncate">
                          {r.supplierName || t('rebills.unknownSupplier', 'Supplier')}
                          <span className="ml-2 text-xs px-1.5 py-0.5 rounded bg-neutral-100 text-neutral-600 dark:bg-neutral-800 dark:text-neutral-300">
                            {r.mode === 'passthrough' ? t('rebills.mode.passthrough', 'Passthrough') : t('rebills.mode.rebill', 'Re-bill')}
                          </span>
                        </div>
                        <div className="text-xs text-neutral-500 dark:text-neutral-400 truncate">
                          {r.date ? fmtDate(r.date) : ''}
                          {r.eventName ? ` · ${r.eventName}` : ''}
                          {r.invoiceNumber ? (
                            <>
                              {' · '}
                              <Link to={`/admin/clients/bills/${r.invoiceId}`} className="hover:underline font-mono">{r.invoiceNumber}</Link>
                            </>
                          ) : ''}
                        </div>
                        {r.proofAttachError && (
                          <div className="mt-0.5 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
                            <AlertTriangle className="w-3 h-3 shrink-0" />
                            {t('rebills.proofError', 'Proof not attached: {{err}}', { err: r.proofAttachError })}
                          </div>
                        )}
                      </div>
                      <div className="text-right shrink-0">
                        <div className="text-sm tabular-nums text-neutral-900 dark:text-neutral-100">
                          {formatMoney(r.rebilledMinor / 100, r.currency)}
                        </div>
                        {r.rebilledMinor !== r.costMinor && (
                          <div className="text-xs text-neutral-400 dark:text-neutral-500 tabular-nums">
                            {t('rebills.costLabel', 'cost {{amount}}', { amount: formatMoney(r.costMinor / 100, r.currency) })}
                          </div>
                        )}
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      <CrossAddInvoiceDialog
        open={crossAddOpen}
        primary="rebills"
        otherCount={openHours}
        busy={busy}
        onConfirm={runBill}
        onClose={() => setCrossAddOpen(false)}
      />
    </Card>
  );
};
