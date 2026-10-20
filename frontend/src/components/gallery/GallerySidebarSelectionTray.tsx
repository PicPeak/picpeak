import React, { useId, useLayoutEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import { useInView } from 'react-intersection-observer';
import { useTranslation } from 'react-i18next';

import { AuthenticatedImage } from '../common';
import type { Photo } from '../../types';
import { photoDisplayFilename } from '../../utils/photoFilename';
import { usePhotoLabels } from './PhotoLabels';

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
  /**
   * False where the list sits in a popover or sheet with its own title (the
   * gallery toolbar, issue 1733 E5): no foldable title and no section frame.
   */
  foldable?: boolean;
}

const TrayRow: React.FC<{
  photo: TrayPhoto;
  /** The row's place in the tray, to tell apart photos a filter hides. */
  position: number;
  count: number;
  onRemove: (photoId: number, button: HTMLButtonElement) => void;
  slug?: string;
}> = ({
  photo,
  position,
  count,
  onRemove,
  slug,
}) => {
  const { t } = useTranslation();
  // A thumbnail is requested only once its row scrolls into the tray, so a
  // selection of several hundred photos costs a handful of requests.
  const { ref, inView } = useInView({ triggerOnce: true, rootMargin: '100px' });
  // Numbered against the gallery's list under neutral labels (issue 1733, E6).
  // A selected photo a search or filter hides has no number there, so it is
  // numbered by its place in the tray instead: every row keeps a distinct name.
  const photoLabels = usePhotoLabels();
  const name = photoLabels.neutral && !photoLabels.has(photo)
    ? t('gallery.neutralLabel.selected', 'Selected photo {{position}} of {{total}}', { position: position + 1, total: count })
    : photoLabels.of(photo, photoDisplayFilename(photo));
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

export const GallerySidebarSelectionTray: React.FC<GallerySidebarSelectionTrayProps> = ({ photos, onRemove, onEmptied, slug, foldable = true }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);
  // Removing a row unmounts the button that had focus, which would drop focus
  // to <body> and send a keyboard user back to the top of the page. The removal
  // is noted here and focus handed on once the row is gone: to the row that
  // moved up into its place, else the one before it, else out of the tray.
  const focusAfterRemove = useRef<{ photoId: number; index: number } | null>(null);
  const handleRemove = (photoId: number, button: HTMLButtonElement) => {
    // Only when the button held focus (Safari does not focus a button on
    // click): otherwise there is no focus to lose.
    focusAfterRemove.current = document.activeElement === button
      ? { photoId, index: photos.findIndex((photo) => photo.id === photoId) }
      : null;
    onRemove(photoId);
  };
  // A layout effect, so it has always run for one commit before the next click
  // is handled. A passive effect left over from an earlier commit would be
  // flushed after the click, see the photo still listed and drop the record.
  useLayoutEffect(() => {
    const removed = focusAfterRemove.current;
    if (!removed) return;
    focusAfterRemove.current = null;
    // The target is picked from the list as it is now, not as it was at the
    // click: the same update may have dropped more rows than the one removed.
    // Nothing to do if the photo is still listed or focus has gone elsewhere.
    if (photos.some((photo) => photo.id === removed.photoId)) return;
    if (document.activeElement && document.activeElement !== document.body) return;
    if (photos.length === 0) {
      onEmptied?.();
      return;
    }
    const target = photos[Math.min(removed.index, photos.length - 1)];
    listRef.current
      ?.querySelector<HTMLButtonElement>(`[data-tray-remove="${target.id}"]`)
      ?.focus();
  }, [photos, onEmptied]);
  if (photos.length === 0) return null;
  const list = (
    // In the sidebar, five and a half rows: the cut-off row is what says the
    // list scrolls where the scrollbar is an overlay (macOS, phones). A sheet
    // or popover scrolls the list itself.
    <ul id={listId} ref={listRef} className={`${foldable ? 'mt-3 max-h-[17.5rem] overflow-y-auto' : ''} space-y-1`}>
      {photos.map((photo, index) => (
        <TrayRow key={photo.id} photo={photo} position={index} count={photos.length} onRemove={handleRemove} slug={slug} />
      ))}
    </ul>
  );
  if (!foldable) return list;
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
      {open && list}
    </div>
  );
};
