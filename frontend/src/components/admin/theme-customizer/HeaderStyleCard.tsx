import React from 'react';
import { ImageIcon, Check } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card } from '../../common';
import { ThemeConfig, HeaderStyleType, HeroDividerStyle } from '../../../types/theme.types';
import { headerStyleIcons, dividerStylePreviews } from './icons';

interface HeaderStyleCardProps {
  localTheme: ThemeConfig;
  handleChange: (key: keyof ThemeConfig, newValue: any) => void;
}

export const HeaderStyleCard: React.FC<HeaderStyleCardProps> = ({ localTheme, handleChange }) => {
  const { t } = useTranslation();

  return (
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
  );
};
