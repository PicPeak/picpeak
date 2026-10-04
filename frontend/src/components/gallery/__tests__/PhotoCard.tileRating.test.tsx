/**
 * Star rating on the grid tile (issue 1733, A3a).
 *
 * The control sits in the tile overlay, switched by `allowRatings`, posts the
 * same rating request the lightbox does, and writes the result into every
 * cached gallery-photos query in place rather than refetching the gallery.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PhotoCard } from '../PhotoCard';
import { feedbackService } from '../../../services/feedback.service';
import { __inputModeTesting } from '../../../hooks/useInputMode';
import type { GalleryData, Photo } from '../../../types';

vi.mock('../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => (
    <img data-testid="tile" src={src} alt={alt} />
  ),
  // The identity modal's form controls, plain enough to type into.
  Button: ({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...rest}>{children}</button>,
  Input: ({ label: _label, error: _error, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { label?: string; error?: string }) => <input {...rest} />,
}));

// Switchable per test: null = simple/shared mode, 'guest' = guest identity mode.
let guestIdentityContext: null | {
  identityMode: 'guest';
  /** The identity the provider holds before the call; null = not registered yet. */
  identity: { id: number } | null;
  ensureIdentity: () => Promise<{ id: number }>;
} = null;
vi.mock('../../../contexts/GuestIdentityContext', () => ({
  useGuestIdentityOptional: () => guestIdentityContext,
}));

