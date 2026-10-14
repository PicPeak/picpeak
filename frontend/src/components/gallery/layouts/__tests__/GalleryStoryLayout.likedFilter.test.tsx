/**
 * The Story nav heart showed the viewer's liked count but did nothing on
 * click. It now drives the gallery's "Liked" filter: the harness below holds
 * that filter the way GalleryView does and feeds the layout the result of the
 * real useGalleryFiltering, so the layout only sees already-filtered photos.
 */
import React, { useState } from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import { GalleryStoryLayout } from '../GalleryStoryLayout';
import { useGalleryFiltering } from '../../hooks/useGalleryFiltering';
import type { FeedbackFilterType } from '../../GalleryFilter';
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
  Button: ({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) => (
    <button type="button" onClick={onClick}>{children}</button>
  ),
}));
vi.mock('../../PhotoLightbox', () => ({ PhotoLightbox: () => <div data-testid="lightbox" /> }));
const submitFeedback = vi.hoisted(() => vi.fn().mockResolvedValue({}));
vi.mock('../../../../services/feedback.service', () => ({
  feedbackService: { submitFeedback },
}));
vi.mock('../../../../services/gallery.service', () => ({
  galleryService: { downloadSelectedPhotos: vi.fn() },
}));
vi.mock('../../../../services/analytics.service', () => ({
  analyticsService: { trackGalleryEvent: vi.fn() },
}));

// Photo 2 is liked by someone else only (like_count without is_liked): the
// heart must not show it, since it is not this viewer's like.
const makePhotos = (liked: number[]): Photo[] => [1, 2, 3, 4].map((i) => ({
  id: i,
  filename: `IMG_${i}.jpg`,
  url: `/api/gallery/x/photo/${i}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${i}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  category_name: 'Ceremony',
  is_liked: liked.includes(i),
  like_count: liked.includes(i) || i === 2 ? 1 : 0,
} as Photo));

function Harness({ source }: { source: Photo[] }) {
  const [activeFilters, setActiveFilters] = useState<FeedbackFilterType[]>([]);
  const photos = useGalleryFiltering({
    sourcePhotos: source, folderId: null, selectedCategoryId: null, searchTerm: '',
    sortBy: 'name', sortDesc: false, watermarkEnabled: false, slug: 'x',
    activeFilters, activeColorFilters: [], mediaFilter: 'all', isGuestIdentityMode: false,
    myFeedbackPhotoIds: { liked: new Set(), favorited: new Set(), rated: new Set(), commented: new Set() },
    selectedPersonIds: [], peopleMatchAny: false, likedIsOwn: true,
  });
  return (
    <GalleryStoryLayout
      {...({
        photos,
        slug: 'x',
        eventName: 'Sarah & Tom',
        onPhotoClick: () => {},
        onDownload: () => {},
        selectedPhotos: new Set<number>(),
        allowDownloads: false,
        feedbackEnabled: true,
        feedbackOptions: { allowLikes: true },
        likedOnly: activeFilters.includes('liked'),
        onToggleLikedOnly: () => setActiveFilters((prev) => (prev.includes('liked') ? [] : ['liked'])),
      } as never)}
    />
  );
}

const shownIds = (container: HTMLElement) =>
  Array.from(container.querySelectorAll('main img'))
    .map((img) => Number(/\/(\d+)$/.exec(img.getAttribute('src') || '')?.[1]))
    .filter((id) => !Number.isNaN(id))
    .sort();

describe('GalleryStoryLayout nav heart filters to the viewer\'s likes', () => {
  it('shows only liked photos on click and every photo on the next click', () => {
    const { container } = render(<Harness source={makePhotos([1, 3])} />);
    const heart = screen.getByTestId('story-nav-liked');
    expect(heart).toHaveAttribute('aria-pressed', 'false');
    expect(heart).toHaveAttribute('aria-label', 'Show only photos I liked (2)');
    expect(shownIds(container)).toEqual([1, 2, 3, 4]);

    fireEvent.click(heart);
    expect(screen.getByTestId('story-nav-liked')).toHaveAttribute('aria-pressed', 'true');
    expect(shownIds(container)).toEqual([1, 3]);

    fireEvent.click(screen.getByTestId('story-nav-liked'));
    expect(screen.getByTestId('story-nav-liked')).toHaveAttribute('aria-pressed', 'false');
    expect(shownIds(container)).toEqual([1, 2, 3, 4]);
  });

  it('explains an empty liked view and offers the way back', () => {
    const { container } = render(<Harness source={makePhotos([])} />);
    fireEvent.click(screen.getByTestId('story-nav-liked'));
    expect(screen.getByText(/not liked any photos here yet/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show all photos' }));
    expect(shownIds(container)).toEqual([1, 2, 3, 4]);
    expect(screen.getByTestId('story-nav-liked')).toHaveAttribute('aria-pressed', 'false');
  });

  const navLabel = () => screen.getByTestId('story-nav-liked').getAttribute('aria-label');
  const likeCard = (container: HTMLElement, id: number) => fireEvent.click(
    container.querySelector(`a[data-photo-id="${id}"]`)!.closest('.story-photo-card')!
      .querySelector('.story-photo-card-btn') as HTMLElement,
  );

  it('keeps a saved like until a payload confirms it', async () => {
    submitFeedback.mockClear();
    const { container, rerender } = render(<Harness source={makePhotos([1, 3])} />);
    likeCard(container, 4);
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 0));
    expect(navLabel()).toBe('Show only photos I liked (3)');
    // Saved, but the refetch it asked for has not landed: a payload from
    // before the like still says not liked and must not undo the heart.
    rerender(<Harness source={makePhotos([1, 3]).map((p) => ({ ...p }))} />);
    expect(navLabel()).toBe('Show only photos I liked (3)');
    rerender(<Harness source={makePhotos([1, 3, 4])} />);
    expect(navLabel()).toBe('Show only photos I liked (3)');
    // Confirmed; from here the payload alone decides again.
    rerender(<Harness source={makePhotos([1, 3])} />);
    expect(navLabel()).toBe('Show only photos I liked (2)');
  });

  it('lets an unconfirmed saved like lapse, so a change made elsewhere shows', async () => {
    submitFeedback.mockClear();
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000_000);
      const { container, rerender } = render(<Harness source={makePhotos([1, 3])} />);
      likeCard(container, 4);
      await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1));
      await new Promise((r) => setTimeout(r, 0));
      rerender(<Harness source={makePhotos([1, 3]).map((p) => ({ ...p }))} />);
      expect(navLabel()).toBe('Show only photos I liked (3)');
      now.mockReturnValue(1_000_000 + 6000);
      rerender(<Harness source={makePhotos([1, 3]).map((p) => ({ ...p }))} />);
      expect(navLabel()).toBe('Show only photos I liked (2)');
    } finally {
      now.mockRestore();
    }
  });
});
