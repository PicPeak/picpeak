import React, { useLayoutEffect, useMemo, useRef, useState } from 'react';
import { StoryPhotoCard, type StoryCaptionMode } from './StoryPhotoCard';
import { useWindowedItems, watchStylesheets, type WindowItem } from '../rowWindow';
import { layoutQuilted } from '../quiltedWindow';
import type { Photo } from '../../../../types';

const NO_ITEMS: WindowItem[] = [];

interface StoryGrid {
  columns: number;
  /** The fixed height of a row, in px. */
  cell: number;
  gap: number;
  /** Content-box width, which is what the anchor check in rowWindow compares. */
  width: number;
}

/**
 * The grid as the stylesheet resolves it at this width: fixed rows, and a
 * first photo two columns and two rows large where there are three columns.
 * Null for anything else (a CSS template), which mounts every card.
 */
function readGrid(container: HTMLElement): StoryGrid | null {
  const parent = container.parentElement;
  if (!parent) return null;
  // Read from an empty copy: on the grid itself, cards still pinned to the
  // third column of a grid that just went to one would read as extra tracks.
  const copy = container.cloneNode(false) as HTMLElement;
  copy.removeAttribute('id');
  copy.style.position = 'absolute';
  copy.style.visibility = 'hidden';
  copy.style.width = getComputedStyle(container).width;
  copy.style.removeProperty('grid-template-rows');
  parent.appendChild(copy);
  const style = getComputedStyle(copy);
  const display = style.display;
  const tracks = (style.gridTemplateColumns || '').split(/\s+/).filter(Boolean).map(parseFloat);
  const cell = parseFloat(style.gridAutoRows);
  const forcedRow = parseFloat(style.gridTemplateRows);
  const gap = parseFloat(style.rowGap) || 0;
  const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  copy.remove();
  if (display !== 'grid' || (tracks.length !== 1 && tracks.length !== 3)) return null;
  if (tracks.some((track) => !(Math.abs(track - tracks[0]) < 0.5)) || !(cell > 0)) return null;
  if (forcedRow && Math.abs(forcedRow - cell) >= 0.5) return null;
  return { columns: tracks.length, cell, gap, width: container.clientWidth - padding };
}

const sameGrid = (a: StoryGrid | null | undefined, b: StoryGrid | null) => a === b || (Boolean(a) && Boolean(b)
  && a!.columns === b!.columns && a!.cell === b!.cell && a!.gap === b!.gap && Math.abs(a!.width - b!.width) < 0.5);

interface StoryFixedGridProps {
  id: string;
  photos: Photo[];
  favorites: Set<number>;
  onToggleFavorite: (id: number) => void;
  onPhotoClick: (photo: Photo) => void;
  slug: string;
  allowDownloads?: boolean;
  useEnhancedProtection?: boolean;
  isSelectionMode?: boolean;
  selectedPhotos: Set<number>;
  onPhotoSelect?: (id: number) => void;
  likesAllowed?: boolean;
  onToggleVisibility?: (photoId: number, currentVisibility: string) => void;
  caption?: StoryCaptionMode;
  /** Mount only the rows near the viewport (issue 2193). */
  windowed?: boolean;
  revealed?: Set<number>;
}

/**
 * The Story scene's fixed tile grid. In a large gallery the mounted cards are
 * pinned to their grid lines, as Masonry quilted's are (quiltedWindow.ts), and
 * `grid-template-rows` holds the height.
 */
export const StoryFixedGrid: React.FC<StoryFixedGridProps> = ({
  id,
  photos,
  favorites,
  onToggleFavorite,
  onPhotoClick,
  slug,
  allowDownloads,
  useEnhancedProtection,
  isSelectionMode,
  selectedPhotos,
  onPhotoSelect,
  likesAllowed,
  onToggleVisibility,
  caption,
  windowed: requested = false,
  revealed,
}) => {
  const gridRef = useRef<HTMLDivElement>(null);
  // undefined: not measured yet. null: not this grid, every card is mounted.
  const [grid, setGrid] = useState<StoryGrid | null | undefined>(undefined);

  const featured = photos.length > 4;
  useLayoutEffect(() => {
    const container = gridRef.current;
    if (!container) return undefined;
    const read = () => {
      const next = readGrid(container);
      setGrid((previous) => (sameGrid(previous, next) ? previous : next));
    };
    read();
    const stopWatching = watchStylesheets(read);
    if (typeof ResizeObserver === 'undefined') return stopWatching;
    const observer = new ResizeObserver(read);
    observer.observe(container);
    return () => {
      observer.disconnect();
      stopWatching();
    };
  }, []);

  const layout = useMemo(() => (grid
    ? layoutQuilted(photos, grid.columns, grid.cell, grid.gap, (_photo, index) => {
      const size = featured && index === 0 && grid.columns > 1 ? 2 : 1;
      return { columns: size, rows: size };
    })
    : null), [grid, photos, featured]);
  const windowed = requested && layout !== null;
  // Not this grid, every card is mounted: a later template that makes it one
  // starts its window from them, not from nothing.
  const mountedItems = useMemo((): WindowItem[] => (grid === null
    ? photos.map((photo, rowIndex) => ({ photoId: photo.id, x: 0, y: 0, width: 0, height: 0, rowIndex }))
    : NO_ITEMS), [grid, photos]);
  const { visible } = useWindowedItems(gridRef, layout?.items ?? mountedItems, grid?.width ?? 0, windowed, grid?.cell);

  // In list order, as with every card mounted: their lines place them, and
  // this is the order Tab walks them in.
  const indices = useMemo(() => {
    if (requested && grid === undefined) return [];
    if (!windowed) return photos.map((_, index) => index);
    const indexById = new Map(photos.map((photo, index) => [photo.id, index]));
    return visible.flatMap((item) => indexById.get(item.photoId) ?? []).sort((a, b) => a - b);
  }, [requested, grid, windowed, visible, photos]);

  return (
    <div
      id={id}
      ref={gridRef}
      className="story-gallery-grid"
      style={windowed && layout ? { gridTemplateRows: `repeat(${layout.rowCount}, ${grid?.cell}px)` } : undefined}
    >
      {indices.map((index) => {
        const photo = photos[index];
        return (
          <StoryPhotoCard
            key={photo.id}
            photo={photo}
            index={index}
            isFavorite={favorites.has(photo.id)}
            onToggleFavorite={onToggleFavorite}
            onClick={() => onPhotoClick(photo)}
            slug={slug}
            galleryId={id}
            allowDownloads={allowDownloads}
            useEnhancedProtection={useEnhancedProtection}
            // Mark first photo in each grid as featured
            featured={index === 0 && featured}
            isSelectionMode={isSelectionMode}
            isSelected={selectedPhotos.has(photo.id)}
            onSelect={onPhotoSelect}
            likesAllowed={likesAllowed}
            onToggleVisibility={onToggleVisibility}
            caption={caption}
            style={windowed ? layout?.placements.get(photo.id) : undefined}
            revealed={revealed}
          />
        );
      })}
    </div>
  );
};
