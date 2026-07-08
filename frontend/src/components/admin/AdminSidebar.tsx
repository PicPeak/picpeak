import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Calendar,
  Archive,
  BarChart3,
  Settings,
  Activity,
  X,
  Users,
  Briefcase,
  Landmark,
  Mail,
  Workflow,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { settingsService } from '../../services/settings.service';
import { VersionInfo } from './VersionInfo';
import { usePermissions } from '../../contexts/PermissionsContext';
import { useAdminDarkMode } from '../../contexts/AdminDarkModeContext';
import { useFeatureFlags, type FeatureKey } from '../../contexts/FeatureFlagsContext';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { buildResourceUrl } from '../../utils/url';

interface AdminSidebarProps {
  isOpen: boolean;
  onClose: () => void;
  /** Desktop-only: collapse to icon-rail when true. Persisted by parent. */
  collapsed?: boolean;
  /** Desktop-only: toggle for the collapse button rendered in the title bar. */
  onToggleCollapse?: () => void;
}

interface NavItem {
  nameKey: string;
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  permission?: string | false;
  /** Single required flag — entry hidden when this is false. */
  featureFlag?: FeatureKey;
  /**
   * "At least one of these must be on" — used by the Clients section
   * to hide the sidebar entry when the parent flag is on but no
   * child sub-feature is enabled. Empty arrays are treated as no
   * constraint.
   */
  featureFlagsAny?: FeatureKey[];
}

// Sidebar shape after the Settings reorg (#feature-flags-settings-reorg).
//
// Removed (now live as Settings tabs, with redirects from the old
// top-level paths so bookmarks keep working):
//   /admin/email, /admin/branding, /admin/event-types, /admin/backup,
//   /admin/cms.
//
// Feature-gated (only render when the corresponding feature flag is on):
//   Analytics → flags.analytics
//   Users     → flags.userManagement
const navigation: NavItem[] = [
  { nameKey: 'navigation.dashboard', href: '/admin/dashboard', icon: LayoutDashboard, permission: false },
  { nameKey: 'navigation.events',    href: '/admin/events',    icon: Calendar,        permission: 'events.view' },
  { nameKey: 'navigation.archives',  href: '/admin/archives',  icon: Archive,         permission: 'archives.view' },
  { nameKey: 'navigation.messages',  href: '/admin/messages', icon: Mail,             permission: 'email.view',     featureFlag: 'messaging' },
  { nameKey: 'admin.analytics',      href: '/admin/analytics', icon: BarChart3,       permission: 'analytics.view', featureFlag: 'analytics' },
  { nameKey: 'navigation.settings',  href: '/admin/settings',  icon: Settings,        permission: 'settings.view' },
  { nameKey: 'navigation.systemHealth', href: '/admin/system-health', icon: Activity,  permission: 'settings.view' },
  { nameKey: 'navigation.users',     href: '/admin/users',     icon: Users,           permission: 'users.view',     featureFlag: 'userManagement' },
  // Clients section (#354 follow-up) — admin-side surface for the
  // CRM-area sub-features. Today this entry leads to /admin/clients
  // which renders a Settings-style sub-nav with one item (Accounts).
  // When calendar / quotes / bills / messaging ship they slot in as
  // additional sub-nav items inside ClientsLayout without needing
  // their own top-level sidebar entry.
  //
  // Gate uses the parent `clients` flag (master). The Accounts page
  // itself is independently gated by `customerPortal` inside the
  // route tree — that nested check is invisible from here.
  //
  // `permission: 'customers.view'` is the only Clients-area
  // permission today; future sub-features (booking, billing) get
  // their own permission keys and the gate here grows into an OR.
  {
    nameKey: 'navigation.clients', href: '/admin/clients', icon: Briefcase,
    permission: 'customers.view',
    featureFlag: 'clients',
    // Hide the entry when the parent is on but no sub-feature is —
    // there's nothing inside ClientsLayout to link to. Mirror the same
    // set used to derive the parent `clients` flag in
    // FeatureFlagsContext (see clientsDependsOn) so the two checks
    // can't disagree: any sub-feature on lights up the entry, all off
    // hides it. Future siblings (e.g. `messaging`) get appended here
    // AND in the context derivation.
    // taxReport intentionally excluded — Tax moved to the Accounting section
    // and is not a Clients sub-nav item, so it must not reveal Clients (would
    // open an empty ClientsLayout). Mirrors the context's `clients` derivation.
    featureFlagsAny: [
      'customerPortal', 'crmDevelopment', 'quotes', 'bills',
      'hoursLogging', 'contracts', 'calendar', 'projects',
    ],
  },
  // Accounting section (migration 122) — inbound supplier invoices,
  // expenses + re-bill, and the tax report (which relocates here from
  // the CRM sub-nav when `accounting` is on). Gated by the `accounting`
  // master flag; the sub-pages inside AccountingLayout are each
  // independently feature-gated.
  {
    nameKey: 'navigation.accounting', href: '/admin/accounting', icon: Landmark,
    permission: 'accounting.view',
    featureFlag: 'accounting',
  },
  // Workflows (automation engine) — top-level, gated by the `workflows` flag.
  {
    nameKey: 'navigation.workflows', href: '/admin/workflows', icon: Workflow,
    permission: 'workflows.view',
    featureFlag: 'workflows',
  },
];

