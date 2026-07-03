import React, { useState } from 'react';
import { Code, Info, ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card } from '../../common';
import { ThemeConfig } from '../../../types/theme.types';

interface CustomCssCardProps {
  localTheme: ThemeConfig;
  customCss: string;
  onCustomCssChange: (newCss: string) => void;
}

export const CustomCssCard: React.FC<CustomCssCardProps> = ({
  localTheme,
  customCss,
  onCustomCssChange
}) => {
  const { t } = useTranslation();
  const [showCssInstructions, setShowCssInstructions] = useState(false);

  return (
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
        onChange={(e) => onCustomCssChange(e.target.value)}
        placeholder="/* Add custom CSS here */"
        className="w-full h-40 px-3 py-2 font-mono text-sm border border-neutral-300 dark:border-neutral-600 rounded-lg bg-neutral-50 dark:bg-neutral-900 text-neutral-900 dark:text-neutral-100"
      />
      <p className="mt-2 text-sm text-neutral-600 dark:text-neutral-400">
        {t('branding.customCSSHelp')}
      </p>
    </Card>
  );
};
