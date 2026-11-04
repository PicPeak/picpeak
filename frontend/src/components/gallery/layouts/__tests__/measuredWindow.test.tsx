/**
 * Windowing of the layouts placed from a hidden copy of the grid: Mosaic and
 * Masonry columns (issue 2193, step 3; Premium is in fullPageWindow.test.tsx).
 *
 * jsdom has no layout, so the copy is "laid out" here by getBoundingClientRect:
 * a tile's box comes from its place among its siblings. That the real boxes
 * match what a browser does with every tile mounted cannot be shown in jsdom:
 * it was compared tile by tile against Chromium, Firefox and WebKit.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, renderHook, screen, act, fireEvent } from '@testing-library/react';

import { MosaicGalleryLayout } from '../MosaicGalleryLayout';
import { MasonryGalleryLayout } from '../MasonryGalleryLayout';
import { WINDOW_MIN_PHOTOS } from '../rowWindow';
import { boxStyle, measuredItems, useMeasuredWindow, type TileBox } from '../measuredWindow';
import { feedbackService } from '../../../../services/feedback.service';
import type { Photo } from '../../../../types';

const mounts: number[] = [];
vi.mock('../../PhotoCard', () => ({
  PhotoCard: ({ photo, style, onClick, isSelected, liked, onLikeSuccess, onRequireIdentity }: {
    photo: Photo;
    style: React.CSSProperties;
    onClick?: (e: React.MouseEvent) => void;
    isSelected?: boolean;
    liked?: boolean;
    onLikeSuccess?: () => void;
    onRequireIdentity?: (action: 'like', photoId: number) => void;
  }) => {
    React.useEffect(() => { mounts.push(photo.id); }, [photo.id]);
    return (
      <div
        data-testid="tile"
        data-photo={photo.id}
        data-selected={isSelected ? 'yes' : 'no'}
        data-liked={liked ? 'yes' : 'no'}
        style={style}
        tabIndex={0}
        onClick={onClick}
      >
        <button type="button" data-testid="like" onClick={(e) => { e.stopPropagation(); onLikeSuccess?.(); }} />
        <button type="button" data-testid="identity" onClick={(e) => { e.stopPropagation(); onRequireIdentity?.('like', photo.id); }} />
      </div>
    );
  },
}));
vi.mock('../../../common', () => ({ AuthenticatedImage: () => null, Button: () => null, Input: () => null }));
vi.mock('../../../gallery/FeedbackIdentityModal', () => ({
  FeedbackIdentityModal: ({ isOpen, onSubmit }: { isOpen: boolean; onSubmit: (name: string, email: string) => void }) => (
    isOpen ? <button type="button" data-testid="identity-submit" onClick={() => onSubmit('Ann', 'a@b.c')} /> : null
  ),
}));
vi.mock('../../../../services/feedback.service', () => ({
  feedbackService: { submitFeedback: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: { gallerySettings: { masonryMode: 'columns', masonryGutter: 16 } } }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const makePhotos = (count: number, firstId = 1): Photo[] => Array.from({ length: count }, (_, i) => ({
  id: firstId + i,
  filename: `IMG_${firstId + i}.jpg`,
  url: `/p/${firstId + i}`,
  thumbnail_url: `/t/${firstId + i}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  width: 3000,
  height: i % 2 ? 2000 : 3000,
} as Photo));

const layoutProps = (photos: Photo[], extra: Record<string, unknown> = {}) => ({
  photos,
  slug: 'x',
  onPhotoClick: () => {},
  onDownload: () => {},
  ...extra,
} as never);

const COLUMNS = 4;
/** What the copy's "browser" gives every tile: rows this far apart. */
const ROW = 300;

let gridTop = 0;
let gridWidth = 1200;
let columnCount = String(COLUMNS);
/** How far apart the copy's tiles are, relative to ROW: a re-packed layout. */
let stretch = 1;
/** How much further down each column of the copy starts than the one before. */
let stagger = 0;
/** The page has no scrollbar yet, and gets one (15 px) once something is tall. */
let scrollbarPending = false;
/** The width each copy was laid out at. */
let copyWidths: string[] = [];
/** How many copies of the grid were laid out. */
let measurements = 0;
let resizeCallbacks: Array<{ target: Element; run: (width: number) => void }> = [];

