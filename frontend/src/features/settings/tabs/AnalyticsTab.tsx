import React from 'react';
import { Save, Globe, Key, Activity, AlertCircle, ShieldCheck } from 'lucide-react';
import { Button, Card, Input } from '../../../components/common';
import { useTranslation } from 'react-i18next';
import type { AnalyticsSettings, TrackerProvider } from '../hooks/useSettingsState';

interface AnalyticsTabProps {
  analyticsSettings: AnalyticsSettings;
  setAnalyticsSettings: React.Dispatch<React.SetStateAction<AnalyticsSettings>>;
  saveAnalyticsMutation: {
    mutate: () => void;
    isPending: boolean;
  };
}

const PROVIDER_OPTIONS: TrackerProvider[] = ['none', 'umami', 'rybbit'];

/** PicPeak-owned events, never third-party code on the application origin. */
const ProxiedNotice: React.FC = () => {
  const { t } = useTranslation();

  return (
    <div className="p-4 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg">
      <div className="flex items-start gap-3">
        <ShieldCheck className="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0" />
        <div className="text-sm text-blue-800 dark:text-blue-200">
          <p className="font-medium mb-1">
            {t('settings.analytics.proxiedNotice', 'Data-only analytics forwarding')}
          </p>
          <p>
            {t(
              'settings.analytics.proxiedNoticeText',
              'PicPeak forwards sanitized page views and gallery events without loading third-party code. The collector receives visitor IP and user agent, but no query strings, page titles, referrers, tokens or account identifiers. Production collectors must use HTTPS.',
            )}
          </p>
        </div>
      </div>
    </div>
  );
};

