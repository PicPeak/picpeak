import React, { lazy, Suspense, useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useSearchParams } from 'react-router-dom';
import { Loading } from '../../components/common';
const ProductUsageTab = lazy(() => import('../../features/settings/tabs/ProductUsageTab'));
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
  DownloadsTab,
  ApiTokensTab,
  WebhooksTab,
  AccountingTab,
  WhatsAppTab,
  SsoTab,
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
import { usePermissions } from '../../contexts/PermissionsContext';
import {
  type SettingsTab as TabType,
  ALL_SETTINGS_TABS,
  DEFAULT_SETTINGS_TAB,
  isValidSettingsTab as isValidTab,
  SETTINGS_TAB_PERMISSIONS as TAB_PERMISSIONS,
  settingsTabGatedOff,
  useSettingsNavGroups,
} from '../../features/settings/settingsNav';
import { SectionPageHeader } from '../../components/admin/SectionPageHeader';

// Tab keys, permissions and the grouped navigation live in
// features/settings/settingsNav.tsx — shared with the admin sidebar, which
// renders the Settings groups in place of the main menu while on this page.

export const SettingsPage: React.FC = () => {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  const { hasAnyPermission, isLoading: permissionsLoading } = usePermissions();
  const visibleGroups = useSettingsNavGroups();

  // Read ?tab=… on mount; default to Features per the redesign.
  const initialTab: TabType = isValidTab(searchParams.get('tab'))
    ? (searchParams.get('tab') as TabType)
    : DEFAULT_SETTINGS_TAB;
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
    rateLimitSettings,
    setRateLimitSettings,
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
    if (settingsTabGatedOff(flags)[activeTab]) {
      setActiveTab(DEFAULT_SETTINGS_TAB);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flagsLoading, flags.quotes, flags.bills, flags.contracts, flags.documents, flags.reminderEmails, flags.accounting, flags.whatsapp, flags.slideshow, activeTab]);

  // Permission snap-back: if the active tab isn't permitted for this role (e.g.
  // a deep-linked ?tab=security a photographer can't access), move to the first
  // tab that is both permitted and not feature-flag-gated-off. Sits above the
  // isLoading early return to keep hook ordering stable.
  useEffect(() => {
    if (flagsLoading) return;
    if (hasAnyPermission(TAB_PERMISSIONS[activeTab] ?? ['settings.view'])) return;
    const flagOff = settingsTabGatedOff(flags);
    const firstVisible = ALL_SETTINGS_TABS.find(
      (k) => !flagOff[k] && hasAnyPermission(TAB_PERMISSIONS[k] ?? ['settings.view'])
    );
    if (firstVisible && firstVisible !== activeTab) setActiveTab(firstVisible);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flagsLoading, activeTab, flags.quotes, flags.bills, flags.contracts, flags.documents, flags.reminderEmails, flags.accounting, flags.whatsapp, flags.slideshow]);

  // Wait for the permissions context too: on a fresh/hard mount it starts out
  // empty, which filters every nav group down to nothing and left `activeItem`
  // undefined below (QA J.08 crash). `activeTab` is held in state, so a
  // deep-linked ?tab= still lands on the right tab once permissions arrive.
  if (isLoading || permissionsLoading) {
    return (
      <div className="flex items-center justify-center min-h-[400px]">
        <Loading size="lg" text={t('settings.loadingSettings')} />
      </div>
    );
  }

  const allItems = visibleGroups.flatMap((g) => g.items);
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
      <div className="min-w-0">
          {showSectionHeading && activeItem && (
            <SectionPageHeader icon={activeItem.icon} title={activeItem.label} />
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
          {activeTab === 'usage' && hasAnyPermission(['settings.edit']) && <Suspense fallback={<Loading />}><ProductUsageTab /></Suspense>}

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

          {activeTab === 'sso' && <SsoTab />}

          {activeTab === 'security' && (
            <SecurityTab
              securitySettings={securitySettings}
              setSecuritySettings={setSecuritySettings}
              rateLimitSettings={rateLimitSettings}
              setRateLimitSettings={setRateLimitSettings}
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
          {activeTab === 'downloads' && <DownloadsTab />}
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
  );
};
