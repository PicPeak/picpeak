import React from 'react';
import { Save, Key, AlertCircle, AlertTriangle, ShieldCheck } from 'lucide-react';
import { Button, Card, Input } from '../../../components/common';
import { useTranslation } from 'react-i18next';
import type { SecuritySettings, RateLimitSettings } from '../hooks/useSettingsState';

interface SecurityTabProps {
  securitySettings: SecuritySettings;
  setSecuritySettings: React.Dispatch<React.SetStateAction<SecuritySettings>>;
  rateLimitSettings: RateLimitSettings;
  setRateLimitSettings: React.Dispatch<React.SetStateAction<RateLimitSettings>>;
  saveSecurityMutation: {
    mutate: () => void;
    isPending: boolean;
  };
}

export const SecurityTab: React.FC<SecurityTabProps> = ({
  securitySettings,
  setSecuritySettings,
  rateLimitSettings,
  setRateLimitSettings,
  saveSecurityMutation,
}) => {
  const { t } = useTranslation();
  const setRateLimit = <K extends keyof RateLimitSettings>(key: K, value: RateLimitSettings[K]) =>
    setRateLimitSettings((prev) => ({ ...prev, [key]: value }));
  const numberField = (key: keyof RateLimitSettings, min: number, max: number, labelKey: string, helpKey: string) => (
    <div>
      <label className="block text-sm font-medium text-body mb-1">
        {t(`settings.security.${labelKey}`)}
      </label>
      <Input
        type="number"
        min={min}
        max={max}
        value={rateLimitSettings[key] as number}
        onChange={(e) => setRateLimit(key, Number(e.target.value) as RateLimitSettings[typeof key])}
        aria-label={t(`settings.security.${labelKey}`)}
      />
      <p className="text-xs text-muted mt-1">{t(`settings.security.${helpKey}`)}</p>
    </div>
  );

  return (
    <div className="space-y-6">
      <Card padding="md">
        <h2 className="text-lg font-semibold text-heading mb-4">{t('settings.security.passwordSettings')}</h2>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-body mb-1">
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
            <label className="block text-sm font-medium text-body mb-1">
              {t('settings.security.passwordComplexity')}
            </label>
            <select
              value={securitySettings.password_complexity}
              onChange={(e) => setSecuritySettings(prev => ({ ...prev, password_complexity: e.target.value }))}
              className="w-full px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            >
              <option value="simple">{t('settings.security.complexitySimple')}</option>
              <option value="moderate">{t('settings.security.complexityModerate')}</option>
              <option value="strong">{t('settings.security.complexityStrong')}</option>
              <option value="very_strong">{t('settings.security.complexityVeryStrong')}</option>
            </select>
            <p className="mt-1 text-sm text-soft">
              {t('settings.security.passwordComplexityHelp')}
            </p>
          </div>
        </div>
      </Card>

      <Card padding="md">
        <h2 className="text-lg font-semibold text-heading mb-4">{t('settings.security.sessionAuth')}</h2>

        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-body mb-1">
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
              <label className="block text-sm font-medium text-body mb-1">
                {t('settings.security.attemptWindowMinutes')}
              </label>
              <Input
                type="number"
                value={securitySettings.attempt_window_minutes}
                onChange={(e) => setSecuritySettings(prev => ({ ...prev, attempt_window_minutes: parseInt(e.target.value, 10) || 15 }))}
                min="1"
                max="1440"
              />
              <p className="mt-1 text-sm text-soft">
                {t('settings.security.attemptWindowMinutesHelp')}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-body mb-1">
                {t('settings.security.lockoutDurationMinutes')}
              </label>
              <Input
                type="number"
                value={securitySettings.lockout_duration_minutes}
                onChange={(e) => setSecuritySettings(prev => ({ ...prev, lockout_duration_minutes: parseInt(e.target.value, 10) || 30 }))}
                min="1"
                max="1440"
              />
              <p className="mt-1 text-sm text-soft">
                {t('settings.security.lockoutDurationMinutesHelp')}
              </p>
            </div>
            <div>
              <label className="block text-sm font-medium text-body mb-1">
                {t('settings.security.maxLoginAttempts')}
              </label>
              <Input
                type="number"
                value={securitySettings.max_login_attempts}
                onChange={(e) => setSecuritySettings(prev => ({ ...prev, max_login_attempts: parseInt(e.target.value, 10) || 5 }))}
                min="1"
                max="50"
              />
              <p className="mt-1 text-sm text-soft">
                {t('settings.security.maxLoginAttemptsHelp')}
              </p>
            </div>
          </div>

          <div className="p-4 bg-neutral-50 dark:bg-neutral-800/60 border border-line rounded-lg">
            <div className="flex items-start gap-3">
              <ShieldCheck className="w-5 h-5 text-primary-600 dark:text-primary-400 flex-shrink-0 mt-0.5" />
              <div className="text-sm text-body">
                <p className="font-medium text-heading">{t('settings.security.twoFactorTitle')}</p>
                <p className="mt-1">{t('settings.security.twoFactorNote')}</p>
              </div>
            </div>
          </div>
        </div>
      </Card>

      {/* General API rate limiter (#1337). These keys had a backend route and
          no screen, so installs ran on a budget nobody could see. */}
      <Card padding="md">
        <h2 className="text-lg font-semibold text-heading mb-1">{t('settings.security.rateLimitTitle')}</h2>
        <p className="text-sm text-soft mb-4">{t('settings.security.rateLimitIntro')}</p>

        <div className="space-y-4">
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={rateLimitSettings.rate_limit_enabled}
              onChange={(e) => setRateLimit('rate_limit_enabled', e.target.checked)}
              className="w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
            />
            <span className="ml-2 text-sm text-body">{t('settings.security.rateLimitEnabled')}</span>
          </label>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
            {numberField('rate_limit_window_minutes', 1, 60, 'rateLimitWindowMinutes', 'rateLimitWindowMinutesHelp')}
            {numberField('rate_limit_max_requests', 10, 10000, 'rateLimitMaxRequests', 'rateLimitMaxRequestsHelp')}
            {numberField('rate_limit_auth_max_requests', 1, 100, 'rateLimitAuthMaxRequests', 'rateLimitAuthMaxRequestsHelp')}
          </div>

          <label className="flex items-start">
            <input
              type="checkbox"
              checked={rateLimitSettings.rate_limit_skip_authenticated}
              onChange={(e) => setRateLimit('rate_limit_skip_authenticated', e.target.checked)}
              className="mt-0.5 w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
            />
            <span className="ml-2 text-sm text-body">
              {t('settings.security.rateLimitSkipAuthenticated')}
              <span className="block text-xs text-muted">{t('settings.security.rateLimitSkipAuthenticatedHelp')}</span>
            </span>
          </label>

          <label className="flex items-start">
            <input
              type="checkbox"
              checked={rateLimitSettings.rate_limit_public_endpoints_only}
              onChange={(e) => setRateLimit('rate_limit_public_endpoints_only', e.target.checked)}
              className="mt-0.5 w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
            />
            <span className="ml-2 text-sm text-body">
              {t('settings.security.rateLimitPublicOnly')}
              <span className="block text-xs text-muted">{t('settings.security.rateLimitPublicOnlyHelp')}</span>
            </span>
          </label>

          <div className="flex items-start gap-2 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 p-3 text-sm text-amber-800 dark:text-amber-200">
            <AlertCircle className="w-5 h-5 flex-none mt-0.5" />
            <p>{t('settings.security.rateLimitNatNote')}</p>
          </div>
        </div>
      </Card>

      <Card padding="md">
        <h2 className="text-lg font-semibold text-heading mb-4">{t('settings.security.galleryPasswordsTitle')}</h2>

        <div className="space-y-4">
          <label className="flex items-start">
            <input
              type="checkbox"
              checked={securitySettings.gallery_password_recoverable}
              onChange={(e) => setSecuritySettings(prev => ({ ...prev, gallery_password_recoverable: e.target.checked }))}
              className="w-4 h-4 mt-0.5 text-primary-600 rounded focus:ring-primary-500"
            />
            <span className="ml-2 text-sm text-body">
              <span className="block font-medium text-heading">{t('settings.security.galleryPasswordRecoverable')}</span>
              <span className="block mt-1">{t('settings.security.galleryPasswordRecoverableHelp')}</span>
            </span>
          </label>

          {/* #1271 — reversible storage is a deliberate trade of security for
              convenience; the warning stays visible whether or not it is on. */}
          <div className="p-4 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-800 rounded-lg">
            <div className="flex items-start gap-3">
              <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0" />
              <div className="text-sm text-amber-800 dark:text-amber-200 space-y-1">
                <p className="font-medium">{t('settings.security.galleryPasswordRecoverableWarningTitle')}</p>
                <p>{t('settings.security.galleryPasswordRecoverableWarning')}</p>
                <p>{t('settings.security.galleryPasswordRecoverableOffNote')}</p>
              </div>
            </div>
          </div>
        </div>
      </Card>

      <Card padding="md">
        <h2 className="text-lg font-semibold text-heading mb-4">{t('settings.security.recaptchaSettings')}</h2>

        <div className="space-y-4">
          <label className="flex items-center">
            <input
              type="checkbox"
              checked={securitySettings.enable_recaptcha}
              onChange={(e) => setSecuritySettings(prev => ({ ...prev, enable_recaptcha: e.target.checked }))}
              className="w-4 h-4 text-primary-600 rounded focus:ring-primary-500"
            />
            <span className="ml-2 text-sm text-body">{t('settings.security.enableRecaptcha')}</span>
          </label>

          {securitySettings.enable_recaptcha && (
            <>
              <div>
                <label className="block text-sm font-medium text-body mb-1">
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
                <label className="block text-sm font-medium text-body mb-1">
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
