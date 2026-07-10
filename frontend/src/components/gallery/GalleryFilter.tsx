import React from 'react';
import { Heart, Star, MessageSquare, Bookmark } from 'lucide-react';
import { Button } from '../common';
import { useTranslation } from 'react-i18next';

export type FilterType = 'all' | 'liked' | 'favorited' | 'rated' | 'commented';

interface GalleryFilterProps {
  currentFilter: FilterType;
  onFilterChange: (filter: FilterType) => void;
  feedbackEnabled: boolean;
  likeCount?: number;
  favoriteCount?: number;
  ratedCount?: number;
  className?: string;
  isMobile?: boolean;
  variant?: 'default' | 'compact';
}

export const GalleryFilter: React.FC<GalleryFilterProps> = ({
  currentFilter,
  onFilterChange,
  feedbackEnabled,
  likeCount = 0,
  favoriteCount = 0,
  ratedCount = 0,
  className = '',
  isMobile = false,
  variant = 'default'
}) => {
  const { t } = useTranslation();

  if (!feedbackEnabled) {
    return null;
  }

  // Compact icon-only vertical variant (used in sidebar and tight spaces)
  if (variant === 'compact') {
    return (
      <div className={`${className}`}>
        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-theme whitespace-nowrap">
            {t('gallery.feedbackFilter', 'Feedback Filter')}
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant={currentFilter === 'all' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => onFilterChange('all')}
              className="p-1 w-8 h-8 flex items-center justify-center"
              aria-label={t('gallery.all', 'All')}
            >
              <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 text-current"><path d="M3 3h8v8H3V3zm10 0h8v8h-8V3zM3 13h8v8H3v-8zm10 8v-8h8v8h-8z"/></svg>
            </Button>
            <Button
              variant={currentFilter === 'liked' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => onFilterChange('liked')}
              className="p-1 w-8 h-8 flex items-center justify-center"
              aria-label={t('feedback.likes', 'Likes')}
            >
              <Heart className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant={currentFilter === 'favorited' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => onFilterChange('favorited')}
              className="p-1 w-8 h-8 flex items-center justify-center"
              aria-label={t('gallery.favorited', 'Saved')}
            >
              <Bookmark className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant={currentFilter === 'rated' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => onFilterChange('rated')}
              className="p-1 w-8 h-8 flex items-center justify-center"
              aria-label={t('gallery.rated', 'Rated')}
            >
              <Star className="w-3.5 h-3.5" />
            </Button>
            <Button
              variant={currentFilter === 'commented' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => onFilterChange('commented')}
              className="p-1 w-8 h-8 flex items-center justify-center"
              aria-label={t('gallery.commented', 'Commented')}
            >
              <MessageSquare className="w-3.5 h-3.5" />
            </Button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={`${className}`}>
      {/* Mobile-optimized vertical layout */}
      {isMobile ? (
        <div className="space-y-2">
          <div className="text-xs text-muted-theme font-medium">
            {t('gallery.feedbackFilter', 'Feedback Filter')}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button
              variant={currentFilter === 'all' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => onFilterChange('all')}
              className="text-xs flex-1 min-w-[80px]"
            >
              {t('gallery.all', 'All')}
            </Button>
            
            <Button
              variant={currentFilter === 'liked' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => onFilterChange('liked')}
              className="text-xs flex-1 min-w-[80px] flex items-center justify-center gap-1"
            >
              <Heart className="w-3 h-3" />
              <span>{likeCount > 0 ? likeCount : t('gallery.liked', 'Liked')}</span>
            </Button>

            <Button
              variant={currentFilter === 'favorited' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => onFilterChange('favorited')}
              className="text-xs flex-1 min-w-[80px] flex items-center justify-center gap-1"
            >
              <Bookmark className="w-3 h-3" />
              <span>{favoriteCount > 0 ? favoriteCount : t('gallery.favorited', 'Saved')}</span>
            </Button>
            
            <Button
              variant={currentFilter === 'rated' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => onFilterChange('rated')}
              className="text-xs flex-1 min-w-[80px] flex items-center justify-center gap-1"
            >
              <Star className="w-3 h-3" />
              <span>{ratedCount > 0 ? ratedCount : t('gallery.rated', 'Rated')}</span>
            </Button>
          </div>
        </div>
      ) : (
        /* Desktop layout - inline with categories */
        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-theme font-medium whitespace-nowrap">
            {t('gallery.feedbackFilter', 'Feedback Filter')}:
          </span>
          <div className="flex gap-2">
            <Button
              variant={currentFilter === 'all' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => onFilterChange('all')}
              className="text-xs sm:text-sm"
            >
              {t('gallery.all', 'All')}
            </Button>
            
            <Button
              variant={currentFilter === 'liked' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => onFilterChange('liked')}
              className="text-xs sm:text-sm flex items-center gap-1"
            >
              <Heart className="w-3 h-3 sm:w-4 sm:h-4" />
              <span className="hidden sm:inline">{t('gallery.liked', 'Liked')}</span>
              {likeCount > 0 && (
                <span className="bg-accent-dark/15 text-accent-dark px-1.5 rounded">
                  {likeCount}
                </span>
              )}
            </Button>

            <Button
              variant={currentFilter === 'favorited' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => onFilterChange('favorited')}
              className="text-xs sm:text-sm flex items-center gap-1"
            >
              <Bookmark className="w-3 h-3 sm:w-4 sm:h-4" />
              <span className="hidden sm:inline">{t('gallery.favorited', 'Saved')}</span>
              {favoriteCount > 0 && (
                <span className="bg-accent-dark/15 text-accent-dark px-1.5 rounded">
                  {favoriteCount}
                </span>
              )}
            </Button>
            
            <Button
              variant={currentFilter === 'rated' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => onFilterChange('rated')}
              className="text-xs sm:text-sm flex items-center gap-1"
            >
              <Star className="w-3 h-3 sm:w-4 sm:h-4" />
              <span className="hidden sm:inline">{t('gallery.rated', 'Rated')}</span>
              {ratedCount > 0 && (
                <span className="bg-accent-dark/15 text-accent-dark px-1.5 rounded">
                  {ratedCount}
                </span>
              )}
            </Button>

            <Button
              variant={currentFilter === 'commented' ? 'primary' : 'outline'}
              size="sm"
              onClick={() => onFilterChange('commented')}
              className="text-xs sm:text-sm flex items-center gap-1"
            >
              <MessageSquare className="w-3 h-3 sm:w-4 sm:h-4" />
              <span className="hidden sm:inline">{t('gallery.commented', 'Commented')}</span>
            </Button>
          </div>
        </div>
      )}
    </div>
  );
};
