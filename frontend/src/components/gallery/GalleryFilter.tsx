import React from 'react';
import { Heart, Star, MessageSquare, Bookmark } from 'lucide-react';
import { Button } from '../common';
import { useTranslation } from 'react-i18next';
import { FavoriteListSwitcher } from './FavoriteListSwitcher';

export type FilterType = 'all' | 'liked' | 'favorited' | 'rated' | 'commented';
// Multi-select feedback filters (#889): the active set holds the concrete
// filters; an empty set means "All".
export type FeedbackFilterType = Exclude<FilterType, 'all'>;

interface GalleryFilterProps {
  activeFilters: FeedbackFilterType[];
  // Clicking a filter toggles it in the parent's set; 'all' clears the set.
  onFilterChange: (filter: FilterType) => void;
  feedbackEnabled: boolean;
  /**
   * The filters this gallery's feedback settings allow (issue 2505): no
   * "Liked" without likes, and so on. Absent: all of them.
   */
  available?: FeedbackFilterType[];
  likeCount?: number;
  favoriteCount?: number;
  ratedCount?: number;
  className?: string;
}

export const GalleryFilter: React.FC<GalleryFilterProps> = ({
  activeFilters,
  onFilterChange,
  feedbackEnabled,
  available,
  className = '',
}) => {
  const { t } = useTranslation();

  const isActive = (filter: FilterType) =>
    filter === 'all' ? activeFilters.length === 0 : activeFilters.includes(filter);

  const shows = (filter: FeedbackFilterType) => !available || available.includes(filter);

  if (!feedbackEnabled || (available && available.length === 0)) {
    return null;
  }

  // Compact icon-only row (the gallery sidebar)
  return (
    <div className={`${className}`}>
      <div className="flex items-center gap-2">
        <span className="text-sm text-muted-theme whitespace-nowrap">
          {t('gallery.feedbackFilter', 'Feedback Filter')}
        </span>
        <div className="flex items-center gap-1">
          <Button
            variant={isActive('all') ? 'primary' : 'outline'}
            size="sm"
            onClick={() => onFilterChange('all')}
            className="p-1 w-8 h-8 flex items-center justify-center"
            aria-label={t('gallery.all', 'All')}
          >
            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-current"><path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 8v-8h8v8h-8z"/></svg>
          </Button>
          {shows('liked') && (
            <Button
              variant={isActive('liked') ? 'primary' : 'outline'}
              size="sm"
              onClick={() => onFilterChange('liked')}
              className="p-1 w-8 h-8 flex items-center justify-center"
              aria-label={t('feedback.likes', 'Likes')}
            >
              <Heart className="w-3.5 h-3.5" />
            </Button>
          )}
          {shows('favorited') && (
            <Button
              variant={isActive('favorited') ? 'primary' : 'outline'}
              size="sm"
              onClick={() => onFilterChange('favorited')}
              className="p-1 w-8 h-8 flex items-center justify-center"
              aria-label={t('gallery.favorited', 'Saved')}
            >
              <Bookmark className="w-3.5 h-3.5" />
            </Button>
          )}
          {shows('rated') && (
            <Button
              variant={isActive('rated') ? 'primary' : 'outline'}
              size="sm"
              onClick={() => onFilterChange('rated')}
              className="p-1 w-8 h-8 flex items-center justify-center"
              aria-label={t('gallery.rated', 'Rated')}
            >
              <Star className="w-3.5 h-3.5" />
            </Button>
          )}
          {shows('commented') && (
            <Button
              variant={isActive('commented') ? 'primary' : 'outline'}
              size="sm"
              onClick={() => onFilterChange('commented')}
              className="p-1 w-8 h-8 flex items-center justify-center"
              aria-label={t('gallery.commented', 'Commented')}
            >
              <MessageSquare className="w-3.5 h-3.5" />
            </Button>
          )}
        </div>
      </div>
      {/* Named lists (issue 2303); absent without them. */}
      <FavoriteListSwitcher className="mt-2" />
    </div>
  );
};