export const AnalyticsTab: React.FC<AnalyticsTabProps> = ({
  analyticsSettings,
  setAnalyticsSettings,
  saveAnalyticsMutation,
}) => {
  const { t } = useTranslation();

  const provider = analyticsSettings.tracker_provider;

  return (
    <div className="space-y-6">
      <Card padding="md">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-1">
          {t('settings.analytics.providerHeading', 'Analytics provider')}
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
          {t(
            'settings.analytics.providerDescription',
            'Choose Umami or Rybbit for public gallery analytics. PicPeak forwards data only; arbitrary custom scripts are no longer supported.',
          )}
        </p>

        {/* Provider dropdown — single source of truth for which panel renders. */}
        <div className="mb-4">
          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
            {t('settings.analytics.providerLabel', 'Provider')}
          </label>
          <select
            value={provider}
            onChange={(e) => setAnalyticsSettings((prev) => ({
              ...prev,
              tracker_provider: e.target.value as TrackerProvider,
            }))}
            className="w-full sm:w-72 px-3 py-2 text-sm border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100"
          >
            {provider === 'custom' && <option value="custom" disabled>{t('settings.analytics.customDisabled', 'Custom scripts disabled')}</option>}
            {PROVIDER_OPTIONS.map((p) => (
              <option key={p} value={p}>
                {t(`settings.analytics.provider.${p}`, p)}
              </option>
            ))}
          </select>
        </div>

        {/* Umami panel */}
        {provider === 'umami' && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.analytics.umamiUrl')}
              </label>
              <Input
                type="url"
                value={analyticsSettings.umami_url}
                onChange={(e) => setAnalyticsSettings((prev) => ({ ...prev, umami_url: e.target.value }))}
                placeholder="https://analytics.yourdomain.com"
                leftIcon={<Globe className="w-5 h-5 text-neutral-400" />}
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {t('settings.analytics.umamiUrlHelp')}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.analytics.websiteId')}
              </label>
              <Input
                type="text"
                value={analyticsSettings.umami_website_id}
                onChange={(e) => setAnalyticsSettings((prev) => ({ ...prev, umami_website_id: e.target.value }))}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                leftIcon={<Key className="w-5 h-5 text-neutral-400" />}
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {t('settings.analytics.websiteIdHelp')}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.analytics.shareUrl')}
              </label>
              <Input
                type="url"
                value={analyticsSettings.umami_share_url}
                onChange={(e) => setAnalyticsSettings((prev) => ({ ...prev, umami_share_url: e.target.value }))}
                placeholder="https://analytics.yourdomain.com/share/..."
                leftIcon={<Activity className="w-5 h-5 text-neutral-400" />}
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {t('settings.analytics.shareUrlHelp')} {t('analytics.embedCspHint')}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.analytics.umamiApiKey', 'API key')}
              </label>
              <Input
                type="password"
                value={analyticsSettings.umami_api_key}
                onChange={(e) => setAnalyticsSettings((prev) => ({ ...prev, umami_api_key: e.target.value }))}
                placeholder="api_xxx…"
                leftIcon={<Key className="w-5 h-5 text-neutral-400" />}
                autoComplete="off"
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {t(
                  'settings.analytics.umamiApiKeyHelp',
                  'Optional. Required only for the device-breakdown chart on the Analytics dashboard. Generate in Umami → Settings → Profile → API Keys. Stored masked as •••••••• once saved — leave the masked value to keep the existing key.',
                )}
              </p>
            </div>

            <ProxiedNotice />
          </div>
        )}

        {/* Rybbit panel */}
        {provider === 'rybbit' && (
          <div className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.analytics.rybbitUrl', 'Rybbit URL')}
              </label>
              <Input
                type="url"
                value={analyticsSettings.rybbit_url}
                onChange={(e) => setAnalyticsSettings((prev) => ({ ...prev, rybbit_url: e.target.value }))}
                placeholder="https://app.rybbit.io"
                leftIcon={<Globe className="w-5 h-5 text-neutral-400" />}
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {t(
                  'settings.analytics.rybbitUrlHelp',
                  'Your Rybbit instance URL — `https://app.rybbit.io` for the SaaS, or `https://rybbit.yourdomain.com` for self-hosted.',
                )}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.analytics.rybbitWebsiteId', 'Site ID')}
              </label>
              <Input
                type="text"
                value={analyticsSettings.rybbit_website_id}
                onChange={(e) => setAnalyticsSettings((prev) => ({ ...prev, rybbit_website_id: e.target.value }))}
                placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                leftIcon={<Key className="w-5 h-5 text-neutral-400" />}
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {t(
                  'settings.analytics.rybbitWebsiteIdHelp',
                  'Found in Rybbit → Sites → your site → Tracking script.',
                )}
              </p>
            </div>

            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.analytics.rybbitApiKey', 'API key')}
              </label>
              <Input
                type="password"
                value={analyticsSettings.rybbit_api_key}
                onChange={(e) => setAnalyticsSettings((prev) => ({ ...prev, rybbit_api_key: e.target.value }))}
                placeholder="rybbit_xxx…"
                leftIcon={<Key className="w-5 h-5 text-neutral-400" />}
                autoComplete="off"
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {t(
                  'settings.analytics.rybbitApiKeyHelp',
                  'Optional. Required only for the device-breakdown chart. Generate in Rybbit → Account → Settings → API Keys. Stored masked as •••••••• once saved.',
                )}
              </p>
            </div>

            <ProxiedNotice />
          </div>
        )}

        {/* Legacy snippets are retained in admin settings for recovery, never rendered. */}
        {provider === 'custom' && (
          <p className="text-sm text-neutral-600 dark:text-neutral-400" role="status">
            {t('settings.analytics.customDisabledHelp', 'Your legacy custom snippet is disabled and is not sent to visitors. Choose Umami, Rybbit or None, then save to clear the old snippet.')}
          </p>
        )}

        {provider === 'none' && (
          <div className="p-4 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0" />
              <div className="text-sm text-blue-800 dark:text-blue-200">
                {t(
                  'settings.analytics.providerNoneInfo',
                  'No external events forwarded. The admin dashboard still shows summary cards + the daily chart from PicPeak\'s own access_logs; the device-breakdown chart uses a coarse user-agent heuristic.',
                )}
              </div>
            </div>
          </div>
        )}

        <div className="mt-6">
          <Button
            variant="primary"
            onClick={() => saveAnalyticsMutation.mutate()}
            isLoading={saveAnalyticsMutation.isPending}
            leftIcon={<Save className="w-5 h-5" />}
          >
            {t('settings.analytics.saveAnalyticsSettings')}
          </Button>
        </div>
      </Card>

      {/* Backend Analytics Info */}
      <Card padding="md">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('settings.analytics.backendAnalytics')}</h2>
        <p className="text-sm text-neutral-700 dark:text-neutral-300 mb-4">{t('settings.analytics.backendAnalyticsText')}</p>

        <div className="grid grid-cols-2 gap-4">
          <div className="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-4">
            <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-2">{t('settings.analytics.tracked')}</h3>
            <ul className="text-xs text-neutral-600 dark:text-neutral-400 space-y-1">
              <li>• {t('settings.analytics.galleryViews')}</li>
              <li>• {t('settings.analytics.photoDownloads')}</li>
              <li>• {t('settings.analytics.uniqueVisitors')}</li>
              <li>• {t('settings.analytics.deviceTypes')}</li>
            </ul>
          </div>
          <div className="bg-neutral-50 dark:bg-neutral-800 rounded-lg p-4">
            <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100 mb-2">{t('settings.analytics.privacy')}</h3>
            <p className="text-xs text-neutral-600 dark:text-neutral-400">
              {t('settings.analytics.privacyText')}
            </p>
          </div>
        </div>
      </Card>
    </div>
  );
};
