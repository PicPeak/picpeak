import React from 'react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';
import { Heart, Image as ImageIcon } from 'lucide-react';
import type { ThemeConfig } from '../../../types/theme.types';
import { applyForceColorMode } from '../../../utils/themeMigration';
import { getReadableForeground } from '../../../utils/contrast';
import { DEFAULT_STATUS_COLORS, STATUS_KEYS, type StatusColors, type StatusKey } from '../../../utils/statusColors';
import { Badge } from '../../common/Badge';

/** A picker's key: a ThemeConfig colour field, or `status.<key>`. */
export type ColorKey = string;

interface ThemeColorPreviewProps {
  theme: ThemeConfig;
  statusColors?: StatusColors;
  forceColorMode?: 'dark' | 'light' | null;
  /** The picker being hovered or edited: its uses get an outline. */
  highlight?: ColorKey | null;
}

const STATUS_TONE: Record<StatusKey, StatusKey> = {
  success: 'success', warning: 'warning', danger: 'danger', info: 'info', storno: 'storno',
};

/**
 * Branding › Colours, previewed with only the colours being edited: a
 * gallery/portal card on the theme palette, the status chips on it, and the
 * admin's badges in light and dark. Hovering a picker outlines where that
 * colour lands. Shows the palette as visitors get it, the force lock applied.
 */
export const ThemeColorPreview: React.FC<ThemeColorPreviewProps> = ({
  theme: rawTheme,
  statusColors = {},
  forceColorMode = null,
  highlight = null,
}) => {
  const { t } = useTranslation();
  const theme = applyForceColorMode(rawTheme, forceColorMode);
  const hue = (key: StatusKey) => {
    const picked = statusColors[key];
    return picked && /^#[0-9a-f]{6}$/i.test(picked) ? picked : DEFAULT_STATUS_COLORS[key];
  };

  const themed = {
    '--color-background': theme.backgroundColor,
    '--color-surface': theme.surfaceColor,
    '--color-elevated': theme.elevatedColor,
    '--color-surface-border': theme.surfaceBorderColor,
    '--color-text': theme.textColor,
    '--color-muted-text': theme.mutedTextColor,
    '--color-accent': theme.accentColor,
    '--color-accent-dark': theme.accentDarkColor,
    '--color-accent-dark-fg': getReadableForeground(theme.accentDarkColor),
    ...Object.fromEntries(STATUS_KEYS.map((key) => [`--status-${key}`, hue(key)])),
  } as React.CSSProperties;

  // Outline what the highlighted picker paints. `uses` lists the picker keys.
  const mark = (...uses: ColorKey[]) => (highlight && uses.includes(highlight)
    ? 'outline outline-2 outline-dashed outline-offset-2 outline-info'
    : '');

  const statusLabel: Record<StatusKey, string> = {
    success: t('branding.colorPreview.statusSuccess', 'Paid'),
    warning: t('branding.colorPreview.statusWarning', 'Due soon'),
    danger: t('branding.colorPreview.statusDanger', 'Overdue'),
    info: t('branding.colorPreview.statusInfo', 'Sent'),
    storno: t('branding.colorPreview.statusStorno', 'Cancelled'),
  };

  const mode = theme.colorMode === 'dark' ? 'dark' : theme.colorMode === 'auto' ? 'auto' : 'light';
  const modeLabel = {
    light: t('branding.colorModeLight', 'Light'),
    dark: t('branding.colorModeDark', 'Dark'),
    auto: t('branding.colorModeAuto', 'Auto'),
  }[mode];

  return (
    <div className="space-y-4" style={themed}>
      <div>
        <p className="text-xs font-medium text-muted mb-2">
          {t('branding.colorPreview.galleryAndPortal', 'Gallery and customer portal')}
          {' · '}
          {forceColorMode
            ? t('branding.colorPreview.modeForced', '{{mode}}, locked', { mode: modeLabel })
            : modeLabel}
        </p>
        <div
          className={clsx('rounded-xl p-4', mark('backgroundColor'))}
          style={{ backgroundColor: 'var(--color-background)' }}
        >
          <div
            className={clsx('rounded-lg border p-4 space-y-3', mark('surfaceColor', 'surfaceBorderColor'))}
            style={{ backgroundColor: 'var(--color-surface)', borderColor: 'var(--color-surface-border)' }}
          >
            <div>
              <p className={clsx('font-semibold', mark('textColor'))} style={{ color: 'var(--color-text)' }}>
                {t('branding.colorPreview.galleryTitle', 'Anna & Ben, wedding')}
              </p>
              <p className={clsx('text-sm', mark('mutedTextColor'))} style={{ color: 'var(--color-muted-text)' }}>
                {t('branding.colorPreview.galleryMeta', '12 October 2026 · 248 photos')}
              </p>
            </div>
            <div
              className={clsx('flex items-center gap-2 rounded-md px-3 py-2 text-sm', mark('elevatedColor'))}
              style={{ backgroundColor: 'var(--color-elevated)', color: 'var(--color-text)' }}
            >
              <Heart className="w-4 h-4" style={{ color: 'var(--color-accent)' }} />
              {t('branding.colorPreview.favourites', 'Your favourites (12)')}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span
                className={clsx('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium', mark('accentDarkColor'))}
                style={{ backgroundColor: 'var(--color-accent-dark)', color: 'var(--color-accent-dark-fg)' }}
              >
                <ImageIcon className="w-4 h-4" />
                {t('branding.colorPreview.openGallery', 'Open gallery')}
              </span>
              <span
                className={clsx('rounded-md border px-3 py-1.5 text-sm', mark('surfaceBorderColor', 'textColor'))}
                style={{ borderColor: 'var(--color-surface-border)', color: 'var(--color-text)' }}
              >
                {t('branding.colorPreview.share', 'Share')}
              </span>
              <span className={clsx('text-sm underline', mark('accentColor'))} style={{ color: 'var(--color-accent)' }}>
                {t('branding.colorPreview.downloadAll', 'Download all')}
              </span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {STATUS_KEYS.map((key) => (
                <span
                  key={key}
                  className={clsx(`status-chip hue-${key} inline-flex rounded-full px-2 py-0.5 text-xs font-medium`, mark(`status.${key}`))}
                >
                  {statusLabel[key]}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>

      <div>
        <p className="text-xs font-medium text-muted mb-2">{t('branding.colorPreview.admin', 'Admin, light and dark')}</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {(['ui-light', 'ui-dark'] as const).map((scope) => (
            <div key={scope} className={clsx(scope, 'rounded-lg border border-line bg-panel p-3 flex flex-wrap gap-1.5')}>
              {STATUS_KEYS.map((key) => (
                <span key={key} className={clsx('rounded-full', mark(`status.${key}`))}>
                  <Badge tone={STATUS_TONE[key]} dot>{statusLabel[key]}</Badge>
                </span>
              ))}
              <span
                className={clsx('inline-flex items-center rounded-lg px-2.5 py-1 text-xs font-medium bg-accent-strong text-accent-fg', mark('accentDarkColor'))}
              >
                {t('branding.colorPreview.save', 'Save')}
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
