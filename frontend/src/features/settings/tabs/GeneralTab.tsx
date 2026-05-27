import React from 'react';
import { Save, Globe, Mail, User } from 'lucide-react';
import { Button, Card, Input, Loading } from '../../../components/common';
import { useTranslation } from 'react-i18next';
import type { GeneralSettings } from '../hooks/useSettingsState';
import { MAX_FILES_PER_UPLOAD_LIMIT } from '../hooks/useSettingsState';
import { SUPPORTED_LANGUAGES } from "../../../components/common/LanguageSelector.tsx";

interface GeneralTabProps {
  generalSettings: GeneralSettings;
  setGeneralSettings: React.Dispatch<React.SetStateAction<GeneralSettings>>;
  saveGeneralMutation: {
    mutate: () => void;
    isPending: boolean;
  };
  accountForm: { username: string; email: string };
  accountErrors: Record<string, string>;
  handleAccountChange: (field: 'username' | 'email') => (e: React.ChangeEvent<HTMLInputElement>) => void;
  handleAccountSubmit: (e: React.FormEvent<HTMLFormElement>) => void;
  updateAdminProfileMutation: { isPending: boolean };
  adminProfileLoading: boolean;
}

export const GeneralTab: React.FC<GeneralTabProps> = ({
  generalSettings,
  setGeneralSettings,
  saveGeneralMutation,
  accountForm,
  accountErrors,
  handleAccountChange,
  handleAccountSubmit,
  updateAdminProfileMutation,
  adminProfileLoading,
}) => {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <Card padding="md">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('settings.general.accountSection')}</h2>
        {adminProfileLoading ? (
          <div className="py-8 flex justify-center">
            <Loading size="md" />
          </div>
        ) : (
          <form className="space-y-4" onSubmit={handleAccountSubmit}>
            <div>
              <label htmlFor="admin-account-username" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.general.accountUsername')}
              </label>
              <Input
                id="admin-account-username"
                type="text"
                value={accountForm.username}
                onChange={handleAccountChange('username')}
                placeholder="admin"
                leftIcon={<User className="w-5 h-5 text-neutral-400" />}
                error={accountErrors.username}
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {t('settings.general.accountUsernameHelp')}
              </p>
            </div>

            <div>
              <label htmlFor="admin-account-email" className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.general.accountEmail')}
              </label>
              <Input
                id="admin-account-email"
                type="email"
                value={accountForm.email}
                onChange={handleAccountChange('email')}
                placeholder="admin@example.com"
                leftIcon={<Mail className="w-5 h-5 text-neutral-400" />}
                error={accountErrors.email}
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {t('settings.general.accountEmailHelp')}
              </p>
            </div>

            <div className="pt-2">
              <Button
                type="submit"
                variant="primary"
                leftIcon={<Save className="w-5 h-5" />}
                isLoading={updateAdminProfileMutation.isPending}
              >
                {t('settings.general.accountSaveButton')}
              </Button>
            </div>
          </form>
        )}
      </Card>

      <Card padding="md">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('settings.general.siteConfiguration')}</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('settings.general.siteUrl')}
            </label>
            <Input
              type="url"
              value={generalSettings.site_url}
              onChange={(e) => setGeneralSettings(prev => ({ ...prev, site_url: e.target.value }))}
              placeholder="https://yourdomain.com"
              leftIcon={<Globe className="w-5 h-5 text-neutral-400" />}
            />
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              {t('settings.general.siteUrlHelp')}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.general.defaultExpiration')}
              </label>
              <Input
                type="number"
                value={generalSettings.default_expiration_days}
                onChange={(e) => setGeneralSettings(prev => ({ ...prev, default_expiration_days: parseInt(e.target.value) || 30 }))}
                min="1"
                max="365"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.general.maxFileSize')}
              </label>
              <Input
                type="number"
                value={generalSettings.max_file_size_mb}
                onChange={(e) => setGeneralSettings(prev => ({ ...prev, max_file_size_mb: parseInt(e.target.value) || 50 }))}
                min="1"
                max="500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.general.maxFilesPerUpload')}
              </label>
              <Input
                type="number"
                value={generalSettings.max_files_per_upload}
                onChange={(e) => {
                  const parsed = parseInt(e.target.value, 10);
                  setGeneralSettings(prev => ({
                    ...prev,
                    max_files_per_upload: Number.isFinite(parsed)
                      ? Math.min(MAX_FILES_PER_UPLOAD_LIMIT, Math.max(1, parsed))
                      : prev.max_files_per_upload
                  }));
                }}
                min="1"
                max={MAX_FILES_PER_UPLOAD_LIMIT}
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {t('settings.general.maxFilesPerUploadHelp', { max: MAX_FILES_PER_UPLOAD_LIMIT })}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.general.maxUploadBatchSize')}
              </label>
              <Input
                type="number"
                value={generalSettings.max_upload_batch_size_mb}
                onChange={(e) => {
                  const parsed = parseInt(e.target.value, 10);
                  setGeneralSettings(prev => ({
                    ...prev,
                    max_upload_batch_size_mb: Number.isFinite(parsed)
                      ? Math.max(1, parsed)
                      : prev.max_upload_batch_size_mb
                  }));
                }}
                min="1"
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {t('settings.general.maxUploadBatchSizeHelp')}
              </p>
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('settings.general.allowedFileTypes')}
            </label>
            <Input
              type="text"
              value={generalSettings.allowed_file_types}
              onChange={(e) => setGeneralSettings(prev => ({ ...prev, allowed_file_types: e.target.value }))}
              placeholder="jpg,jpeg,png,gif"
            />
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              {t('settings.general.allowedFileTypesHelp')}
            </p>
          </div>
        </div>
      </Card>

      <Card padding="md">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('settings.general.featureToggles')}</h2>

        <div className="space-y-3">
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={generalSettings.enable_analytics}
              onChange={(e) => setGeneralSettings(prev => ({ ...prev, enable_analytics: e.target.checked }))}
              className="w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
            />
            <span className="ml-2 text-sm text-neutral-700 dark:text-neutral-300">{t('settings.general.enableAnalytics')}</span>
          </label>

          <label className="flex items-center">
            <input
              type="checkbox"
              checked={generalSettings.enable_registration}
              onChange={(e) => setGeneralSettings(prev => ({ ...prev, enable_registration: e.target.checked }))}
              className="w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
            />
            <span className="ml-2 text-sm text-neutral-700 dark:text-neutral-300">{t('settings.general.enableRegistration')}</span>
          </label>

          <label className="flex items-center">
            <input
              type="checkbox"
              checked={generalSettings.maintenance_mode}
              onChange={(e) => setGeneralSettings(prev => ({ ...prev, maintenance_mode: e.target.checked }))}
              className="w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
            />
            <span className="ml-2 text-sm text-neutral-700 dark:text-neutral-300">{t('settings.general.maintenanceMode')}</span>
          </label>

          <div>
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={generalSettings.short_gallery_urls}
                onChange={(e) => setGeneralSettings(prev => ({ ...prev, short_gallery_urls: e.target.checked }))}
                className="w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
              />
              <span className="ml-2 text-sm text-neutral-700 dark:text-neutral-300">{t('settings.general.enableShortGalleryUrls')}</span>
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 ml-6 mt-1">
              {t('settings.general.enableShortGalleryUrlsHelp')}
            </p>
          </div>

          <div>
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={generalSettings.use_original_filenames_for_downloads}
                onChange={(e) => setGeneralSettings(prev => ({ ...prev, use_original_filenames_for_downloads: e.target.checked }))}
                className="w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
              />
              <span className="ml-2 text-sm text-neutral-700 dark:text-neutral-300">{t('settings.general.useOriginalFilenames')}</span>
            </label>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 ml-6 mt-1">
              {t('settings.general.useOriginalFilenamesHelp')}
            </p>
          </div>
        </div>
      </Card>

      <Card padding="md">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('settings.general.language')}</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
              {t('settings.general.language')}
            </label>
            <select
              value={generalSettings.default_language}
              onChange={(e) => setGeneralSettings(prev => ({ ...prev, default_language: e.target.value }))}
              className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            >
              {SUPPORTED_LANGUAGES.map(lang => (
                <option key={lang.code} value={lang.code}>{lang.name}</option>
              ))}
            </select>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              {t('settings.general.defaultLanguageHelp')}
            </p>
          </div>
        </div>
      </Card>

      <Card padding="md">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('settings.general.dateTimeFormat')}</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
              {t('settings.general.dateFormat')}
            </label>
            <select
              value={generalSettings.date_format?.format || 'dd/MM/yyyy'}
              onChange={(e) => {
                const format = e.target.value;
                const locale = format === 'MM/dd/yyyy' ? 'en-US' : 'en-GB';
                setGeneralSettings(prev => ({
                  ...prev,
                  date_format: { format, locale }
                }));
              }}
              className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            >
              <option value="dd/MM/yyyy">DD/MM/YYYY (European)</option>
              <option value="MM/dd/yyyy">MM/DD/YYYY (US)</option>
              <option value="yyyy-MM-dd">YYYY-MM-DD (ISO)</option>
              <option value="dd.MM.yyyy">DD.MM.YYYY (German)</option>
            </select>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              {t('settings.general.dateFormatHelp')}
            </p>
          </div>
        </div>

        <div className="mt-6">
          <Button
            variant="primary"
            onClick={() => saveGeneralMutation.mutate()}
            isLoading={saveGeneralMutation.isPending}
            leftIcon={<Save className="w-5 h-5" />}
          >
            {t('settings.general.saveGeneralSettings')}
          </Button>
        </div>
      </Card>
    </div>
  );
};
