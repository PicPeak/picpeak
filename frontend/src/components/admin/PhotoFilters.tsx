import React from 'react';
import { Search, Filter, SortAsc, SortDesc } from 'lucide-react';
import { Input } from '../common';
import { useTranslation } from 'react-i18next';

interface PhotoFiltersProps {
  categories: Array<{ id: number | string; name: string; slug: string }>;
  selectedCategory: number | string | null | undefined;
  searchTerm: string;
  sortBy: 'date' | 'name' | 'size' | 'rating';
  sortOrder: 'asc' | 'desc';
  onCategoryChange: (categoryId: number | string | null | undefined) => void;
  onSearchChange: (search: string) => void;
  onSortChange: (sort: 'date' | 'name' | 'size' | 'rating', order: 'asc' | 'desc') => void;
  mediaType?: 'all' | 'photo' | 'video';
  onMediaTypeChange?: (mediaType: 'all' | 'photo' | 'video') => void;
  showMediaFilter?: boolean;
}

export const PhotoFilters: React.FC<PhotoFiltersProps> = ({
  categories,
  selectedCategory,
  searchTerm,
  sortBy,
  sortOrder,
  onCategoryChange,
  onSearchChange,
  onSortChange,
  mediaType = 'all',
  onMediaTypeChange,
  showMediaFilter = false
}) => {
  const { t } = useTranslation();
  const handleSortToggle = () => {
    onSortChange(sortBy, sortOrder === 'asc' ? 'desc' : 'asc');
  };

  return (
    <div className="bg-white dark:bg-neutral-800 border border-neutral-200 dark:border-neutral-700 rounded-lg p-4 mb-6">
      <div className="flex flex-col lg:flex-row gap-4">
        {/* Search */}
        <div className="flex-1">
          <Input
            type="text"
            placeholder={t('gallery.searchByFilename', 'Search by filename...')}
            value={searchTerm}
            onChange={(e) => onSearchChange(e.target.value)}
            leftIcon={<Search className="w-5 h-5 text-neutral-400" />}
          />
        </div>

        {/* Category Filter */}
        <div className="flex items-center gap-2">
          <Filter className="w-5 h-5 text-neutral-400" />
          <select
            value={selectedCategory === null ? '' : selectedCategory || ''}
            onChange={(e) => {
              const raw = e.target.value;
              if (raw === '') return onCategoryChange(null);
              const numeric = Number(raw);
              onCategoryChange(Number.isNaN(numeric) ? raw : numeric);
            }}
            className="px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
          >
            <option value="">{t('gallery.allCategories', 'All Categories')}</option>
            <option value="0">{t('gallery.uncategorized', 'Uncategorized')}</option>
            {categories.map(cat => (
              <option key={cat.id} value={cat.id}>
                {cat.name}
              </option>
            ))}
          </select>
        </div>

        {showMediaFilter && onMediaTypeChange && (
          <div className="flex items-center gap-2">
            <Filter className="w-5 h-5 text-neutral-400" />
            <select
              value={mediaType}
              onChange={(e) => onMediaTypeChange(e.target.value as 'all' | 'photo' | 'video')}
              className="px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
            >
              <option value="all">{t('gallery.allMedia', 'All media')}</option>
              <option value="photo">{t('gallery.photosOnly', 'Photos only')}</option>
              <option value="video">{t('gallery.videosOnly', 'Videos only')}</option>
            </select>
          </div>
        )}

        {/* Sort Options */}
        <div className="flex items-center gap-2">
          <select
            value={sortBy}
            onChange={(e) => onSortChange(e.target.value as 'date' | 'name' | 'size' | 'rating', sortOrder)}
            className="px-3 py-2 border border-neutral-300 dark:border-neutral-600 rounded-lg bg-white dark:bg-neutral-800 text-neutral-900 dark:text-neutral-100 focus:ring-2 focus:ring-primary-500 focus:border-accent-dark"
          >
            <option value="date">{t('gallery.sortByDate', 'Sort by Date')}</option>
            <option value="name">{t('gallery.sortByName', 'Sort by Name')}</option>
            <option value="size">{t('gallery.sortBySize', 'Sort by Size')}</option>
            <option value="rating">{t('gallery.sortByRating', 'Sort by Rating')}</option>
          </select>
          
          <button
            onClick={handleSortToggle}
            className="p-2 border border-neutral-300 dark:border-neutral-600 rounded-lg hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors"
            aria-label={sortOrder === 'asc' ? t('gallery.sortDescending', 'Sort descending') : t('gallery.sortAscending', 'Sort ascending')}
          >
            {sortOrder === 'asc' ? (
              <SortAsc className="w-5 h-5 text-neutral-600 dark:text-neutral-400" />
            ) : (
              <SortDesc className="w-5 h-5 text-neutral-600 dark:text-neutral-400" />
            )}
          </button>
        </div>
      </div>
    </div>
  );
};
