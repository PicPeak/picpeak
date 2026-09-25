import React, { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  ArrowLeft,
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
  Github,
  Send,
  type LucideIcon,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { settingsService } from '../../services/settings.service';
import { VersionInfo } from './VersionInfo';
import { repoUrl } from '../../utils/githubReleaseUrl';
import { usePermissions } from '../../contexts/PermissionsContext';
import { useAdminDarkMode } from '../../contexts/AdminDarkModeContext';
import { useFeatureFlags, type FeatureKey } from '../../contexts/FeatureFlagsContext';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { buildResourceUrl } from '../../utils/url';
import {
  DEFAULT_SETTINGS_TAB,
  SETTINGS_PATH,
  isValidSettingsTab,
  settingsTabHref,
  useSettingsNavGroups,
} from '../../features/settings/settingsNav';
import { useClientsNavItems } from './ClientsLayout';
import { useAccountingNavItems } from './AccountingLayout';

// A section that takes over the sidebar while the admin is inside it:
// the main menu is replaced by the section's own navigation, with a
// "Back to menu" row and the section title pinned on top.
interface SidebarSectionItem {
  key: string;
  href: string;
  label: string;
  icon: LucideIcon;
  active: boolean;
  /** Navigate with history.replace (tab switches inside one page). */
  replace?: boolean;
}
interface SidebarSectionGroup {
  /** Omitted for sections with a single, unlabelled list. */
  label?: string;
  items: SidebarSectionItem[];
}
interface SidebarSection {
  key: string;
  /** Route prefix that activates the section. */
  path: string;
  title: string;
  icon: LucideIcon;
  groups: SidebarSectionGroup[];
}

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
  /**
   * Alternative permissions, any ONE of which reveals the entry. For a
   * section whose sub-features are gated independently server-side — Clients
   * hosts both customer accounts and newsletters, and the backend supports a
   * role holding `newsletters.view` without `customers.view` (#1264).
   */
  permissionAny?: string[];
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
// Exported so Settings → Features can render its "Sidebar preview" against
// the same declaration the real sidebar uses (it used to keep a second,
// hand-maintained array that only knew about 2 of the feature gates).
export const adminNavigation: NavItem[] = [
  { nameKey: 'navigation.dashboard', href: '/admin/dashboard', icon: LayoutDashboard, permission: false },
  { nameKey: 'navigation.events',    href: '/admin/events',    icon: Calendar,        permission: 'events.view' },
  { nameKey: 'navigation.archives',  href: '/admin/archives',  icon: Archive,         permission: 'archives.view' },
  { nameKey: 'navigation.transfers', href: '/admin/transfers', icon: Send,            permission: 'events.view', featureFlag: 'transfers' },
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
    // Any of these opens the section; each sub-page is gated on its own
    // permission once inside.
    permissionAny: ['customers.view', 'newsletters.view'],
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
      // #1264 — newsletters is a Clients child and must light up the entry,
      // or a newsletter-only install has no way into the section.
      'newsletters',
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

  const filteredNavigation = adminNavigation.filter((item) => {
    if (item.permission && !hasPermission(item.permission as string)) return false;
    if (item.permissionAny?.length
      && !item.permissionAny.some((p) => hasPermission(p))) return false;
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

  // Sections take over the sidebar: while the admin is inside Settings,
  // CRM or Accounting the main menu is replaced by that section's
  // navigation, with a "Back to menu" row on top. `peekMain` lets the
  // admin flip back to the main menu without leaving the page; it resets
  // on every navigation so clicking the section entry again (or
  // deep-linking) lands in section mode.
  const [peekMain, setPeekMain] = useState(false);
  useEffect(() => { setPeekMain(false); }, [location.key]);

  const settingsGroups = useSettingsNavGroups();
  const clientsItems = useClientsNavItems();
  const accountingItems = useAccountingNavItems();
  const urlTab = new URLSearchParams(location.search).get('tab');
  const activeSettingsTab = isValidSettingsTab(urlTab) ? urlTab : DEFAULT_SETTINGS_TAB;
  const isUnder = (href: string) =>
    location.pathname === href || location.pathname.startsWith(`${href}/`);

  const sections: SidebarSection[] = [
    {
      key: 'settings',
      path: SETTINGS_PATH,
      title: t('navigation.settings'),
      icon: Settings,
      groups: settingsGroups.map((g) => ({
        label: g.label,
        items: g.items.map((i) => ({
          key: i.key,
          href: settingsTabHref(i.key),
          label: i.label,
          icon: i.icon,
          active: activeSettingsTab === i.key,
          replace: true,
        })),
      })),
    },
    {
      key: 'clients',
      path: '/admin/clients',
      title: t('navigation.clients'),
      icon: Briefcase,
      groups: [{
        items: clientsItems.map((i) => ({
          key: i.key, href: i.to, label: i.label, icon: i.icon, active: isUnder(i.to),
        })),
      }],
    },
    {
      key: 'accounting',
      path: '/admin/accounting',
      title: t('navigation.accounting'),
      icon: Landmark,
      groups: [{
        items: accountingItems.map((i) => ({
          key: i.key, href: i.to, label: i.label, icon: i.icon, active: isUnder(i.to),
        })),
      }],
    },
  ];
  const activeSection = sections.find((sec) => isUnder(sec.path)) ?? null;
  const section = peekMain ? null : activeSection;

  // Desktop width: full nav (w-64) vs icon rail (w-16). Mobile is always
  // w-64 since the collapse affordance only applies on lg+ viewports.
  const widthClasses = collapsed ? 'w-64 lg:w-16' : 'w-64';
  const showLabels = !collapsed;

  const itemClass = (isActive: boolean) => `flex items-center py-2 text-sm font-medium rounded-lg transition-colors ${
    collapsed ? 'px-3 lg:px-0 lg:justify-center' : 'px-3'
  } ${
    isActive
      ? 'bg-accent-dark text-white'
      : 'text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800 hover:text-neutral-900 dark:hover:text-neutral-100'
  }`;
  const iconClass = (isActive: boolean) => `w-5 h-5 flex-shrink-0 ${
    collapsed ? 'mr-3 lg:mr-0' : 'mr-3'
  } ${
    isActive ? 'text-white' : 'text-neutral-400'
  }`;

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

        {/* Section mode: back row + section title pinned above the
            scrolling list so they stay reachable however long the list
            gets. */}
        {section && (
          <div className={`flex-shrink-0 border-b border-neutral-200 dark:border-neutral-700 pt-3 pb-2 animate-panel-in-right ${
            collapsed ? 'px-4 lg:px-2' : 'px-4'
          }`}>
            <button
              type="button"
              onClick={() => setPeekMain(true)}
              title={collapsed ? t('admin.backToMenu', 'Back to menu') : undefined}
              className={`w-full flex items-center py-1.5 text-xs font-medium rounded-lg text-neutral-500 dark:text-neutral-400 hover:text-neutral-900 dark:hover:text-neutral-100 hover:bg-neutral-100 dark:hover:bg-neutral-800 transition-colors ${
                collapsed ? 'px-3 lg:px-0 lg:justify-center' : 'px-3'
              }`}
            >
              <ArrowLeft className={`w-4 h-4 flex-shrink-0 ${collapsed ? 'mr-2 lg:mr-0' : 'mr-2'}`} />
              <span className={collapsed ? 'lg:hidden' : ''}>{t('admin.backToMenu', 'Back to menu')}</span>
            </button>
            <div className={`flex items-center px-3 mt-2 mb-1 ${collapsed ? 'lg:hidden' : ''}`}>
              <section.icon className="w-5 h-5 mr-3 flex-shrink-0 text-neutral-700 dark:text-neutral-300" />
              <span className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
                {section.title}
              </span>
            </div>
          </div>
        )}

        {/* Navigation. Two panels share this slot: the main menu and the
            active section's navigation (see `section`). Re-keying the
            wrapper replays a short slide so the switch reads as a
            drill-down. */}
        <nav
          aria-label={section ? section.title : undefined}
          className={`flex-1 py-4 overflow-y-auto overflow-x-hidden min-h-0 ${
            collapsed ? 'px-4 lg:px-2' : 'px-4'
          }`}
        >
          {section ? (
            <div key={section.key} className="animate-panel-in-right">
              <div className={collapsed ? 'space-y-4 lg:space-y-2' : 'space-y-4'}>
                {section.groups.map((group, groupIndex) => (
                  <div key={group.label ?? groupIndex}>
                    {group.label && (
                      <h3 className={`px-3 mb-1 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400 ${
                        collapsed ? 'lg:hidden' : ''
                      }`}>
                        {group.label}
                      </h3>
                    )}
                    {/* Collapsed rail: the group label has no room, so a
                        hairline between groups keeps the icon column
                        readable. */}
                    {collapsed && groupIndex > 0 && (
                      <div className="hidden lg:block mx-2 mb-2 border-t border-neutral-200 dark:border-neutral-700" />
                    )}
                    <div className="space-y-0.5">
                      {group.items.map((item) => {
                        const isActive = item.active;
                        return (
                          <NavLink
                            key={item.key}
                            to={item.href}
                            replace={item.replace}
                            onClick={() => onClose()}
                            title={collapsed ? item.label : undefined}
                            aria-current={isActive ? 'page' : undefined}
                            className={itemClass(isActive)}
                          >
                            <item.icon className={iconClass(isActive)} />
                            <span className={`truncate ${collapsed ? 'lg:hidden' : ''}`}>{item.label}</span>
                          </NavLink>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            <div key="main" className={`space-y-1 ${peekMain ? 'animate-panel-in-left' : ''}`}>
              {filteredNavigation.map((item) => {
                const isActive = location.pathname === item.href ||
                               (item.href !== '/admin/dashboard' && location.pathname.startsWith(item.href));
                const label = t(item.nameKey);

                return (
                  <NavLink
                    key={item.nameKey}
                    to={item.href}
                    onClick={() => {
                      // Clicking the current section's entry while peeking
                      // at the main menu hands the sidebar back to section
                      // mode even if the URL doesn't change.
                      if (item.href === activeSection?.path) setPeekMain(false);
                      onClose();
                    }}
                    title={collapsed ? label : undefined}
                    className={itemClass(isActive)}
                  >
                    {/* Selected item: solid accent-dark fill with white text/icon
                        for unambiguous high-contrast selection — matches the
                        .tile-selected pattern used in the customizer. The accent
                        -dark token defaults to the legacy primary green so users
                        who haven't set CI colours yet see no migration regression. */}
                    <item.icon className={iconClass(isActive)} />
                    <span className={collapsed ? 'lg:hidden' : ''}>{label}</span>
                  </NavLink>
                );
              })}
            </div>
          )}
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
        {/* Hidden in section mode: the section list needs the vertical
            space more than the version / storage widgets, which are one
            click away on the main menu. */}
        {!section && (permissionsLoading || hasPermission('settings.view')) && (
          <div className={`flex-shrink-0 ${collapsed ? 'lg:hidden' : ''}`}>
            {/* Version Info */}
            <VersionInfo />

            {/* Storage Info */}
            <StorageInfo />

            {/* Link to the project on GitHub (#778). Subtle footer row so
                admins can reach the repo — star, source, report an issue —
                from anywhere in the dashboard, not just the setup screen. */}
            <a
              href={repoUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="mx-4 mb-3 flex items-center gap-2 text-xs text-neutral-500 dark:text-neutral-400 hover:text-neutral-700 dark:hover:text-neutral-200 transition-colors"
              title={t('admin.viewOnGithub', 'View PicPeak on GitHub')}
            >
              <Github className="w-3.5 h-3.5" />
              <span>{t('admin.viewOnGithub', 'View PicPeak on GitHub')}</span>
            </a>
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
            {/* The `+` marks a floor: part of the storage root was unreadable,
                so the real figure — and the percentage below — is higher than
                this. Without it an EACCES subtree reads as "safely under the
                limit" (#1164). */}
            {settingsService.formatBytes(storageInfo.total_used)}{storageInfo.storage_partial ? '+' : ''}
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
