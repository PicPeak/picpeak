import React, { useState, useEffect } from 'react';
import { Palette, RotateCcw } from 'lucide-react';
import { Button } from '../common';
import { ThemeConfig, GALLERY_THEME_PRESETS, GalleryLayoutType } from '../../types/theme.types';
import type { EnabledTemplate } from '../../services/cssTemplates.service';
import { settingsService } from '../../services/settings.service';
import { fontsService, type FontDefinition } from '../../services/fonts.service';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { ThemePresetsCard } from './theme-customizer/ThemePresetsCard';
import { GalleryLayoutCard } from './theme-customizer/GalleryLayoutCard';
import { HeaderStyleCard } from './theme-customizer/HeaderStyleCard';
import { ControlsStyleCard } from './theme-customizer/ControlsStyleCard';
import { ColorCustomizationCard } from './theme-customizer/ColorCustomizationCard';
import { TypographyStyleCard } from './theme-customizer/TypographyStyleCard';
import { CssTemplateCard } from './theme-customizer/CssTemplateCard';
import { CustomCssCard } from './theme-customizer/CustomCssCard';

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

  const handleColorModeSelect = (mode: 'light' | 'dark' | 'auto') => {
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
  };

  const handleCustomCssChange = (newCss: string) => {
    setCustomCss(newCss);
    // Mark as custom when CSS is added
    if (newCss && selectedPreset !== 'custom' && onPresetChange) {
      setSelectedPreset('custom');
      onPresetChange('custom');
    }
    // Propagate to parent so Save sees the latest CSS (#323).
    onChange({ ...localTheme, customCss: newCss });
  };

  return (
    <div className="space-y-6">
      {/* Preset Themes */}
      <ThemePresetsCard
        selectedPreset={selectedPreset}
        handlePresetSelect={handlePresetSelect}
        showGalleryLayouts={showGalleryLayouts}
        isBetaLayout={isBetaLayout}
        isThumbnailTooSmall={isThumbnailTooSmall}
        thumbnailWidth={thumbnailWidth}
        thumbnailHeight={thumbnailHeight}
        minRecommendedThumbnailSize={MIN_RECOMMENDED_THUMBNAIL_SIZE}
      />

      {/* Gallery Layout */}
      {showGalleryLayouts && (
        <GalleryLayoutCard
          localTheme={localTheme}
          handleChange={handleChange}
          updateGallerySettings={updateGallerySettings}
          isBetaLayout={isBetaLayout}
          isThumbnailTooSmall={isThumbnailTooSmall}
          thumbnailWidth={thumbnailWidth}
          thumbnailHeight={thumbnailHeight}
          minRecommendedThumbnailSize={MIN_RECOMMENDED_THUMBNAIL_SIZE}
        />
      )}

      {/* Header Style - Decoupled from Layout */}
      {showGalleryLayouts && (
        <HeaderStyleCard localTheme={localTheme} handleChange={handleChange} />
      )}

      {/* Controls Style */}
      {showGalleryLayouts && (
        <ControlsStyleCard localTheme={localTheme} handleChange={handleChange} />
      )}

      {/* Color Customization */}
      <ColorCustomizationCard
        localTheme={localTheme}
        handleChange={handleChange}
        handleColorModeSelect={handleColorModeSelect}
        forcedColorActive={forcedColorActive}
        isBrandingContext={isBrandingContext}
        hideGalleryColors={hideGalleryColors}
        forceColorMode={forceColorMode}
        onForceColorModeChange={onForceColorModeChange}
        onSyncFromBranding={onSyncFromBranding}
      />

      {/* Typography & Style */}
      <TypographyStyleCard
        localTheme={localTheme}
        handleChange={handleChange}
        availableFonts={availableFonts}
      />

      {/* CSS Template Selector - only show if templates are provided */}
      {cssTemplates && cssTemplates.length > 0 && onCssTemplateChange && (
        <CssTemplateCard
          cssTemplates={cssTemplates}
          cssTemplateId={cssTemplateId}
          onCssTemplateChange={onCssTemplateChange}
        />
      )}

      {/* Caller-provided slot — used by BrandingPage to keep the
          PDF typography card adjacent to the web typography section
          instead of trailing the (often-collapsed) Custom CSS block. */}
      {slotBeforeCustomCss}

      {/* Event-specific Custom CSS */}
      <CustomCssCard
        localTheme={localTheme}
        customCss={customCss}
        onCustomCssChange={handleCustomCssChange}
      />

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
