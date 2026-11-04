/**
 * Row windowing for Masonry flickr and quilted (issue 2193, step 2).
 *
 * jsdom has no layout, so as in rowWindow.test.tsx the grid's position comes
 * through getBoundingClientRect on `.photo-grid`, and what a browser resolves
 * for the grid through getComputedStyle. That the placement here matches a
 * browser's `dense` packing cannot be shown in jsdom: it was compared tile by
 * tile against Chromium, Firefox and WebKit when this was written.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

import { MasonryGalleryLayout } from '../MasonryGalleryLayout';
import { buildRows, WINDOW_MIN_PHOTOS } from '../rowWindow';
import { layoutQuilted, quiltedColumnCount, quiltedSpan, type QuiltedSpan } from '../quiltedWindow';
import { GridDensityOffered, resetGridDensityForTests, setGridDensity } from '../../gridDensity';
import type { Photo } from '../../../../types';

const mounts: number[] = [];
vi.mock('../../PhotoCard', () => ({
  PhotoCard: ({ photo, style, containerProps, onClick, isSelected }: {
    photo: Photo;
    style: React.CSSProperties;
    containerProps?: React.HTMLAttributes<HTMLDivElement>;
    onClick?: (e: React.MouseEvent) => void;
    isSelected?: boolean;
  }) => {
    React.useEffect(() => { mounts.push(photo.id); }, [photo.id]);
    return (
      <div
        data-testid="tile"
        data-photo={photo.id}
        data-likes={photo.like_count ?? 0}
        data-selected={isSelected ? 'yes' : 'no'}
        data-grid-column={style.gridColumn}
        data-grid-row={style.gridRow}
        style={style}
        tabIndex={0}
        onClick={onClick}
        {...containerProps}
      >
        <button type="button" data-testid="tile-action" />
      </div>
    );
  },
}));
vi.mock('../../../common', () => ({ AuthenticatedImage: () => null }));
vi.mock('../../../gallery/FeedbackIdentityModal', () => ({ FeedbackIdentityModal: () => null }));
const themeMode = vi.hoisted(() => ({ current: 'flickr' }));
vi.mock('../../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: { gallerySettings: { masonryMode: themeMode.current } } }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ format: () => '' }) }));

const CELL = 200;
const GUTTER = 16;
const PITCH = CELL + GUTTER;

// A mix of all three quilted shapes: 4:3, 16:9 (two columns), 2:3 (two rows).
const SHAPES = [[4000, 3000], [1920, 1080], [4000, 3000], [2000, 3000], [3000, 3000]];
const makePhotos = (count: number): Photo[] => Array.from({ length: count }, (_, i) => ({
  id: i + 1,
  filename: `IMG_${i + 1}.jpg`,
  url: `/p/${i + 1}`,
  thumbnail_url: `/t/${i + 1}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  width: SHAPES[i % SHAPES.length][0],
  height: SHAPES[i % SHAPES.length][1],
} as Photo));

const layoutProps = (photos: Photo[], extra: Record<string, unknown> = {}) => ({
  photos,
  slug: 'x',
  onPhotoClick: () => {},
  onDownload: () => {},
  ...extra,
} as never);

let gridTop = 0;
let gridWidth = 1200;
/** What a CSS template forces with `!important`, as the browser resolves it. */
let forced: Record<string, string> = {};
let resizeCallbacks: Array<{ target: Element; run: (width: number) => void }> = [];

const tiles = () => screen.queryAllByTestId('tile');
const tileIds = () => tiles().map((tile) => Number(tile.dataset.photo));
const grid = () => document.querySelector('.photo-grid') as HTMLElement;
const find = (id: number) => tiles().find((tile) => Number(tile.dataset.photo) === id);
const mountsOf = (id: number) => mounts.filter((mounted) => mounted === id).length;

/** Px offset of a tile in the grid, in either mode. */
const tileY = (tile: HTMLElement) => (tile.dataset.gridRow
  ? (parseInt(tile.dataset.gridRow, 10) - 1) * PITCH
  : parseFloat(tile.style.top));

function scrollGridTo(top: number) {
  gridTop = top;
  act(() => { window.dispatchEvent(new Event('scroll')); });
}

function resizeTo(width: number) {
  gridWidth = width;
  act(() => {
    resizeCallbacks.filter((entry) => entry.target !== document.body).forEach((entry) => entry.run(width));
  });
}

