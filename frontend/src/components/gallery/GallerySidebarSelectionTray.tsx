import React, { useEffect, useId, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useInView } from 'react-intersection-observer';
import { useTranslation } from 'react-i18next';

import { AuthenticatedImage } from '../common';
import type { Photo } from '../../types';
import { photoDisplayFilename } from '../../utils/photoFilename';

/**
 * The current selection as a list (issue 1733, backlog item A3e): one row per
 * selected photo with its thumbnail, its name and a button that takes just
 * that photo out again. The sidebar used to show only the count.
 *
 * Selection only — favourites are a separate list (backlog item A1).
 */

type TrayPhoto = Pick<Photo, 'id' | 'filename' | 'original_filename' | 'thumbnail_url' | 'url'>;

interface GallerySidebarSelectionTrayProps {
  photos: ReadonlyArray<TrayPhoto>;
  onRemove: (photoId: number) => void;
  /** Called after a keyboard removal emptied the tray, to give focus a home. */
  onEmptied?: () => void;
  slug?: string;
}

const TrayRow: React.FC<{ photo: TrayPhoto; onRemove: (photoId: number, button: HTMLButtonElement) => void; slug?: string }> = ({
  photo,
  onRemove,
  slug,
}) => {
  const { t } = useTranslation();
  // A thumbnail is requested only once its row scrolls into the tray, so a
  // selection of several hundred photos costs a handful of requests.
  const { ref, inView } = useInView({ triggerOnce: true, rootMargin: '100px' });
  const name = photoDisplayFilename(photo);
  return (
    <li ref={ref} className="flex items-center gap-2 h-12">
      <div className="w-10 h-10 shrink-0 rounded overflow-hidden bg-black/10">
        {inView && (
          <AuthenticatedImage
            src={photo.thumbnail_url || photo.url}
            alt=""
            className="w-full h-full object-cover"
            isGallery
            slug={slug}
          />
        )}
      </div>
      <span className="flex-1 min-w-0 truncate text-sm text-theme" title={name}>{name}</span>
      <button
        type="button"
        onClick={(event) => onRemove(photo.id, event.currentTarget)}
        data-tray-remove={photo.id}
        className="shrink-0 p-2 rounded text-muted-theme hover-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        aria-label={t('gallery.selectionTray.remove', 'Remove {{name}} from the selection', { name })}
      >
        <X className="w-4 h-4" />
      </button>
    </li>
  );
};

export const GallerySidebarSelectionTray: React.FC<GallerySidebarSelectionTrayProps> = ({ photos, onRemove, onEmptied, slug }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  // Removing a row unmounts the button that had focus, which would drop focus
  // to <body> and send a keyboard user back to the top of the page. Where to
  // go instead is noted here and applied once the row is gone: the row that
  // moved up into its place, else the one before it, else out of the tray.
  const focusAfterRemove = useRef<{ photoId: number | null } | null>(null);
  const handleRemove = (photoId: number, button: HTMLButtonElement) => {
    // Only when the button really held focus: Safari does not focus a button
    // on click, and a mouse user's focus is not ours to move.
    if (document.activeElement === button) {
      const index = photos.findIndex((photo) => photo.id === photoId);
      const neighbour = photos[index + 1] ?? photos[index - 1];
      focusAfterRemove.current = { photoId: neighbour ? neighbour.id : null };
    }
    onRemove(photoId);
  };
  useEffect(() => {
    const target = focusAfterRemove.current;
    if (!target) return;
    focusAfterRemove.current = null;
    if (target.photoId === null) {
      onEmptied?.();
      return;
    }
    listRef.current
      ?.querySelector<HTMLButtonElement>(`[data-tray-remove="${target.photoId}"]`)
      ?.focus();
  }, [photos, onEmptied]);
  if (photos.length === 0) return null;
  return (
    <div className="gallery-sidebar-section gallery-sidebar-selection p-4 border-b border-border-token">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-controls={listId}
        className="gallery-sidebar-section-title w-full text-sm font-semibold text-muted-theme flex items-center gap-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-accent"
      >
        {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
        {t('gallery.selectionTray.title', 'Selected ({{count}})', { count: photos.length })}
      </button>
      {open && (
        // Five and a half rows: the cut-off row is what says the list scrolls
        // where the scrollbar is an overlay (macOS, phones).
        <ul id={listId} ref={listRef} className="mt-3 max-h-[17.5rem] overflow-y-auto space-y-1">
          {photos.map((photo) => (
            <TrayRow key={photo.id} photo={photo} onRemove={handleRemove} slug={slug} />
          ))}
        </ul>
      )}
    </div>
  );
};
