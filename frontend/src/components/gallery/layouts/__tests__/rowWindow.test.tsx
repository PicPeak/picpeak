/**
 * Row windowing for Masonry rows (issue 1733, step 2).
 *
 * jsdom has no layout, so the grid's position is stood up through
 * getBoundingClientRect on the `.photo-grid` container and the scroll
 * position is whatever `gridTop` says.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';

import { MasonryGalleryLayout } from '../MasonryGalleryLayout';
import { buildRows, visibleRowRange, WINDOW_MIN_PHOTOS, type RowBox } from '../rowWindow';
import { GridDensityOffered, resetGridDensityForTests, setGridDensity } from '../../gridDensity';
import { calculateJustifiedLayout, createJustifiedPhotos } from '../../../../utils/justifiedLayoutCalculator';
import type { Photo } from '../../../../types';

const mounts: number[] = [];
vi.mock('../../PhotoCard', () => ({
  PhotoCard: ({ photo, style, containerProps }: {
    photo: Photo; style: React.CSSProperties; containerProps?: React.HTMLAttributes<HTMLDivElement>;
  }) => {
    React.useEffect(() => { mounts.push(photo.id); }, [photo.id]);
    return (
      <div data-testid="tile" data-photo={photo.id} data-likes={photo.like_count ?? 0} style={style} tabIndex={0} {...containerProps}>
        <button type="button" data-testid="tile-action" />
      </div>
    );
  },
}));
vi.mock('../../../common', () => ({ AuthenticatedImage: () => null }));
vi.mock('../../../gallery/FeedbackIdentityModal', () => ({ FeedbackIdentityModal: () => null }));
const themeMode = vi.hoisted(() => ({ current: 'rows' }));
vi.mock('../../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: { gallerySettings: { masonryMode: themeMode.current } } }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../../../hooks/useLocalizedDate', () => ({ useLocalizedDate: () => ({ format: () => '' }) }));

const makePhotos = (count: number): Photo[] => Array.from({ length: count }, (_, i) => ({
  id: i + 1,
  filename: `IMG_${i + 1}.jpg`,
  url: `/p/${i + 1}`,
  thumbnail_url: `/t/${i + 1}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  width: i % 3 === 0 ? 3000 : 4000,
  height: i % 3 === 0 ? 4000 : 3000,
} as Photo));

const layoutProps = (photos: Photo[]) => ({
  photos,
  slug: 'x',
  onPhotoClick: () => {},
  onDownload: () => {},
} as never);

let gridTop = 0;
let gridWidth = 1200;
/** Padding a CSS template puts on the grid, each side; the layout gets the width inside it. */
let gridPadding = 0;
let resizeCallbacks: Array<{ target: Element; run: (width: number) => void }> = [];

const tiles = () => screen.queryAllByTestId('tile');
const tileIds = () => tiles().map((tile) => Number(tile.dataset.photo));
const tileTop = (id: number) => parseFloat(tiles().find((tile) => Number(tile.dataset.photo) === id)!.style.top);

function scrollGridTo(top: number) {
  gridTop = top;
  act(() => { window.dispatchEvent(new Event('scroll')); });
}

beforeEach(() => {
  mounts.length = 0;
  themeMode.current = 'rows';
  gridTop = 0;
  gridWidth = 1200;
  resizeCallbacks = [];
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => gridWidth });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => gridWidth });
  gridPadding = 0;
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = computed(element, pseudo);
    if (!String((element as HTMLElement).className).includes('photo-grid')) return style;
    return new Proxy(style, {
      get: (target, key) => (key === 'paddingLeft' || key === 'paddingRight'
        ? `${gridPadding}px`
        : Reflect.get(target, key)),
    });
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

const row = (top: number, height = 100): RowBox => ({ top, bottom: top + height, from: 0, to: 1 });
// Ten 100px rows with a 10px gap: row i spans [110i, 110i + 100].
const tenRows = Array.from({ length: 10 }, (_, i) => row(i * 110));

