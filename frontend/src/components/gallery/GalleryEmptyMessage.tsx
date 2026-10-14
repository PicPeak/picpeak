import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '../common';

/**
 * The line under an empty photo grid. A search or filter that leaves nothing
 * on screen says so, so the guest knows to clear it; only a scope with no
 * photos at all says the gallery is empty.
 */
export const GalleryEmptyMessage: React.FC<{ filtered?: boolean }> = ({ filtered = false }) => {
  const { t } = useTranslation();
  return (
    <p className="text-muted-theme">
      {filtered
        ? t('gallery.noPhotosMatch', 'No photos match your search or filters.')
        : t('gallery.noPhotosYet', 'There are no photos here yet.')}
    </p>
  );
};

/**
 * Premium / Story with the nav heart on and nothing liked in this scope. Those
 * layouts render no nav on an empty list, so the way back to every photo has
 * to be here.
 */
export const LikedOnlyEmptyMessage: React.FC<{ onShowAll?: () => void }> = ({ onShowAll }) => {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center gap-4">
      <p className="text-muted-theme">
        {t('gallery.likedOnlyEmpty', 'You have not liked any photos here yet. Tap the heart on a photo to find it here.')}
      </p>
      {onShowAll && (
        // Premium and Story remount between this view and their photos; the
        // nav heart (same role) takes focus back on the way out.
        <Button variant="outline" size="sm" onClick={onShowAll} data-gallery-focus="liked">
          {t('gallery.showAllPhotos', 'Show all photos')}
        </Button>
      )}
    </div>
  );
};
