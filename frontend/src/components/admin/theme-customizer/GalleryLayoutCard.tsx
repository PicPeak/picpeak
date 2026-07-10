import React from 'react';
import { Layout, Check, AlertTriangle } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Card, Input } from '../../common';
import { ThemeConfig, GalleryLayoutType } from '../../../types/theme.types';
import { layoutIcons } from './icons';

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

  return (
    <Card className="p-6">
      <h3 className="text-lg font-semibold text-neutral-900 dark:text-neutral-100 mb-4 flex items-center gap-2">
        <Layout className="w-5 h-5" />
        {t('branding.galleryLayout')}
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {(Object.keys(layoutIcons) as GalleryLayoutType[]).map((layout) => (
          <button
            type="button"
            key={layout}
            onClick={() => handleChange('galleryLayout', layout)}
            className={`relative p-4 rounded-lg border-2 transition-all ${
              localTheme.galleryLayout === layout
                ? 'tile-selected'
                : 'border-neutral-200 dark:border-neutral-700 hover:border-neutral-300 dark:hover:border-neutral-600'
            }`}
          >
            <div className="flex flex-col items-center text-center">
              <div className="mb-2 text-neutral-700 dark:text-neutral-300">
                {layoutIcons[layout]}
              </div>
              <span className="font-medium text-sm capitalize text-neutral-900 dark:text-neutral-100">
                {layout}
                {(layout === 'gallery-premium' || layout === 'gallery-story') && (
                  <span className="ml-1 text-xs text-amber-600 dark:text-amber-400">(Beta)</span>
                )}
              </span>
              <span className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
                {t(`branding.layoutDescriptions.${layout}`)}
              </span>
            </div>
            {localTheme.galleryLayout === layout && (
              <Check className="absolute top-2 right-2 w-4 h-4 text-accent-dark" />
            )}
          </button>
        ))}
      </div>

      {/* Warning: Beta theme with low thumbnail resolution */}
      {isBetaLayout && isThumbnailTooSmall && (
        <div className="mt-4 p-4 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg">
          <div className="flex items-start gap-3">
            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400 flex-shrink-0 mt-0.5" />
            <div>
              <p className="text-sm font-medium text-amber-800 dark:text-amber-300">
                {t('branding.betaThumbnailWarningTitle')}
              </p>
              <p className="text-sm text-amber-700 dark:text-amber-400 mt-1">
                {t('branding.betaThumbnailWarningText', { width: thumbnailWidth, height: thumbnailHeight, recommended: minRecommendedThumbnailSize })}
              </p>
              <a
                href="/admin/settings"
                className="inline-flex items-center gap-1 mt-2 text-sm font-medium text-amber-800 dark:text-amber-300 hover:underline"
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
        <div className="mt-6 space-y-4 pt-6 border-t border-neutral-200 dark:border-neutral-700">
          <h4 className="font-medium text-sm text-neutral-700 dark:text-neutral-300">{t('branding.layoutSettings')}</h4>

          {/* Common settings */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                {t('branding.photoSpacing')}
              </label>
              <select
                value={localTheme.gallerySettings?.spacing || 'normal'}
                onChange={(e) => updateGallerySettings('spacing', e.target.value)}
                className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
              >
                <option value="tight">{t('branding.spacing.tight')}</option>
                <option value="normal">{t('branding.spacing.normal')}</option>
                <option value="relaxed">{t('branding.spacing.relaxed')}</option>
              </select>
            </div>

            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                {t('branding.photoAnimation')}
              </label>
              <select
                value={localTheme.gallerySettings?.photoAnimation || 'fade'}
                onChange={(e) => updateGallerySettings('photoAnimation', e.target.value)}
                className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
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
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                  {t('branding.columns')}
                </label>
                <div className="grid grid-cols-3 gap-4">
                  <div>
                    <label className="text-xs text-neutral-600 dark:text-neutral-400">{t('branding.mobile')}</label>
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
                    <label className="text-xs text-neutral-600 dark:text-neutral-400">{t('branding.tablet')}</label>
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
                    <label className="text-xs text-neutral-600 dark:text-neutral-400">{t('branding.desktop')}</label>
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
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                  {t('branding.thumbnailScale', 'Thumbnail Scale')}
                </label>
                <select
                  value={localTheme.gallerySettings?.thumbnailScale || 'md'}
                  onChange={(e) => updateGallerySettings('thumbnailScale', e.target.value)}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
                >
                  <option value="xs">{t('branding.thumbnailScaleOptions.xs', 'XS — Most photos')}</option>
                  <option value="sm">{t('branding.thumbnailScaleOptions.sm', 'SM — More photos')}</option>
                  <option value="md">{t('branding.thumbnailScaleOptions.md', 'MD — Default')}</option>
                  <option value="lg">{t('branding.thumbnailScaleOptions.lg', 'LG — Larger photos')}</option>
                  <option value="xl">{t('branding.thumbnailScaleOptions.xl', 'XL — Largest photos')}</option>
                </select>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
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
                  <span className="text-sm font-medium text-neutral-700 dark:text-neutral-300">{t('branding.enableAutoplay')}</span>
                </label>
              </div>
              {localTheme.gallerySettings?.carouselAutoplay && (
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
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
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                {t('branding.groupPhotosBy')}
              </label>
              <select
                value={localTheme.gallerySettings?.timelineGrouping || 'day'}
                onChange={(e) => updateGallerySettings('timelineGrouping', e.target.value)}
                className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
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
                <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                  {t('branding.masonryMode', 'Layout Mode')}
                </label>
                <select
                  value={localTheme.gallerySettings?.masonryMode || 'columns'}
                  onChange={(e) => updateGallerySettings('masonryMode', e.target.value)}
                  className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
                >
                  <option value="columns">{t('branding.masonryModeOptions.columns', 'Columns (Pinterest-style)')}</option>
                  <option value="rows">{t('branding.masonryModeOptions.rows', 'Rows (Custom justified)')}</option>
                  <option value="flickr">{t('branding.masonryModeOptions.flickr', 'Flickr (Battle-tested justified)')}</option>
                  <option value="justified">{t('branding.masonryModeOptions.justified', 'Google Photos (Knuth-Plass algorithm)')}</option>
                </select>
                <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                  {localTheme.gallerySettings?.masonryMode === 'columns'
                    ? t('branding.masonryModeHint.columns', 'Pinterest-style vertical columns with varied heights')
                    : localTheme.gallerySettings?.masonryMode === 'flickr'
                    ? t('branding.masonryModeHint.flickr', 'Flickr\'s open-source justified layout algorithm')
                    : localTheme.gallerySettings?.masonryMode === 'justified'
                    ? t('branding.masonryModeHint.justified', 'Google Photos-style rows using Knuth-Plass algorithm for optimal breaks')
                    : t('branding.masonryModeHint.rows', 'Custom row-based justified layout')}
                </p>
              </div>

              {/* Thumbnail scale - only for columns mode */}
              {(!localTheme.gallerySettings?.masonryMode || localTheme.gallerySettings?.masonryMode === 'columns') && (
                <div>
                  <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                    {t('branding.thumbnailScale', 'Thumbnail Scale')}
                  </label>
                  <select
                    value={localTheme.gallerySettings?.thumbnailScale || 'md'}
                    onChange={(e) => updateGallerySettings('thumbnailScale', e.target.value)}
                    className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
                  >
                    <option value="xs">{t('branding.thumbnailScaleOptions.xs', 'XS — Most photos')}</option>
                    <option value="sm">{t('branding.thumbnailScaleOptions.sm', 'SM — More photos')}</option>
                    <option value="md">{t('branding.thumbnailScaleOptions.md', 'MD — Default')}</option>
                    <option value="lg">{t('branding.thumbnailScaleOptions.lg', 'LG — Larger photos')}</option>
                    <option value="xl">{t('branding.thumbnailScaleOptions.xl', 'XL — Largest photos')}</option>
                  </select>
                  <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                    {t('branding.thumbnailScaleHint', 'Adjusts column count relative to the base grid columns')}
                  </p>
                </div>
              )}

              {/* Row-specific settings - show for all row-based modes */}
              {['rows', 'flickr', 'justified'].includes(localTheme.gallerySettings?.masonryMode || '') && (
                <>
                  <div>
                    <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                      {t('branding.targetRowHeight', 'Target Row Height')}
                    </label>
                    <Input
                      type="number"
                      min="150"
                      max="400"
                      value={localTheme.gallerySettings?.masonryRowHeight || 250}
                      onChange={(e) => updateGallerySettings('masonryRowHeight', parseInt(e.target.value))}
                    />
                    <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                      {t('branding.targetRowHeightHint', 'Height in pixels (150-400). Photos will scale to fit rows.')}
                    </p>
                  </div>
                  {/* Last row behavior - only for rows and flickr modes */}
                  {['rows', 'flickr'].includes(localTheme.gallerySettings?.masonryMode || '') && (
                    <div>
                      <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                        {t('branding.lastRowBehavior', 'Last Row Alignment')}
                      </label>
                      <select
                        value={localTheme.gallerySettings?.masonryLastRowBehavior || 'left'}
                        onChange={(e) => updateGallerySettings('masonryLastRowBehavior', e.target.value)}
                        className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
                      >
                        <option value="left">{t('branding.lastRowOptions.left', 'Left aligned')}</option>
                        <option value="center">{t('branding.lastRowOptions.center', 'Centered')}</option>
                        <option value="justify">{t('branding.lastRowOptions.justify', 'Justified (stretch)')}</option>
                      </select>
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {/* Mosaic specific */}
          {localTheme.galleryLayout === 'mosaic' && (
            <div>
              <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
                {t('branding.thumbnailScale', 'Thumbnail Scale')}
              </label>
              <select
                value={localTheme.gallerySettings?.thumbnailScale || 'md'}
                onChange={(e) => updateGallerySettings('thumbnailScale', e.target.value)}
                className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100"
              >
                <option value="xs">{t('branding.thumbnailScaleOptions.xs', 'XS — Most photos')}</option>
                <option value="sm">{t('branding.thumbnailScaleOptions.sm', 'SM — More photos')}</option>
                <option value="md">{t('branding.thumbnailScaleOptions.md', 'MD — Default')}</option>
                <option value="lg">{t('branding.thumbnailScaleOptions.lg', 'LG — Larger photos')}</option>
                <option value="xl">{t('branding.thumbnailScaleOptions.xl', 'XL — Largest photos')}</option>
              </select>
              <p className="text-xs text-neutral-500 dark:text-neutral-400 mt-1">
                {t('branding.thumbnailScaleHint', 'Adjusts column count relative to the base grid columns')}
              </p>
            </div>
          )}
        </div>
      )}
    </Card>
  );
};
