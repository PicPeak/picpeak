import React, { useEffect, useState } from 'react';
import { Save, Download, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { toast } from 'react-toastify';

import { Button, Card, Input, Loading } from '../../../components/common';
import { api } from '../../../config/api';

/**
 * Download resolutions (#858).
 *
 * The STANDARD resolution is what every ordinary download hands out — single
 * photos, selected photos and download-all alike. The PICKER is an opt-in
 * modal letting guests choose a different size; those archives are built on
 * demand rather than served from the cache.
 *
 * Both are global defaults here; individual galleries can override them.
 */

interface Preset {
  id?: string;
  label: string;
  width: number;
  height: number;
}

interface DownloadSettings {
  standard_resolution: string;
  picker_enabled: boolean;
  allow_original: boolean;
  resolutions: Preset[];
}

const ORIGINAL = 'original';

export const DownloadsTab: React.FC = () => {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<DownloadSettings | null>(null);

  const { data, isLoading } = useQuery<DownloadSettings>({
    queryKey: ['admin-download-settings'],
    queryFn: async () => (await api.get('/admin/settings/downloads')).data,
  });

  useEffect(() => {
    if (data) setForm(data);
  }, [data]);

  const save = useMutation({
    mutationFn: async (payload: DownloadSettings) => {
      await api.put('/admin/settings/downloads', {
        download_standard_resolution: payload.standard_resolution,
        download_resolution_picker_enabled: payload.picker_enabled,
        download_allow_original: payload.allow_original,
        download_resolutions: payload.resolutions.map((r) => ({
          label: r.label, width: r.width, height: r.height,
        })),
      });
    },
    onSuccess: () => {
      toast.success(t('settings.saved', 'Settings saved'));
      queryClient.invalidateQueries({ queryKey: ['admin-download-settings'] });
    },
    onError: (e: unknown) => {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || t('settings.saveError', 'Failed to save settings'));
    },
  });

  // Matches SlideshowStyleFields' input styling — the explicit text colour
  // matters, without it the select renders muted and looks disabled.
  const selectClass = 'w-full px-3 py-2 bg-neutral-50 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 text-neutral-900 dark:text-neutral-100 rounded-lg text-sm';

  if (isLoading || !form) return <Loading />;

  const setPreset = (i: number, patch: Partial<Preset>) => {
    const old = form.resolutions[i];
    const next = { ...old, ...patch };
    const resolutions = form.resolutions.map((r, idx) => (idx === i ? next : r));
    // A preset's id IS its dimensions, so editing width/height of the preset
    // that is currently the standard would leave standard_resolution pointing
    // at an id that no longer exists and the save would 400. Follow the edit.
    const standard = `${old.width}x${old.height}` === form.standard_resolution
      ? `${next.width}x${next.height}`
      : form.standard_resolution;
    setForm({ ...form, resolutions, standard_resolution: standard });
  };

  const removePreset = (i: number) => {
    const removed = form.resolutions[i];
    const resolutions = form.resolutions.filter((_, idx) => idx !== i);
    // Keep the invariant the API enforces: the standard must stay a real
    // preset, otherwise the save is rejected.
    const standard = `${removed.width}x${removed.height}` === form.standard_resolution
      ? ORIGINAL
      : form.standard_resolution;
    setForm({ ...form, resolutions, standard_resolution: standard });
  };

  const addPreset = () => setForm({
    ...form,
    resolutions: [...form.resolutions, { label: 'Custom', width: 2000, height: 1500 }],
  });

  return (
    <div className="space-y-6">
      <Card>
        <div className="flex items-center gap-2 mb-1">
          <Download className="w-5 h-5 text-neutral-500" />
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
            {t('settings.downloads.title', 'Download resolutions')}
          </h2>
        </div>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-5">
          {t('settings.downloads.intro',
            'The standard size is what every gallery hands out by default. Individual galleries can override this.')}
        </p>

        <label className="block text-sm font-medium mb-1 text-neutral-800 dark:text-neutral-200">
          {t('settings.downloads.standard', 'Standard resolution')}
        </label>
        <select
          className={`mb-5 ${selectClass}`}
          value={form.standard_resolution}
          onChange={(e) => setForm({ ...form, standard_resolution: e.target.value })}
        >
          <option value={ORIGINAL}>{t('settings.downloads.original', 'Original (full size)')}</option>
          {form.resolutions.map((r) => (
            <option key={`${r.width}x${r.height}`} value={`${r.width}x${r.height}`}>
              {r.label} — {r.width} × {r.height}
            </option>
          ))}
        </select>

        <label className="flex items-start gap-3 mb-3 cursor-pointer">
          <input
            type="checkbox"
            className="mt-1 accent-primary-600"
            checked={form.picker_enabled}
            onChange={(e) => setForm({ ...form, picker_enabled: e.target.checked })}
          />
          <span>
            <span className="block text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {t('settings.downloads.picker', 'Let guests choose a download size')}
            </span>
            <span className="block text-xs text-neutral-500 dark:text-neutral-400">
              {t('settings.downloads.pickerHint',
                'Adds a size picker to bulk downloads. Custom sizes are prepared on demand and are never larger than the standard.')}
            </span>
          </span>
        </label>

        <label className="flex items-start gap-3 mb-5 cursor-pointer">
          <input
            type="checkbox"
            className="mt-1 accent-primary-600"
            checked={form.allow_original}
            disabled={!form.picker_enabled}
            onChange={(e) => setForm({ ...form, allow_original: e.target.checked })}
          />
          <span>
            <span className="block text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {t('settings.downloads.allowOriginal', 'Offer "Original" in the picker')}
            </span>
            <span className="block text-xs text-neutral-500 dark:text-neutral-400">
              {t('settings.downloads.allowOriginalHint',
                'Off by default: lowering the standard size normally means full-resolution files should not be handed out.')}
            </span>
          </span>
        </label>

        <div className="border-t border-neutral-200 dark:border-neutral-700 pt-4">
          <div className="flex items-center justify-between mb-2">
            <h3 className="text-sm font-medium text-neutral-900 dark:text-neutral-100">
              {t('settings.downloads.presets', 'Available sizes')}
            </h3>
            <Button variant="outline" size="sm" onClick={addPreset} leftIcon={<Plus className="w-4 h-4" />}>
              {t('common.add', 'Add')}
            </Button>
          </div>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
            {t('settings.downloads.presetsHint',
              'Sizes are an upper bound — the aspect ratio is kept and photos are never enlarged.')}
          </p>

          <div className="space-y-2">
            {form.resolutions.map((r, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={r.label}
                  onChange={(e) => setPreset(i, { label: e.target.value })}
                  className="flex-1"
                  aria-label={t('settings.downloads.label', 'Label')}
                />
                <Input
                  type="number"
                  value={String(r.width)}
                  onChange={(e) => setPreset(i, { width: parseInt(e.target.value, 10) || 0 })}
                  className="w-28"
                  aria-label={t('settings.downloads.width', 'Width')}
                />
                <span className="text-neutral-400">×</span>
                <Input
                  type="number"
                  value={String(r.height)}
                  onChange={(e) => setPreset(i, { height: parseInt(e.target.value, 10) || 0 })}
                  className="w-28"
                  aria-label={t('settings.downloads.height', 'Height')}
                />
                <button
                  type="button"
                  onClick={() => removePreset(i)}
                  disabled={form.resolutions.length <= 1}
                  aria-label={t('common.remove', 'Remove')}
                  className="p-2 text-neutral-500 hover:text-red-600 disabled:opacity-40"
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </div>
            ))}
          </div>
        </div>

        <div className="flex justify-end mt-6">
          <Button
            variant="primary"
            onClick={() => save.mutate(form)}
            disabled={save.isPending}
            leftIcon={<Save className="w-4 h-4" />}
          >
            {t('common.save', 'Save')}
          </Button>
        </div>
      </Card>
    </div>
  );
};
