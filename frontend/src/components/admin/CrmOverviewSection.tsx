/**
 * CrmOverviewSection — headline metrics embedded into the main
 * AdminDashboard for admins who use the CRM features.
 *
 * Feature-flag gating (three layers):
 *   - `clients` parent flag OFF       → renders nothing
 *   - only `quotes` enabled            → only the quote cards render
 *   - only `bills` enabled             → only the invoice + revenue
 *                                        + outstanding cards render
 *   - both enabled                     → full section
 *
 * Numbers come from /api/admin/dashboard/crm-stats. Each card deep-
 * links into the matching filtered list so the admin can drill in
 * with one click.
 */
import React from 'react';
import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { useQuery } from '@tanstack/react-query';
import {
  FileText, Send, CheckCircle2, XCircle, Clock,
  Receipt, AlertTriangle, TrendingUp, Wallet,
} from 'lucide-react';
import { Card } from '../common';
import { fetchCrmOverview, type CrmOverviewStats } from '../../services/bills.service';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { usePublicSettings } from '../../hooks/usePublicSettings';

import { formatMoneyMinor } from '../../utils/money';
// Local alias preserved so call-sites in this file keep their
// minor-units semantics. The unified helper handles the /100 conversion.
const formatMoney = formatMoneyMinor;

