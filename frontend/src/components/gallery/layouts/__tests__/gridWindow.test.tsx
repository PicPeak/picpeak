/**
 * Row windowing for the CSS-grid layouts, Grid and Timeline (issue 2193).
 *
 * jsdom has no layout: the grid's resolved tracks, gap and padding are stood
 * up through getComputedStyle on `.photo-grid`, a tile's height through
 * getComputedStyle on the tile, and the scroll position is whatever `gridTop`
 * says.
 */
import React, { Suspense, startTransition } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

import { GridGalleryLayout } from '../GridGalleryLayout';
import { TimelineGalleryLayout } from '../TimelineGalleryLayout';
import { WINDOW_MIN_PHOTOS } from '../rowWindow';
import type { Photo } from '../../../../types';

vi.mock('../../PhotoCard', () => ({
  PhotoCard: ({ photo, onClick, containerProps }: {
    photo: Photo; onClick: () => void; containerProps?: React.HTMLAttributes<HTMLDivElement>;
  }) => (
    <div data-testid="tile" data-photo={photo.id} onClick={onClick} {...containerProps} />
  ),
}));
vi.mock('../../../common', () => ({ AuthenticatedImage: () => null }));
vi.mock('../../../gallery/FeedbackIdentityModal', () => ({ FeedbackIdentityModal: () => null }));
vi.mock('../../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: { gallerySettings: { timelineShowDates: true } } }),
}));
vi.mock('../../../../hooks/useLocalizedDate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../hooks/useLocalizedDate')>()),
  useLocalizedDate: () => ({ formatTime: (v: string) => v }),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const makePhotos = (count: number, day = (_i: number) => '2026-01-01'): Photo[] => Array.from({ length: count }, (_, i) => ({
  id: i + 1,
  filename: `IMG_${i + 1}.jpg`,
  url: `/p/${i + 1}`,
  thumbnail_url: `/t/${i + 1}`,
  type: 'individual',
  size: 1,
  // Descending within the day, so Timeline keeps the list order.
  uploaded_at: `${day(i)}T12:${String(59 - Math.floor(i / 60) % 60).padStart(2, '0')}:${String(59 - i % 60).padStart(2, '0')}Z`,
} as Photo));

const layoutProps = (photos: Photo[], onPhotoClick = () => {}) => ({
  photos,
  slug: 'x',
  onPhotoClick,
  onDownload: () => {},
} as never);

const TILE = 300;
const GAP = 16;
const PITCH = TILE + GAP;
let gridTop = 0;
let columns = 4;
let gridPadding = 0;
/** A transform on the tiles, which getBoundingClientRect includes. */
let tileScale = 1;
let gridDisplay = 'grid';
let tracks: string | null = null;
let autoRows = 'auto';
let tileMargin = 0;
/** The grid's rows as a browser resolves them; '' is none (jsdom). */
let gridRows = '';
/** Every ResizeObserver callback, to fire as a resize would. */
let resizeCallbacks: Array<() => void> = [];

const tiles = () => screen.queryAllByTestId('tile');
const tileIds = () => tiles().map((tile) => Number(tile.dataset.photo));
const grid = () => document.querySelector('.photo-grid') as HTMLElement;
const spacers = (container: HTMLElement = grid()) =>
  Array.from(container.children).filter((child) => child.getAttribute('aria-hidden') === 'true') as HTMLElement[];

function scrollGridTo(top: number) {
  gridTop = top;
  act(() => { window.dispatchEvent(new Event('scroll')); });
}

