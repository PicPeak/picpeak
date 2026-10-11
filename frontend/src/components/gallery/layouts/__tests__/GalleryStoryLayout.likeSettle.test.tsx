/**
 * A saved like keeps its heart while its row is still being refreshed.
 *
 * Since issue 1891 a like refreshes one row instead of the whole list, so
 * after two quick likes a payload can arrive that has the second photo's new
 * row but not yet the first one's. The first heart was cleared by that
 * payload, and "Favourite selected" would then have sent the like again,
 * which toggles it off on the server.
 */
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent, waitFor } from '@testing-library/react';

import { GalleryStoryLayout } from '../GalleryStoryLayout';
import type { Photo } from '../../../../types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
  }),
}));

// framer-motion's useInView needs IntersectionObserver, and the animation
// props would leak onto the DOM node.
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

vi.mock('../../PhotoLightbox', () => ({
  PhotoLightbox: ({ feedbackEnabled, initialIndex }: { feedbackEnabled?: boolean; initialIndex: number }) => (
    <div
      data-testid="lightbox"
      data-feedback-enabled={String(!!feedbackEnabled)}
      data-index={String(initialIndex)}
    />
  ),
}));

const submitFeedback = vi.fn().mockResolvedValue({});
vi.mock('../../../../services/feedback.service', () => ({
  feedbackService: { submitFeedback: (...args: unknown[]) => submitFeedback(...args) },
}));
vi.mock('../../../../services/gallery.service', () => ({
  galleryService: { downloadSelectedPhotos: vi.fn() },
}));
vi.mock('../../../../services/analytics.service', () => ({
  analyticsService: { trackGalleryEvent: vi.fn() },
}));

const photo = (id: number, is_liked: boolean) => ({
  id,
  filename: `IMG_${id}.jpg`,
  url: `/api/gallery/x/photo/${id}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  category_name: 'Ceremony',
  is_liked,
} as Photo);

const props = (photos: Photo[]) => ({
  photos,
  slug: 'x',
  eventName: 'Sarah & Tom',
  onPhotoClick: () => {},
  onDownload: () => {},
  selectedPhotos: new Set<number>(),
  isSelectionMode: false,
  allowDownloads: true,
  feedbackEnabled: true,
  feedbackOptions: { requireNameEmail: false, allowComments: true, allowRatings: true },
  onFeedbackChange: vi.fn(),
} as never);

describe('GalleryStoryLayout: a saved like and its row refresh', () => {
  it('keeps the first heart when the second photo\'s row arrives first', async () => {
    const { container, rerender } = render(<GalleryStoryLayout {...props([photo(1, false), photo(2, false)])} />);
    const hearts = () => Array.from(container.querySelectorAll('.story-photo-card-actions button'))
      .map((button) => button.classList.contains('favorite'));

    const buttons = container.querySelectorAll('.story-photo-card-actions button');
    fireEvent.click(buttons[0]);
    fireEvent.click(buttons[1]);
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(hearts()).toEqual([true, true]));

    // Photo 2's row is refreshed first; photo 1's still says "not liked".
    rerender(<GalleryStoryLayout {...props([photo(1, false), photo(2, true)])} />);
    expect(hearts()).toEqual([true, true]);

    // Then photo 1's row arrives, and from here the payload decides again:
    // an unlike made elsewhere shows up.
    rerender(<GalleryStoryLayout {...props([photo(1, true), photo(2, true)])} />);
    expect(hearts()).toEqual([true, true]);
    rerender(<GalleryStoryLayout {...props([photo(1, false), photo(2, true)])} />);
    expect(hearts()).toEqual([false, true]);
  });
});
