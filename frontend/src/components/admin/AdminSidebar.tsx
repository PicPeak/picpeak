import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useGuardedLinkClick, useLeaveGuard } from '../../contexts/UnsavedChangesContext';
import {
  ArrowLeft,
  LayoutDashboard,
  BarChart3,
  Settings,
  X,
  Briefcase,
  Landmark,
  Mail,
  Share2,
  Workflow,
  PanelLeftClose,
  PanelLeftOpen,
  Github,
  Search,
  type LucideIcon,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { settingsService } from '../../services/settings.service';
import { VersionInfo } from './VersionInfo';
import { DashboardHomeLink } from './DashboardHomeLink';
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
  searchScore,
  settingsTabHref,
  useSettingsNavGroups,
} from '../../features/settings/settingsNav';
import { useClientsNavItems } from './ClientsLayout';
import { useAccountingNavItems } from './AccountingLayout';
import { useSharingNavItems, SHARING_PATHS } from './sharingNav';
import { useAutomationNavItems } from './AutomationLayout';

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
  /** Extra search terms, so the Settings filter finds a tab by what it does. */
  keywords?: string[];
}
interface SidebarSectionGroup {
  /** Omitted for sections with a single, unlabelled list. */
  label?: string;
  items: SidebarSectionItem[];
}
interface SidebarSection {
  key: string;
  /**
   * Route prefixes that activate the section, and the first of them is where
   * the main-menu entry points by default. Usually one, but Sharing spans
   * /admin/events and /admin/transfers: a section is a grouping of pages, and
   * pages it groups need not share a URL prefix.
   */
  paths: string[];
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

// Sidebar shape after the Settings reorg (#feature-flags-settings-reorg)
// and the navigation cleanup that followed it.
//
// Removed (now live as Settings tabs, with redirects from the old
// top-level paths so bookmarks keep working):
//   /admin/email, /admin/branding, /admin/event-types, /admin/backup,
//   /admin/cms, /admin/users, /admin/system-health.
//
// Folded into sections (same: redirects kept):
//   /admin/archives  → Events section
//   /admin/transfers → Sharing section (same URL, new home)
//   /admin/workflows → Automation section
//
// What is left is eight entries, of which four disappear entirely on an
// install with the matching features off.
//
// Feature-gated (only render when the corresponding feature flag is on):
//   Analytics  → flags.analytics
//   Messages   → flags.messaging
//   Automation → flags.workflows | flags.reminderEmails
// Exported so Settings → Features can render its "Sidebar preview" against
// the same declaration the real sidebar uses (it used to keep a second,
// hand-maintained array that only knew about 2 of the feature gates).
//
// Section entries (Sharing, Automation, Settings) carry their
// FLAGS here — the preview reads them and applies nothing else — but no
// permission fields. Their visibility is decided in the sidebar by asking the
// section's own nav hook whether it has anything to show, which cannot drift
// from what is inside the way a duplicated permission list can.
export const adminNavigation: NavItem[] = [
  { nameKey: 'navigation.dashboard', href: '/admin/dashboard', icon: LayoutDashboard, permission: false },
  // Sharing section — the three ways files reach someone: the galleries, the
  // archived ones, and a direct PicTransfer link.
  { nameKey: 'navigation.sharing',   href: '/admin/events',    icon: Share2 },
  // Messages is a single page, so it stays a plain entry. It briefly shared a
  // "Communication" section with PicTransfer; sending files is not messaging,
  // and a section wrapping one page is worse than the page itself.
  {
    nameKey: 'navigation.messages', href: '/admin/messages', icon: Mail,
    permission: 'email.view', featureFlag: 'messaging',
  },
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
  // Automation section — the workflow engine plus the reminder email
  // templates it sends (which came here from Settings).
  {
    nameKey: 'navigation.automation', href: '/admin/automation', icon: Workflow,
    featureFlagsAny: ['workflows', 'reminderEmails'],
  },
  { nameKey: 'admin.analytics',      href: '/admin/analytics', icon: BarChart3,       permission: 'analytics.view', featureFlag: 'analytics' },
  { nameKey: 'navigation.settings',  href: '/admin/settings',  icon: Settings },
];

/**
 * Does this main-menu entry pass its declared permission and feature gates?
 *
 * Exported because the command palette indexes the same menu and must not
 * offer a destination the sidebar hides. Section entries are NOT decided here
 * — their visibility follows the item count inside the section (see
 * `sectionItemCounts`), which is narrower and cannot drift.
 */
/**
 * Main-menu entries that open a section rather than a page.
 *
 * The sidebar decides these from the section's own contents and the command
 * palette indexes their sub-pages instead of the entry, so both need the same
 * list — and a section added to one but not the other would be indexed through
 * `navItemAllowed`, which returns true for everyone because a section entry
 * carries no permission of its own.
 */
export const SECTION_PATHS: readonly string[] = [
  SETTINGS_PATH, ...SHARING_PATHS,
  '/admin/automation', '/admin/clients', '/admin/accounting',
];

export function navItemAllowed(
  item: NavItem,
  hasPermission: (p: string) => boolean,
  flags: ReturnType<typeof useFeatureFlags>['flags'],
): boolean {
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
}

export const AdminSidebar: React.FC<AdminSidebarProps> = ({ isOpen, onClose, collapsed = false, onToggleCollapse }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const { confirmLeave, isAnyDirty } = useLeaveGuard();
  // A settings form with unsaved edits gets to say no before the sidebar
  // navigates away from it (UnsavedChangesProvider).
  const guardedLinkClick = useGuardedLinkClick();
  const guardedClick = (e: React.MouseEvent, href: string, replace: boolean | undefined, after: () => void) =>
    guardedLinkClick(e, href, { replace, after });
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

  const settingsGroups = useSettingsNavGroups();
  const sharingItems = useSharingNavItems();
  const automationItems = useAutomationNavItems();

  // A section entry follows what is actually inside the section. Each of
  // these hooks already applies that section's flags AND permissions, so
  // asking it for a count is both the narrowest correct gate and the one
  // that cannot drift from the section's contents — the failure this
  // replaces is an entry that opens an empty section (or, worse, a page the
  // backend then 403s). Settings needs it because its tabs accept narrower
  // permissions than `settings.view`; the rest because their sub-pages are
  // independently flagged.
  //
  // `entry` is where the menu entry points. It is NOT always the section root:
  // /admin/events is the events list, which 403s for a role holding only
  // `archives.view` — and that role legitimately has the section, because
  // Archives is in it. Clients, Accounting, Communication and Automation each
  // redirect their root to the first reachable child; Events has no such root
  // to redirect, so the entry aims at the first item directly. Settings keeps
  // its own root, which snaps to a permitted tab by itself.
  const sectionState: Record<string, { count: number; entry?: string }> = {
    [SETTINGS_PATH]: { count: settingsGroups.length },
    '/admin/events': { count: sharingItems.length, entry: sharingItems[0]?.to },
    '/admin/automation': { count: automationItems.length },
    // Clients and Accounting keep the declared permission/flag gating they
    // already had. Converting them to count-gating would be an improvement,
    // but it is a behaviour change to sections this PR does not otherwise
    // touch, so it stays out of this diff.
  };

  const filteredNavigation = adminNavigation.filter((item) => {
    const section = sectionState[item.href];
    if (section) return section.count > 0;
    return navItemAllowed(item, hasPermission, flags);
  });

  /** Where the main-menu entry for `href` should actually navigate. */
  const entryHref = (href: string) => sectionState[href]?.entry ?? href;

  // Sections take over the sidebar: while the admin is inside Settings,
  // CRM or Accounting the main menu is replaced by that section's
  // navigation, with a "Back to menu" row on top. `peekMain` lets the
  // admin flip back to the main menu without leaving the page; it resets
  // on every navigation so clicking the section entry again (or
  // deep-linking) lands in section mode.
  const [peekMain, setPeekMain] = useState(false);
  useEffect(() => { setPeekMain(false); }, [location.key]);

  const clientsItems = useClientsNavItems();
  const accountingItems = useAccountingNavItems();
  const urlTab = new URLSearchParams(location.search).get('tab');
  const activeSettingsTab = isValidSettingsTab(urlTab) ? urlTab : DEFAULT_SETTINGS_TAB;
  const isUnder = (href: string) =>
    location.pathname === href || location.pathname.startsWith(`${href}/`);

  /**
   * Mark the matching item with the LONGEST path as active, not every item
   * whose path is a prefix of the URL. The Events section is the first one
   * where a sub-page lives under a sibling entry's path
   * (/admin/events/archives under /admin/events), and a plain prefix test
   * highlights Events and Archives at the same time. Longest-prefix-wins is
   * the general rule; it is a no-op for sections whose items don't nest.
   */
  const activeKeys = <T extends { key: string; to: string }>(items: T[]): Set<string> => {
    const matches = items.filter((i) => isUnder(i.to));
    if (matches.length === 0) return new Set();
    const longest = matches.reduce((a, b) => (b.to.length > a.to.length ? b : a));
    return new Set([longest.key]);
  };
  const activeSharing = activeKeys(sharingItems);
  const activeAutomation = activeKeys(automationItems);

  const sections: SidebarSection[] = [
    {
      key: 'settings',
      paths: [SETTINGS_PATH],
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
          keywords: i.keywords,
        })),
      })),
    },
    {
      key: 'clients',
      paths: ['/admin/clients'],
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
      paths: ['/admin/accounting'],
      title: t('navigation.accounting'),
      icon: Landmark,
      groups: [{
        items: accountingItems.map((i) => ({
          key: i.key, href: i.to, label: i.label, icon: i.icon, active: isUnder(i.to),
        })),
      }],
    },
    {
      key: 'sharing',
      // Two trees, because PicTransfer keeps its own top-level URL rather than
      // being renamed into the events tree just to sit in this section.
      paths: [...SHARING_PATHS],
      title: t('navigation.sharing', 'Sharing'),
      icon: Share2,
      groups: [{
        items: sharingItems.map((i) => ({
          key: i.key, href: i.to, label: i.label, icon: i.icon, active: activeSharing.has(i.key),
        })),
      }],
    },
    {
      key: 'automation',
      paths: ['/admin/automation'],
      title: t('navigation.automation', 'Automation'),
      icon: Workflow,
      groups: [{
        items: automationItems.map((i) => ({
          key: i.key, href: i.to, label: i.label, icon: i.icon, active: activeAutomation.has(i.key),
        })),
      }],
    },
  ];
  const activeSection = sections.find((sec) => sec.paths.some(isUnder)) ?? null;
  const section = peekMain ? null : activeSection;

  // Settings is 30 tabs in 8 groups — long enough that scanning it is the
  // slow part. Only Settings gets the filter; every other section is short
  // enough to read at a glance, and a search box on a list of three would be
  // noise.
  const searchable = section?.key === 'settings' && !collapsed;
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);
  // Leaving the section (or collapsing to the rail) drops the filter, so
  // coming back never shows a mysteriously short list.
  useEffect(() => { if (!searchable) setQuery(''); }, [searchable]);

  const sectionGroups = useMemo(() => {
    if (!section) return [];
    if (!searchable || !query.trim()) return section.groups;
    return section.groups
      .map((g) => ({
        ...g,
        items: g.items
          .map((i) => ({ item: i, score: searchScore(query, i.label, i.keywords) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score)
          .map((r) => r.item),
      }))
      .filter((g) => g.items.length > 0);
  }, [section, searchable, query]);

  const firstMatch = sectionGroups[0]?.items[0];

  // Desktop width: full nav (w-64) vs icon rail (w-16). Mobile is always
  // w-64 since the collapse affordance only applies on lg+ viewports.
  const widthClasses = collapsed ? 'w-64 lg:w-16' : 'w-64';
  const showLabels = !collapsed;

  const itemClass = (isActive: boolean) => `flex items-center py-2 text-sm font-medium rounded-lg transition-colors ${
    collapsed ? 'px-3 lg:px-0 lg:justify-center' : 'px-3'
  } ${
    isActive
      ? 'bg-accent-dark text-white'
      : 'text-body hover:bg-hover-soft hover:text-heading'
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
      className={`fixed inset-y-0 left-0 z-50 ${widthClasses} bg-shell shadow-[1px_0_0_0_theme(colors.neutral.200)] dark:shadow-[1px_0_0_0_theme(colors.neutral.700)] transform transition-all duration-200 ease-in-out lg:relative lg:translate-x-0 lg:h-screen ${
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
        {/* The brand doubles as the home button: the link carries the
            row's padding so the whole row (minus the mobile close button)
            goes to the dashboard, asking first if a form is dirty. */}
        <div className="flex items-stretch h-16 border-b border-line flex-shrink-0">
          <DashboardHomeLink
            onNavigate={onClose}
            className={`flex flex-1 items-center gap-2 min-w-0 hover:bg-hover-soft transition-colors focus-visible:ring-inset ${
              collapsed ? 'lg:justify-center lg:px-2 px-6' : 'px-6'
            }`}
          >
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
                  <span className="text-xl font-bold text-heading lg:hidden truncate">
                    {brandAlt}
                  </span>
                )}
              </>
            ) : (
              <>
                {showLabels && (
                  <span className="text-xl font-bold text-heading">{t('admin.title')}</span>
                )}
                {/* When collapsed on desktop the title is hidden; on mobile we
                    always show it because the rail-narrow style only applies at lg+ */}
                {collapsed && (
                  <span className="text-xl font-bold text-heading lg:hidden">{t('admin.title')}</span>
                )}
                {/* The collapsed desktop rail has no wordmark, and the row is
                    the home link, so it shows the Dashboard icon rather than
                    an empty, focusable target. */}
                {collapsed && (
                  <LayoutDashboard
                    role="img"
                    aria-label={t('navigation.dashboard', 'Dashboard')}
                    className="hidden lg:block w-5 h-5 text-body"
                  />
                )}
              </>
            )}
          </DashboardHomeLink>
          <button
            onClick={onClose}
            className="lg:hidden px-6 text-faint hover:text-body"
            aria-label="Close sidebar"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Section mode: section title + back row pinned above the
            scrolling list so they stay reachable however long the list
            gets. The sidebar reads top-down as "brand → where am I →
            back → pages". The back row uses the item styles so it sits
            in the same type scale and icon column as the list. The
            brand row above stays the brand (logo or wordmark) in every
            mode — see issue 1712. On the collapsed rail the title hides
            and the active item identifies the section. */}
        {section && (
          <div className="flex-shrink-0 animate-panel-in-right">
            {/* One rule, under the back row: it marks the boundary between
                leaving the section and navigating inside it. The filter keeps
                no rule of its own — two hairlines inside four rows read as
                three separate things stacked above the list (c21ce2f5), and
                the filter belongs with the list it filters. */}
            <div className={`border-b border-line py-2 ${
              collapsed ? 'px-4 lg:px-2' : 'px-4'
            }`}>
              <div className={`flex items-center px-3 mt-1 mb-2 ${collapsed ? 'lg:hidden' : ''}`}>
                <section.icon className="w-5 h-5 mr-3 flex-shrink-0 text-body" />
                <span className="text-xl font-semibold text-heading truncate">{section.title}</span>
              </div>
              <button
                type="button"
                onClick={() => setPeekMain(true)}
                title={collapsed ? t('admin.backToMenu', 'Back to menu') : undefined}
                className={`w-full text-left ${itemClass(false)}`}
              >
                <ArrowLeft className={iconClass(false)} />
                <span className={collapsed ? 'lg:hidden' : ''}>{t('admin.backToMenu', 'Back to menu')}</span>
              </button>
            </div>
            {searchable && (
              <div className="px-4 py-2">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400 pointer-events-none" />
                  <input
                    ref={searchRef}
                    type="search"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Escape') { setQuery(''); return; }
                      // Enter goes to the best match, so a filter that has
                      // narrowed to one result doesn't still need the mouse.
                      // It leaves the page, so it owes the open form the same
                      // question every other route out of here asks — clicks
                      // go through guardedClick, the palette through its own
                      // confirmLeave, and this was the one path that did not.
                      if (e.key === 'Enter' && firstMatch) {
                        e.preventDefault();
                        const go = () => {
                          navigate(firstMatch.href, { replace: !!firstMatch.replace });
                          onClose();
                        };
                        if (!isAnyDirty) { go(); return; }
                        void confirmLeave().then((ok) => { if (ok) go(); });
                      }
                    }}
                    placeholder={t('settings.search.placeholder', 'Search settings…')}
                    aria-label={t('settings.search.label', 'Search settings')}
                    className="w-full pl-9 pr-3 py-1.5 text-sm rounded-lg bg-subtle text-heading placeholder:text-muted border border-transparent focus:bg-panel focus:border-line-strong focus:outline-none focus:ring-2 focus:ring-primary-500"
                  />
                </div>
              </div>
            )}
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
                {sectionGroups.length === 0 && (
                  <p className="px-3 py-2 text-sm text-muted">
                    {t('settings.search.noResults', 'No settings match “{{query}}”.', { query })}
                  </p>
                )}
                {sectionGroups.map((group, groupIndex) => (
                  <div key={group.label ?? groupIndex}>
                    {group.label && (
                      <h3 className={`px-3 mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted ${
                        collapsed ? 'lg:hidden' : ''
                      }`}>
                        {group.label}
                      </h3>
                    )}
                    {/* Collapsed rail: the group label has no room, so a
                        hairline between groups keeps the icon column
                        readable. */}
                    {collapsed && groupIndex > 0 && (
                      <div className="hidden lg:block mx-2 mb-2 border-t border-line" />
                    )}
                    <div className="space-y-0.5">
                      {group.items.map((item) => {
                        const isActive = item.active;
                        // Link, not NavLink: NavLink decides "active" from the
                        // pathname alone, and every Settings item shares one
                        // pathname with a different ?tab=, so it would mark
                        // all of them aria-current="page". Active state is
                        // computed here and set explicitly.
                        return (
                          <Link
                            key={item.key}
                            to={item.href}
                            replace={item.replace}
                            onClick={(e) => guardedClick(e, item.href, item.replace, () => onClose())}
                            title={collapsed ? item.label : undefined}
                            aria-current={isActive ? 'page' : undefined}
                            className={itemClass(isActive)}
                          >
                            <item.icon className={iconClass(isActive)} />
                            <span className={`truncate ${collapsed ? 'lg:hidden' : ''}`}>{item.label}</span>
                          </Link>
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
                    to={entryHref(item.href)}
                    onClick={(e) => guardedClick(e, entryHref(item.href), false, () => {
                      // Clicking the current section's entry while peeking
                      // at the main menu hands the sidebar back to section
                      // mode even if the URL doesn't change.
                      if (activeSection?.paths.includes(item.href)) setPeekMain(false);
                      onClose();
                    })}
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
          <div className={`hidden lg:flex flex-shrink-0 border-t border-line py-2 ${
            collapsed ? 'justify-center px-2' : 'justify-end px-4'
          }`}>
            <button
              type="button"
              onClick={onToggleCollapse}
              className="inline-flex items-center justify-center w-9 h-9 rounded-md text-neutral-500 hover:text-heading hover:bg-hover-soft transition-colors"
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
              className="mx-4 mb-3 flex items-center gap-2 text-xs text-muted hover:text-body transition-colors"
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
    : 'bg-subtle';
  const softLimitDisplay = settingsService.formatBytes(limitInUse);

  return (
    <div className="p-4 border-t border-line">
      <div className={`${containerClass} rounded-lg p-3 transition-colors duration-300`}>
        <div className="flex items-center justify-between text-sm">
          <span className="text-body">{t('admin.storageUsed')}</span>
          <span className="font-medium text-heading">
            {/* The `+` marks a floor: part of the storage root was unreadable,
                so the real figure — and the percentage below — is higher than
                this. Without it an EACCES subtree reads as "safely under the
                limit" (#1164). */}
            {settingsService.formatBytes(storageInfo.total_used)}{storageInfo.storage_partial ? '+' : ''}
          </span>
        </div>
        <div className="mt-2 w-full bg-fill rounded-full h-2">
          <div
            className={`${progressBarClass} h-2 rounded-full transition-all duration-300`}
            style={{ width: `${Math.min(usagePercent, 100)}%` }}
          />
        </div>
        <p className="text-xs text-soft mt-1">
          {t('admin.storagePercent', { percent: usagePercent, limit: softLimitDisplay })}
        </p>
      </div>
    </div>
  );
};
