import React from 'react';
import { Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Minimum own-rating thresholds offered as chips: "1+" … "4+" and "5". */
const MIN_RATING_THRESHOLDS = [1, 2, 3, 4, 5] as const;

interface MinRatingFilterChipsProps {
  /** The active threshold; null = no rating filter. */
  minRating: number | null;
  onChange: (minRating: number | null) => void;
  /** Per-threshold counts of photos the viewer rated at or above it. */
  counts?: Partial<Record<number, number>>;
  /** Hide thresholds nothing reaches. On by default, like the colour chips:
   *  a "5" chip that can only ever empty the grid is noise. */
  hideEmpty?: boolean;
  className?: string;
  showLabel?: boolean;
}

/**
 * "Show only what I rated 3 stars or more" (issue 1733, A3c). Single-select:
 * a chip sets the threshold, clicking the active chip clears it. Filters on
 * `photo.my_rating`, the viewer's own stars, so it is guest-scoped by
 * construction like the colour chips.
 */
export const MinRatingFilterChips: React.FC<MinRatingFilterChipsProps> = ({
  minRating,
  onChange,
  counts = {},
  hideEmpty = true,
  className = '',
  showLabel = true,
}) => {
  const { t } = useTranslation();

  const visible = MIN_RATING_THRESHOLDS.filter(min =>
    !hideEmpty || (counts[min] || 0) > 0 || minRating === min
  );
  if (visible.length === 0) return null;

  return (
    <div className={`flex items-center gap-2 ${className}`}>
      {showLabel && (
        <span className="text-sm text-muted-theme whitespace-nowrap">
          {t('gallery.minRatingFilter', 'My rating')}
        </span>
      )}
      <div className="flex items-center gap-1 flex-wrap">
        {visible.map((min) => {
          const isActive = minRating === min;
          const count = counts[min] || 0;
          return (
            <button
              key={min}
              type="button"
              onClick={() => onChange(isActive ? null : min)}
              aria-pressed={isActive}
              aria-label={t('gallery.filterByMinRating', 'My rating: {{min}} stars or more', { min })}
              title={`${t('gallery.filterByMinRating', 'My rating: {{min}} stars or more', { min })}${count > 0 ? ` (${count})` : ''}`}
              className={`flex items-center gap-1 pl-1.5 pr-2 h-8 rounded-full border text-xs transition-all ${
                isActive
                  ? 'border-current ring-2 ring-offset-1 ring-current text-yellow-500'
                  : 'border-black/15 text-muted-theme hover:border-current'
              }`}
            >
              <Star className={`w-3.5 h-3.5 shrink-0 ${isActive ? 'fill-yellow-500' : ''}`} aria-hidden="true" />
              <span className="font-medium">{min}{min < 5 ? '+' : ''}</span>
              {/* Bracketed like the category chips: "3+ 1" reads as one number. */}
              {count > 0 && <span>({count})</span>}
            </button>
          );
        })}
      </div>
    </div>
  );
};