beforeEach(() => {
  mounts.length = 0;
  gridTop = 0;
  gridWidth = 1200;
  forced = {};
  resizeCallbacks = [];
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => gridWidth });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => gridWidth });
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = computed(element, pseudo);
    if (!String((element as HTMLElement).className).includes('photo-grid')) return style;
    const inline = (element as HTMLElement).style;
    const resolved: Record<string, string> = {
      display: 'grid',
      gridAutoFlow: 'row dense',
      gridAutoRows: inline.gridAutoRows,
      rowGap: `${GUTTER}px`,
      gridTemplateColumns: Array(quiltedColumnCount(gridWidth, parseInt(inline.gridAutoRows, 10) || CELL, GUTTER)).fill('1px').join(' '),
      ...forced,
    };
    return new Proxy(style, { get: (target, key) => (key in resolved ? resolved[key as string] : Reflect.get(target, key)) });
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const top = String(this.className).includes('photo-grid') ? gridTop : 0;
    return { top, bottom: top, left: 0, right: 0, width: gridWidth, height: 0, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: (entries: unknown[]) => void) {}
    observe(target: Element) {
      resizeCallbacks.push({ target, run: (width) => this.cb([{ contentRect: { width } }]) });
    }
    unobserve() {}
    disconnect() {}
  });
  // Scrolling the page moves the grid in the viewport.
  window.scrollBy = vi.fn((_x: number, y: number) => { gridTop -= y; }) as never;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** The same packing, the slow way: every tile scans from the top left. */
function bruteForceDense(spans: QuiltedSpan[], columns: number): Array<[number, number]> {
  const taken = new Set<string>();
  return spans.map((span) => {
    for (let row = 0; ; row++) {
      for (let column = 0; column + span.columns <= columns; column++) {
        const cells: string[] = [];
        for (let r = row; r < row + span.rows; r++) {
          for (let c = column; c < column + span.columns; c++) cells.push(`${r}/${c}`);
        }
        if (cells.every((cell) => !taken.has(cell))) {
          cells.forEach((cell) => taken.add(cell));
          return [column, row];
        }
      }
    }
  });
}

describe('layoutQuilted', () => {
  const photo = (id: number, width: number, height: number) => ({ id, width, height });
  const wide = (id: number) => photo(id, 1920, 1080);
  const tall = (id: number) => photo(id, 2000, 3000);
  const plain = (id: number) => photo(id, 4000, 3000);

  it('keeps the span thresholds, and treats a photo without dimensions as 4:3', () => {
    expect(quiltedSpan({ width: 3000, height: 2000 })).toEqual({ columns: 1, rows: 1 });
    expect(quiltedSpan({ width: 3001, height: 2000 })).toEqual({ columns: 2, rows: 1 });
    expect(quiltedSpan({ width: 700, height: 1000 })).toEqual({ columns: 1, rows: 1 });
    expect(quiltedSpan({ width: 699, height: 1000 })).toEqual({ columns: 1, rows: 2 });
    expect(quiltedSpan({})).toEqual({ columns: 1, rows: 1 });
  });

  it('counts the tracks auto-fill resolves to', () => {
    expect(quiltedColumnCount(1200, 200, 16)).toBe(5);
    expect(quiltedColumnCount(632, 200, 16)).toBe(3);
    expect(quiltedColumnCount(631.9, 200, 16)).toBe(2);
    expect(quiltedColumnCount(100, 200, 16)).toBe(1);
  });

  it('backfills a hole with a later photo, which puts it ahead in row order', () => {
    const layout = layoutQuilted([wide(1), wide(2), plain(3)], 3, 200, 16)!;
    expect(layout.placements.get(1)).toEqual({ gridColumn: '1 / span 2', gridRow: '1 / span 1' });
    expect(layout.placements.get(2)).toEqual({ gridColumn: '1 / span 2', gridRow: '2 / span 1' });
    expect(layout.placements.get(3)).toEqual({ gridColumn: '3 / span 1', gridRow: '1 / span 1' });
    expect(layout.items.map((item) => item.photoId)).toEqual([1, 3, 2]);
    expect(layout.items.map((item) => item.listIndex)).toEqual([0, 2, 1]);
    expect(layout.rowCount).toBe(2);
  });

  it('gives a two-row tile its full height and reserves both rows', () => {
    const layout = layoutQuilted([tall(1), plain(2), plain(3)], 2, 200, 16)!;
    expect(layout.items.find((item) => item.photoId === 1)!.height).toBe(416);
    expect(layout.placements.get(3)).toEqual({ gridColumn: '2 / span 1', gridRow: '2 / span 1' });
    expect(layout.rowCount).toBe(2);
  });

  it('agrees with a full scan for every tile, over a large mixed album', () => {
    const photos = makePhotos(1500).map((p, i) => ((i * 7) % 11 < 3 ? { ...p, width: 1920, height: 1080 } : p));
    for (const columns of [2, 3, 5, 8]) {
      const expected = bruteForceDense(photos.map(quiltedSpan), columns);
      const layout = layoutQuilted(photos, columns, 200, 16)!;
      photos.forEach((p, i) => {
        const span = quiltedSpan(p);
        expect(layout.placements.get(p.id)).toEqual({
          gridColumn: `${expected[i][0] + 1} / span ${span.columns}`,
          gridRow: `${expected[i][1] + 1} / span ${span.rows}`,
        });
      });
    }
  });

  it('gives up where a span overflows a single column, and only there', () => {
    expect(layoutQuilted([plain(1), wide(2)], 1, 200, 16)).toBeNull();
    expect(layoutQuilted([plain(1), tall(2)], 1, 200, 16)!.rowCount).toBe(3);
  });

  it('gives each row the reach of its tallest tile, with bottoms never decreasing', () => {
    const { items } = layoutQuilted([plain(1), tall(2), plain(3), plain(4)], 2, 200, 16)!;
    expect(buildRows(items).map(({ top, bottom }) => [top, bottom])).toEqual([[0, 416], [216, 416], [432, 632]]);

    const rows = buildRows(layoutQuilted(makePhotos(1000), 5, 200, 16)!.items);
    rows.slice(1).forEach((row, i) => {
      expect(row.top).toBeGreaterThan(rows[i].top);
      expect(row.bottom).toBeGreaterThanOrEqual(rows[i].bottom);
    });
  });
});

