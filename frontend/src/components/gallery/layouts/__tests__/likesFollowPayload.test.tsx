/**
 * Issue 2561: the tile hearts follow the viewer's `is_liked` in every photo
 * payload, not only the first one.
 *
 * Grid, Masonry, Carousel and Timeline seeded their liked set once on mount
 * and Mosaic laid its toggles over the payload for good, so a like changed in
 * the lightbox (whose row refresh does reach the photos) never reached the
 * tile. The tile then showed a heart the server no longer held, or none for
 * one it did, and since the like endpoint is a toggle, clicking that heart to
 * take a like back created one: the grid looked cleared while the lightbox
 * and the admin still counted the like.
 */
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { GridGalleryLayout } from '../GridGalleryLayout';
import { MasonryGalleryLayout } from '../MasonryGalleryLayout';
import { MosaicGalleryLayout } from '../MosaicGalleryLayout';
import { TimelineGalleryLayout } from '../TimelineGalleryLayout';
import { CarouselGalleryLayout } from '../CarouselGalleryLayout';
import { feedbackService } from '../../../../services/feedback.service';
import type { Photo } from '../../../../types';
import { LIKES_CLEARED_EVENT } from '../../../../utils/feedbackEvents';

vi.mock('react-intersection-observer', () => ({ useInView: () => ({ ref: vi.fn(), inView: true }) }));
vi.mock('../../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt} />,
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
vi.mock('../../../../hooks/useLocalizedDate', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../hooks/useLocalizedDate')>()),
  useLocalizedDate: () => ({ formatTime: (v: string) => v, formatDate: (v: string) => v }),
}));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' },
  }),
}));

const photoWith = (liked: boolean): Photo[] => [{
  id: 1,
  filename: 'IMG_1.jpg',
  url: '/api/gallery/x/photo/1',
  thumbnail_url: '/api/gallery/x/thumbnail/1',
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  width: 4000,
  height: 3000,
  is_liked: liked,
} as Photo];

const layouts = [
  ['Grid', GridGalleryLayout],
  ['Masonry', MasonryGalleryLayout],
  ['Mosaic', MosaicGalleryLayout],
  ['Timeline', TimelineGalleryLayout],
  ['Carousel', CarouselGalleryLayout],
] as const;

function mount(Layout: React.ComponentType<never>, photos: Photo[]) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const props = (list: Photo[]) => ({
    photos: list,
    slug: 'x',
    onPhotoClick: vi.fn(),
    onDownload: vi.fn(),
    selectedPhotos: new Set<number>(),
    isSelectionMode: false,
    allowDownloads: true,
    feedbackEnabled: true,
    feedbackOptions: { allowLikes: true },
    onFeedbackChange: vi.fn(),
  }) as never;
  const view = render(<QueryClientProvider client={queryClient}><Layout {...props(photos)} /></QueryClientProvider>);
  return (list: Photo[]) => view.rerender(
    <QueryClientProvider client={queryClient}><Layout {...props(list)} /></QueryClientProvider>,
  );
}

// The tile's heart; PhotoCard and the Carousel both say its state in aria-pressed.
const heart = () => screen.getAllByRole('button').find((b) => b.hasAttribute('aria-pressed')) as HTMLElement;

beforeEach(() => {
  // Masonry lays its tiles out only once it knows a width.
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1440 });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => vi.unstubAllGlobals());

