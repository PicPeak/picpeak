/**
 * Star rating on the grid tile (issue 1733, A3a).
 *
 * The control sits in the tile overlay, switched by `allowRatings`, posts the
 * same rating request the lightbox does, and writes the result into every
 * cached gallery-photos query in place rather than refetching the gallery.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PhotoCard } from '../PhotoCard';
import { feedbackService } from '../../../services/feedback.service';
import { __inputModeTesting } from '../../../hooks/useInputMode';
import type { GalleryData, Photo } from '../../../types';

vi.mock('../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => (
    <img data-testid="tile" src={src} alt={alt} />
  ),
}));

vi.mock('../../../contexts/GuestIdentityContext', () => ({
  useGuestIdentityOptional: () => null,
}));

vi.mock('../../../services/feedback.service', () => ({
  feedbackService: { submitFeedback: vi.fn() },
}));

vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

// Default strings with {{count}} filled in, so the aria-labels read as shipped.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, opts?: { count?: number }) =>
      fallback.replace('{{count}}', String(opts?.count ?? '')),
  }),
}));

const SLUG = 'x';
const PHOTO = {
  id: 7,
  filename: 'IMG_0001.jpg',
  url: '/api/gallery/x/photo/7',
  thumbnail_url: '/api/gallery/x/thumbnail/7',
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  my_rating: null,
} as Photo;

/** A mouse, so a tile click opens straight away instead of revealing the overlay. */
function stubPointerDevice() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      onchange: null,
      dispatchEvent: () => false,
    }),
  });
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
  delete (window as any).ontouchstart;
  __inputModeTesting.reset();
}

let queryClient: QueryClient;

/** The list query the gallery keeps, with a sibling photo that must be left alone. */
function seedCache(photo: Photo) {
  const data = { event: { id: 1 }, photos: [photo, { ...photo, id: 8, my_rating: 2 }] } as unknown as GalleryData;
  queryClient.setQueryData(['gallery-photos', SLUG, 'all', undefined], data);
}

function cachedPhoto(id: number) {
  const data = queryClient.getQueryData<GalleryData>(['gallery-photos', SLUG, 'all', undefined]);
  return data!.photos.find((p) => p.id === id)!;
}

function renderCard(props: Partial<React.ComponentProps<typeof PhotoCard>> = {}) {
  return render(
    <QueryClientProvider client={queryClient}>
      <PhotoCard
        photo={PHOTO}
        isSelected={false}
        isSelectionMode={false}
        onClick={() => {}}
        onDownload={() => {}}
        onToggleSelect={() => {}}
        className="group tile"
        overlayBaseClassName="absolute inset-0 flex items-center justify-center gap-2"
        imageProps={{ src: PHOTO.thumbnail_url!, alt: PHOTO.filename }}
        slug={SLUG}
        feedbackEnabled
        feedbackOptions={{ allowLikes: true, allowRatings: true }}
        {...props}
      />
    </QueryClientProvider>,
  );
}

const stars = () => screen.queryAllByRole('button', { name: /Rate \d stars|Remove rating/ });

beforeEach(() => {
  stubPointerDevice();
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.mocked(feedbackService.submitFeedback).mockResolvedValue({ success: true });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('PhotoCard tile rating (issue 1733)', () => {
  it('renders five stars when ratings are allowed', () => {
    renderCard();
    expect(stars()).toHaveLength(5);
  });

  it('renders nothing when ratings are off, or feedback is off', () => {
    renderCard({ feedbackOptions: { allowLikes: true, allowRatings: false } });
    expect(stars()).toHaveLength(0);
    renderCard({ feedbackEnabled: false });
    expect(stars()).toHaveLength(0);
  });

  it('shows the viewer\'s own rating from the payload', () => {
    renderCard({ photo: { ...PHOTO, my_rating: 3 } });
    const pressed = stars().filter((b) => b.getAttribute('aria-pressed') === 'true');
    expect(pressed).toHaveLength(3);
    // The current star is the one that clears.
    expect(screen.getByRole('button', { name: 'Remove rating' })).toBe(stars()[2]);
  });

  it('submits the star value with the lightbox\'s request and does not open the tile', async () => {
    const onClick = vi.fn();
    seedCache(PHOTO);
    renderCard({ onClick });

    fireEvent.click(screen.getByRole('button', { name: 'Rate 4 stars' }));

    await waitFor(() => expect(feedbackService.submitFeedback).toHaveBeenCalledTimes(1));
    expect(feedbackService.submitFeedback).toHaveBeenCalledWith(SLUG, '7', expect.objectContaining({
      feedback_type: 'rating',
      rating: 4,
    }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it('writes the rating into the cached photo list in place', async () => {
    seedCache(PHOTO);
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Rate 4 stars' }));

    await waitFor(() => expect(cachedPhoto(7).my_rating).toBe(4));
    // Neighbour untouched; nothing refetched (no queryFn exists to run).
    expect(cachedPhoto(8).my_rating).toBe(2);
  });

  it('clears the rating when the current star is pressed again', async () => {
    const rated = { ...PHOTO, my_rating: 4 };
    seedCache(rated);
    renderCard({ photo: rated });

    fireEvent.click(screen.getByRole('button', { name: 'Remove rating' }));

    await waitFor(() => expect(feedbackService.submitFeedback).toHaveBeenCalledWith(
      SLUG, '7', expect.objectContaining({ feedback_type: 'rating', rating: 0 }),
    ));
    await waitFor(() => expect(cachedPhoto(7).my_rating).toBeNull());
  });

  it('leaves the cache alone when the request fails', async () => {
    vi.mocked(feedbackService.submitFeedback).mockRejectedValue({ response: { status: 429 } });
    seedCache(PHOTO);
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Rate 5 stars' }));

    await waitFor(() => expect(feedbackService.submitFeedback).toHaveBeenCalledTimes(1));
    // Give the rejected mutation a tick to settle.
    await waitFor(() => expect(stars()[4]).not.toBeDisabled());
    expect(cachedPhoto(7).my_rating).toBeNull();
  });
});
