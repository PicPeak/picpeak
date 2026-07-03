import React, { useState, useEffect } from 'react';
import { Palette, RotateCcw, Check, Layout, LayoutTemplate, Type, Sparkles, Grid3X3, Layers, Play, Clock, Image, LayoutGrid, ChevronDown, Code, Info, FileCode, ImageIcon, Minimize2, EyeOff, Menu, SlidersHorizontal, Columns, Film, AlertTriangle } from 'lucide-react';
import { Button, Card, Input } from '../common';
import { ThemeConfig, GALLERY_THEME_PRESETS, GalleryLayoutType, HeaderStyleType, HeroDividerStyle } from '../../types/theme.types';
import type { EnabledTemplate } from '../../services/cssTemplates.service';
import { settingsService } from '../../services/settings.service';
import { fontsService, extractFamilyName, type FontDefinition } from '../../services/fonts.service';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';

/**
 * Build the CSS font-family value for a scanned font, using the generic
 * fallback the backend supplied (from each family's optional meta.json).
 * Defaults to 'sans-serif' when the backend doesn't report one — keeps
 * compatibility with backends that predate the generic field.
 */
function buildFontFamilyValue(font: FontDefinition): string {
  const generic = font.generic ?? 'sans-serif';
  // Always quote the family name (covers multi-word like 'Playfair Display').
  return `'${font.family}', ${generic}`;
}

/**
 * Match a saved CSS font-family string against the available scanned families
 * and return the canonical option value the dropdown renders. Handles both
 * legacy unquoted strings ("Inter, sans-serif") and the new quoted format
 * ("'Inter', sans-serif"), so events saved before this change still show the
 * right option as selected.
 */
function resolveFontDropdownValue(
  saved: string | undefined,
  available: FontDefinition[] | undefined,
  fallback: string
): string {
  if (!saved) return fallback;
  const family = extractFamilyName(saved);
  if (!family) return saved; // generic family like "system-ui, sans-serif"
  const match = (available || []).find(
    (f) => f.family.toLowerCase() === family.toLowerCase()
  );
  return match ? buildFontFamilyValue(match) : saved;
}

interface ThemeCustomizerEnhancedProps {
  value: ThemeConfig;
  onChange: (theme: ThemeConfig) => void;
  presetName?: string;
  onPresetChange?: (presetName: string) => void;
  showGalleryLayouts?: boolean;
  hideActions?: boolean;
  onApply?: (theme: ThemeConfig, metadata: { presetName: string }) => Promise<void> | void;
  isApplying?: boolean;
  // CSS Template props
  cssTemplates?: EnabledTemplate[];
  cssTemplateId?: number | null;
  onCssTemplateChange?: (templateId: number | null) => void;
  // Force color mode is an instance-level branding setting (not part of the
  // per-theme config), but it lives next to the per-theme Color Mode picker
  // so the Branding admin can find both controls in one place. When these
  // props are omitted (e.g. event-level theme editor), the section is hidden.
  forceColorMode?: 'dark' | 'light' | null;
  onForceColorModeChange?: (mode: 'dark' | 'light' | null) => void;
  // Sync palette from Branding. When provided, a small button appears in
  // the colour-pickers section header. The caller resolves the active
  // Branding theme and fires onChange with the merged 8-token values —
  // only the colour tokens swap, layout/header/typography stay put so an
  // admin who's already arranged the structure can pull just the palette.
  onSyncFromBranding?: () => void;
  // Optional render slot inserted between the Typography & Style /
  // CSS Templates section and the Event-specific Custom CSS card.
  // Used by BrandingPage to slot in unrelated cards (PDF typography)
  // so they live with the other typography choices rather than after
  // the always-bulky Custom CSS editor.
  slotBeforeCustomCss?: React.ReactNode;
}

/**
 * Compact color-picker row used by the 8-token palette.
 * Renders [Label + Info icon (tooltip)] / [color swatch + hex input].
 * Help text is hidden in the static layout (lives on the Info icon's title
 * attribute) so all rows are the same height — keeps the four Surfaces
 * pickers and the two Accent pickers grid-aligned without forcing the user
 * to read every help string up front.
 */
const ColorPickerRow: React.FC<{
  label: string;
  help: string;
  value: string;
  fallback: string;
  onChange: (value: string) => void;
}> = ({ label, help, value, fallback, onChange }) => (
  <div>
    <label className="flex items-center gap-1.5 text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
      {label}
      <span
        className="info-tooltip text-neutral-400 dark:text-neutral-500"
        data-tooltip={help}
        tabIndex={0}
      >
        <Info className="w-3.5 h-3.5" />
      </span>
    </label>
    <div className="flex gap-2">
      <input
        type="color"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="h-10 w-20 rounded border border-neutral-300 dark:border-neutral-600 cursor-pointer"
      />
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={fallback}
        className="flex-1"
      />
    </div>
  </div>
);

const layoutIcons: Record<GalleryLayoutType, React.ReactNode> = {
  grid: <Grid3X3 className="w-5 h-5" />,
  masonry: <Layers className="w-5 h-5" />,
  carousel: <Play className="w-5 h-5" />,
  timeline: <Clock className="w-5 h-5" />,
  mosaic: <LayoutGrid className="w-5 h-5" />,
  'gallery-premium': <Columns className="w-5 h-5" />,
  'gallery-story': <Film className="w-5 h-5" />
};

const headerStyleIcons: Record<HeaderStyleType, React.ReactNode> = {
  hero: <Image className="w-5 h-5" />,
  standard: <Layout className="w-5 h-5" />,
  banner: <LayoutTemplate className="w-5 h-5" />,
  minimal: <Minimize2 className="w-5 h-5" />,
  none: <EyeOff className="w-5 h-5" />
};

const dividerStylePreviews: Record<HeroDividerStyle, React.ReactNode> = {
  wave: (
    <svg className="w-full h-6" viewBox="0 0 100 24" preserveAspectRatio="none">
      <path d="M0,12 C12,18 37,6 50,12 C63,18 88,6 100,12 L100,24 L0,24 Z" fill="currentColor" className="text-neutral-300" />
    </svg>
  ),
  straight: (
    <svg className="w-full h-6" viewBox="0 0 100 24" preserveAspectRatio="none">
      <rect x="0" y="12" width="100" height="12" fill="currentColor" className="text-neutral-300" />
    </svg>
  ),
  angle: (
    <svg className="w-full h-6" viewBox="0 0 100 24" preserveAspectRatio="none">
      <path d="M0,24 L100,8 L100,24 Z" fill="currentColor" className="text-neutral-300" />
    </svg>
  ),
  curve: (
    <svg className="w-full h-6" viewBox="0 0 100 24" preserveAspectRatio="none">
      <path d="M0,16 Q50,0 100,16 L100,24 L0,24 Z" fill="currentColor" className="text-neutral-300" />
    </svg>
  ),
  none: (
    <svg className="w-full h-6" viewBox="0 0 100 24" preserveAspectRatio="none">
      <rect x="0" y="0" width="100" height="24" fill="currentColor" className="text-neutral-100" />
      <text x="50" y="16" textAnchor="middle" fontSize="10" fill="currentColor" className="text-neutral-400">No divider</text>
    </svg>
  )
};

