/**
 * The Story card's hover caption printed every photo's filename with no way
 * to turn it off. It is now a layout setting (gallerySettings.storyShowFilenames),
 * off unless set, and names the photo the way the lightbox does when the
 * gallery shows original filenames (#508).
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

import { GalleryStoryLayout } from '../GalleryStoryLayout';
import { PhotoLabelsProvider } from '../../PhotoLabels';
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

const photo = (id: number, category: string): Photo => ({
  id,
  filename: `stored-${id}.jpg`,
  original_filename: `DSC_${id}.jpg`,
  url: `/api/gallery/x/photo/${id}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  category_name: category,
  width: 3000,
  height: 2000,
} as Photo);

// A grid scene and a carousel scene, so both card paths are covered.
const photos: Photo[] = [
  photo(1, 'Ceremony'), photo(2, 'Ceremony'), photo(3, 'Ceremony'),
  photo(4, 'Party'), photo(5, 'Party'),
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

const captions = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('.story-photo-card-caption')).map((el) => el.textContent);

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

describe('GalleryStoryLayout filename caption', () => {
  it('shows no filename caption by default', () => {
    const { container } = render(<GalleryStoryLayout {...props} />);
    expect(container.querySelectorAll('.story-photo-card')).toHaveLength(5);
    expect(captions(container)).toEqual([]);
  });

  it('shows the stored filename on every card when turned on', () => {
    const { container } = render(<GalleryStoryLayout {...props} storyShowFilenames />);
    expect(captions(container)).toEqual(['stored-1.jpg', 'stored-2.jpg', 'stored-3.jpg', 'stored-4.jpg', 'stored-5.jpg']);
  });

  it('shows the original filename when the gallery uses original filenames', () => {
    const { container } = render(<GalleryStoryLayout {...props} storyShowFilenames showOriginalFilename />);
    expect(captions(container)).toEqual(['DSC_1.jpg', 'DSC_2.jpg', 'DSC_3.jpg', 'DSC_4.jpg', 'DSC_5.jpg']);
  });

  it('shows the neutral label instead under neutral photo labels (issue 1733, E6)', () => {
    const { container } = render(
      <PhotoLabelsProvider neutral photos={photos}>
        <GalleryStoryLayout {...props} storyShowFilenames showOriginalFilename />
      </PhotoLabelsProvider>,
    );
    expect(captions(container)).toEqual(['Photo 1 of 5', 'Photo 2 of 5', 'Photo 3 of 5', 'Photo 4 of 5', 'Photo 5 of 5']);
    expect(container.innerHTML).not.toMatch(/DSC_|stored-/);
  });

  it('numbers against the photos its search leaves (issue 1733, E6)', () => {
    const { container } = render(
      <PhotoLabelsProvider neutral photos={photos}>
        <GalleryStoryLayout {...props} storyShowFilenames />
      </PhotoLabelsProvider>,
    );
    fireEvent.change(container.querySelector('.story-nav-search input')!, { target: { value: 'Party' } });
    expect(captions(container)).toEqual(['Photo 1 of 2', 'Photo 2 of 2']);
  });

  it('original filenames alone do not turn the caption on', () => {
    const { container } = render(<GalleryStoryLayout {...props} showOriginalFilename />);
    expect(captions(container)).toEqual([]);
  });

  it('applies to the natural (justified) grid as well', () => {
    const { container } = render(<GalleryStoryLayout {...props} storyGridMode="natural" storyShowFilenames />);
    expect(container.querySelectorAll('.story-gallery-justified-box .story-photo-card-caption')).toHaveLength(3);
    const hidden = render(<GalleryStoryLayout {...props} storyGridMode="natural" />);
    expect(hidden.container.querySelectorAll('.story-photo-card-caption')).toHaveLength(0);
  });
});