vi.mock('../../../services/feedback.service', () => ({
  feedbackService: { submitFeedback: vi.fn(), getPhotoFeedback: vi.fn() },
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
  vi.mocked(feedbackService.getPhotoFeedback).mockResolvedValue({
    feedback: [], my_feedback: {}, summary: { average_rating: 4, total_ratings: 1 },
  } as any);
});

afterEach(() => {
  guestIdentityContext = null;
  vi.clearAllMocks();
});

describe('PhotoCard tile rating (issue 1733)', () => {
  it('renders five stars when ratings are allowed', () => {
    renderCard();
    expect(stars()).toHaveLength(5);
  });

  it('keeps the rating row inside a short tile', () => {
    renderCard();
    const row = stars()[0].closest('div[role="group"]')!.parentElement!;
    // Centre + offset on a normal tile, clamped to one pill height above the
    // bottom on a ~50px panoramic Mosaic tile (overflow-hidden would clip it).
    // jsdom's CSSOM garbles the min() argument list, so pin its two parts.
    const top = row.getAttribute('style') || '';
    expect(top).toMatch(/^top: min\(/);
    expect(top).toContain('calc(50% + 1.5rem)');
    expect(top).toContain('calc(100% - 1.75rem)');
    expect(row.className).not.toMatch(/top-1\/2|mt-6/);
  });

  it('withholds the row on a tile too short for the buttons and the stars', async () => {
    // A panoramic Mosaic/Masonry tile (~50-100px) has no room under the
    // centred 36px action band; the clamped row would sit on the buttons.
    const observers: Array<(entries: Array<{ contentRect: { height: number } }>) => void> = [];
    vi.stubGlobal('ResizeObserver', class {
      constructor(cb: (entries: Array<{ contentRect: { height: number } }>) => void) { observers.push(cb); }
      observe() {} unobserve() {} disconnect() {}
    });
    try {
      renderCard();
      expect(stars()).toHaveLength(5);
      act(() => observers.forEach((cb) => cb([{ contentRect: { height: 60 } }])));
      await waitFor(() => expect(stars()).toHaveLength(0));
      act(() => observers.forEach((cb) => cb([{ contentRect: { height: 200 } }])));
      await waitFor(() => expect(stars()).toHaveLength(5));
    } finally {
      vi.unstubAllGlobals();
    }
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

  it('refreshes the photo\'s aggregate rating fields from the per-photo summary', async () => {
    // Outside guest mode the Rated chip and the tile badge read these off
    // the list row; a stale 0 kept a freshly rated photo out of the filter.
    seedCache({ ...PHOTO, average_rating: 0, total_ratings: 0 });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Rate 4 stars' }));

    await waitFor(() => expect(feedbackService.getPhotoFeedback).toHaveBeenCalledWith(SLUG, '7'));
    await waitFor(() => expect(cachedPhoto(7).total_ratings).toBe(1));
    expect(cachedPhoto(7).average_rating).toBe(4);
    // The neighbour (seeded from the same row) is left alone.
    expect(cachedPhoto(8).total_ratings).toBe(0);
  });

  it('refreshes the aggregates in guest identity mode as well', async () => {
    // The badges on Grid/Justified/Masonry tiles read the aggregates in every
    // identity mode; only the Rated chip switches to /my-feedback in guest mode.
    guestIdentityContext = { identityMode: 'guest', identity: { id: 3 }, ensureIdentity: vi.fn().mockResolvedValue({ id: 3 }) };
    seedCache({ ...PHOTO, average_rating: 0, total_ratings: 0 });
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Rate 4 stars' }));

    await waitFor(() => expect(feedbackService.submitFeedback).toHaveBeenCalledWith(
      SLUG, '7', expect.objectContaining({ rating: 4 }),
    ));
    await waitFor(() => expect(cachedPhoto(7).total_ratings).toBe(1));
    expect(cachedPhoto(7).average_rating).toBe(4);
    expect(cachedPhoto(7).my_rating).toBe(4);
  });

  it('is not overwritten by a list request that was already in flight', async () => {
    // The rating that registers the guest: ensureIdentity() establishes the
    // identity, the provider invalidates gallery-photos just before the
    // rating POST, and the refetch it starts carries the unrated row.
    guestIdentityContext = { identityMode: 'guest', identity: null, ensureIdentity: vi.fn().mockResolvedValue({ id: 3 }) };
    seedCache(PHOTO);
    let resolveList: (v: GalleryData) => void = () => {};
    const stale = { event: { id: 1 }, photos: [{ ...PHOTO, my_rating: null }, { ...PHOTO, id: 8, my_rating: 2 }] } as unknown as GalleryData;
    // A fetch that completes only after the patch has been written.
    void queryClient.fetchQuery({
      queryKey: ['gallery-photos', SLUG, 'all', undefined],
      queryFn: () => new Promise<GalleryData>((resolve) => { resolveList = resolve; }),
      staleTime: 0,
    }).catch(() => {});
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Rate 5 stars' }));
    await waitFor(() => expect(cachedPhoto(7).my_rating).toBe(5));
    resolveList(stale);
    await new Promise((r) => setTimeout(r, 20));

    expect(cachedPhoto(7).my_rating).toBe(5);
    // The cancelled request also carried the other photos' identity-bound
    // fields; the list is marked for a refetch (background, patch stays).
    expect(queryClient.getQueryState(['gallery-photos', SLUG, 'all', undefined])?.isInvalidated).toBe(true);
  });

  it('neither cancels nor refetches the list for a registered guest with nothing in flight', async () => {
    // Every rating after the first: proofing 300 photos must not refetch
    // the gallery 300 times.
    guestIdentityContext = { identityMode: 'guest', identity: { id: 3 }, ensureIdentity: vi.fn().mockResolvedValue({ id: 3 }) };
    seedCache(PHOTO);
    const cancel = vi.spyOn(queryClient, 'cancelQueries');
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Rate 5 stars' }));
    await waitFor(() => expect(cachedPhoto(7).my_rating).toBe(5));
    await waitFor(() => expect(feedbackService.getPhotoFeedback).toHaveBeenCalled());
    await waitFor(() => expect(cachedPhoto(7).total_ratings).toBe(1));

    expect(cancel).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(['gallery-photos', SLUG, 'all', undefined])?.isInvalidated).toBe(false);
  });

  it('refetches once when an invite or a guest switch changed the identity under the rating', async () => {
    // ensureIdentity() answers with a different guest than the provider held.
    guestIdentityContext = { identityMode: 'guest', identity: { id: 3 }, ensureIdentity: vi.fn().mockResolvedValue({ id: 4 }) };
    seedCache(PHOTO);
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Rate 2 stars' }));
    await waitFor(() => expect(cachedPhoto(7).my_rating).toBe(2));
    await waitFor(() => expect(
      queryClient.getQueryState(['gallery-photos', SLUG, 'all', undefined])?.isInvalidated,
    ).toBe(true));
  });

  it('does not let a simple-mode refresh that was already in flight win, and restarts it once', async () => {
    seedCache(PHOTO);
    // A refresh started before the rating: it carries the unrated row.
    let resolveList: (v: GalleryData) => void = () => {};
    const stale = { event: { id: 1 }, photos: [{ ...PHOTO, my_rating: null, total_ratings: 0 }, { ...PHOTO, id: 8, my_rating: 2 }] } as unknown as GalleryData;
    void queryClient.fetchQuery({
      queryKey: ['gallery-photos', SLUG, 'all', undefined],
      queryFn: () => new Promise<GalleryData>((resolve) => { resolveList = resolve; }),
      staleTime: 0,
    }).catch(() => {});
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Rate 5 stars' }));
    await waitFor(() => expect(cachedPhoto(7).my_rating).toBe(5));
    await waitFor(() => expect(cachedPhoto(7).total_ratings).toBe(1));
    resolveList(stale);
    await new Promise((r) => setTimeout(r, 20));

    expect(cachedPhoto(7).my_rating).toBe(5);
    expect(cachedPhoto(7).total_ratings).toBe(1);
    // The cancelled refresh is asked for again — once.
    expect(queryClient.getQueryState(['gallery-photos', SLUG, 'all', undefined])?.isInvalidated).toBe(true);
    expect(invalidate.mock.calls.filter(([f]) => (f as { queryKey: unknown[] }).queryKey[0] === 'gallery-photos')).toHaveLength(1);
  });

  it('refetches nothing in simple mode when no list request is in flight', async () => {
    seedCache(PHOTO);
    const cancel = vi.spyOn(queryClient, 'cancelQueries');
    renderCard();
    fireEvent.click(screen.getByRole('button', { name: 'Rate 5 stars' }));
    await waitFor(() => expect(cachedPhoto(7).total_ratings).toBe(1));
    expect(cancel).not.toHaveBeenCalled();
    expect(queryClient.getQueryState(['gallery-photos', SLUG, 'all', undefined])?.isInvalidated).toBe(false);
  });

  it('keeps the star when the summary request fails', async () => {
    vi.mocked(feedbackService.getPhotoFeedback).mockRejectedValue(new Error('offline'));
    seedCache(PHOTO);
    renderCard();

    fireEvent.click(screen.getByRole('button', { name: 'Rate 3 stars' }));

    await waitFor(() => expect(cachedPhoto(7).my_rating).toBe(3));
    await waitFor(() => expect(feedbackService.getPhotoFeedback).toHaveBeenCalledTimes(1));
    expect(cachedPhoto(7).average_rating).toBeUndefined();
  });

  it('hands the identity typed on one tile to the layout, so the next tile does not ask again', async () => {
    // require_name_email outside guest mode: the layout stores the identity
    // (its own modal path does the same) and passes it back as savedIdentity.
    const onIdentitySaved = vi.fn();
    const { rerender } = render(
      <QueryClientProvider client={queryClient}>
        <PhotoCard
          photo={PHOTO} isSelected={false} isSelectionMode={false} onClick={() => {}} onDownload={() => {}}
          onToggleSelect={() => {}} className="group tile" slug={SLUG} feedbackEnabled
          overlayBaseClassName="absolute inset-0 flex items-center justify-center gap-2"
          imageProps={{ src: PHOTO.thumbnail_url!, alt: PHOTO.filename }}
          feedbackOptions={{ allowLikes: true, allowRatings: true, requireNameEmail: true }}
          identityMode="parent" savedIdentity={null} onIdentitySaved={onIdentitySaved}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rate 4 stars' }));
    expect(feedbackService.submitFeedback).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText('Enter your name'), { target: { value: 'Maria' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your email'), { target: { value: 'maria@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Feedback' }));

    await waitFor(() => expect(feedbackService.submitFeedback).toHaveBeenCalledWith(
      SLUG, '7', expect.objectContaining({ rating: 4, guest_name: 'Maria', guest_email: 'maria@example.com' }),
    ));
    expect(onIdentitySaved).toHaveBeenCalledWith({ name: 'Maria', email: 'maria@example.com' });

    // The layout feeds it back: another photo rates straight away.
    const other = { ...PHOTO, id: 9 } as Photo;
    rerender(
      <QueryClientProvider client={queryClient}>
        <PhotoCard
          photo={other} isSelected={false} isSelectionMode={false} onClick={() => {}} onDownload={() => {}}
          onToggleSelect={() => {}} className="group tile" slug={SLUG} feedbackEnabled
          overlayBaseClassName="absolute inset-0 flex items-center justify-center gap-2"
          imageProps={{ src: PHOTO.thumbnail_url!, alt: PHOTO.filename }}
          feedbackOptions={{ allowLikes: true, allowRatings: true, requireNameEmail: true }}
          identityMode="parent" savedIdentity={{ name: 'Maria', email: 'maria@example.com' }} onIdentitySaved={onIdentitySaved}
        />
      </QueryClientProvider>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Rate 2 stars' }));
    await waitFor(() => expect(feedbackService.submitFeedback).toHaveBeenCalledWith(
      SLUG, '9', expect.objectContaining({ rating: 2, guest_name: 'Maria' }),
    ));
    expect(screen.queryByPlaceholderText('Enter your name')).not.toBeInTheDocument();
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
