/**
 * <WatermarkSourcePicker>
 *
 * Visible picker for the slideshow watermark logo. Instead of a blind dropdown
 * the admin sees each branding asset (light logo, dark-mode logo, favicon) and
 * the event's own logo, and clicks the one to overlay. Previews render on a
 * transparency checkerboard so both light and dark marks are visible.
 *
 * URLs come from the public settings (branding assets) + an optional per-event
 * logo. A source with no configured logo still selects, but shows a "not set"
 * placeholder so the admin knows to upload one.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { usePublicSettings } from '../../hooks/usePublicSettings';
import { buildResourceUrl } from '../../utils/url';
import type { SlideshowWatermarkSource } from '../../services/slideshow.service';

export interface WatermarkSourcePickerProps {
  value: SlideshowWatermarkSource;
  onChange: (s: SlideshowWatermarkSource) => void;
  /** Per-event hero logo, previewed for the 'event' source when available. */
  eventLogoUrl?: string | null;
}

// Classic transparency checkerboard so white and dark logos both show up.
const CHECKER: React.CSSProperties = {
  backgroundImage:
    'linear-gradient(45deg, #c8c8c8 25%, transparent 25%), linear-gradient(-45deg, #c8c8c8 25%, transparent 25%), linear-gradient(45deg, transparent 75%, #c8c8c8 75%), linear-gradient(-45deg, transparent 75%, #c8c8c8 75%)',
  backgroundSize: '12px 12px',
  backgroundPosition: '0 0, 0 6px, 6px -6px, -6px 0',
  backgroundColor: '#f0f0f0',
};

export const WatermarkSourcePicker: React.FC<WatermarkSourcePickerProps> = ({ value, onChange, eventLogoUrl }) => {
  const { t } = useTranslation();
  const { data: ps } = usePublicSettings();

  const options: Array<{ key: SlideshowWatermarkSource; label: string; url?: string | null }> = [
    { key: 'logo', label: t('slideshow.watermarkSource.logo', 'Light logo'), url: ps?.branding_logo_url },
    { key: 'logo_dark', label: t('slideshow.watermarkSource.logo_dark', 'Dark-mode logo'), url: ps?.branding_logo_url_dark },
    { key: 'favicon', label: t('slideshow.watermarkSource.favicon', 'Favicon'), url: ps?.branding_favicon_url },
    { key: 'event', label: t('slideshow.watermarkSource.event', 'Event logo'), url: eventLogoUrl },
  ];

  return (
    <div className="flex flex-wrap gap-2">
      {options.map((opt) => {
        const selected = value === opt.key;
        const resolved = opt.url ? buildResourceUrl(opt.url) : null;
        return (
          <button
            key={opt.key}
            type="button"
            onClick={() => onChange(opt.key)}
            title={opt.label}
            className={`w-24 rounded-lg border-2 overflow-hidden transition-all text-center ${
              selected
                ? 'tile-selected'
                : 'border-neutral-200 dark:border-neutral-600 hover:border-neutral-300 dark:hover:border-neutral-500'
            }`}
          >
            <div className="h-14 flex items-center justify-center" style={CHECKER}>
              {resolved ? (
                <img src={resolved} alt="" className="max-h-12 max-w-[80%] object-contain" draggable={false} />
              ) : (
                <span className="text-[10px] text-neutral-500">{t('slideshow.watermarkSource.notSet', 'Not set')}</span>
              )}
            </div>
            <div className="text-xs text-neutral-700 dark:text-neutral-300 py-1 px-1 truncate">{opt.label}</div>
          </button>
        );
      })}
    </div>
  );
};

export default WatermarkSourcePicker;
