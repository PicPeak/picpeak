/**
 * Windowing of the grids inside the full-page layouts (issue 2193, step 4):
 * Story's fixed and natural grids, and Premium's masonry album.
 *
 * jsdom has no layout: what a browser resolves comes through getComputedStyle
 * and getBoundingClientRect, and Premium's hidden copy of the album through
 * the latter. Positions were compared against Chromium, Firefox and WebKit
 * when this was written, which jsdom cannot show.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';

import { GalleryStoryLayout } from '../GalleryStoryLayout';
import { GalleryPremiumLayout } from '../GalleryPremiumLayout';
import { WINDOW_MIN_PHOTOS } from '../rowWindow';
import { layoutQuilted } from '../quiltedWindow';
import type { Photo } from '../../../../types';

// Marks whether the card was told to skip its entrance, and is in view at once.
const motionStub = (tag: string) => React.forwardRef<HTMLElement, Record<string, unknown>>(
  ({ children, className, onClick, style, initial, onViewportEnter, 'data-testid': testId, 'data-selected': selected }, ref) => {
    React.useEffect(() => { (onViewportEnter as (() => void) | undefined)?.(); }, [onViewportEnter]);
    return React.createElement(tag, {
      ref, className, onClick, style, 'data-testid': testId, 'data-selected': selected, 'data-entrance': initial === false ? 'skipped' : 'animated',
    }, children as React.ReactNode);
  },
);
vi.mock('framer-motion', () => ({
  motion: new Proxy({} as Record<string, unknown>, {
    get: (cache, tag: string) => (cache[tag] ??= motionStub(tag)),
  }),
  AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  useInView: () => true,
}));
vi.mock('react-intersection-observer', () => ({ useInView: () => ({ ref: vi.fn(), inView: true }) }));
vi.mock('swiper/react', () => ({
  Swiper: ({ children }: { children?: React.ReactNode }) => <div data-testid="swiper">{children}</div>,
  SwiperSlide: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('swiper/modules', () => ({ FreeMode: {}, Mousewheel: {} }));
vi.mock('swiper/css', () => ({}));
vi.mock('swiper/css/free-mode', () => ({}));
vi.mock('react-i18next', async () => ({
  ...await vi.importActual('react-i18next'),
  useTranslation: () => ({ t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key) }),
}));
vi.mock('../../../common', async () => ({
  ...await vi.importActual('../../../common'),
  AuthenticatedImage: ({ src, alt, className }: { src: string; alt?: string; className?: string }) => (
    <img src={src} alt={alt} className={className} />
  ),
  PoweredBy: () => null,
}));
vi.mock('../../PhotoLightbox', () => ({
  PhotoLightbox: ({ initialIndex, onClose }: { initialIndex: number; onClose: () => void }) => (
    <button type="button" data-testid="lightbox" data-index={initialIndex} onClick={onClose} />
  ),
}));
vi.mock('../../DownloadQuotaNotice', () => ({ DownloadQuotaNotice: () => null }));
vi.mock('../../../../services/feedback.service', () => ({
  feedbackService: { submitFeedback: vi.fn().mockResolvedValue({}), getPhotoFeedback: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../../../../services/gallery.service', () => ({
  galleryService: { downloadSelectedPhotos: vi.fn(), trackPhotoView: vi.fn() },
}));
vi.mock('../../../../services/analytics.service', () => ({ analyticsService: { trackGalleryEvent: vi.fn() } }));
vi.mock('../../../../hooks/usePublicSettings', () => ({ usePublicSettings: () => ({ data: undefined }) }));
vi.mock('../../../../hooks/useGallery', () => ({ useDownloadPhoto: () => ({ mutate: vi.fn() }) }));
vi.mock('../../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../../hooks/useInputMode', () => ({ useInputMode: () => 'mouse' }));
vi.mock('yet-another-react-lightbox', () => ({
  default: ({ open, index }: { open: boolean; index: number }) => (open ? <div data-testid="yarl" data-index={index} /> : null),
}));
vi.mock('yet-another-react-lightbox/plugins/thumbnails', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/zoom', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/fullscreen', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/download', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/captions', () => ({ default: () => null }));

const makePhotos = (count: number, category = (_i: number) => 'Ceremony'): Photo[] => Array.from({ length: count }, (_, i) => ({
  id: i + 1,
  filename: `photo-${i + 1}.jpg`,
  url: `/api/gallery/x/photo/${i + 1}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${i + 1}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  category_name: category(i),
  width: 3000,
  height: 2000,
} as Photo));

const layoutProps = (photos: Photo[], extra: Record<string, unknown> = {}) => ({
  photos,
  slug: 'x',
  eventName: 'Sarah & Tom',
  onPhotoClick: () => {},
  onDownload: () => {},
  selectedPhotos: new Set<number>(),
  isSelectionMode: false,
  allowDownloads: true,
  ...extra,
} as never);

const STORY_GRID = '.story-gallery-grid';
const CELL = 400;
const GAP = 16;
const PITCH = CELL + GAP;

/** The grid's top in the viewport: scrolling down makes it negative. */
let gridTop = 0;
let gridWidth = 1200;
/** What the stylesheet (or a template) resolves `.story-gallery-grid` to. */
let storyGrid: Record<string, string> = {};
let resizeCallbacks: Array<() => void> = [];
/** What the grid resolves to with cards in it, beyond its own tracks. */
let implicitTracks: Record<string, string> = {};

