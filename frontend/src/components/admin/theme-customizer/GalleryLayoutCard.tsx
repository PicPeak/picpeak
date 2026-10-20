import React, { useId } from 'react';
import { Layout, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card, Input, Switch } from '../../common';
import { ThemeConfig, STORY_FOOTER_TEXT_MAX, STORY_FOOTER_TITLE_MAX } from '../../../types/theme.types';
import { LayoutPicker } from './LayoutPicker';
import { masonryModeWireframes, useGalleryLayoutOptions, type MasonryPickerMode } from './layoutWireframes';

interface GalleryLayoutCardProps {
  localTheme: ThemeConfig;
  handleChange: (key: keyof ThemeConfig, newValue: any) => void;
  updateGallerySettings: (key: string, value: any) => void;
  isBetaLayout: boolean;
  isThumbnailTooSmall: boolean;
  thumbnailWidth: number;
  thumbnailHeight: number;
  minRecommendedThumbnailSize: number;
}

export const GalleryLayoutCard: React.FC<GalleryLayoutCardProps> = ({
  localTheme,
  handleChange,
  updateGallerySettings,
  isBetaLayout,
  isThumbnailTooSmall,
  thumbnailWidth,
  thumbnailHeight,
  minRecommendedThumbnailSize
}) => {
  const { t } = useTranslation();
  const layoutOptions = useGalleryLayoutOptions();
  const layoutHeadingId = useId();
  const masonryModeLabelId = useId();
  // A stored 'justified' renders as rows (MasonryGalleryLayout), so the
  // picker and the settings below treat it as Rows; the stored value stays
  // until the admin picks.
  const storedMasonryMode = localTheme.gallerySettings?.masonryMode || 'columns';
  const masonryMode: MasonryPickerMode = storedMasonryMode === 'justified' ? 'rows' : storedMasonryMode;

  return (
    <Card className="p-6">
      <h3 id={layoutHeadingId} className="text-lg font-semibold text-heading mb-4 flex items-center gap-2">
        <Layout className="w-5 h-5" />
        {t('branding.galleryLayout')}
      </h3>
      <LayoutPicker
        aria-labelledby={layoutHeadingId}
        options={layoutOptions}
        value={localTheme.galleryLayout}
        onChange={(layout) => handleChange('galleryLayout', layout)}
      />

      {/* Warning: Beta theme with low thumbnail resolution */}
      {isBetaLayout && isThumbnailTooSmall && (
        <div className="mt-4 p-4 bg-warning-soft border border-warning-line rounded-lg">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-warning-text flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-warning-text">
                {t('branding.betaThumbnailWarningTitle')}
              </p>
              <p className="text-sm text-warning-text mt-1">
                {t('branding.betaThumbnailWarningText', { width: thumbnailWidth, height: thumbnailHeight, recommended: minRecommendedThumbnailSize })}
              </p>
              <a
                href="/admin/settings"
                className="inline-flex items-center gap-1 mt-2 text-sm font-medium text-warning-text hover:underline"
                onClick={(e) => {
                  e.preventDefault();
                  window.location.href = '/admin/settings';
                }}
              >
                {t('branding.betaThumbnailWarningLink')} →
              </a>
            </div>
          </div>
        </div>
      )}

      {/* Layout-specific settings */}
      {localTheme.galleryLayout && (
        <div className="mt-6 space-y-4 pt-6 border-t border-line">
          <h4 className="font-medium text-sm text-body">{t('branding.layoutSettings')}</h4>

          {/* Common settings */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-body mb-2">
                {t('branding.photoSpacing')}
              </label>
              <select
                value={localTheme.gallerySettings?.spacing || 'normal'}
                onChange={(e) => updateGallerySettings('spacing', e.target.value)}
                className="w-full px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading"
              >
                <option value="tight">{t('branding.spacing.tight')}</option>
                <option value="normal">{t('branding.spacing.normal')}</option>
                <option value="relaxed">{t('branding.spacing.relaxed')}</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-body mb-2">
                {t('branding.photoAnimation')}
              </label>
              <select
                value={localTheme.gallerySettings?.photoAnimation || 'fade'}
                onChange={(e) => updateGallerySettings('photoAnimation', e.target.value)}
                className="w-full px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading"
              >
                <option value="none">{t('branding.animation.none')}</option>
                <option value="fade">{t('branding.animation.fade')}</option>
                <option value="scale">{t('branding.animation.scale')}</option>
                <option value="slide">{t('branding.animation.slide')}</option>
              </select>
            </div>
          </div>

          {/* Grid specific */}
          {localTheme.galleryLayout === 'grid' && (
            <>
              <div>
                <label className="block text-sm font-medium text-body mb-2">
                  {t('branding.columns')}
                </label>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="text-xs text-soft">{t('branding.mobile')}</label>
                    <Input
                      type="number"
                      min="1"
                      max="4"
                      value={localTheme.gallerySettings?.gridColumns?.mobile || 2}
                      onChange={(e) => updateGallerySettings('gridColumns', {
                        ...localTheme.gallerySettings?.gridColumns,
                        mobile: parseInt(e.target.value)
                      })}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-soft">{t('branding.tablet')}</label>
                    <Input
                      type="number"
                      min="2"
                      max="6"
                      value={localTheme.gallerySettings?.gridColumns?.tablet || 3}
                      onChange={(e) => updateGallerySettings('gridColumns', {
                        ...localTheme.gallerySettings?.gridColumns,
                        tablet: parseInt(e.target.value)
                      })}
                    />
                  </div>
                  <div>
                    <label className="text-xs text-soft">{t('branding.desktop')}</label>
                    <Input
                      type="number"
                      min="3"
                      max="8"
                      value={localTheme.gallerySettings?.gridColumns?.desktop || 4}
                      onChange={(e) => updateGallerySettings('gridColumns', {
                        ...localTheme.gallerySettings?.gridColumns,
                        desktop: parseInt(e.target.value)
                      })}
                    />
                  </div>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-body mb-2">
                  {t('branding.thumbnailScale', 'Thumbnail Scale')}
                </label>
                <select
                  value={localTheme.gallerySettings?.thumbnailScale || 'md'}
                  onChange={(e) => updateGallerySettings('thumbnailScale', e.target.value)}
                  className="w-full px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading"
                >
                  <option value="xs">{t('branding.thumbnailScaleOptions.xs', 'XS — Most photos')}</option>
                  <option value="sm">{t('branding.thumbnailScaleOptions.sm', 'SM — More photos')}</option>
                  <option value="md">{t('branding.thumbnailScaleOptions.md', 'MD — Default')}</option>
                  <option value="lg">{t('branding.thumbnailScaleOptions.lg', 'LG — Larger photos')}</option>
                  <option value="xl">{t('branding.thumbnailScaleOptions.xl', 'XL — Largest photos')}</option>
                </select>
                <p className="text-xs text-muted mt-1">
                  {t('branding.thumbnailScaleHint', 'Adjusts column count relative to the base grid columns')}
                </p>
              </div>
            </>
          )}

          {/* Carousel specific */}
          {localTheme.galleryLayout === 'carousel' && (
            <>
              <div>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={localTheme.gallerySettings?.carouselAutoplay || false}
                    onChange={(e) => updateGallerySettings('carouselAutoplay', e.target.checked)}
                    className="rounded"
                  />
                  <span className="text-sm font-medium text-body">{t('branding.enableAutoplay')}</span>
                </label>
              </div>
              {localTheme.gallerySettings?.carouselAutoplay && (
                <div>
                  <label className="block text-sm font-medium text-body mb-2">
                    {t('branding.autoplayInterval')}
                  </label>
                  <Input
                    type="number"
                    min="2"
                    max="10"
                    value={(localTheme.gallerySettings?.carouselInterval || 5000) / 1000}
                    onChange={(e) => updateGallerySettings('carouselInterval', parseInt(e.target.value) * 1000)}
                  />
                </div>
              )}
            </>
          )}

          {/* Timeline specific */}
          {localTheme.galleryLayout === 'timeline' && (
            <div>
              <label className="block text-sm font-medium text-body mb-2">
                {t('branding.groupPhotosBy')}
              </label>
              <select
                value={localTheme.gallerySettings?.timelineGrouping || 'day'}
                onChange={(e) => updateGallerySettings('timelineGrouping', e.target.value)}
                className="w-full px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading"
              >
                <option value="day">{t('branding.grouping.day')}</option>
                <option value="week">{t('branding.grouping.week')}</option>
                <option value="month">{t('branding.grouping.month')}</option>
              </select>
            </div>
          )}

          {/* Masonry specific */}
          {localTheme.galleryLayout === 'masonry' && (
            <>
              <div>
                <span id={masonryModeLabelId} className="block text-sm font-medium text-body mb-2">
                  {t('branding.masonryMode', 'Layout Mode')}
                </span>
                <LayoutPicker
                  aria-labelledby={masonryModeLabelId}
                  options={(Object.keys(masonryModeWireframes) as MasonryPickerMode[]).map((mode) => ({
                    value: mode,
                    label: t(`branding.masonryModeNames.${mode}`),
                    description: t(`branding.masonryModeDescriptions.${mode}`),
                    wireframe: masonryModeWireframes[mode],
                  }))}
                  value={masonryMode}
                  onChange={(mode) => updateGallerySettings('masonryMode', mode)}
                />
              </div>

              {/* Thumbnail scale - only for columns mode */}
              {masonryMode === 'columns' && (
                <div>
                  <label className="block text-sm font-medium text-body mb-2">
                    {t('branding.thumbnailScale', 'Thumbnail Scale')}
                  </label>
                  <select
                    value={localTheme.gallerySettings?.thumbnailScale || 'md'}
                    onChange={(e) => updateGallerySettings('thumbnailScale', e.target.value)}
                    className="w-full px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading"
                  >
                    <option value="xs">{t('branding.thumbnailScaleOptions.xs', 'XS — Most photos')}</option>
                    <option value="sm">{t('branding.thumbnailScaleOptions.sm', 'SM — More photos')}</option>
                    <option value="md">{t('branding.thumbnailScaleOptions.md', 'MD — Default')}</option>
                    <option value="lg">{t('branding.thumbnailScaleOptions.lg', 'LG — Larger photos')}</option>
                    <option value="xl">{t('branding.thumbnailScaleOptions.xl', 'XL — Largest photos')}</option>
                  </select>
                  <p className="text-xs text-muted mt-1">
                    {t('branding.thumbnailScaleHint', 'Adjusts column count relative to the base grid columns')}
                  </p>
                </div>
              )}

              {/* Row-specific settings - show for all row-based modes */}
              {(masonryMode === 'rows' || masonryMode === 'flickr') && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-body mb-2">
                      {t('branding.targetRowHeight', 'Target Row Height')}
                    </label>
                    <Input
                      type="number"
                      min="150"
                      max="400"
                      value={localTheme.gallerySettings?.masonryRowHeight || 250}
                      onChange={(e) => updateGallerySettings('masonryRowHeight', parseInt(e.target.value))}
                    />
                    <p className="text-xs text-muted mt-1">
                      {t('branding.targetRowHeightHint', 'Height in pixels (150-400). Photos will scale to fit rows.')}
                    </p>
                  </div>
                  {/* Last row behavior */}
                  <div>
                    <label className="block text-sm font-medium text-body mb-2">
                      {t('branding.lastRowBehavior', 'Last Row Alignment')}
                    </label>
                    <select
                      value={localTheme.gallerySettings?.masonryLastRowBehavior || 'left'}
                      onChange={(e) => updateGallerySettings('masonryLastRowBehavior', e.target.value)}
                      className="w-full px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading"
                    >
                      <option value="left">{t('branding.lastRowOptions.left', 'Left aligned')}</option>
                      <option value="center">{t('branding.lastRowOptions.center', 'Centered')}</option>
                      <option value="justify">{t('branding.lastRowOptions.justify', 'Justified (stretch)')}</option>
                    </select>
                  </div>
                </>
              )}
            </>
          )}

          {/* Mosaic specific */}
          {/* Gallery Story specific (issue 1709) */}
          {localTheme.galleryLayout === 'gallery-story' && (
            <>
              <div>
                <label className="block text-sm font-medium text-body mb-2">
                  {t('branding.storyGridMode', 'Photo Framing')}
                </label>
                <select
                  value={localTheme.gallerySettings?.storyGridMode || 'fixed'}
                  onChange={(e) => updateGallerySettings('storyGridMode', e.target.value)}
                  className="w-full px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading"
                >
                  <option value="fixed">{t('branding.storyGridModeOptions.fixed', 'Fixed tiles (crop to fill)')}</option>
                  <option value="natural">{t('branding.storyGridModeOptions.natural', 'Natural (keep every aspect ratio)')}</option>
                </select>
                <p className="text-xs text-muted mt-1">
                  {t('branding.storyGridModeHint', 'Natural lays scenes out in rows from each photo\'s dimensions, so portrait photos are shown whole instead of cropped.')}
                </p>
              </div>
              <Switch
                checked={localTheme.gallerySettings?.storyShowFilenames === true}
                onChange={(next) => updateGallerySettings('storyShowFilenames', next)}
                label={t('branding.storyShowFilenames', 'Show filenames on hover')}
                description={t('branding.storyShowFilenamesHint', 'Shows the photo\'s filename when a guest hovers over it. A gallery set to show original filenames shows the uploaded name.')}
              />
              <Input
                label={t('branding.storyFooterTitle', 'Footer title')}
                value={localTheme.gallerySettings?.storyFooterTitle || ''}
                onChange={(e) => updateGallerySettings('storyFooterTitle', e.target.value)}
                maxLength={STORY_FOOTER_TITLE_MAX}
                placeholder={t('gallery.thankYou', 'Thank You')}
                helperText={t('branding.storyFooterTitleHint', 'Leave empty for "Thank You".')}
              />
              <div>
                <label htmlFor="story-footer-text" className="block text-sm font-medium text-body mb-1.5">
                  {t('branding.storyFooterText', 'Footer text')}
                </label>
                <textarea
                  id="story-footer-text"
                  rows={3}
                  value={localTheme.gallerySettings?.storyFooterText || ''}
                  onChange={(e) => updateGallerySettings('storyFooterText', e.target.value)}
                  maxLength={STORY_FOOTER_TEXT_MAX}
                  // h-auto: `.input` fixes the height at h-10, which would
                  // cut the three rows down to one.
                  className="input w-full h-auto"
                  aria-describedby="story-footer-text-hint"
                />
                <p id="story-footer-text-hint" className="text-xs text-muted mt-1">
                  {t('branding.storyFooterTextHint', 'Plain text, up to {{max}} characters. Leave empty to show the welcome message, or the default thank-you line when there is none.', { max: STORY_FOOTER_TEXT_MAX })}
                </p>
              </div>
            </>
          )}

          {localTheme.galleryLayout === 'mosaic' && (
            <div>
              <label className="block text-sm font-medium text-body mb-2">
                {t('branding.thumbnailScale', 'Thumbnail Scale')}
              </label>
              <select
                value={localTheme.gallerySettings?.thumbnailScale || 'md'}
                onChange={(e) => updateGallerySettings('thumbnailScale', e.target.value)}
                className="w-full px-3 py-2 border border-line-strong rounded-lg bg-panel text-heading"
              >
                <option value="xs">{t('branding.thumbnailScaleOptions.xs', 'XS — Most photos')}</option>
                <option value="sm">{t('branding.thumbnailScaleOptions.sm', 'SM — More photos')}</option>
                <option value="md">{t('branding.thumbnailScaleOptions.md', 'MD — Default')}</option>
                <option value="lg">{t('branding.thumbnailScaleOptions.lg', 'LG — Larger photos')}</option>
                <option value="xl">{t('branding.thumbnailScaleOptions.xl', 'XL — Largest photos')}</option>
              </select>
              <p className="text-xs text-muted mt-1">
                {t('branding.thumbnailScaleHint', 'Adjusts column count relative to the base grid columns')}
              </p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
};
