import React from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { Photo } from '../../types';

/** Whether a client has hidden this photo from regular guests (#172). */
export const isHiddenFromGuests = (photo: Pick<Photo, 'visibility'>): boolean =>
  photo.visibility === 'hidden';

interface ClientVisibilityToggleProps {
  photo: Pick<Photo, 'id' | 'visibility'>;
  onToggle: (photoId: number, currentVisibility: string) => void;
  /** Positioning inside the tile. Defaults to Grid's top-left corner. */
  className?: string;
}

/**
 * The client's per-photo hide/show button (#172), shared by every gallery
 * layout (issue 1992: it used to exist in Grid only). The click stops here,
 * so it never opens the lightbox or toggles the tile underneath.
 */
export const ClientVisibilityToggle: React.FC<ClientVisibilityToggleProps> = ({
  photo,
  onToggle,
  className = 'absolute top-2 left-2 z-10',
}) => {
  const { t } = useTranslation();
  const isHidden = isHiddenFromGuests(photo);
  const label = isHidden
    ? t('clientAccess.hiddenFromGuests', 'Hidden from guests')
    : t('clientAccess.visibleToGuests', 'Visible to guests');

  return (
    <button
      type="button"
      onClick={(e) => {
        // preventDefault too: the Story card sits next to a link.
        e.preventDefault();
        e.stopPropagation();
        onToggle(photo.id, photo.visibility || 'visible');
      }}
      className={`${className} p-1.5 rounded-full shadow-md transition-colors ${
        isHidden
          ? 'bg-danger text-white hover:opacity-90'
          // On the photo: a fixed white chip, whatever the theme.
          : 'bg-white/90 text-neutral-700 hover:bg-white'
      }`}
      title={label}
      aria-label={label}
      aria-pressed={isHidden}
      data-testid={`client-visibility-toggle-${photo.id}`}
    >
      {isHidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
    </button>
  );
};
