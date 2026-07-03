import React, { useState, useEffect } from 'react';
import { Save, Shield, Monitor, Image, RefreshCw, AlertCircle } from 'lucide-react';
import { Button, Card, Loading } from '../../../components/common';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { api } from '../../../config/api';

interface ImageSecuritySettings {
  default_protection_level: 'basic' | 'standard' | 'enhanced' | 'maximum';
  default_image_quality: number;
  enable_devtools_protection: boolean;
  max_image_requests_per_minute: number;
  max_image_requests_per_5_minutes: number;
  max_image_requests_per_hour: number;
  suspicious_activity_threshold: number;
  enable_canvas_rendering: boolean;
  default_fragmentation_level: number;
  security_monitoring_enabled: boolean;
  block_suspicious_ips: boolean;
  log_security_events_to_db: boolean;
  auto_block_threshold: number;
}

const defaultSettings: ImageSecuritySettings = {
  default_protection_level: 'standard',
  default_image_quality: 85,
  enable_devtools_protection: true,
  max_image_requests_per_minute: 30,
  max_image_requests_per_5_minutes: 100,
  max_image_requests_per_hour: 500,
  suspicious_activity_threshold: 10,
  enable_canvas_rendering: false,
  default_fragmentation_level: 3,
  security_monitoring_enabled: true,
  block_suspicious_ips: true,
  log_security_events_to_db: true,
  auto_block_threshold: 50,
};

