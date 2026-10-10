import React from 'react';
import { Key, ShieldCheck } from 'lucide-react';
import { Card, Input, Notice } from '../../../components/common';
import { useTranslation } from 'react-i18next';
import { SettingsSaveBar } from '../../../components/admin/SettingsSaveBar';
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
  isDirty: boolean;
  onDiscard: () => void;
}

export const SecurityTab: React.FC<SecurityTabProps> = ({
  securitySettings,
  setSecuritySettings,
  rateLimitSettings,
  setRateLimitSettings,
  saveSecurityMutation,
  isDirty,
  onDiscard,
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
              className="w-full px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading focus:outline-none focus:ring-2 focus:ring-accent focus:border-accent"
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
              <ShieldCheck className="w-5 h-5 text-accent flex-shrink-0 mt-0.5" />
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
              className="w-4 h-4 text-accent rounded focus:ring-accent"
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
              className="mt-0.5 w-4 h-4 text-accent rounded focus:ring-accent"
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
              className="mt-0.5 w-4 h-4 text-accent rounded focus:ring-accent"
            />
            <span className="ml-2 text-sm text-body">
              {t('settings.security.rateLimitPublicOnly')}
              <span className="block text-xs text-muted">{t('settings.security.rateLimitPublicOnlyHelp')}</span>
            </span>
          </label>

          <Notice tone="warning">{t('settings.security.rateLimitNatNote')}</Notice>
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
              className="w-4 h-4 mt-0.5 text-accent rounded focus:ring-accent"
            />
            <span className="ml-2 text-sm text-body">
              <span className="block font-medium text-heading">{t('settings.security.galleryPasswordRecoverable')}</span>
              <span className="block mt-1">{t('settings.security.galleryPasswordRecoverableHelp')}</span>
            </span>
          </label>

          {/* #1271 — reversible storage is a deliberate trade of security for
              convenience; the warning stays visible whether or not it is on. */}
          <Notice tone="warning" title={t('settings.security.galleryPasswordRecoverableWarningTitle')}>
            <div className="space-y-1">
              <p>{t('settings.security.galleryPasswordRecoverableWarning')}</p>
              <p>{t('settings.security.galleryPasswordRecoverableOffNote')}</p>
            </div>
          </Notice>
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
              className="w-4 h-4 text-accent rounded focus:ring-accent"
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
                  leftIcon={<Key className="w-5 h-5 text-faint" />}
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
                  leftIcon={<Key className="w-5 h-5 text-faint" />}
                />
              </div>
            </>
          )}

          <Notice tone="info">
            {t('settings.security.recaptchaHelp')} <a href="https://www.google.com/recaptcha/admin" target="_blank" rel="noopener noreferrer" className="underline text-accent">Google reCAPTCHA Admin</a>
          </Notice>
        </div>
      </Card>

      <SettingsSaveBar

        isDirty={isDirty}

        isSaving={saveSecurityMutation.isPending}

        onSave={() => saveSecurityMutation.mutate()}

        onDiscard={onDiscard}

      />
    </div>
  );
};
