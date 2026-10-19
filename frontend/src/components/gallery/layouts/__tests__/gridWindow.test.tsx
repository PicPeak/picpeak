/**
 * Row windowing for the CSS-grid layouts, Grid and Timeline (issue 2193).
 *
 * jsdom has no layout: the grid's resolved tracks, gap and padding are stood
 * up through getComputedStyle on `.photo-grid`, a tile's height through
 * getBoundingClientRect, and the scroll position is whatever `gridTop` says.
 */
import React from 'react';
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
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get: () => columns * TILE + (columns - 1) * GAP + 2 * gridPadding,
  });
  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = computed(element, pseudo);
    if (!String((element as HTMLElement).className).includes('photo-grid')) return style;
    const overrides: Record<string, string> = {
      gridTemplateColumns: Array.from({ length: columns }, () => `${TILE}px`).join(' '),
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
    const height = this.hasAttribute('data-grid-tile') ? TILE : 0;
    return { top, bottom: top + height, left: 0, right: 0, width: TILE, height, x: 0, y: top, toJSON: () => ({}) } as DOMRect;
  });
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('ResizeObserver', class {
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

  it('mounts every tile below the threshold', () => {
    render(<TimelineGalleryLayout {...layoutProps(makePhotos(50))} />);
    expect(tiles()).toHaveLength(50);
  });
});