export const ImageSecurityTab: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState<ImageSecuritySettings>(defaultSettings);
  const [isDirty, setIsDirty] = useState(false);

  // Fetch current settings
  const { data: fetchedSettings, isLoading, error } = useQuery({
    queryKey: ['image-security-settings'],
    queryFn: async () => {
      const response = await api.get('/admin/image-security/settings');
      return response.data;
    },
  });

  // Update local state when settings are fetched
  useEffect(() => {
    if (fetchedSettings) {
      setSettings({
        ...defaultSettings,
        ...fetchedSettings,
      });
    }
  }, [fetchedSettings]);

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: async (newSettings: ImageSecuritySettings) => {
      const response = await api.put('/admin/image-security/settings', newSettings);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['image-security-settings'] });
      toast.success(t('settings.imageSecurity.saveSuccess', 'Image security settings saved'));
      setIsDirty(false);
    },
    onError: () => {
      toast.error(t('settings.imageSecurity.saveError', 'Failed to save settings'));
    },
  });

  const handleChange = <K extends keyof ImageSecuritySettings>(
    key: K,
    value: ImageSecuritySettings[K]
  ) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setIsDirty(true);
  };

  const handleSave = () => {
    saveMutation.mutate(settings);
  };

  const handleReset = () => {
    if (fetchedSettings) {
      setSettings({ ...defaultSettings, ...fetchedSettings });
      setIsDirty(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <Loading size="lg" text={t('common.loading')} />
      </div>
    );
  }

  if (error) {
    return (
      <Card padding="md">
        <div className="flex items-center gap-3 text-red-600">
          <AlertCircle className="w-5 h-5" />
          <p>{t('settings.imageSecurity.loadError', 'Failed to load image security settings')}</p>
        </div>
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Default Protection Level */}
      <Card padding="md">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4 flex items-center gap-2">
          <Shield className="w-5 h-5 text-primary-600" />
          {t('settings.imageSecurity.defaultProtection', 'Default Protection Settings')}
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
          {t('settings.imageSecurity.defaultProtectionHelp', 'These settings apply to all new events. Individual events can override these defaults.')}
        </p>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('settings.imageSecurity.protectionLevel', 'Default Protection Level')}
            </label>
            <select
              value={settings.default_protection_level}
              onChange={(e) => handleChange('default_protection_level', e.target.value as ImageSecuritySettings['default_protection_level'])}
              className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            >
              <option value="basic">{t('events.protectionLevelBasic', 'Basic - Right-click blocking only')}</option>
              <option value="standard">{t('events.protectionLevelStandard', 'Standard - Keyboard shortcuts blocked')}</option>
              <option value="enhanced">{t('events.protectionLevelEnhanced', 'Enhanced - Print screen detection')}</option>
              <option value="maximum">{t('events.protectionLevelMaximum', 'Maximum - DevTools detection & canvas rendering')}</option>
            </select>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.imageSecurity.imageQuality', 'Default Image Quality')}
              </label>
              <input
                type="number"
                min="1"
                max="100"
                value={settings.default_image_quality}
                onChange={(e) => handleChange('default_image_quality', parseInt(e.target.value) || 85)}
                className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">1-100, higher = better quality</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.imageSecurity.fragmentationLevel', 'Fragmentation Level')}
              </label>
              <input
                type="number"
                min="1"
                max="10"
                value={settings.default_fragmentation_level}
                onChange={(e) => handleChange('default_fragmentation_level', parseInt(e.target.value) || 3)}
                className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">1-10, higher = more protection</p>
            </div>
          </div>

          <div className="space-y-3 pt-2">
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={settings.enable_devtools_protection}
                onChange={(e) => handleChange('enable_devtools_protection', e.target.checked)}
                className="w-4 h-4 text-primary-600 border-neutral-300 rounded focus:ring-primary-500"
              />
              <Monitor className="w-4 h-4 ml-2 mr-1 text-neutral-500" />
              <span className="text-sm text-neutral-700 dark:text-neutral-300">
                {t('settings.imageSecurity.enableDevtools', 'Enable DevTools detection by default')}
              </span>
            </label>

            <label className="flex items-center">
              <input
                type="checkbox"
                checked={settings.enable_canvas_rendering}
                onChange={(e) => handleChange('enable_canvas_rendering', e.target.checked)}
                className="w-4 h-4 text-primary-600 border-neutral-300 rounded focus:ring-primary-500"
              />
              <Image className="w-4 h-4 ml-2 mr-1 text-neutral-500" />
              <span className="text-sm text-neutral-700 dark:text-neutral-300">
                {t('settings.imageSecurity.enableCanvas', 'Enable canvas rendering by default (advanced protection)')}
              </span>
            </label>
          </div>
        </div>
      </Card>

      {/* Rate Limiting */}
      <Card padding="md">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">
          {t('settings.imageSecurity.rateLimiting', 'Rate Limiting')}
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
          {t('settings.imageSecurity.rateLimitingHelp', 'Limit how many images can be requested to prevent scraping.')}
        </p>

        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('settings.imageSecurity.requestsPerMinute', 'Requests per minute')}
            </label>
            <input
              type="number"
              min="1"
              max="1000"
              value={settings.max_image_requests_per_minute}
              onChange={(e) => handleChange('max_image_requests_per_minute', parseInt(e.target.value) || 30)}
              className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('settings.imageSecurity.requestsPer5Minutes', 'Requests per 5 min')}
            </label>
            <input
              type="number"
              min="1"
              max="5000"
              value={settings.max_image_requests_per_5_minutes}
              onChange={(e) => handleChange('max_image_requests_per_5_minutes', parseInt(e.target.value) || 100)}
              className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('settings.imageSecurity.requestsPerHour', 'Requests per hour')}
            </label>
            <input
              type="number"
              min="1"
              max="10000"
              value={settings.max_image_requests_per_hour}
              onChange={(e) => handleChange('max_image_requests_per_hour', parseInt(e.target.value) || 500)}
              className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
          </div>
        </div>
      </Card>

      {/* Security Monitoring */}
      <Card padding="md">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4">
          {t('settings.imageSecurity.securityMonitoring', 'Security Monitoring')}
        </h2>

        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.imageSecurity.suspiciousThreshold', 'Suspicious activity threshold')}
              </label>
              <input
                type="number"
                min="1"
                max="100"
                value={settings.suspicious_activity_threshold}
                onChange={(e) => handleChange('suspicious_activity_threshold', parseInt(e.target.value) || 10)}
                className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">Violations before flagging as suspicious</p>
            </div>

            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('settings.imageSecurity.autoBlockThreshold', 'Auto-block threshold')}
              </label>
              <input
                type="number"
                min="1"
                max="500"
                value={settings.auto_block_threshold}
                onChange={(e) => handleChange('auto_block_threshold', parseInt(e.target.value) || 50)}
                className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
              />
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">Violations before auto-blocking IP</p>
            </div>
          </div>

          <div className="space-y-3 pt-2">
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={settings.security_monitoring_enabled}
                onChange={(e) => handleChange('security_monitoring_enabled', e.target.checked)}
                className="w-4 h-4 text-primary-600 border-neutral-300 rounded focus:ring-primary-500"
              />
              <span className="ml-2 text-sm text-neutral-700 dark:text-neutral-300 dark:text-neutral-300">
                {t('settings.imageSecurity.enableMonitoring', 'Enable security monitoring')}
              </span>
            </label>

            <label className="flex items-center">
              <input
                type="checkbox"
                checked={settings.block_suspicious_ips}
                onChange={(e) => handleChange('block_suspicious_ips', e.target.checked)}
                className="w-4 h-4 text-primary-600 border-neutral-300 rounded focus:ring-primary-500"
              />
              <span className="ml-2 text-sm text-neutral-700 dark:text-neutral-300 dark:text-neutral-300">
                {t('settings.imageSecurity.blockSuspiciousIps', 'Automatically block suspicious IPs')}
              </span>
            </label>

            <label className="flex items-center">
              <input
                type="checkbox"
                checked={settings.log_security_events_to_db}
                onChange={(e) => handleChange('log_security_events_to_db', e.target.checked)}
                className="w-4 h-4 text-primary-600 border-neutral-300 rounded focus:ring-primary-500"
              />
              <span className="ml-2 text-sm text-neutral-700 dark:text-neutral-300 dark:text-neutral-300">
                {t('settings.imageSecurity.logEvents', 'Log security events to database')}
              </span>
            </label>
          </div>
        </div>
      </Card>

      {/* Info Box */}
      <Card padding="md" className="bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-blue-800 dark:text-blue-200">
            <p className="font-medium mb-1">{t('settings.imageSecurity.infoTitle', 'About Image Protection')}</p>
            <p>
              {t('settings.imageSecurity.infoText', 'These protection features help prevent casual downloading and copying but cannot block all methods. Determined users may still find ways to capture images. Consider using watermarks and legal agreements for comprehensive protection.')}
            </p>
          </div>
        </div>
      </Card>

      {/* Action Buttons */}
      <div className="flex gap-3">
        <Button
          variant="primary"
          onClick={handleSave}
          isLoading={saveMutation.isPending}
          leftIcon={<Save className="w-5 h-5" />}
          disabled={!isDirty}
        >
          {t('common.saveChanges', 'Save Changes')}
        </Button>

        {isDirty && (
          <Button
            variant="outline"
            onClick={handleReset}
            leftIcon={<RefreshCw className="w-5 h-5" />}
          >
            {t('common.resetChanges', 'Reset Changes')}
          </Button>
        )}
      </div>
    </div>
  );
};
