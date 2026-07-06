/**
 * Settings → Slideshow tab. Top-level (global) Live Slideshow settings.
 * Currently the global watermark default (source/position/opacity/style) that
 * every event inherits unless it overrides. Gated behind the `slideshow`
 * feature flag (see SettingsPage nav).
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { SlideshowGlobalDefaultsCard } from '../../components/admin/SlideshowGlobalDefaultsCard';

export const SlideshowSettingsPage: React.FC = () => {
  const { t } = useTranslation();
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100">
          {t('settings.slideshow.title', 'Slideshow')}
        </h2>
        <p className="text-sm text-neutral-600 dark:text-neutral-400 mt-1">
          {t('settings.slideshow.subtitle', 'Global defaults for the Live Slideshow. Events and event types can override these.')}
        </p>
      </div>
      <SlideshowGlobalDefaultsCard />
    </div>
  );
};

export default SlideshowSettingsPage;
