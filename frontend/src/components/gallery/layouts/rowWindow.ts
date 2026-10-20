import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { JustifiedLayoutItem } from '../../../utils/justifiedLayoutCalculator';
import { KEEP_BAND_VIEWPORTS } from './lazyBands';

/**
 * Row windowing for the layouts that position every tile from a precomputed
 * box (Masonry rows) — issue 1733, step 2.
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
 *
 * `rowHeight` is the target row height they were laid out for. A change to it
 * (the viewer's tile size, issue 1733 E4) re-packs the rows at the same width
 * and is restored the same way.
 */
export function useWindowedItems(
  containerRef: RefObject<HTMLElement | null>,
  items: JustifiedLayoutItem[],
  width: number,
  enabled: boolean,
  rowHeight = 0,
): WindowedItems {
  const model = useMemo(() => {
    const rows = enabled ? buildRows(items) : [];
    const rowOf = new Map<number, number>();
    const indexOf = new Map<number, number>();
    rows.forEach((row, index) => {
      for (let i = row.from; i < row.to; i++) {
        rowOf.set(items[i].photoId, index);
        indexOf.set(items[i].photoId, i);
      }
    });
    return { items, rows, rowOf, indexOf };
  }, [items, enabled]);

  // The rows in the window, and the layout they were measured in.
  const [win, setWin] = useState({ model, start: 0, end: 0 });
  const modelRef = useRef(model);
  const anchorRef = useRef<ScrollAnchor | null>(null);
  const widthRef = useRef(width);
  const rowHeightRef = useRef(rowHeight);

  // The grid's position is read from the DOM on every pass, never cached: a
  // header, folder bar or notice that grows above the grid moves it.
  const measure = useCallback(() => {
    const container = containerRef.current;
    const current = modelRef.current;
    const { rows } = current;
    if (!container || rows.length === 0) return;
    const viewTop = -container.getBoundingClientRect().top;
    const viewport = window.innerHeight;
    const next = visibleRowRange(rows, viewTop, viewTop + viewport, viewport * WINDOW_OVERSCAN_VIEWPORTS);
    setWin((prev) => (prev.model === current && prev.start === next.start && prev.end === next.end
      ? prev
      : { model: current, ...next }));
  }, [containerRef]);

  // Remember what is at the top of the viewport. Taken whenever the grid may
  // have moved under it, except while a width change is on its way to the
  // layout: by then the toolbar above may already have re-wrapped and pushed
  // the grid a few pixels, and going there and back would not return to the
  // same place.
  //
  // `rearranged`: the list changed under the anchor, which then means
  // nothing any more; what is at the top now is the better guess even then.
  const markAnchor = useCallback((rearranged = false) => {
    const container = containerRef.current;
    const { rows } = modelRef.current;
    if (!container || rows.length === 0) return;
    // The rows must still be those of the container's width: the content
    // box, which is what the layouts measure (a CSS template may pad the grid).
    const style = getComputedStyle(container);
    const padding = (parseFloat(style.paddingLeft) || 0) + (parseFloat(style.paddingRight) || 0);
    if (!rearranged && Math.abs(container.clientWidth - padding - widthRef.current) >= 1) return;
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
    const previous = modelRef.current;
    modelRef.current = model;
    const container = containerRef.current;
    const anchor = anchorRef.current;
    const index = anchor ? model.rowOf.get(anchor.photoId) : undefined;
    // Sorted, filtered or grown ahead of the anchor: its photo is somewhere
    // else in the list, or gone. A cache patch leaves it where it was.
    const rearranged = anchor !== null
      && model.indexOf.get(anchor.photoId) !== previous.indexOf.get(anchor.photoId);
    const resized = (widthRef.current !== width && widthRef.current > 0)
      || rowHeightRef.current !== rowHeight;
    widthRef.current = width;
    rowHeightRef.current = rowHeight;
    if (resized && !rearranged && container && anchor && index !== undefined) {
      const row = model.rows[index];
      const viewTop = -container.getBoundingClientRect().top;
      const delta = row.top + anchor.ratio * (row.bottom - row.top) - viewTop;
      if (Math.abs(delta) >= 1) window.scrollBy(0, delta);
    } else {
      // Same geometry, or nothing to restore to.
      markAnchor(rearranged);
    }
    measure();
  }, [model, width, rowHeight, measure, markAnchor, containerRef]);

  useEffect(() => {
    if (!enabled) return;
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        measure();
        markAnchor();
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
  }, [enabled, measure, markAnchor]);

  // The items of the last commit. While windowing is off the window is never
  // measured, so `win` can be many layouts old when it turns on; what was on
  // screen is what the next window has to start from.
  const renderedRef = useRef<JustifiedLayoutItem[]>([]);

  const visible = useMemo(() => {
    const { items, rows, indexOf } = model;
    if (!enabled) return items;
    const { start, end } = win;
    if (win.model !== model) {
      // The window predates this layout for one unpainted render. Its row
      // numbers mean other photos here; mounting those would unmount every
      // tile in view (and whatever has focus) only to mount it again once
      // the window is measured, images refetched. Keep the same photos.
      const keep = new Set<number>();
      for (const item of renderedRef.current) {
        const index = indexOf.get(item.photoId);
        if (index !== undefined) keep.add(index);
      }
      return [...keep].sort((a, b) => a - b).map((index) => items[index]);
    }
    return start < end ? items.slice(rows[start].from, rows[end - 1].to) : [];
  }, [enabled, model, win]);

  useLayoutEffect(() => {
    renderedRef.current = visible;
  }, [visible]);

  return { visible };
}
