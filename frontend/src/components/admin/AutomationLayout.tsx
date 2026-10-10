/**
 * Automation section layout.
 *
 * Workflows was a top-level sidebar entry and Reminder emails was a Settings
 * tab, but they are one job split across two areas: ReminderTemplatesPage
 * already renders a callout reading "The reminder schedule is now in
 * Workflows" with a link out to it. This section puts the schedule and the
 * templates it sends next to each other.
 *
 * Same shape as ClientsLayout / AccountingLayout — the sidebar renders the
 * navigation from `useAutomationNavItems()`, this layout owns the
 * section-root redirect and the empty state.
 */
import React from 'react';
import { Outlet, Navigate, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Workflow, CheckSquare, BellRing } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useFeatureFlags, type FeatureKey } from '../../contexts/FeatureFlagsContext';
import { usePermissions } from '../../contexts/PermissionsContext';

export interface AutomationNavItem {
  key: string;
  to: string;
  label: string;
  icon: LucideIcon;
  /** Feature flag that must be ON for this entry to render. */
  featureFlag: FeatureKey;
  /** Permission required to reach the page behind this entry. */
  permission: string;
}

/** Sub-pages of the Automation section that are switched on and permitted. */
export function useAutomationNavItems(): AutomationNavItem[] {
  const { t } = useTranslation();
  const { flags } = useFeatureFlags();
  const { hasPermission } = usePermissions();

  const navItems: AutomationNavItem[] = [
    {
      key: 'workflows',
      to: '/admin/automation/workflows',
      label: t('navigation.workflows', 'Workflows'),
      icon: Workflow,
      featureFlag: 'workflows',
      permission: 'workflows.view',
    },
    {
      key: 'approvals',
      // Flattened out of /admin/workflows/approvals: a sibling URL rather
      // than a child keeps "Workflows" from staying highlighted while the
      // admin is on Approvals.
      to: '/admin/automation/approvals',
      label: t('automation.subnav.approvals', 'Approvals'),
      icon: CheckSquare,
      featureFlag: 'workflows',
      permission: 'workflows.view',
    },
    {
      key: 'reminder-templates',
      to: '/admin/automation/reminder-templates',
      label: t('settings.reminderTemplates.title', 'Reminder emails'),
      icon: BellRing,
      featureFlag: 'reminderEmails',
      permission: 'email.view',
    },
  ];

  return navItems.filter((item) => flags[item.featureFlag] && hasPermission(item.permission));
}

/**
 * Is any sub-feature of this section switched on, regardless of whether this
 * admin may open it?
 *
 * The empty state needs the distinction: "nothing is enabled" and "you cannot
 * open any of what is enabled" are different problems, and telling the second
 * admin to go and enable the feature they just arrived from — via a bookmark
 * to the old top-level path — is advice they cannot act on.
 */
export function useAutomationSectionHasFlag(): boolean {
  const { flags } = useFeatureFlags();
  return (['workflows', 'reminderEmails'] as FeatureKey[]).some((f) => flags[f]);
}

export const AutomationLayout: React.FC = () => {
  const { t } = useTranslation();
  const location = useLocation();
  const anyFlagOn = useAutomationSectionHasFlag();
  const enabledItems = useAutomationNavItems();

  const isSectionRoot = location.pathname.replace(/\/+$/, '') === '/admin/automation';
  if (isSectionRoot && enabledItems.length > 0) {
    return <Navigate to={enabledItems[0].to} replace />;
  }

  if (enabledItems.length === 0) {
    // Two different empty states. With the flags off, the admin is one toggle
    // away and the message says so. With the flags on, the section is empty
    // because this role may not open any page in it — usually arriving here
    // from a bookmark to the old top-level path — and pointing them at
    // Settings → Features would be advice they cannot act on.
    const title = anyFlagOn
      ? t('automation.empty.noAccessTitle', 'Nothing here you can open')
      : t('automation.empty.title', 'No automation features enabled');
    const description = anyFlagOn
      ? t('automation.empty.noAccessBody', 'These features are switched on, but your role cannot open any of their pages. Ask an administrator for access.')
      : t('automation.empty.body', 'Enable Workflows or reminder emails under Settings → Features to get started.');
    return (
      <div>
        <div className="rounded-xl border border-dashed border-line-strong bg-shell p-8 text-center">
          <Workflow className="w-10 h-10 mx-auto mb-3 text-faint" />
          <h2 className="text-lg font-semibold text-heading mb-1">{title}</h2>
          <p className="text-sm text-soft">{description}</p>
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
