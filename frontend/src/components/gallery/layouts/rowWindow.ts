import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { JustifiedLayoutItem } from '../../../utils/justifiedLayoutCalculator';
import { KEEP_BAND_VIEWPORTS } from './lazyBands';

/**
 * Row windowing for the layouts that position every tile from a precomputed
 * box (Justified, Masonry rows) — issue 1733, step 2.
 *
 * Only the rows near the viewport are in the DOM. The grid container keeps
 * the layout's full height and the tiles stay absolutely positioned at their
 * own offsets, so the container is its own spacer: the scrollbar and every
 * tile's position are exactly what they are with all rows mounted.
 */

/** Below this many photos every row is mounted, as before. */
export const WINDOW_MIN_PHOTOS = 200;

/**
 * Rows kept mounted beyond each edge of the viewport, in viewport heights.
 * The same distance at which PhotoCard releases a tile's image, so windowing
 * removes a tile exactly where its image would have been dropped anyway.
 */
export const WINDOW_OVERSCAN_VIEWPORTS = KEEP_BAND_VIEWPORTS;

export interface RowBox {
  top: number;
  bottom: number;
  /** Index range into the layout's items, `to` exclusive. */
  from: number;
  to: number;
}

/** Row range, `end` exclusive. */
export interface RowRange {
  start: number;
  end: number;
}

/** Group layout items (already in row order) into their rows. */
export function buildRows(items: JustifiedLayoutItem[]): RowBox[] {
  const rows: RowBox[] = [];
  let rowIndex = -1;
  items.forEach((item, i) => {
    if (item.rowIndex !== rowIndex) {
      rowIndex = item.rowIndex;
      rows.push({ top: item.y, bottom: item.y + item.height, from: i, to: i + 1 });
    } else {
      rows[rows.length - 1].to = i + 1;
    }
  });
  return rows;
}

