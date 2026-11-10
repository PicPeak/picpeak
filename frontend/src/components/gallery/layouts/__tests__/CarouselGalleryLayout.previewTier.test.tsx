/**
 * Issue 2465: Carousel's main stage rendered `photo.url`, the original
 * (often 5–12 MB), for every photo it showed, while every other layout shows
 * a photo through the lightbox preview tier. The stage takes the preview now;
 * a video keeps its poster, and a photo with no derivative falls back to the
 * original as before.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { CarouselGalleryLayout } from '../CarouselGalleryLayout';
import type { Photo } from '../../../../types';

vi.mock('react-intersection-observer', () => ({ useInView: () => ({ ref: vi.fn(), inView: true }) }));
vi.mock('../../../common', () => ({
  AuthenticatedImage: ({ src, alt, className }: { src: string; alt?: string; className?: string }) =>
    <img src={src} alt={alt} className={className} />,
  PoweredBy: () => null,
  Button: ({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...rest}>{children}</button>,
  Input: ({ label: _l, error: _e, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { label?: string; error?: string }) => <input {...rest} />,
}));
vi.mock('../../../../contexts/ThemeContext', () => ({ useTheme: () => ({ theme: { gallerySettings: {} } }) }));
vi.mock('../../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../../services/feedback.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/feedback.service')>()),
  feedbackService: { submitFeedback: vi.fn(), getPhotoFeedback: vi.fn() },
}));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' },
  }),
}));

const photo = (extra: Partial<Photo> = {}): Photo => ({
  id: 1,
  filename: 'IMG_1.jpg',
  url: '/api/gallery/x/photo/1',
  thumbnail_url: '/api/gallery/x/thumbnail/1',
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  width: 4000,
  height: 3000,
  ...extra,
} as Photo);

const stageSrc = (p: Photo) => {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const { container } = render(
    <QueryClientProvider client={queryClient}>
      <CarouselGalleryLayout {...({
        photos: [p],
        slug: 'x',
        onPhotoClick: vi.fn(),
        onDownload: vi.fn(),
        selectedPhotos: new Set<number>(),
        isSelectionMode: false,
        allowDownloads: true,
        feedbackEnabled: false,
      } as never)} />
    </QueryClientProvider>,
  );
  const stage = container.querySelector('.photo-card img');
  return stage?.getAttribute('src');
};

beforeEach(() => {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Carousel main stage (issue 2465)', () => {
  it('shows the lightbox preview, not the original', () => {
    const src = stageSrc(photo({ slideshow_url: '/api/gallery/x/preview/1' }));
    expect(src).toMatch(/^\/api\/gallery\/x\/preview\/1/);
  });

  it('prefers preview_url, which carries the admin preview settings', () => {
    const src = stageSrc(photo({ preview_url: '/api/gallery/x/preview/1?wm=1', slideshow_url: '/api/gallery/x/preview/1' }));
    expect(src).toMatch(/^\/api\/gallery\/x\/preview\/1\?wm=1/);
  });

  it('keeps a video on its poster', () => {
    const src = stageSrc(photo({ media_type: 'video', slideshow_url: null }));
    expect(src).toBe('/api/gallery/x/thumbnail/1');
  });

  it('falls back to the original when the server sends no preview', () => {
    expect(stageSrc(photo())).toBe('/api/gallery/x/photo/1');
  });
});