const storyCards = () => Array.from(document.querySelectorAll<HTMLElement>('.story-photo-card'));
const storyCard = (id: number) => document.querySelector<HTMLElement>(`a[data-photo-id="${id}"]`)?.closest<HTMLElement>('.story-photo-card') ?? null;
const premiumCards = () => screen.queryAllByTestId(/^photo-card-/);
const premiumCard = (id: number) => screen.queryByTestId(`photo-card-${id}`);

function scrollTo(top: number) {
  gridTop = top;
  act(() => { window.dispatchEvent(new Event('scroll')); });
}

beforeEach(() => {
  gridTop = 0;
  gridWidth = 1200;
  resizeCallbacks = [];
  implicitTracks = {};
  storyGrid = {
    display: 'grid',
    gridTemplateColumns: `${(gridWidth - 2 * GAP) / 3}px ${(gridWidth - 2 * GAP) / 3}px ${(gridWidth - 2 * GAP) / 3}px`,
    gridAutoRows: `${CELL}px`,
    rowGap: `${GAP}px`,
  };
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => gridWidth });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => gridWidth });

  const computed = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element, pseudo) => {
    const style = computed(element, pseudo);
    const name = String((element as HTMLElement).className);
    const resolved: Record<string, string> = name.includes('story-gallery-grid') && !name.includes('featured')
      ? { ...storyGrid, width: `${gridWidth}px`, ...(element.children.length > 0 ? implicitTracks : {}) }
      : name.includes('react-photo-album') ? { width: `${gridWidth}px`, columnCount: 'auto' } : {};
    return new Proxy(style, { get: (target, key) => (key in resolved ? resolved[key as string] : Reflect.get(target, key)) });
  });

  // The album's copy: a tile's box from its place in its track.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const rect = (top: number, left: number, height: number) => ({
      top, left, height, width: 300, bottom: top + height, right: left + 300, x: left, y: top, toJSON: () => ({}),
    } as DOMRect);
    const parent = this.parentElement;
    const track = parent?.parentElement;
    if (track?.getAttribute('aria-hidden') === 'true') {
      const index = Array.prototype.indexOf.call(parent!.children, this);
      const column = Array.prototype.indexOf.call(track.children, parent);
      return rect(index * 216, column * 316, 200);
    }
    if (this.getAttribute('aria-hidden') === 'true') return rect(0, 0, 100000);
    const windowed = /story-gallery|react-photo-album($| )/.test(String(this.className));
    return rect(windowed ? gridTop : 0, 0, 0);
  });

  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
  vi.stubGlobal('cancelAnimationFrame', () => {});
  vi.stubGlobal('ResizeObserver', class {
    constructor(private cb: () => void) {}
    observe() { resizeCallbacks.push(() => this.cb()); }
    unobserve() {}
    disconnect() {}
  });
  vi.stubGlobal('IntersectionObserver', class {
    observe() {}
    unobserve() {}
    disconnect() {}
  });
  window.scrollBy = vi.fn() as never;
  window.scrollTo = vi.fn() as never;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('layoutQuilted with other spans', () => {
  it('places a two-by-two first tile and fills around it', () => {
    const photos = [1, 2, 3, 4, 5].map((id) => ({ id }));
    const layout = layoutQuilted(photos, 3, 400, 16, (_photo, index) => (
      index === 0 ? { columns: 2, rows: 2 } : { columns: 1, rows: 1 }
    ))!;
    expect(layout.placements.get(1)).toEqual({ gridColumn: '1 / span 2', gridRow: '1 / span 2' });
    expect(layout.placements.get(2)).toEqual({ gridColumn: '3 / span 1', gridRow: '1 / span 1' });
    expect(layout.placements.get(3)).toEqual({ gridColumn: '3 / span 1', gridRow: '2 / span 1' });
    expect(layout.placements.get(4)).toEqual({ gridColumn: '1 / span 1', gridRow: '3 / span 1' });
    expect(layout.rowCount).toBe(3);
  });
});

