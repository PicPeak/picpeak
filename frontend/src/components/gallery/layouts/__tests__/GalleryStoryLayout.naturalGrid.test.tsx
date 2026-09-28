/**
 * Issue 1709: the Story grid cropped every portrait photo into a fixed-height
 * landscape tile. `storyGridMode: 'natural'` lays scenes out as justified rows
 * from the stored dimensions; the default stays the original tile grid so
 * existing galleries keep their composition.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';

import { GalleryStoryLayout } from '../GalleryStoryLayout';
import type { Photo } from '../../../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

vi.mock('framer-motion', () => {
  const stub = (tag: string) =>
    React.forwardRef<HTMLElement, Record<string, unknown>>(({ children, className, onClick, style }, ref) =>
      React.createElement(tag, { ref, className, onClick, style }, children as React.ReactNode)
    );
  return {
    motion: new Proxy({} as Record<string, unknown>, {
      get: (cache, tag: string) => (cache[tag] ??= stub(tag)),
    }),
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    useInView: () => true,
  };
});

vi.mock('swiper/react', () => ({
  Swiper: ({ children }: { children?: React.ReactNode }) => <div data-testid="swiper">{children}</div>,
  SwiperSlide: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('swiper/modules', () => ({ FreeMode: {}, Mousewheel: {} }));
vi.mock('swiper/css', () => ({}));
vi.mock('swiper/css/free-mode', () => ({}));

vi.mock('../../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt} />,
  PoweredBy: () => null,
}));
vi.mock('../../PhotoLightbox', () => ({ PhotoLightbox: () => <div data-testid="lightbox" /> }));
vi.mock('../../DownloadQuotaNotice', () => ({ DownloadQuotaNotice: () => null }));
vi.mock('../../../../services/feedback.service', () => ({
  feedbackService: { submitFeedback: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../../../../services/gallery.service', () => ({
  galleryService: { downloadSelectedPhotos: vi.fn() },
}));
vi.mock('../../../../services/analytics.service', () => ({
  analyticsService: { trackGalleryEvent: vi.fn() },
}));

const photo = (id: number, width: number, height: number, category = 'Ceremony'): Photo => ({
  id,
  filename: `photo-${id}.jpg`,
  url: `/api/gallery/x/photo/${id}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  category_name: category,
  width,
  height,
} as Photo);

// Portrait, landscape, square, portrait, landscape, panorama: enough for
// several rows and a featured tile in fixed mode.
const photos: Photo[] = [
  photo(1, 2000, 3000),
  photo(2, 3000, 2000),
  photo(3, 2000, 2000),
  photo(4, 2000, 3000),
  photo(5, 3000, 2000),
  photo(6, 6000, 2000),
];

const props = {
  photos,
  slug: 'x',
  eventName: 'Sarah & Tom',
  onPhotoClick: () => {},
  onDownload: () => {},
  selectedPhotos: new Set<number>(),
  isSelectionMode: false,
  allowDownloads: true,
} as never;

let containerWidth = 1200;
const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() { return containerWidth; },
  });
  vi.stubGlobal('ResizeObserver', class {
    observe() {}
    disconnect() {}
    unobserve() {}
  });
});

afterEach(() => {
  if (originalOffsetWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidth);
  vi.unstubAllGlobals();
});

type Box = { id: string; left: number; top: number; width: number; height: number };

function boxes(container: HTMLElement): Box[] {
  return Array.from(container.querySelectorAll<HTMLElement>('.story-gallery-justified-box')).map((el) => ({
    id: el.querySelector('a[data-photo-id]')?.getAttribute('data-photo-id') ?? '',
    left: parseFloat(el.style.left),
    top: parseFloat(el.style.top),
    width: parseFloat(el.style.width),
    height: parseFloat(el.style.height),
  }));
}

describe('GalleryStoryLayout natural grid (issue 1709)', () => {
  it('keeps the original fixed tile grid by default', () => {
    const { container } = render(<GalleryStoryLayout {...props} />);
    expect(container.querySelector('.story-gallery-grid')).not.toBeNull();
    expect(container.querySelector('.story-gallery-justified')).toBeNull();
    expect(container.querySelector('.story-gallery-grid-featured')).not.toBeNull();
  });

  it('lays every photo out at its own aspect ratio on desktop', () => {
    const { container } = render(<GalleryStoryLayout {...props} storyGridMode="natural" />);
    expect(container.querySelector('.story-gallery-grid')).toBeNull();
    expect(container.querySelector('.story-gallery-grid-featured')).toBeNull();

    const laidOut = boxes(container);
    expect(laidOut.map((b) => b.id)).toEqual(['1', '2', '3', '4', '5', '6']);
    for (const box of laidOut) {
      const source = photos.find((p) => String(p.id) === box.id) as Photo;
      expect(box.width / box.height).toBeCloseTo((source.width as number) / (source.height as number), 1);
      expect(box.left + box.width).toBeLessThanOrEqual(containerWidth + 0.5);
      expect(box.width).toBeGreaterThan(0);
    }
    // A portrait photo is taller than wide: nothing is cropped to a landscape tile.
    const portrait = laidOut.find((b) => b.id === '1') as Box;
    expect(portrait.height).toBeGreaterThan(portrait.width);

    // The container is sized from the layout, so the page does not shift as images load.
    const grid = container.querySelector<HTMLElement>('.story-gallery-justified') as HTMLElement;
    const bottom = Math.max(...laidOut.map((b) => b.top + b.height));
    expect(parseFloat(grid.style.height)).toBeGreaterThanOrEqual(bottom - 0.5);
  });

  it('uses shorter rows on a phone and still fills the width', () => {
    containerWidth = 375;
    const { container } = render(<GalleryStoryLayout {...props} storyGridMode="natural" />);
    const laidOut = boxes(container);
    expect(laidOut).toHaveLength(6);
    for (const box of laidOut) {
      expect(box.left + box.width).toBeLessThanOrEqual(containerWidth + 0.5);
    }
    const tallest = Math.max(...laidOut.map((b) => b.height));
    expect(tallest).toBeLessThan(400);
    containerWidth = 1200;
  });

  it('keeps favourites, lightbox links and lazy placeholders on every card', () => {
    const { container } = render(<GalleryStoryLayout {...props} storyGridMode="natural" />);
    expect(container.querySelectorAll('.story-gallery-justified-box .story-photo-card')).toHaveLength(6);
    expect(container.querySelectorAll('.story-gallery-justified-box a[data-pswp-src]')).toHaveLength(6);
    expect(container.querySelectorAll('.story-gallery-justified-box .story-photo-card-btn')).toHaveLength(6);
  });

  it('sizes carousel slides from the aspect ratio in natural mode only', () => {
    const twoScenes = [...photos, photo(7, 2000, 3000, 'Party'), photo(8, 3000, 2000, 'Party')];
    const natural = render(<GalleryStoryLayout {...props} photos={twoScenes} storyGridMode="natural" />);
    const slides = Array.from(natural.container.querySelectorAll<HTMLElement>('.story-carousel-item'));
    expect(slides).toHaveLength(2);
    expect(slides[0].classList.contains('story-carousel-item--natural')).toBe(true);
    expect(slides[0].style.getPropertyValue('--story-ratio')).toBe(String(2000 / 3000));
    expect(slides[1].style.getPropertyValue('--story-ratio')).toBe(String(3000 / 2000));
    natural.unmount();

    const fixed = render(<GalleryStoryLayout {...props} photos={twoScenes} />);
    const fixedSlides = Array.from(fixed.container.querySelectorAll<HTMLElement>('.story-carousel-item'));
    expect(fixedSlides[0].classList.contains('story-carousel-item--natural')).toBe(false);
    expect(fixedSlides[0].style.getPropertyValue('--story-ratio')).toBe('');
  });
});
