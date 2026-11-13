/**
 * The row above the scenes (`beforeGrid`, issue 2355): Story puts it between
 * the hero and the first scene, never under the fixed nav, so the nav keeps
 * the hero behind it; an empty result keeps it so the filter can be cleared.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

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

const photo = (id: number): Photo => ({
  id,
  filename: `photo-${id}.jpg`,
  url: `/api/gallery/x/photo/${id}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  category_name: 'Ceremony',
  width: 3000,
  height: 2000,
} as Photo);

const props = {
  photos: [photo(1), photo(2)],
  slug: 'x',
  eventName: 'Sarah & Tom',
  onPhotoClick: () => {},
  onDownload: () => {},
  selectedPhotos: new Set<number>(),
  isSelectionMode: false,
  allowDownloads: true,
} as never;

const row = <button type="button">Find my photos with a selfie</button>;

describe('GalleryStoryLayout row above the scenes', () => {
  it('sits after the hero and before the scenes, outside the nav', () => {
    const { container } = render(<GalleryStoryLayout {...props} beforeGrid={row} />);
    const toolbar = container.querySelector('.story-toolbar') as HTMLElement;
    expect(toolbar).not.toBeNull();
    expect(toolbar.nextElementSibling?.tagName).toBe('MAIN');
    expect(toolbar.closest('nav')).toBeNull();
    expect(screen.getByRole('button', { name: 'Find my photos with a selfie' })).toBeTruthy();
  });

  it('keeps it when the filter leaves no photos', () => {
    const { container } = render(<GalleryStoryLayout {...props} photos={[]} beforeGrid={row} />);
    expect(container.querySelector('.story-toolbar--empty')).not.toBeNull();
  });

  it('renders no row without one', () => {
    const { container } = render(<GalleryStoryLayout {...props} />);
    expect(container.querySelector('.story-toolbar')).toBeNull();
  });
});