describe.each([['flickr'], ['quilted']])('Masonry %s windowing', (mode) => {
  beforeEach(() => { themeMode.current = mode; });
  // Deep in the album in both modes; flickr is about 650 photos at this depth.
  const DEEP = -20000;

  it('mounts every tile of a small gallery', () => {
    render(<MasonryGalleryLayout {...layoutProps(makePhotos(WINDOW_MIN_PHOTOS - 1))} />);
    expect(tileIds()).toEqual(makePhotos(WINDOW_MIN_PHOTOS - 1).map((photo) => photo.id));
    expect(grid().style.gridTemplateRows).toBe('');
    expect(tiles().every((tile) => !tile.dataset.gridColumn)).toBe(true);
  });

  it('keeps 2000 photos to a small DOM, and never mounts them all on the way', () => {
    render(<MasonryGalleryLayout {...layoutProps(makePhotos(2000))} />);
    expect(tiles().length).toBeGreaterThan(0);
    expect(tiles().length).toBeLessThan(150);
    expect(tileIds()).toContain(1);
    expect(new Set(mounts).size).toBeLessThan(150);
  });

  it('follows the scroll position, and the grid moving under content above it', () => {
    render(<MasonryGalleryLayout {...layoutProps(makePhotos(2000))} />);
    const before = tileIds();

    scrollGridTo(DEEP);
    const after = tileIds();
    expect(after.length).toBeLessThan(150);
    expect(Math.min(...after)).toBeGreaterThan(Math.max(...before));
    tiles().forEach((tile) => {
      expect(tileY(tile)).toBeGreaterThan(-DEEP - 800 * 5);
      expect(tileY(tile)).toBeLessThan(-DEEP + 800 * 5);
    });

    // A notice above the grid pushes it down with no scroll event; the body
    // observer picks it up.
    gridTop = DEEP / 2;
    act(() => { resizeCallbacks.find((entry) => entry.target === document.body)!.run(0); });
    expect(Math.max(...tileIds())).toBeLessThan(Math.min(...after));
  });

  it('re-windows at once when the list changes under a deep scroll position', () => {
    const photos = makePhotos(2000);
    const { rerender } = render(<MasonryGalleryLayout {...layoutProps(photos)} />);
    scrollGridTo(DEEP);

    // Reversed sort: the same offset now shows the other end of the album,
    // and no two tiles land on one spot.
    rerender(<MasonryGalleryLayout {...layoutProps([...photos].reverse())} />);
    const ids = tileIds();
    expect(ids.length).toBeLessThan(150);
    expect(Math.min(...ids)).toBeGreaterThan(1000);
    const spot = (tile: HTMLElement) => (tile.dataset.gridRow
      ? `${tile.dataset.gridRow}/${tile.dataset.gridColumn}`
      : `${tile.style.top}/${tile.style.left}`);
    expect(new Set(tiles().map(spot)).size).toBe(ids.length);

    // A filter that leaves less than the scroll offset: nothing is stranded.
    rerender(<MasonryGalleryLayout {...layoutProps(photos.slice(0, 250))} />);
    expect(tileIds().every((id) => id <= 250)).toBe(true);
    expect(window.scrollBy).not.toHaveBeenCalled();
  });

  it('does not remount tiles when one photo is patched in the cache', () => {
    const photos = makePhotos(2000);
    const { rerender } = render(<MasonryGalleryLayout {...layoutProps(photos)} />);
    const mountedBefore = [...mounts];
    const target = tileIds()[3];

    rerender(<MasonryGalleryLayout {...layoutProps(photos.map((p) => (p.id === target ? { ...p, like_count: 1 } : p)))} />);
    expect(mounts).toEqual(mountedBefore);
    expect(find(target)!.dataset.likes).toBe('1');
  });

  it('keeps the mounted tiles when a growing gallery crosses the threshold', () => {
    const photos = makePhotos(WINDOW_MIN_PHOTOS + 300);
    const { rerender } = render(<MasonryGalleryLayout {...layoutProps(photos.slice(0, WINDOW_MIN_PHOTOS - 10))} />);
    expect(tiles()).toHaveLength(WINDOW_MIN_PHOTOS - 10);

    rerender(<MasonryGalleryLayout {...layoutProps(photos)} />);
    expect(tiles().length).toBeLessThan(150);
    tileIds().forEach((id) => expect(mountsOf(id)).toBe(1));
  });

  it('keeps a tile with a focused control mounted across a width change', () => {
    render(<MasonryGalleryLayout {...layoutProps(makePhotos(2000))} />);
    scrollGridTo(DEEP);
    const control = tiles()[Math.floor(tiles().length / 2)].querySelector('button')!;
    act(() => { control.focus(); });

    resizeTo(600);
    expect(control.isConnected).toBe(true);
    expect(document.activeElement).toBe(control);
  });

  it('opens the clicked photo by its place in the list, after a re-sort too', () => {
    const onPhotoClick = vi.fn();
    const photos = [...makePhotos(2000)].reverse();
    render(<MasonryGalleryLayout {...layoutProps(photos, { onPhotoClick })} />);
    scrollGridTo(DEEP);
    const id = tileIds()[10];
    fireEvent.click(find(id)!);
    expect(onPhotoClick).toHaveBeenCalledWith(photos.findIndex((photo) => photo.id === id));
  });

  it('shows a selection made on a tile that has since left the window', () => {
    const selectedPhotos = new Set([1]);
    render(<MasonryGalleryLayout {...layoutProps(makePhotos(2000), { selectedPhotos, isSelectionMode: true })} />);
    expect(find(1)!.dataset.selected).toBe('yes');
    scrollGridTo(DEEP);
    expect(find(1)).toBeUndefined();
    scrollGridTo(0);
    expect(find(1)!.dataset.selected).toBe('yes');
    expect(find(2)!.dataset.selected).toBe('no');
  });
});

