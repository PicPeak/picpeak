import React, { useState, useEffect } from 'react';
import { Save, Image, RefreshCw, AlertCircle, Loader2 } from 'lucide-react';
import { Button, Card, Loading } from '../../../components/common';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';
import { api } from '../../../config/api';

interface ThumbnailSettings {
  width: number;
  height: number;
  quality: number;
  fit: string;
  format: string;
  // Lightbox preview tier (#492). Off by default; admin opts in.
  lightbox_preview_enabled: boolean;
}

const defaultSettings: ThumbnailSettings = {
  width: 300,
  height: 300,
  quality: 85,
  fit: 'cover',
  format: 'jpeg',
  lightbox_preview_enabled: false,
};

// Backend returns the lightbox toggle as a JSON-stringified boolean
// per migration 104. Tolerate raw boolean / "true" / "false" / "1" /
// "0" coming back so the form mirrors whatever shape lands.
function parseLightboxFlag(raw: unknown): boolean {
  if (raw === true || raw === 1) return true;
  if (typeof raw !== 'string') return false;
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === 'true' || trimmed === '"true"' || trimmed === '1') return true;
  return false;
}

interface FetchedSettings {
  settings: Record<string, { value: string; description: string }>;
  fitOptions: Array<'cover' | 'contain' | 'fill' | 'inside' | 'outside'>;
  formatOptions: Array<'jpeg' | 'png' | 'webp'>;
}

