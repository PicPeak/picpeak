import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { useWindowedItems, watchStylesheets, type WindowItem } from './rowWindow';

/**
 * Row windowing for the layouts that stack tiles in columns: Masonry columns,
 * Mosaic and Premium (issue 2193, steps 3 and 4).
 *
 * Their tile positions cannot be calculated to the pixel. Mosaic is CSS
 * multi-column, whose balancing is the browser's own: a linear partition of
 * the same heights put tiles into another column in Firefox. The others stack
 * tiles whose px heights the browser rounds to its own layout unit (1/64 px
 * or 1/60 px), and 500 tiles of one shape came out 5.4 px off in Chromium.
 *
 * So the browser is asked: a hidden copy of the grid, with one empty box per
 * tile and the real classes (a CSS template applies to them too), is laid out
 * once per layout, read and removed before paint. From then on its boxes are
 * the layout, and a like, which changes no box, measures nothing.
 *
 * Mounted tiles are placed absolutely at their box, in the grid that keeps the
 * full height, so a tile's position does not depend on which others are
 * mounted. They keep their parent, a column or the grid itself.
 */

export interface TileBox {
  /** In the grid's own coordinates, from its padding edge. */
  x: number;
  y: number;
  width: number;
  height: number;
}

interface Measured {
  boxes: Map<number, TileBox>;
  /** The grid's own height. */
  height: number;
  /** Content-box width, which is what the anchor check in rowWindow compares. */
  width: number;
  columns: number;
  items: WindowItem[];
}

/** Builds the tiles into the hidden copy of the grid, keyed by photo id. */
export type GhostTiles = (root: HTMLElement) => Map<number, HTMLElement>;

/** A `div` for the hidden copy of the grid. */
export function ghostBox(parent: HTMLElement, className: string, style: Partial<CSSStyleDeclaration>): HTMLElement {
  const box = document.createElement('div');
  box.className = className;
  Object.assign(box.style, style);
  parent.appendChild(box);
  return box;
}

function contentWidth(container: HTMLElement): number {
  const style = getComputedStyle(container);
  return container.clientWidth - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
}


/**
 * Every tile a row of its own, in order of `y`: the columns have no rows to
 * share, and the photo at the top of the viewport is what a width change has
 * to keep. `listIndex` keeps its place in the list: another column count
 * re-orders the tiles without being a sort (rowWindow's `rearranged`).
 */
export function measuredItems(boxes: Map<number, TileBox>, photoIds: number[]): WindowItem[] {
  const items = photoIds.flatMap((photoId, listIndex): WindowItem[] => {
    const box = boxes.get(photoId);
    return box ? [{ photoId, ...box, rowIndex: 0, listIndex }] : [];
  });
  items.sort((a, b) => a.y - b.y || (a.listIndex ?? 0) - (b.listIndex ?? 0));
  items.forEach((item, index) => { item.rowIndex = index; });
  return items;
}

function measureTiles(container: HTMLElement, build: GhostTiles, photoIds: number[]): Measured | null {
  const parent = container.parentElement;
  if (!parent || !(contentWidth(container) > 0)) return null;
  // The container's own classes and inline style, minus what windowing added.
  const root = container.cloneNode(false) as HTMLElement;
  root.setAttribute('aria-hidden', 'true');
  // Fixed, for its height: absolute, it would give a scroll container up the
  // tree a scrollbar of its own (`overflow-x: hidden` in a CSS template makes
  // one of `.gallery-page`), and the grid would be measured that much narrower.
  root.style.position = 'fixed';
  root.style.visibility = 'hidden';
  root.style.left = '0';
  root.style.top = '0';
  root.style.removeProperty('height');
  root.style.removeProperty('min-height');
  const tiles = build(root);
  parent.appendChild(root);
  root.style.width = getComputedStyle(container).width;
  // A page too short for its scrollbar, as on a first render, gets it once
  // the grid has its height, and the grid gives up that width.
  const height = container.style.height;
  container.style.height = `${root.getBoundingClientRect().height}px`;
  root.style.width = getComputedStyle(container).width;
  const width = contentWidth(container);
  const origin = root.getBoundingClientRect();
  const boxes = new Map<number, TileBox>();
  tiles.forEach((tile, photoId) => {
    const rect = tile.getBoundingClientRect();
    boxes.set(photoId, {
      x: rect.left - origin.left - root.clientLeft,
      y: rect.top - origin.top - root.clientTop,
      width: rect.width,
      height: rect.height,
    });
  });
  root.remove();
  container.style.height = height;
  const columns = new Set(Array.from(boxes.values(), (box) => Math.round(box.x))).size;
  return { boxes, height: origin.height, width, columns, items: measuredItems(boxes, photoIds) };
}