describe('visibleRowRange', () => {
  it('is empty for an empty list', () => {
    expect(visibleRowRange([], 0, 800, 100)).toEqual({ start: 0, end: 0 });
  });

  it('holds a single row while it is within the overscan, and drops it beyond', () => {
    expect(visibleRowRange([row(0)], 0, 800, 0)).toEqual({ start: 0, end: 1 });
    expect(visibleRowRange([row(0)], 150, 950, 100)).toEqual({ start: 0, end: 1 });
    expect(visibleRowRange([row(0)], 250, 1050, 100)).toEqual({ start: 1, end: 1 });
    expect(visibleRowRange([row(0)], -2000, -1200, 100)).toEqual({ start: 0, end: 0 });
  });

  it('finds the rows that intersect the viewport', () => {
    // [330, 550]: rows 3 and 4 fully, row 2 ends at 320, row 5 starts at 550.
    expect(visibleRowRange(tenRows, 330, 550, 0)).toEqual({ start: 3, end: 5 });
    // A row cut by either edge counts.
    expect(visibleRowRange(tenRows, 319, 551, 0)).toEqual({ start: 2, end: 6 });
  });

  it('widens by the overscan on both sides and clamps at the ends', () => {
    expect(visibleRowRange(tenRows, 330, 550, 110)).toEqual({ start: 2, end: 6 });
    expect(visibleRowRange(tenRows, 330, 550, 5000)).toEqual({ start: 0, end: 10 });
    expect(visibleRowRange(tenRows, 5000, 5800, 0)).toEqual({ start: 10, end: 10 });
  });

  it('agrees with a linear scan over a real layout', () => {
    const { items } = calculateJustifiedLayout(createJustifiedPhotos(makePhotos(500)), {
      containerWidth: 1000, targetRowHeight: 250, spacing: 16,
    });
    const rows = buildRows(items);
    expect(rows.reduce((sum, r) => sum + (r.to - r.from), 0)).toBe(500);
    for (const viewTop of [-500, 0, 1234, 20000, rows[rows.length - 1].bottom - 10, 1e6]) {
      const lo = viewTop - 300;
      const hi = viewTop + 800 + 300;
      const expected = rows.map((r, i) => (r.bottom > lo && r.top < hi ? i : -1)).filter((i) => i >= 0);
      const { start, end } = visibleRowRange(rows, viewTop, viewTop + 800, 300);
      expect(Array.from({ length: end - start }, (_, i) => start + i)).toEqual(expected);
    }
  });
});

