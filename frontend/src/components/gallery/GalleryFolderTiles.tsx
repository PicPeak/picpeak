/**
 * Folder tiles for the gallery root (#1160).
 *
 * Rendered above the photo grid rather than inside any one layout, so all eight
 * gallery layouts (Grid, Masonry, Justified, Mosaic, Timeline, Carousel, Story,
 * Premium) get folders without eight implementations.
 */
import React from 'react';
import { useTranslation } from 'react-i18next';
import { Folder } from 'lucide-react';

import { AuthenticatedImage } from '../common';
import type { FolderTile } from './folders';

interface GalleryFolderTilesProps {
  tiles: FolderTile[];
  onOpen: (slug: string) => void;
}

export const GalleryFolderTiles: React.FC<GalleryFolderTilesProps> = ({ tiles, onOpen }) => {
  const { t } = useTranslation();

  if (tiles.length === 0) return null;

  return (
    <div className="mb-8">
      {/* Theme tokens, not Tailwind `dark:` — the gallery is themed through CSS
          variables per event, so a hardcoded light card renders white on a dark
          gallery (the #1106 class of bug). */}
      <h2 className="text-sm font-medium text-muted-theme mb-3">
        {t('gallery.folders', 'Folders')}
      </h2>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
        {tiles.map(({ category, count, coverPhoto }) => (
          <button
            key={category.id}
            type="button"
            onClick={() => onOpen(category.slug)}
            aria-label={t('gallery.openFolder', 'Open folder {{name}}', { name: category.name })}
            className="group text-left rounded-lg overflow-hidden border border-surface bg-surface hover:shadow-md transition-all focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <div className="aspect-[4/3] relative" style={{ backgroundColor: 'var(--color-background)' }}>
              {coverPhoto?.thumbnail_url ? (
                <AuthenticatedImage
                  src={coverPhoto.thumbnail_url}
                  alt=""
                  className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform"
                />
              ) : (
                <div className="w-full h-full flex items-center justify-center">
                  <Folder className="w-8 h-8 text-muted-theme" />
                </div>
              )}
            </div>
            <div className="p-3">
              <div className="flex items-center gap-2">
                <Folder className="w-4 h-4 text-muted-theme shrink-0" />
                <span className="font-medium truncate" style={{ color: 'var(--color-text)' }}>
                  {category.name}
                </span>
              </div>
              <p className="mt-1 text-sm text-muted-theme">
                {t('gallery.folderPhotoCount', '{{count}} photos', { count })}
              </p>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
};
