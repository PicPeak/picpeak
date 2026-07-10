import React from 'react';
import { Palette, RotateCcw, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Card } from '../../common';
import { ThemeConfig } from '../../../types/theme.types';
import { ColorPickerRow } from './ColorPickerRow';

interface ColorCustomizationCardProps {
  localTheme: ThemeConfig;
  handleChange: (key: keyof ThemeConfig, newValue: any) => void;
  handleColorModeSelect: (mode: 'light' | 'dark' | 'auto') => void;
  forcedColorActive: boolean;
  isBrandingContext: boolean;
  hideGalleryColors: boolean;
  forceColorMode?: 'dark' | 'light' | null;
  onForceColorModeChange?: (mode: 'dark' | 'light' | null) => void;
  onSyncFromBranding?: () => void;
}

export const ColorCustomizationCard: React.FC<ColorCustomizationCardProps> = ({
  localTheme,
  handleChange,
  handleColorModeSelect,
  forcedColorActive,
  isBrandingContext,
  hideGalleryColors,
  forceColorMode,
  onForceColorModeChange,
  onSyncFromBranding
}) => {
  const { t } = useTranslation();

  return (
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
              onClick={() => handleColorModeSelect(mode)}
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
  );
};
