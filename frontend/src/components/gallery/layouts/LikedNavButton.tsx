import React from 'react';
import { Heart } from 'lucide-react';
import { useTranslation } from 'react-i18next';

interface LikedNavButtonProps {
  /** The layout's own nav button class, with `activeClassName` while the filter is on. */
  className: string;
  activeClassName: string;
  countClassName: string;
  iconClassName: string;
  /** The hover text: "Favorites" where a like is the favourite, the filter's own name elsewhere. */
  title: string;
  testId: string;
  likedOnly: boolean;
  /** The container's filter toggle; absent, the heart is not a filter control. */
  onToggleLikedOnly?: () => void;
  /** How many photos this viewer has liked. */
  likedCount: number;
}

/**
 * The nav heart of the full-page layouts: the gallery's "Liked" filter (only
 * the photos this viewer liked, until clicked again) with the viewer's count.
 */
export const LikedNavButton: React.FC<LikedNavButtonProps> = ({
  className,
  activeClassName,
  countClassName,
  iconClassName,
  title,
  testId,
  likedOnly,
  onToggleLikedOnly,
  likedCount,
}) => {
  const { t } = useTranslation();
  return (
    <button
      type="button"
      className={`${className}${likedOnly ? ` ${activeClassName}` : ''}`}
      onClick={onToggleLikedOnly}
      aria-pressed={onToggleLikedOnly ? likedOnly : undefined}
      aria-label={`${t('gallery.showLikedOnly', 'Show only photos I liked')}${likedCount > 0 ? ` (${likedCount})` : ''}`}
      title={title}
      data-testid={testId}
      // Focus moves to "Show all photos" when the filter empties the view.
      data-gallery-focus="liked"
    >
      <Heart className={iconClassName} fill={likedOnly ? 'currentColor' : 'none'} />
      {likedCount > 0 && (
        <span className={countClassName}>{likedCount > 9 ? '9+' : likedCount}</span>
      )}
    </button>
  );
};
