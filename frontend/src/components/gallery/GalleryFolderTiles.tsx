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
import { folderKey, type FolderTile } from './folders';

interface GalleryFolderTilesProps {
  tiles: FolderTile[];
  onOpen: (slug: string) => void;
  /** Gallery slug — the cover is an authenticated image like any other photo. */
  slug?: string;
  /**
   * Image-protection settings (#1160). A folder cover is a real gallery photo,
   * so a gallery configured for canvas rendering or maximum protection must not
   * get an ordinary blob-backed <img> here just because it is a cover.
   */
  protectionLevel?: 'basic' | 'standard' | 'enhanced' | 'maximum';
  useEnhancedProtection?: boolean;
  useCanvasRendering?: boolean;
  allowDownloads?: boolean;
  /**
   * Compact chip row instead of cover cards. Used by the full-bleed layouts
   * (Premium, Story), where a block of cards above the hero would break the
   * edge-to-edge opening those layouts exist for — but where the folders still
   * have to be reachable, since containment applies there too.
   */
  compact?: boolean;
}

export const GalleryFolderTiles: React.FC<GalleryFolderTilesProps> = ({
  tiles,
  onOpen,
  compact = false,
  slug,
  protectionLevel,
  useEnhancedProtection,
  useCanvasRendering,
  allowDownloads = true,
}) => {
  const { t } = useTranslation();

  if (tiles.length === 0) return null;

  if (compact) {
    return (
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-sm text-muted-theme">{t('gallery.folders', 'Folders')}</span>
        {tiles.map(({ category, count }) => (
          <button
            key={category.id}
            type="button"
            onClick={() => onOpen(folderKey(category))}
            aria-label={t('gallery.openFolder', 'Open folder {{name}}', { name: category.name })}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-surface bg-surface text-sm hover:shadow-sm transition-shadow focus:outline-none focus:ring-2 focus:ring-primary-500"
            style={{ color: 'var(--color-text)' }}
          >
            <Folder className="w-3.5 h-3.5 text-muted-theme" />
            <span className="font-medium">{category.name}</span>
            <span className="text-muted-theme">{count}</span>
          </button>
        ))}
      </div>
    );
  }

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
            onClick={() => onOpen(folderKey(category))}
            aria-label={t('gallery.openFolder', 'Open folder {{name}}', { name: category.name })}
            className="group text-left rounded-lg overflow-hidden border border-surface bg-surface hover:shadow-md transition-all focus:outline-none focus:ring-2 focus:ring-primary-500"
          >
            <div className="aspect-[4/3] relative" style={{ backgroundColor: 'var(--color-background)' }}>
              {coverPhoto?.thumbnail_url ? (
                <AuthenticatedImage
                  src={coverPhoto.thumbnail_url}
                  alt=""
                  className="w-full h-full object-cover group-hover:scale-[1.02] transition-transform"
                  isGallery
                  slug={slug}
                  photoId={coverPhoto.id}
                  requiresToken={coverPhoto.requires_token}
                  secureUrlTemplate={coverPhoto.secure_url_template}
                  protectFromDownload={!allowDownloads || useEnhancedProtection}
                  protectionLevel={protectionLevel}
                  useEnhancedProtection={useEnhancedProtection}
                  useCanvasRendering={useCanvasRendering}
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
