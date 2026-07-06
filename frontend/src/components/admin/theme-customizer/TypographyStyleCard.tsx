import React from 'react';
import { Type } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card } from '../../common';
import { ThemeConfig } from '../../../types/theme.types';
import type { FontDefinition } from '../../../services/fonts.service';
import { buildFontFamilyValue, resolveFontDropdownValue } from './fontUtils';

interface TypographyStyleCardProps {
  localTheme: ThemeConfig;
  handleChange: (key: keyof ThemeConfig, newValue: any) => void;
  availableFonts?: FontDefinition[];
}

export const TypographyStyleCard: React.FC<TypographyStyleCardProps> = ({
  localTheme,
  handleChange,
  availableFonts
}) => {
  const { t } = useTranslation();

  return (
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
  );
};
