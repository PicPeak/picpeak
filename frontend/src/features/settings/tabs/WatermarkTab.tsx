import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { Droplets, Upload, Trash2, ShieldCheck, Info } from 'lucide-react';
import { api } from '../../../config/api';
import { Card, Loading } from '../../../components/common';
import { SettingsSaveBar } from '../../../components/admin/SettingsSaveBar';
import { settingsService, type BrandingSettings } from '../../../services/settings.service';

const POSITIONS = ['top-left', 'top-right', 'bottom-left', 'bottom-right', 'center'] as const;

/** The fields this tab edits; the logo saves on its own (upload / remove). */
const EDITED_FIELDS = ['watermark_enabled', 'watermark_position', 'watermark_opacity', 'watermark_size'] as const;

/**
 * Settings → Watermark.
 *
 * Controls the existing branding watermark pipeline (text or logo, position,
 * opacity, size). Priced galleries keep working automatically: paid photos
 * get a strong TILED version of the same mark regardless of these values.
 */
export const WatermarkTab: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState<BrandingSettings | null>(null);
  const [serverSettings, setServerSettings] = useState<BrandingSettings | null>(null);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);

  const { data, isLoading } = useQuery({
    queryKey: ['admin-settings', 'branding'],
    queryFn: () => settingsService.getSettingsByType('branding'),
  });

  useEffect(() => {
    if (!data) return;
    const formatted = settingsService.formatBrandingSettings(data);
    setServerSettings(formatted);
    // A logo upload refetches the branding settings: keep unsaved edits to
    // the other fields, take the logo from the server.
    setSettings((current) => (current
      ? { ...current, watermark_logo_url: formatted.watermark_logo_url }
      : formatted));
  }, [data]);

  const isDirty = !!settings && !!serverSettings
    && EDITED_FIELDS.some((field) => settings[field] !== serverSettings[field]);

  const save = async () => {
    if (!settings) return;
    setSaving(true);
    try {
      await settingsService.updateBranding(settings);
      setServerSettings(settings);
      toast.success(t('settings.watermark.saved', 'Watermark settings saved'));
      queryClient.invalidateQueries({ queryKey: ['admin-settings', 'branding'] });
      queryClient.invalidateQueries({ queryKey: ['public-settings'] });
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('common.error'));
    } finally {
      setSaving(false);
    }
  };

  const discard = () => {
    if (serverSettings) setSettings(serverSettings);
  };

  const handleUpload = async (file: File) => {
    setUploading(true);
    try {
      const formData = new FormData();
      formData.append('watermarkLogo', file);
      await api.post('/admin/settings/branding/watermark-logo', formData, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      toast.success(t('settings.watermark.logoUploaded', 'Watermark logo uploaded'));
      queryClient.invalidateQueries({ queryKey: ['admin-settings', 'branding'] });
      queryClient.invalidateQueries({ queryKey: ['public-settings'] });
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('common.error'));
    } finally {
      setUploading(false);
    }
  };

  const handleRemoveLogo = async () => {
    try {
      await api.delete('/admin/settings/branding/watermark-logo');
      toast.success(t('settings.watermark.logoRemoved', 'Watermark logo removed'));
      queryClient.invalidateQueries({ queryKey: ['admin-settings', 'branding'] });
      queryClient.invalidateQueries({ queryKey: ['public-settings'] });
    } catch (error: any) {
      toast.error(error?.response?.data?.error || t('common.error'));
    }
  };

  if (isLoading || !settings) {
    return <Loading size="lg" text={t('settings.loadingSettings')} />;
  }

  const patch = (next: Partial<BrandingSettings>) => {
    const merged = { ...settings, ...next };
    setSettings(merged);
    return merged;
  };

  return (
    <div className="space-y-6">
      <Card padding="md">
        <div className="flex items-start gap-3">
          <Info className="w-5 h-5 text-accent flex-shrink-0 mt-0.5" />
          <p className="text-sm text-soft">
            {t('settings.watermark.photoSalesHint', 'For priced galleries the watermark is applied automatically: photos beyond the free quota get a strong, tiled version of this mark — independent of the settings below.')}
          </p>
        </div>
      </Card>

      <Card padding="md">
        <h2 className="text-lg font-semibold text-heading flex items-center gap-2">
          <Droplets className="w-5 h-5" />
          {t('settings.watermark.title', 'Watermark')}
        </h2>

        <div className="mt-6 space-y-6">
          {/* Enable */}
          <label className="flex items-center gap-3 cursor-pointer">
            <input
              type="checkbox"
              checked={settings.watermark_enabled === true}
              onChange={(e) => patch({ watermark_enabled: e.target.checked })}
              className="rounded border-line-strong"
            />
            <span className="text-sm font-medium text-body">
              {t('settings.watermark.enable', 'Show a watermark on gallery photos')}
            </span>
          </label>

          {/* Logo */}
          <div>
            <span className="block text-sm font-medium text-body mb-2">
              {t('settings.watermark.logo', 'Watermark logo (optional)')}
            </span>
            <div className="flex items-center gap-3 flex-wrap">
              {settings.watermark_logo_url ? (
                <img
                  src={settings.watermark_logo_url}
                  alt={t('settings.watermark.logo', 'Watermark logo')}
                  className="h-12 max-w-[180px] object-contain rounded border border-line bg-white p-1"
                />
              ) : (
                <span className="text-sm text-muted">
                  {t('settings.watermark.noLogo', 'No logo — the text below is used instead.')}
                </span>
              )}
              <label className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-accent border border-accent rounded-lg hover:bg-accent/10 cursor-pointer">
                <Upload className="w-4 h-4" />
                {uploading ? t('common.loading', 'Uploading…') : t('settings.watermark.uploadLogo', 'Upload logo')}
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  disabled={uploading}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) handleUpload(file);
                    e.target.value = '';
                  }}
                />
              </label>
              {settings.watermark_logo_url && (
                <button
                  onClick={handleRemoveLogo}
                  className="inline-flex items-center gap-2 px-3 py-1.5 text-sm font-medium text-danger-text border border-danger-line rounded-lg hover:bg-danger-soft"
                >
                  <Trash2 className="w-4 h-4" />
                  {t('settings.watermark.removeLogo', 'Remove')}
                </button>
              )}
            </div>
          </div>

          {/* Position */}
          <div>
            <label className="block text-sm font-medium text-body mb-2">
              {t('settings.watermark.position', 'Position')}
            </label>
            <div className="flex flex-wrap gap-2">
              {POSITIONS.map((position) => (
                <button
                  key={position}
                  onClick={() => patch({ watermark_position: position })}
                  className={`px-3 py-1.5 text-sm rounded-lg border transition-colors ${
                    (settings.watermark_position || 'bottom-right') === position
                      ? 'border-accent bg-accent/10 text-accent'
                      : 'border-line-strong text-soft hover:border-neutral-400'
                  }`}
                >
                  {t(`settings.watermark.position_${position.replace('-', '_')}`, position)}
                </button>
              ))}
            </div>
          </div>

          {/* Opacity */}
          <div>
            <label className="block text-sm font-medium text-body mb-2">
              {t('settings.watermark.opacity', 'Opacity')}: {settings.watermark_opacity ?? 50}%
            </label>
            <input
              type="range"
              min={10}
              max={100}
              value={settings.watermark_opacity ?? 50}
              onChange={(e) => patch({ watermark_opacity: Number(e.target.value) })}
              className="w-full max-w-md accent-[var(--color-accent)]"
            />
          </div>

          {/* Size */}
          <div>
            <label className="block text-sm font-medium text-body mb-2">
              {t('settings.watermark.size', 'Size')}: {settings.watermark_size ?? 15}%
            </label>
            <input
              type="range"
              min={5}
              max={40}
              value={settings.watermark_size ?? 15}
              onChange={(e) => patch({ watermark_size: Number(e.target.value) })}
              className="w-full max-w-md accent-[var(--color-accent)]"
            />
          </div>
        </div>
      </Card>

      <Card padding="md">
        <div className="flex items-start gap-3">
          <ShieldCheck className="w-5 h-5 text-accent flex-shrink-0 mt-0.5" />
          <p className="text-sm text-soft">
            {t('settings.watermark.photoSalesNote', 'Photo sales: paid photos are always watermarked (tiled, stronger) before checkout, and the original without watermark is delivered only after purchase.')}
          </p>
        </div>
      </Card>

      <SettingsSaveBar isDirty={isDirty} isSaving={saving} onSave={save} onDiscard={discard} />
    </div>
  );
};
