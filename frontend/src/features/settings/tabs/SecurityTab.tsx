import React from 'react';
import { Save, Key, AlertCircle } from 'lucide-react';
import { Button, Card, Input } from '../../../components/common';
import { useTranslation } from 'react-i18next';
import type { SecuritySettings } from '../hooks/useSettingsState';

interface SecurityTabProps {
  securitySettings: SecuritySettings;
  setSecuritySettings: React.Dispatch<React.SetStateAction<SecuritySettings>>;
  saveSecurityMutation: {
    mutate: () => void;
    isPending: boolean;
  };
}

export const SecurityTab: React.FC<SecurityTabProps> = ({
  securitySettings,
  setSecuritySettings,
  saveSecurityMutation,
}) => {
  const { t } = useTranslation();

  return (
    <div className="space-y-6">
      <Card padding="md">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('settings.security.passwordSettings')}</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('settings.security.minPasswordLength')}
            </label>
            <Input
              type="number"
              value={securitySettings.password_min_length}
              onChange={(e) => setSecuritySettings(prev => ({ ...prev, password_min_length: parseInt(e.target.value) || 8 }))}
              min="4"
              max="32"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('settings.security.passwordComplexity')}
            </label>
            <select
              value={securitySettings.password_complexity}
              onChange={(e) => setSecuritySettings(prev => ({ ...prev, password_complexity: e.target.value }))}
              className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            >
              <option value="simple">{t('settings.security.complexitySimple')}</option>
              <option value="moderate">{t('settings.security.complexityModerate')}</option>
              <option value="strong">{t('settings.security.complexityStrong')}</option>
              <option value="very_strong">{t('settings.security.complexityVeryStrong')}</option>
            </select>
            <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
              {t('settings.security.passwordComplexityHelp')}
            </p>
          </div>
        </div>
      </Card>

      <Card padding="md">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('settings.security.sessionAuth')}</h2>

        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.security.sessionTimeout')}
              </label>
              <Input
                type="number"
                value={securitySettings.session_timeout_minutes}
                onChange={(e) => setSecuritySettings(prev => ({ ...prev, session_timeout_minutes: parseInt(e.target.value, 10) || 60 }))}
                min="5"
                max="1440"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.security.attemptWindowMinutes')}
              </label>
              <Input
                type="number"
                value={securitySettings.attempt_window_minutes}
                onChange={(e) => setSecuritySettings(prev => ({ ...prev, attempt_window_minutes: parseInt(e.target.value, 10) || 15 }))}
                min="1"
                max="1440"
              />
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                {t('settings.security.attemptWindowMinutesHelp')}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.security.lockoutDurationMinutes')}
              </label>
              <Input
                type="number"
                value={securitySettings.lockout_duration_minutes}
                onChange={(e) => setSecuritySettings(prev => ({ ...prev, lockout_duration_minutes: parseInt(e.target.value, 10) || 30 }))}
                min="1"
                max="1440"
              />
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                {t('settings.security.lockoutDurationMinutesHelp')}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.security.maxLoginAttempts')}
              </label>
              <Input
                type="number"
                value={securitySettings.max_login_attempts}
                onChange={(e) => setSecuritySettings(prev => ({ ...prev, max_login_attempts: parseInt(e.target.value, 10) || 5 }))}
                min="1"
                max="50"
              />
              <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-400">
                {t('settings.security.maxLoginAttemptsHelp')}
              </p>
            </div>
          </div>

          <label className="flex items-center">
            <input
              type="checkbox"
              checked={securitySettings.enable_2fa}
              onChange={(e) => setSecuritySettings(prev => ({ ...prev, enable_2fa: e.target.checked }))}
              className="w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
            />
            <span className="ml-2 text-sm text-neutral-700 dark:text-neutral-300">{t('settings.security.enable2FA')}</span>
          </label>
        </div>
      </Card>

      <Card padding="md">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">{t('settings.security.recaptchaSettings')}</h2>

        <div className="space-y-4">
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={securitySettings.enable_recaptcha}
              onChange={(e) => setSecuritySettings(prev => ({ ...prev, enable_recaptcha: e.target.checked }))}
              className="w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
            />
            <span className="ml-2 text-sm text-neutral-700 dark:text-neutral-300">{t('settings.security.enableRecaptcha')}</span>
          </label>

          {securitySettings.enable_recaptcha && (
            <>
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('settings.security.siteKey')}
                </label>
                <Input
                  type="text"
                  value={securitySettings.recaptcha_site_key}
                  onChange={(e) => setSecuritySettings(prev => ({ ...prev, recaptcha_site_key: e.target.value }))}
                  placeholder={t('settings.security.siteKey')}
                  leftIcon={<Key className="w-5 h-5 text-neutral-400" />}
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                  {t('settings.security.secretKey')}
                </label>
                <Input
                  type="password"
                  value={securitySettings.recaptcha_secret_key}
                  onChange={(e) => setSecuritySettings(prev => ({ ...prev, recaptcha_secret_key: e.target.value }))}
                  placeholder={t('settings.security.secretKey')}
                  leftIcon={<Key className="w-5 h-5 text-neutral-400" />}
                />
              </div>
            </>
          )}

          <div className="p-4 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg">
            <div className="flex items-start gap-3">
              <AlertCircle className="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0" />
              <div className="text-sm text-blue-800 dark:text-blue-200">
                <p>{t('settings.security.recaptchaHelp')} <a href="https://www.google.com/recaptcha/admin" target="_blank" rel="noopener noreferrer" className="underline">Google reCAPTCHA Admin</a></p>
              </div>
            </div>
          </div>
        </div>

        <div className="mt-6">
          <Button
            variant="primary"
            onClick={() => saveSecurityMutation.mutate()}
            isLoading={saveSecurityMutation.isPending}
            leftIcon={<Save className="w-5 h-5" />}
          >
            {t('settings.security.saveSecuritySettings')}
          </Button>
        </div>
      </Card>
    </div>
  );
};
