/**
 * Film strip in the lightbox toolbar (issue 1733, backlog item B5).
 *
 * A window of thumbnails around the open photo, the open one centred. Only
 * the window is mounted, so a gallery of any size costs about twenty
 * thumbnails. Thumbnails only, ever: a photo without one gets a neutral
 * placeholder, never its original.
 *
 * Desktop only for now. Below the breakpoint, on a short window or with a
 * coarse pointer the strip is not mounted at all, so the mobile toolbar keeps
 * its height and nothing is fetched for it.
 */
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { Photo } from '../../types';
import { AuthenticatedImage } from '../common';

/** Thumbnails mounted on each side of the open photo. */
export const FILM_STRIP_REACH = 10;

const THUMB_PX = 56;
const GAP_PX = 4;

const DESKTOP_QUERY = '(min-width: 768px) and (min-height: 600px) and (hover: hover) and (pointer: fine)';

// The image component paints a light grey box while it loads or after it
// failed; on the black toolbar that would flash, so the box is dimmed.
const PLACEHOLDER_STYLE: React.CSSProperties = { backgroundColor: 'rgba(255, 255, 255, 0.1)' };

const EDGE_FADE = 'linear-gradient(to right, transparent, #000 10%, #000 90%, transparent)';

function useDesktopViewport(): boolean {
  const [matches, setMatches] = useState(() => (
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(DESKTOP_QUERY).matches
      : false
  ));
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const query = window.matchMedia(DESKTOP_QUERY);
    const onChange = () => setMatches(query.matches);
    onChange();
    query.addEventListener('change', onChange);
    return () => query.removeEventListener('change', onChange);
  }, []);
  return matches;
}

interface LightboxFilmStripProps {
  photos: Photo[];
  currentIndex: number;
  onSelect: (index: number) => void;
  slug: string;
  /** Name each photo by its filename too; follows the lightbox's own filename line. */
  showFilenames?: boolean;
}

export const LightboxFilmStrip: React.FC<LightboxFilmStripProps> = ({
  photos,
  currentIndex,
  onSelect,
  slug,
  showFilenames = false,
}) => {
  const { t } = useTranslation();
  const isDesktop = useDesktopViewport();

  if (!isDesktop || photos.length < 2) return null;

  const first = Math.max(0, currentIndex - FILM_STRIP_REACH);
  const last = Math.min(photos.length - 1, currentIndex + FILM_STRIP_REACH);

  return (
    <ul
      aria-label={t('gallery.filmStrip.label', 'Photos')}
      data-testid="lightbox-film-strip"
      className="relative mx-auto mb-3 h-14 max-w-4xl overflow-hidden"
      style={{ maskImage: EDGE_FADE, WebkitMaskImage: EDGE_FADE }}
    >
      {photos.slice(first, last + 1).map((photo, offset) => {
        const index = first + offset;
        const isCurrent = index === currentIndex;
        const name = showFilenames ? (photo.original_filename || photo.filename) : '';
        const position = { position: index + 1, total: photos.length };
        return (
          // Every thumbnail sits at the centre and is shifted by its distance
          // from the open photo, so a step is one transform change per item
          // and the browser animates the slide.
          <li
            key={photo.id}
            className="absolute left-1/2 top-0 transition-transform duration-200 ease-out motion-reduce:transition-none"
            style={{
              width: THUMB_PX,
              height: THUMB_PX,
              marginLeft: -THUMB_PX / 2,
              transform: `translateX(${(index - currentIndex) * (THUMB_PX + GAP_PX)}px)`,
            }}
          >
            <button
              type="button"
              // Out of the tab order and never focused by a click: the arrow
              // keys already step through the photos, and a focused thumbnail
              // would take Space and Enter away from the lightbox.
              tabIndex={-1}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => onSelect(index)}
              aria-current={isCurrent ? 'true' : undefined}
              aria-label={name
                ? t('gallery.filmStrip.photoNamed', { ...position, name, defaultValue: 'Photo {{position}} of {{total}}: {{name}}' })
                : t('gallery.filmStrip.photo', { ...position, defaultValue: 'Photo {{position}} of {{total}}' })}
              className={`block h-full w-full overflow-hidden rounded transition-opacity ${isCurrent ? 'opacity-100' : 'opacity-50 hover:opacity-100'}`}
              // An outline, not a ring: a ring is a box-shadow and would be
              // painted underneath the thumbnail.
              style={isCurrent ? { outline: '2px solid #fff', outlineOffset: '-2px' } : undefined}
            >
              {photo.thumbnail_url ? (
                <AuthenticatedImage
                  src={photo.thumbnail_url}
                  alt=""
                  className="h-full w-full object-cover select-none pointer-events-none"
                  style={PLACEHOLDER_STYLE}
                  draggable={false}
                  isGallery={true}
                  slug={slug}
                />
              ) : (
                <span className="block h-full w-full" style={PLACEHOLDER_STYLE} data-testid="film-strip-placeholder" />
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
};

/**
 * What the lightbox shows instead of the preview while a key is held: the
 * photo's thumbnail, scaled up. Thumbnail only, like the strip.
 */
export const LightboxScrubStandIn: React.FC<{ photo: Photo; slug: string }> = ({ photo, slug }) => (
  <div className="absolute inset-0 flex items-center justify-center" data-testid="lightbox-scrub-stand-in">
    {photo.thumbnail_url && (
      <AuthenticatedImage
        queuePriority="high"
        src={photo.thumbnail_url}
        alt={photo.filename}
        className="h-full w-full object-contain select-none pointer-events-none"
        style={{ backgroundColor: 'transparent' }}
        draggable={false}
        isGallery={true}
        slug={slug}
      />
    )}
  </div>
);
