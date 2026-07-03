import React, { useState, useEffect, useRef } from 'react';
import { Palette, RotateCcw, Check, Upload } from 'lucide-react';
import { Button, Card, Input } from '../common';
import { GALLERY_THEME_PRESETS, type ThemeConfig } from '../../contexts/ThemeContext';
import { settingsService } from '../../services/settings.service';
import { toast } from 'react-toastify';
import { buildResourceUrl } from '../../utils/url';

interface ThemeCustomizerProps {
  value: ThemeConfig;
  onChange: (theme: ThemeConfig) => void;
  presetName?: string;
  onPresetChange?: (presetName: string) => void;
}

export const ThemeCustomizer: React.FC<ThemeCustomizerProps> = ({
  value,
  onChange,
  presetName = 'default',
  onPresetChange
}) => {
  const [localTheme, setLocalTheme] = useState<ThemeConfig>(value);
  const [selectedPreset, setSelectedPreset] = useState(presetName);
  const [customCss, setCustomCss] = useState(value.customCss || '');
  const logoInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setLocalTheme(value);
    setCustomCss(value.customCss || '');
  }, [value]);

  useEffect(() => {
    setSelectedPreset(presetName);
  }, [presetName]);

  const handleChange = (key: keyof ThemeConfig, newValue: any) => {
    const updated = { ...localTheme, [key]: newValue };
    setLocalTheme(updated);
    // Always propagate changes to parent, not just in preview mode
    onChange(updated);
  };

  const handlePresetSelect = (presetKey: string) => {
    const preset = GALLERY_THEME_PRESETS[presetKey];
    if (preset) {
      setSelectedPreset(presetKey);
      setLocalTheme(preset.config);
      if (onPresetChange) {
        onPresetChange(presetKey);
      }
      // Always propagate preset changes
      onChange(preset.config);
    }
  };

  const handleApply = () => {
    const themeWithCss = { ...localTheme, customCss };
    setLocalTheme(themeWithCss);
    onChange(themeWithCss);
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

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      try {
        // Upload to server
        const logoUrl = await settingsService.uploadLogo(file);
        // Update theme with the server URL
        handleChange('logoUrl', logoUrl);
        toast.success('Logo uploaded successfully');
      } catch (error) {
        console.error('Failed to upload logo:', error);
        toast.error('Failed to upload logo');
      }
    }
  };

  return (
    <div className="space-y-6">
      {/* Preset Themes */}
      <Card className="p-6">
        <h3 className="text-lg font-semibold text-neutral-900 mb-4">Preset Themes</h3>
        <div className="grid grid-cols-2 md:grid-cols-3 gap-4">
          {Object.entries(GALLERY_THEME_PRESETS).map(([key, theme]) => (
            <button
              key={key}
              onClick={() => handlePresetSelect(key)}
              className={`relative p-4 rounded-lg border-2 transition-all ${
                selectedPreset === key
                  ? 'tile-selected'
                  : 'border-neutral-200 hover:border-neutral-300'
              }`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="font-medium text-sm">{theme.name}</span>
                {selectedPreset === key && (
                  <Check className="w-4 h-4 text-accent" />
                )}
              </div>
              <div className="flex gap-2">
                <div
                  className="w-6 h-6 rounded-full border border-neutral-200"
                  style={{ backgroundColor: theme.config.primaryColor }}
                />
                <div
                  className="w-6 h-6 rounded-full border border-neutral-200"
                  style={{ backgroundColor: theme.config.accentColor }}
                />
                <div
                  className="w-6 h-6 rounded-full border border-neutral-200"
                  style={{ backgroundColor: theme.config.backgroundColor }}
                />
              </div>
            </button>
          ))}
        </div>
      </Card>

      {/* Color Customization */}
      <Card className="p-6">
        <h3 className="text-lg font-semibold text-neutral-900 mb-4">Colors</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-2">
              Primary Color
            </label>
            <div className="flex gap-2">
              <input
                type="color"
                value={localTheme.primaryColor || '#5C8762'}
                onChange={(e) => handleChange('primaryColor', e.target.value)}
                className="h-10 w-20 rounded border border-neutral-300"
              />
              <Input
                value={localTheme.primaryColor || '#5C8762'}
                onChange={(e) => handleChange('primaryColor', e.target.value)}
                placeholder="#5C8762"
                className="flex-1"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-2">
              Accent Color
            </label>
            <div className="flex gap-2">
              <input
                type="color"
                value={localTheme.accentColor || '#22c55e'}
                onChange={(e) => handleChange('accentColor', e.target.value)}
                className="h-10 w-20 rounded border border-neutral-300"
              />
              <Input
                value={localTheme.accentColor || '#22c55e'}
                onChange={(e) => handleChange('accentColor', e.target.value)}
                placeholder="#22c55e"
                className="flex-1"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-2">
              Background Color
            </label>
            <div className="flex gap-2">
              <input
                type="color"
                value={localTheme.backgroundColor || '#fafafa'}
                onChange={(e) => handleChange('backgroundColor', e.target.value)}
                className="h-10 w-20 rounded border border-neutral-300"
              />
              <Input
                value={localTheme.backgroundColor || '#fafafa'}
                onChange={(e) => handleChange('backgroundColor', e.target.value)}
                placeholder="#fafafa"
                className="flex-1"
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-2">
              Text Color
            </label>
            <div className="flex gap-2">
              <input
                type="color"
                value={localTheme.textColor || '#171717'}
                onChange={(e) => handleChange('textColor', e.target.value)}
                className="h-10 w-20 rounded border border-neutral-300"
              />
              <Input
                value={localTheme.textColor || '#171717'}
                onChange={(e) => handleChange('textColor', e.target.value)}
                placeholder="#171717"
                className="flex-1"
              />
            </div>
          </div>
        </div>
      </Card>

      {/* Typography & Style */}
      <Card className="p-6">
        <h3 className="text-lg font-semibold text-neutral-900 mb-4">Typography & Style</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-2">
              Font Family
            </label>
            <select
              value={localTheme.fontFamily || 'Inter, sans-serif'}
              onChange={(e) => handleChange('fontFamily', e.target.value)}
              className="w-full px-3 py-2 border border-neutral-300 rounded-lg focus:ring-2 focus:ring-primary-500"
            >
              <option value="Inter, sans-serif">Inter (Default)</option>
              <option value="Georgia, serif">Georgia (Elegant)</option>
              <option value="Helvetica, Arial, sans-serif">Helvetica (Clean)</option>
              <option value="'Playfair Display', serif">Playfair Display (Sophisticated)</option>
              <option value="'Comic Sans MS', cursive">Comic Sans (Playful)</option>
            </select>
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-2">
              Border Radius
            </label>
            <div className="flex gap-2">
              {(['none', 'sm', 'md', 'lg'] as const).map((radius) => (
                <button
                  key={radius}
                  onClick={() => handleChange('borderRadius', radius)}
                  className={`px-4 py-2 rounded-lg border-2 transition-all ${
                    localTheme.borderRadius === radius
                      ? 'tile-selected'
                      : 'border-neutral-200 hover:border-neutral-300'
                  }`}
                >
                  {radius === 'none' ? 'None' : radius.toUpperCase()}
                </button>
              ))}
            </div>
          </div>
        </div>
      </Card>

      {/* Logo Upload */}
      <Card className="p-6">
        <h3 className="text-lg font-semibold text-neutral-900 mb-4">Branding</h3>
        <div className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-2">
              Custom Logo
            </label>
            <div className="flex items-center gap-4">
              {localTheme.logoUrl && (
                <img
                  src={localTheme.logoUrl.startsWith('http') ? localTheme.logoUrl : buildResourceUrl(localTheme.logoUrl)}
                  alt="Custom logo"
                  className="h-16 w-auto object-contain"
                />
              )}
              <input
                ref={logoInputRef}
                type="file"
                accept="image/*"
                onChange={handleLogoUpload}
                className="hidden"
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => logoInputRef.current?.click()}
                leftIcon={<Upload className="w-4 h-4" />}
              >
                Upload Logo
              </Button>
              {localTheme.logoUrl && (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => handleChange('logoUrl', '')}
                >
                  Remove
                </Button>
              )}
            </div>
          </div>
        </div>
      </Card>

      {/* Custom CSS */}
      <Card className="p-6">
        <h3 className="text-lg font-semibold text-neutral-900 mb-4">Custom CSS</h3>
        <textarea
          value={customCss}
          onChange={(e) => setCustomCss(e.target.value)}
          placeholder="/* Add custom CSS here */"
          className="w-full h-32 px-3 py-2 font-mono text-sm border border-neutral-300 rounded-lg focus:ring-2 focus:ring-primary-500"
        />
        <p className="mt-2 text-sm text-neutral-600">
          Advanced: Add custom CSS to further customize the appearance
        </p>
      </Card>

      {/* Actions */}
      <div className="flex items-center justify-end gap-3">
        <Button
          variant="outline"
          leftIcon={<RotateCcw className="w-4 h-4" />}
          onClick={handleReset}
        >
          Reset to Default
        </Button>
        <Button
          variant="primary"
          leftIcon={<Palette className="w-4 h-4" />}
          onClick={handleApply}
        >
          Apply Theme
        </Button>
      </div>
    </div>
  );
};