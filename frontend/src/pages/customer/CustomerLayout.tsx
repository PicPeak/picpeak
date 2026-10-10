/**
 * Customer surface shell (#354).
 *
 * Visually patterned after the admin layout (sidebar + top header + scrollable
 * main) — the maintainer asked for parity with /admin/* so admins dogfooding
 * the customer flow get a familiar structure. Differences from AdminLayout:
 *   - no AdminSidebar / RBAC permission gating; customers don't have roles
 *   - branding header (logo + company name) sits inside the sidebar so the
 *     customer surface looks like *their* photographer's site, not picpeak
 *     chrome
 *   - calendar / quotes / bills nav items are stubbed (coming-soon pages);
 *     they're shown to the user behind a small "Coming soon" tag because
 *     they're built but intentionally inert until the matching backends ship
 *
 * Renders as a layout route (Outlet pattern) so individual pages don't need
 * to wrap their content in `<CustomerLayout>` — same approach AdminLayout uses.
 */
import React, { useState } from 'react';
import { Link, NavLink, Outlet, Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Calendar,
  FileText,
  FolderOpen,
  Image as ImageIcon,
  LogOut,
  Menu,
  Receipt,
  ScrollText,
  User as UserIcon,
  X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

import { useCustomerAuth } from '../../contexts/CustomerAuthContext';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { usePublicDarkMode } from '../../hooks/usePublicDarkMode';
import { useEscapeClose } from '../../components/common/useEscapeClose';

interface NavItem {
  to: string;
  labelKey: string;
  fallback: string;
  icon: LucideIcon;
  /**
   * Optional gate — entry only renders when the matching feature is
   * effective for this customer (i.e. global toggle ON and per-customer
   * flag ON, AND-combined server-side in /api/customer/auth/session).
   * Galleries + Profile are always visible; Calendar/Quotes/Bills are
   * gated.
   */
  feature?: 'calendar' | 'quotes' | 'bills' | 'contracts' | 'documents';
}

const NAV: NavItem[] = [
  { to: '/customer/dashboard', labelKey: 'customer.nav.galleries', fallback: 'Galleries', icon: ImageIcon },
  { to: '/customer/calendar', labelKey: 'customer.nav.calendar', fallback: 'Calendar', icon: Calendar, feature: 'calendar' },
  { to: '/customer/quotes', labelKey: 'customer.nav.quotes', fallback: 'Quotes', icon: FileText, feature: 'quotes' },
  { to: '/customer/contracts', labelKey: 'customer.nav.contracts', fallback: 'Contracts', icon: ScrollText, feature: 'contracts' },
  { to: '/customer/bills', labelKey: 'customer.nav.bills', fallback: 'Invoices', icon: Receipt, feature: 'bills' },
  { to: '/customer/documents', labelKey: 'customer.nav.documents', fallback: 'Documents', icon: FolderOpen, feature: 'documents' },
  { to: '/customer/profile', labelKey: 'customer.nav.profile', fallback: 'Profile', icon: UserIcon },
];

export const CustomerLayout: React.FC = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const { customer, features, branding, isAuthenticated, isLoading, logout } = useCustomerAuth();
  const { data: settingsData } = usePublicSettings();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  useEscapeClose(sidebarOpen, () => setSidebarOpen(false));

  const companyName = settingsData?.branding_company_name?.trim() || 'PicPeak';
  // The portal follows the operator's palette (usePublicDarkMode puts the
  // theme tokens in charge on <html>, dialogs included). `isDark` picks the
  // logo; symmetric fallback so a single uploaded logo serves both modes.
  const { isDark: customerIsDark } = usePublicDarkMode();
  const lightLogo = settingsData?.branding_logo_url?.trim();
  const darkLogo = settingsData?.branding_logo_url_dark?.trim();
  const logoUrl = customerIsDark ? (darkLogo || lightLogo) : (lightLogo || darkLogo);
  const resolvedLogoUrl = logoUrl || '/picpeak-logo-transparent.png';

  // Filter out feature-gated entries the customer can't see. Galleries +
  // Profile have no feature property, so they're always present.
  const visibleNav = NAV.filter((item) => !item.feature || features[item.feature] === true);

  // Branding visibility — admin can hide either piece independently. If
  // both are hidden the brand link still exists (you can click it to
  // reach /customer/dashboard) but renders empty space at zero height.
  const showLogo = branding.showLogo;
  const showCompanyName = branding.showCompanyName;

  // Loading screen mirrors AdminLayout's so admin-as-customer dogfooding
  // sees a familiar transition. Background uses the theme token so a
  // dark Branding palette doesn't flash white on first paint.
  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background">
        <div className="w-12 h-12 border-4 border-accent border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!isAuthenticated) {
    // Keep the requested page so a deep link (e.g. from an email) survives
    // the login. The login page only follows it back into /customer/*, and
    // the target page re-checks access after login.
    const returnTo = `${location.pathname}${location.search}`;
    return <Navigate to={`/customer/login?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }

  const greetingName = customer?.displayName
    || customer?.firstName
    || (customer?.email ? customer.email.split('@')[0] : '');

  return (
    <div className="h-screen flex overflow-hidden bg-background">
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 border-r bg-surface border-border-token transform transition-transform duration-200 ease-in-out lg:relative lg:translate-x-0 lg:h-screen ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
      >
        <div className="flex flex-col h-screen lg:h-full">
          {/* Brand */}
          <div className="flex items-center justify-between h-16 px-4 border-b border-border-token flex-shrink-0">
            <Link
              to="/customer/dashboard"
              className="flex items-center gap-2 min-w-0 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 rounded"
              onClick={() => setSidebarOpen(false)}
            >
              {showLogo && (
                <img
                  src={resolvedLogoUrl}
                  alt={companyName}
                  className="h-8 w-auto object-contain flex-shrink-0"
                />
              )}
              {showCompanyName && (
                <span className="text-sm font-semibold text-theme truncate">
                  {companyName}
                </span>
              )}
            </Link>
            <button
              type="button"
              onClick={() => setSidebarOpen(false)}
              className="lg:hidden text-muted-theme hover:text-theme"
              aria-label={t('common.close', 'Close')}
            >
              <X className="w-6 h-6" />
            </button>
          </div>

          {/* Navigation */}
          <nav className="flex-1 px-3 py-4 space-y-1 overflow-y-auto min-h-0">
            {visibleNav.map((item) => {
              const Icon = item.icon;
              // Active when the path matches or starts with the entry —
              // dashboard stays active only on exact match so the other
              // nav entries don't double-highlight on /customer/dashboard.
              const isActive = item.to === '/customer/dashboard'
                ? location.pathname === item.to
                : location.pathname === item.to || location.pathname.startsWith(`${item.to}/`);
              return (
                <NavLink
                  key={item.to}
                  to={item.to}
                  onClick={() => setSidebarOpen(false)}
                  // Active: the filled accent with the label colour applyTheme()
                  // picks for it. Rest: the theme's text, the elevated
                  // surface on hover (the admin sidebar's subtle grey).
                  className={`flex items-center px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                    isActive ? 'bg-accent-strong text-accent-fg' : 'text-theme hover:bg-elevated'
                  }`}
                >
                  <Icon className="w-5 h-5 mr-3" />
                  {t(item.labelKey, item.fallback)}
                </NavLink>
              );
            })}
          </nav>

          {/* Footer (logout + greeting on a single line, mirrors admin) */}
          <div className="border-t border-border-token px-4 py-3 flex items-center justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-medium text-theme truncate">{greetingName}</div>
              <div className="text-xs text-muted-theme truncate">{customer?.email}</div>
            </div>
            <button
              type="button"
              onClick={() => { void logout(); }}
              className="p-2 rounded hover-surface text-muted-theme hover:text-theme focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
              aria-label={t('common.logout', 'Logout')}
              title={t('common.logout', 'Logout')}
            >
              <LogOut className="w-5 h-5" />
            </button>
          </div>
        </div>
      </aside>

      {/* Main column */}
      <div className="flex-1 flex flex-col min-w-0 h-screen">
        <header className="lg:hidden h-14 px-4 flex items-center justify-between border-b bg-surface border-border-token flex-shrink-0">
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="p-2 -ml-2 rounded hover-surface text-theme"
            aria-label={t('common.menu', 'Menu')}
          >
            <Menu className="w-6 h-6" />
          </button>
          <span className="text-sm font-semibold text-theme truncate">{companyName}</span>
          <span className="w-9" aria-hidden="true" />
        </header>

        <main id="customer-main" className="flex-1 overflow-y-auto">
          <Outlet />
        </main>

        <footer className="py-4 px-4 text-center text-xs text-muted-theme">
          <p>
            {settingsData?.branding_footer_text
              || `© ${new Date().getFullYear()} ${companyName}. All rights reserved.`}
          </p>
        </footer>
      </div>
    </div>
  );
};

export default CustomerLayout;