describe('Masonry flickr boxes', () => {
  beforeEach(() => { themeMode.current = 'flickr'; });

  it('keeps the full height and each tile at its box', () => {
    render(<MasonryGalleryLayout {...layoutProps(makePhotos(2000))} />);
    expect(parseFloat(grid().style.height)).toBeGreaterThan(50000);
    scrollGridTo(-40000);
    tiles().forEach((tile) => {
      expect(parseFloat(tile.style.top)).toBeGreaterThan(30000);
      expect(parseFloat(tile.style.width)).toBeGreaterThan(0);
    });
  });

  it('keeps the viewer on the same photo when the container width changes', () => {
    render(<MasonryGalleryLayout {...layoutProps(makePhotos(2000))} />);
    scrollGridTo(-30000);
    const ratioOf = (tile: HTMLElement) => (-gridTop - parseFloat(tile.style.top)) / parseFloat(tile.style.height);

    const anchorTile = tiles().find((tile) => parseFloat(tile.style.top) > 30000)!;
    const anchorId = Number(anchorTile.dataset.photo);
    const start = parseFloat(anchorTile.style.top) + parseFloat(anchorTile.style.height) * 0.4;
    scrollGridTo(-start);

    resizeTo(600);
    expect(window.scrollBy).toHaveBeenCalledTimes(1);
    expect(ratioOf(find(anchorId)!)).toBeCloseTo(0.4, 5);

    resizeTo(1200);
    expect(gridTop).toBeCloseTo(-start, 3);
  });
});

