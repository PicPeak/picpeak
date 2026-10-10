import React, { useMemo } from 'react';
import clsx from 'clsx';
import { Palette, RotateCcw, Info } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Card, Notice } from '../../common';
import { ThemeConfig } from '../../../types/theme.types';
import { applyForceColorMode } from '../../../utils/themeMigration';
import { DEFAULT_STATUS_COLORS, STATUS_KEYS, type StatusColors, type StatusKey } from '../../../utils/statusColors';
import { ColorPickerRow } from './ColorPickerRow';
import { colorWarnings, type ColorWarning } from './colorWarnings';
import type { ColorKey } from './ThemeColorPreview';

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
  /** Branding only: the site-wide status hues (missing = default). */
  statusColors?: StatusColors;
  onStatusColorsChange?: (next: StatusColors) => void;
  /** The picker being hovered or edited, for a preview to point at. */
  onColorFocus?: (key: ColorKey | null) => void;
}

// The palette fields a force lock replaces when the modes disagree.
const SWAPPED_KEYS = ['backgroundColor', 'surfaceColor', 'elevatedColor', 'surfaceBorderColor', 'textColor', 'mutedTextColor'];

interface PickerDef {
  key: string;
  label: string;
  help: string;
  fallback: string;
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
  onSyncFromBranding,
  statusColors,
  onStatusColorsChange,
  onColorFocus,
}) => {
  const { t } = useTranslation();
  // What visitors get: a force lock that disagrees with the palette's own
  // mode swaps in the built-in surfaces and text (applyForceColorMode).
  // Warnings check that palette, and a notice says when the pickers below
  // are not what visitors see.
  const effectiveTheme = useMemo(
    () => applyForceColorMode(localTheme, forcedColorActive ? forceColorMode ?? null : null),
    [localTheme, forcedColorActive, forceColorMode],
  );
  const surfacesReplaced = SWAPPED_KEYS.some(
    (key) => (effectiveTheme as Record<string, unknown>)[key] !== (localTheme as Record<string, unknown>)[key],
  );
  const warnings = useMemo(() => colorWarnings(effectiveTheme, statusColors), [effectiveTheme, statusColors]);

  const warningText = (w: ColorWarning): string => {
    const ratio = 'ratio' in w ? { ratio: w.ratio, needed: w.needed } : { ratio: 0, needed: 0 };
    switch (w.code) {
      case 'textOnBackground': return t('branding.colorWarnings.textOnBackground', 'Text is hard to read on the background ({{ratio}}:1, aim for {{needed}}:1).', ratio);
      case 'textOnSurface': return t('branding.colorWarnings.textOnSurface', 'Text is hard to read on cards ({{ratio}}:1, aim for {{needed}}:1).', ratio);
      case 'textOnElevated': return t('branding.colorWarnings.textOnElevated', 'Text on raised panels is hard to read ({{ratio}}:1, aim for {{needed}}:1). On a dark palette, pick a dark colour here.', ratio);
      case 'mutedOnSurface': return t('branding.colorWarnings.mutedOnSurface', 'Secondary text is hard to read on cards ({{ratio}}:1, aim for {{needed}}:1).', ratio);
      case 'borderInvisible': return t('branding.colorWarnings.borderInvisible', 'Borders barely show against cards.');
      case 'accentOnBackground': return t('branding.colorWarnings.accentOnBackground', 'Links and icons in this colour are hard to see on the background ({{ratio}}:1, aim for {{needed}}:1).', ratio);
      case 'buttonLabel': return t('branding.colorWarnings.buttonLabel', 'Button labels are hard to read on this colour ({{ratio}}:1, aim for {{needed}}:1).', ratio);
      case 'statusTooLight': return t('branding.colorWarnings.statusTooLight', 'Too light: labels in this colour wash out on white.');
      case 'statusLikeAccent': return t('branding.colorWarnings.statusLikeAccent', 'Looks like your accent colour, so it may read as a button rather than a status.');
      case 'statusLikeStatus': return t('branding.colorWarnings.statusLikeStatus', 'Hard to tell apart from "{{other}}".', { other: statusName(w.other) });
      default: return '';
    }
  };

  function statusName(key: StatusKey): string {
    return {
      success: t('branding.status.success', 'Success'),
      warning: t('branding.status.warning', 'Warning'),
      danger: t('branding.status.danger', 'Danger'),
      info: t('branding.status.info', 'Info'),
      storno: t('branding.status.storno', 'Cancelled (Storno)'),
    }[key];
  }

  const focus = (key: ColorKey) => (focused: boolean) => onColorFocus?.(focused ? key : null);

  const themePickers = (defs: PickerDef[]) => (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {defs.map(({ key, label, help, fallback }) => (
        <ColorPickerRow
          key={key}
          label={label}
          help={help}
          value={(localTheme as Record<string, string | undefined>)[key] || fallback}
          fallback={fallback}
          onChange={(v) => handleChange(key as keyof ThemeConfig, v)}
          warnings={(warnings[key] || []).map(warningText)}
          onFocusChange={focus(key)}
        />
      ))}
    </div>
  );

  const groupHeading = (title: string, help: string) => (
    <h4 className="text-sm font-semibold text-body uppercase tracking-wide mb-3 flex items-center gap-1.5">
      {title}
      <span className="info-tooltip text-faint" data-tooltip={help} tabIndex={0} aria-label={help}>
        <Info className="w-3.5 h-3.5" />
      </span>
    </h4>
  );

  const tile = (active: boolean) => clsx(
    'px-4 py-2 text-sm font-medium rounded-lg border transition-colors',
    active ? 'tile-selected' : 'border-line-strong text-soft hover:bg-hover-soft',
  );

  const statusHelp: Record<StatusKey, string> = {
    success: t('branding.status.successHelp', 'Paid, signed, published, done.'),
    warning: t('branding.status.warningHelp', 'Due soon, needs attention, not saved yet.'),
    danger: t('branding.status.dangerHelp', 'Overdue, failed, delete.'),
    info: t('branding.status.infoHelp', 'Sent, in progress, neutral notices.'),
    storno: t('branding.status.stornoHelp', 'Cancelled and credited documents.'),
  };

  return (
    <Card className="p-6">
      <div className="flex items-center justify-between gap-2 mb-4">
        <h3 className="text-lg font-semibold text-heading flex items-center gap-2">
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
          <Notice tone="warning" size="sm" className="mb-3">
            {isBrandingContext
              ? t('branding.forcedModeBrandingHint', 'Light/dark is locked site-wide by the Force control below — the per-theme mode picker is hidden because it would have no effect.')
              : t('branding.forcedModeGalleryNote', 'A site-wide color lock is active, so this gallery follows the locked light/dark mode. Color and light/dark options are hidden here and can’t be overridden per gallery.')}
          </Notice>
        )}
        {!forcedColorActive && (<>
        <p className="block text-sm font-medium text-body mb-2" id="color-mode-label">
          {t('branding.colorMode', 'Color Mode')}
        </p>
        <div className="flex flex-wrap gap-2" role="group" aria-labelledby="color-mode-label">
          {(['light', 'dark', 'auto'] as const).map((mode) => {
            const active = (localTheme.colorMode || 'light') === mode;
            return (
              <button
                type="button"
                key={mode}
                aria-pressed={active}
                onClick={() => handleColorModeSelect(mode)}
                className={tile(active)}
              >
                {mode === 'light' ? t('branding.colorModeLight', 'Light') :
                 mode === 'dark' ? t('branding.colorModeDark', 'Dark') :
                 t('branding.colorModeAuto', 'Auto')}
              </button>
            );
          })}
        </div>
        <p className="mt-1 text-sm text-muted">
          {t('branding.colorModeHelp', 'Auto follows the visitor\'s system preference.')}
        </p>
        </>)}

        {/*
         * Force color mode (instance-wide). Lives next to the per-theme
         * Color Mode picker so the admin can find both controls in one
         * place. Only rendered on the Branding page, which persists it.
         */}
        {onForceColorModeChange && (
          <div className="mt-5 pt-5 border-t border-line">
            <h4 className="block text-sm font-medium text-body mb-1" id="force-color-mode-label">
              {t('branding.forceColorMode', 'Force color mode')}
            </h4>
            <p className="text-xs text-muted mb-3">
              {t(
                'branding.forceColorModeHelp',
                'Lock the entire admin and public site to dark or light. The user-facing dark/light toggle is hidden whenever a lock is active. Per-event themes that try to override the colour mode are also forced to follow.'
              )}
            </p>
            <div className="flex flex-wrap gap-2" role="group" aria-labelledby="force-color-mode-label">
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
                    aria-pressed={active}
                    onClick={() => onForceColorModeChange(value)}
                    className={tile(active)}
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
       * Palette pickers, grouped by role. Each label carries an Info icon
       * with its help; readability warnings show under the picker.
       * Translation keys fall back to inline strings — German/English
       * coverage only; other locales show the fallback until reviewed.
       */}
      {!hideGalleryColors && (
      <div className="space-y-6">
        {surfacesReplaced && forceColorMode && (
          <Notice
            tone="info"
            size="sm"
            action={(
              <Button type="button" size="sm" variant="outline" onClick={() => handleColorModeSelect(forceColorMode)}>
                {forceColorMode === 'dark'
                  ? t('branding.useColorsForDark', 'Use these colours for dark')
                  : t('branding.useColorsForLight', 'Use these colours for light')}
              </Button>
            )}
          >
            {forceColorMode === 'dark'
              ? t('branding.surfacesReplacedDark', 'Dark is forced, but this palette is set up for light, so visitors see the built-in dark surfaces and text instead of the colours below.')
              : t('branding.surfacesReplacedLight', 'Light is forced, but this palette is set up for dark, so visitors see the built-in light surfaces and text instead of the colours below.')}
          </Notice>
        )}
        <div>
          {groupHeading(
            t('branding.colorGroupSurfaces', 'Surfaces'),
            t('branding.colorGroupSurfacesHelp', 'The neutral layers behind your content. Background sits furthest back; Surface and Elevated stack on top.'),
          )}
          {themePickers([
            { key: 'backgroundColor', label: t('branding.backgroundColor', 'Background Color'), help: t('branding.backgroundColorHelp', 'The page itself — body background of every gallery, admin page and CMS page.'), fallback: '#fafafa' },
            { key: 'surfaceColor', label: t('branding.surfaceColor', 'Surface'), help: t('branding.surfaceColorHelp', 'Cards, sidebar, header bar and navigation. The first layer above Background.'), fallback: '#ffffff' },
            { key: 'elevatedColor', label: t('branding.elevatedColor', 'Elevated'), help: t('branding.elevatedColorHelp', 'Panels that float above cards: image placeholders, hover/active rows, modal headers, code blocks.'), fallback: '#f5f5f5' },
            { key: 'surfaceBorderColor', label: t('branding.borderColor', 'Border'), help: t('branding.borderColorHelp', 'Dividers, table grid lines, card outlines, input borders.'), fallback: '#e5e5e5' },
          ])}
        </div>

        <div>
          {groupHeading(
            t('branding.colorGroupText', 'Text'),
            t('branding.colorGroupTextHelp', 'Foreground text colours. Primary is for everything readers focus on; Secondary is for supporting copy.'),
          )}
          {themePickers([
            { key: 'textColor', label: t('branding.textColor', 'Text Color'), help: t('branding.textColorHelp', 'Headlines, body copy, table cells, form input values, navigation labels — the main text colour.'), fallback: '#171717' },
            { key: 'mutedTextColor', label: t('branding.mutedTextColor', 'Muted text'), help: t('branding.mutedTextColorHelp', 'Captions, helper text under inputs, table column headers, footer links, dates and metadata.'), fallback: '#737373' },
          ])}
        </div>

        <div>
          {groupHeading(
            t('branding.colorGroupAccent', 'Accent'),
            t('branding.colorGroupAccentHelp', 'Brand colours that highlight interactive elements. Use a strong colour pair — Accent is for outlines/text, Accent Dark is for filled buttons.'),
          )}
          {themePickers([
            { key: 'accentColor', label: t('branding.accentColor', 'Accent Color'), help: t('branding.accentColorHelp', 'Links, icons, focus rings, hover states on primary buttons, active sidebar item underline. Should read clearly on both Background and Surface.'), fallback: '#22c55e' },
            { key: 'accentDarkColor', label: t('branding.accentDarkColor', 'Accent (filled)'), help: t('branding.accentDarkColorHelp', 'Filled CTA buttons, active sidebar item background, badges and tags. Needs enough contrast for white text to be readable on top.'), fallback: '#5C8762' },
          ])}
          {/* primaryColor is kept in sync with accentDarkColor inside
              handleChange() — no dedicated picker. */}
        </div>

        {/* Status (Branding only): site-wide, admin and public alike. */}
        {onStatusColorsChange && (
          <div>
            {groupHeading(
              t('branding.colorGroupStatus', 'Status'),
              t('branding.colorGroupStatusHelp', 'One colour per meaning, used for badges, notices and status labels in the admin, the customer portal and on public pages. Light and dark shades are worked out from it.'),
            )}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {STATUS_KEYS.map((key) => {
                const value = statusColors?.[key] || DEFAULT_STATUS_COLORS[key];
                const setStatus = (next: string | null) => {
                  const updated: StatusColors = { ...(statusColors || {}) };
                  if (next && next.toLowerCase() !== DEFAULT_STATUS_COLORS[key]) updated[key] = next;
                  else delete updated[key];
                  onStatusColorsChange(updated);
                };
                return (
                  <ColorPickerRow
                    key={key}
                    label={statusName(key)}
                    help={statusHelp[key]}
                    value={value}
                    fallback={DEFAULT_STATUS_COLORS[key]}
                    defaultValue={DEFAULT_STATUS_COLORS[key]}
                    onReset={() => setStatus(null)}
                    onChange={(v) => setStatus(v)}
                    warnings={(warnings[`status.${key}`] || []).map(warningText)}
                    onFocusChange={focus(`status.${key}`)}
                  />
                );
              })}
            </div>
          </div>
        )}
      </div>
      )}
    </Card>
  );
};