export const AdminSidebar: React.FC<AdminSidebarProps> = ({ isOpen, onClose, collapsed = false, onToggleCollapse }) => {
  const location = useLocation();
  const { t } = useTranslation();
  const { hasPermission, isLoading: permissionsLoading } = usePermissions();
  const { flags } = useFeatureFlags();
  // Branding lookup for the "logo_position = sidepanel" mode — when
  // chosen, the logo replaces the "PicPeak Admin" text in the brand
  // row, and the favicon takes over in the collapsed icon rail.
  const { data: publicSettings } = usePublicSettings();
  const { isDark } = useAdminDarkMode();
  const logoInSidebar = publicSettings?.branding_logo_position === 'sidepanel';
  // Theme-aware logo with symmetric fallback (one logo serves both modes).
  const lightLogo = publicSettings?.branding_logo_url?.trim();
  const darkLogo = publicSettings?.branding_logo_url_dark?.trim();
  const rawLogoUrl = isDark ? (darkLogo || lightLogo) : (lightLogo || darkLogo);
  const rawFaviconUrl = publicSettings?.branding_favicon_url?.trim();
  const resolvedLogoUrl = rawLogoUrl
    ? (rawLogoUrl.startsWith('http') ? rawLogoUrl : buildResourceUrl(rawLogoUrl))
    : null;
  const resolvedFaviconUrl = rawFaviconUrl
    ? (rawFaviconUrl.startsWith('http') ? rawFaviconUrl : buildResourceUrl(rawFaviconUrl))
    : null;
  // In collapsed rail, prefer the favicon (it's already a square,
  // tight crop). Fall back to the logo when no favicon is set, then
  // to nothing — better an empty rail than a stretched logo.
  const sidebarBrandImageUrl = collapsed
    ? (resolvedFaviconUrl || resolvedLogoUrl)
    : (resolvedLogoUrl || resolvedFaviconUrl);
  const showLogoBrand = logoInSidebar && !!sidebarBrandImageUrl;
  const brandAlt = publicSettings?.branding_company_name?.trim() || t('admin.title');

  const filteredNavigation = navigation.filter((item) => {
    if (item.permission && !hasPermission(item.permission as string)) return false;
    if (item.featureFlag && !flags[item.featureFlag]) return false;
    // featureFlagsAny: entry is hidden when none of the listed
    // sub-flags are on, even if the parent flag IS on. Used by
    // the Clients section so the sidebar entry only appears when
    // there's at least one sub-feature it can link to.
    if (item.featureFlagsAny && item.featureFlagsAny.length > 0
        && !item.featureFlagsAny.some((k) => flags[k])) {
      return false;
    }
    return true;
  });

  // Desktop width: full nav (w-64) vs icon rail (w-16). Mobile is always
  // w-64 since the collapse affordance only applies on lg+ viewports.
  const widthClasses = collapsed ? 'w-64 lg:w-16' : 'w-64';
  const showLabels = !collapsed;

  return (
    <div
      // Right edge drawn via box-shadow rather than `border-r` so the
      // brand row's `border-b` can extend to the sidebar's full width
      // and meet the header's `border-b` cleanly at the L-junction. A
      // 1px border-r would shrink the brand row's content by 1px and
      // leave a visible step in the horizontal divider where the
      // sidebar meets the main column. Shadow uses the same neutral
      // border colors so it looks identical to the previous border.
      className={`fixed inset-y-0 left-0 z-50 ${widthClasses} bg-white dark:bg-neutral-900 shadow-[1px_0_0_0_theme(colors.neutral.200)] dark:shadow-[1px_0_0_0_theme(colors.neutral.700)] transform transition-all duration-200 ease-in-out lg:relative lg:translate-x-0 lg:h-screen ${
        isOpen ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      <div className="flex flex-col h-screen lg:h-full">
        {/* Brand row: title on the left, mobile close (X) on the
            right. The desktop collapse toggle used to live here but
            was moved down next to the version / storage widgets so
            it sits in admins' muscle-memory zone for chrome controls.
            When collapsed on desktop the title hides and the row
            becomes an empty spacer (no rail-width fight). */}
        <div className={`flex items-center h-16 border-b border-neutral-200 dark:border-neutral-700 flex-shrink-0 ${
          collapsed ? 'lg:justify-center lg:px-2 px-6 justify-between' : 'justify-between px-6'
        }`}>
          <div className="flex items-center gap-2 min-w-0">
            {showLogoBrand ? (
              <>
                {/* Logo brand variant — fed by Branding > Logo
                    Position = "Sidebar". On the collapsed rail, only
                    the favicon (or logo as fallback) is shown — sized
                    to fit the 64px-wide rail. Expanded shows the full
                    logo at the same h-8 the admin header uses for
                    visual continuity. */}
                <img
                  src={sidebarBrandImageUrl!}
                  alt={brandAlt}
                  className={collapsed ? 'h-8 w-8 object-contain lg:h-9 lg:w-9' : 'h-8 w-auto object-contain max-w-full'}
                />
                {/* On mobile the rail-narrow style only applies at
                    lg+, so when collapsed=true the mobile view still
                    has the regular w-64 width — show the company name
                    next to the logo so the brand row doesn't feel
                    empty there. */}
                {collapsed && (
                  <span className="text-xl font-bold text-neutral-900 dark:text-neutral-100 lg:hidden truncate">
                    {brandAlt}
                  </span>
                )}
              </>
            ) : (
              <>
                {showLabels && (
                  <span className="text-xl font-bold text-neutral-900 dark:text-neutral-100">{t('admin.title')}</span>
                )}
                {/* When collapsed on desktop the title is hidden; on mobile we
                    always show it because the rail-narrow style only applies at lg+ */}
                {collapsed && (
                  <span className="text-xl font-bold text-neutral-900 dark:text-neutral-100 lg:hidden">{t('admin.title')}</span>
                )}
              </>
            )}
          </div>
          <button
            onClick={onClose}
            className="lg:hidden text-neutral-400 hover:text-neutral-600"
            aria-label="Close sidebar"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Navigation */}
        <nav className={`flex-1 py-4 space-y-1 overflow-y-auto overflow-x-hidden min-h-0 ${
          collapsed ? 'px-4 lg:px-2' : 'px-4'
        }`}>
          {filteredNavigation.map((item) => {
            const isActive = location.pathname === item.href ||
                           (item.href !== '/admin/dashboard' && location.pathname.startsWith(item.href));
            const label = t(item.nameKey);

            return (
              <NavLink
                key={item.nameKey}
                to={item.href}
                onClick={() => onClose()}
                title={collapsed ? label : undefined}
                className={`flex items-center py-2 text-sm font-medium rounded-lg transition-colors ${
                  collapsed ? 'px-3 lg:px-0 lg:justify-center' : 'px-3'
                } ${
                  isActive
                    ? 'bg-accent-dark text-white'
                    : 'text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-900 dark:hover:text-neutral-100'
                }`}
              >
                {/* Selected item: solid accent-dark fill with white text/icon
                    for unambiguous high-contrast selection — matches the
                    .tile-selected pattern used in the customizer. The accent
                    -dark token defaults to the legacy primary green so users
                    who haven't set CI colours yet see no migration regression. */}
                <item.icon className={`w-5 h-5 flex-shrink-0 ${
                  collapsed ? 'mr-3 lg:mr-0' : 'mr-3'
                } ${
                  isActive ? 'text-white' : 'text-neutral-400'
                }`} />
                <span className={collapsed ? 'lg:hidden' : ''}>{label}</span>
              </NavLink>
            );
          })}
        </nav>

        {/* Desktop collapse / expand toggle.
            Lives directly above the version + storage widgets — sits
            in admins' muscle-memory zone for chrome controls and
            stays visible even when the sidebar is collapsed so the
            rail can always be re-expanded. Hidden on mobile (the X
            in the brand row already closes the sheet there). */}
        {onToggleCollapse && (
          <div className={`hidden lg:flex flex-shrink-0 border-t border-neutral-200 dark:border-neutral-700 py-2 ${
            collapsed ? 'justify-center px-2' : 'justify-end px-4'
          }`}>
            <button
              type="button"
              onClick={onToggleCollapse}
              className="inline-flex items-center justify-center w-9 h-9 rounded-md text-neutral-500 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors"
              aria-label={collapsed ? t('admin.expandSidebar', 'Expand sidebar') : t('admin.collapseSidebar', 'Collapse sidebar')}
              title={collapsed ? t('admin.expandSidebar', 'Expand sidebar') : t('admin.collapseSidebar', 'Collapse sidebar')}
            >
              {collapsed
                ? <PanelLeftOpen className="w-5 h-5" />
                : <PanelLeftClose className="w-5 h-5" />}
            </button>
          </div>
        )}

        {/* Bottom section - sticky to bottom (only for users with settings.view permission).
            Hidden on desktop when collapsed since these widgets don't fit in the icon rail;
            mobile keeps them visible because mobile width is always w-64.

            #523 follow-up 2: render OPTIMISTICALLY while permissions are
            still hydrating from the auth context (Rekoo-PS's 3.60.3-beta.0
            screenshot showed the whole bottom block missing on first paint
            right after a deploy — `hasPermission` returns false during the
            ~hundreds-of-ms hydration window, the widgets vanish entirely,
            then re-appear). Only HIDE the block when we definitively know
            the user lacks the permission. VersionInfo + StorageInfo each
            have their own loading states so admins see "—" / a spinner
            instead of nothing during the actual data fetch. */}
        {(permissionsLoading || hasPermission('settings.view')) && (
          <div className={`flex-shrink-0 ${collapsed ? 'lg:hidden' : ''}`}>
            {/* Version Info */}
            <VersionInfo />

            {/* Storage Info */}
            <StorageInfo />
          </div>
        )}
      </div>
    </div>
  );
};

const StorageInfo: React.FC = () => {
  const { t } = useTranslation();
  const { data: storageInfo } = useQuery({
    queryKey: ['storage-info'],
    queryFn: () => settingsService.getStorageInfo(),
    refetchInterval: 60000 // Refresh every minute
  });

  // Don't render anything while loading or if data failed to load
  if (!storageInfo) {
    return null;
  }

  const limitInUse = storageInfo.storage_soft_limit || storageInfo.storage_limit || 1;
  const usagePercent = limitInUse
    ? Math.round((storageInfo.total_used / limitInUse) * 100)
    : 0;
  const isOverSoftLimit = limitInUse && storageInfo.total_used >= limitInUse;
  const progressBarClass = isOverSoftLimit ? 'bg-red-600' : 'bg-accent-dark';
  const containerClass = isOverSoftLimit
    ? 'bg-red-50 dark:bg-red-900/30 border border-red-200 dark:border-red-800'
    : 'bg-neutral-100 dark:bg-neutral-800';
  const softLimitDisplay = settingsService.formatBytes(limitInUse);

  return (
    <div className="p-4 border-t border-neutral-200 dark:border-neutral-700">
      <div className={`${containerClass} rounded-lg p-3 transition-colors duration-300`}>
        <div className="flex items-center justify-between text-sm">
          <span className="text-neutral-700 dark:text-neutral-300">{t('admin.storageUsed')}</span>
          <span className="font-medium text-neutral-900 dark:text-neutral-100">
            {settingsService.formatBytes(storageInfo.total_used)}
          </span>
        </div>
        <div className="mt-2 w-full bg-neutral-200 dark:bg-neutral-700 rounded-full h-2">
          <div
            className={`${progressBarClass} h-2 rounded-full transition-all duration-300`}
            style={{ width: `${Math.min(usagePercent, 100)}%` }}
          />
        </div>
        <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
          {t('admin.storagePercent', { percent: usagePercent, limit: softLimitDisplay })}
        </p>
      </div>
    </div>
  );
};