beforeEach(() => {
  gridTop = 0;
  columns = 4;
  gridPadding = 0;
  tileScale = 1;
  gridDisplay = 'grid';
  tracks = null;
  autoRows = 'auto';
  tileMargin = 0;
  gridRows = '';
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => columns * TILE + (columns - 1) * GAP + 2 * gridPadding,
  });
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = computed(element, pseudo);
    if ((element as HTMLElement).hasAttribute('data-grid-tile')) {
      const tile: Record<string, string> = {
        height: `${TILE - 2 * tileMargin}px`, boxSizing: 'border-box', marginTop: `${tileMargin}px`, marginBottom: `${tileMargin}px`,
      };
      return new Proxy(style, { get: (target, key) => (key in tile ? tile[key as string] : Reflect.get(target, key)) });
    }
    if (!String((element as HTMLElement).className).includes('photo-grid')) return style;
    const overrides: Record<string, string> = {
      display: gridDisplay,
      gridAutoRows: autoRows,
      gridTemplateRows: gridRows,
      gridTemplateColumns: tracks ?? Array.from({ length: columns }, () => `${TILE}px`).join(' '),
      rowGap: `${GAP}px`,
      paddingTop: `${gridPadding}px`,
      paddingLeft: `${gridPadding}px`,
      paddingRight: `${gridPadding}px`,
    };
    return new Proxy(style, { get: (target, key) => (key in overrides ? overrides[key as string] : Reflect.get(target, key)) });
  });
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const isGrid = String(this.className).includes('photo-grid');
    const top = isGrid ? gridTop : 0;
    const height = this.hasAttribute('data-grid-tile') ? TILE * tileScale : 0;
    return { top, bottom: top + height, left: 0, right: 0, width: TILE, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  resizeCallbacks = [];
  vi.stubGlobal('ResizeObserver', class {
    constructor(callback: () => void) { resizeCallbacks.push(callback); }
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  window.scrollBy = vi.fn((_x: number, y: number) => { gridTop -= y; }) as never;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Grid height as laid out: spacers, mounted rows, and the gaps between them. */
function laidOutHeight(container: HTMLElement, count: number) {
  const rows = Math.ceil(count / columns);
  const mountedRows = Math.ceil(tiles().filter((tile) => container.contains(tile)).length / columns);
  const parts = spacers(container).map((spacer) => parseFloat(spacer.style.height));
  const items = parts.length + mountedRows;
  return { rows, height: parts.reduce((a, b) => a + b, 0) + mountedRows * TILE + (items - 1) * GAP };
}

describe('Grid layout windowing', () => {
  it('mounts every tile of a small gallery, without spacers', () => {
    render(<GridGalleryLayout {...layoutProps(makePhotos(WINDOW_MIN_PHOTOS - 1))} />);
    expect(tiles()).toHaveLength(WINDOW_MIN_PHOTOS - 1);
    expect(spacers()).toHaveLength(0);
  });

  it('keeps 2000 photos to a small DOM while the grid keeps its full height', () => {
    render(<GridGalleryLayout {...layoutProps(makePhotos(2000))} />);
    // Viewport plus three viewports of overscan below: (800 + 2400) / 316 rows.
    expect(tiles().length).toBeLessThanOrEqual(12 * columns);
    expect(tileIds()[0]).toBe(1);
    const { rows, height } = laidOutHeight(grid(), 2000);
    expect(height).toBeCloseTo(rows * PITCH - GAP, 5);
  });

  it('follows the scroll position with whole rows', () => {
    render(<GridGalleryLayout {...layoutProps(makePhotos(2000))} />);
    scrollGridTo(-100 * PITCH);
    const ids = tileIds();
    expect(ids).not.toContain(1);
    expect(ids).toContain(100 * columns + 1);
    // The window starts at a row boundary, so CSS grid puts every tile in its column.
    expect((ids[0] - 1) % columns).toBe(0);
    expect(ids.length % columns).toBe(0);
    const [before] = spacers();
    expect(parseFloat(before.style.height)).toBeCloseTo(((ids[0] - 1) / columns) * PITCH - GAP, 5);
    const { rows, height } = laidOutHeight(grid(), 2000);
    expect(height).toBeCloseTo(rows * PITCH - GAP, 5);
  });

  it('opens the photo that was clicked, by its place in the list', () => {
    const onPhotoClick = vi.fn();
    render(<GridGalleryLayout {...layoutProps(makePhotos(2000), onPhotoClick)} />);
    scrollGridTo(-200 * PITCH);
    const tile = tiles().find((t) => t.dataset.photo === String(200 * columns + 2))!;
    fireEvent.click(tile);
    expect(onPhotoClick).toHaveBeenCalledWith(200 * columns + 1);
  });

  it('takes the column count and padding from the grid a CSS template styled', () => {
    columns = 3;
    gridPadding = 40;
    render(<GridGalleryLayout {...layoutProps(makePhotos(2000))} />);
    scrollGridTo(-(40 + 100 * PITCH));
    const ids = tileIds();
    expect((ids[0] - 1) % 3).toBe(0);
    expect(ids).toContain(100 * 3 + 1);
  });

  it('sizes the rows by the tile as laid out, not as a hover transform scales it', () => {
    tileScale = 1.02;
    render(<GridGalleryLayout {...layoutProps(makePhotos(2000))} />);
    scrollGridTo(-100 * PITCH);
    const { rows, height } = laidOutHeight(grid(), 2000);
    expect(height).toBeCloseTo(rows * PITCH - GAP, 5);
  });

  it('keeps the mounted tiles when a growing gallery crosses the threshold', () => {
    const { rerender } = render(<GridGalleryLayout {...layoutProps(makePhotos(WINDOW_MIN_PHOTOS - 1))} />);
    const first = tiles()[0];
    rerender(<GridGalleryLayout {...layoutProps(makePhotos(WINDOW_MIN_PHOTOS))} />);
    expect(tiles()[0]).toBe(first);
    expect(tiles().length).toBeLessThan(WINDOW_MIN_PHOTOS);
  });

  it('keeps the grid height in the render between a sort and its new window', () => {
    const photos = makePhotos(2000);
    const { rerender } = render(<GridGalleryLayout {...layoutProps(photos)} />);
    scrollGridTo(-100 * PITCH);
    // Every grid read, i.e. every layout the browser would do, sees the full height.
    const heights: number[] = [];
    const rect = HTMLElement.prototype.getBoundingClientRect;
    vi.mocked(rect).mockImplementation(function (this: HTMLElement) {
      if (String(this.className).includes('photo-grid')) heights.push(laidOutHeight(this, 2000).height);
      const isGrid = String(this.className).includes('photo-grid');
      const top = isGrid ? gridTop : 0;
      const height = this.hasAttribute('data-grid-tile') ? TILE : 0;
      return { top, bottom: top + height, left: 0, right: 0, width: TILE, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
    });
    // Even ids first: the photos on screen now sit in two runs a thousand photos apart.
    const sorted = [...photos.filter((p) => p.id % 2 === 0), ...photos.filter((p) => p.id % 2 === 1)];
    rerender(<GridGalleryLayout {...layoutProps(sorted)} />);
    expect(heights.length).toBeGreaterThan(0);
    for (const height of heights) expect(height).toBeCloseTo(Math.ceil(2000 / columns) * PITCH - GAP, 5);
  });

  it('mounts every tile when a template makes the container flex, tracks left over', () => {
    gridDisplay = 'flex';
    render(<GridGalleryLayout {...layoutProps(makePhotos(300))} />);
    expect(tiles()).toHaveLength(300);
    expect(spacers()).toHaveLength(0);
  });

  it('counts a tile margin into the row height', () => {
    tileMargin = 10;
    render(<GridGalleryLayout {...layoutProps(makePhotos(2000))} />);
    scrollGridTo(-100 * PITCH);
    const [before] = spacers();
    expect(parseFloat(before.style.height)).toBeCloseTo(((tileIds()[0] - 1) / columns) * PITCH - GAP, 5);
  });

  it('mounts every tile when a template sizes the rows itself', () => {
    autoRows = '200px';
    render(<GridGalleryLayout {...layoutProps(makePhotos(300))} />);
    expect(tiles()).toHaveLength(300);
  });

  it('stays windowed while each spacer sizes its own row', () => {
    const photos = makePhotos(2000);
    const { rerender } = render(<GridGalleryLayout {...layoutProps(photos)} />);
    scrollGridTo(-100 * PITCH);
    const [before, after] = spacers().map((spacer) => spacer.style.height);
    // Rounded the way a browser lays rows out, to 1/64 px.
    gridRows = `${Math.round(parseFloat(before) * 64) / 64}px ${TILE}px ${TILE}px ${after}`;
    const getStyle = vi.mocked(window.getComputedStyle);
    const reads = getStyle.mock.calls.length;
    rerender(<GridGalleryLayout {...layoutProps([...photos])} />);
    expect(getStyle.mock.calls.length).toBeGreaterThan(reads);
    expect(tiles().length).toBeLessThan(200);
    expect(spacers()).toHaveLength(2);
  });

  it('mounts every tile once a spacer turns out not to size its row', () => {
    // A template's grid-template-rows: the spacer then sits in a 300px row.
    gridRows = '300px 300px';
    render(<GridGalleryLayout {...layoutProps(makePhotos(2000))} />);
    scrollGridTo(-100 * PITCH);
    expect(tiles()).toHaveLength(2000);
    expect(spacers()).toHaveLength(0);
  });

  it('does not check the spacers of a render React did not commit', () => {
    const photos = makePhotos(2000);
    const never = new Promise<never>(() => {});
    let suspend = false;
    const Gate = () => { if (suspend) throw never; return null; };
    const App = ({ list }: { list: Photo[] }) => (
      <Suspense fallback={null}><GridGalleryLayout {...layoutProps(list)} /><Gate /></Suspense>
    );
    const { rerender } = render(<App list={photos} />);
    scrollGridTo(-100 * PITCH);
    const [before, after] = spacers().map((spacer) => spacer.style.height);
    gridRows = `${before} ${TILE}px ${after}`;
    // A transition that suspends: the grid renders 1000 photos, the DOM keeps 2000.
    suspend = true;
    act(() => { startTransition(() => { rerender(<App list={photos.slice(0, 1000)} />); }); });
    act(() => { resizeCallbacks.forEach((callback) => callback()); });
    expect(spacers().map((spacer) => spacer.style.height)).toEqual([before, after]);
    expect(tiles().length).toBeLessThan(200);
  });

  it('mounts every tile when the columns differ in width', () => {
    tracks = `${TILE}px ${2 * TILE}px`;
    render(<GridGalleryLayout {...layoutProps(makePhotos(300))} />);
    expect(tiles()).toHaveLength(300);
  });

  it('mounts every tile when the container is not a measurable grid', () => {
    vi.mocked(window.getComputedStyle).mockImplementation(() => ({ gridTemplateColumns: 'none' }) as CSSStyleDeclaration);
    render(<GridGalleryLayout {...layoutProps(makePhotos(300))} />);
    expect(tiles()).toHaveLength(300);
  });
});

describe('Timeline layout windowing', () => {
  it('windows each date group and keeps every header', () => {
    // Two days of 1000 photos each.
    const photos = makePhotos(2000, (i) => (i < 1000 ? '2026-01-02' : '2026-01-01'));
    render(<TimelineGalleryLayout {...layoutProps(photos)} />);
    const grids = Array.from(document.querySelectorAll('.photo-grid')) as HTMLElement[];
    expect(grids).toHaveLength(2);
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(2);
    // Both grids sit at the same mocked offset, so each holds one window.
    expect(tiles().length).toBeLessThanOrEqual(2 * 12 * columns);
    for (const container of grids) {
      const { rows, height } = laidOutHeight(container, 1000);
      expect(height).toBeCloseTo(rows * PITCH - GAP, 5);
    }
  });

  it('leaves small date groups alone in a large gallery', () => {
    // 300 days of one photo each: no group gets a window and its listeners.
    const addEventListener = vi.spyOn(window, 'addEventListener');
    const photos = makePhotos(300, (i) => new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10));
    render(<TimelineGalleryLayout {...layoutProps(photos)} />);
    expect(tiles()).toHaveLength(300);
    expect(addEventListener.mock.calls.filter(([type]) => type === 'scroll')).toHaveLength(0);
  });

  it('mounts every tile below the threshold', () => {
    render(<TimelineGalleryLayout {...layoutProps(makePhotos(50))} />);
    expect(tiles()).toHaveLength(50);
  });
});
