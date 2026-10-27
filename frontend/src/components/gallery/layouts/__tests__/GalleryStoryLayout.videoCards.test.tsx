/**
 * Story cards and videos (issue 2284). A card rendered lightboxImageUrl,
 * which falls back to `url` when a photo has no preview or slideshow tier,
 * and a video has neither: every Story video card fetched the clip itself as
 * an image and showed no poster. A video card now shows its poster
 * (thumbnail_url) and the same Video badge the other layouts carry.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';

import { GalleryStoryLayout } from '../GalleryStoryLayout';
import type { Photo } from '../../../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string'
      ? fallback
      // The options form, as the neutral label uses it: interpolated.
      : typeof fallback === 'object' && fallback && 'defaultValue' in fallback
        ? String((fallback as { defaultValue: string }).defaultValue)
          .replace(/{{(\w+)}}/g, (_, name: string) => String((fallback as Record<string, unknown>)[name]))
        : key),
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
  AuthenticatedImage: ({ src, alt, className }: { src: string; alt?: string; className?: string }) => (
    <img src={src} alt={alt} className={className} />
  ),
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

const photo = (id: number, category: string, extra: Partial<Photo> = {}): Photo => ({
  id,
  filename: `stored-${id}.jpg`,
  url: `/api/gallery/x/photo/${id}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
  slideshow_url: `/api/gallery/x/preview/${id}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  category_name: category,
  width: 3000,
  height: 2000,
  ...extra,
} as Photo);

// A video has no preview tier: the server sends null for both derivatives.
const video = (id: number, category: string, extra: Partial<Photo> = {}) => photo(id, category, {
  filename: `clip-${id}.mp4`,
  media_type: 'video',
  mime_type: 'video/mp4',
  slideshow_url: null,
  preview_url: null,
  thumbnail_url: `/api/gallery/x/thumbnail/${id}?poster=3`,
  ...extra,
});

// A grid scene and a carousel scene, so both card paths are covered.
const photos: Photo[] = [
  photo(1, 'Ceremony'), video(2, 'Ceremony'), photo(3, 'Ceremony'),
  video(4, 'Party', { media_type: 'image', mime_type: 'video/quicktime' }), photo(5, 'Party'),
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

const originalOffsetWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');

beforeEach(() => {
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1200 });
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

const cardImages = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.story-photo-card a img')).map((img) => img.getAttribute('src'));

describe('GalleryStoryLayout video cards (issue 2284)', () => {
  it.each(['grid', 'natural'] as const)('shows a video by its poster, never the clip, in the %s grid', (mode) => {
    const { container } = render(<GalleryStoryLayout {...props} storyGridMode={mode} />);
    const srcs = cardImages(container);
    expect(srcs).toContain('/api/gallery/x/thumbnail/2?poster=3');
    expect(srcs).toContain('/api/gallery/x/thumbnail/4?poster=3');
    // A photo keeps its preview tier (a width may ride along).
    expect(srcs.some((src) => src?.startsWith('/api/gallery/x/preview/1'))).toBe(true);
    expect(srcs.some((src) => src?.includes('/photo/'))).toBe(false);
  });

  it('marks each video card, and only those', () => {
    const { container } = render(<GalleryStoryLayout {...props} />);
    const badged = Array.from(container.querySelectorAll('.story-photo-card'))
      .filter((card) => card.querySelector('[data-testid="story-video-badge"]'))
      .map((card) => card.querySelector('a')?.getAttribute('data-photo-id'));
    expect(badged).toEqual(['2', '4']);
  });
});
