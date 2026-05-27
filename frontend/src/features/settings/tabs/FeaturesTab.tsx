import React from 'react';
import {
  ToggleRight,
  Save,
  AlertCircle,
  Images,
  BellRing,
  MessageSquare,
  CalendarDays,
  FileSignature,
  Receipt,
  BarChart3,
  Users,
  UserCog,
  Briefcase,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Card } from '../../../components/common';
import { FeatureCard } from '../components/FeatureCard';
import { SidebarPreview } from '../components/SidebarPreview';
import { useFeatureFlags } from '../../../contexts/FeatureFlagsContext';
import type { FeatureStatus } from '../components/StatusBadge';

interface SectionProps {
  title: string;
  children: React.ReactNode;
}

const Section: React.FC<SectionProps> = ({ title, children }) => (
  <section className="mt-6 first:mt-0">
    <h3 className="px-1 mb-3 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
      {title}
    </h3>
    <ul className="space-y-3">{children}</ul>
  </section>
);

export const FeaturesTab: React.FC = () => {
  const { t } = useTranslation();
  const { staged, setFlag, save, reset, isDirty, isSaving } = useFeatureFlags();

  // The localized label shown in StatusBadge — short, uppercased internally.
  const statusLabel = (status: FeatureStatus): string => {
    const map: Record<FeatureStatus, string> = {
      stable: t('settings.features.status.stable', 'stable'),
      beta: t('settings.features.status.beta', 'beta'),
      new: t('settings.features.status.new', 'new'),
      experimental: t('settings.features.status.experimental', 'experimental'),
      roadmap: t('settings.features.status.roadmap', 'roadmap'),
    };
    return map[status];
  };

  // Localized "no sidebar item" caption used by the Reminder Emails card.
  const sidebarHiddenLabel = t(
    'settings.features.sidebarHidden',
    'No sidebar item — runs in the background',
  );

  // "Coming soon" lock reason for unbuilt features. Keep wording neutral —
  // we don't promise a release date.
  const NOT_YET_AVAILABLE = t(
    'settings.features.notYetAvailable',
    'Not yet available — this toggle activates when the feature ships.',
  );

  return (
    <div className="space-y-6">
      <Card padding="md">
        {/* Header */}
        <div className="mb-6 pb-4 border-b border-neutral-200 dark:border-neutral-700">
          <div className="flex items-start gap-3">
            <div className="w-10 h-10 rounded-lg bg-accent-soft text-on-accent-soft flex items-center justify-center">
              <ToggleRight className="w-5 h-5" />
            </div>
            <div>
              <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                {t('settings.features.title', 'Features')}
              </h2>
              <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-0.5 max-w-2xl">
                {t(
                  'settings.features.intro',
                  'Turn product surfaces on or off. Enabled features appear in the left navigation and become available to your team. Some features are still in beta — flip them on to try them, off to hide them.',
                )}
              </p>
            </div>
          </div>
        </div>

        {/* Core */}
        <Section title={t('settings.features.sections.core', 'Core')}>
          <FeatureCard
            icon={Images}
            title={t('settings.features.galleries.title', 'Galleries')}
            description={t(
              'settings.features.galleries.description',
              'The core PicPeak surface. Always available.',
            )}
            status="stable"
            statusLabel={statusLabel('stable')}
            sidebarLabel={t('navigation.events')}
            enabled={staged.galleries}
            onToggle={() => { /* locked */ }}
            disabled
            lockedReason={t(
              'settings.features.galleries.locked',
              "Galleries are the foundation of PicPeak and can't be turned off.",
            )}
          />
        </Section>

        {/* Clients (#354 follow-up). Visual grouping for the CRM-area
            sub-features. The "Clients" sidebar section itself is gated
            by a derived `clients` flag (computed from whether any
            child below is on), so there's no explicit parent toggle —
            admins just enable the specific feature they want and the
            section appears automatically. */}
        <Section title={t('settings.features.sections.clients', 'Clients')}>
          <FeatureCard
            icon={UserCog}
            title={t('settings.features.customerPortal.title', 'Clients')}
            description={t(
              'settings.features.customerPortal.description',
              'Persistent customer logins. Recurring clients see all their assigned galleries from one place — no per-event passwords. Customers log in at /customer/login and you manage them under Clients → Accounts.',
            )}
            status="beta"
            statusLabel={statusLabel('beta')}
            // Sidebar hint mirrors the top-level "Clients" entry the
            // admin clicks first, not the deeper "Accounts" sub-nav.
            // Keeps the wording consistent with what's actually visible
            // in the menu bar.
            sidebarLabel={t('navigation.clients', 'Clients')}
            enabled={staged.customerPortal}
            onToggle={(next) => setFlag('customerPortal', next)}
          />
          {/* Future sub-features (Calendar / Quotes / Bills / Messaging)
              slot in here as FeatureCard entries when they ship. No
              placeholder cards today — the Clients section just shows
              what's actually built. */}
        </Section>

        {/* Communication */}
        <Section title={t('settings.features.sections.communication', 'Communication')}>
          <FeatureCard
            icon={BellRing}
            title={t('settings.features.reminderEmails.title', 'Reminder Emails')}
            description={t(
              'settings.features.reminderEmails.description',
              'Automatic nudges to guests before their gallery expires and to admins about pending uploads.',
            )}
            status="stable"
            statusLabel={statusLabel('stable')}
            sidebarHidden
            sidebarHiddenLabel={sidebarHiddenLabel}
            enabled={staged.reminderEmails}
            onToggle={() => { /* locked */ }}
            disabled
            lockedReason={NOT_YET_AVAILABLE}
          />

          <FeatureCard
            icon={MessageSquare}
            title={t('settings.features.messaging.title', 'Messaging')}
            description={t(
              'settings.features.messaging.description',
              'In-app threads with guests, attached to a gallery. Email is genuinely fine for most teams — this is for studios that want everything in one place.',
            )}
            status="experimental"
            statusLabel={statusLabel('experimental')}
            sidebarLabel={t('settings.features.messaging.sidebar', 'Messages')}
            enabled={staged.messaging}
            onToggle={() => { /* locked */ }}
            disabled
            lockedReason={NOT_YET_AVAILABLE}
          />
        </Section>

        {/* Scheduling */}
        <Section title={t('settings.features.sections.scheduling', 'Scheduling')}>
          <FeatureCard
            icon={CalendarDays}
            title={t('settings.features.calendar.title', 'Calendar')}
            description={t(
              'settings.features.calendar.description',
              'See all upcoming and past events on a month/week view. Optionally accept new bookings from clients.',
            )}
            status="beta"
            statusLabel={statusLabel('beta')}
            sidebarLabel={t('settings.features.calendar.sidebar', 'Calendar')}
            enabled={staged.calendar}
            onToggle={() => { /* locked */ }}
            disabled
            lockedReason={NOT_YET_AVAILABLE}
          />
        </Section>

        {/* Sales */}
        <Section title={t('settings.features.sections.sales', 'Sales')}>
          <FeatureCard
            icon={FileSignature}
            title={t('settings.features.quotes.title', 'Quotes')}
            description={t(
              'settings.features.quotes.description',
              'Send line-itemed quotes to clients. They can accept or decline from a public link; payment is tracked manually.',
            )}
            status="new"
            statusLabel={statusLabel('new')}
            sidebarLabel={t('settings.features.quotes.sidebar', 'Quotes')}
            enabled={staged.quotes}
            onToggle={() => { /* locked */ }}
            disabled
            lockedReason={NOT_YET_AVAILABLE}
          />

          <FeatureCard
            icon={Receipt}
            title={t('settings.features.bills.title', 'Bills')}
            description={t(
              'settings.features.bills.description',
              'Generate a bill from any accepted quote. Mark paid manually — no payment processor integration.',
            )}
            status="roadmap"
            statusLabel={statusLabel('roadmap')}
            sidebarLabel={t('settings.features.bills.sidebar', 'Bills')}
            enabled={staged.bills}
            onToggle={() => { /* locked */ }}
            disabled
            lockedReason={NOT_YET_AVAILABLE}
          />
        </Section>

        {/* Insights & Access */}
        <Section title={t('settings.features.sections.insights', 'Insights & Access')}>
          <FeatureCard
            icon={BarChart3}
            title={t('settings.features.analytics.title', 'Analytics')}
            description={t(
              'settings.features.analytics.description',
              'Storage usage, gallery views, download counts, and per-event stats.',
            )}
            status="stable"
            statusLabel={statusLabel('stable')}
            sidebarLabel={t('admin.analytics', 'Analytics')}
            enabled={staged.analytics}
            onToggle={(next) => setFlag('analytics', next)}
          />

          <FeatureCard
            icon={Users}
            title={t('settings.features.userManagement.title', 'User Management')}
            description={t(
              'settings.features.userManagement.description',
              "Multi-admin support with role-based permissions. Turn off if you're a single-operator studio.",
            )}
            status="stable"
            statusLabel={statusLabel('stable')}
            sidebarLabel={t('navigation.users', 'Users')}
            enabled={staged.userManagement}
            onToggle={(next) => setFlag('userManagement', next)}
            warning={t(
              'settings.features.userManagement.warning',
              'Existing user accounts stay valid; the admin UI for managing them will be hidden until you re-enable this.',
            )}
          />
        </Section>
      </Card>

      <SidebarPreview staged={staged} />

      {/* Save bar */}
      <div className="flex items-center justify-end gap-2 pt-2">
        {isDirty && (
          <span className="mr-auto text-xs text-amber-700 dark:text-amber-400 flex items-center gap-1.5">
            <AlertCircle className="w-3.5 h-3.5" />
            {t('settings.features.unsavedChanges', 'You have unsaved changes')}
          </span>
        )}
        <Button variant="outline" disabled={!isDirty || isSaving} onClick={reset}>
          {t('common.discard', 'Discard')}
        </Button>
        <Button
          variant="primary"
          disabled={!isDirty || isSaving}
          isLoading={isSaving}
          onClick={() => { void save(); }}
          leftIcon={<Save className="w-4 h-4" />}
        >
          {t('common.saveChanges', 'Save changes')}
        </Button>
      </div>
    </div>
  );
};
