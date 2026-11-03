import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import type { RefObject } from 'react';
import { watchStylesheets, type WindowItem } from './rowWindow';

/**
 * The boxes of Masonry quilted, for row windowing (issue 2193).
 *
 * Quilted is a CSS grid with `grid-auto-flow: dense`, so with tiles missing
 * the browser would pack the rest differently. `layoutQuilted` runs the same
 * placement up front, and the mounted tiles are then pinned to the lines it
 * gave them. They stay grid items: the browser still sizes the tracks, the
 * gaps and the tiles, so a tile is where it would be with all of them mounted.
 * The grid keeps its height through `grid-template-rows`.
 */

export interface QuiltedSpan {
  columns: number;
  rows: number;
}

export interface QuiltedPlacement {
  gridColumn: string;
  gridRow: string;
}

export interface QuiltedLayout {
  /**
   * In row order, which is not list order: `dense` backfills a hole with a
   * later photo. Vertical only, in the grid's own coordinates; a padded grid
   * shifts them all alike. The columns are the browser's.
   */
  items: WindowItem[];
  placements: Map<number, QuiltedPlacement>;
  rowCount: number;
}

// Landscape photos span 2 columns, portrait photos span 2 rows.
export function quiltedSpan(photo: { width?: number | null; height?: number | null }): QuiltedSpan {
  const ratio = (photo.width || 800) / (photo.height || 600);
  // Very wide landscape (panoramic) - span 2 columns
  if (ratio > 1.5) return { columns: 2, rows: 1 };
  // Very tall portrait - span 2 rows
  if (ratio < 0.7) return { columns: 1, rows: 2 };
  // Normal aspect ratio - single cell
  return { columns: 1, rows: 1 };
}

/** What `repeat(auto-fill, minmax(cell, 1fr))` resolves to. */
export function quiltedColumnCount(width: number, cell: number, gutter: number): number {
  return Math.max(1, Math.floor((width + gutter) / (cell + gutter)));
}

/**
 * `dense` row-first placement: each tile takes the first cell, from the top
 * left, where it fits. Null when a span does not fit the columns. The grid
 * then adds an implicit column whose width comes from the images in it, which
 * no calculation can give. Story's grid is the same thing with other spans.
 */
export function layoutQuilted<P extends { id: number; width?: number | null; height?: number | null }>(
  photos: P[],
  columns: number,
  cell: number,
  gutter: number,
  spanOf: (photo: P, index: number) => QuiltedSpan = quiltedSpan,
): QuiltedLayout | null {
  const spans = photos.map((photo, index) => spanOf(photo, index));
  if (spans.some((span) => span.columns > columns)) return null;

  // Cells by `row * columns + column`.
  const taken: boolean[] = [];
  const fits = (at: number, span: QuiltedSpan) => {
    for (let row = 0; row < span.rows; row++) {
      for (let column = 0; column < span.columns; column++) {
        if (taken[at + row * columns + column]) return false;
      }
    }
    return true;
  };
  // Where each shape last fitted. Cells only ever fill up, so a shape never
  // fits before that, and a run of wide photos does not rescan the album.
  const cursors = new Map<string, number>();

  const pitch = cell + gutter;
  const items: WindowItem[] = [];
  const placements = new Map<number, QuiltedPlacement>();
  let rowCount = 0;
  photos.forEach((photo, listIndex) => {
    const span = spans[listIndex];
    const shape = `${span.columns}x${span.rows}`;
    let at = cursors.get(shape) ?? 0;
    while ((at % columns) + span.columns > columns || !fits(at, span)) at++;
    cursors.set(shape, at);
    for (let row = 0; row < span.rows; row++) {
      for (let column = 0; column < span.columns; column++) taken[at + row * columns + column] = true;
    }
    const row = Math.floor(at / columns);
    rowCount = Math.max(rowCount, row + span.rows);
    items.push({ photoId: photo.id, x: 0, y: row * pitch, width: 0, height: span.rows * pitch - gutter, rowIndex: row, listIndex });
    placements.set(photo.id, {
      gridColumn: `${(at % columns) + 1} / span ${span.columns}`,
      gridRow: `${row + 1} / span ${span.rows}`,
    });
  });
  // Stable, so a row keeps list order.
  items.sort((a, b) => a.rowIndex - b.rowIndex);
  return { items, placements, rowCount };
}

export interface QuiltedWindow {
  layout: QuiltedLayout | null;
  /** Tiles are pinned to `layout` and windowed. */
  windowed: boolean;
  /** Too early to say: mount nothing yet rather than every tile. */
  pending: boolean;
}

export function useQuiltedWindow<P extends { id: number; width?: number | null; height?: number | null }>(
  containerRef: RefObject<HTMLElement | null>,
  photos: P[],
  containerWidth: number,
  cell: number,
  gutter: number,
  active: boolean,
  requested: boolean,
): QuiltedWindow {
  // Set for good once the grid turned out not to be the one laid out here.
  const [unsupported, setUnsupported] = useState(false);
  const columns = quiltedColumnCount(containerWidth, cell, gutter);

  // Laid out below the threshold too: when a growing list crosses it, the
  // window then starts from the tiles that were mounted.
  const layout = useMemo(
    () => (active && containerWidth > 0 && photos.length > 0 ? layoutQuilted(photos, columns, cell, gutter) : null),
    [active, containerWidth, photos, columns, cell, gutter],
  );
  const windowed = requested && !unsupported && layout !== null;
  // Bumped when a CSS template arrives, which can change the grid at any size.
  const [styles, setStyles] = useState(0);
  useEffect(() => (windowed ? watchStylesheets(() => setStyles((count) => count + 1)) : undefined), [windowed]);

  // The grid's style is inline, but a CSS template can override it with
  // `!important`, and every tile would then be pinned to the wrong grid.
  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!windowed || !container) return;
    const style = getComputedStyle(container);
    const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    // A resize still on its way to `containerWidth`.
    if (Math.abs(container.clientWidth - padding - containerWidth) >= 1) return;
    const tracks = (style.gridTemplateColumns || '').split(/\s+/).filter(Boolean);
    if (
      style.display !== 'grid'
      || !(style.gridAutoFlow || '').includes('dense')
      || style.gridAutoRows !== `${cell}px`
      || style.gridTemplateRows === 'none'
      || (style.gridTemplateRows || '').split(/\s+/).some((row) => Math.abs((parseFloat(row) || cell) - cell) >= 0.5)
      || parseFloat(style.rowGap) !== gutter
      || tracks.length !== columns
    ) setUnsupported(true);
  }, [containerRef, windowed, containerWidth, columns, cell, gutter, styles]);

  return { layout, windowed, pending: requested && !unsupported && containerWidth <= 0 };
}
