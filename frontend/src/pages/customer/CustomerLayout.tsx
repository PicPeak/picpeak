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
  Image as ImageIcon,
  LogOut,
  Menu,
  Receipt,
  User as UserIcon,
  X,
} from 'lucide-react';

import { useCustomerAuth } from '../../contexts/CustomerAuthContext';
import { usePublicSettings } from '../../hooks/usePublicSettings';

interface NavItem {
  to: string;
  labelKey: string;
  fallback: string;
  icon: React.ComponentType<{ className?: string }>;
  /**
   * Optional gate — entry only renders when the matching feature is
   * effective for this customer (i.e. global toggle ON and per-customer
   * flag ON, AND-combined server-side in /api/customer/auth/session).
   * Galleries + Profile are always visible; Calendar/Quotes/Bills are
   * gated.
   */
  feature?: 'calendar' | 'quotes' | 'bills';
}

const NAV: NavItem[] = [
  { to: '/customer/dashboard', labelKey: 'customer.nav.galleries', fallback: 'Galleries', icon: ImageIcon },
  { to: '/customer/calendar', labelKey: 'customer.nav.calendar', fallback: 'Calendar', icon: Calendar, feature: 'calendar' },
  { to: '/customer/quotes', labelKey: 'customer.nav.quotes', fallback: 'Quotes', icon: FileText, feature: 'quotes' },
  { to: '/customer/bills', labelKey: 'customer.nav.bills', fallback: 'Bills', icon: Receipt, feature: 'bills' },
  { to: '/customer/profile', labelKey: 'customer.nav.profile', fallback: 'Profile', icon: UserIcon },
];

export const CustomerLayout: React.FC = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const { customer, features, branding, isAuthenticated, isLoading, logout } = useCustomerAuth();
  const { data: settingsData } = usePublicSettings();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const companyName = settingsData?.branding_company_name?.trim() || 'PicPeak';
  const logoUrl = settingsData?.branding_logo_url?.trim();
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
  // sees a familiar transition. Background uses the theme variable so a
  // dark Branding palette doesn't flash white on first paint.
  if (isLoading) {
    return (
      <div
        className="min-h-screen flex items-center justify-center"
        style={{ backgroundColor: 'var(--color-background, #fafafa)' }}
      >
        <div className="w-12 h-12 border-4 border-t-transparent rounded-full animate-spin" style={{ borderColor: 'var(--color-accent)', borderTopColor: 'transparent' }} />
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/customer/login" replace />;
  }

  const greetingName = customer?.displayName
    || customer?.firstName
    || (customer?.email ? customer.email.split('@')[0] : '');

  return (
    <div
      // The `customer-surface` marker is read by index.css to retheme
      // <Input> components via CSS variables — admin uses tailwind's
      // `dark:` modifier (toggled on <html>), but the customer surface
      // uses theme tokens so we scope the override here.
      className="customer-surface h-screen flex overflow-hidden"
      style={{ backgroundColor: 'var(--color-background, #fafafa)' }}
    >
      {/* Mobile backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black bg-opacity-50 z-40 lg:hidden"
          onClick={() => setSidebarOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Sidebar */}
      <aside
        className={`fixed inset-y-0 left-0 z-50 w-64 border-r transform transition-transform duration-200 ease-in-out lg:relative lg:translate-x-0 lg:h-screen ${
          sidebarOpen ? 'translate-x-0' : '-translate-x-full'
        }`}
        style={{
          backgroundColor: 'var(--color-surface, #ffffff)',
          borderColor: 'var(--color-surface-border, #e5e5e5)',
        }}
      >
        <div className="flex flex-col h-screen lg:h-full">
          {/* Brand */}
          <div
            className="flex items-center justify-between h-16 px-4 border-b flex-shrink-0"
            style={{ borderColor: 'var(--color-surface-border, #e5e5e5)' }}
          >
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
                  className={`flex items-center px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
                    isActive
                      ? 'bg-accent-dark text-white'
                      : 'text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-900 dark:hover:text-neutral-100'
                  }`}
                >
                  {/* Mirrors AdminSidebar's active state exactly: solid
                      accent-dark pill, white icon and label, no extra
                      flex grow on the label so the pill width matches
                      what the admin chrome renders. */}
                  <Icon
                    className={`w-5 h-5 mr-3 ${
                      isActive ? 'text-white' : 'text-neutral-400'
                    }`}
                  />
                  {t(item.labelKey, item.fallback)}
                  {/* Coming-soon pill for the gated entries. Pushed to
                      the right of the label with ml-auto so it doesn't
                      add the flex-1 stretching that was throwing off
                      the active-pill visual. */}
                  {item.feature && (
                    <span
                      className={`ml-auto text-[10px] uppercase tracking-wider px-1.5 py-0.5 rounded font-semibold ${
                        isActive ? 'bg-white/20 text-white' : ''
                      }`}
                      style={isActive ? undefined : {
                        backgroundColor: 'color-mix(in srgb, var(--color-accent) 14%, transparent)',
                        color: 'var(--color-accent)',
                      }}
                    >
                      {t('customer.nav.soon', 'Soon')}
                    </span>
                  )}
                </NavLink>
              );
            })}
          </nav>

          {/* Footer (logout + greeting on a single line, mirrors admin) */}
          <div
            className="border-t px-4 py-3 flex items-center justify-between gap-2"
            style={{ borderColor: 'var(--color-surface-border, #e5e5e5)' }}
          >
            <div className="min-w-0">
              <div className="text-sm font-medium text-theme truncate">{greetingName}</div>
              <div className="text-xs text-muted-theme truncate">{customer?.email}</div>
            </div>
            <button
              type="button"
              onClick={() => { void logout(); }}
              className="p-2 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 text-muted-theme hover:text-theme focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2"
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
        <header
          className="lg:hidden h-14 px-4 flex items-center justify-between border-b flex-shrink-0"
          style={{
            backgroundColor: 'var(--color-surface, #ffffff)',
            borderColor: 'var(--color-surface-border, #e5e5e5)',
          }}
        >
          <button
            type="button"
            onClick={() => setSidebarOpen(true)}
            className="p-2 -ml-2 rounded hover:bg-neutral-100 dark:hover:bg-neutral-800 text-theme"
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

        <footer
          className="py-4 px-4 text-center text-xs"
          style={{ color: 'var(--color-muted-text, #737373)' }}
        >
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
