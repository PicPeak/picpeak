import React from 'react';
import { Star, Heart, Bookmark, MessageCircle, Filter, X } from 'lucide-react';
import { COLOR_LABELS, COLOR_LABEL_SWATCHES, type ColorLabel } from '../../services/feedback.service';
import { useTranslation } from 'react-i18next';
import { Button } from '../common';
import { FeedbackFilters, FilterSummary } from '../../services/photos.service';

interface PhotoFilterPanelProps {
  filters: FeedbackFilters;
  onChange: (filters: FeedbackFilters) => void;
  summary: FilterSummary | null;
  isLoading?: boolean;
}

const RATING_OPTIONS = [
  { value: null, label: 'filter.allPhotos' },
  { value: 0.1, label: 'filter.anyRating' },
  { value: 1, label: 'filter.oneStarPlus' },
  { value: 2, label: 'filter.twoStarsPlus' },
  { value: 3, label: 'filter.threeStarsPlus' },
  { value: 4, label: 'filter.fourStarsPlus' },
  { value: 5, label: 'filter.fiveStarsOnly' },
] as const;

export const PhotoFilterPanel: React.FC<PhotoFilterPanelProps> = ({
  filters,
  onChange,
  summary,
  isLoading = false
}) => {
  const { t } = useTranslation();

  const handleRatingChange = (value: number | null) => {
    onChange({ ...filters, minRating: value });
  };

  const handleCheckboxChange = (field: 'hasLikes' | 'hasFavorites' | 'hasComments') => {
    onChange({ ...filters, [field]: !filters[field] });
  };

  // Colour labels are multi-select (#1044): each swatch toggles its colour,
  // an empty list means no colour filtering.
  const toggleColorLabel = (color: ColorLabel) => {
    const active = filters.colorLabels || [];
    onChange({
      ...filters,
      colorLabels: active.includes(color)
        ? active.filter(c => c !== color)
        : [...active, color],
    });
  };

  // The same row against the admin's own marks (#1044 follow-up), kept as a
  // separate filter rather than merged with the client's — "the client's
  // greens" and "my greens" are different questions during a cull.
  const toggleMyColorLabel = (color: ColorLabel) => {
    const active = filters.myColorLabels || [];
    onChange({
      ...filters,
      myColorLabels: active.includes(color)
        ? active.filter(c => c !== color)
        : [...active, color],
    });
  };

  const handleLogicChange = (logic: 'AND' | 'OR') => {
    onChange({ ...filters, logic });
  };

  const clearFilters = () => {
    onChange({
      minRating: null,
      hasLikes: false,
      hasFavorites: false,
      hasComments: false,
      colorLabels: [],
      myColorLabels: [],
      logic: 'AND'
    });
  };

  const hasActiveFilters = filters.minRating !== null ||
    filters.hasLikes ||
    filters.hasFavorites ||
    filters.hasComments ||
    (filters.colorLabels?.length || 0) > 0 ||
    (filters.myColorLabels?.length || 0) > 0;

  return (
    <div className="bg-white dark:bg-neutral-800 rounded-lg border border-neutral-200 dark:border-neutral-700 p-4 mb-4">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-medium text-neutral-900 dark:text-neutral-100 flex items-center gap-2">
          <Filter className="w-4 h-4" />
          {t('filter.feedbackFilters', 'Feedback Filters')}
        </h3>
        {hasActiveFilters && (
          <Button
            variant="ghost"
            size="sm"
            onClick={clearFilters}
            leftIcon={<X className="w-3 h-3" />}
          >
            {t('filter.clear', 'Clear')}
          </Button>
        )}
      </div>

      <div className="space-y-4">
        {/* Rating Filter */}
        <div>
          <label className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
            <Star className="w-4 h-4 inline mr-1" />
            {t('filter.rating', 'Rating')}
          </label>
          <select
            value={filters.minRating ?? ''}
            onChange={(e) => handleRatingChange(e.target.value === '' ? null : parseFloat(e.target.value))}
            className="w-full px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
            disabled={isLoading}
          >
            {RATING_OPTIONS.map(option => (
              <option key={option.label} value={option.value ?? ''}>
                {t(option.label, { defaultValue: option.label.split('.').pop() })}
              </option>
            ))}
          </select>
        </div>

        {/* Checkbox Filters */}
        <div className="flex flex-wrap gap-4">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={filters.hasLikes || false}
              onChange={() => handleCheckboxChange('hasLikes')}
              className="rounded border-neutral-300 text-accent focus:ring-primary-500"
              disabled={isLoading}
            />
            <Heart className="w-4 h-4 text-red-500" />
            <span className="text-sm text-neutral-700 dark:text-neutral-300">
              {t('filter.hasLikes', 'Has likes')}
              {summary && (
                <span className="text-neutral-500 dark:text-neutral-400 ml-1">({summary.withLikes})</span>
              )}
            </span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={filters.hasFavorites || false}
              onChange={() => handleCheckboxChange('hasFavorites')}
              className="rounded border-neutral-300 text-accent focus:ring-primary-500"
              disabled={isLoading}
            />
            <Bookmark className="w-4 h-4 text-yellow-500" />
            <span className="text-sm text-neutral-700 dark:text-neutral-300">
              {t('filter.hasFavorites', 'Has favorites')}
              {summary && (
                <span className="text-neutral-500 dark:text-neutral-400 ml-1">({summary.withFavorites})</span>
              )}
            </span>
          </label>

          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="checkbox"
              checked={filters.hasComments || false}
              onChange={() => handleCheckboxChange('hasComments')}
              className="rounded border-neutral-300 text-accent focus:ring-primary-500"
              disabled={isLoading}
            />
            <MessageCircle className="w-4 h-4 text-blue-500" />
            <span className="text-sm text-neutral-700 dark:text-neutral-300">
              {t('filter.hasComments', 'Has comments')}
              {summary && (
                <span className="text-neutral-500 dark:text-neutral-400 ml-1">({summary.withComments})</span>
              )}
            </span>
          </label>
        </div>

        {/* Color labels (#1044). Rendered only when someone has actually
            labelled something — an always-visible swatch row would be dead
            UI in the many galleries that never turn the feature on. */}
        {(summary?.withColorLabels || 0) > 0 && (
          <div>
            <span className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
              {t('filter.colorLabels', 'Color labels')}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {COLOR_LABELS.map((color) => {
                const count = summary?.colorLabelCounts?.[color] || 0;
                const isActive = (filters.colorLabels || []).includes(color);
                const swatch = COLOR_LABEL_SWATCHES[color];
                const name = t(`feedback.colorLabels.${color}`, color);
                return (
                  <button
                    key={color}
                    type="button"
                    onClick={() => toggleColorLabel(color)}
                    disabled={isLoading}
                    aria-pressed={isActive}
                    aria-label={t('filter.showOnlyColor', 'Show only {{color}}', { color: name })}
                    className={`flex items-center gap-2 px-2.5 py-1 rounded-full border text-sm transition-colors ${
                      isActive
                        ? 'border-accent-dark bg-accent-dark/10 text-neutral-900 dark:text-neutral-100'
                        : 'border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
                    }`}
                  >
                    <span
                      className="w-3.5 h-3.5 rounded-full border shrink-0"
                      style={{ backgroundColor: swatch.fill, borderColor: swatch.ring }}
                      aria-hidden="true"
                    />
                    <span>{name}</span>
                    <span className="text-neutral-500 dark:text-neutral-400">({count})</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* The admin's own marks (#1044 follow-up). Same shape as the row
            above, labelled so the two are never confused. */}
        {Object.keys(summary?.myColorLabelCounts || {}).length > 0 && (
          <div>
            <span className="block text-sm font-medium text-neutral-700 dark:text-neutral-300 mb-2">
              {t('filter.myColorLabels', 'Your marks')}
            </span>
            <div className="flex flex-wrap items-center gap-2">
              {COLOR_LABELS.map((color) => {
                const count = summary?.myColorLabelCounts?.[color] || 0;
                if (count === 0 && !(filters.myColorLabels || []).includes(color)) return null;
                const isActive = (filters.myColorLabels || []).includes(color);
                const swatch = COLOR_LABEL_SWATCHES[color];
                const name = t(`feedback.colorLabels.${color}`, color);
                return (
                  <button
                    key={color}
                    type="button"
                    onClick={() => toggleMyColorLabel(color)}
                    disabled={isLoading}
                    aria-pressed={isActive}
                    aria-label={t('filter.showOnlyMyColor', 'Show only my {{color}} marks', { color: name })}
                    className={`flex items-center gap-2 px-2.5 py-1 rounded-full border text-sm transition-colors ${
                      isActive
                        ? 'border-accent-dark bg-accent-dark/10 text-neutral-900 dark:text-neutral-100'
                        : 'border-neutral-200 dark:border-neutral-700 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
                    }`}
                  >
                    <span
                      className="w-3.5 h-3.5 rounded-full border-2 border-dashed shrink-0"
                      style={{ backgroundColor: swatch.fill, borderColor: swatch.ring }}
                      aria-hidden="true"
                    />
                    <span>{name}</span>
                    <span className="text-neutral-500 dark:text-neutral-400">({count})</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Logic Toggle */}
        {(filters.hasLikes || filters.hasFavorites || filters.hasComments) && (
          <div className="flex items-center gap-2">
            <span className="text-sm text-neutral-600 dark:text-neutral-400">{t('filter.combineWith', 'Combine with')}:</span>
            <div className="flex rounded-lg border border-neutral-200 dark:border-neutral-700 overflow-hidden">
              <button
                type="button"
                onClick={() => handleLogicChange('AND')}
                className={`px-3 py-1 text-sm font-medium transition-colors ${
                  filters.logic === 'AND' || !filters.logic
                    ? 'bg-accent-dark text-white'
                    : 'bg-white dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
                }`}
                disabled={isLoading}
              >
                AND
              </button>
              <button
                type="button"
                onClick={() => handleLogicChange('OR')}
                className={`px-3 py-1 text-sm font-medium transition-colors ${
                  filters.logic === 'OR'
                    ? 'bg-accent-dark text-white'
                    : 'bg-white dark:bg-neutral-800 text-neutral-600 dark:text-neutral-400 hover:bg-neutral-50 dark:hover:bg-neutral-700'
                }`}
                disabled={isLoading}
              >
                OR
              </button>
            </div>
          </div>
        )}

        {/* Summary */}
        {summary && (
          <div className="pt-2 border-t border-neutral-100 dark:border-neutral-700 text-sm text-neutral-600 dark:text-neutral-400">
            {t('filter.showingPhotos', 'Total photos')}: {summary.total}
            {summary.withRatings > 0 && (
              <span className="ml-2">
                | {t('filter.withRatings', 'With ratings')}: {summary.withRatings}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

export default PhotoFilterPanel;