describe.each([
  ['Masonry rows', MasonryGalleryLayout],
])('%s windowing', (_name, Layout) => {
  it('mounts every tile of a small gallery', () => {
    render(<Layout {...layoutProps(makePhotos(WINDOW_MIN_PHOTOS - 1))} />);
    expect(tiles()).toHaveLength(WINDOW_MIN_PHOTOS - 1);
  });

  it('keeps 2000 photos to a small DOM while the container holds the full height', () => {
    const { container } = render(<Layout {...layoutProps(makePhotos(2000))} />);
    expect(tiles().length).toBeGreaterThan(0);
    expect(tiles().length).toBeLessThan(150);
    expect(tileIds()[0]).toBe(1);
    const grid = container.querySelector<HTMLElement>('.photo-grid')!;
    expect(parseFloat(grid.style.height)).toBeGreaterThan(50000);
  });

  it('follows the scroll position, and the grid moving under content above it', () => {
    render(<Layout {...layoutProps(makePhotos(2000))} />);
    const before = tileIds();

    scrollGridTo(-40000);
    const after = tileIds();
    expect(after.length).toBeLessThan(150);
    expect(after[0]).toBeGreaterThan(before[before.length - 1]);
    // Tiles sit at their own layout offsets, around the viewport.
    expect(tileTop(after[0])).toBeGreaterThan(40000 - 800 * 4);
    expect(tileTop(after[after.length - 1])).toBeLessThan(40000 + 800 * 5);

    // A notice above the grid pushes it down with no scroll event; the body
    // observer picks it up.
    gridTop = -20000;
    act(() => { resizeCallbacks.find((entry) => entry.target === document.body)!.run(0); });
    expect(tileIds()[tileIds().length - 1]).toBeLessThan(after[0]);
  });

  it('re-windows at once when the list changes under a deep scroll position', () => {
    const photos = makePhotos(2000);
    const { rerender } = render(<Layout {...layoutProps(photos)} />);
    scrollGridTo(-40000);

    // Reversed sort: the same offset now shows the other end of the album,
    // every tile at the offset the new layout gives it.
    rerender(<Layout {...layoutProps([...photos].reverse())} />);
    const ids = tileIds();
    expect(ids.length).toBeLessThan(150);
    expect(ids).toEqual([...ids].sort((a, b) => b - a));
    expect(new Set(tiles().map((tile) => `${tile.style.top}/${tile.style.left}`)).size).toBe(ids.length);
    expect(tileTop(ids[0])).toBeGreaterThan(40000 - 800 * 4);

    // A filter that leaves less than the scroll offset: nothing is stranded.
    rerender(<Layout {...layoutProps(photos.slice(0, 250))} />);
    expect(tileIds().every((id) => id <= 250)).toBe(true);
    expect(window.scrollBy).not.toHaveBeenCalled();
  });

  it('does not remount tiles when one photo is patched in the cache', () => {
    const photos = makePhotos(2000);
    const { rerender } = render(<Layout {...layoutProps(photos)} />);
    const mountedBefore = [...mounts];
    const target = tileIds()[3];

    // What the like patch does: a new array with one new photo object.
    rerender(<Layout {...layoutProps(photos.map((p) => (p.id === target ? { ...p, like_count: 1 } : p)))} />);
    expect(mounts).toEqual(mountedBefore);
    expect(tiles().find((tile) => Number(tile.dataset.photo) === target)!.dataset.likes).toBe('1');
  });

  it('keeps the viewer on the same photo when the container width changes', () => {
    render(<Layout {...layoutProps(makePhotos(2000))} />);
    scrollGridTo(-40000);
    const resizeTo = (width: number) => {
      gridWidth = width;
      act(() => {
        resizeCallbacks.filter((entry) => entry.target !== document.body).forEach((entry) => entry.run(width));
      });
    };
    // How far down a tile the top of the viewport is, as a fraction of it.
    const ratioOf = (tile: HTMLElement) =>
      (-gridTop - parseFloat(tile.style.top)) / parseFloat(tile.style.height);
    const find = (id: number) => tiles().find((tile) => Number(tile.dataset.photo) === id)!;

    // Put the top of the viewport 40% down a row; its first photo is the anchor.
    const anchorTile = tiles().find((tile) => parseFloat(tile.style.top) > 40000)!;
    const anchorId = Number(anchorTile.dataset.photo);
    const start = parseFloat(anchorTile.style.top) + parseFloat(anchorTile.style.height) * 0.4;
    scrollGridTo(-start);
    const ratio = ratioOf(find(anchorId));
    expect(ratio).toBeCloseTo(0.4, 5);

    // Narrower rows: the photo is far further down, and the page follows it.
    resizeTo(600);
    expect(tileTop(anchorId)).toBeGreaterThan(60000);
    expect(window.scrollBy).toHaveBeenCalledTimes(1);
    expect(ratioOf(find(anchorId))).toBeCloseTo(ratio, 5);

    // And back: the same pixel as before, not a row or two off.
    resizeTo(1200);
    expect(gridTop).toBeCloseTo(-start, 3);
    expect(ratioOf(find(anchorId))).toBeCloseTo(ratio, 5);
  });

  it('keeps the viewer on the same photo when the viewer changes the tile size', () => {
    window.localStorage.clear();
    resetGridDensityForTests();
    render(
      <GridDensityOffered.Provider value>
        <Layout {...layoutProps(makePhotos(2000))} />
      </GridDensityOffered.Provider>,
    );
    scrollGridTo(-40000);
    const ratioOf = (tile: HTMLElement) =>
      (-gridTop - parseFloat(tile.style.top)) / parseFloat(tile.style.height);
    const find = (id: number) => tiles().find((tile) => Number(tile.dataset.photo) === id)!;

    const anchorTile = tiles().find((tile) => parseFloat(tile.style.top) > 40000)!;
    const anchorId = Number(anchorTile.dataset.photo);
    scrollGridTo(-(parseFloat(anchorTile.style.top) + parseFloat(anchorTile.style.height) * 0.4));
    const ratio = ratioOf(find(anchorId));

    // Shorter rows at the same width: the photo moves up, and the page with it.
    act(() => setGridDensity('compact'));
    expect(window.scrollBy).toHaveBeenCalledTimes(1);
    expect(ratioOf(find(anchorId))).toBeCloseTo(ratio, 5);
    act(() => setGridDensity('default'));
  });

  it('anchors on what is at the top after content above the grid moved without a scroll', () => {
    render(<Layout {...layoutProps(makePhotos(2000))} />);
    scrollGridTo(-40000);
    const ratioOf = (tile: HTMLElement) =>
      (-gridTop - parseFloat(tile.style.top)) / parseFloat(tile.style.height);
    const offsetInto = (tile: HTMLElement, fraction: number) =>
      parseFloat(tile.style.top) + parseFloat(tile.style.height) * fraction;
    const before = tiles().find((tile) => parseFloat(tile.style.top) > 40000)!;
    scrollGridTo(-offsetInto(before, 0.4));

    // A notice above the grid pushes it down, to 70% down a photo some rows
    // earlier; only the body observer hears of it.
    const moved = tiles().find((tile) => parseFloat(tile.style.top) > 38000)!;
    const movedId = Number(moved.dataset.photo);
    expect(movedId).toBeLessThan(Number(before.dataset.photo));
    gridTop = -offsetInto(moved, 0.7);
    act(() => { resizeCallbacks.find((entry) => entry.target === document.body)!.run(0); });

    // The width change holds that photo, not the one from before the notice.
    gridWidth = 600;
    act(() => {
      resizeCallbacks.filter((entry) => entry.target !== document.body).forEach((entry) => entry.run(600));
    });
    const held = tiles().find((tile) => Number(tile.dataset.photo) === movedId)!;
    expect(ratioOf(held)).toBeCloseTo(0.7, 5);
  });

  it('does not take an anchor while a width change has not reached the layout yet', () => {
    render(<Layout {...layoutProps(makePhotos(2000))} />);
    scrollGridTo(-40000);
    const anchorTile = tiles().find((tile) => parseFloat(tile.style.top) > 40000)!;
    const anchorId = Number(anchorTile.dataset.photo);
    scrollGridTo(-(parseFloat(anchorTile.style.top) + parseFloat(anchorTile.style.height) * 0.4));

    // The window is already narrower and the toolbar above has re-wrapped,
    // pushing the grid 5000px; the layout still has the old width.
    gridWidth = 600;
    gridTop += 5000;
    act(() => { window.dispatchEvent(new Event('resize')); });
    act(() => {
      resizeCallbacks.filter((entry) => entry.target !== document.body).forEach((entry) => entry.run(600));
    });
    const held = tiles().find((tile) => Number(tile.dataset.photo) === anchorId)!;
    expect((-gridTop - parseFloat(held.style.top)) / parseFloat(held.style.height)).toBeCloseTo(0.4, 5);
  });

  it('takes the anchor in a grid a CSS template has padded', () => {
    render(<Layout {...layoutProps(makePhotos(2000))} />);
    const resizeTo = (width: number) => {
      gridWidth = width;
      act(() => {
        resizeCallbacks.filter((entry) => entry.target !== document.body)
          .forEach((entry) => entry.run(width - 2 * gridPadding));
      });
    };
    gridPadding = 16;
    resizeTo(1200);
    scrollGridTo(-40000);
    const anchorTile = tiles().find((tile) => parseFloat(tile.style.top) > 40000)!;
    const anchorId = Number(anchorTile.dataset.photo);
    scrollGridTo(-(parseFloat(anchorTile.style.top) + parseFloat(anchorTile.style.height) * 0.4));

    resizeTo(600);
    const held = tiles().find((tile) => Number(tile.dataset.photo) === anchorId)!;
    expect((-gridTop - parseFloat(held.style.top)) / parseFloat(held.style.height)).toBeCloseTo(0.4, 5);
  });

  it('keeps the anchor when a photo is patched while a width change is pending', () => {
    const photos = makePhotos(2000);
    const { rerender } = render(<Layout {...layoutProps(photos)} />);
    scrollGridTo(-40000);
    const anchorTile = tiles().find((tile) => parseFloat(tile.style.top) > 40000)!;
    const anchorId = Number(anchorTile.dataset.photo);
    scrollGridTo(-(parseFloat(anchorTile.style.top) + parseFloat(anchorTile.style.height) * 0.4));

    // Narrower already, the toolbar re-wrapped; a like lands before the
    // layout has the new width.
    gridWidth = 600;
    gridTop += 5000;
    rerender(<Layout {...layoutProps(photos.map((p) => (p.id === 1 ? { ...p, like_count: 1 } : p)))} />);
    act(() => {
      resizeCallbacks.filter((entry) => entry.target !== document.body).forEach((entry) => entry.run(600));
    });
    const held = tiles().find((tile) => Number(tile.dataset.photo) === anchorId)!;
    expect((-gridTop - parseFloat(held.style.top)) / parseFloat(held.style.height)).toBeCloseTo(0.4, 5);
  });

  // The first photo of the row crossing the top of the viewport, and how far
  // down it the viewport top is.
  const atTop = () => {
    const tile = tiles().find((t) => parseFloat(t.style.top) + parseFloat(t.style.height) > -gridTop)!;
    return {
      id: Number(tile.dataset.photo),
      ratio: Math.max(0, (-gridTop - parseFloat(tile.style.top)) / parseFloat(tile.style.height)),
    };
  };
  const ratioOfPhoto = (id: number) => {
    const tile = tiles().find((t) => Number(t.dataset.photo) === id)!;
    return (-gridTop - parseFloat(tile.style.top)) / parseFloat(tile.style.height);
  };
  const deliverWidth = (width: number) => {
    resizeCallbacks.filter((entry) => entry.target !== document.body).forEach((entry) => entry.run(width));
  };

  it('anchors on the new order when the list is re-sorted while a width change is pending', () => {
    const photos = makePhotos(2000);
    const { rerender } = render(<Layout {...layoutProps(photos)} />);
    scrollGridTo(-40000);
    const anchorTile = tiles().find((tile) => parseFloat(tile.style.top) > 40000)!;
    scrollGridTo(-(parseFloat(anchorTile.style.top) + parseFloat(anchorTile.style.height) * 0.4));

    gridWidth = 600;
    rerender(<Layout {...layoutProps([...photos].reverse())} />);
    const sorted = atTop();
    expect(sorted.id).not.toBe(Number(anchorTile.dataset.photo));
    act(() => { deliverWidth(600); });
    expect(ratioOfPhoto(sorted.id)).toBeCloseTo(sorted.ratio, 5);
  });

  it('takes a new anchor when the old one left the list in the same commit as a width change', () => {
    const photos = makePhotos(2000);
    const { rerender } = render(<Layout {...layoutProps(photos)} />);
    scrollGridTo(-40000);
    const anchorTile = tiles().find((tile) => parseFloat(tile.style.top) > 40000)!;
    const anchorId = Number(anchorTile.dataset.photo);
    scrollGridTo(-(parseFloat(anchorTile.style.top) + parseFloat(anchorTile.style.height) * 0.4));

    gridWidth = 600;
    act(() => {
      deliverWidth(600);
      rerender(<Layout {...layoutProps(photos.filter((p) => p.id !== anchorId))} />);
    });
    const next = atTop();

    gridWidth = 900;
    act(() => { deliverWidth(900); });
    expect(ratioOfPhoto(next.id)).toBeCloseTo(next.ratio, 5);
  });

  it('keeps a tile with a focused control mounted across a width change', () => {
    render(<Layout {...layoutProps(makePhotos(2000))} />);
    scrollGridTo(-40000);
    const card = tiles()[Math.floor(tiles().length / 2)];
    const control = card.querySelector('button')!;
    act(() => { control.focus(); });
    expect(document.activeElement).toBe(control);

    // The old row range applied to the new rows is other photos entirely.
    gridWidth = 600;
    act(() => { deliverWidth(600); });
    expect(control.isConnected).toBe(true);
    expect(document.activeElement).toBe(control);
  });

  it('does not remount the tiles in view when the rows are re-packed', () => {
    render(<Layout {...layoutProps(makePhotos(2000))} />);
    scrollGridTo(-40000);
    const anchorTile = tiles().find((tile) => parseFloat(tile.style.top) > 40000)!;
    const anchorId = Number(anchorTile.dataset.photo);
    scrollGridTo(-(parseFloat(anchorTile.style.top) + parseFloat(anchorTile.style.height) * 0.4));
    const mountsOf = (id: number) => mounts.filter((mounted) => mounted === id).length;
    const before = mountsOf(anchorId);

    gridWidth = 600;
    act(() => { deliverWidth(600); });
    expect(tiles().find((tile) => Number(tile.dataset.photo) === anchorId)).toBe(anchorTile);
    expect(mountsOf(anchorId)).toBe(before);
    expect(tiles().length).toBeLessThan(150);
  });

  it('holds the place in the new order when a sort and a width change land together', () => {
    const photos = makePhotos(2000);
    const { rerender } = render(<Layout {...layoutProps(photos)} />);
    scrollGridTo(-40000);
    const anchorTile = tiles().find((tile) => parseFloat(tile.style.top) > 40000)!;
    scrollGridTo(-(parseFloat(anchorTile.style.top) + parseFloat(anchorTile.style.height) * 0.4));
    const top = gridTop;

    gridWidth = 600;
    act(() => {
      deliverWidth(600);
      rerender(<Layout {...layoutProps([...photos].reverse())} />);
    });
    expect(window.scrollBy).not.toHaveBeenCalled();
    expect(gridTop).toBe(top);
  });
});

// The picker's "Google Photos" option stores masonryMode 'justified'. It is
// the rows mode under another name, not a fall-through to columns.
describe('Masonry with the stored justified mode', () => {
  const boxes = () => tiles().map((tile) => `${tile.style.left}/${tile.style.top}/${tile.style.width}/${tile.style.height}`);

  it('renders the same justified rows as rows mode', () => {
    const photos = makePhotos(12);
    const rows = render(<MasonryGalleryLayout {...layoutProps(photos)} />);
    const expected = boxes();
    expect(expected).toHaveLength(12);
    expect(new Set(tiles().map((tile) => tile.style.top)).size).toBeGreaterThan(1);
    rows.unmount();

    themeMode.current = 'justified';
    render(<MasonryGalleryLayout {...layoutProps(photos)} />);
    expect(boxes()).toEqual(expected);
  });

  it('is windowed like rows mode in a large gallery', () => {
    themeMode.current = 'justified';
    render(<MasonryGalleryLayout {...layoutProps(makePhotos(2000))} />);
    expect(tiles().length).toBeGreaterThan(0);
    expect(tiles().length).toBeLessThan(150);
  });
});
