import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { JustifiedLayoutItem } from '../../../utils/justifiedLayoutCalculator';
import { useWindowedItems } from './rowWindow';

/**
 * Row windowing for the layouts that flow equal tiles through a CSS grid
 * (Grid, Timeline) — issue 2193, the follow-up to Masonry rows in #1955.
 *
 * The grid's columns, gaps and tile height come from the browser, not from
 * the theme: a CSS template may restyle `.photo-grid` (its own
 * `grid-template-columns`, padding and gap). From those every tile's box is
 * known, so the same row windowing as Masonry rows applies. The rows that are
 * not mounted are replaced by two full-width spacers, which keeps the grid's
 * height, every mounted tile's position and the scrollbar unchanged.
 */

/** Set on each tile, a direct child of the grid, so the grid can measure one. */
export const GRID_TILE_ATTR = 'data-grid-tile';

interface GridGeometry {
  columns: number;
  /** Column width in px. */
  track: number;
  rowGap: number;
  paddingTop: number;
  /** Content-box width, which is what the anchor check in rowWindow compares. */
  width: number;
  /** Tile height over column width, kept while no tile is mounted. */
  ratio: number;
}

/**
 * A tile's laid-out height. Not getBoundingClientRect: that includes
 * transforms, and a template may scale a hovered card (Liquid Glass does),
 * which would then size every row that is not mounted.
 */
function layoutHeight(tile: Element): number {
  const style = getComputedStyle(tile);
  const height = parseFloat(style.height);
  if (!(height > 0)) return 0;
  if (style.boxSizing === 'border-box') return height;
  return height
    + (parseFloat(style.paddingTop) || 0) + (parseFloat(style.paddingBottom) || 0)
    + (parseFloat(style.borderTopWidth) || 0) + (parseFloat(style.borderBottomWidth) || 0);
}

function readGeometry(container: HTMLElement, previousRatio: number | undefined): GridGeometry | null {
  const style = getComputedStyle(container);
  // Resolved track sizes, e.g. "280px 280px 280px"; "none" when it is not a grid.
  const tracks = (style.gridTemplateColumns || '').split(/\s+/).filter(Boolean).map(parseFloat);
  if (tracks.length === 0 || tracks.some((track) => !(track > 0))) return null;
  const tile = Array.from(container.children).find((child) => child.hasAttribute(GRID_TILE_ATTR));
  const height = tile ? layoutHeight(tile) : 0;
  const ratio = height > 0 ? height / tracks[0] : previousRatio;
  if (!ratio) return null;
  const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
  return {
    columns: tracks.length,
    track: tracks[0],
    rowGap: parseFloat(style.rowGap) || 0,
    paddingTop: parseFloat(style.paddingTop) || 0,
    width: container.clientWidth - padding,
    ratio,
  };
}

function sameGeometry(a: GridGeometry | null | undefined, b: GridGeometry | null): boolean {
  if (!a || !b) return a === b;
  return a.columns === b.columns
    && Math.abs(a.track - b.track) < 0.5
    && a.rowGap === b.rowGap
    && a.paddingTop === b.paddingTop
    && Math.abs(a.width - b.width) < 0.5
    && Math.abs(a.ratio - b.ratio) < 0.001;
}

export interface GridWindow<P> {
  /** The photos to render, in order, with their index in `photos`. */
  tiles: Array<{ photo: P; index: number }>;
  /** Heights of the spacers before and after the tiles; 0 means none. */
  before: number;
  after: number;
}

export function useGridWindow<P extends { id: number }>(
  containerRef: RefObject<HTMLElement | null>,
  photos: P[],
  enabled: boolean,
): GridWindow<P> {
  // undefined: not measured yet. null: not measurable (not a grid, or hidden),
  // in which case every tile is mounted.
  const [geometry, setGeometry] = useState<GridGeometry | null | undefined>(undefined);
  const geometryRef = useRef(geometry);
  geometryRef.current = geometry;

  // Measured on every commit even while windowing is off, so the grid is
  // already known when a growing list crosses the threshold and nothing in
  // view remounts.
  const measure = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const previous = geometryRef.current;
    const next = readGeometry(container, previous?.ratio);
    if (!sameGeometry(previous, next)) {
      geometryRef.current = next;
      setGeometry(next);
    }
  }, [containerRef]);

  // After every commit: a tile that just mounted gives the first height.
  useLayoutEffect(measure);

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !container) return;
    const observer = new ResizeObserver(() => measure());
    observer.observe(container);
    return () => observer.disconnect();
  }, [enabled, containerRef, measure]);

  const windowed = enabled && Boolean(geometry);

  // Laid out whenever the grid is known, windowing on or off: when a growing
  // list crosses the threshold, the window then starts from every tile that
  // was mounted instead of from none, and nothing in view remounts.
  const items = useMemo((): JustifiedLayoutItem[] => {
    if (!geometry) return [];
    const height = geometry.track * geometry.ratio;
    const pitch = height + geometry.rowGap;
    return photos.map((photo, i) => {
      const row = Math.floor(i / geometry.columns);
      return { photoId: photo.id, x: 0, y: geometry.paddingTop + row * pitch, width: geometry.track, height, rowIndex: row };
    });
  }, [geometry, photos]);

  const { visible } = useWindowedItems(containerRef, items, geometry?.width ?? 0, windowed);

  return useMemo(() => {
    const all = () => photos.map((photo, index) => ({ photo, index }));
    if (!enabled || geometry === null) return { tiles: all(), before: 0, after: 0 };
    // First render of a large gallery: one tile to measure the grid by,
    // windowed before the first paint.
    if (geometry === undefined) return { tiles: all().slice(0, 1), before: 0, after: 0 };

    const indexById = new Map<number, number>();
    photos.forEach((photo, index) => indexById.set(photo.id, index));
    const tiles = visible.flatMap((item) => {
      const index = indexById.get(item.photoId);
      return index === undefined ? [] : [{ photo: photos[index], index }];
    });

    const gap = geometry.rowGap;
    const pitch = geometry.track * geometry.ratio + gap;
    const total = Math.ceil(photos.length / geometry.columns) * pitch - gap;
    if (tiles.length === 0) return { tiles, before: Math.max(0, total), after: 0 };
    // A spacer is a grid row of its own and brings a gap with it.
    const first = visible[0].rowIndex;
    const before = first > 0 ? first * pitch - gap : 0;
    // The rest of the height, from the rows the tiles fill. Not from the last
    // tile's row: for the one unpainted render after a sort, the window keeps
    // the photos that were on screen, which may now sit rows apart, and the
    // grid packs them together. The grid must keep its height even then, or
    // the layout read in that render clamps the scroll position.
    const mounted = Math.ceil(tiles.length / geometry.columns) * pitch - gap;
    const rest = total - (before > 0 ? before + gap : 0) - mounted - gap;
    return { tiles, before, after: rest > 0.5 ? rest : 0 };
  }, [enabled, geometry, photos, visible]);
}
