import React from 'react';
import {
  Palette,
  Type,
  Grid3X3,
  Layers,
  Play,
  Clock,
  LayoutGrid,
  Layout,
  Columns,
  Film
} from 'lucide-react';
import { ThemeConfig, GalleryLayoutType, GALLERY_THEME_PRESETS } from '../../types/theme.types';
import { useTranslation } from 'react-i18next';

interface ThemeDisplayProps {
  theme: ThemeConfig | string;
  presetName?: string;
  className?: string;
  showDetails?: boolean;
}

const layoutIcons: Record<GalleryLayoutType, React.ReactNode> = {
  grid: <Grid3X3 className="w-4 h-4" />,
  masonry: <Layers className="w-4 h-4" />,
  carousel: <Play className="w-4 h-4" />,
  timeline: <Clock className="w-4 h-4" />,
  mosaic: <LayoutGrid className="w-4 h-4" />,
  'gallery-premium': <Columns className="w-4 h-4" />,
  'gallery-story': <Film className="w-4 h-4" />
};

export const ThemeDisplay: React.FC<ThemeDisplayProps> = ({ 
  theme, 
  presetName,
  className = '',
  showDetails = true 
}) => {
  const { t } = useTranslation();
  
  // Parse theme if it's a string
  let themeConfig: ThemeConfig | null = null;
  let themeName = t('branding.theme');
  
  if (typeof theme === 'string') {
    try {
      if (theme.startsWith('{')) {
        themeConfig = JSON.parse(theme);
      } else {
        // Legacy theme name - find matching preset
        const preset = Object.entries(GALLERY_THEME_PRESETS).find(([key]) => key === theme);
        if (preset) {
          themeConfig = preset[1].config;
          themeName = preset[1].name;
        }
      }
    } catch (e) {
      console.error('Failed to parse theme:', e);
    }
  } else {
    themeConfig = theme;
  }
  
  // If we have a preset name, use its display name
  if (presetName && GALLERY_THEME_PRESETS[presetName]) {
    themeName = GALLERY_THEME_PRESETS[presetName].name;
  }
  
  if (!themeConfig) {
    return (
      <div className={`text-sm text-neutral-500 ${className}`}>
        {t('events.noThemeSet')}
      </div>
    );
  }
  
  const galleryLayout = themeConfig.galleryLayout || 'grid';
  
  return (
    <div className={`space-y-3 ${className}`}>
      {/* Theme Name & Layout */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Layout className="w-4 h-4 text-neutral-500 dark:text-neutral-300" />
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-100">{themeName}</span>
        </div>
        <div className="flex items-center gap-2 text-sm text-neutral-600 dark:text-neutral-200">
          {layoutIcons[galleryLayout]}
          <span className="capitalize">{t(`branding.layoutDescriptions.${galleryLayout}`)}</span>
        </div>
      </div>

      {showDetails && (
        <>
          {/* Color Palette — show all 8 tokens of the active theme.
              Each swatch only renders if its token is set so legacy themes
              (pre-8-token migration) still render their original 4 swatches. */}
          <div className="flex items-center gap-2">
            <Palette className="w-4 h-4 text-neutral-500 dark:text-neutral-300" />
            <span className="text-sm text-neutral-600 dark:text-neutral-200">{t('branding.colors')}:</span>
            <div className="flex gap-1">
              {[
                { value: themeConfig.backgroundColor, title: t('branding.backgroundColor', 'Background') },
                { value: themeConfig.surfaceColor, title: t('branding.surfaceColor', 'Surface') },
                { value: themeConfig.elevatedColor, title: t('branding.elevatedColor', 'Elevated') },
                { value: themeConfig.surfaceBorderColor, title: t('branding.borderColor', 'Border') },
                { value: themeConfig.textColor, title: t('branding.textColor', 'Text') },
                { value: themeConfig.mutedTextColor, title: t('branding.mutedTextColor', 'Muted text') },
                { value: themeConfig.accentColor, title: t('branding.accentColor', 'Accent') },
                { value: themeConfig.accentDarkColor || themeConfig.primaryColor, title: t('branding.accentDarkColor', 'Accent (filled)') },
              ].filter((s) => !!s.value).map((s, i) => (
                <div
                  key={i}
                  className="w-6 h-6 rounded border border-neutral-300 dark:border-neutral-600"
                  style={{ backgroundColor: s.value }}
                  title={s.title}
                />
              ))}
            </div>
          </div>

          {/* Typography */}
          {themeConfig.fontFamily && (
            <div className="flex items-center gap-2">
              <Type className="w-4 h-4 text-neutral-500 dark:text-neutral-300" />
              <span className="text-sm text-neutral-600 dark:text-neutral-200">{t('branding.bodyFont')}:</span>
              <span className="text-sm font-medium text-neutral-700 dark:text-neutral-100" style={{ fontFamily: themeConfig.fontFamily }}>
                {themeConfig.fontFamily}
              </span>
            </div>
          )}

          {/* Layout Settings */}
          {themeConfig.gallerySettings && (
            <div className="text-sm text-neutral-600 dark:text-neutral-200">
              {themeConfig.gallerySettings.spacing && (
                <span className="inline-flex items-center gap-1 mr-3">
                  <span>{t('branding.photoSpacing')}:</span>
                  <span className="font-medium capitalize text-neutral-700 dark:text-neutral-100">
                    {t(`branding.spacing.${themeConfig.gallerySettings.spacing}`)}
                  </span>
                </span>
              )}
              {themeConfig.gallerySettings.photoAnimation && themeConfig.gallerySettings.photoAnimation !== 'none' && (
                <span className="inline-flex items-center gap-1">
                  <span>{t('branding.photoAnimation')}:</span>
                  <span className="font-medium capitalize text-neutral-700 dark:text-neutral-100">
                    {t(`branding.animation.${themeConfig.gallerySettings.photoAnimation}`)}
                  </span>
                </span>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
};

ThemeDisplay.displayName = 'ThemeDisplay';