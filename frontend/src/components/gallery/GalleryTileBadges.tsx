/**
 * Per-tile badges that depend on the gallery rather than the photo alone:
 * the first-look pill (issue 1562) and, in "All photos" mode, the folder a
 * photo lives in (issue 1786).
 *
 * Carried by context instead of a prop: the shared PhotoCard is rendered from
 * five layouts (some in several places), and Carousel, Premium and Story draw
 * their own tiles. A prop would have to be threaded through every one of them
 * for something no layout decides on its own.
 */
import React, { createContext, useContext } from 'react';
import { Sparkles } from 'lucide-react';

import type { Photo } from '../../types';

export interface GalleryTileBadgesValue {
  /**
   * Text of the first-look pill, or null when the gallery is not a two-stage
   * delivery. The flag on a photo stays after the full gallery lands (issue
   * 1562), so the badge does too — it only needs `event.delivery` to exist.
   */
  firstLookLabel: string | null;
  /** The folder name to hint on a tile, or null for none (not in "All photos"). */
  folderNameOf: ((photo: Photo) => string | null) | null;
}

const EMPTY: GalleryTileBadgesValue = { firstLookLabel: null, folderNameOf: null };

const GalleryTileBadgesContext = createContext<GalleryTileBadgesValue>(EMPTY);

export const GalleryTileBadgesProvider: React.FC<{
  value: GalleryTileBadgesValue;
  children: React.ReactNode;
}> = ({ value, children }) => (
  <GalleryTileBadgesContext.Provider value={value}>{children}</GalleryTileBadgesContext.Provider>
);

export const useGalleryTileBadges = (): GalleryTileBadgesValue => useContext(GalleryTileBadgesContext);

/** The first-look label for this photo, or null when it carries no badge. */
export function useFirstLookLabel(photo: Photo): string | null {
  const { firstLookLabel } = useGalleryTileBadges();
  return photo.first_look && firstLookLabel ? firstLookLabel : null;
}

/** The folder hint for this photo, or null when none applies. */
export function useFolderHint(photo: Photo): string | null {
  const { folderNameOf } = useGalleryTileBadges();
  return folderNameOf ? folderNameOf(photo) : null;
}

interface BadgeProps {
  photo: Photo;
  /** Positioning classes inside the tile (absolute offsets). */
  className?: string;
  style?: React.CSSProperties;
  /**
   * In the flow of PhotoCard's lane instead of on a corner. The pill never
   * shrinks, so in a full row it wraps away whole rather than squeezing to
   * "First ..."; a long label ends at a fixed width of its own.
   */
  inline?: boolean;
}

/**
 * "✨ First look" pill. Sits on top of a photo, so it uses a fixed light chip
 * like the tiles' other indicators rather than gallery theme colours, which
 * are made for the page background, not for an arbitrary image.
 */
export const FirstLookBadge: React.FC<BadgeProps> = ({ photo, className = 'bottom-2 left-2', style, inline = false }) => {
  const label = useFirstLookLabel(photo);
  if (!label) return null;
  if (inline) {
    return (
      // In a lane narrower than 13rem (a phone's two columns) the icon alone:
      // the label would take the row from every other mark.
      <span
        className="relative shrink-0 pointer-events-none inline-flex h-6 max-w-[9rem] items-center gap-1 px-2 rounded-full bg-white/90 shadow-sm text-[11px] font-medium text-neutral-800 [@container_(max-width:13rem)]:w-6 [@container_(max-width:13rem)]:justify-center [@container_(max-width:13rem)]:px-0"
        title={label}
        data-testid="first-look-badge"
      >
        <Sparkles className="w-3 h-3 shrink-0" aria-hidden="true" />
        <span className="truncate [@container_(max-width:13rem)]:sr-only">{label}</span>
      </span>
    );
  }
  return (
    <span
      className={`absolute ${className} z-10 pointer-events-none inline-flex max-w-[calc(100%-1rem)] items-center gap-1 px-2 py-0.5 rounded-full bg-white/90 backdrop-blur-sm shadow-sm text-[11px] font-medium text-neutral-800`}
      style={style}
      data-testid="first-look-badge"
    >
      <Sparkles className="w-3 h-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
};

/** Folder name pill for "All photos" mode (issue 1786, mockup 2). */
export const FolderHintPill: React.FC<BadgeProps> = ({ photo, className = 'top-2 right-2', style, inline = false }) => {
  const name = useFolderHint(photo);
  if (!name) return null;
  if (inline) {
    return (
      <span
        className="relative shrink-0 pointer-events-none max-w-[8rem] truncate px-1.5 py-0.5 rounded bg-black/60 text-white text-[10px] font-medium leading-tight"
        title={name}
        data-testid="folder-hint"
      >
        {name}
      </span>
    );
  }
  return (
    <span
      className={`absolute ${className} z-10 pointer-events-none max-w-[60%] truncate px-1.5 py-0.5 rounded bg-black/60 text-white text-[10px] font-medium leading-tight transition-opacity`}
      style={style}
      title={name}
      data-testid="folder-hint"
    >
      {name}
    </span>
  );
};

/**
 * Bottom-left placement for the first-look pill above `rows` chips a layout
 * already keeps in that corner (feedback indicators, Timeline's time, the
 * collage chip). Literal class names so Tailwind sees them.
 */
export function firstLookAboveChips(rows: number): string | undefined {
  if (rows <= 0) return undefined;
  return rows === 1 ? 'bottom-10 left-2' : 'bottom-16 left-2';
}