/** Index of the first row for which `past(row)` holds; rows.length if none. */
function firstRow(rows: RowBox[], past: (row: RowBox) => boolean): number {
  let lo = 0;
  let hi = rows.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (past(rows[mid])) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/**
 * The rows that intersect [viewTop - overscan, viewBottom + overscan], with
 * all three in the grid's own coordinates (0 = top of the grid).
 */
export function visibleRowRange(
  rows: RowBox[],
  viewTop: number,
  viewBottom: number,
  overscan: number,
): RowRange {
  const start = firstRow(rows, (row) => row.bottom > viewTop - overscan);
  const end = firstRow(rows, (row) => row.top >= viewBottom + overscan);
  return { start, end: Math.max(start, end) };
}

interface ScrollAnchor {
  photoId: number;
  /** How far down the anchor's row the top of the viewport is, 0 to 1. */
  ratio: number;
}

export interface WindowedItems {
  /** The items to render, in layout order. */
  visible: JustifiedLayoutItem[];
  /** Keep a photo's row, and the rows next to it, mounted while focus is in its tile. */
  pin: (photoId: number | null) => void;
}

/**
 * Which of `items` to render. With `enabled` false it is all of them.
 *
 * `width` is the container width the items were laid out for: when it
 * changes, the page is scrolled so a photo from the row that crossed the top
 * of the viewport crosses it again, at the same fraction of its row, instead
 * of whatever now sits at the old pixel offset. A plain scroll adjustment by
 * the browser cannot do this: the rows are re-packed, so the photo moves by
 * a different amount than its neighbours.
 */
export function useWindowedItems(
  containerRef: RefObject<HTMLElement | null>,
  items: JustifiedLayoutItem[],
  width: number,
  enabled: boolean,
): WindowedItems {
  const model = useMemo(() => {
    const rows = enabled ? buildRows(items) : [];
    const rowOf = new Map<number, number>();
    rows.forEach((row, index) => {
      for (let i = row.from; i < row.to; i++) rowOf.set(items[i].photoId, index);
    });
    return { items, rows, rowOf };
  }, [items, enabled]);

  const [range, setRange] = useState<RowRange>({ start: 0, end: 0 });
  const [pinned, setPinned] = useState<number | null>(null);
  const modelRef = useRef(model);
  const anchorRef = useRef<ScrollAnchor | null>(null);
  const widthRef = useRef(width);

  // The grid's position is read from the DOM on every pass, never cached: a
  // header, folder bar or notice that grows above the grid moves it.
  const measure = useCallback(() => {
    const container = containerRef.current;
    const { rows } = modelRef.current;
    if (!container || rows.length === 0) return;
    // A focused control can go without a blur: PhotoCard releases a far
    // tile's buttons, and a removed element fires none. Let go of its rows.
    if (!container.contains(document.activeElement)) setPinned(null);
    const viewTop = -container.getBoundingClientRect().top;
    const viewport = window.innerHeight;
    const next = visibleRowRange(rows, viewTop, viewTop + viewport, viewport * WINDOW_OVERSCAN_VIEWPORTS);
    setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, [containerRef]);

  // Remember what is at the top of the viewport. Taken whenever the grid may
  // have moved under it, except while a width change is on its way to the
  // layout: by then the toolbar above may already have re-wrapped and pushed
  // the grid a few pixels, and going there and back would not return to the
  // same place.
  const markAnchor = useCallback(() => {
    const container = containerRef.current;
    const { rows } = modelRef.current;
    if (!container || rows.length === 0) return;
    const viewTop = -container.getBoundingClientRect().top;
    const top = firstRow(rows, (row) => row.bottom > viewTop);
    if (viewTop <= 0 || top >= rows.length) {
      anchorRef.current = null;
      return;
    }
    // Hold on to the same photo while its row is still the one at the top:
    // another width puts it in a row that starts with a different photo, and
    // switching to that one would drift a row per resize, never to return.
    const { items, rowOf } = modelRef.current;
    const previous = anchorRef.current;
    anchorRef.current = {
      photoId: previous && rowOf.get(previous.photoId) === top ? previous.photoId : items[rows[top].from].photoId,
      ratio: Math.max(0, (viewTop - rows[top].top) / (rows[top].bottom - rows[top].top)),
    };
  }, [containerRef]);

  // A new layout (sort, filter, more photos, another width) invalidates the
  // range at once, before paint.
  useLayoutEffect(() => {
    modelRef.current = model;
    const container = containerRef.current;
    const anchor = anchorRef.current;
    if (widthRef.current === width) {
      markAnchor();
    } else if (container && anchor && widthRef.current > 0) {
      const index = model.rowOf.get(anchor.photoId);
      if (index !== undefined) {
        const row = model.rows[index];
        const viewTop = -container.getBoundingClientRect().top;
        const delta = row.top + anchor.ratio * (row.bottom - row.top) - viewTop;
        if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
      }
    }
    widthRef.current = width;
    measure();
  }, [model, width, measure, markAnchor, containerRef]);

  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
        // The rows are still those of the width they were laid out for.
        const container = containerRef.current;
        if (container && Math.abs(container.offsetWidth - widthRef.current) < 1) markAnchor();
      });
    };
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    // Content above the grid can grow without a scroll event (no scroll
    // anchoring in Safari); the document's height changes when it does.
    const observer = new ResizeObserver(schedule);
    observer.observe(document.body);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [enabled, measure, markAnchor, containerRef]);

  const visible = useMemo(() => {
    const { items, rows, rowOf } = model;
    if (!enabled) return items;
    // The range may predate this layout for one unpainted render.
    const end = Math.min(range.end, rows.length);
    const start = Math.min(range.start, end);
    const take = (from: number, to: number) => (from < to ? items.slice(rows[from].from, rows[to - 1].to) : []);
    const pinnedRow = pinned === null ? undefined : rowOf.get(pinned);
    if (pinnedRow === undefined) return take(start, end);
    // The focused row and its two neighbours, so Tab and Shift+Tab land on
    // the next photo (and scroll to it) wherever the window has gone since.
    const keepStart = Math.max(0, pinnedRow - 1);
    const keepEnd = Math.min(rows.length, pinnedRow + 2);
    if (start === end || (keepStart <= end && keepEnd >= start)) {
      return start === end ? take(keepStart, keepEnd) : take(Math.min(start, keepStart), Math.max(end, keepEnd));
    }
    // Document order stays photo order.
    return keepEnd < start
      ? [...take(keepStart, keepEnd), ...take(start, end)]
      : [...take(start, end), ...take(keepStart, keepEnd)];
  }, [enabled, model, range, pinned]);

  return { visible, pin: setPinned };
}
