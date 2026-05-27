import React from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import {
  LayoutDashboard,
  Calendar,
  Archive,
  BarChart3,
  Settings,
  X,
  Users,
  Briefcase,
} from 'lucide-react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { settingsService } from '../../services/settings.service';
import { VersionInfo } from './VersionInfo';
import { usePermissions } from '../../contexts/PermissionsContext';
import { useFeatureFlags, type FeatureKey } from '../../contexts/FeatureFlagsContext';

interface AdminSidebarProps {
  isOpen: boolean;
  onClose: () => void;
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
  { nameKey: 'admin.analytics',      href: '/admin/analytics', icon: BarChart3,       permission: 'analytics.view', featureFlag: 'analytics' },
  { nameKey: 'navigation.settings',  href: '/admin/settings',  icon: Settings,        permission: 'settings.view' },
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
    // there's nothing inside ClientsLayout to link to. Add future
    // sub-flags (calendar, quotes, bills, messaging) here as they
    // ship; the entry reappears the moment any of them is enabled.
    featureFlagsAny: ['customerPortal'],
  },
];

export const AdminSidebar: React.FC<AdminSidebarProps> = ({ isOpen, onClose }) => {
  const location = useLocation();
  const { t } = useTranslation();
  const { hasPermission } = usePermissions();
  const { flags } = useFeatureFlags();

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

  return (
    <div
      className={`fixed inset-y-0 left-0 z-50 w-64 bg-white dark:bg-neutral-900 border-r border-neutral-200 dark:border-neutral-700 transform transition-transform duration-200 ease-in-out lg:relative lg:translate-x-0 lg:h-screen ${
        isOpen ? 'translate-x-0' : '-translate-x-full'
      }`}
    >
      <div className="flex flex-col h-screen lg:h-full">
        {/* Brand */}
        <div className="flex items-center justify-between h-16 px-6 border-b border-neutral-200 dark:border-neutral-700 flex-shrink-0">
          <div className="flex items-center">
            <span className="text-xl font-bold text-neutral-900 dark:text-neutral-100">{t('admin.title')}</span>
          </div>
          <button
            onClick={onClose}
            className="lg:hidden text-neutral-400 hover:text-neutral-600"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Navigation */}
        <nav className="flex-1 px-4 py-4 space-y-1 overflow-y-auto min-h-0">
          {filteredNavigation.map((item) => {
            const isActive = location.pathname === item.href || 
                           (item.href !== '/admin/dashboard' && location.pathname.startsWith(item.href));
            
            return (
              <NavLink
                key={item.nameKey}
                to={item.href}
                onClick={() => onClose()}
                className={`flex items-center px-3 py-2 text-sm font-medium rounded-lg transition-colors ${
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
                <item.icon className={`w-5 h-5 mr-3 ${
                  isActive ? 'text-white' : 'text-neutral-400'
                }`} />
                {t(item.nameKey)}
              </NavLink>
            );
          })}
        </nav>

        {/* Bottom section - sticky to bottom (only for users with settings.view permission) */}
        {hasPermission('settings.view') && (
          <div className="flex-shrink-0">
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