const tiles = () => screen.queryAllByTestId('tile');
const tileIds = () => tiles().map((tile) => Number(tile.dataset.photo));
const grid = () => document.querySelector('.photo-grid:not([aria-hidden])') as HTMLElement;
const find = (id: number) => tiles().find((tile) => Number(tile.dataset.photo) === id);
const mountsOf = (id: number) => mounts.filter((mounted) => mounted === id).length;
const isCopy = (element: Element) => element.getAttribute('aria-hidden') === 'true';

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
  columnCount = String(COLUMNS);
  stretch = 1;
  stagger = 0;
  scrollbarPending = false;
  copyWidths = [];
  measurements = 0;
  resizeCallbacks = [];
  const copies = new WeakSet<HTMLElement>();
  const width = () => {
    if (scrollbarPending && document.querySelector<HTMLElement>('.photo-grid:not([aria-hidden])')?.style.height) {
      scrollbarPending = false;
      gridWidth -= 15;
    }
    return gridWidth;
  };
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: width });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: width });

  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = computed(element, pseudo);
    if (!String((element as HTMLElement).className).includes('photo-grid')) return style;
    const resolved: Record<string, string> = { width: `${(element as HTMLElement).clientWidth}px`, columnCount };
    return new Proxy(style, { get: (target, key) => (key in resolved ? resolved[key as string] : Reflect.get(target, key)) });
  });

  // A copy's tile: Mosaic's are its direct children, in rows of COLUMNS; a
  // columns-mode tile is a child of a column, the column's index its `x`.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const rect = (top: number, left: number, height: number) => ({
      top, left, height, width: 280, bottom: top + height, right: left + 280, x: left, y: top, toJSON: () => ({}),
    } as DOMRect);
    if (isCopy(this)) {
      if (!copies.has(this)) measurements += 1;
      copies.add(this);
      copyWidths.push(this.style.width);
      return rect(0, 0, ROW * 100);
    }
    const parent = this.parentElement;
    const index = parent ? Array.prototype.indexOf.call(parent.children, this) : 0;
    if (parent && isCopy(parent)) {
      return rect(Math.floor(index / COLUMNS) * ROW * stretch + (index % COLUMNS) * stagger, (index % COLUMNS) * 300, ROW - 16);
    }
    if (parent?.parentElement && isCopy(parent.parentElement)) {
      const column = Array.prototype.indexOf.call(parent.parentElement.children, parent);
      return rect(index * ROW * stretch, column * 300, ROW - 16);
    }
    const top = String(this.className).includes('photo-grid') ? gridTop : 0;
    return rect(top, 0, 0);
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
  window.scrollBy = vi.fn((_x: number, y: number) => { gridTop -= y; }) as never;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('measuredItems', () => {
  const box = (y: number, x = 0): TileBox => ({ x, y, width: 100, height: 100 });

  it('orders the tiles by height on the page, keeping the place in the list', () => {
    const items = measuredItems(new Map([[1, box(0)], [2, box(500)], [3, box(0, 100)], [4, box(200, 100)]]), [1, 2, 3, 4]);
    expect(items.map((item) => item.photoId)).toEqual([1, 3, 4, 2]);
    expect(items.map((item) => item.listIndex)).toEqual([0, 2, 3, 1]);
  });

  it('takes the place in the list from the list, not from the order of the columns', () => {
    const items = measuredItems(new Map([[3, box(0)], [1, box(0, 100)]]), [1, 2, 3]);
    expect(items.map((item) => [item.photoId, item.listIndex])).toEqual([[1, 0], [3, 2]]);
  });

  it('gives every tile a row of its own', () => {
    const items = measuredItems(new Map([[1, box(0)], [2, box(0)], [3, box(0)]]), [1, 2, 3]);
    expect(items.map((item) => item.rowIndex)).toEqual([0, 1, 2]);
  });
});

describe('useMeasuredWindow before the width is known', () => {
  it('mounts nothing on the way to a window: the skeleton held no tiles', () => {
    const ref = { current: document.createElement('div') };
    const ids = Array.from({ length: 2000 }, (_, index) => index + 1);
    const sizes: number[] = [];
    const { rerender } = renderHook(({ requested, pending }) => {
      const result = useMeasuredWindow(ref, ids, 'shape', () => new Map(), requested, pending);
      sizes.push(result.mounted.size);
      return result;
    }, { initialProps: { requested: false, pending: true } });
    rerender({ requested: true, pending: false });
    expect(Math.max(...sizes)).toBe(0);
  });

  it('mounts everything when windowing is off', () => {
    const ref = { current: document.createElement('div') };
    const { result } = renderHook(() => useMeasuredWindow(ref, [1, 2, 3], 'shape', () => new Map(), false));
    expect(result.current.mounted.size).toBe(3);
  });
});