export const CrmOverviewSection: React.FC = () => {
  const { t } = useTranslation();
  const { flags } = useFeatureFlags();
  const { data: publicSettings } = usePublicSettings();

  // Outer gate: hide the entire CRM block when the parent feature
  // flag is off. The query is also skipped so we don't hit the
  // endpoint at all on non-CRM installs.
  const clientsOn = !!flags.clients;
  const quotesOn  = clientsOn && !!flags.quotes;
  const billsOn   = clientsOn && !!flags.bills;
  const anyCrm    = quotesOn || billsOn;

  // Per-tile visibility (admin pref in Settings → CRM behaviour). All
  // default true; only explicit false hides the matching tile. We
  // resolve via `!== false` so the very first render — before
  // publicSettings finishes loading — shows everything, then settles.
  const showRevenue     = publicSettings?.crm_overview_show_revenue !== false;
  const showOutstanding = publicSettings?.crm_overview_show_outstanding !== false;
  // Revenue "year" tile toggles in place between the trailing-365-day
  // window and calendar year-to-date — keeps the dashboard to four
  // tiles instead of adding a fifth.
  const [revYearMode, setRevYearMode] = React.useState<'rolling' | 'calendar'>('rolling');
  const showQuotes      = publicSettings?.crm_overview_show_quotes !== false;
  const showInvoices    = publicSettings?.crm_overview_show_invoices !== false;
  // Compute which sub-sections actually render so we can skip the
  // outer block entirely when the admin hid everything.
  const billsRevenueRow = billsOn && (showRevenue || showOutstanding);
  const quotesBlock     = quotesOn && showQuotes;
  const invoicesBlock   = billsOn && showInvoices;

  const { data, isLoading, isError } = useQuery({
    queryKey: ['crm-overview'],
    queryFn: () => fetchCrmOverview(),
    enabled: anyCrm,
    // Dashboard tile aggregates — admin opens this on every dashboard
    // load; refetching the full aggregate on every mount adds DB load
    // without observable benefit. 60s window covers the typical
    // "click into a contract / click back" pattern.
    staleTime: 60_000,
  });

  if (!anyCrm) return null;
  // Admin hid every CRM tile — render nothing, including the heading.
  if (!billsRevenueRow && !quotesBlock && !invoicesBlock) return null;
  if (isLoading) return null;
  if (isError || !data) {
    // Surface a tiny inline notice when the section is enabled by
    // flags but the API failed — silent renders make this hard to
    // debug (the user reported "everything turned on but nothing
    // shows" which traced back to a permission check on the
    // backend). Keep it small so it doesn't disrupt the page.
    return (
      <section className="mt-8">
        <h2 className="text-xl font-bold text-theme mb-2">
          {t('crmOverview.title', 'CRM overview')}
        </h2>
        <p className="text-sm text-red-600">
          {t('crmOverview.loadError',
            'Could not load CRM stats. Check that you have bills.view or quotes.view permission and that the backend is on the latest build.')}
        </p>
      </section>
    );
  }

  const d: CrmOverviewStats = data;
  const cur = d.currency || 'CHF';

  return (
    <section className="mt-8 space-y-5">
      <h2 className="text-xl font-bold text-theme">
        {t('crmOverview.title', 'CRM overview')}
      </h2>

      {/* Revenue + outstanding (bills feature only). Revenue trio and
          outstanding tile are gated independently — admins who only
          want the outstanding figure (or vice versa) can hide either
          via Settings → CRM behaviour. */}
      {billsRevenueRow && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
          {showRevenue && (
            <>
              <StatCard
                icon={<TrendingUp className="w-5 h-5" />}
                label={t('crmOverview.revenue.month', 'Revenue · last 30 days')}
                value={formatMoney(d.revenue.monthMinor, cur)}
              />
              <StatCard
                icon={<TrendingUp className="w-5 h-5" />}
                label={t('crmOverview.revenue.quarter', 'Revenue · last 90 days')}
                value={formatMoney(d.revenue.quarterMinor, cur)}
              />
              <StatCard
                icon={<TrendingUp className="w-5 h-5" />}
                label={revYearMode === 'calendar'
                  ? t('crmOverview.revenue.yearCalendar', 'Revenue · this year')
                  : t('crmOverview.revenue.year', 'Revenue · last 365 days')}
                value={formatMoney(
                  revYearMode === 'calendar' ? d.revenue.calendarYearMinor : d.revenue.yearMinor,
                  cur,
                )}
                sub={t('crmOverview.revenue.toggleHint', 'Tap to switch window')}
                onClick={() => setRevYearMode((m) => (m === 'rolling' ? 'calendar' : 'rolling'))}
              />
            </>
          )}
          {showOutstanding && (
            <StatCard
              icon={<Wallet className="w-5 h-5 text-red-600" />}
              label={t('crmOverview.outstanding', 'Outstanding payments')}
              value={formatMoney(d.outstanding.totalMinor, cur)}
              sub={t('crmOverview.outstandingSub', '{{count}} invoice(s) unpaid', {
                count: d.outstanding.invoiceCount,
              })}
              to="/admin/clients/bills?unpaidOnly=true"
            />
          )}
        </div>
      )}

      {/* Quotes pipeline (quotes feature only) */}
      {quotesBlock && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base font-semibold flex items-center gap-2">
              <FileText className="w-5 h-5" />
              {t('crmOverview.quotes.title', 'Quotes')}
            </h3>
            <Link to="/admin/clients/quotes" className="text-sm text-primary-600 dark:text-primary-400 hover:underline">
              {t('crmOverview.viewAll', 'View all')} →
            </Link>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
            <StatCard
              icon={<Clock className="w-5 h-5 text-amber-600" />}
              label={t('quotes.status.draft', 'Drafts')}
              value={d.quotes.draft}
              to="/admin/clients/quotes?status=draft"
            />
            <StatCard
              icon={<Send className="w-5 h-5 text-blue-600" />}
              label={t('quotes.status.sent', 'Sent / open')}
              value={d.quotes.sent}
              to="/admin/clients/quotes?status=sent"
            />
            <StatCard
              icon={<CheckCircle2 className="w-5 h-5 text-green-600" />}
              label={t('quotes.status.accepted', 'Accepted')}
              value={d.quotes.accepted}
              to="/admin/clients/quotes?status=accepted"
            />
            <StatCard
              icon={<XCircle className="w-5 h-5 text-red-600" />}
              label={t('quotes.status.declined', 'Declined')}
              value={d.quotes.declined}
              to="/admin/clients/quotes?status=declined"
            />
            <StatCard
              icon={<Clock className="w-5 h-5 text-neutral-500" />}
              label={t('quotes.status.expired', 'Expired')}
              value={d.quotes.expired}
              to="/admin/clients/quotes?status=expired"
            />
            <StatCard
              icon={<CheckCircle2 className="w-5 h-5 text-emerald-700" />}
              label={t('quotes.status.converted', 'Converted')}
              value={d.quotes.converted}
              to="/admin/clients/quotes?status=converted"
            />
          </div>
        </div>
      )}

      {/* Invoices pipeline (bills feature only) */}
      {invoicesBlock && (
        <div>
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-base font-semibold flex items-center gap-2">
              <Receipt className="w-5 h-5" />
              {t('crmOverview.invoices.title', 'Invoices')}
            </h3>
            <Link to="/admin/clients/bills" className="text-sm text-primary-600 dark:text-primary-400 hover:underline">
              {t('crmOverview.viewAll', 'View all')} →
            </Link>
          </div>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <StatCard
              icon={<Clock className="w-5 h-5 text-amber-600" />}
              label={t('bills.status.scheduled', 'Scheduled')}
              value={d.invoices.scheduled}
              to="/admin/clients/bills?status=scheduled"
            />
            <StatCard
              icon={<Send className="w-5 h-5 text-blue-600" />}
              label={t('bills.status.sent', 'Sent / open')}
              value={d.invoices.sent}
              to="/admin/clients/bills?status=sent"
            />
            <StatCard
              icon={<CheckCircle2 className="w-5 h-5 text-green-600" />}
              label={t('bills.status.paid', 'Paid')}
              value={d.invoices.paid}
              to="/admin/clients/bills?status=paid"
            />
            <StatCard
              icon={<AlertTriangle className="w-5 h-5 text-red-600" />}
              label={t('bills.status.overdue', 'Overdue')}
              value={d.invoices.overdue}
              to="/admin/clients/bills?status=overdue"
            />
            <StatCard
              icon={<XCircle className="w-5 h-5 text-neutral-500" />}
              label={t('bills.status.cancelled', 'Cancelled')}
              value={d.invoices.cancelled}
              to="/admin/clients/bills?status=cancelled"
            />
          </div>
        </div>
      )}
    </section>
  );
};

interface StatCardProps {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  sub?: string;
  to?: string;
  /** Makes the whole tile a button (mutually exclusive with `to`).
   *  Used by the revenue tile to toggle its window in place. */
  onClick?: () => void;
}
const StatCard: React.FC<StatCardProps> = ({ icon, label, value, sub, to, onClick }) => {
  const inner = (
    <Card padding="md" className="h-full">
      <div className="flex items-start gap-3">
        <div className="shrink-0 mt-0.5">{icon}</div>
        <div className="min-w-0">
          <div className="text-xs uppercase tracking-wider text-muted-theme">{label}</div>
          <div className="text-2xl font-bold tabular-nums mt-1">{value}</div>
          {sub && <div className="text-xs text-muted-theme mt-1">{sub}</div>}
        </div>
      </div>
    </Card>
  );
  if (to) {
    return <Link to={to} className="block hover:opacity-90 transition-opacity">{inner}</Link>;
  }
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className="block w-full text-left hover:opacity-90 transition-opacity">
        {inner}
      </button>
    );
  }
  return inner;
};

export default CrmOverviewSection;
