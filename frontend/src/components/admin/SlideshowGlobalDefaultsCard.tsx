/**
 * <SlideshowGlobalDefaultsCard>
 *
 * Global default for the Live Slideshow watermark (the white, semi-transparent
 * corner logo). Every event whose watermark mode is "Use global default"
 * (events.show_watermark = NULL) follows this; events can still override on/off
 * per event. Persisted via PUT /admin/settings/slideshow (app_settings,
 * type 'slideshow').
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'react-toastify';
import { MonitorPlay, Save } from 'lucide-react';
import { Button, Card } from '../common';
import { settingsService } from '../../services/settings.service';
import {
  SLIDESHOW_WATERMARK_POSITIONS,
  SLIDESHOW_WATERMARK_STYLES,
  SLIDESHOW_FITS,
  SLIDESHOW_TRANSITIONS,
  SLIDESHOW_COLORFILTERS,
  type SlideshowGlobalDefaults,
} from '../../services/slideshow.service';
import { WatermarkSourcePicker } from './WatermarkSourcePicker';

// Optimistic form state shown until the GET resolves; mirrors the backend
// defaults so the controls don't flicker on load (backend is the source of
// truth — these are just the pre-fetch placeholder).
const DEFAULTS: SlideshowGlobalDefaults = {
  slideshow_fit: 'cover',
  slideshow_interval_ms: 5000,
  slideshow_transition: 'crossfade',
  slideshow_transition_ms: 800,
  slideshow_colorfilter: 'none',
  slideshow_watermark_enabled: false,
  slideshow_watermark_source: 'logo',
  slideshow_watermark_position: 'bottom-right',
  slideshow_watermark_opacity: 60,
  slideshow_watermark_style: 'white',
  slideshow_watermark_size: 12,
  slideshow_qr_enabled: false,
  slideshow_qr_position: 'bottom-left',
  slideshow_qr_opacity: 90,
  slideshow_qr_size: 14,
};

const inputClass =
  'w-full px-3 py-2 bg-neutral-50 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 text-neutral-900 dark:text-neutral-100 rounded-lg text-sm';
const labelClass = 'block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1';

export const SlideshowGlobalDefaultsCard: React.FC = () => {
  const { t } = useTranslation();
  const [val, setVal] = useState<SlideshowGlobalDefaults>(DEFAULTS);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    settingsService.getSettingsByType('slideshow').then((s) => {
      if (cancelled || !s) return;
      setVal({
        slideshow_fit: s.slideshow_fit ?? DEFAULTS.slideshow_fit,
        slideshow_interval_ms: s.slideshow_interval_ms ?? DEFAULTS.slideshow_interval_ms,
        slideshow_transition: s.slideshow_transition ?? DEFAULTS.slideshow_transition,
        slideshow_transition_ms: s.slideshow_transition_ms ?? DEFAULTS.slideshow_transition_ms,
        slideshow_colorfilter: s.slideshow_colorfilter ?? DEFAULTS.slideshow_colorfilter,
        slideshow_watermark_enabled: s.slideshow_watermark_enabled ?? DEFAULTS.slideshow_watermark_enabled,
        slideshow_watermark_source: s.slideshow_watermark_source ?? DEFAULTS.slideshow_watermark_source,
        slideshow_watermark_position: s.slideshow_watermark_position ?? DEFAULTS.slideshow_watermark_position,
        slideshow_watermark_opacity: s.slideshow_watermark_opacity ?? DEFAULTS.slideshow_watermark_opacity,
        slideshow_watermark_style: s.slideshow_watermark_style ?? DEFAULTS.slideshow_watermark_style,
        slideshow_watermark_size: s.slideshow_watermark_size ?? DEFAULTS.slideshow_watermark_size,
        slideshow_qr_enabled: s.slideshow_qr_enabled ?? DEFAULTS.slideshow_qr_enabled,
        slideshow_qr_position: s.slideshow_qr_position ?? DEFAULTS.slideshow_qr_position,
        slideshow_qr_opacity: s.slideshow_qr_opacity ?? DEFAULTS.slideshow_qr_opacity,
        slideshow_qr_size: s.slideshow_qr_size ?? DEFAULTS.slideshow_qr_size,
      });
    }).catch(() => { /* keep defaults */ });
    return () => { cancelled = true; };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await settingsService.updateSlideshowDefaults(val);
      toast.success(t('slideshow.defaultsSaved', 'Slideshow defaults saved'));
    } catch {
      toast.error(t('common.error', 'Something went wrong'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card padding="md" className="mb-6">
      <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-1 flex items-center gap-2">
        <MonitorPlay className="w-5 h-5" />
        {t('slideshow.globalTitle', 'Global slideshow settings')}
      </h2>
      <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-4">
        {t('slideshow.globalDescription', 'Defaults for every slideshow. Events can override the watermark on or off.')}
      </p>

      <div className="space-y-4">
        {/* Image fit */}
        <div>
          <label className={labelClass}>{t('slideshow.fitLabel', 'Image fit')}</label>
          <select
            value={val.slideshow_fit}
            onChange={(e) => setVal({ ...val, slideshow_fit: e.target.value as SlideshowGlobalDefaults['slideshow_fit'] })}
            className={inputClass}
          >
            {SLIDESHOW_FITS.map((f) => (
              <option key={f} value={f}>
                {t(`slideshow.fit.${f}`, f === 'contain' ? 'Black bars (no crop)' : 'Fill screen (crop)')}
              </option>
            ))}
          </select>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
            {t('slideshow.fitHint', '"Fill" crops to fill the screen; "Black bars" shows the whole photo — better for portrait images.')}
          </p>
        </div>

        {/* Default display style new slideshows inherit (override per event) */}
        <div className="pt-2 border-t border-neutral-200 dark:border-neutral-700">
          <p className="text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
            {t('slideshow.presetTitle', 'Default style for new slideshows')}
          </p>
          <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
            {t('slideshow.presetHint', 'Applied to events created from now on; each event can still override it.')}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className={labelClass}>{t('slideshow.transitionLabel', 'Transition')}</label>
              <select
                value={val.slideshow_transition}
                onChange={(e) => setVal({ ...val, slideshow_transition: e.target.value as SlideshowGlobalDefaults['slideshow_transition'] })}
                className={inputClass}
              >
                {SLIDESHOW_TRANSITIONS.map((tr) => (
                  <option key={tr} value={tr}>{t(`slideshow.transition.${tr}`, tr)}</option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>{t('slideshow.intervalLabel', 'Display time (sec)')}</label>
              <input
                type="number"
                min={1}
                max={120}
                value={Math.round(val.slideshow_interval_ms / 1000)}
                onChange={(e) => setVal({ ...val, slideshow_interval_ms: Math.min(120, Math.max(1, parseInt(e.target.value, 10) || 5)) * 1000 })}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>{t('slideshow.transitionSpeedLabel', 'Transition speed (ms)')}</label>
              <input
                type="number"
                min={100}
                max={5000}
                step={100}
                value={val.slideshow_transition_ms}
                onChange={(e) => setVal({ ...val, slideshow_transition_ms: Math.min(5000, Math.max(100, parseInt(e.target.value, 10) || 800)) })}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>{t('slideshow.colorfilterLabel', 'Color filter')}</label>
              <select
                value={val.slideshow_colorfilter}
                onChange={(e) => setVal({ ...val, slideshow_colorfilter: e.target.value as SlideshowGlobalDefaults['slideshow_colorfilter'] })}
                className={inputClass}
              >
                {SLIDESHOW_COLORFILTERS.map((cf) => (
                  <option key={cf} value={cf}>{t(`slideshow.colorfilter.${cf}`, cf)}</option>
                ))}
              </select>
            </div>
          </div>
        </div>

        <div className="pt-2 border-t border-neutral-200 dark:border-neutral-700">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1 w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
            checked={val.slideshow_watermark_enabled}
            onChange={(e) => setVal({ ...val, slideshow_watermark_enabled: e.target.checked })}
          />
          <div>
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              {t('slideshow.watermarkToggle', 'Logo watermark')}
            </span>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              {t('slideshow.watermarkDescription', 'Overlay a white, semi-transparent logo in a corner (like a TV station ident).')}
            </p>
          </div>
        </label>

        {val.slideshow_watermark_enabled && (
          <div className="space-y-3">
            <div>
              <label className={labelClass}>{t('slideshow.watermarkSourceLabel', 'Logo')}</label>
              <WatermarkSourcePicker
                value={val.slideshow_watermark_source}
                onChange={(s) => setVal({ ...val, slideshow_watermark_source: s })}
              />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div>
              <label className={labelClass}>{t('slideshow.watermarkPositionLabel', 'Position')}</label>
              <select
                value={val.slideshow_watermark_position}
                onChange={(e) => setVal({ ...val, slideshow_watermark_position: e.target.value as SlideshowGlobalDefaults['slideshow_watermark_position'] })}
                className={inputClass}
              >
                {SLIDESHOW_WATERMARK_POSITIONS.map((pos) => (
                  <option key={pos} value={pos}>
                    {t(`slideshow.watermarkPosition.${pos}`, pos)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>{t('slideshow.watermarkOpacityLabel', 'Opacity (%)')}</label>
              <input
                type="number"
                min={0}
                max={100}
                step={5}
                value={val.slideshow_watermark_opacity}
                onChange={(e) => setVal({ ...val, slideshow_watermark_opacity: Math.min(100, Math.max(0, parseInt(e.target.value, 10) || 0)) })}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>{t('slideshow.watermarkStyleLabel', 'Logo style')}</label>
              <select
                value={val.slideshow_watermark_style}
                onChange={(e) => setVal({ ...val, slideshow_watermark_style: e.target.value as SlideshowGlobalDefaults['slideshow_watermark_style'] })}
                className={inputClass}
              >
                {SLIDESHOW_WATERMARK_STYLES.map((st) => (
                  <option key={st} value={st}>
                    {t(`slideshow.watermarkStyle.${st}`, st === 'original' ? 'Original colors' : 'White')}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>{t('slideshow.watermarkSizeLabel', 'Size (% of screen)')}</label>
              <input
                type="number"
                min={3}
                max={40}
                step={1}
                value={val.slideshow_watermark_size}
                onChange={(e) => setVal({ ...val, slideshow_watermark_size: Math.min(40, Math.max(3, parseInt(e.target.value, 10) || 12)) })}
                className={inputClass}
              />
            </div>
            </div>
          </div>
        )}
        </div>

        {/* Share-link QR overlay (#837) */}
        <div className="pt-2 border-t border-neutral-200 dark:border-neutral-700">
        <label className="flex items-start gap-2">
          <input
            type="checkbox"
            className="mt-1 w-4 h-4 text-accent border-neutral-300 dark:border-neutral-600 rounded focus:ring-primary-500"
            checked={val.slideshow_qr_enabled}
            onChange={(e) => setVal({ ...val, slideshow_qr_enabled: e.target.checked })}
          />
          <div>
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">
              {t('slideshow.qrToggle', 'Gallery QR code')}
            </span>
            <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
              {t('slideshow.qrDescription', 'Show the gallery link as a QR code so guests can scan it straight off the screen.')}
            </p>
          </div>
        </label>

        {val.slideshow_qr_enabled && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3">
            <div>
              <label className={labelClass}>{t('slideshow.watermarkPositionLabel', 'Position')}</label>
              <select
                value={val.slideshow_qr_position}
                onChange={(e) => setVal({ ...val, slideshow_qr_position: e.target.value as SlideshowGlobalDefaults['slideshow_qr_position'] })}
                className={inputClass}
              >
                {SLIDESHOW_WATERMARK_POSITIONS.map((pos) => (
                  <option key={pos} value={pos}>
                    {t(`slideshow.watermarkPosition.${pos}`, pos)}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelClass}>{t('slideshow.watermarkOpacityLabel', 'Opacity (%)')}</label>
              <input
                type="number"
                min={0}
                max={100}
                step={5}
                value={val.slideshow_qr_opacity}
                onChange={(e) => setVal({ ...val, slideshow_qr_opacity: Math.min(100, Math.max(0, parseInt(e.target.value, 10) || 0)) })}
                className={inputClass}
              />
            </div>
            <div>
              <label className={labelClass}>{t('slideshow.watermarkSizeLabel', 'Size (% of screen)')}</label>
              <input
                type="number"
                min={5}
                max={40}
                step={1}
                value={val.slideshow_qr_size}
                onChange={(e) => setVal({ ...val, slideshow_qr_size: Math.min(40, Math.max(5, parseInt(e.target.value, 10) || 14)) })}
                className={inputClass}
              />
            </div>
          </div>
        )}
        </div>

        <Button variant="outline" size="md" leftIcon={<Save className="w-4 h-4" />} onClick={save} isLoading={saving}>
          {t('common.save', 'Save')}
        </Button>
      </div>
    </Card>
  );
};

export default SlideshowGlobalDefaultsCard;