describe('boxStyle', () => {
  it('leaves a tile without a box alone', () => {
    expect(boxStyle(undefined)).toBeUndefined();
  });

  it('places a tile at its box, its own margin being part of the box already', () => {
    expect(boxStyle({ x: 1, y: 2, width: 3, height: 4 })).toMatchObject({
      position: 'absolute', left: 1, top: 2, width: 3, height: 4, margin: 0,
    });
  });

  it('does not let a hover transition animate a tile to a new position', () => {
    expect(boxStyle({ x: 1, y: 2, width: 3, height: 4 })!.transitionProperty).not.toMatch(/all|top|left|width|height/);
  });
});

describe('Mosaic windowing', () => {
  it('leaves a small gallery alone: every tile, in columns, no copy', () => {
    render(<MosaicGalleryLayout {...layoutProps(makePhotos(WINDOW_MIN_PHOTOS - 1))} />);
    expect(tiles()).toHaveLength(WINDOW_MIN_PHOTOS - 1);
    expect(measurements).toBe(0);
    expect(grid().style.position).toBe('');
    expect(grid().style.height).toBe('');
    expect(find(1)!.style.position).toBe('');
    expect(find(1)!.style.aspectRatio).toBe('1');
  });

  it('mounts 2000 photos as a small DOM at the positions the browser gave them', () => {
    render(<MosaicGalleryLayout {...layoutProps(makePhotos(2000))} />);
    expect(tiles().length).toBeLessThan(100);
    expect(grid().style.position).toBe('relative');
    expect(grid().style.height).toBe(`${ROW * 100}px`);
    const tile = find(6)!;
    expect(tile.style.position).toBe('absolute');
    expect(tile.style.left).toBe('300px');
    expect(tile.style.top).toBe(`${ROW}px`);
    expect(tile.style.height).toBe(`${ROW - 16}px`);
    // Its own margin would push it off the box.
    expect(tile.style.margin).toBe('0px');
  });

  it('removes the copy again, and leaves nothing of its measuring on the grid', () => {
    render(<MosaicGalleryLayout {...layoutProps(makePhotos(500))} />);
    expect(document.querySelector('[aria-hidden="true"].photo-grid')).toBeNull();
    expect(grid().style.height).toBe(`${ROW * 100}px`);
  });

  it('lays the copy out fixed, where a tall box scrolls nothing up the tree', () => {
    const appended: HTMLElement[] = [];
    const append = Node.prototype.appendChild;
    vi.spyOn(Node.prototype, 'appendChild').mockImplementation(function (this: Node, node: Node) {
      if (node instanceof HTMLElement && node.getAttribute('aria-hidden') === 'true') appended.push(node);
      return append.call(this, node) as never;
    });
    render(<MosaicGalleryLayout {...layoutProps(makePhotos(500))} />);
    expect(appended[0].style.position).toBe('fixed');
  });

  it('follows the scroll position', () => {
    render(<MosaicGalleryLayout {...layoutProps(makePhotos(2000))} />);
    expect(tileIds()).toContain(1);
    scrollGridTo(-30000);
    expect(tileIds()).not.toContain(1);
    // Row 100 of the copy, at y = 30000, is in view.
    expect(tileIds()).toContain(401);
  });

  it('takes the viewport position from the DOM when content above the grid grows', () => {
    render(<MosaicGalleryLayout {...layoutProps(makePhotos(2000))} />);
    scrollGridTo(-30000);
    const before = tileIds();
    // A banner above pushes the grid down by six viewports, without a scroll.
    gridTop = -25000;
    act(() => { resizeCallbacks.find((entry) => entry.target === document.body)!.run(0); });
    expect(tileIds()).not.toEqual(before);
    expect(tileIds()).toContain(1 + Math.floor(25000 / ROW) * COLUMNS);
  });

  it('opens the photo that was clicked, by its place in the list', () => {
    const onPhotoClick = vi.fn();
    render(<MosaicGalleryLayout {...layoutProps(makePhotos(2000), { onPhotoClick })} />);
    scrollGridTo(-30000);
    fireEvent.click(find(401)!);
    expect(onPhotoClick).toHaveBeenCalledWith(400);
  });

  it('measures a new order, or the tiles would stack on the old boxes', () => {
    const photos = makePhotos(500);
    const { rerender } = render(<MosaicGalleryLayout {...layoutProps(photos)} />);
    const before = measurements;
    rerender(<MosaicGalleryLayout {...layoutProps([...photos].reverse())} />);
    expect(measurements).toBeGreaterThan(before);
    expect(find(500)!.style.top).toBe('0px');
    expect(find(500)!.style.left).toBe('0px');
  });

  it('does not measure a like, which changes no box and no key', () => {
    const photos = makePhotos(500);
    const { rerender } = render(<MosaicGalleryLayout {...layoutProps(photos)} />);
    const before = measurements;
    mounts.length = 0;
    rerender(<MosaicGalleryLayout {...layoutProps(photos.map((photo) => ({ ...photo, like_count: 3 })))} />);
    expect(measurements).toBe(before);
    expect(mounts).toEqual([]);
  });

  it('keeps the top photo through a width change, not the pixel offset', () => {
    render(<MosaicGalleryLayout {...layoutProps(makePhotos(1000))} />);
    scrollGridTo(-30000);
    // A narrower grid has taller tiles, and everything is further down.
    stretch = 2;
    resizeTo(900);
    expect(window.scrollBy).toHaveBeenCalled();
    // The anchor photo's row sits at the top of the viewport again.
    expect(gridTop).toBeLessThan(-59000);
    expect(gridTop).toBeGreaterThan(-61000);
  });

  it('holds on to the top photo while it still crosses the viewport, next to tiles that started higher', () => {
    stagger = 100;
    render(<MosaicGalleryLayout {...layoutProps(makePhotos(500))} />);
    // The third column of row 99, y 29900, is the first tile reaching past
    // this line.
    scrollGridTo(-30100);
    // Rows half as far apart: that tile is at y 15050, and the fourth column
    // of row 98, at 15000, now reaches past the line too and comes first.
    stretch = 0.5;
    resizeTo(900);
    expect(Math.abs(gridTop + 15250)).toBeLessThan(1);
    // Scrolling a pixel settles the anchor on what is at the top now.
    scrollGridTo(gridTop - 1);
    stretch = 1;
    resizeTo(1200);
    expect(Math.abs(gridTop + 30101)).toBeLessThan(2);
  });

  it('gives each box of the copy a child: WebKit balances empty boxes differently', () => {
    const appended: HTMLElement[] = [];
    const append = Node.prototype.appendChild;
    vi.spyOn(Node.prototype, 'appendChild').mockImplementation(function (this: Node, node: Node) {
      if (node instanceof HTMLElement && node.getAttribute('aria-hidden') === 'true') appended.push(node);
      return append.call(this, node) as never;
    });
    render(<MosaicGalleryLayout {...layoutProps(makePhotos(500))} />);
    expect(appended).toHaveLength(1);
    expect(appended[0].children).toHaveLength(500);
    expect(appended[0].children[0].children).toHaveLength(1);
  });

  it('measures again when a media query changes the columns at the same width', () => {
    render(<MosaicGalleryLayout {...layoutProps(makePhotos(500))} />);
    const before = measurements;
    columnCount = '3';
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(measurements).toBeGreaterThan(before);
  });

  it('does not measure a resize that changes nothing', () => {
    render(<MosaicGalleryLayout {...layoutProps(makePhotos(500))} />);
    const before = measurements;
    act(() => { window.dispatchEvent(new Event('resize')); });
    resizeTo(gridWidth);
    expect(measurements).toBe(before);
  });

  it('leaves a width change to the observer, or it would go by the old layout', () => {
    render(<MosaicGalleryLayout {...layoutProps(makePhotos(500))} />);
    const before = measurements;
    gridWidth = 1000;
    act(() => { window.dispatchEvent(new Event('resize')); });
    expect(measurements).toBe(before);
    resizeTo(1000);
    expect(measurements).toBe(before + 1);
  });

  it('measures again when a CSS template arrives', async () => {
    render(<MosaicGalleryLayout {...layoutProps(makePhotos(500))} />);
    const before = measurements;
    const style = document.createElement('style');
    await act(async () => {
      document.head.appendChild(style);
      await new Promise((resolve) => setTimeout(resolve));
    });
    expect(measurements).toBeGreaterThan(before);
    style.remove();
  });

  it('measures against the grid as it is once the page has its scrollbar', () => {
    // On a first render the empty grid leaves the page short. The grid at its
    // full height brings the scrollbar, and gives up that width.
    scrollbarPending = true;
    render(<MosaicGalleryLayout {...layoutProps(makePhotos(500))} />);
    expect(copyWidths[copyWidths.length - 1]).toBe('1185px');
    const before = measurements;
    resizeTo(1185);
    expect(measurements).toBe(before);
  });

  it('measures a width change', () => {
    render(<MosaicGalleryLayout {...layoutProps(makePhotos(500))} />);
    const before = measurements;
    resizeTo(1100);
    expect(measurements).toBeGreaterThan(before);
    expect(copyWidths[copyWidths.length - 1]).toBe('1100px');
  });

  it('keeps the mounted tiles when a growing gallery crosses the threshold', () => {
    const photos = makePhotos(WINDOW_MIN_PHOTOS - 1);
    const { rerender } = render(<MosaicGalleryLayout {...layoutProps(photos)} />);
    expect(mountsOf(1)).toBe(1);
    rerender(<MosaicGalleryLayout {...layoutProps([...photos, ...makePhotos(100, 1000)])} />);
    expect(tiles().length).toBeLessThan(150);
    expect(mountsOf(1)).toBe(1);
  });

  it('keeps a focused tile mounted through a layout change', () => {
    const photos = makePhotos(500);
    const { rerender } = render(<MosaicGalleryLayout {...layoutProps(photos)} />);
    const tile = find(3)!;
    tile.focus();
    rerender(<MosaicGalleryLayout {...layoutProps([photos[2], ...photos.slice(0, 2), ...photos.slice(3)])} />);
    expect(document.activeElement).toBe(tile);
    expect(mountsOf(3)).toBe(1);
  });

  it('keeps a like when the tile leaves the window and comes back', () => {
    render(<MosaicGalleryLayout {...layoutProps(makePhotos(2000))} />);
    fireEvent.click(find(1)!.querySelector('[data-testid="like"]')!);
    expect(find(1)!.dataset.liked).toBe('yes');
    scrollGridTo(-30000);
    expect(find(1)).toBeUndefined();
    scrollGridTo(0);
    expect(find(1)!.dataset.liked).toBe('yes');
  });

  it('seeds a like from the server and toggles it off', () => {
    const photos = makePhotos(300).map((photo) => ({ ...photo, is_liked: photo.id === 1 }));
    render(<MosaicGalleryLayout {...layoutProps(photos)} />);
    expect(find(1)!.dataset.liked).toBe('yes');
    fireEvent.click(find(1)!.querySelector('[data-testid="like"]')!);
    expect(find(1)!.dataset.liked).toBe('no');
  });

  it('keeps the identity prompt open when its tile leaves the window', async () => {
    render(<MosaicGalleryLayout {...layoutProps(makePhotos(2000))} />);
    fireEvent.click(find(1)!.querySelector('[data-testid="identity"]')!);
    scrollGridTo(-30000);
    expect(find(1)).toBeUndefined();
    await act(async () => { fireEvent.click(screen.getByTestId('identity-submit')); });
    expect(feedbackService.submitFeedback).toHaveBeenCalledWith('x', '1', expect.objectContaining({ feedback_type: 'like', guest_name: 'Ann' }));
  });

  it('keeps a selection across the window, and selects by photo id', () => {
    const onPhotoSelect = vi.fn();
    const selectedPhotos = new Set([1]);
    render(<MosaicGalleryLayout {...layoutProps(makePhotos(2000), { selectedPhotos, isSelectionMode: true, onPhotoSelect })} />);
    scrollGridTo(-30000);
    fireEvent.click(find(401)!);
    expect(onPhotoSelect).toHaveBeenCalledWith(401);
    scrollGridTo(0);
    expect(find(1)!.dataset.selected).toBe('yes');
  });
});

