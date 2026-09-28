/**
 * Accounting section layout (migration 122).
 *
 * Wraps /admin/accounting/* routes, mirroring ClientsLayout. The section's
 * navigation is rendered by the admin sidebar from `useAccountingNavItems()`
 * while the admin is inside /admin/accounting; this layout only owns the
 * empty state (the sidebar carries the section title).
 */
import React from 'react';
import { Outlet, Navigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Landmark, Calculator, Inbox, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useFeatureFlags, type FeatureKey } from '../../contexts/FeatureFlagsContext';

export interface AccountingNavItem {
  key: string;
  to: string;
  label: string;
  icon: LucideIcon;
  /** Feature flag that must be ON for this entry to render. */
  featureFlag: FeatureKey;
}

/** Sub-pages of the Accounting section that are switched on. */
export function useAccountingNavItems(): AccountingNavItem[] {
  const { t } = useTranslation();
  const { flags } = useFeatureFlags();

  const navItems: AccountingNavItem[] = [
    {
      key: 'inbox',
      to: '/admin/accounting/inbox',
      label: t('accounting.subnav.incomingInvoices', 'Incoming invoices'),
      icon: Inbox,
      featureFlag: 'incomingInvoices',
    },
    {
      key: 'expenses',
      to: '/admin/accounting/expenses',
      label: t('accounting.subnav.expenses', 'Expenses'),
      icon: Wallet,
      featureFlag: 'expenses',
    },
    {
      key: 'tax-report',
      // The Treuhänder export now lives ON the Tax page (same period/currency
      // filters, same data) instead of a separate sub-tab — see TaxReportPage.
      to: '/admin/accounting/tax-report',
      label: t('accounting.subnav.taxReport', 'Tax'),
      icon: Calculator,
      featureFlag: 'taxReport',
    },
    // Chart of accounts moved to Settings → Accounting (all accounting config
    // lives there now); this section keeps only the operational pages.
    // Future: Erfolgsrechnung (Layer B).
  ];

  return navItems.filter((item) => flags[item.featureFlag]);
}

export const AccountingLayout: React.FC = () => {
  const { t } = useTranslation();
  const enabledItems = useAccountingNavItems();

  if (enabledItems.length === 0) {
    return (
      <div>
        <div className="rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 p-8 text-center">
          <Landmark className="w-10 h-10 mx-auto mb-3 text-neutral-400" />
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-1">
            {t('accounting.empty.title', 'No accounting features enabled')}
          </h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t('accounting.empty.body', 'Enable the Tax report (or another accounting sub-feature) under Settings → Features to get started.')}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="min-w-0">
        <Outlet />
      </div>
    </div>
  );
};

/**
 * Index redirect for /admin/accounting — send to the first enabled
 * sub-feature (Incoming invoices preferred, then Tax export). When none
 * are on, render nothing; AccountingLayout shows its empty state.
 */
export const AccountingIndex: React.FC = () => {
  const { flags } = useFeatureFlags();
  if (flags.incomingInvoices) return <Navigate to="/admin/accounting/inbox" replace />;
  if (flags.expenses) return <Navigate to="/admin/accounting/expenses" replace />;
  if (flags.taxReport) return <Navigate to="/admin/accounting/tax-report" replace />;
  return null;
};