describe.each(layouts)('%s layout like state (issue 2561)', (_name, Layout) => {
  it('shows a like made elsewhere once the payload carries it', () => {
    const update = mount(Layout as never, photoWith(false));
    expect(heart()).toHaveAttribute('aria-pressed', 'false');
    update(photoWith(true));
    expect(heart()).toHaveAttribute('aria-pressed', 'true');
  });

  it('keeps a fresh toggle over a payload that predates it', async () => {
    vi.mocked(feedbackService.submitFeedback).mockResolvedValue({ success: true } as never);
    const update = mount(Layout as never, photoWith(false));
    fireEvent.click(heart());
    await waitFor(() => expect(heart()).toHaveAttribute('aria-pressed', 'true'));
    // Another refresh lands before the one that carries the like.
    update(photoWith(false));
    expect(heart()).toHaveAttribute('aria-pressed', 'true');
  });

  it('drops a tile like that was taken back in the lightbox', async () => {
    vi.mocked(feedbackService.submitFeedback).mockResolvedValue({ success: true } as never);
    const update = mount(Layout as never, photoWith(false));
    fireEvent.click(heart());
    await waitFor(() => expect(heart()).toHaveAttribute('aria-pressed', 'true'));
    // The row refresh after the tile like confirms it ...
    update(photoWith(true));
    expect(heart()).toHaveAttribute('aria-pressed', 'true');
    // ... and the one after the lightbox unlike takes it away again, so the
    // next click on this heart asks for a like rather than a removal.
    update(photoWith(false));
    expect(heart()).toHaveAttribute('aria-pressed', 'false');
  });

  it('holds a tile like while its submit is still running, past the confirmation window', async () => {
    let finish: (value: unknown) => void = () => {};
    vi.mocked(feedbackService.submitFeedback).mockImplementation(() => new Promise((resolve) => { finish = resolve; }) as never);
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      const update = mount(Layout as never, photoWith(false));
      fireEvent.click(heart());
      await waitFor(() => expect(heart()).toHaveAttribute('aria-pressed', 'true'));
      // A slow POST: another row refresh lands long after the click.
      now.mockReturnValue(start + 6000);
      update(photoWith(false));
      expect(heart()).toHaveAttribute('aria-pressed', 'true');
      // Settled now; the confirming refresh carries the like.
      await act(async () => { finish({ success: true }); });
      update(photoWith(true));
      expect(heart()).toHaveAttribute('aria-pressed', 'true');
    } finally {
      now.mockRestore();
    }
  });

  it('keeps a quick unlike over the refresh confirming the like before it', async () => {
    const finishers: Array<(value: unknown) => void> = [];
    vi.mocked(feedbackService.submitFeedback).mockImplementation(() => new Promise((resolve) => { finishers.push(resolve); }) as never);
    const update = mount(Layout as never, photoWith(false));
    fireEvent.click(heart());
    await waitFor(() => expect(heart()).toHaveAttribute('aria-pressed', 'true'));
    await waitFor(() => expect(finishers).toHaveLength(1));
    fireEvent.click(heart());
    await waitFor(() => expect(heart()).toHaveAttribute('aria-pressed', 'false'));
    await waitFor(() => expect(finishers).toHaveLength(2));
    // An unrelated refresh from before both writes agrees with the unlike ...
    update(photoWith(false));
    // ... then the like settles and its refresh still carries it.
    await act(async () => { finishers[0]({ success: true }); });
    update(photoWith(true));
    expect(heart()).toHaveAttribute('aria-pressed', 'false');
    // The unlike settles; its refresh confirms the empty heart.
    await act(async () => { finishers[1]({ success: true }); });
    update(photoWith(false));
    expect(heart()).toHaveAttribute('aria-pressed', 'false');
  });

  it('keeps a held tile like when another gallery\'s likes are taken back', async () => {
    vi.mocked(feedbackService.submitFeedback).mockResolvedValue({ success: true } as never);
    const update = mount(Layout as never, photoWith(false));
    fireEvent.click(heart());
    await waitFor(() => expect(heart()).toHaveAttribute('aria-pressed', 'true'));
    act(() => { window.dispatchEvent(new CustomEvent(LIKES_CLEARED_EVENT, { detail: { slug: 'another-gallery' } })); });
    update(photoWith(false));
    expect(heart()).toHaveAttribute('aria-pressed', 'true');
  });

  it('drops a held tile like when all own likes are taken back', async () => {
    vi.mocked(feedbackService.submitFeedback).mockResolvedValue({ success: true } as never);
    const update = mount(Layout as never, photoWith(false));
    fireEvent.click(heart());
    await waitFor(() => expect(heart()).toHaveAttribute('aria-pressed', 'true'));
    // "Remove my likes" before the refresh confirming the click arrived.
    act(() => { window.dispatchEvent(new CustomEvent(LIKES_CLEARED_EVENT, { detail: { slug: 'x' } })); });
    update(photoWith(false));
    expect(heart()).toHaveAttribute('aria-pressed', 'false');
  });
});
