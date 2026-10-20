import React from 'react';
import { Bookmark, CheckSquare, Grid, Heart, MessageSquare, Search, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button, Input } from '../common';
import type { Photo } from '../../types';
import type { ColorLabel } from '../../services/feedback.service';
import type { FilterType, FeedbackFilterType } from './GalleryFilter';
import { ColorLabelFilterChips } from './ColorLabelFilterChips';
import { MinRatingFilterChips } from './MinRatingFilterChips';
import { CreditFilterChips } from './CreditFilterChips';
import { TagFilterChips, type TagChip } from './TagFilterChips';

export type GalleryMediaFilter = 'all' | 'photo' | 'video';

export interface GalleryFilterPanelProps {
  /** Only while selecting: the toolbar's search box is gone then. */
  search?: { value: string; onChange: (term: string) => void };
  // Each group renders only when its slice is passed, so the container decides
  // what the gallery offers (feedback on, ratings on, videos present, ...).
  feedback?: { activeFilters: FeedbackFilterType[]; onFilterChange: (filter: FilterType) => void };
  colorLabels?: { activeColors: ColorLabel[]; onToggle: (color: ColorLabel) => void; counts: Partial<Record<ColorLabel, number>> };
  minRating?: { value: number | null; onChange: (minRating: number | null) => void; counts: Partial<Record<number, number>> };
  media?: { value: GalleryMediaFilter; onChange: (filter: GalleryMediaFilter) => void };
  credits?: { photos: Photo[]; selectedKey: string | null; onChange: (key: string | null) => void };
  tags?: { tags: TagChip[]; selectedKeys: string[]; onToggle: (key: string) => void };
  /** What the filters (and search, category, people) leave on screen. */
  matchCount: number;
  hasVideos?: boolean;
  /** Any panel filter is set: offers "Clear filters". */
  filtersActive?: boolean;
  onClearFilters?: () => void;
  /** "Select these N photos". Absent where the gallery offers no selection. */
  onSelectMatches?: () => void;
}

/**
 * The gallery's filters in one place, ending in the step they lead to (issue
 * 1733, E7): narrow the gallery down, then "Select these N photos", after
 * which the toolbar shows the batch actions for exactly that set.
 *
 * Content only; the toolbar puts it in a popover, a phone in a bottom sheet.
 */
export const GalleryFilterPanel: React.FC<GalleryFilterPanelProps> = ({
  search,
  feedback,
  colorLabels,
  minRating,
  media,
  credits,
  tags,
  matchCount,
  hasVideos = false,
  filtersActive = false,
  onClearFilters,
  onSelectMatches,
}) => {
  const { t } = useTranslation();

  const feedbackChips: Array<{ value: FilterType; label: string; icon: React.ReactNode }> = [
    { value: 'all', label: t('gallery.all', 'All'), icon: <Grid className="w-3.5 h-3.5" /> },
    { value: 'liked', label: t('feedback.likes', 'Likes'), icon: <Heart className="w-3.5 h-3.5" /> },
    { value: 'favorited', label: t('gallery.favorited', 'Saved'), icon: <Bookmark className="w-3.5 h-3.5" /> },
    { value: 'rated', label: t('gallery.rated', 'Rated'), icon: <Star className="w-3.5 h-3.5" /> },
    { value: 'commented', label: t('gallery.commented', 'Commented'), icon: <MessageSquare className="w-3.5 h-3.5" /> },
  ];
  const isFeedbackActive = (filter: FilterType) => !!feedback && (filter === 'all'
    ? feedback.activeFilters.length === 0
    : feedback.activeFilters.includes(filter as FeedbackFilterType));

  const mediaChips: Array<{ value: GalleryMediaFilter; label: string }> = [
    { value: 'all', label: t('gallery.allMedia', 'All') },
    { value: 'photo', label: t('gallery.photosOnly', 'Photos') },
    { value: 'video', label: t('gallery.videosOnly', 'Videos') },
  ];

  const selectMatchesLabel = hasVideos
    ? t('gallery.filterPanel.selectMatchesMedia', { count: matchCount })
    : t('gallery.filterPanel.selectMatches', { count: matchCount });

  return (
    <div className="flex flex-col gap-4">
      {search && (
        <Input
          themed
          type="text"
          placeholder={t('gallery.searchPhotos')}
          aria-label={t('gallery.searchPhotos')}
          leftIcon={<Search className="w-5 h-5 text-muted-theme" />}
          value={search.value}
          onChange={(e) => search.onChange(e.target.value)}
          className="text-sm"
        />
      )}

      {feedback && (
        <div className="flex flex-col gap-2">
          <span className="text-sm text-muted-theme">{t('gallery.feedbackFilter', 'Feedback Filter')}</span>
          <div className="flex items-center gap-1.5 flex-wrap">
            {feedbackChips.map((chip) => (
              <Button
                key={chip.value}
                variant={isFeedbackActive(chip.value) ? 'primary' : 'outline'}
                size="sm"
                onClick={() => feedback.onFilterChange(chip.value)}
                aria-pressed={isFeedbackActive(chip.value)}
                leftIcon={chip.icon}
                className="text-xs md:text-sm"
              >
                {chip.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* Colour filter (#1044) */}
      {colorLabels && (
        <ColorLabelFilterChips
          className="flex-wrap"
          activeColors={colorLabels.activeColors}
          onToggle={colorLabels.onToggle}
          counts={colorLabels.counts}
        />
      )}

      {/* Own-rating filter (issue 1733, A3c) */}
      {minRating && (
        <MinRatingFilterChips
          className="flex-wrap"
          minRating={minRating.value}
          onChange={minRating.onChange}
          counts={minRating.counts}
        />
      )}

      {media && (
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-sm text-muted-theme whitespace-nowrap">{t('gallery.mediaType', 'Media')}</span>
          <div className="flex items-center gap-2">
            {mediaChips.map((chip) => (
              <Button
                key={chip.value}
                variant={media.value === chip.value ? 'primary' : 'outline'}
                size="sm"
                onClick={() => media.onChange(chip.value)}
                aria-pressed={media.value === chip.value}
                className="text-xs md:text-sm"
              >
                {chip.label}
              </Button>
            ))}
          </div>
        </div>
      )}

      {/* "By" filter (#1561) */}
      {credits && (
        <CreditFilterChips photos={credits.photos} selectedKey={credits.selectedKey} onChange={credits.onChange} />
      )}

      {/* Scene tags (issue 1733) */}
      {tags && (
        <TagFilterChips tags={tags.tags} selectedKeys={tags.selectedKeys} onToggle={tags.onToggle} />
      )}

      {(onSelectMatches || (filtersActive && onClearFilters)) && (
        <div className="flex items-center justify-between gap-3 flex-wrap pt-3 border-t border-border-token">
          {filtersActive && onClearFilters ? (
            <Button variant="ghost" size="sm" onClick={onClearFilters} className="text-xs md:text-sm">
              {t('gallery.filterPanel.clear', 'Clear filters')}
            </Button>
          ) : <span />}
          {onSelectMatches && (
            <Button
              variant="primary"
              size="sm"
              leftIcon={<CheckSquare className="w-4 h-4" />}
              onClick={onSelectMatches}
              disabled={matchCount === 0}
              className="text-xs md:text-sm"
            >
              {selectMatchesLabel}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};
