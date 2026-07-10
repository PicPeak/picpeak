import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import {
  ToggleRight,
  Sliders,
  CalendarPlus,
  Activity,
  Lock,
  Shield,
  Image as ImageIcon,
  Search,
  Tags,
  Tag,
  BarChart3,
  Flag,
  Code,
  KeyRound,
  Webhook,
  Mail,
  Palette,
  FileText,
  HardDrive,
  type LucideIcon,
} from 'lucide-react';
import { Loading } from '../../components/common';
import {
  useSettingsState,
  FeaturesTab,
  GeneralTab,
  EventsTab,
  StatusTab,
  SecurityTab,
  ImageSecurityTab,
  CategoriesTab,
  AnalyticsTab,
  ModerationTab,
  StylingTab,
  SEOTab,
  ThumbnailsTab,
  ApiTokensTab,
  WebhooksTab,
  AccountingTab,
  WhatsAppTab,
} from '../../features/settings';
import { EmailConfigPage } from './EmailConfigPage';
import { BrandingPage } from './BrandingPage';
import { EventTypesPage } from './EventTypesPage';
import { SlideshowSettingsPage } from './SlideshowSettingsPage';
import { BackupManagement } from './BackupManagement';
import { CMSPage } from './CMSPage';
// CRM (#TBD)
import { SettingsBusinessProfilePage } from './settings/SettingsBusinessProfilePage';
import { CrmSettingsPage } from './settings/CrmSettingsPage';
import { ReminderTemplatesPage } from './settings/ReminderTemplatesPage';
import { BlockLibraryPage } from './contracts/BlockLibraryPage';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import { Briefcase, Receipt, ScrollText, Landmark, Smartphone, MonitorPlay } from 'lucide-react';

// Tab keys driving the inner-nav. Must include every key used in
// `navGroups` below and in the switch at the bottom of the component.
type TabType =
  | 'features'
  | 'general'
  | 'events'
  | 'eventTypes'
  | 'branding'
  | 'categories'
  | 'thumbnails'
  | 'styling'
  | 'cms'
  | 'email'
  | 'moderation'
  | 'security'
  | 'imageSecurity'
  | 'seo'
  | 'apiTokens'
  | 'webhooks'
  | 'status'
  | 'analytics'
  | 'backup'
  // CRM (#TBD): issuer block for quote/invoice PDFs and per-area
  // CRM behaviour toggles.
  | 'businessProfile'
  | 'crm'
  | 'contracts'
  | 'reminderTemplates'
  | 'accounting'
  | 'whatsapp'
  | 'slideshow';

interface NavItem {
  key: TabType;
  label: string;
  icon: LucideIcon;
}

interface NavGroup {
  label: string;
  items: NavItem[];
}

const ALL_TAB_KEYS: TabType[] = [
  'features', 'general', 'events', 'eventTypes',
  'branding', 'categories', 'thumbnails', 'styling', 'cms',
  'email', 'moderation',
  'security', 'imageSecurity', 'seo',
  'apiTokens', 'webhooks',
  'status', 'analytics', 'backup',
  'businessProfile', 'crm', 'contracts', 'reminderTemplates', 'accounting', 'whatsapp',
  'slideshow',
];

function isValidTab(value: string | null): value is TabType {
  return value !== null && (ALL_TAB_KEYS as string[]).includes(value);
}