export const ThumbnailsTab: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [settings, setSettings] = useState<ThumbnailSettings>(defaultSettings);
  const [isDirty, setIsDirty] = useState(false);

  const { data: fetchedData, isLoading, error } = useQuery<FetchedSettings>({
    queryKey: ['thumbnail-settings'],
    queryFn: async () => {
      const response = await api.get('/admin/thumbnails/settings');
      return response.data;
    },
  });

  useEffect(() => {
    if (fetchedData?.settings) {
      const s = fetchedData.settings;
      setSettings({
        width: parseInt(s.thumbnail_width?.value) || defaultSettings.width,
        height: parseInt(s.thumbnail_height?.value) || defaultSettings.height,
        quality: parseInt(s.thumbnail_quality?.value) || defaultSettings.quality,
        fit: s.thumbnail_fit?.value || defaultSettings.fit,
        format: s.thumbnail_format?.value || defaultSettings.format,
        lightbox_preview_enabled: parseLightboxFlag(s.lightbox_preview_enabled?.value),
      });
    }
  }, [fetchedData]);

  const saveMutation = useMutation({
    mutationFn: async (newSettings: ThumbnailSettings) => {
      const response = await api.put('/admin/thumbnails/settings', newSettings);
      return response.data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['thumbnail-settings'] });
      toast.success(t('settings.thumbnails.saveSuccess', 'Thumbnail settings saved'));
      setIsDirty(false);
    },
    onError: () => {
      toast.error(t('settings.thumbnails.saveError', 'Failed to save thumbnail settings'));
    },
  });

  const regenerateMutation = useMutation({
    mutationFn: async () => {
      const response = await api.post('/admin/thumbnails/regenerate');
      return response.data;
    },
    onSuccess: (data) => {
      toast.success(data.message || t('settings.thumbnails.regenerateStarted', 'Thumbnail regeneration started'));
    },
    onError: () => {
      toast.error(t('settings.thumbnails.regenerateError', 'Failed to start thumbnail regeneration'));
    },
  });

  // Lightbox preview tier (#492). Eager regeneration counterpart to
  // ensurePreviewImage's lazy on-first-open generation. Useful after
  // flipping the toggle on so guests don't pay the lazy-cost on the
  // very first lightbox open per gallery.
  const regeneratePreviewsMutation = useMutation({
    mutationFn: async () => {
      const response = await api.post('/admin/thumbnails/regenerate-previews');
      return response.data;
    },
    onSuccess: (data) => {
      toast.success(data.message || t('settings.thumbnails.previewsRegenerateStarted', 'Lightbox preview regeneration started'));
    },
    onError: () => {
      toast.error(t('settings.thumbnails.previewsRegenerateError', 'Failed to start preview regeneration'));
    },
  });

  const handleChange = <K extends keyof ThumbnailSettings>(
    key: K,
    value: ThumbnailSettings[K]
  ) => {
    setSettings(prev => ({ ...prev, [key]: value }));
    setIsDirty(true);
  };

  const handleSave = () => {
    saveMutation.mutate(settings);
  };

  const handleReset = () => {
    if (fetchedData?.settings) {
      const s = fetchedData.settings;
      setSettings({
        width: parseInt(s.thumbnail_width?.value) || defaultSettings.width,
        height: parseInt(s.thumbnail_height?.value) || defaultSettings.height,
        quality: parseInt(s.thumbnail_quality?.value) || defaultSettings.quality,
        fit: s.thumbnail_fit?.value || defaultSettings.fit,
        format: s.thumbnail_format?.value || defaultSettings.format,
        lightbox_preview_enabled: parseLightboxFlag(s.lightbox_preview_enabled?.value),
      });
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
          <p>{t('settings.thumbnails.loadError', 'Failed to load thumbnail settings')}</p>
        </div>
      </Card>
    );
  }

  const fitOptions = fetchedData?.fitOptions || ['cover', 'contain', 'fill', 'inside', 'outside'];
  const formatOptions = fetchedData?.formatOptions || ['jpeg', 'png', 'webp'];

  return (
    <div className="space-y-6">
      {/* Dimensions & Quality */}
      <Card padding="md">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4 flex items-center gap-2">
          <Image className="w-5 h-5 text-primary-600" />
          {t('settings.thumbnails.dimensionsTitle', 'Thumbnail Dimensions & Quality')}
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
          {t('settings.thumbnails.dimensionsHelp', 'Configure the size and quality of auto-generated thumbnails. Higher values produce better-looking previews but increase storage and load times.')}
        </p>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('settings.thumbnails.width', 'Width (px)')}
            </label>
            <input
              type="number"
              min="50"
              max="1000"
              value={settings.width}
              onChange={(e) => handleChange('width', parseInt(e.target.value) || 300)}
              className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              {t('settings.thumbnails.widthHelp', '50-1000 pixels')}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('settings.thumbnails.height', 'Height (px)')}
            </label>
            <input
              type="number"
              min="50"
              max="1000"
              value={settings.height}
              onChange={(e) => handleChange('height', parseInt(e.target.value) || 300)}
              className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              {t('settings.thumbnails.heightHelp', '50-1000 pixels')}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('settings.thumbnails.quality', 'Quality')}
            </label>
            <input
              type="number"
              min="1"
              max="100"
              value={settings.quality}
              onChange={(e) => handleChange('quality', parseInt(e.target.value) || 85)}
              className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            />
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              {t('settings.thumbnails.qualityHelp', '1-100, higher = better quality but larger files')}
            </p>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
              {t('settings.thumbnails.format', 'Format')}
            </label>
            <select
              value={settings.format}
              onChange={(e) => handleChange('format', e.target.value)}
              className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
            >
              {formatOptions.map((fmt) => (
                <option key={fmt} value={fmt}>{fmt.toUpperCase()}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-4">
          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
            {t('settings.thumbnails.fit', 'Fit Mode')}
          </label>
          <select
            value={settings.fit}
            onChange={(e) => handleChange('fit', e.target.value)}
            className="w-full sm:w-64 px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-primary-500"
          >
            {fitOptions.map((opt) => (
              <option key={opt} value={opt}>
                {t(`settings.thumbnails.fit_${opt}`, opt.charAt(0).toUpperCase() + opt.slice(1))}
              </option>
            ))}
          </select>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            {t('settings.thumbnails.fitHelp', 'How images are resized to fit the thumbnail dimensions. "Cover" crops to fill, "Contain" fits within bounds.')}
          </p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-2">
            {t('settings.thumbnails.fitRecommendation', 'Recommendation: use "Inside" for masonry / mosaic / justified layouts (preserves aspect ratio); "Cover" for uniform 1:1 grid tiles.')}
          </p>
        </div>
      </Card>

      {/* Regenerate */}
      <Card padding="md">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4 flex items-center gap-2">
          <RefreshCw className="w-5 h-5 text-primary-600" />
          {t('settings.thumbnails.regenerateTitle', 'Regenerate Thumbnails')}
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
          {t('settings.thumbnails.regenerateHelp', 'After changing thumbnail settings, regenerate all existing thumbnails to apply the new configuration. This runs in the background and may take a while for large galleries.')}
        </p>

        <Button
          variant="outline"
          onClick={() => regenerateMutation.mutate()}
          isLoading={regenerateMutation.isPending}
          leftIcon={regenerateMutation.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : <RefreshCw className="w-5 h-5" />}
        >
          {t('settings.thumbnails.regenerateButton', 'Regenerate All Thumbnails')}
        </Button>
      </Card>

      {/* Lightbox preview tier (#492). Independent opt-in from the
          thumbnail size/quality settings above — costs disk but
          dramatically speeds up lightbox open on mobile / slow
          connections by serving an aspect-preserved ~1920px JPEG
          instead of the multi-megabyte original. */}
      <Card padding="md">
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-1 flex items-center gap-2">
          <Image className="w-5 h-5 text-primary-600" />
          {t('settings.thumbnails.lightboxTitle', 'Lightbox Preview Tier')}
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
          {t('settings.thumbnails.lightboxHelp', 'When enabled, the lightbox loads an aspect-preserved ~1920px JPEG (typically 200–500 KB) instead of the full original (often 5–12 MB). Originals are still served when guests click Download. Costs roughly one extra preview file per photo on disk; previews are generated lazily on first open and stored in /previews.')}
        </p>

        <label className="flex items-start gap-3 cursor-pointer mb-4">
          <input
            type="checkbox"
            className="mt-0.5 rounded border-neutral-300 dark:border-neutral-600 text-accent focus:ring-primary-500"
            checked={settings.lightbox_preview_enabled}
            onChange={(e) => handleChange('lightbox_preview_enabled', e.target.checked)}
          />
          <span className="text-sm">
            <span className="font-medium text-neutral-900 dark:text-neutral-100">
              {t('settings.thumbnails.lightboxToggle', 'Use medium-resolution previews in the lightbox')}
            </span>
            <span className="block text-xs text-neutral-600 dark:text-neutral-400 mt-0.5">
              {t('settings.thumbnails.lightboxToggleHelp', 'Off by default. Flip on after deciding the perceived-perf win is worth the extra disk usage.')}
            </span>
          </span>
        </label>

        {/* Eager regeneration so guests don't pay the lazy first-open
            cost. Only useful after the toggle is on; gated so admins
            don't accidentally kick off a job that won't be visible. */}
        <Button
          variant="outline"
          onClick={() => regeneratePreviewsMutation.mutate()}
          isLoading={regeneratePreviewsMutation.isPending}
          disabled={!settings.lightbox_preview_enabled}
          leftIcon={regeneratePreviewsMutation.isPending ? <Loader2 className="w-5 h-5 animate-spin" /> : <RefreshCw className="w-5 h-5" />}
        >
          {t('settings.thumbnails.regeneratePreviewsButton', 'Regenerate All Previews')}
        </Button>
      </Card>

      {/* Info Box */}
      <Card padding="md" className="bg-blue-50 dark:bg-blue-900/30 border-blue-200 dark:border-blue-800">
        <div className="flex items-start gap-3">
          <AlertCircle className="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
          <div className="text-sm text-blue-800 dark:text-blue-200">
            <p className="font-medium mb-1">{t('settings.thumbnails.infoTitle', 'About Thumbnails')}</p>
            <p>
              {t('settings.thumbnails.infoText', 'Thumbnails are smaller preview images generated from your originals. Increasing the size or quality improves how photos look in the gallery grid but uses more storage and bandwidth. After changing settings, use "Regenerate All Thumbnails" to update existing photos.')}
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
