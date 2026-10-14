/**
 * The Story footer always read "Thank You" plus the welcome message or a
 * fixed thank-you line. Its title and text are now layout settings
 * (gallerySettings.storyFooterTitle / storyFooterText), plain text, clamped,
 * and empty keeps the old behaviour.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import { GalleryStoryLayout } from '../GalleryStoryLayout';
import type { Photo } from '../../../../types';
import { STORY_FOOTER_TEXT_MAX, STORY_FOOTER_TITLE_MAX } from '../../../../types/theme.types';

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

const DEFAULT_TEXT = 'For being part of our story and making our special day unforgettable.';
const footer = (container: HTMLElement) => ({
  title: container.querySelector('.story-footer-title')?.textContent,
  text: container.querySelector('.story-footer-text')?.textContent,
});

describe('GalleryStoryLayout footer', () => {
  it('keeps the thank-you title and line when nothing is set', () => {
    const { container } = render(<GalleryStoryLayout {...props} />);
    expect(footer(container)).toEqual({ title: 'Thank You', text: DEFAULT_TEXT });
  });

  it('falls back to the welcome message for the text, as before', () => {
    const { container } = render(<GalleryStoryLayout {...props} welcomeMessage="Welcome to our day" />);
    expect(footer(container)).toEqual({ title: 'Thank You', text: 'Welcome to our day' });
  });

  it('shows the footer title and text from the layout settings over both defaults', () => {
    const { container } = render(
      <GalleryStoryLayout
        {...props}
        welcomeMessage="Welcome to our day"
        storyFooterTitle="  See you soon  "
        storyFooterText="Photos by Anna"
      />
    );
    expect(footer(container)).toEqual({ title: 'See you soon', text: 'Photos by Anna' });
  });

  it('treats whitespace-only values as empty', () => {
    const { container } = render(<GalleryStoryLayout {...props} storyFooterTitle="   " storyFooterText={'\n '} />);
    expect(footer(container)).toEqual({ title: 'Thank You', text: DEFAULT_TEXT });
  });

  it('renders markup as text, never as HTML', () => {
    const { container } = render(
      <GalleryStoryLayout {...props} storyFooterTitle="<b>Hi</b>" storyFooterText={'<img src=x onerror="alert(1)">'} />
    );
    expect(footer(container)).toEqual({ title: '<b>Hi</b>', text: '<img src=x onerror="alert(1)">' });
    expect(container.querySelector('.story-footer b, .story-footer img')).toBeNull();
    expect(screen.getByRole('heading', { name: '<b>Hi</b>' })).toBeTruthy();
  });

  it('clamps values longer than the limits (the theme JSON is stored as sent)', () => {
    const { container } = render(
      <GalleryStoryLayout {...props} storyFooterTitle={'t'.repeat(200)} storyFooterText={'x'.repeat(1000)} />
    );
    expect(footer(container).title).toHaveLength(STORY_FOOTER_TITLE_MAX);
    expect(footer(container).text).toHaveLength(STORY_FOOTER_TEXT_MAX);
  });

  it('ignores a non-string value in a hand-edited theme', () => {
    const { container } = render(
      <GalleryStoryLayout {...props} {...({ storyFooterTitle: 42, storyFooterText: { a: 1 } } as never)} />
    );
    expect(footer(container)).toEqual({ title: 'Thank You', text: DEFAULT_TEXT });
  });
});
