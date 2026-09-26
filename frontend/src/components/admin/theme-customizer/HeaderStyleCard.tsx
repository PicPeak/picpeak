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
      <h3 className="text-lg font-semibold text-heading mb-4 flex items-center gap-2">
        <ImageIcon className="w-5 h-5" />
        {t('branding.headerStyle', 'Header Style')}
      </h3>
      <p className="text-sm text-soft mb-4">
        {t('branding.headerStyleDescription', 'Choose how the gallery header appears. The header style is independent of the photo layout.')}
      </p>
      {/* auto-fit/minmax rather than viewport breakpoints (#1412): the
          breakpoints size the columns off the WINDOW, but this card sits in a
          settings panel that is far narrower, so `lg:grid-cols-3` produced
          three ~85px columns no German string could fit in. A minimum track
          width lets the column count follow the container instead, and drops
          to fewer columns when there is no room. */}
      <div className="grid grid-cols-[repeat(auto-fit,minmax(9rem,1fr))] gap-4">
        {(Object.keys(headerStyleIcons) as HeaderStyleType[]).map((style) => (
          <button
            type="button"
            key={style}
            onClick={() => handleChange('headerStyle', style)}
            className={`relative p-4 rounded-lg border-2 transition-all ${
              (localTheme.headerStyle || 'standard') === style
                ? 'tile-selected'
                : 'border-line hover:border-line-strong'
            }`}
          >
            {/* min-w-0 + break-words: a grid item will not shrink below its
                min-content width, and German compounds here are long enough to
                exceed a narrow column — "Veranstaltungsinfo-Overlay" and
                "Veranstaltungsdetails" spilled out of the card and over the
                neighbouring one at three columns in a narrow panel (#1412).
                Any translation can do this, so the constraint belongs on the
                element rather than on the strings. */}
            <div className="flex flex-col items-center text-center w-full min-w-0">
              <div className="mb-2 text-body">
                {headerStyleIcons[style]}
              </div>
              <span className="w-full break-words font-medium text-sm capitalize text-heading">
                {t(`branding.headerStyleOptions.${style}`, style)}
              </span>
              <span className="w-full break-words text-xs text-soft mt-1">
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
        <div className="mt-6 pt-6 border-t border-line">
          <h4 className="font-medium text-sm text-body mb-3">
            {t('branding.heroDividerStyle', 'Divider Style')}
          </h4>
          <p className="text-xs text-soft mb-4">
            {t('branding.heroDividerDescription', 'Choose how the transition between the hero image and gallery content looks.')}
          </p>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(6rem,1fr))] gap-3">
            {(Object.keys(dividerStylePreviews) as HeroDividerStyle[]).map((divider) => (
              <button
                type="button"
                key={divider}
                onClick={() => handleChange('heroDividerStyle', divider)}
                className={`relative p-3 rounded-lg border-2 transition-all ${
                  (localTheme.heroDividerStyle || 'wave') === divider
                    ? 'tile-selected'
                    : 'border-line hover:border-line-strong'
                }`}
              >
                <div className="flex flex-col items-center w-full min-w-0">
                  <div className="w-full mb-2 bg-neutral-800 rounded-t overflow-hidden">
                    <div className="h-8"></div>
                    {dividerStylePreviews[divider]}
                  </div>
                  <span className="w-full break-words text-xs font-medium capitalize text-heading">
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
