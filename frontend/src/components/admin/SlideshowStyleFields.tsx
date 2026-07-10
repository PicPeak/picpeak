/**
 * <SlideshowStyleFields>
 *
 * Shared, controlled editor for a slideshow's visual style — transition,
 * timing, watermark and color filter. Used in two places:
 *   - SlideshowSettingsCard (per-event live settings)
 *   - EventTypeModal (per-event-type preset that new events inherit)
 *
 * Purely presentational: it owns no persistence, just renders the controls
 * for a SlideshowStyle value and calls onChange with the next value.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  SLIDESHOW_TRANSITIONS,
  SLIDESHOW_COLORFILTERS,
  SLIDESHOW_WATERMARK_MODES,
  SLIDESHOW_ORDERS,
  type SlideshowStyle,
} from '../../services/slideshow.service';
import type { PhotoCategory } from '../../services/categories.service';

export interface SlideshowStyleFieldsProps {
  value: SlideshowStyle;
  onChange: (next: SlideshowStyle) => void;
  /** Event categories for the content filter (#202). Omitted/empty → the
   *  category picker is hidden (e.g. events without any categories). */
  categories?: PhotoCategory[];
}

const inputClass =
  'w-full px-3 py-2 bg-neutral-50 dark:bg-neutral-700 border border-neutral-300 dark:border-neutral-600 text-neutral-900 dark:text-neutral-100 rounded-lg text-sm';
const labelClass = 'block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1';

const titleCase = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export const SlideshowStyleFields: React.FC<SlideshowStyleFieldsProps> = ({ value, onChange, categories = [] }) => {
  const { t } = useTranslation();
  const set = (patch: Partial<SlideshowStyle>) => onChange({ ...value, ...patch });

  return (
    <div className="space-y-4">
      {/* Transition + timing */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div>
          <label className={labelClass}>{t('slideshow.transitionLabel', 'Transition')}</label>
          <select
            value={value.transition}
            onChange={(e) => set({ transition: e.target.value as SlideshowStyle['transition'] })}
            className={inputClass}
          >
            {SLIDESHOW_TRANSITIONS.map((tr) => (
              <option key={tr} value={tr}>
                {t(`slideshow.transition.${tr}`, titleCase(tr))}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelClass}>{t('slideshow.intervalLabel', 'Display time (sec)')}</label>
          <input
            type="number"
            min={1}
            max={120}
            value={Math.round(value.interval_ms / 1000)}
            onChange={(e) => set({ interval_ms: Math.min(120, Math.max(1, parseInt(e.target.value, 10) || 5)) * 1000 })}
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
            value={value.transition_ms}
            onChange={(e) => set({ transition_ms: Math.min(5000, Math.max(100, parseInt(e.target.value, 10) || 800)) })}
            className={inputClass}
          />
        </div>
      </div>

      {/* Color filter */}
      <div>
        <label className={labelClass}>{t('slideshow.colorfilterLabel', 'Color filter')}</label>
        <select
          value={value.colorfilter}
          onChange={(e) => set({ colorfilter: e.target.value as SlideshowStyle['colorfilter'] })}
          className={inputClass}
        >
          {SLIDESHOW_COLORFILTERS.map((cf) => (
            <option key={cf} value={cf}>
              {t(`slideshow.colorfilter.${cf}`, titleCase(cf))}
            </option>
          ))}
        </select>
      </div>

      {/* Play order + content filter (#202) */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className={labelClass}>{t('slideshow.orderLabel', 'Play order')}</label>
          <select
            value={value.order}
            onChange={(e) => set({ order: e.target.value as SlideshowStyle['order'] })}
            className={inputClass}
          >
            {SLIDESHOW_ORDERS.map((o) => (
              <option key={o} value={o}>
                {t(`slideshow.order.${o}`, o === 'random' ? 'Random (shuffle)' : 'Chronological')}
              </option>
            ))}
          </select>
        </div>
        {categories.length > 0 && (
          <div>
            <label className={labelClass}>{t('slideshow.categoryLabel', 'Show only category')}</label>
            <select
              value={value.category_id ?? ''}
              onChange={(e) => set({ category_id: e.target.value === '' ? null : parseInt(e.target.value, 10) })}
              className={inputClass}
            >
              <option value="">{t('slideshow.categoryAll', 'All photos')}</option>
              {categories.map((c) => (
                <option key={c.id} value={c.id}>{c.name}</option>
              ))}
            </select>
          </div>
        )}
      </div>

      {/* Watermark — MODE only. The look (logo/position/opacity/style/size)
          lives in Settings → Slideshow, so it isn't duplicated here. */}
      <div className="pt-2 border-t border-neutral-200 dark:border-neutral-700">
        <label className={labelClass}>{t('slideshow.watermarkToggle', 'Logo watermark')}</label>
        <select
          value={value.watermark}
          onChange={(e) => set({ watermark: e.target.value as SlideshowStyle['watermark'] })}
          className={inputClass}
        >
          {SLIDESHOW_WATERMARK_MODES.map((m) => (
            <option key={m} value={m}>
              {t(`slideshow.watermarkMode.${m}`, m === 'inherit' ? 'Use global default' : m === 'on' ? 'On' : 'Off')}
            </option>
          ))}
        </select>
        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
          {t('slideshow.watermarkModeHint', 'The logo, position, opacity, style and size are configured under Settings → Slideshow.')}
        </p>
      </div>
    </div>
  );
};

export default SlideshowStyleFields;
