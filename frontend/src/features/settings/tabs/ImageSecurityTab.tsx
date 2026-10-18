import React, { useState, useEffect } from 'react';
import { Shield, Monitor, Image } from 'lucide-react';
import { Card, ErrorState, Loading, Notice } from '../../../components/common';
import { SettingsSaveBar } from '../../../components/admin/SettingsSaveBar';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { api } from '../../../config/api';

interface ImageSecuritySettings {
  default_protection_level: 'basic' | 'standard' | 'enhanced' | 'maximum';
  enable_devtools_protection: boolean;
  enable_canvas_rendering: boolean;
}

const defaultSettings: ImageSecuritySettings = {
  default_protection_level: 'standard',
  enable_devtools_protection: true,
  enable_canvas_rendering: false,
};

export const ImageSecurityTab: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState<ImageSecuritySettings>(defaultSettings);
  // What the server last sent, in draft shape — dirty is a comparison against it.
  const [loaded, setLoaded] = useState<ImageSecuritySettings>(defaultSettings);
  const isDirty = JSON.stringify(settings) !== JSON.stringify(loaded);

  // Fetch current settings
  const { data: fetchedSettings, isLoading, error, refetch, isFetching } = useQuery({
    queryKey: ['image-security-settings'],
    queryFn: async () => {
      const response = await api.get('/admin/image-security/settings');
      return response.data;
    },
  });

  // Update local state when settings are fetched
  useEffect(() => {
    if (fetchedSettings) {
      const next = { ...defaultSettings, ...fetchedSettings };
      setSettings(next);
      setLoaded(next);
    }
  }, [fetchedSettings]);

  // Save mutation
  const saveMutation = useMutation({
    mutationFn: async (newSettings: ImageSecuritySettings) => {
      const response = await api.put('/admin/image-security/settings', newSettings);
      return response.data;
    },
    onSuccess: (_data, saved) => {
      queryClient.invalidateQueries({ queryKey: ['image-security-settings'] });
      toast.success(t('settings.imageSecurity.saveSuccess', 'Image security settings saved'));
      setLoaded(saved);
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
  };

  const handleSave = () => {
    saveMutation.mutate(settings);
  };

  const handleReset = () => {
    setSettings(loaded);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center min-h-[200px]">
        <Loading size="lg" text={t('common.loading')} />
      </div>
    );
  }

  if (error && !fetchedSettings) {
    return (
      <Card padding="md">
        <ErrorState
          size="inline"
          title={t('settings.imageSecurity.loadError', 'Failed to load image security settings')}
          onRetry={() => refetch()}
          retrying={isFetching}
        />
      </Card>
    );
  }

  return (
    <div className="space-y-6">
      {/* Default Protection Level */}
      <Card padding="md">
        <h2 className="text-lg font-semibold text-heading mb-4 flex items-center gap-2">
          <Shield className="w-5 h-5 text-accent" />
          {t('settings.imageSecurity.defaultProtection', 'Default Protection Settings')}
        </h2>
        <p className="text-sm text-soft mb-4">
          {t('settings.imageSecurity.defaultProtectionHelp', 'These settings apply to all new events. Individual events can override these defaults.')}
        </p>

        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-body mb-1">
              {t('settings.imageSecurity.protectionLevel', 'Default Protection Level')}
            </label>
            <select
              value={settings.default_protection_level}
              onChange={(e) => handleChange('default_protection_level', e.target.value as ImageSecuritySettings['default_protection_level'])}
              className="w-full px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading focus:ring-2 focus:ring-accent focus:border-accent"
            >
              <option value="basic">{t('events.protectionLevelBasic', 'Basic - Right-click blocking only')}</option>
              <option value="standard">{t('events.protectionLevelStandard', 'Standard - Keyboard shortcuts blocked')}</option>
              <option value="enhanced">{t('events.protectionLevelEnhanced', 'Enhanced - Print screen detection')}</option>
              <option value="maximum">{t('events.protectionLevelMaximum', 'Maximum - DevTools detection & canvas rendering')}</option>
            </select>
          </div>

          <div className="space-y-3 pt-2">
            <label className="flex items-center">
              <input
                type="checkbox"
                checked={settings.enable_devtools_protection}
                onChange={(e) => handleChange('enable_devtools_protection', e.target.checked)}
                className="w-4 h-4 text-accent border-line-strong rounded focus:ring-accent"
              />
              <Monitor className="w-4 h-4 ml-2 mr-1 text-muted" />
              <span className="text-sm text-body">
                {t('settings.imageSecurity.enableDevtools', 'Enable DevTools detection by default')}
              </span>
            </label>

            <label className="flex items-center">
              <input
                type="checkbox"
                checked={settings.enable_canvas_rendering}
                onChange={(e) => handleChange('enable_canvas_rendering', e.target.checked)}
                className="w-4 h-4 text-accent border-line-strong rounded focus:ring-accent"
              />
              <Image className="w-4 h-4 ml-2 mr-1 text-muted" />
              <span className="text-sm text-body">
                {t('settings.imageSecurity.enableCanvas', 'Enable canvas rendering in the lightbox by default (advanced protection)')}
              </span>
            </label>
          </div>
        </div>
      </Card>

      {/* Info Box */}
      <Notice tone="info" title={t('settings.imageSecurity.infoTitle', 'About Image Protection')}>
        {t('settings.imageSecurity.infoText', 'These protection features help prevent casual downloading and copying but cannot block all methods. Determined users may still find ways to capture images. Consider using watermarks and legal agreements for comprehensive protection.')}
      </Notice>

      <SettingsSaveBar
        isDirty={isDirty}
        isSaving={saveMutation.isPending}
        onSave={handleSave}
        onDiscard={handleReset}
      />
    </div>
  );
};
