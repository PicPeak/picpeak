/**
 * Accounting section layout (migration 122).
 *
 * Wraps /admin/accounting/* routes with a Settings-style left sub-nav,
 * mirroring ClientsLayout. Today it hosts the Tax report (relocated here
 * from CRM when the `accounting` flag is on); the inbound-document inbox and
 * expenses pages slot in as additional sub-nav entries when their UIs land.
 */
import React from 'react';
import { NavLink, Outlet, Navigate, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Landmark, Calculator, Inbox, Wallet } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useFeatureFlags, type FeatureKey } from '../../contexts/FeatureFlagsContext';

interface NavItem {
  key: string;
  to: string;
  label: string;
  icon: LucideIcon;
  /** Feature flag that must be ON for this entry to render. */
  featureFlag: FeatureKey;
}

export const AccountingLayout: React.FC = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { flags } = useFeatureFlags();

  const navItems: NavItem[] = [
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

  const enabledItems = navItems.filter((item) => flags[item.featureFlag]);

  const header = (
    <div className="mb-6">
      <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
        {t('accounting.title', 'Accounting')}
      </h1>
      <p className="text-neutral-600 dark:text-neutral-400 mt-1">
        {t('accounting.subtitle', 'Inbound supplier invoices, expenses and reporting.')}
      </p>
    </div>
  );

  if (enabledItems.length === 0) {
    return (
      <div>
        {header}
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
      {header}

      <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6 lg:gap-8">
        {/* Mobile: native select dropdown */}
        <div className="lg:hidden">
          <label htmlFor="accounting-section" className="sr-only">
            {t('accounting.navAriaLabel', 'Accounting navigation')}
          </label>
          <select
            id="accounting-section"
            value={location.pathname}
            onChange={(e) => navigate(e.target.value)}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm font-medium text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            {enabledItems.map((item) => (
              <option key={item.key} value={item.to}>{item.label}</option>
            ))}
          </select>
        </div>

        {/* Desktop: sticky left rail */}
        <aside className="hidden lg:block">
          <nav
            aria-label={t('accounting.navAriaLabel', 'Accounting navigation')}
            className="sticky top-6 space-y-1"
          >
            {enabledItems.map((item) => {
              const Icon = item.icon;
              return (
                <NavLink
                  key={item.key}
                  to={item.to}
                  className={({ isActive }) =>
                    `group w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                      isActive
                        ? 'bg-accent-dark text-white'
                        : 'text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800'
                    }`
                  }
                >
                  {({ isActive }) => (
                    <>
                      <Icon
                        className={`w-4 h-4 flex-shrink-0 ${
                          isActive
                            ? 'text-white'
                            : 'text-neutral-500 dark:text-neutral-400 group-hover:text-neutral-700 dark:group-hover:text-neutral-200'
                        }`}
                      />
                      <span className="truncate">{item.label}</span>
                    </>
                  )}
                </NavLink>
              );
            })}
          </nav>
        </aside>

        <div className="min-w-0">
          <Outlet />
        </div>
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
