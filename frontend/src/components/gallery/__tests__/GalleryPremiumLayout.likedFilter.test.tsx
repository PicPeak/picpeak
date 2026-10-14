/**
 * The Premium nav heart was a button with no handler and no count. It now
 * carries the viewer's liked count, as Story's does, and drives the gallery's
 * "Liked" filter. The harness holds that filter the way GalleryView does and
 * hands the layout the result of the real useGalleryFiltering.
 */
import React, { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { Photo } from '../../../types';
import type { FeedbackFilterType } from '../GalleryFilter';
import { useGalleryFiltering } from '../hooks/useGalleryFiltering';

vi.mock('react-i18next', async () => ({
  ...await vi.importActual('react-i18next'),
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' },
  }),
}));
vi.mock('../../../hooks/useGallery', () => ({ useDownloadPhoto: () => ({ mutate: vi.fn() }) }));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../hooks/useInputMode', () => ({ useInputMode: () => 'mouse' }));
vi.mock('react-intersection-observer', () => ({ useInView: () => ({ ref: vi.fn(), inView: true }) }));
vi.mock('../../../services/gallery.service', () => ({ galleryService: { trackPhotoView: vi.fn() } }));
const submitFeedback = vi.hoisted(() => vi.fn());
vi.mock('../../../services/feedback.service', async () => ({
  ...await vi.importActual('../../../services/feedback.service'),
  feedbackService: { submitFeedback },
}));
vi.mock('../../common', async () => ({ ...await vi.importActual('../../common'), PoweredBy: () => null }));
vi.mock('react-photo-album', () => ({
  MasonryPhotoAlbum: ({ photos, render: renderer }: any) => <>{photos.map((photo: any, index: number) =>
    <React.Fragment key={photo.key}>{renderer.photo({}, { photo, index, width: 300, height: 200 })}</React.Fragment>
  )}</>,
}));
vi.mock('yet-another-react-lightbox', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/thumbnails', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/zoom', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/fullscreen', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/download', () => ({ default: () => null }));
vi.mock('yet-another-react-lightbox/plugins/captions', () => ({ default: () => null }));

import { GalleryPremiumLayout } from '../layouts/GalleryPremiumLayout';

// Photo 2 is liked by someone else only (like_count without is_liked).
const makePhotos = (liked: number[]) => [1, 2, 3, 4].map((id) => ({
  id, filename: `photo-${id}.jpg`, original_filename: `original-${id}.jpg`,
  url: `/api/gallery/demo/photo/${id}`, thumbnail_url: `/api/gallery/demo/thumbnail/${id}`,
  width: 6000, height: 4000, type: 'individual', size: 1, uploaded_at: '2026-01-01T00:00:00Z',
  is_liked: liked.includes(id), like_count: liked.includes(id) || id === 2 ? 1 : 0,
})) as Photo[];

function Harness({ source }: { source: Photo[] }) {
  const [activeFilters, setActiveFilters] = useState<FeedbackFilterType[]>([]);
  const photos = useGalleryFiltering({
    sourcePhotos: source, folderId: null, selectedCategoryId: null, searchTerm: '',
    sortBy: 'name', sortDesc: false, watermarkEnabled: false, slug: 'demo',
    activeFilters, activeColorFilters: [], mediaFilter: 'all', isGuestIdentityMode: false,
    myFeedbackPhotoIds: { liked: new Set(), favorited: new Set(), rated: new Set(), commented: new Set() },
    selectedPersonIds: [], peopleMatchAny: false, likedIsOwn: true,
  });
  return (
    <GalleryPremiumLayout
      photos={photos} slug="demo" onPhotoClick={vi.fn()} onDownload={vi.fn()} allowDownloads={false}
      feedbackEnabled feedbackOptions={{ allowLikes: true }}
      likedOnly={activeFilters.includes('liked')}
      onToggleLikedOnly={() => setActiveFilters((prev) => (prev.includes('liked') ? [] : ['liked']))}
    />
  );
}

const shownIds = () => screen.queryAllByTestId(/^photo-card-\d+$/)
  .map((card) => Number(card.dataset.testid?.replace('photo-card-', '')))
  .sort();

afterEach(() => cleanup());

describe('Gallery Premium — nav heart filters to the viewer\'s likes', () => {
  it('shows the liked count, as Story does', () => {
    render(<Harness source={makePhotos([1, 3])} />);
    const heart = screen.getByTestId('premium-nav-liked');
    expect(heart.querySelector('.gallery-premium-nav-count')?.textContent).toBe('2');
    expect(heart).toHaveAttribute('aria-label', 'Show only photos I liked (2)');
  });

  it('shows no count when nothing is liked', () => {
    render(<Harness source={makePhotos([])} />);
    expect(screen.getByTestId('premium-nav-liked').querySelector('.gallery-premium-nav-count')).toBeNull();
  });

  it('shows only liked photos on click and every photo on the next click', () => {
    render(<Harness source={makePhotos([1, 3])} />);
    expect(screen.getByTestId('premium-nav-liked')).toHaveAttribute('aria-pressed', 'false');
    expect(shownIds()).toEqual([1, 2, 3, 4]);

    fireEvent.click(screen.getByTestId('premium-nav-liked'));
    expect(screen.getByTestId('premium-nav-liked')).toHaveAttribute('aria-pressed', 'true');
    expect(shownIds()).toEqual([1, 3]);

    fireEvent.click(screen.getByTestId('premium-nav-liked'));
    expect(screen.getByTestId('premium-nav-liked')).toHaveAttribute('aria-pressed', 'false');
    expect(shownIds()).toEqual([1, 2, 3, 4]);
  });

  it('explains an empty liked view and offers the way back', () => {
    render(<Harness source={makePhotos([])} />);
    fireEvent.click(screen.getByTestId('premium-nav-liked'));
    expect(screen.getByText(/not liked any photos here yet/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Show all photos' }));
    expect(shownIds()).toEqual([1, 2, 3, 4]);
  });

  it('takes a refused like back out of the count', async () => {
    // The like limit: the server keeps is_liked false, so the Liked filter
    // will not show the photo and the count must not claim it either.
    submitFeedback.mockRejectedValueOnce({ response: { status: 403, data: { code: 'LIKE_LIMIT_REACHED' } } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    render(<Harness source={makePhotos([1, 3])} />);
    const likeButton = screen.getByTestId('photo-card-4').querySelector('.gallery-premium-like-btn') as HTMLElement;
    fireEvent.click(likeButton);
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(
      screen.getByTestId('premium-nav-liked').querySelector('.gallery-premium-nav-count')?.textContent,
    ).toBe('2'));
    expect(likeButton.className).not.toContain('liked');
    warn.mockRestore();
  });
});
