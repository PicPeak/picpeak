import React from 'react';
import { useTranslation } from 'react-i18next';

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