describe('Masonry columns windowing', () => {
  const column = (index: number) => grid().children[index] as HTMLElement;

  it('leaves a small gallery alone: every tile, in its column, no copy', () => {
    render(<MasonryGalleryLayout {...layoutProps(makePhotos(WINDOW_MIN_PHOTOS - 1))} />);
    expect(tiles()).toHaveLength(WINDOW_MIN_PHOTOS - 1);
    expect(measurements).toBe(0);
    expect(find(1)!.style.position).toBe('');
    expect(grid().style.height).toBe('');
    expect(grid().style.position).toBe('');
  });

  it('mounts 2000 photos as a small DOM at the positions the browser gave them', () => {
    render(<MasonryGalleryLayout {...layoutProps(makePhotos(2000))} />);
    expect(tiles().length).toBeLessThan(150);
    expect(grid().style.position).toBe('relative');
    expect(grid().style.height).toBe(`${ROW * 100}px`);
    const tile = find(1)!;
    expect(tile.style.position).toBe('absolute');
    expect(tile.style.top).toBe('0px');
    expect(tile.style.margin).toBe('0px');
  });

  it('keeps every tile in its column, so that a growing gallery does not remount it', () => {
    render(<MasonryGalleryLayout {...layoutProps(makePhotos(2000))} />);
    expect(column(0).contains(find(1)!)).toBe(true);
  });

  it('follows the scroll position', () => {
    render(<MasonryGalleryLayout {...layoutProps(makePhotos(2000))} />);
    scrollGridTo(-30000);
    expect(tileIds()).not.toContain(1);
    const tops = tiles().map((tile) => parseFloat(tile.style.top));
    expect(Math.min(...tops)).toBeGreaterThanOrEqual(30000 - 800 * 3 - ROW);
    expect(Math.max(...tops)).toBeLessThanOrEqual(30000 + 800 * 4 + ROW);
  });

  it('opens the photo that was clicked, by its place in the list', () => {
    const onPhotoClick = vi.fn();
    render(<MasonryGalleryLayout {...layoutProps(makePhotos(2000), { onPhotoClick })} />);
    fireEvent.click(find(7)!);
    expect(onPhotoClick).toHaveBeenCalledWith(6);
  });

  it('does not measure a like, and a selection survives the window', () => {
    const photos = makePhotos(500);
    const props = { selectedPhotos: new Set([1]), isSelectionMode: true };
    const { rerender } = render(<MasonryGalleryLayout {...layoutProps(photos, props)} />);
    const before = measurements;
    rerender(<MasonryGalleryLayout {...layoutProps(photos.map((photo) => ({ ...photo, like_count: 2 })), props)} />);
    expect(measurements).toBe(before);
    scrollGridTo(-30000);
    scrollGridTo(0);
    expect(find(1)!.dataset.selected).toBe('yes');
  });

  it('measures a new order, or the tiles would stack on the old boxes', () => {
    const photos = makePhotos(500);
    const { rerender } = render(<MasonryGalleryLayout {...layoutProps(photos)} />);
    const before = measurements;
    rerender(<MasonryGalleryLayout {...layoutProps([...photos].reverse())} />);
    expect(measurements).toBeGreaterThan(before);
    expect(find(500)!.style.top).toBe('0px');
  });

  it('keeps the top photo through a width change that keeps the column count', () => {
    render(<MasonryGalleryLayout {...layoutProps(makePhotos(2000))} />);
    scrollGridTo(-30000);
    stretch = 2;
    resizeTo(1100);
    expect(window.scrollBy).toHaveBeenCalled();
    expect(gridTop).toBeLessThan(-59000);
    expect(gridTop).toBeGreaterThan(-61000);
  });

  it('keeps the top photo through a change of column count', () => {
    render(<MasonryGalleryLayout {...layoutProps(makePhotos(2000))} />);
    scrollGridTo(-30000);
    stretch = 2;
    // Tiles go to other columns, which is not a sort: the anchor is kept.
    resizeTo(900);
    expect(window.scrollBy).toHaveBeenCalled();
    expect(gridTop).toBeLessThan(-50000);
  });

  it('keeps the mounted tiles when a growing gallery crosses the threshold', () => {
    const photos = makePhotos(WINDOW_MIN_PHOTOS - 1);
    const { rerender } = render(<MasonryGalleryLayout {...layoutProps(photos)} />);
    expect(mountsOf(1)).toBe(1);
    rerender(<MasonryGalleryLayout {...layoutProps([...photos, ...makePhotos(100, 1000)])} />);
    expect(mountsOf(1)).toBe(1);
  });
});
