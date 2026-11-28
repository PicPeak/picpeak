import React, { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Input } from '../../common';
import type { GalleryLayoutSettings } from '../../../types/theme.types';
import { LayoutPicker } from './LayoutPicker';
import {
  FOLIO_COLUMN_LIMITS,
  FOLIO_COVERS,
  FOLIO_PALETTE_COLORS,
  FOLIO_PALETTES,
  FOLIO_SPACINGS,
  FOLIO_STUDIO_LABEL_MAX,
  FOLIO_TYPES,
  folioSettings,
  type FolioCover,
  type FolioPalette,
} from '../../gallery/layouts/folioSettings';

const coverWireframes: Record<FolioCover, React.ReactNode> = {
  full: (
    <svg viewBox="0 0 48 36" className="block w-full h-auto" aria-hidden="true" focusable="false">
      <rect x="0.5" y="0.5" width="47" height="35" rx="2" fill="currentColor" fillOpacity="0.3" stroke="currentColor" strokeOpacity="0.35" />
      <rect x="16" y="25" width="16" height="2" rx="1" fill="currentColor" />
      <rect x="20" y="29" width="8" height="1" rx="0.5" fill="currentColor" fillOpacity="0.6" />
    </svg>
  ),
  split: (
    <svg viewBox="0 0 48 36" className="block w-full h-auto" aria-hidden="true" focusable="false">
      <rect x="0.5" y="0.5" width="47" height="35" rx="2" fill="none" stroke="currentColor" strokeOpacity="0.35" />
      <rect x="20" y="1" width="27" height="34" rx="1.5" fill="currentColor" fillOpacity="0.3" />
      <rect x="4" y="15" width="12" height="2" rx="1" fill="currentColor" />
      <rect x="4" y="19" width="7" height="1" rx="0.5" fill="currentColor" fillOpacity="0.6" />
    </svg>
  ),
};

// A swatch of the palette itself: the page, a photo and two lines of text.
// The colours are the palette's data, not styling.
const paletteSwatch = (palette: FolioPalette) => {
  const colors = FOLIO_PALETTE_COLORS[palette];
  return (
    <svg viewBox="0 0 48 36" className="block w-full h-auto" aria-hidden="true" focusable="false">
      <rect x="0.5" y="0.5" width="47" height="35" rx="2" fill={colors.background} stroke={colors.border} />
      <rect x="4" y="4" width="18" height="24" rx="1" fill={colors.elevated} />
      <rect x="26" y="9" width="17" height="2.5" rx="1.25" fill={colors.text} />
      <rect x="26" y="15" width="12" height="1.5" rx="0.75" fill={colors.muted} />
      <rect x="26" y="19" width="14" height="1.5" rx="0.75" fill={colors.muted} />
    </svg>
  );
};

const selectClass = 'w-full px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading';

interface FolioSettingsFieldsProps {
  gallerySettings?: GalleryLayoutSettings;
  updateGallerySettings: (key: string, value: unknown) => void;
}

/**
 * Gallery Folio's design options (issue 2617) in the theme editor. Fonts are
 * the Typography card's and the cover's focal point is the event's hero
 * photo setting, so neither is repeated here.
 */
export const FolioSettingsFields: React.FC<FolioSettingsFieldsProps> = ({ gallerySettings, updateGallerySettings }) => {
  const { t } = useTranslation();
  const ids = useId();
  const folio = folioSettings(gallerySettings);

  return (
    <div className="space-y-4" data-testid="folio-settings">
      <div>
        <span id={`${ids}-cover`} className="block text-sm font-medium text-body mb-2">
          {t('branding.folio.cover', 'Cover')}
        </span>
        <LayoutPicker
          aria-labelledby={`${ids}-cover`}
          compact
          options={FOLIO_COVERS.map((cover) => ({
            value: cover,
            label: t(`branding.folio.covers.${cover}`),
            wireframe: coverWireframes[cover],
          }))}
          value={folio.cover}
          onChange={(cover) => updateGallerySettings('folioCover', cover)}
        />
        <p className="text-xs text-muted mt-1">
          {t('branding.folio.coverHint', 'The cover shows the gallery\'s hero photo, cropped around the focal point set in the gallery\'s settings.')}
        </p>
      </div>

      <div>
        <span id={`${ids}-palette`} className="block text-sm font-medium text-body mb-2">
          {t('branding.folio.palette', 'Palette')}
        </span>
        <LayoutPicker
          aria-labelledby={`${ids}-palette`}
          compact
          options={FOLIO_PALETTES.map((palette) => ({
            value: palette,
            label: t(`branding.folio.palettes.${palette}`),
            wireframe: paletteSwatch(palette),
          }))}
          value={folio.palette}
          onChange={(palette) => updateGallerySettings('folioPalette', palette)}
        />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div>
          <label htmlFor={`${ids}-type`} className="block text-sm font-medium text-body mb-2">
            {t('branding.folio.type', 'Typography')}
          </label>
          <select
            id={`${ids}-type`}
            value={folio.type}
            onChange={(e) => updateGallerySettings('folioType', e.target.value)}
            className={selectClass}
            aria-describedby={`${ids}-type-hint`}
          >
            {FOLIO_TYPES.map((type) => (
              <option key={type} value={type}>{t(`branding.folio.types.${type}`)}</option>
            ))}
          </select>
          <p id={`${ids}-type-hint`} className="text-xs text-muted mt-1">
            {t('branding.folio.typeHint', 'Uses the heading and body fonts from Typography & Style.')}
          </p>
        </div>
        <div>
          <label htmlFor={`${ids}-spacing`} className="block text-sm font-medium text-body mb-2">
            {t('branding.folio.spacing', 'Spacing')}
          </label>
          <select
            id={`${ids}-spacing`}
            value={folio.spacing}
            onChange={(e) => updateGallerySettings('folioSpacing', e.target.value)}
            className={selectClass}
          >
            {FOLIO_SPACINGS.map((spacing) => (
              <option key={spacing} value={spacing}>{t(`branding.folio.spacings.${spacing}`)}</option>
            ))}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {(['mobile', 'desktop'] as const).map((device) => {
          const { min, max } = FOLIO_COLUMN_LIMITS[device];
          return (
            <div key={device}>
              <label htmlFor={`${ids}-columns-${device}`} className="block text-sm font-medium text-body mb-2">
                {t(`branding.folio.columns.${device}`)}
              </label>
              <select
                id={`${ids}-columns-${device}`}
                value={folio.columns[device]}
                onChange={(e) => updateGallerySettings('folioColumns', { ...folio.columns, [device]: Number(e.target.value) })}
                className={selectClass}
              >
                {Array.from({ length: max - min + 1 }, (_, i) => min + i).map((count) => (
                  <option key={count} value={count}>{count}</option>
                ))}
              </select>
            </div>
          );
        })}
      </div>

      <Input
        id={`${ids}-studio`}
        label={t('branding.folio.studioLabel', 'Studio label')}
        value={gallerySettings?.folioStudioLabel || ''}
        onChange={(e) => updateGallerySettings('folioStudioLabel', e.target.value)}
        maxLength={FOLIO_STUDIO_LABEL_MAX}
        helperText={t('branding.folio.studioLabelHint', 'A short name for the top of the page, such as your studio. Leave empty to show the gallery\'s name.')}
      />
    </div>
  );
};
