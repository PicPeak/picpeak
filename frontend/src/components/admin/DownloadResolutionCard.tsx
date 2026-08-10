/**
 * <DownloadResolutionCard>
 *
 * Per-event override for the download-resolution settings (#858). The globals
 * live in Settings → Download resolutions; this card lets one gallery differ.
 *
 * Every field is tri-state — "Inherit" writes NULL and the gallery follows the
 * global, matching the show_watermark / show_qr convention. The card shows the
 * inherited value inline so an admin can see what "Inherit" currently means
 * without leaving the page.
 *
 * Reads GET /api/admin/events/:id/download-resolutions (which returns the raw
 * overrides, the globals, and the resolved effective policy) and saves through
 * PATCH on the same path.
 */
import React, { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { Download, Save } from 'lucide-react';

import { Button, Card, Loading } from '../common';
import { api } from '../../config/api';
import type { DownloadResolutionChoice } from '../../types';

const INHERIT = '__inherit__';
const ORIGINAL = 'original';

interface Payload {
  overrides: {
    download_standard_resolution: string | null;
    download_resolution_picker_enabled: boolean | null;
    download_allow_original: boolean | null;
  };
  globals: {
    standard_resolution: string;
    picker_enabled: boolean;
    allow_original: boolean;
    resolutions: DownloadResolutionChoice[];
  };
  effective: {
    standard: string;
    picker_enabled: boolean;
    allow_original: boolean;
    choices: DownloadResolutionChoice[];
  };
}

export interface DownloadResolutionCardProps {
  eventId: number;
  onChanged?: () => void;
}

/** null → "Inherit"; true/false → explicit. */
const triToSelect = (v: boolean | null | undefined) =>
  (v === null || v === undefined ? INHERIT : String(v));
const selectToTri = (v: string) => (v === INHERIT ? null : v === 'true');

export const DownloadResolutionCard: React.FC<DownloadResolutionCardProps> = ({ eventId, onChanged }) => {
  const { t } = useTranslation();
  const [standard, setStandard] = useState<string>(INHERIT);
  const [picker, setPicker] = useState<string>(INHERIT);
  const [allowOriginal, setAllowOriginal] = useState<string>(INHERIT);
  const [saving, setSaving] = useState(false);

  const { data, isLoading, refetch } = useQuery<Payload>({
    queryKey: ['event-download-resolutions', eventId],
    queryFn: async () => (await api.get(`/admin/events/${eventId}/download-resolutions`)).data,
  });

  useEffect(() => {
    if (!data) return;
    setStandard(data.overrides.download_standard_resolution ?? INHERIT);
    setPicker(triToSelect(data.overrides.download_resolution_picker_enabled));
    setAllowOriginal(triToSelect(data.overrides.download_allow_original));
  }, [data]);

  if (isLoading || !data) {
    return <Card><Loading /></Card>;
  }

  const globalStandardLabel = data.globals.standard_resolution === ORIGINAL
    ? t('settings.downloads.original', 'Original (full size)')
    : data.globals.standard_resolution;

  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/admin/events/${eventId}/download-resolutions`, {
        download_standard_resolution: standard === INHERIT ? null : standard,
        download_resolution_picker_enabled: selectToTri(picker),
        download_allow_original: selectToTri(allowOriginal),
      });
      toast.success(t('settings.saved', 'Settings saved'));
      await refetch();
      onChanged?.();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { error?: string } } })?.response?.data?.error;
      toast.error(msg || t('settings.saveError', 'Failed to save settings'));
    } finally {
      setSaving(false);
    }
  };

  // Same input styling as the other admin cards (SlideshowStyleFields) —
  // notably the explicit text colour, without which the select renders
  // muted and reads as disabled.
  const selectClass = 'w-full px-3 py-2 bg-neutral-50 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 text-neutral-900 dark:text-neutral-100 rounded-lg text-sm';

  return (
    <Card>
      <div className="flex items-center gap-2 mb-1">
        <Download className="w-5 h-5 text-neutral-500" />
        <h3 className="text-base font-semibold text-neutral-900 dark:text-neutral-100">
          {t('settings.downloads.eventTitle', 'Download resolution')}
        </h3>
      </div>
      <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
        {t('settings.downloads.eventIntro',
          'Override the site-wide download settings for this gallery only. "Inherit" follows Settings → Download resolutions.')}
      </p>

      <div className="space-y-4">
        <div>
          <label className="block text-sm font-medium mb-1 text-neutral-800 dark:text-neutral-200">
            {t('settings.downloads.standard', 'Standard resolution')}
          </label>
          <select className={selectClass} value={standard} onChange={(e) => setStandard(e.target.value)}>
            <option value={INHERIT}>
              {t('settings.downloads.inheritWith', 'Inherit ({{value}})', { value: globalStandardLabel })}
            </option>
            <option value={ORIGINAL}>{t('settings.downloads.original', 'Original (full size)')}</option>
            {data.globals.resolutions.map((r) => (
              <option key={r.id} value={r.id}>{r.label} — {r.width} × {r.height}</option>
            ))}
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1 text-neutral-800 dark:text-neutral-200">
            {t('settings.downloads.picker', 'Let guests choose a download size')}
          </label>
          <select className={selectClass} value={picker} onChange={(e) => setPicker(e.target.value)}>
            <option value={INHERIT}>
              {t('settings.downloads.inheritWith', 'Inherit ({{value}})', {
                value: data.globals.picker_enabled ? t('common.on', 'on') : t('common.off', 'off'),
              })}
            </option>
            <option value="true">{t('common.on', 'on')}</option>
            <option value="false">{t('common.off', 'off')}</option>
          </select>
        </div>

        <div>
          <label className="block text-sm font-medium mb-1 text-neutral-800 dark:text-neutral-200">
            {t('settings.downloads.allowOriginal', 'Offer "Original" in the picker')}
          </label>
          <select
            className={selectClass}
            value={allowOriginal}
            onChange={(e) => setAllowOriginal(e.target.value)}
          >
            <option value={INHERIT}>
              {t('settings.downloads.inheritWith', 'Inherit ({{value}})', {
                value: data.globals.allow_original ? t('common.on', 'on') : t('common.off', 'off'),
              })}
            </option>
            <option value="true">{t('common.on', 'on')}</option>
            <option value="false">{t('common.off', 'off')}</option>
          </select>
        </div>
      </div>

      {/* What the gallery actually does right now, after the cascade. */}
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-4">
        {t('settings.downloads.effective', 'Currently hands out: {{standard}}', {
          standard: data.effective.standard === ORIGINAL
            ? t('settings.downloads.original', 'Original (full size)')
            : data.effective.standard,
        })}
        {data.effective.picker_enabled
          ? ` · ${t('settings.downloads.pickerOn', 'guests may choose another size')}`
          : ''}
      </p>

      <div className="flex justify-end mt-4">
        <Button variant="primary" onClick={save} disabled={saving} leftIcon={<Save className="w-4 h-4" />}>
          {t('common.save', 'Save')}
        </Button>
      </div>
    </Card>
  );
};