// Layout descriptions will use translation keys

export const ThemeCustomizerEnhanced: React.FC<ThemeCustomizerEnhancedProps> = ({
  value,
  onChange,
  presetName = 'default',
  onPresetChange,
  showGalleryLayouts = true,
  hideActions = false,
  onApply,
  isApplying = false,
  cssTemplates,
  cssTemplateId,
  onCssTemplateChange,
  forceColorMode,
  onForceColorModeChange,
  onSyncFromBranding,
  slotBeforeCustomCss
}) => {
  const { t } = useTranslation();
  // A force lock (instance-wide light/dark) overrides the per-theme color
  // mode. On the Branding page (where the Force control lives —
  // onForceColorModeChange is provided) we hide only the now-redundant
  // per-theme Color Mode picker. In per-event gallery editors (no Force
  // control) we ALSO hide the colour pickers, since a gallery can't override
  // the site-wide lock. Presets, fonts and style always stay.
  const forcedColorActive = (forceColorMode ?? null) !== null;
  const isBrandingContext = !!onForceColorModeChange;
  const hideGalleryColors = forcedColorActive && !isBrandingContext;
  const [localTheme, setLocalTheme] = useState<ThemeConfig>(value);
  const [selectedPreset, setSelectedPreset] = useState(presetName);
  const [customCss, setCustomCss] = useState(value.customCss || '');
  const [showCssInstructions, setShowCssInstructions] = useState(false);

  const BETA_LAYOUTS: GalleryLayoutType[] = ['gallery-premium', 'gallery-story'];
  const MIN_RECOMMENDED_THUMBNAIL_SIZE = 500;

  // Fetch thumbnail settings to warn about low resolution with beta themes
  const { data: allSettings } = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => settingsService.getAllSettings(),
    staleTime: 60000,
  });

  // Fetch the list of self-hosted font families discovered by the backend
  // scanner. Used to populate the body / heading font dropdowns. Cached
  // 5 minutes — fonts rarely change without a backend restart.
  const { data: availableFonts } = useQuery<FontDefinition[]>({
    queryKey: ['fonts'],
    queryFn: () => fontsService.list(),
    staleTime: 5 * 60 * 1000,
  });

  const thumbnailWidth = parseInt(allSettings?.thumbnail_width) || 300;
  const thumbnailHeight = parseInt(allSettings?.thumbnail_height) || 300;
  const isBetaLayout = BETA_LAYOUTS.includes(localTheme.galleryLayout as GalleryLayoutType);
  const isThumbnailTooSmall = Math.max(thumbnailWidth, thumbnailHeight) < MIN_RECOMMENDED_THUMBNAIL_SIZE;

  useEffect(() => {
    setLocalTheme(value);
    setCustomCss(value.customCss || '');
  }, [value]);

  useEffect(() => {
    setSelectedPreset(presetName);
  }, [presetName]);

  const handleChange = (key: keyof ThemeConfig, newValue: any) => {
    const updated: ThemeConfig = { ...localTheme, [key]: newValue };
    // Legacy alias: keep primaryColor in lockstep with accentDarkColor so
    // any consumer that still reads --color-primary or themeConfig.primaryColor
    // doesn't drift after the 8-token migration.
    if (key === 'accentDarkColor') {
      updated.primaryColor = newValue;
    }
    setLocalTheme(updated);

    // When any change is made, mark it as custom
    if (selectedPreset !== 'custom' && onPresetChange) {
      setSelectedPreset('custom');
      onPresetChange('custom');
    }

    // Always propagate to parent so Save sees the latest values (#323).
    // The "Apply changes immediately (Live Preview)" toggle controls whether
    // the parent applies the theme globally — that gating belongs in the
    // parent, not here.
    onChange({ ...updated, customCss });
  };

  const handlePresetSelect = (presetKey: string) => {
    const preset = GALLERY_THEME_PRESETS[presetKey];
    if (preset) {
      setSelectedPreset(presetKey);
      setLocalTheme(preset.config);
      // Don't wipe customCss on preset pick — preset configs carry no
      // customCss, and the admin's persisted styling extras should
      // survive a layout switch (#645). Matches ThemeCustomizer.tsx
      // which never cleared it. The parent's handleThemeChange merges
      // via `customCss: newTheme.customCss ?? currentTheme.customCss`,
      // so propagating preset.config (no customCss) keeps the saved
      // value intact end-to-end.
      if (onPresetChange) {
        onPresetChange(presetKey);
      }
      // Always propagate; live-apply gating is the parent's concern (#323).
      onChange(preset.config);
    }
  };

  const handleApply = async () => {
    const themeWithCss = { ...localTheme, customCss };
    onChange(themeWithCss);

    if (onApply) {
      await onApply(themeWithCss, { presetName: selectedPreset });
    }
  };

  const handleReset = () => {
    const defaultPreset = GALLERY_THEME_PRESETS['default'];
    if (defaultPreset) {
      setSelectedPreset('default');
      setLocalTheme(defaultPreset.config);
      setCustomCss('');
      onChange(defaultPreset.config);
      if (onPresetChange) {
        onPresetChange('default');
      }
    }
  };

  // const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
  //   const file = e.target.files?.[0];
  //   if (file) {
  //     try {
  //       const logoUrl = await settingsService.uploadLogo(file);
  //       handleChange('logoUrl', logoUrl);
  //       toast.success('Logo uploaded successfully');
  //     } catch (error) {
  //       console.error('Failed to upload logo:', error);
  //       toast.error('Failed to upload logo');
  //     }
  //   }
  // };

  const updateGallerySettings = (key: string, value: any) => {
    const updatedSettings = {
      ...localTheme.gallerySettings,
      [key]: value
    };
    handleChange('gallerySettings', updatedSettings);
  };

  return (
    <div className="space-y-6">
      {/* Preset Themes */}
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
                  {t('branding.betaThumbnailWarningText', { width: thumbnailWidth, height: thumbnailHeight, recommended: MIN_RECOMMENDED_THUMBNAIL_SIZE })}
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

      {/* Gallery Layout */}
      {showGalleryLayouts && (
        <Card className="p-6">
          <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4 flex items-center gap-2">
            <Layout className="w-5 h-5" />
            {t('branding.galleryLayout')}
          </h3>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {(Object.keys(layoutIcons) as GalleryLayoutType[]).map((layout) => (
              <button
                type="button"
                key={layout}
                onClick={() => handleChange('galleryLayout', layout)}
                className={`relative p-4 rounded-lg border-2 transition-all ${
                  localTheme.galleryLayout === layout
                    ? 'tile-selected'
                    : 'border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600'
                }`}
              >
                <div className="flex flex-col items-center text-center">
                  <div className="mb-2 text-neutral-700 dark:text-neutral-300">
                    {layoutIcons[layout]}
                  </div>
                  <span className="font-medium text-sm capitalize text-neutral-900 dark:text-neutral-100">
                    {layout}
                    {(layout === 'gallery-premium' || layout === 'gallery-story') && (
                      <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">(Beta)</span>
                    )}
                  </span>
                  <span className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
                    {t(`branding.layoutDescriptions.${layout}`)}
                  </span>
                </div>
                {localTheme.galleryLayout === layout && (
                  <Check className="absolute top-2 right-2 w-4 h-4 text-accent-dark" />
                )}
              </button>
            ))}
          </div>

          {/* Warning: Beta theme with low thumbnail resolution */}
          {isBetaLayout && isThumbnailTooSmall && (
            <div className="mt-4 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
              <div className="flex items-start gap-3">
                <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
                <div>
                  <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                    {t('branding.betaThumbnailWarningTitle')}
                  </p>
                  <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
                    {t('branding.betaThumbnailWarningText', { width: thumbnailWidth, height: thumbnailHeight, recommended: MIN_RECOMMENDED_THUMBNAIL_SIZE })}
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

          {/* Layout-specific settings */}
          {localTheme.galleryLayout && (
            <div className="mt-6 space-y-4 pt-6 border-t border-neutral-200 dark:border-neutral-700">
              <h4 className="font-medium text-sm text-neutral-700 dark:text-neutral-300">{t('branding.layoutSettings')}</h4>
              
              {/* Common settings */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                    {t('branding.photoSpacing')}
                  </label>
                  <select
                    value={localTheme.gallerySettings?.spacing || 'normal'}
                    onChange={(e) => updateGallerySettings('spacing', e.target.value)}
                    className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
                  >
                    <option value="tight">{t('branding.spacing.tight')}</option>
                    <option value="normal">{t('branding.spacing.normal')}</option>
                    <option value="relaxed">{t('branding.spacing.relaxed')}</option>
                  </select>
                </div>

                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                    {t('branding.photoAnimation')}
                  </label>
                  <select
                    value={localTheme.gallerySettings?.photoAnimation || 'fade'}
                    onChange={(e) => updateGallerySettings('photoAnimation', e.target.value)}
                    className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
                  >
                    <option value="none">{t('branding.animation.none')}</option>
                    <option value="fade">{t('branding.animation.fade')}</option>
                    <option value="scale">{t('branding.animation.scale')}</option>
                    <option value="slide">{t('branding.animation.slide')}</option>
                  </select>
                </div>
              </div>

              {/* Grid specific */}
              {localTheme.galleryLayout === 'grid' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                      {t('branding.columns')}
                    </label>
                    <div className="grid grid-cols-3 gap-4">
                      <div>
                        <label className="text-xs text-neutral-600 dark:text-neutral-400">{t('branding.mobile')}</label>
                        <Input
                          type="number"
                          min="1"
                          max="4"
                          value={localTheme.gallerySettings?.gridColumns?.mobile || 2}
                          onChange={(e) => updateGallerySettings('gridColumns', {
                            ...localTheme.gallerySettings?.gridColumns,
                            mobile: parseInt(e.target.value)
                          })}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-neutral-600 dark:text-neutral-400">{t('branding.tablet')}</label>
                        <Input
                          type="number"
                          min="2"
                          max="6"
                          value={localTheme.gallerySettings?.gridColumns?.tablet || 3}
                          onChange={(e) => updateGallerySettings('gridColumns', {
                            ...localTheme.gallerySettings?.gridColumns,
                            tablet: parseInt(e.target.value)
                          })}
                        />
                      </div>
                      <div>
                        <label className="text-xs text-neutral-600 dark:text-neutral-400">{t('branding.desktop')}</label>
                        <Input
                          type="number"
                          min="3"
                          max="8"
                          value={localTheme.gallerySettings?.gridColumns?.desktop || 4}
                          onChange={(e) => updateGallerySettings('gridColumns', {
                            ...localTheme.gallerySettings?.gridColumns,
                            desktop: parseInt(e.target.value)
                          })}
                        />
                      </div>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                      {t('branding.thumbnailScale', 'Thumbnail Scale')}
                    </label>
                    <select
                      value={localTheme.gallerySettings?.thumbnailScale || 'md'}
                      onChange={(e) => updateGallerySettings('thumbnailScale', e.target.value)}
                      className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
                    >
                      <option value="xs">{t('branding.thumbnailScaleOptions.xs', 'XS — Most photos')}</option>
                      <option value="sm">{t('branding.thumbnailScaleOptions.sm', 'SM — More photos')}</option>
                      <option value="md">{t('branding.thumbnailScaleOptions.md', 'MD — Default')}</option>
                      <option value="lg">{t('branding.thumbnailScaleOptions.lg', 'LG — Larger photos')}</option>
                      <option value="xl">{t('branding.thumbnailScaleOptions.xl', 'XL — Largest photos')}</option>
                    </select>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                      {t('branding.thumbnailScaleHint', 'Adjusts column count relative to the base grid columns')}
                    </p>
                  </div>
                </>
              )}

              {/* Carousel specific */}
              {localTheme.galleryLayout === 'carousel' && (
                <>
                  <div>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={localTheme.gallerySettings?.carouselAutoplay || false}
                        onChange={(e) => updateGallerySettings('carouselAutoplay', e.target.checked)}
                        className="rounded"
                      />
                      <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('branding.enableAutoplay')}</span>
                    </label>
                  </div>
                  {localTheme.gallerySettings?.carouselAutoplay && (
                    <div>
                      <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                        {t('branding.autoplayInterval')}
                      </label>
                      <Input
                        type="number"
                        min="2"
                        max="10"
                        value={(localTheme.gallerySettings?.carouselInterval || 5000) / 1000}
                        onChange={(e) => updateGallerySettings('carouselInterval', parseInt(e.target.value) * 1000)}
                      />
                    </div>
                  )}
                </>
              )}

              {/* Timeline specific */}
              {localTheme.galleryLayout === 'timeline' && (
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                    {t('branding.groupPhotosBy')}
                  </label>
                  <select
                    value={localTheme.gallerySettings?.timelineGrouping || 'day'}
                    onChange={(e) => updateGallerySettings('timelineGrouping', e.target.value)}
                    className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
                  >
                    <option value="day">{t('branding.grouping.day')}</option>
                    <option value="week">{t('branding.grouping.week')}</option>
                    <option value="month">{t('branding.grouping.month')}</option>
                  </select>
                </div>
              )}

              {/* Masonry specific */}
              {localTheme.galleryLayout === 'masonry' && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                      {t('branding.masonryMode', 'Layout Mode')}
                    </label>
                    <select
                      value={localTheme.gallerySettings?.masonryMode || 'columns'}
                      onChange={(e) => updateGallerySettings('masonryMode', e.target.value)}
                      className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
                    >
                      <option value="columns">{t('branding.masonryModeOptions.columns', 'Columns (Pinterest-style)')}</option>
                      <option value="rows">{t('branding.masonryModeOptions.rows', 'Rows (Custom justified)')}</option>
                      <option value="flickr">{t('branding.masonryModeOptions.flickr', 'Flickr (Battle-tested justified)')}</option>
                      <option value="justified">{t('branding.masonryModeOptions.justified', 'Google Photos (Knuth-Plass algorithm)')}</option>
                    </select>
                    <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                      {localTheme.gallerySettings?.masonryMode === 'columns'
                        ? t('branding.masonryModeHint.columns', 'Pinterest-style vertical columns with varied heights')
                        : localTheme.gallerySettings?.masonryMode === 'flickr'
                        ? t('branding.masonryModeHint.flickr', 'Flickr\'s open-source justified layout algorithm')
                        : localTheme.gallerySettings?.masonryMode === 'justified'
                        ? t('branding.masonryModeHint.justified', 'Google Photos-style rows using Knuth-Plass algorithm for optimal breaks')
                        : t('branding.masonryModeHint.rows', 'Custom row-based justified layout')}
                    </p>
                  </div>

                  {/* Thumbnail scale - only for columns mode */}
                  {(!localTheme.gallerySettings?.masonryMode || localTheme.gallerySettings?.masonryMode === 'columns') && (
                    <div>
                      <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                        {t('branding.thumbnailScale', 'Thumbnail Scale')}
                      </label>
                      <select
                        value={localTheme.gallerySettings?.thumbnailScale || 'md'}
                        onChange={(e) => updateGallerySettings('thumbnailScale', e.target.value)}
                        className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
                      >
                        <option value="xs">{t('branding.thumbnailScaleOptions.xs', 'XS — Most photos')}</option>
                        <option value="sm">{t('branding.thumbnailScaleOptions.sm', 'SM — More photos')}</option>
                        <option value="md">{t('branding.thumbnailScaleOptions.md', 'MD — Default')}</option>
                        <option value="lg">{t('branding.thumbnailScaleOptions.lg', 'LG — Larger photos')}</option>
                        <option value="xl">{t('branding.thumbnailScaleOptions.xl', 'XL — Largest photos')}</option>
                      </select>
                      <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                        {t('branding.thumbnailScaleHint', 'Adjusts column count relative to the base grid columns')}
                      </p>
                    </div>
                  )}

                  {/* Row-specific settings - show for all row-based modes */}
                  {['rows', 'flickr', 'justified'].includes(localTheme.gallerySettings?.masonryMode || '') && (
                    <>
                      <div>
                        <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                          {t('branding.targetRowHeight', 'Target Row Height')}
                        </label>
                        <Input
                          type="number"
                          min="150"
                          max="400"
                          value={localTheme.gallerySettings?.masonryRowHeight || 250}
                          onChange={(e) => updateGallerySettings('masonryRowHeight', parseInt(e.target.value))}
                        />
                        <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                          {t('branding.targetRowHeightHint', 'Height in pixels (150-400). Photos will scale to fit rows.')}
                        </p>
                      </div>
                      {/* Last row behavior - only for rows and flickr modes */}
                      {['rows', 'flickr'].includes(localTheme.gallerySettings?.masonryMode || '') && (
                        <div>
                          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                            {t('branding.lastRowBehavior', 'Last Row Alignment')}
                          </label>
                          <select
                            value={localTheme.gallerySettings?.masonryLastRowBehavior || 'left'}
                            onChange={(e) => updateGallerySettings('masonryLastRowBehavior', e.target.value)}
                            className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
                          >
                            <option value="left">{t('branding.lastRowOptions.left', 'Left aligned')}</option>
                            <option value="center">{t('branding.lastRowOptions.center', 'Centered')}</option>
                            <option value="justify">{t('branding.lastRowOptions.justify', 'Justified (stretch)')}</option>
                          </select>
                        </div>
                      )}
                    </>
                  )}
                </>
              )}

              {/* Mosaic specific */}
              {localTheme.galleryLayout === 'mosaic' && (
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                    {t('branding.thumbnailScale', 'Thumbnail Scale')}
                  </label>
                  <select
                    value={localTheme.gallerySettings?.thumbnailScale || 'md'}
                    onChange={(e) => updateGallerySettings('thumbnailScale', e.target.value)}
                    className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
                  >
                    <option value="xs">{t('branding.thumbnailScaleOptions.xs', 'XS — Most photos')}</option>
                    <option value="sm">{t('branding.thumbnailScaleOptions.sm', 'SM — More photos')}</option>
                    <option value="md">{t('branding.thumbnailScaleOptions.md', 'MD — Default')}</option>
                    <option value="lg">{t('branding.thumbnailScaleOptions.lg', 'LG — Larger photos')}</option>
                    <option value="xl">{t('branding.thumbnailScaleOptions.xl', 'XL — Largest photos')}</option>
                  </select>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                    {t('branding.thumbnailScaleHint', 'Adjusts column count relative to the base grid columns')}
                  </p>
                </div>
              )}
            </div>
          )}
        </Card>
      )}

      {/* Header Style - Decoupled from Layout */}
      {showGalleryLayouts && (
        <Card className="p-6">
          <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4 flex items-center gap-2">
            <ImageIcon className="w-5 h-5" />
            {t('branding.headerStyle', 'Header Style')}
          </h3>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
            {t('branding.headerStyleDescription', 'Choose how the gallery header appears. The header style is independent of the photo layout.')}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
            {(Object.keys(headerStyleIcons) as HeaderStyleType[]).map((style) => (
              <button
                type="button"
                key={style}
                onClick={() => handleChange('headerStyle', style)}
                className={`relative p-4 rounded-lg border-2 transition-all ${
                  (localTheme.headerStyle || 'standard') === style
                    ? 'tile-selected'
                    : 'border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600'
                }`}
              >
                <div className="flex flex-col items-center text-center">
                  <div className="mb-2 text-neutral-700 dark:text-neutral-300">
                    {headerStyleIcons[style]}
                  </div>
                  <span className="font-medium text-sm capitalize text-neutral-900 dark:text-neutral-100">
                    {t(`branding.headerStyleOptions.${style}`, style)}
                  </span>
                  <span className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
                    {t(`branding.headerStyleDescriptions.${style}`, '')}
                  </span>
                </div>
                {(localTheme.headerStyle || 'standard') === style && (
                  <Check className="absolute top-2 right-2 w-4 h-4 text-accent-dark" />
                )}
              </button>
            ))}
          </div>

          {/* Divider Style - Only show when hero header is selected */}
          {localTheme.headerStyle === 'hero' && (
            <div className="mt-6 pt-6 border-t border-neutral-200 dark:border-neutral-700">
              <h4 className="font-medium text-sm text-neutral-700 dark:text-neutral-300 mb-3">
                {t('branding.heroDividerStyle', 'Divider Style')}
              </h4>
              <p className="text-xs text-neutral-600 dark:text-neutral-400 mb-4">
                {t('branding.heroDividerDescription', 'Choose how the transition between the hero image and gallery content looks.')}
              </p>
              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
                {(Object.keys(dividerStylePreviews) as HeroDividerStyle[]).map((divider) => (
                  <button
                    type="button"
                    key={divider}
                    onClick={() => handleChange('heroDividerStyle', divider)}
                    className={`relative p-3 rounded-lg border-2 transition-all ${
                      (localTheme.heroDividerStyle || 'wave') === divider
                        ? 'tile-selected'
                        : 'border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600'
                    }`}
                  >
                    <div className="flex flex-col items-center">
                      <div className="w-full mb-2 bg-neutral-800 rounded-t overflow-hidden">
                        <div className="h-8"></div>
                        {dividerStylePreviews[divider]}
                      </div>
                      <span className="text-xs font-medium capitalize text-neutral-900 dark:text-neutral-100">
                        {t(`branding.dividerOptions.${divider}`, divider)}
                      </span>
                    </div>
                    {(localTheme.heroDividerStyle || 'wave') === divider && (
                      <Check className="absolute top-1 right-1 w-3 h-3 text-accent-dark" />
                    )}
                  </button>
                ))}
              </div>
            </div>
          )}
        </Card>
      )}

      {/* Controls Style */}
      {showGalleryLayouts && (
        <Card className="p-6">
          <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4 flex items-center gap-2">
            <SlidersHorizontal className="w-5 h-5" />
            {t('branding.controlsStyle', 'Controls Style')}
          </h3>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
            {t('branding.controlsStyleDescription', 'Choose how gallery filters and controls are displayed.')}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <button
              type="button"
              onClick={() => handleChange('controlsStyle', 'classic')}
              className={`relative p-4 rounded-lg border-2 transition-all ${
                (localTheme.controlsStyle || 'classic') === 'classic'
                  ? 'tile-selected'
                  : 'border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600'
              }`}
            >
              <div className="flex flex-col items-center text-center">
                <div className="mb-2 text-neutral-700 dark:text-neutral-300">
                  <SlidersHorizontal className="w-6 h-6" />
                </div>
                <span className="font-medium text-sm text-neutral-900 dark:text-neutral-100">
                  {t('branding.controlsStyleOptions.classic', 'Classic')}
                </span>
                <span className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
                  {t('branding.controlsStyleDescriptions.classic', 'Inline filter bar below header')}
                </span>
              </div>
              {(localTheme.controlsStyle || 'classic') === 'classic' && (
                <Check className="absolute top-2 right-2 w-4 h-4 text-accent-dark" />
              )}
            </button>
            <button
              type="button"
              onClick={() => handleChange('controlsStyle', 'sidebar')}
              className={`relative p-4 rounded-lg border-2 transition-all ${
                localTheme.controlsStyle === 'sidebar'
                  ? 'tile-selected'
                  : 'border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600'
              }`}
            >
              <div className="flex flex-col items-center text-center">
                <div className="mb-2 text-neutral-700 dark:text-neutral-300">
                  <Menu className="w-6 h-6" />
                </div>
                <span className="font-medium text-sm text-neutral-900 dark:text-neutral-100">
                  {t('branding.controlsStyleOptions.sidebar', 'Sidebar')}
                </span>
                <span className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
                  {t('branding.controlsStyleDescriptions.sidebar', 'Menu button opens sidebar with filters')}
                </span>
              </div>
              {localTheme.controlsStyle === 'sidebar' && (
                <Check className="absolute top-2 right-2 w-4 h-4 text-accent-dark" />
              )}
            </button>
          </div>
          {/* Info about hero header */}
          {localTheme.headerStyle === 'hero' && localTheme.controlsStyle !== 'sidebar' && (
            <div className="mt-4 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
              <p className="text-sm text-amber-800 dark:text-amber-200 flex items-center gap-2">
                <Info className="w-4 h-4 flex-shrink-0" />
                {t('branding.controlsStyleHeroWarning', 'Sidebar is recommended for hero headers to prevent controls appearing above the hero image.')}
              </p>
            </div>
          )}
        </Card>
      )}

      {/* Color Customization */}
      <Card className="p-6">
        <div className="flex items-center justify-between gap-2 mb-4">
          <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
            <Palette className="w-5 h-5" />
            {t('branding.colors')}
          </h3>
          {/* "Sync from Branding" — caller-supplied so the customizer
              doesn't have to know how to resolve the Branding theme.
              Used in event create/edit to reset palette to site colours. */}
          {onSyncFromBranding && (
            <Button
              type="button"
              variant="outline"
              size="sm"
              leftIcon={<RotateCcw className="w-4 h-4" />}
              onClick={onSyncFromBranding}
            >
              {t('branding.syncFromBranding', 'Sync from Branding')}
            </Button>
          )}
        </div>

        {/* Color Mode Selector */}
        <div className="mb-6">
          {forcedColorActive && (
            <div className="mb-3 rounded-lg border border-amber-200 dark:border-amber-800 bg-amber-50 dark:bg-amber-900/20 px-3 py-2 text-xs text-amber-800 dark:text-amber-300">
              {isBrandingContext
                ? t('branding.forcedModeBrandingHint', 'Light/dark is locked site-wide by the Force control below — the per-theme mode picker is hidden because it would have no effect.')
                : t('branding.forcedModeGalleryNote', 'A site-wide color lock is active, so this gallery follows the locked light/dark mode. Color and light/dark options are hidden here and can’t be overridden per gallery.')}
            </div>
          )}
          {!forcedColorActive && (<>
          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
            {t('branding.colorMode', 'Color Mode')}
          </label>
          <div className="flex gap-2">
            {(['light', 'dark', 'auto'] as const).map((mode) => (
              <button
                type="button"
                key={mode}
                onClick={() => {
                  handleChange('colorMode', mode);
                  // When switching to dark, auto-populate dark defaults if colors are still light
                  if (mode === 'dark' && (!localTheme.backgroundColor || localTheme.backgroundColor === '#fafafa' || localTheme.backgroundColor === '#ffffff')) {
                    const updated: ThemeConfig = {
                      ...localTheme,
                      colorMode: mode,
                      backgroundColor: '#0f0f0f',
                      surfaceColor: '#1a1a1a',
                      elevatedColor: '#242424',
                      surfaceBorderColor: '#2e2e2e',
                      textColor: '#e5e5e5',
                      mutedTextColor: '#a3a3a3',
                    };
                    setLocalTheme(updated);
                    onChange({ ...updated, customCss });
                  } else if (mode === 'light' && localTheme.colorMode === 'dark') {
                    const updated: ThemeConfig = {
                      ...localTheme,
                      colorMode: mode,
                      backgroundColor: '#fafafa',
                      surfaceColor: '#ffffff',
                      elevatedColor: '#f5f5f5',
                      surfaceBorderColor: '#e5e5e5',
                      textColor: '#171717',
                      mutedTextColor: '#737373',
                    };
                    setLocalTheme(updated);
                    onChange({ ...updated, customCss });
                  }
                }}
                className={`px-4 py-2 text-sm font-medium rounded-lg border transition-colors ${
                  (localTheme.colorMode || 'light') === mode
                    ? 'border-accent-dark bg-accent-dark text-white'
                    : 'border-neutral-300 dark:border-neutral-600 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800'
                }`}
              >
                {mode === 'light' ? t('branding.colorModeLight', 'Light') :
                 mode === 'dark' ? t('branding.colorModeDark', 'Dark') :
                 t('branding.colorModeAuto', 'Auto')}
              </button>
            ))}
          </div>
          <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">
            {t('branding.colorModeHelp', 'Auto follows the visitor\'s system preference.')}
          </p>
          </>)}

          {/*
           * Force color mode (instance-wide). Lives next to the per-theme
           * Color Mode picker so the admin can find both controls in one
           * place. The data flows through props from BrandingPage which
           * persists it to branding settings; only renders when the
           * onForceColorModeChange handler is provided (i.e. only on the
           * Branding admin page, not in event-level theme editors).
           */}
          {onForceColorModeChange && (
            <div className="mt-5 pt-5 border-t border-neutral-200 dark:border-neutral-700">
              <h4 className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-1">
                {t('branding.forceColorMode', 'Force color mode')}
              </h4>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mb-3">
                {t(
                  'branding.forceColorModeHelp',
                  'Lock the entire admin and public site to dark or light. The user-facing dark/light toggle is hidden whenever a lock is active. Per-event themes that try to override the colour mode are also forced to follow.'
                )}
              </p>
              <div className="flex flex-wrap gap-2">
                {([
                  { value: null, label: t('branding.forceColorModeNone', 'No force (user choice)') },
                  { value: 'dark', label: t('branding.forceColorModeDark', 'Force dark') },
                  { value: 'light', label: t('branding.forceColorModeLight', 'Force light') },
                ] as const).map(({ value, label }) => {
                  const active = (forceColorMode ?? null) === value;
                  return (
                    <button
                      type="button"
                      key={String(value)}
                      onClick={() => onForceColorModeChange(value)}
                      className={`px-4 py-2 text-sm font-medium rounded-lg border transition-colors ${
                        active
                          ? 'border-accent-dark bg-accent-dark text-white'
                          : 'border-neutral-300 dark:border-neutral-600 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-800'
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>

        {/*
         * 8-token CI palette pickers, grouped by role.
         * Each token writes directly to the same field name on ThemeConfig
         * (kebab → camel mapping happens via handleChange's first arg).
         * Translation keys fall back to inline strings — German/English
         * coverage only (per user language profile); other locales will
         * show the fallback until reviewed by a native speaker.
         */}
        {/*
         * 8-token CI palette pickers, grouped by role. Each picker label
         * carries an Info icon whose `title` attribute renders the
         * descriptive help text on hover (or long-press on touch). Keeping
         * the help out of the static layout means every picker row is the
         * same height so the four Surfaces and the two Accent rows align
         * cleanly side-by-side.
         */}
        {!hideGalleryColors && (
        <div className="space-y-6">
          {/* Surfaces */}
          <div>
            <h4 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300 uppercase tracking-wide mb-3 flex items-center gap-1.5">
              {t('branding.colorGroupSurfaces', 'Surfaces')}
              <span
                className="info-tooltip text-neutral-400 dark:text-neutral-500"
                data-tooltip={t(
                  'branding.colorGroupSurfacesHelp',
                  'The neutral layers behind your content. Background sits furthest back; Surface and Elevated stack on top.'
                )}
                tabIndex={0}
              >
                <Info className="w-3.5 h-3.5" />
              </span>
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[
                {
                  key: 'backgroundColor',
                  label: t('branding.backgroundColor', 'Background'),
                  help: t('branding.backgroundColorHelp', 'The page itself — body background of every gallery, admin page and CMS page.'),
                  fallback: '#fafafa',
                },
                {
                  key: 'surfaceColor',
                  label: t('branding.surfaceColor', 'Surface'),
                  help: t('branding.surfaceColorHelp', 'Cards, sidebar, header bar and navigation. The first layer above Background.'),
                  fallback: '#ffffff',
                },
                {
                  key: 'elevatedColor',
                  label: t('branding.elevatedColor', 'Elevated'),
                  help: t('branding.elevatedColorHelp', 'Panels that float above cards: image placeholders, hover/active rows, modal headers, code blocks.'),
                  fallback: '#f5f5f5',
                },
                {
                  key: 'surfaceBorderColor',
                  label: t('branding.borderColor', 'Border'),
                  help: t('branding.borderColorHelp', 'Dividers, table grid lines, card outlines, input borders.'),
                  fallback: '#e5e5e5',
                },
              ].map(({ key, label, help, fallback }) => (
                <ColorPickerRow
                  key={key}
                  label={label}
                  help={help}
                  value={(localTheme as Record<string, string | undefined>)[key] || fallback}
                  fallback={fallback}
                  onChange={(v) => handleChange(key as keyof ThemeConfig, v)}
                />
              ))}
            </div>
          </div>

          {/* Text */}
          <div>
            <h4 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300 uppercase tracking-wide mb-3 flex items-center gap-1.5">
              {t('branding.colorGroupText', 'Text')}
              <span
                className="info-tooltip text-neutral-400 dark:text-neutral-500"
                data-tooltip={t(
                  'branding.colorGroupTextHelp',
                  'Foreground text colours. Primary is for everything readers focus on; Secondary is for supporting copy.'
                )}
                tabIndex={0}
              >
                <Info className="w-3.5 h-3.5" />
              </span>
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[
                {
                  key: 'textColor',
                  label: t('branding.textColor', 'Primary text'),
                  help: t('branding.textColorHelp', 'Headlines, body copy, table cells, form input values, navigation labels — the main text colour.'),
                  fallback: '#171717',
                },
                {
                  key: 'mutedTextColor',
                  label: t('branding.mutedTextColor', 'Secondary text'),
                  help: t('branding.mutedTextColorHelp', 'Captions, helper text under inputs, table column headers, footer links, dates and metadata.'),
                  fallback: '#737373',
                },
              ].map(({ key, label, help, fallback }) => (
                <ColorPickerRow
                  key={key}
                  label={label}
                  help={help}
                  value={(localTheme as Record<string, string | undefined>)[key] || fallback}
                  fallback={fallback}
                  onChange={(v) => handleChange(key as keyof ThemeConfig, v)}
                />
              ))}
            </div>
          </div>

          {/* Accent */}
          <div>
            <h4 className="text-sm font-semibold text-neutral-700 dark:text-neutral-300 uppercase tracking-wide mb-3 flex items-center gap-1.5">
              {t('branding.colorGroupAccent', 'Accent')}
              <span
                className="info-tooltip text-neutral-400 dark:text-neutral-500"
                data-tooltip={t(
                  'branding.colorGroupAccentHelp',
                  'Brand colours that highlight interactive elements. Use a strong colour pair — Accent is for outlines/text, Accent Dark is for filled buttons.'
                )}
                tabIndex={0}
              >
                <Info className="w-3.5 h-3.5" />
              </span>
            </h4>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[
                {
                  key: 'accentColor',
                  label: t('branding.accentColor', 'Accent'),
                  help: t(
                    'branding.accentColorHelp',
                    'Links, icons, focus rings, hover states on primary buttons, active sidebar item underline. Should read clearly on both Background and Surface.'
                  ),
                  fallback: '#22c55e',
                },
                {
                  key: 'accentDarkColor',
                  label: t('branding.accentDarkColor', 'Accent (filled)'),
                  help: t(
                    'branding.accentDarkColorHelp',
                    'Filled CTA buttons, active sidebar item background, badges and tags. Needs enough contrast for white text to be readable on top.'
                  ),
                  fallback: '#5C8762',
                },
              ].map(({ key, label, help, fallback }) => (
                <ColorPickerRow
                  key={key}
                  label={label}
                  help={help}
                  value={(localTheme as Record<string, string | undefined>)[key] || fallback}
                  fallback={fallback}
                  onChange={(v) => handleChange(key as keyof ThemeConfig, v)}
                />
              ))}
            </div>
            {/* primaryColor is kept in sync with accentDarkColor inside
                handleChange() — no dedicated picker. */}
          </div>
        </div>
        )}
      </Card>

      {/* Typography & Style */}
      <Card className="p-6">
        <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4 flex items-center gap-2">
          <Type className="w-5 h-5" />
          {t('branding.typographyAndStyle')}
        </h3>
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                {t('branding.bodyFont')}
              </label>
              <select
                value={resolveFontDropdownValue(
                  localTheme.fontFamily,
                  availableFonts,
                  // Fallback when no fontFamily is saved yet: prefer the
                  // scanned Inter (with its real generic), else a bare CSS
                  // string when the backend hasn't loaded yet.
                  (availableFonts || []).find((f) => f.family === 'Inter')
                    ? buildFontFamilyValue(
                        (availableFonts || []).find((f) => f.family === 'Inter')!
                      )
                    : "'Inter', sans-serif"
                )}
                onChange={(e) => handleChange('fontFamily', e.target.value)}
                className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
              >
                <option value="system-ui, sans-serif">System UI</option>
                {(availableFonts || []).map((f) => (
                  <option key={f.family} value={buildFontFamilyValue(f)}>
                    {f.family}
                  </option>
                ))}
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                {t('branding.headingFont')}
              </label>
              <select
                value={resolveFontDropdownValue(
                  localTheme.headingFontFamily,
                  availableFonts,
                  ''
                )}
                onChange={(e) => handleChange('headingFontFamily', e.target.value)}
                className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
              >
                <option value="">{t('branding.sameAsBody')}</option>
                <option value="system-ui, sans-serif">System UI</option>
                {(availableFonts || []).map((f) => (
                  <option key={f.family} value={buildFontFamilyValue(f)}>
                    {f.family}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Row 1: Font Size & Border Radius */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                {t('branding.fontSize')}
              </label>
              <select
                value={localTheme.fontSize || 'normal'}
                onChange={(e) => handleChange('fontSize', e.target.value)}
                className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
              >
                <option value="small">{t('branding.fontSizes.small')}</option>
                <option value="normal">{t('branding.fontSizes.normal')}</option>
                <option value="large">{t('branding.fontSizes.large')}</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                {t('branding.borderRadius')}
              </label>
              <select
                value={localTheme.borderRadius || 'md'}
                onChange={(e) => handleChange('borderRadius', e.target.value)}
                className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
              >
                <option value="none">{t('branding.borderRadiusOptions.none')}</option>
                <option value="sm">{t('branding.borderRadiusOptions.small')}</option>
                <option value="md">{t('branding.borderRadiusOptions.medium')}</option>
                <option value="lg">{t('branding.borderRadiusOptions.large')}</option>
              </select>
            </div>
          </div>

          {/* Row 2: Shadow Style & Background Pattern */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                {t('branding.shadowStyle')}
              </label>
              <select
                value={localTheme.shadowStyle || 'normal'}
                onChange={(e) => handleChange('shadowStyle', e.target.value)}
                className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
              >
                <option value="none">{t('branding.shadowOptions.none')}</option>
                <option value="subtle">{t('branding.shadowOptions.subtle')}</option>
                <option value="normal">{t('branding.shadowOptions.normal')}</option>
                <option value="dramatic">{t('branding.shadowOptions.dramatic')}</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                {t('branding.backgroundPattern')}
              </label>
              <select
                value={localTheme.backgroundPattern || 'none'}
                onChange={(e) => handleChange('backgroundPattern', e.target.value)}
                className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
              >
                <option value="none">{t('branding.backgroundOptions.none')}</option>
                <option value="dots">{t('branding.backgroundOptions.dots')}</option>
                <option value="grid">{t('branding.backgroundOptions.grid')}</option>
                <option value="waves">{t('branding.backgroundOptions.waves')}</option>
              </select>
            </div>
          </div>
        </div>
      </Card>

      {/* CSS Template Selector - only show if templates are provided */}
      {cssTemplates && cssTemplates.length > 0 && onCssTemplateChange && (
        <Card className="p-6">
          <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4 flex items-center gap-2">
            <FileCode className="w-5 h-5" />
            {t('branding.cssTemplate', 'CSS Template')}
          </h3>
          <p className="text-sm text-neutral-600 dark:text-neutral-400 mb-4">
            {t('branding.cssTemplateDescription', 'Select a pre-built CSS template to apply application-wide styling to this gallery. Templates can be managed in Settings > CSS Templates.')}
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {/* No template option */}
            <button
              type="button"
              onClick={() => onCssTemplateChange(null)}
              className={`relative p-4 rounded-lg border-2 transition-all text-left ${
                !cssTemplateId
                  ? 'tile-selected'
                  : 'border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600'
              }`}
            >
              <div className="flex items-center justify-between">
                <span className="font-medium text-sm text-neutral-900 dark:text-neutral-100">{t('branding.noTemplate', 'No Template')}</span>
                {!cssTemplateId && (
                  <Check className="w-4 h-4 text-accent-dark flex-shrink-0" />
                )}
              </div>
              <span className="text-xs text-neutral-600 dark:text-neutral-400 mt-1 block">
                {t('branding.noTemplateDescription', 'Use only theme settings without a CSS template')}
              </span>
            </button>
            {/* Template options */}
            {cssTemplates.map((template) => (
              <button
                type="button"
                key={template.id}
                onClick={() => onCssTemplateChange(template.id)}
                className={`relative p-4 rounded-lg border-2 transition-all text-left ${
                  cssTemplateId === template.id
                    ? 'tile-selected'
                    : 'border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600'
                }`}
              >
                <div className="flex items-center justify-between">
                  <span className="font-medium text-sm text-neutral-900 dark:text-neutral-100">{template.name}</span>
                  {cssTemplateId === template.id && (
                    <Check className="w-4 h-4 text-accent-dark flex-shrink-0" />
                  )}
                </div>
                <span className="text-xs text-neutral-600 dark:text-neutral-400 mt-1 block">
                  {t('branding.templateSlot', 'Slot {{slot}}', { slot: template.slot_number })}
                </span>
              </button>
            ))}
          </div>
        </Card>
      )}

      {/* Caller-provided slot — used by BrandingPage to keep the
          PDF typography card adjacent to the web typography section
          instead of trailing the (often-collapsed) Custom CSS block. */}
      {slotBeforeCustomCss}

      {/* Event-specific Custom CSS */}
      <Card className="p-6">
        <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4 flex items-center gap-2">
          <Code className="w-5 h-5" />
          {t('branding.eventCustomCSS', 'Event-specific Custom CSS')}
        </h3>

        {/* Collapsible Instructions Panel */}
        <div className="mb-4">
          <button
            type="button"
            onClick={() => setShowCssInstructions(!showCssInstructions)}
            className="flex items-center gap-2 text-sm text-accent hover:opacity-80 font-medium"
          >
            <Info className="w-4 h-4" />
            {t('branding.cssInstructions.title', 'How to use Custom CSS')}
            <ChevronDown className={`w-4 h-4 transition-transform ${showCssInstructions ? 'rotate-180' : ''}`} />
          </button>

          {showCssInstructions && (
            <div className="mt-3 p-4 bg-neutral-50 dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 text-sm space-y-4">
              {/* Available CSS Variables */}
              <div>
                <h4 className="font-semibold text-neutral-900 dark:text-neutral-100 mb-2">
                  {t('branding.cssInstructions.variables', 'Theme CSS Variables')}
                </h4>
                <p className="text-neutral-600 dark:text-neutral-400 mb-2">
                  {t('branding.cssInstructions.variablesDesc', 'Use these CSS variables to match your theme presets:')}
                </p>
                <code className="block bg-neutral-800 text-green-400 p-3 rounded text-xs overflow-x-auto">
{`--color-background: ${localTheme.backgroundColor || '#fafafa'};
--color-surface: ${localTheme.surfaceColor || '#ffffff'};
--color-elevated: ${localTheme.elevatedColor || '#f5f5f5'};
--color-surface-border: ${localTheme.surfaceBorderColor || '#e5e5e5'};
--color-text: ${localTheme.textColor || '#171717'};
--color-muted-text: ${localTheme.mutedTextColor || '#737373'};
--color-accent: ${localTheme.accentColor || '#22c55e'};
--color-accent-dark: ${localTheme.accentDarkColor || localTheme.primaryColor || '#5C8762'};
--font-family: ${localTheme.fontFamily || 'Inter, sans-serif'};
--heading-font: ${localTheme.headingFontFamily || localTheme.fontFamily || 'Inter, sans-serif'};`}
                </code>
              </div>

              {/* Custom Gallery Layouts */}
              <div>
                <h4 className="font-semibold text-neutral-900 dark:text-neutral-100 mb-2">
                  {t('branding.cssInstructions.layouts', 'Custom Gallery Layouts')}
                </h4>
                <p className="text-neutral-600 dark:text-neutral-400 mb-2">
                  {t('branding.cssInstructions.layoutsDesc', 'Target gallery elements with these selectors:')}
                </p>
                <code className="block bg-neutral-800 text-green-400 p-3 rounded text-xs overflow-x-auto">
{`.gallery-container { /* Main gallery wrapper */ }
.gallery-grid { /* Photo grid container */ }
.gallery-item { /* Individual photo card */ }
.gallery-header { /* Header section */ }
.gallery-hero { /* Hero image area */ }
.photo-overlay { /* Photo hover overlay */ }
.photo-actions { /* Like/favorite buttons */ }`}
                </code>
              </div>

              {/* Glassmorphism Example */}
              <div>
                <h4 className="font-semibold text-neutral-900 dark:text-neutral-100 mb-2">
                  {t('branding.cssInstructions.glassEffect', 'Glassmorphism Effect')}
                </h4>
                <p className="text-neutral-600 dark:text-neutral-400 mb-2">
                  {t('branding.cssInstructions.glassEffectDesc', 'Create modern glass effects:')}
                </p>
                <code className="block bg-neutral-800 text-green-400 p-3 rounded text-xs overflow-x-auto">
{`.glass-panel {
  background: rgba(255, 255, 255, 0.25);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(255, 255, 255, 0.18);
  border-radius: 16px;
}`}
                </code>
              </div>

              {/* Tips */}
              <div className="flex items-start gap-2 p-3 bg-blue-50 dark:bg-blue-900/30 border border-blue-200 dark:border-blue-800 rounded-lg">
                <Info className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
                <div className="text-blue-800 dark:text-blue-200 text-xs">
                  <strong>{t('branding.cssInstructions.tip', 'Tip')}:</strong>{' '}
                  {t('branding.cssInstructions.tipText', 'Use CSS Templates from Settings > CSS Templates for pre-built designs like Apple Liquid Glass.')}
                </div>
              </div>
            </div>
          )}
        </div>

        <textarea
          value={customCss}
          onChange={(e) => {
            const newCss = e.target.value;
            setCustomCss(newCss);
            // Mark as custom when CSS is added
            if (newCss && selectedPreset !== 'custom' && onPresetChange) {
              setSelectedPreset('custom');
              onPresetChange('custom');
            }
            // Propagate to parent so Save sees the latest CSS (#323).
            onChange({ ...localTheme, customCss: newCss });
          }}
          placeholder="/* Add custom CSS here */"
          className="w-full h-40 px-3 py-2 font-mono text-sm border border-neutral-300 dark:border-neutral-600 rounded-lg bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100"
        />
        <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
          {t('branding.customCSSHelp')}
        </p>
      </Card>

      {/* Actions */}
      {!hideActions && (
        <div className="flex items-center justify-end gap-3">
          <Button
            variant="outline"
            leftIcon={<RotateCcw className="w-4 h-4" />}
            onClick={handleReset}
          >
            {t('branding.resetToDefault')}
          </Button>
          <Button
            variant="primary"
            leftIcon={<Palette className="w-4 h-4" />}
            onClick={handleApply}
            disabled={isApplying}
          >
            {isApplying ? t('common.applying', 'Applying...') : t('branding.applyTheme')}
          </Button>
        </div>
      )}
    </div>
  );
};
