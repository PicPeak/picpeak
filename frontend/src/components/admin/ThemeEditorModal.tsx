import React, { useState, useEffect } from 'react';
import { X, Save, RotateCcw, Grid3X3, Layers, Play, Clock, LayoutGrid, Check, Columns, Film } from 'lucide-react';
import { Button } from '../common';
import { ThemeCustomizerEnhanced } from './ThemeCustomizerEnhanced';
import { GalleryPreview } from './GalleryPreview';
import { ThemeConfig, GALLERY_THEME_PRESETS, GalleryLayoutType } from '../../types/theme.types';
import { cssTemplatesService, type EnabledTemplate } from '../../services/cssTemplates.service';
import { useTranslation } from 'react-i18next';

interface ThemeEditorModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSave: (theme: ThemeConfig, presetName: string, cssTemplateId: number | null) => void;
  currentTheme: ThemeConfig | string;
  currentCssTemplateId?: number | null;
  eventName: string;
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

export const ThemeEditorModal: React.FC<ThemeEditorModalProps> = ({
  isOpen,
  onClose,
  onSave,
  currentTheme,
  currentCssTemplateId,
  eventName
}) => {
  const { t } = useTranslation();
  const [theme, setTheme] = useState<ThemeConfig>(GALLERY_THEME_PRESETS.default.config);
  const [presetName, setPresetName] = useState<string>('default');
  const [previewLayout, setPreviewLayout] = useState<GalleryLayoutType | undefined>(undefined);
  const [cssTemplates, setCssTemplates] = useState<EnabledTemplate[]>([]);
  const [cssTemplateId, setCssTemplateId] = useState<number | null>(currentCssTemplateId ?? null);

  // Fetch CSS templates when modal opens
  useEffect(() => {
    if (isOpen) {
      cssTemplatesService.getEnabledTemplates()
        .then(setCssTemplates)
        .catch(err => console.error('Failed to load CSS templates:', err));
    }
  }, [isOpen]);

  // Update cssTemplateId when prop changes
  useEffect(() => {
    setCssTemplateId(currentCssTemplateId ?? null);
  }, [currentCssTemplateId]);

  useEffect(() => {
    if (currentTheme) {
      if (typeof currentTheme === 'string') {
        try {
          if (currentTheme.startsWith('{')) {
            const parsedTheme = JSON.parse(currentTheme);
            setTheme(parsedTheme);
            // Try to find matching preset
            const matchingPreset = Object.entries(GALLERY_THEME_PRESETS).find(
              ([_, preset]) => JSON.stringify(preset.config) === JSON.stringify(parsedTheme)
            );
            setPresetName(matchingPreset ? matchingPreset[0] : 'custom');
          } else {
            // Legacy theme name
            const preset = GALLERY_THEME_PRESETS[currentTheme];
            if (preset) {
              setTheme(preset.config);
              setPresetName(currentTheme);
            }
          }
        } catch (e) {
          console.error('Failed to parse theme:', e);
          setTheme(GALLERY_THEME_PRESETS.default.config);
          setPresetName('default');
        }
      } else {
        setTheme(currentTheme);
        setPresetName('custom');
      }
    }
  }, [currentTheme]);

  const handleThemeChange = (newTheme: ThemeConfig) => {
    setTheme(newTheme);
  };

  const handlePresetChange = (newPresetName: string) => {
    setPresetName(newPresetName);
    if (newPresetName !== 'custom') {
      const preset = GALLERY_THEME_PRESETS[newPresetName];
      if (preset) {
        setTheme(preset.config);
      }
    }
  };

  const handleSave = () => {
    onSave(theme, presetName, cssTemplateId);
    onClose();
  };

  const handleReset = () => {
    const defaultPreset = GALLERY_THEME_PRESETS.default;
    setTheme(defaultPreset.config);
    setPresetName('default');
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-neutral-900 rounded-lg shadow-xl max-w-4xl w-full max-h-[90vh] overflow-hidden flex flex-col">
        {/* Header */}
        <div className="px-6 py-4 border-b border-neutral-200 dark:border-neutral-700 flex items-center justify-between">
          <div>
            <h2 className="text-xl font-semibold text-neutral-900 dark:text-neutral-100">
              {t('events.galleryTheme')}
            </h2>
            <p className="text-sm text-neutral-600 dark:text-neutral-300 mt-1">
              {t('events.customizingThemeFor', { event: eventName })}
            </p>
          </div>
          <button
            onClick={onClose}
            className="text-neutral-400 dark:text-neutral-500 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
          >
            <X className="w-6 h-6" />
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          <div className="grid grid-cols-1 lg:grid-cols-2 h-full">
            {/* Left side - Theme Customizer */}
            <div className="p-6 overflow-y-auto border-r border-neutral-200 dark:border-neutral-700">
              <ThemeCustomizerEnhanced
                value={theme}
                onChange={handleThemeChange}
                presetName={presetName}
                onPresetChange={handlePresetChange}
                isPreviewMode={true}
                showGalleryLayouts={true}
                hideActions={true}
                cssTemplates={cssTemplates}
                cssTemplateId={cssTemplateId}
                onCssTemplateChange={setCssTemplateId}
              />
            </div>
            
            {/* Right side - Gallery Preview */}
            <div className="p-6 bg-neutral-50 dark:bg-neutral-800 overflow-y-auto">
              <div className="space-y-4">
                {/* Grid Style Selector */}
                <div>
                  <h3 className="text-sm font-medium text-neutral-700 dark:text-neutral-200 mb-3">
                    {t('branding.previewLayout')}
                  </h3>
                  <div className="grid grid-cols-3 gap-2">
                    {(Object.keys(layoutIcons) as GalleryLayoutType[]).map((layout) => (
                      <button
                        key={layout}
                        onClick={() => setPreviewLayout(layout)}
                        className={`relative p-3 rounded-lg border-2 transition-all ${
                          (previewLayout || theme.galleryLayout || 'grid') === layout
                            ? 'tile-selected'
                            : 'border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600 bg-white dark:bg-neutral-900'
                        }`}
                      >
                        <div className="flex flex-col items-center gap-1">
                          <div className="text-neutral-700 dark:text-neutral-200">
                            {layoutIcons[layout]}
                          </div>
                          <span className="text-xs capitalize">
                            {layout}
                            {(layout === 'gallery-premium' || layout === 'gallery-story') && (
                              <span className="ml-0.5 text-amber-600">(Beta)</span>
                            )}
                          </span>
                        </div>
                        {(previewLayout || theme.galleryLayout || 'grid') === layout && (
                          <Check className="absolute top-1 right-1 w-3 h-3 text-accent" />
                        )}
                      </button>
                    ))}
                  </div>
                </div>
                
                {/* Gallery Preview */}
                <div>
                  <h3 className="text-sm font-medium text-neutral-700 mb-3">
                    {t('branding.livePreview')}
                  </h3>
                  <GalleryPreview 
                    theme={theme} 
                    layoutType={previewLayout}
                    className="shadow-lg" 
                  />
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-neutral-200 flex items-center justify-between">
          <Button
            variant="outline"
            leftIcon={<RotateCcw className="w-4 h-4" />}
            onClick={handleReset}
          >
            {t('branding.resetToDefault')}
          </Button>
          <div className="flex gap-3">
            <Button variant="outline" onClick={onClose}>
              {t('common.cancel')}
            </Button>
            <Button
              variant="primary"
              leftIcon={<Save className="w-4 h-4" />}
              onClick={handleSave}
            >
              {t('branding.saveTheme')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};

ThemeEditorModal.displayName = 'ThemeEditorModal';