describe('Story fixed grid windowing', () => {
  it('leaves a small gallery alone: every card, nothing pinned', () => {
    render(<GalleryStoryLayout {...layoutProps(makePhotos(WINDOW_MIN_PHOTOS - 1))} />);
    expect(storyCards()).toHaveLength(WINDOW_MIN_PHOTOS - 1);
    const grid = document.querySelector<HTMLElement>(STORY_GRID)!;
    expect(grid.getAttribute('style')).toBeNull();
    expect(storyCard(2)!.style.gridColumn).toBe('');
  });

  it('mounts 2000 photos as a small DOM, pinned to their grid lines', () => {
    render(<GalleryStoryLayout {...layoutProps(makePhotos(2000))} />);
    expect(storyCards().length).toBeLessThan(40);
    // 1 featured (4 cells), 1999 single cells, three to a row.
    const grid = document.querySelector<HTMLElement>(STORY_GRID)!;
    expect(grid.style.gridTemplateRows).toBe(`repeat(${Math.ceil(2003 / 3)}, ${CELL}px)`);
    expect(storyCard(1)!.style.gridColumn).toBe('1 / span 2');
    expect(storyCard(1)!.style.gridRow).toBe('1 / span 2');
    expect(storyCard(2)!.style.gridColumn).toBe('3 / span 1');
    expect(storyCard(4)!.style.gridColumn).toBe('1 / span 1');
    expect(storyCard(4)!.style.gridRow).toBe('3 / span 1');
  });

  it('gives the featured card one cell where the grid has one column', () => {
    storyGrid = { ...storyGrid, gridTemplateColumns: '360px', gridAutoRows: '300px', rowGap: '4px' };
    render(<GalleryStoryLayout {...layoutProps(makePhotos(2000))} />);
    expect(storyCard(1)!.style.gridColumn).toBe('1 / span 1');
    expect(document.querySelector<HTMLElement>(STORY_GRID)!.style.gridTemplateRows).toBe('repeat(2000, 300px)');
  });

  it('reads the grid again when a CSS template arrives without changing its size', async () => {
    render(<GalleryStoryLayout {...layoutProps(makePhotos(2000))} />);
    expect(storyCards().length).toBeLessThan(2000);
    storyGrid = { ...storyGrid, gridTemplateColumns: '600px 600px' };
    const template = document.createElement('style');
    await act(async () => { document.head.appendChild(template); });
    expect(document.querySelector<HTMLElement>(STORY_GRID)!.style.gridTemplateRows).toBe('');
    expect(storyCard(2000)).toBeTruthy();

    // And back: the window starts from the cards that are mounted.
    const card = storyCard(1)!;
    storyGrid = { ...storyGrid, gridTemplateColumns: '400px 400px 400px' };
    await act(async () => { template.textContent = '.x {}'; });
    expect(card.isConnected).toBe(true);
    expect(storyCard(2000)).toBeFalsy();
    template.remove();
  });

  it('keeps the top card when a breakpoint takes the grid to one column', () => {
    render(<GalleryStoryLayout {...layoutProps(makePhotos(2000))} />);
    scrollTo(-100 * PITCH);
    gridWidth = 600;
    storyGrid = { ...storyGrid, gridTemplateColumns: '600px', gridAutoRows: '300px', rowGap: '4px' };
    // The cards are still pinned to column three, which reads as extra tracks.
    implicitTracks = { gridTemplateColumns: '600px 0px 0px' };
    act(() => { resizeCallbacks.forEach((run) => run()); });
    expect(document.querySelector<HTMLElement>(STORY_GRID)!.style.gridTemplateRows).toBe('repeat(2000, 300px)');
    // Three to a row before, so a row of its own is three times as far down.
    expect((window.scrollBy as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
    const [, delta] = (window.scrollBy as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(100 * PITCH + delta).toBeGreaterThanOrEqual(296 * 304);
    expect(100 * PITCH + delta).toBeLessThanOrEqual(304 * 304);
  });

  it('follows the scroll position and opens the card that was clicked', () => {
    render(<GalleryStoryLayout {...layoutProps(makePhotos(2000))} />);
    scrollTo(-100 * PITCH);
    expect(storyCard(1)).toBeNull();
    const card = storyCard(300)!;
    expect(card).not.toBeNull();
    fireEvent.click(card.querySelector('a')!);
    expect(screen.getByTestId('lightbox').dataset.index).toBe('299');
  });

  it('keeps the window when the lightbox closes', () => {
    render(<GalleryStoryLayout {...layoutProps(makePhotos(2000))} />);
    scrollTo(-100 * PITCH);
    fireEvent.click(storyCard(300)!.querySelector('a')!);
    fireEvent.click(screen.getByTestId('lightbox'));
    expect(screen.queryByTestId('lightbox')).toBeNull();
    expect(storyCard(300)).not.toBeNull();
    expect(window.scrollTo).not.toHaveBeenCalled();
  });

  it('does not repeat a card\'s entrance when it comes back', () => {
    render(<GalleryStoryLayout {...layoutProps(makePhotos(2000))} />);
    expect(storyCard(2)!.dataset.entrance).toBe('animated');
    scrollTo(-100 * PITCH);
    expect(storyCard(2)).toBeNull();
    scrollTo(0);
    expect(storyCard(2)!.dataset.entrance).toBe('skipped');
    expect(storyCard(2)!.querySelector('img')!.className).toContain('opacity-100');
  });

  it('keeps a selection across the window', () => {
    render(<GalleryStoryLayout {...layoutProps(makePhotos(2000), { selectedPhotos: new Set([2]), isSelectionMode: true })} />);
    scrollTo(-100 * PITCH);
    scrollTo(0);
    expect(storyCard(2)!.dataset.selected).toBe('true');
  });

  it('places the cards anew after a filter, or they would stack', () => {
    const photos = makePhotos(500);
    const { rerender } = render(<GalleryStoryLayout {...layoutProps(photos)} />);
    rerender(<GalleryStoryLayout {...layoutProps(photos.slice(100))} />);
    expect(storyCard(101)!.style.gridRow).toBe('1 / span 2');
    expect(storyCard(102)!.style.gridColumn).toBe('3 / span 1');
  });

  it('does not repin the cards for a like', () => {
    const photos = makePhotos(500);
    const { rerender } = render(<GalleryStoryLayout {...layoutProps(photos)} />);
    const card = storyCard(2);
    rerender(<GalleryStoryLayout {...layoutProps(photos.map((photo) => ({ ...photo, like_count: 1 })))} />);
    expect(storyCard(2)).toBe(card);
  });

  it('leaves a small scene of a large gallery whole', () => {
    const photos = makePhotos(300, (i) => (i < 10 ? 'Small' : 'Other'));
    // Sorted so the small scene is the first and a grid. The second is a
    // carousel, which is not windowed; a third keeps it a grid.
    render(<GalleryStoryLayout {...layoutProps([...photos.slice(0, 10), ...photos.slice(10, 20).map((photo) => ({ ...photo, category_name: 'B' })), ...photos.slice(20).map((photo) => ({ ...photo, category_name: 'C' }))])} />);
    const [small, large] = Array.from(document.querySelectorAll<HTMLElement>(STORY_GRID));
    expect(small.querySelectorAll('.story-photo-card')).toHaveLength(10);
    expect(small.getAttribute('style')).toBeNull();
    expect(large.querySelectorAll('.story-photo-card').length).toBeLessThan(40);
  });

  it('leaves a carousel scene alone', () => {
    const photos = makePhotos(400, (i) => (i < 100 ? 'First' : 'Second'));
    render(<GalleryStoryLayout {...layoutProps(photos)} />);
    expect(screen.getByTestId('swiper').querySelectorAll('.story-photo-card')).toHaveLength(300);
  });

  it('mounts every card for a grid it does not know', () => {
    storyGrid = { ...storyGrid, gridAutoRows: 'auto' };
    render(<GalleryStoryLayout {...layoutProps(makePhotos(300))} />);
    expect(storyCards()).toHaveLength(300);
    expect(document.querySelector<HTMLElement>(STORY_GRID)!.getAttribute('style')).toBeNull();
  });

  it('mounts every card for a template with another column count', () => {
    storyGrid = { ...storyGrid, gridTemplateColumns: '600px 600px' };
    render(<GalleryStoryLayout {...layoutProps(makePhotos(300))} />);
    expect(storyCards()).toHaveLength(300);
  });
});

describe('Story natural grid windowing', () => {
  const natural = { storyGridMode: 'natural' };
  const grid = () => document.querySelector<HTMLElement>('.story-gallery-justified')!;

  it('leaves a small gallery alone', () => {
    render(<GalleryStoryLayout {...layoutProps(makePhotos(WINDOW_MIN_PHOTOS - 1), natural)} />);
    expect(storyCards()).toHaveLength(WINDOW_MIN_PHOTOS - 1);
  });

  it('mounts 2000 photos as a small DOM at their boxes, the grid at its full height', () => {
    render(<GalleryStoryLayout {...layoutProps(makePhotos(2000), natural)} />);
    expect(storyCards().length).toBeLessThan(60);
    expect(parseFloat(grid().style.height)).toBeGreaterThan(100000);
    expect((storyCard(1)!.parentElement as HTMLElement).style.top).toBe('0px');
  });

  it('follows the scroll position and keeps each box', () => {
    render(<GalleryStoryLayout {...layoutProps(makePhotos(2000), natural)} />);
    const height = parseFloat(grid().style.height);
    scrollTo(-height / 2);
    expect(storyCard(1)).toBeNull();
    const box = storyCard(1000)!.parentElement as HTMLElement;
    expect(parseFloat(box.style.top)).toBeGreaterThan(height / 2 - 4000);
    expect(parseFloat(box.style.top)).toBeLessThan(height / 2 + 4000);
  });

  it('does not repeat a card\'s entrance when it comes back', () => {
    render(<GalleryStoryLayout {...layoutProps(makePhotos(2000), natural)} />);
    const height = parseFloat(grid().style.height);
    scrollTo(-height / 2);
    scrollTo(0);
    expect(storyCard(2)!.dataset.entrance).toBe('skipped');
  });
});

describe('Premium album windowing', () => {
  const album = () => document.querySelector<HTMLElement>('.react-photo-album')!;
  const track = (index: number) => album().children[index] as HTMLElement;

  it('leaves a small gallery alone: the plain album, tiles in their tracks', () => {
    render(<GalleryPremiumLayout {...layoutProps(makePhotos(WINDOW_MIN_PHOTOS - 1))} />);
    expect(premiumCards()).toHaveLength(WINDOW_MIN_PHOTOS - 1);
    expect(premiumCard(1)!.style.position).toBe('');
    expect(premiumCard(1)!.style.width).toBe('100%');
    expect(album().style.position).toBe('');
    expect(album().style.height).toBe('');
  });

  it('mounts 2000 photos as a small DOM at the positions the browser gave them', () => {
    render(<GalleryPremiumLayout {...layoutProps(makePhotos(2000))} />);
    expect(premiumCards().length).toBeLessThan(100);
    expect(album().style.position).toBe('relative');
    expect(album().style.height).toBe('100000px');
    expect(premiumCard(2)!.style.position).toBe('absolute');
    expect(premiumCard(2)!.style.left).toBe('316px');
    expect(premiumCard(2)!.style.top).toBe('0px');
    expect(premiumCard(4)!.style.top).toBe('216px');
    expect(track(0).contains(premiumCard(4)!)).toBe(true);
  });

  it('removes the copy again', () => {
    render(<GalleryPremiumLayout {...layoutProps(makePhotos(500))} />);
    expect(document.querySelector('.react-photo-album[aria-hidden="true"]')).toBeNull();
  });

  it('follows the scroll position and opens the tile that was clicked', () => {
    render(<GalleryPremiumLayout {...layoutProps(makePhotos(2000))} />);
    scrollTo(-21600);
    expect(premiumCard(1)).toBeNull();
    // A hundred tiles down each of three tracks.
    const card = premiumCard(301)!;
    expect(card).not.toBeNull();
    fireEvent.click(card);
    expect(screen.getByTestId('yarl').dataset.index).toBe('300');
  });

  it('does not fade a tile in again when it comes back', () => {
    render(<GalleryPremiumLayout {...layoutProps(makePhotos(2000))} />);
    expect(premiumCard(1)!.dataset.entrance).toBe('animated');
    scrollTo(-21600);
    scrollTo(0);
    expect(premiumCard(1)!.dataset.entrance).toBe('skipped');
  });

  it('keeps a selection across the window', () => {
    render(<GalleryPremiumLayout {...layoutProps(makePhotos(2000), { selectedPhotos: new Set([1]), isSelectionMode: true })} />);
    scrollTo(-21600);
    scrollTo(0);
    expect(premiumCard(1)!.className).toContain('selected');
  });

  it('keeps each tile its own state as the window moves', () => {
    render(<GalleryPremiumLayout {...layoutProps(makePhotos(2000))} />);
    const card = premiumCard(202);
    scrollTo(-216);
    // Still the same element: keyed by photo, not by its place in the track.
    expect(premiumCard(202)).toBe(card);
  });

  it('does not fade tiles in again when a filter crosses the threshold', () => {
    const photos = makePhotos(300, (i) => (i < 150 ? 'A' : 'B'));
    render(<GalleryPremiumLayout {...layoutProps(photos)} />);
    expect(premiumCard(1)!.dataset.entrance).toBe('animated');
    // Another album below the threshold, so every tile is mounted anew.
    fireEvent.click(screen.getByRole('button', { name: 'A' }));
    expect(premiumCards()).toHaveLength(150);
    expect(premiumCard(1)!.dataset.entrance).toBe('skipped');
  });

  it('falls back to the plain album when a filter leaves a small gallery', () => {
    const photos = makePhotos(300);
    const { rerender } = render(<GalleryPremiumLayout {...layoutProps(photos)} />);
    expect(premiumCards().length).toBeLessThan(300);
    rerender(<GalleryPremiumLayout {...layoutProps(photos.slice(0, 150))} />);
    expect(premiumCards()).toHaveLength(150);
  });
});
