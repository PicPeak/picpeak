import React from 'react';
import { Grid } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '../common';

interface PhotoCategory {
  id: number | string;
  name: string;
  slug: string;
  is_global?: boolean;
}

interface GalleryCategoryChipsProps {
  categories: PhotoCategory[];
  // Scoped, so a chip can't advertise a count the grid won't produce.
  photos: Array<{ category_id?: number | string | null }>;
  selectedCategoryId: number | string | null;
  onCategoryChange: (categoryId: number | string | null) => void;
  /** "All media" instead of "All photos" once videos are in the gallery. */
  hasVideos?: boolean;
  className?: string;
}

/**
 * The category chips under the gallery toolbar, in a horizontal scroll row.
 * They stay on the page rather than in the filter panel: a category is how a
 * guest finds "the ceremony", and a filter panel hides it behind a button.
 */
export const GalleryCategoryChips: React.FC<GalleryCategoryChipsProps> = ({
  categories,
  photos,
  selectedCategoryId,
  onCategoryChange,
  hasVideos = false,
  className = '',
}) => {
  const { t } = useTranslation();
  if (categories.length === 0) return null;
  return (
    <div className={`w-full overflow-x-auto pb-2 lg:pb-0 ${className}`}>
      <div className="flex items-center gap-2 min-w-max">
        <Button
          variant={selectedCategoryId === null ? 'primary' : 'outline'}
          size="sm"
          onClick={() => onCategoryChange(null)}
          leftIcon={<Grid className="w-3 h-3 md:w-4 md:h-4" />}
          className="text-xs md:text-sm whitespace-nowrap flex-shrink-0"
        >
          {hasVideos ? t('gallery.allMedia', 'All media') : t('gallery.allPhotos')} ({photos.length})
        </Button>
        {categories.map((category) => {
          const categoryPhotoCount = photos.filter((p) => p.category_id === category.id).length;
          if (categoryPhotoCount === 0) return null;
          return (
            <Button
              key={category.id}
              variant={selectedCategoryId === category.id ? 'primary' : 'outline'}
              size="sm"
              onClick={() => onCategoryChange(category.id)}
              className="text-xs md:text-sm whitespace-nowrap flex-shrink-0"
            >
              {category.name} ({categoryPhotoCount})
            </Button>
          );
        })}
      </div>
    </div>
  );
};