export const SettingsPage: React.FC = () => {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { flags, isLoading: flagsLoading } = useFeatureFlags();

  // Read ?tab=… on mount; default to Features per the redesign.
  const initialTab: TabType = isValidTab(searchParams.get('tab'))
    ? (searchParams.get('tab') as TabType)
    : 'features';
  const [activeTab, setActiveTab] = useState<TabType>(initialTab);

  // Keep URL in sync when the user clicks tabs (so deep-link / back-button
  // works and copy-paste of the URL lands the recipient on the same tab).
  useEffect(() => {
    const current = searchParams.get('tab');
    if (current === activeTab) return;
    const next = new URLSearchParams(searchParams);
    next.set('tab', activeTab);
    setSearchParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Reflect external URL changes (e.g. back/forward, redirect-to-tab) back
  // into local state.
  useEffect(() => {
    const urlTab = searchParams.get('tab');
    if (isValidTab(urlTab) && urlTab !== activeTab) {
      setActiveTab(urlTab);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const {
    isLoading,
    adminProfileLoading,
    generalSettings,
    setGeneralSettings,
    securitySettings,
    setSecuritySettings,
    analyticsSettings,
    setAnalyticsSettings,
    eventSettings,
    setEventSettings,
    accountForm,
    accountErrors,
    handleAccountChange,
    handleAccountSubmit,
    updateAdminProfileMutation,
    softLimitGb,
    setSoftLimitGb,
    softLimitDirty,
    setSoftLimitDirty,
    capacityOverrideGb,
    setCapacityOverrideGb,
    availableOverrideGb,
    setAvailableOverrideGb,
    overrideDirty,
    setOverrideDirty,
    handleSaveSoftLimit,
    handleSaveCapacityOverride,
    saveSoftLimitMutation,
    saveCapacityOverrideMutation,
    saveGeneralMutation,
    saveSecurityMutation,
    saveAnalyticsMutation,
    saveEventSettingsMutation,
    seoSettings,
    setSeoSettings,
    saveSeoMutation,
  } = useSettingsState();

  // If the active tab refers to an item that's now hidden (e.g. admin
  // landed on ?tab=reminderTemplates after disabling reminderEmails),
  // snap to the first key that the dependency-rule flags allow. Effect
  // re-fires when flags toggle live. MUST stay above the isLoading early
  // return so React's rules-of-hooks count stays consistent across renders
  // (was previously after the early return — that's a hooks violation that
  // surfaced as React error #310 once settled long enough for `isLoading`
  // to transition true→false in the same mount, #640D pre-existing-bug fix).
  useEffect(() => {
    // Wait for the server's actual flag values before deciding whether the
    // current tab is allowed — during initial load `flags` is the defaults
    // placeholder which would falsely snap-back away from a tab the server
    // has actually enabled.
    if (flagsLoading) return;
    const gatedOff: Record<string, boolean> = {
      crm: !(flags.quotes || flags.bills || flags.contracts),
      contracts: !flags.contracts,
      reminderTemplates: !flags.reminderEmails,
      accounting: !flags.accounting,
      whatsapp: !flags.whatsapp,
      slideshow: !flags.slideshow,
    };
    if (gatedOff[activeTab]) {
      setActiveTab('features');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flagsLoading, flags.quotes, flags.bills, flags.contracts, flags.reminderEmails, flags.accounting, flags.whatsapp, flags.slideshow, activeTab]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loading size="lg" text={t('settings.loadingSettings')} />
      </div>
    );
  }

  // Six-group inner nav. Items that previously lived as top-level admin
  // routes (Email Settings, Branding, Event Types, Backup, CMS Pages) now
  // appear inside their thematic group. The old top-level routes still
  // resolve via redirects (App.tsx) so existing bookmarks keep working.
  const navGroups: NavGroup[] = [
    {
      label: t('settings.groups.general', 'General'),
      items: [
        { key: 'features',   label: t('settings.features.title',   'Features'),       icon: ToggleRight },
        { key: 'general',    label: t('settings.general.title'),                       icon: Sliders },
        { key: 'events',     label: t('settings.events.title',     'Event Creation'),  icon: CalendarPlus },
        { key: 'eventTypes', label: t('settings.eventTypes.title', 'Event Types'),     icon: Tag },
      ],
    },
    {
      label: t('settings.groups.appearance', 'Content & Appearance'),
      items: [
        { key: 'branding',   label: t('settings.branding.title',   'Branding'),    icon: Palette },
        { key: 'categories', label: t('settings.categories.title'),                 icon: Tags },
        { key: 'thumbnails', label: t('settings.thumbnails.title', 'Thumbnails'),  icon: ImageIcon },
        { key: 'styling',    label: t('settings.styling.title',    'Custom CSS'),  icon: Code },
        { key: 'cms',        label: t('settings.cms.title',        'CMS Pages'),   icon: FileText },
        ...(flags.slideshow
          ? [{ key: 'slideshow' as const, label: t('settings.slideshow.title', 'Slideshow'), icon: MonitorPlay }]
          : []),
      ],
    },
    {
      label: t('settings.groups.communication', 'Communication'),
      items: [
        { key: 'email',      label: t('settings.email.title',      'Email Settings'), icon: Mail },
        { key: 'moderation', label: t('settings.moderation.title', 'Moderation'),     icon: Flag },
      ],
    },
    {
      label: t('settings.groups.privacySecurity', 'Privacy & Security'),
      items: [
        { key: 'security',      label: t('settings.security.title'),                   icon: Lock },
        { key: 'imageSecurity', label: t('settings.imageSecurity.title', 'Image Protection'), icon: Shield },
        { key: 'seo',           label: t('settings.seo.title',           'SEO & Robots'), icon: Search },
      ],
    },
    {
      label: t('settings.groups.integrations', 'Integrations'),
      items: [
        { key: 'apiTokens', label: t('settings.apiTokens.title', 'API Tokens'), icon: KeyRound },
        { key: 'webhooks',  label: t('settings.webhooks.title',  'Webhooks'),   icon: Webhook },
      ],
    },
    {
      // CRM group. businessProfile is always relevant (the issuer block
      // feeds every PDF, gallery hero, footer, etc — even with zero
      // CRM features). The remaining items hide when their matching
      // master flag is off so admins don't navigate to a tab that
      // configures a feature they can't actually use.
      label: t('settings.groups.crm', 'CRM-Settings'),
      items: [
        { key: 'businessProfile',    label: t('settings.businessProfile.title', 'Business profile'), icon: Briefcase },
        ...(flags.quotes || flags.bills || flags.contracts
          ? [{ key: 'crm' as const,                label: t('settings.crm.title',             'CRM behaviour'),    icon: Receipt }]
          : []),
        ...(flags.contracts
          ? [{ key: 'contracts' as const,          label: t('settings.contracts.title',       'Contracts'),        icon: ScrollText }]
          : []),
        ...(flags.reminderEmails
          ? [{ key: 'reminderTemplates' as const,  label: t('settings.reminderTemplates.title', 'Reminder emails'), icon: Mail }]
          : []),
        ...(flags.accounting
          ? [{ key: 'accounting' as const,         label: t('settings.accounting.title',      'Accounting'),       icon: Landmark }]
          : []),
        ...(flags.whatsapp
          ? [{ key: 'whatsapp' as const,           label: t('settings.whatsapp.title',        'WhatsApp'),         icon: Smartphone }]
          : []),
      ],
    },
    {
      label: t('settings.groups.system', 'System'),
      items: [
        { key: 'status',    label: t('settings.systemStatus.title'),               icon: Activity },
        { key: 'analytics', label: t('settings.analytics.title'),                  icon: BarChart3 },
        { key: 'backup',    label: t('settings.backup.title',   'Backup'),         icon: HardDrive },
      ],
    },
  ];

  const allItems = navGroups.flatMap((g) => g.items);
  const activeItem = allItems.find((i) => i.key === activeTab) ?? allItems[0];
  // (Visibility snap-back is handled in the useEffect above, which sits
  // before the isLoading early return to keep hook ordering stable.)

  // For tabs that mount existing top-level pages OR bring their own
  // header (FeaturesTab has its own icon+title+description block), skip
  // the Settings shell's section heading so the layout doesn't double
  // up.
  const TABS_WITH_OWN_HEADER: TabType[] = ['features', 'email', 'branding', 'eventTypes', 'backup', 'cms', 'contracts', 'reminderTemplates'];
  const showSectionHeading = !TABS_WITH_OWN_HEADER.includes(activeTab);

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-neutral-900 dark:text-neutral-100">{t('settings.title')}</h1>
        <p className="text-neutral-600 dark:text-neutral-400 mt-1">{t('settings.subtitle')}</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6 lg:gap-8">
        {/* Mobile: native select dropdown */}
        <div className="lg:hidden">
          <label htmlFor="settings-section" className="sr-only">
            {t('settings.sectionLabel', 'Settings section')}
          </label>
          <select
            id="settings-section"
            value={activeTab}
            onChange={(e) => setActiveTab(e.target.value as TabType)}
            className="w-full rounded-md border border-neutral-300 dark:border-neutral-600 bg-white dark:bg-neutral-800 px-3 py-2 text-sm font-medium text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            {navGroups.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.items.map((item) => (
                  <option key={item.key} value={item.key}>
                    {item.label}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>

        {/* Desktop: grouped left rail. */}
        <aside className="hidden lg:block">
          <nav
            aria-label={t('settings.navAriaLabel', 'Settings navigation')}
            className="sticky top-6 space-y-6"
          >
            {navGroups.map((group) => (
              <div key={group.label}>
                <h3 className="px-3 mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-neutral-500 dark:text-neutral-400">
                  {group.label}
                </h3>
                <ul className="space-y-0.5">
                  {group.items.map((item) => {
                    const Icon = item.icon;
                    const isActive = activeTab === item.key;
                    return (
                      <li key={item.key}>
                        <button
                          type="button"
                          onClick={() => setActiveTab(item.key)}
                          aria-current={isActive ? 'page' : undefined}
                          className={`group w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-sm font-medium transition-colors ${
                            isActive
                              ? 'bg-accent-dark text-white'
                              : 'text-neutral-700 dark:text-neutral-300 hover:bg-neutral-100 dark:hover:bg-neutral-800'
                          }`}
                        >
                          {/* Active-state icon paints white to sit on the
                              accent-dark pill (matches the label colour
                              and avoids the accent-on-accent low-contrast
                              that the prior `text-accent` produced). */}
                          <Icon
                            className={`w-4 h-4 flex-shrink-0 ${
                              isActive
                                ? 'text-white'
                                : 'text-neutral-500 dark:text-neutral-400 group-hover:text-neutral-700 dark:group-hover:text-neutral-200'
                            }`}
                          />
                          <span className="truncate">{item.label}</span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </nav>
        </aside>

        <div className="min-w-0">
          {showSectionHeading && (
            <div className="mb-4 lg:mb-6 pb-3 border-b border-neutral-200 dark:border-neutral-700">
              <div className="flex items-center gap-2">
                {/* Section heading icon stays neutral so the Settings
                    chrome reads as one consistent palette — no stray
                    accent flecks. The active sidebar pill is the only
                    place that uses the accent fill. */}
                <activeItem.icon className="w-5 h-5 text-neutral-700 dark:text-neutral-300" />
                <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
                  {activeItem.label}
                </h2>
              </div>
            </div>
          )}

          {activeTab === 'features' && <FeaturesTab />}

          {activeTab === 'general' && (
            <GeneralTab
              generalSettings={generalSettings}
              setGeneralSettings={setGeneralSettings}
              saveGeneralMutation={saveGeneralMutation}
              accountForm={accountForm}
              accountErrors={accountErrors}
              handleAccountChange={handleAccountChange}
              handleAccountSubmit={handleAccountSubmit}
              updateAdminProfileMutation={updateAdminProfileMutation}
              adminProfileLoading={adminProfileLoading}
            />
          )}

          {activeTab === 'events' && (
            <EventsTab
              eventSettings={eventSettings}
              setEventSettings={setEventSettings}
              saveEventSettingsMutation={saveEventSettingsMutation}
            />
          )}

          {activeTab === 'eventTypes' && <EventTypesPage />}
          {activeTab === 'slideshow' && <SlideshowSettingsPage />}
          {activeTab === 'branding' && <BrandingPage />}
          {activeTab === 'cms' && <CMSPage />}
          {activeTab === 'email' && <EmailConfigPage />}
          {activeTab === 'backup' && <BackupManagement />}
          {activeTab === 'businessProfile' && <SettingsBusinessProfilePage />}
          {activeTab === 'crm' && <CrmSettingsPage />}
          {activeTab === 'contracts' && <BlockLibraryPage />}
          {activeTab === 'reminderTemplates' && <ReminderTemplatesPage />}
          {activeTab === 'accounting' && <AccountingTab />}
          {activeTab === 'whatsapp' && <WhatsAppTab />}

          {activeTab === 'status' && (
            <StatusTab
              isActive={activeTab === 'status'}
              handleSaveSoftLimit={handleSaveSoftLimit}
              handleSaveCapacityOverride={handleSaveCapacityOverride}
              saveSoftLimitMutation={saveSoftLimitMutation}
              saveCapacityOverrideMutation={saveCapacityOverrideMutation}
              softLimitGb={softLimitGb}
              setSoftLimitGb={setSoftLimitGb}
              softLimitDirty={softLimitDirty}
              setSoftLimitDirty={setSoftLimitDirty}
              capacityOverrideGb={capacityOverrideGb}
              setCapacityOverrideGb={setCapacityOverrideGb}
              availableOverrideGb={availableOverrideGb}
              setAvailableOverrideGb={setAvailableOverrideGb}
              overrideDirty={overrideDirty}
              setOverrideDirty={setOverrideDirty}
            />
          )}

          {activeTab === 'security' && (
            <SecurityTab
              securitySettings={securitySettings}
              setSecuritySettings={setSecuritySettings}
              saveSecurityMutation={saveSecurityMutation}
            />
          )}

          {activeTab === 'seo' && (
            <SEOTab
              seoSettings={seoSettings}
              setSeoSettings={setSeoSettings}
              saveSeoMutation={saveSeoMutation}
            />
          )}

          {activeTab === 'imageSecurity' && <ImageSecurityTab />}
          {activeTab === 'thumbnails' && <ThumbnailsTab />}
          {activeTab === 'categories' && <CategoriesTab />}

          {activeTab === 'analytics' && (
            <AnalyticsTab
              analyticsSettings={analyticsSettings}
              setAnalyticsSettings={setAnalyticsSettings}
              saveAnalyticsMutation={saveAnalyticsMutation}
            />
          )}

          {activeTab === 'moderation' && <ModerationTab />}
          {activeTab === 'styling' && <StylingTab />}
          {activeTab === 'apiTokens' && <ApiTokensTab />}
          {activeTab === 'webhooks' && <WebhooksTab />}
        </div>
      </div>
    </div>
  );
};
