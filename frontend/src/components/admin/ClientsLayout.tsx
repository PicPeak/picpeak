/**
 * Clients section layout (#354 follow-up).
 *
 * Wraps /admin/clients/* routes with a Settings-style left sub-nav.
 * Today the only sub-nav entry is "Accounts" — when calendar / quotes
 * / bills / messaging ship they get added to `navItems` below and
 * mounted as nested routes in App.tsx. No placeholder UI; absent
 * entries simply don't render.
 *
 * Visual pattern intentionally mirrors SettingsPage: 220px left rail
 * on desktop, native <select> on mobile, accent-dark pill for the
 * active item with white icon + label.
 */
import React from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Briefcase, UserCog } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useFeatureFlags, type FeatureKey } from '../../contexts/FeatureFlagsContext';

interface NavItem {
  key: string;
  to: string;
  label: string;
  icon: LucideIcon;
  /**
   * Feature flag that must be ON for this entry to render. The
   * parent `clients` flag has already been verified by the
   * RequireFeature gate around this layout, so children only need
   * to declare their own sub-flag here.
   */
  featureFlag: FeatureKey;
}

export const ClientsLayout: React.FC = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const { flags } = useFeatureFlags();

  const navItems: NavItem[] = [
    {
      key: 'accounts',
      to: '/admin/clients/accounts',
      label: t('clients.subnav.accounts', 'Accounts'),
      icon: UserCog,
      featureFlag: 'customerPortal',
    },
    // Add future sub-features here as they ship:
    //   { key: 'calendar', to: '/admin/clients/calendar', ... featureFlag: 'calendar' }
    //   { key: 'quotes',   to: '/admin/clients/quotes',   ... featureFlag: 'quotes'   }
    //   { key: 'bills',    to: '/admin/clients/bills',    ... featureFlag: 'bills'    }
    //   etc. The empty-state below disappears automatically once any of
    //   these is enabled.
  ];

  const enabledItems = navItems.filter((item) => flags[item.featureFlag]);

  // When the parent `clients` flag is on but no sub-feature is enabled,
  // there's nothing to render. Settings → Features is one click away
  // and tells the admin exactly what to flip on.
  if (enabledItems.length === 0) {
    return (
      <div>
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
            {t('clients.title', 'Clients')}
          </h1>
          <p className="text-neutral-600 dark:text-neutral-400 mt-1">
            {t('clients.subtitle', 'Customer accounts, scheduling, quotes and billing for recurring clients.')}
          </p>
        </div>

        <div className="rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 p-8 text-center">
          <Briefcase className="w-10 h-10 mx-auto mb-3 text-neutral-400" />
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-1">
            {t('clients.empty.title', 'No client features enabled')}
          </h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t(
              'clients.empty.body',
              'Enable Accounts (or another Clients sub-feature) under Settings → Features to get started.',
            )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">
          {t('clients.title', 'Clients')}
        </h1>
        <p className="text-neutral-600 dark:text-neutral-400 mt-1">
          {t('clients.subtitle', 'Customer accounts, scheduling, quotes and billing for recurring clients.')}
        </p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6 lg:gap-8">
        {/* Mobile: native select dropdown — keeps every option reachable
           in one tap on touch devices, no horizontal scroll. */}
        <div className="lg:hidden">
          <label htmlFor="clients-section" className="sr-only">
            {t('clients.navAriaLabel', 'Clients navigation')}
          </label>
          <select
            id="clients-section"
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
            aria-label={t('clients.navAriaLabel', 'Clients navigation')}
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
