import React from 'react';
import { Sparkles, Check, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card } from '../../common';
import { GALLERY_THEME_PRESETS } from '../../../types/theme.types';
import { layoutIcons } from './icons';

interface ThemePresetsCardProps {
  selectedPreset: string;
  handlePresetSelect: (presetKey: string) => void;
  showGalleryLayouts: boolean;
  isBetaLayout: boolean;
  isThumbnailTooSmall: boolean;
  thumbnailWidth: number;
  thumbnailHeight: number;
  minRecommendedThumbnailSize: number;
}

export const ThemePresetsCard: React.FC<ThemePresetsCardProps> = ({
  selectedPreset,
  handlePresetSelect,
  showGalleryLayouts,
  isBetaLayout,
  isThumbnailTooSmall,
  thumbnailWidth,
  thumbnailHeight,
  minRecommendedThumbnailSize
}) => {
  const { t } = useTranslation();

  return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4 flex items-center gap-2">
        <Sparkles className="w-5 h-5" />
        {t('branding.themePresets')}
      </h3>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {Object.entries(GALLERY_THEME_PRESETS).map(([key, theme]) => (
          <button
            type="button"
            key={key}
            onClick={() => handlePresetSelect(key)}
            className={`relative p-4 rounded-lg border-2 transition-all text-left ${
              selectedPreset === key
                ? 'tile-selected'
                : 'border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600'
            }`}
          >
            <div className="flex items-start justify-between mb-2">
              <div>
                <span className="font-medium text-sm block text-neutral-900 dark:text-neutral-100">{theme.name}</span>
                {theme.description && (
                  <span className="text-xs text-neutral-600 dark:text-neutral-400 mt-1 block">{theme.description}</span>
                )}
              </div>
              {selectedPreset === key && (
                <Check className="w-4 h-4 text-accent-dark flex-shrink-0" />
              )}
            </div>
            <div className="flex items-center gap-2 mt-3">
              <div className="flex gap-1">
                {/* Preview swatches: background, surface, accent-dark, accent
                    — gives a quick read of the preset's full palette. */}
                <div
                  className="w-5 h-5 rounded-full border border-neutral-200 dark:border-neutral-600"
                  style={{ backgroundColor: theme.config.backgroundColor }}
                />
                <div
                  className="w-5 h-5 rounded-full border border-neutral-200 dark:border-neutral-600"
                  style={{ backgroundColor: theme.config.surfaceColor || theme.config.backgroundColor }}
                />
                <div
                  className="w-5 h-5 rounded-full border border-neutral-200 dark:border-neutral-600"
                  style={{ backgroundColor: theme.config.accentDarkColor || theme.config.primaryColor }}
                />
                <div
                  className="w-5 h-5 rounded-full border border-neutral-200 dark:border-neutral-600"
                  style={{ backgroundColor: theme.config.accentColor }}
                />
              </div>
              {theme.config.galleryLayout && layoutIcons[theme.config.galleryLayout] && (
                <div className="ml-auto text-neutral-400">
                  {layoutIcons[theme.config.galleryLayout]}
                </div>
              )}
            </div>
          </button>
        ))}
      </div>

      {/* Warning: Beta preset with low thumbnail resolution */}
      {isBetaLayout && isThumbnailTooSmall && !showGalleryLayouts && (
        <div className="mt-4 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                {t('branding.betaThumbnailWarningTitle')}
              </p>
              <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
                {t('branding.betaThumbnailWarningText', { width: thumbnailWidth, height: thumbnailHeight, recommended: minRecommendedThumbnailSize })}
              </p>
              <a
                href="/admin/settings"
                className="inline-flex items-center gap-1 mt-2 text-sm font-medium text-amber-800 dark:text-amber-300 hover:underline"
                onClick={(e) => {
                  e.preventDefault();
                  window.location.href = '/admin/settings';
                }}
              >
                {t('branding.betaThumbnailWarningLink')} →
              </a>
            </div>
          </div>
        </div>
      )}
    </Card>
  );
};
