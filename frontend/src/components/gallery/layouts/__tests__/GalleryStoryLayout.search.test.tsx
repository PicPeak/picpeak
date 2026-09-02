/**
 * Gallery search matched only the internal, renamed `filename`, never the
 * camera `original_filename` the guest can actually read on the card and in
 * the lightbox. Typing a substring of the visible name returned "no photos
 * found" for a photo sitting right there (QA P4-B.02 / G.08).
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import { GalleryStoryLayout } from '../GalleryStoryLayout';
import type { Photo } from '../../../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

vi.mock('framer-motion', () => {
  const stub = (tag: string) =>
    React.forwardRef<HTMLElement, Record<string, unknown>>(({ children, className, onClick }, ref) =>
      React.createElement(tag, { ref, className, onClick }, children as React.ReactNode)
    );
  return {
    motion: new Proxy({} as Record<string, unknown>, {
      get: (cache, tag: string) => (cache[tag] ??= stub(tag)),
    }),
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    useInView: () => true,
  };
});

vi.mock('../../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt} />,
  PoweredBy: () => null,
}));

vi.mock('../../PhotoLightbox', () => ({ PhotoLightbox: () => <div data-testid="lightbox" /> }));

vi.mock('../../../../services/feedback.service', () => ({
  feedbackService: { submitFeedback: vi.fn().mockResolvedValue({}) },
}));
vi.mock('../../../../services/gallery.service', () => ({
  galleryService: { downloadSelectedPhotos: vi.fn() },
}));
vi.mock('../../../../services/analytics.service', () => ({
  analyticsService: { trackGalleryEvent: vi.fn() },
}));

// Mirrors a real upload: the stored name is the renamed one, the camera name
// survives in original_filename and is what the guest sees.
const photos: Photo[] = [1, 2, 3].map((i) => ({
  id: i,
  filename: `ZZTEST-Hochzeit_individual_000${i}_a1b2c3.jpg`,
  original_filename: `zztest-photo-${i}.jpg`,
  url: `/api/gallery/x/photo/${i}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${i}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  category_name: 'Ceremony',
} as Photo));

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

function search(container: HTMLElement, term: string) {
  fireEvent.change(screen.getByPlaceholderText('Search memories...'), { target: { value: term } });
  return Array.from(container.querySelectorAll('a[data-photo-id]')).map((a) =>
    a.getAttribute('data-photo-id')
  );
}

describe('GalleryStoryLayout search', () => {
  it('matches a substring of the visible original filename', () => {
    const { container } = render(<GalleryStoryLayout {...props} />);
    expect(search(container, 'photo-2')).toEqual(['2']);
  });

  it('still matches the stored/renamed filename', () => {
    const { container } = render(<GalleryStoryLayout {...props} />);
    expect(search(container, 'individual_0003')).toEqual(['3']);
  });

  it('still matches the category name', () => {
    const { container } = render(<GalleryStoryLayout {...props} />);
    expect(search(container, 'ceremony')).toEqual(['1', '2', '3']);
  });

  it('returns nothing for a term present in neither name', () => {
    const { container } = render(<GalleryStoryLayout {...props} />);
    expect(search(container, 'nomatch')).toEqual([]);
  });
});