describe('Masonry quilted grid', () => {
  beforeEach(() => { themeMode.current = 'quilted'; });
  const columnsAt = (width: number) => quiltedColumnCount(width, CELL, GUTTER);

  it('holds the height of every row and pins each tile to its line for the whole list', () => {
    const photos = makePhotos(2000);
    render(<MasonryGalleryLayout {...layoutProps(photos)} />);
    const layout = layoutQuilted(photos, columnsAt(1200), CELL, GUTTER)!;
    expect(grid().getAttribute('style')).toContain(`grid-template-rows: repeat(${layout.rowCount}, ${CELL}px)`);
    expect(grid().style.gridAutoRows).toBe(`${CELL}px`);

    const seen = new Set<number>();
    for (let top = 0; top < layout.rowCount * PITCH; top += 800) {
      scrollGridTo(-top);
      tiles().forEach((tile) => {
        const id = Number(tile.dataset.photo);
        seen.add(id);
        expect({ gridColumn: tile.dataset.gridColumn, gridRow: tile.dataset.gridRow }).toEqual(layout.placements.get(id));
      });
    }
    expect(seen.size).toBe(2000);
  });

  it('keeps the tiles in view when a wider grid ends the all-mounted fallback', () => {
    gridWidth = 400;
    render(<MasonryGalleryLayout {...layoutProps(makePhotos(2000))} />);
    expect(tiles()).toHaveLength(2000);
    const control = find(1)!.querySelector('button')!;
    act(() => { control.focus(); });
    mounts.length = 0;

    resizeTo(1200);
    expect(tiles().length).toBeLessThan(2000);
    expect(control.isConnected).toBe(true);
    expect(document.activeElement).toBe(control);
    expect(mounts).toEqual([]);
  });

  it('falls back when a CSS template arrives without changing the grid\'s size', async () => {
    render(<MasonryGalleryLayout {...layoutProps(makePhotos(2000))} />);
    expect(tiles().length).toBeLessThan(2000);
    forced = { rowGap: '40px' };
    const template = document.createElement('style');
    await act(async () => { document.head.appendChild(template); });
    expect(tiles()).toHaveLength(2000);
    template.remove();
  });

  it('renders the tiles in list order, as with all of them mounted', () => {
    // Wide photos leave holes the single ones then backfill, far up the grid.
    const photos = makePhotos(2000).map((p, i) => (i % 4 === 0 ? p : { ...p, width: 1920, height: 1080 }));
    render(<MasonryGalleryLayout {...layoutProps(photos)} />);
    scrollGridTo(-20000);
    const ids = tileIds();
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it('keeps a two-row tile mounted for as long as its lower half is within the overscan', () => {
    const photos = makePhotos(2000);
    const layout = layoutQuilted(photos, columnsAt(1200), CELL, GUTTER)!;
    render(<MasonryGalleryLayout {...layoutProps(photos)} />);

    // A deep row that starts with a one-row tile and also holds a two-row one.
    const row = buildRows(layout.items).slice(20).find((candidate) => layout.items[candidate.from].height === CELL
      && candidate.bottom - candidate.top > CELL)!;
    const tall = layout.items.slice(row.from, row.to).find((item) => item.height > CELL)!;

    // The overscan's edge is past the first tile, and inside the tall one.
    scrollGridTo(-(row.top + CELL + 800 * 3 + 1));
    expect(tileIds()).toContain(tall.photoId);
  });

  it('keeps the viewer in the list across a change of column count', () => {
    const photos = makePhotos(2000);
    const wider = layoutQuilted(photos, columnsAt(1200), CELL, GUTTER)!;
    const narrower = layoutQuilted(photos, columnsAt(600), CELL, GUTTER)!;
    const orderIn = (layout: typeof wider, id: number) => layout.items.findIndex((item) => item.photoId === id);
    render(<MasonryGalleryLayout {...layoutProps(photos)} />);

    // Fewer columns re-pack `dense` and put the photo at another place in row
    // order, which is no re-sort: its place in the list has not moved.
    // The row at the top is the first to reach past it, as the hook finds it:
    // a two-row tile above can hold on to the top of the viewport.
    const rows = buildRows(wider.items);
    const topRowAt = (viewTop: number) => rows.find((candidate) => candidate.bottom > viewTop)!;
    const viewTop = rows.slice(30).map((candidate) => candidate.top + 40).find((offset) => {
      const { from } = topRowAt(offset);
      return orderIn(narrower, wider.items[from].photoId) !== from;
    })!;
    const row = topRowAt(viewTop);
    const anchorId = wider.items[row.from].photoId;
    const ratio = (viewTop - row.top) / (row.bottom - row.top);
    scrollGridTo(-viewTop);

    resizeTo(600);
    const at = orderIn(narrower, anchorId);
    const nextRow = buildRows(narrower.items).find((candidate) => candidate.from <= at && at < candidate.to)!;
    expect(window.scrollBy).toHaveBeenCalledTimes(1);
    expect(-gridTop).toBeCloseTo(nextRow.top + ratio * (nextRow.bottom - nextRow.top), 3);
    expect(tileIds()).toContain(anchorId);
  });

  it('does not re-pack or scroll for a width change within the same column count', () => {
    const photos = makePhotos(2000);
    render(<MasonryGalleryLayout {...layoutProps(photos)} />);
    scrollGridTo(-20000);
    const ids = tileIds();
    resizeTo(1210);
    expect(tileIds()).toEqual(ids);
    expect(window.scrollBy).not.toHaveBeenCalled();
  });

  it('keeps the viewer in the list when the viewer changes the tile size', () => {
    window.localStorage.clear();
    resetGridDensityForTests();
    const photos = makePhotos(2000);
    render(
      <GridDensityOffered.Provider value>
        <MasonryGalleryLayout {...layoutProps(photos)} />
      </GridDensityOffered.Provider>,
    );
    scrollGridTo(-20000);
    act(() => setGridDensity('compact'));
    expect(window.scrollBy).toHaveBeenCalledTimes(1);
    act(() => setGridDensity('default'));
  });

  it('mounts every tile on a single column with a two-column photo, unpinned', () => {
    gridWidth = 400;
    const photos = makePhotos(WINDOW_MIN_PHOTOS + 50);
    render(<MasonryGalleryLayout {...layoutProps(photos)} />);
    expect(tiles()).toHaveLength(photos.length);
    expect(tiles().every((tile) => !tile.dataset.gridColumn)).toBe(true);
    expect(grid().style.gridTemplateRows).toBe('');
  });

  it('still windows a single column without one', () => {
    gridWidth = 400;
    const photos = makePhotos(2000).map((p) => (p.width === 1920 ? { ...p, width: 3000, height: 3000 } : p));
    render(<MasonryGalleryLayout {...layoutProps(photos)} />);
    expect(tiles().length).toBeLessThan(150);
  });

  it('goes back to every tile when a narrower window reaches one column', () => {
    const photos = makePhotos(2000);
    render(<MasonryGalleryLayout {...layoutProps(photos)} />);
    expect(tiles().length).toBeLessThan(150);
    resizeTo(400);
    expect(tiles()).toHaveLength(2000);
    expect(tiles().every((tile) => !tile.dataset.gridColumn)).toBe(true);
  });

  it.each([
    ['columns', { gridTemplateColumns: '300px 300px' }],
    ['a sparse flow', { gridAutoFlow: 'row' }],
    ['flex', { display: 'flex' }],
    ['the row height', { gridAutoRows: '320px' }],
    ['the gap', { rowGap: '40px' }],
    ['the rows', { gridTemplateRows: '200px 400px' }],
    ['no rows', { gridTemplateRows: 'none' }],
  ])('mounts every tile, unpinned, when a template forces %s', (_name, override) => {
    forced = override;
    render(<MasonryGalleryLayout {...layoutProps(makePhotos(2000))} />);
    expect(tiles()).toHaveLength(2000);
    expect(tiles().every((tile) => !tile.dataset.gridColumn)).toBe(true);
    expect(grid().style.gridTemplateRows).toBe('');
  });

  it('does not take a resize still on its way for a template', () => {
    render(<MasonryGalleryLayout {...layoutProps(makePhotos(2000))} />);
    // Two resizes in a row: the observer reports the first while the grid
    // already has the tracks of the second.
    gridWidth = 1600;
    act(() => {
      resizeCallbacks.filter((entry) => entry.target !== document.body).forEach((entry) => entry.run(1000));
    });
    expect(tiles().length).toBeLessThan(150);
    resizeTo(1600);
    expect(tiles().length).toBeLessThan(150);
  });
});
