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
      {/* No tab title here — the Settings shell renders the section
          heading (icon + label + divider) for every tab that isn't in
          SettingsPage's TABS_WITH_OWN_HEADER, and it reads from the same
          `settings.slideshow.title` key, so repeating it stacked two
          identical H2s on top of each other (QA warning). */}
      <p className="text-sm text-neutral-600 dark:text-neutral-400">
        {t('settings.slideshow.subtitle', 'Global defaults for the Live Slideshow. Events and event types can override these.')}
      </p>
      <SlideshowGlobalDefaultsCard />
    </div>
  );
};

export default SlideshowSettingsPage;
