import React from 'react';
import { Star, Heart, Bookmark, MessageCircle, Filter, X } from 'lucide-react';
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

  const handleLogicChange = (logic: 'AND' | 'OR') => {
    onChange({ ...filters, logic });
  };

  const clearFilters = () => {
    onChange({
      minRating: null,
      hasLikes: false,
      hasFavorites: false,
      hasComments: false,
      logic: 'AND'
    });
  };

  const hasActiveFilters = filters.minRating !== null ||
    filters.hasLikes ||
    filters.hasFavorites ||
    filters.hasComments;

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
