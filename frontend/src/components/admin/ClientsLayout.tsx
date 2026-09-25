/**
 * Clients section layout (#354 follow-up).
 *
 * Wraps /admin/clients/* routes. The section's navigation is rendered by
 * the admin sidebar, which swaps the main menu for `useClientsNavItems()`
 * while the admin is inside /admin/clients — so this layout only owns
 * the section-root redirect and the empty state (the sidebar carries the
 * section title). When
 * calendar / quotes / bills / messaging ship they get added to the hook
 * below and mounted as nested routes in App.tsx. No placeholder UI;
 * absent entries simply don't render.
 */
import React from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Briefcase, UserCog, FileText, Receipt, Wrench, Clock, ScrollText, Calendar, FolderKanban, Megaphone } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useFeatureFlags, type FeatureKey } from '../../contexts/FeatureFlagsContext';
import { usePermissions } from '../../contexts/PermissionsContext';

export interface ClientsNavItem {
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
  /**
   * Permission required to reach the page behind this entry. Without it the
   * item still rendered for anyone who could enter Clients at all, and the
   * click landed on a backend 403 (#1264 review).
   */
  permission?: string;
}

/** Sub-pages of the CRM section the current admin can reach. */
export function useClientsNavItems(): ClientsNavItem[] {
  const { t } = useTranslation();
  const { flags } = useFeatureFlags();
  const { hasPermission } = usePermissions();

  const navItems: ClientsNavItem[] = [
    {
      key: 'overview',
      to: '/admin/clients/projects',
      label: t('clients.subnav.overview', 'Overview'),
      icon: FolderKanban,
      featureFlag: 'projects',
    },
    {
      key: 'accounts',
      to: '/admin/clients/accounts',
      label: t('clients.subnav.accounts', 'Accounts'),
      icon: UserCog,
      featureFlag: 'customerPortal',
      permission: 'customers.view',
    },
    {
      key: 'calendar',
      to: '/admin/clients/calendar',
      label: t('clients.subnav.calendar', 'Calendar'),
      icon: Calendar,
      featureFlag: 'calendar',
    },
    {
      key: 'quotes',
      to: '/admin/clients/quotes',
      label: t('clients.subnav.quotes', 'Quotes'),
      icon: FileText,
      featureFlag: 'quotes',
    },
    {
      key: 'contracts',
      to: '/admin/clients/contracts',
      label: t('clients.subnav.contracts', 'Contracts'),
      icon: ScrollText,
      featureFlag: 'contracts',
    },
    {
      key: 'hours',
      to: '/admin/clients/hours',
      label: t('clients.subnav.hours', 'Hours'),
      icon: Clock,
      featureFlag: 'hoursLogging',
    },
    {
      key: 'bills',
      to: '/admin/clients/bills',
      label: t('clients.subnav.bills', 'Invoices'),
      icon: Receipt,
      featureFlag: 'bills',
    },
    // Tax export moved permanently to the Accounting section (it is no
    // longer a CRM sub-feature). See AccountingLayout.
    // Future sub-features:
    //   { key: 'messaging', ... featureFlag: 'messaging' }
    {
      key: 'newsletters',
      to: '/admin/clients/newsletters',
      label: t('clients.subnav.newsletters', 'Newsletters'),
      icon: Megaphone,
      featureFlag: 'newsletters',
      permission: 'newsletters.view',
    },
    {
      key: 'development',
      to: '/admin/clients/development',
      label: t('clients.subnav.development', 'Development'),
      icon: Wrench,
      featureFlag: 'crmDevelopment',
    },
  ];

  return navItems.filter((item) =>
    flags[item.featureFlag] && (!item.permission || hasPermission(item.permission)));
}

export const ClientsLayout: React.FC = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const enabledItems = useClientsNavItems();

  // /admin/clients has no page of its own. Rather than a hard-coded redirect
  // to Accounts — which a newsletters-only role cannot open — land on the
  // first entry this user can actually reach.
  const isSectionRoot = location.pathname.replace(/\/+$/, '') === '/admin/clients';
  if (isSectionRoot && enabledItems.length > 0) {
    return <Navigate to={enabledItems[0].to} replace />;
  }

  // When the parent `clients` flag is on but no sub-feature is enabled,
  // there's nothing to render. Settings → Features is one click away
  // and tells the admin exactly what to flip on.
  if (enabledItems.length === 0) {
    return (
      <div>
        <div className="rounded-xl border border-dashed border-neutral-300 dark:border-neutral-700 bg-neutral-50 dark:bg-neutral-900 p-8 text-center">
          <Briefcase className="w-10 h-10 mx-auto mb-3 text-neutral-400" />
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-1">
            {t('clients.empty.title', 'No CRM features enabled')}
          </h2>
          <p className="text-sm text-neutral-600 dark:text-neutral-400">
            {t(
              'clients.empty.body',
              'Enable Accounts (or another CRM sub-feature) under Settings → Features to get started.',
            )}
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
