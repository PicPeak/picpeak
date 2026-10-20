import React, { useState, useEffect, useId } from 'react';
import { Save, RotateCcw } from 'lucide-react';
import { Button, Modal } from '../common';
import { ThemeCustomizerEnhanced } from './ThemeCustomizerEnhanced';
import { GalleryPreview } from './GalleryPreview';
import { LayoutPicker } from './theme-customizer/LayoutPicker';
import { useGalleryLayoutOptions } from './theme-customizer/layoutWireframes';
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
  const layoutOptions = useGalleryLayoutOptions();
  const previewLayoutHeadingId = useId();
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
    <Modal
      open={isOpen}
      onClose={onClose}
      title={t('events.galleryTheme')}
      description={t('events.customizingThemeFor', { event: eventName })}
      size="xl"
      closeOnBackdrop={false}
      footer={
        <>
          <Button
            variant="outline"
            leftIcon={<RotateCcw className="w-4 h-4" />}
            onClick={handleReset}
            className="sm:mr-auto"
          >
            {t('branding.resetToDefault')}
          </Button>
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
        </>
      }
    >
      <div className="-mx-6 -my-4 grid grid-cols-1 lg:grid-cols-2">
        {/* Left side - Theme Customizer */}
        <div className="p-6 border-b lg:border-b-0 lg:border-r border-line">
          <ThemeCustomizerEnhanced
            value={theme}
            onChange={handleThemeChange}
            presetName={presetName}
            onPresetChange={handlePresetChange}
            showGalleryLayouts={true}
            hideActions={true}
            cssTemplates={cssTemplates}
            cssTemplateId={cssTemplateId}
            onCssTemplateChange={setCssTemplateId}
          />
        </div>
        
        {/* Right side - Gallery Preview */}
        <div className="p-6 bg-subtle">
          <div className="space-y-4">
            {/* Grid Style Selector */}
            <div>
              <h3 id={previewLayoutHeadingId} className="text-sm font-medium text-body mb-3">
                {t('branding.previewLayout')}
              </h3>
              <LayoutPicker
                compact
                aria-labelledby={previewLayoutHeadingId}
                options={layoutOptions}
                value={previewLayout || theme.galleryLayout || 'grid'}
                onChange={setPreviewLayout}
              />
            </div>
            
            {/* Gallery Preview */}
            <div>
              <h3 className="text-sm font-medium text-body mb-3">
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
    </Modal>
  );
};

ThemeEditorModal.displayName = 'ThemeEditorModal';