/**
 * A tile at its box. The margin is in the box already, and a tile that moves
 * to another box goes there at once: `transition-all`, which a tile has for
 * its hover, would glide it across the page after a sort.
 */
export const boxStyle = (box: TileBox | undefined): CSSProperties | undefined => box && {
  position: 'absolute',
  left: box.x,
  top: box.y,
  width: box.width,
  height: box.height,
  margin: 0,
  transitionProperty: 'transform, opacity, box-shadow',
};

/** The grid around tiles at their boxes. */
export const gridBoxStyle = ({ windowed, height }: Pick<MeasuredWindow, 'windowed' | 'height'>): CSSProperties | undefined => (
  windowed ? { position: 'relative', height } : undefined
);

export interface MeasuredWindow {
  /** Tiles are placed from `boxes` and only `mounted` ones are in the DOM. */
  windowed: boolean;
  /** The ids to render: all of them below the threshold. */
  mounted: Set<number>;
  boxes: Map<number, TileBox> | null;
  height: number;
}

/**
 * `signature` names everything a box depends on (which tile, its shape, the
 * column count): a new `photos` array with the same signature measures
 * nothing. The grid's width and resolved `column-count` are watched here,
 * since a media query can change the second without the first.
 */
export function useMeasuredWindow(
  containerRef: RefObject<HTMLElement | null>,
  photoIds: number[],
  signature: string,
  build: GhostTiles,
  requested: boolean,
  // Too early to say, with no tile rendered yet: those aren't all to window from.
  pending = false,
): MeasuredWindow {
  const [measured, setMeasured] = useState<Measured | null>(null);
  // Bumped when the grid may lay out differently under the same signature.
  const [revision, setRevision] = useState(0);
  const buildRef = useRef(build);
  buildRef.current = build;
  const photoIdsRef = useRef(photoIds);
  photoIdsRef.current = photoIds;
  // What the last measurement was laid out against, besides the signature.
  const shapeRef = useRef({ width: 0, columnCount: '' });

  useLayoutEffect(() => {
    const container = containerRef.current;
    if (!requested || !container) return;
    setMeasured(measureTiles(container, buildRef.current, photoIdsRef.current));
    shapeRef.current = { width: contentWidth(container), columnCount: getComputedStyle(container).columnCount };
  }, [containerRef, requested, signature, revision]);

  useEffect(() => {
    const container = containerRef.current;
    if (!requested || !container) return undefined;
    const remeasure = () => setRevision((revision) => revision + 1);
    const resize = new ResizeObserver(() => {
      if (contentWidth(container) !== shapeRef.current.width) remeasure();
    });
    resize.observe(container);
    // Only for the column count at the same width. A width change waits for
    // the observer, which is also what tells the layouts: measured ahead of
    // them, the window would go by the old tile heights at the new width.
    const onResize = () => {
      const { width, columnCount } = shapeRef.current;
      if (contentWidth(container) === width && getComputedStyle(container).columnCount !== columnCount) remeasure();
    };
    window.addEventListener('resize', onResize);
    const stopWatching = watchStylesheets(remeasure);
    return () => {
      resize.disconnect();
      window.removeEventListener('resize', onResize);
      stopWatching();
    };
  }, [containerRef, requested]);

  const windowed = requested && measured !== null;
  // What a window starts from when a growing list crosses the threshold,
  // before the first measurement: the tiles that were mounted, so that nothing
  // in view remounts. None on a first render.
  const renderedRef = useRef<number[]>([]);
  const items = useMemo(() => {
    if (windowed) return measured.items;
    const known = new Set(photoIds);
    const ids = requested || pending ? renderedRef.current.filter((id) => known.has(id)) : photoIds;
    return ids.map((photoId, rowIndex): WindowItem => ({ photoId, x: 0, y: 0, width: 0, height: 0, rowIndex }));
  }, [windowed, measured, requested, pending, photoIds]);

  // The column count as `rowHeight`: it re-packs the tiles at the same width.
  const { visible } = useWindowedItems(containerRef, items, measured?.width ?? 0, windowed, measured?.columns ?? 0);

  useLayoutEffect(() => {
    renderedRef.current = visible.map((item) => item.photoId);
  }, [visible]);

  const mounted = useMemo(() => new Set(visible.map((item) => item.photoId)), [visible]);
  return { windowed, mounted, boxes: windowed ? measured.boxes : null, height: windowed ? measured.height : 0 };
}
