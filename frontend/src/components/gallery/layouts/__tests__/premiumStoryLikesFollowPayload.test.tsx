/**
 * Issue 2561 for the Premium and Story layouts: their liked set followed only
 * the first photo payload, so a like changed in the lightbox never reached
 * the card heart (and the next click on it, a toggle, did the opposite of
 * what the guest meant). The set now follows every payload; a click holds
 * its state until its submit settled and a payload agrees.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { GalleryPremiumLayout } from '../GalleryPremiumLayout';
import { GalleryStoryLayout } from '../GalleryStoryLayout';
import { feedbackService } from '../../../../services/feedback.service';
import type { Photo } from '../../../../types';

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, fallback?: unknown) => (typeof fallback === 'string' ? fallback : key),
    i18n: { language: 'en' },
  }),
}));
vi.mock('framer-motion', () => {
  const stub = (tag: string) =>
    React.forwardRef<HTMLElement, Record<string, unknown>>(({ children, className, onClick }, ref) =>
      React.createElement(tag, { ref, className, onClick }, children as React.ReactNode));
  return {
    motion: new Proxy({} as Record<string, unknown>, { get: (cache, tag: string) => (cache[tag] ??= stub(tag)) }),
    AnimatePresence: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
    useInView: () => true,
  };
});
vi.mock('react-intersection-observer', () => ({ useInView: () => ({ ref: vi.fn(), inView: true }) }));
// The album lays tiles out only with a measured width; render them flat.
vi.mock('react-photo-album', () => ({
  MasonryPhotoAlbum: ({ photos, render: r }: {
    photos: unknown[];
    render: { photo: (props: object, ctx: { photo: unknown; width: number; height: number }) => React.ReactNode };
  }) => <div>{photos.map((photo, i) => <React.Fragment key={i}>{r.photo({}, { photo, width: 300, height: 200 })}</React.Fragment>)}</div>,
}));
vi.mock('yet-another-react-lightbox', () => ({ default: () => null }));
vi.mock('../../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt} />,
  PoweredBy: () => null,
}));
vi.mock('../../PhotoLightbox', () => ({ PhotoLightbox: () => null }));
vi.mock('../../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../../services/feedback.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../../services/feedback.service')>()),
  feedbackService: { submitFeedback: vi.fn(), getPhotoFeedback: vi.fn(), getPhotoReactions: vi.fn() },
}));
vi.mock('../../../../services/gallery.service', () => ({ galleryService: { downloadSelectedPhotos: vi.fn() } }));
vi.mock('../../../../services/analytics.service', () => ({ analyticsService: { trackGalleryEvent: vi.fn() } }));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));

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
  category_name: 'Ceremony',
  is_liked: liked,
} as Photo];

// Each layout's card heart and how it shows the liked state.
const layouts = [
  ['Premium', GalleryPremiumLayout, '.gallery-premium-like-btn', 'liked'],
  ['Story', GalleryStoryLayout, '.story-photo-card-btn', 'favorite'],
] as const;

function mount(Layout: React.ComponentType<never>, photos: Photo[]) {
  const props = (list: Photo[]) => ({
    photos: list,
    slug: 'x',
    eventName: 'Event',
    onPhotoClick: vi.fn(),
    onDownload: vi.fn(),
    selectedPhotos: new Set<number>(),
    isSelectionMode: false,
    allowDownloads: true,
    feedbackEnabled: true,
    feedbackOptions: { allowLikes: true },
    onFeedbackChange: vi.fn(),
  }) as never;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrap = (list: Photo[]) => <QueryClientProvider client={client}><Layout {...props(list)} /></QueryClientProvider>;
  const view = render(wrap(photos));
  return { view, update: (list: Photo[]) => view.rerender(wrap(list)) };
}

beforeEach(() => {
  vi.stubGlobal('IntersectionObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.mocked(feedbackService.submitFeedback).mockReset(); });

describe.each(layouts)('%s layout like state (issue 2561)', (_name, Layout, selector, likedClass) => {
  const setup = (photos: Photo[]) => {
    const { view, update } = mount(Layout as never, photos);
    const heart = () => view.container.querySelector(selector) as HTMLElement;
    const liked = () => heart().classList.contains(likedClass);
    return { heart, liked, update };
  };

  it('shows a like made elsewhere once the payload carries it', () => {
    const { liked, update } = setup(photoWith(false));
    expect(liked()).toBe(false);
    update(photoWith(true));
    expect(liked()).toBe(true);
  });

  it('drops a card like that was taken back in the lightbox', async () => {
    vi.mocked(feedbackService.submitFeedback).mockResolvedValue({ success: true } as never);
    const { heart, liked, update } = setup(photoWith(false));
    fireEvent.click(heart());
    await waitFor(() => expect(liked()).toBe(true));
    await act(async () => {});
    update(photoWith(true));
    expect(liked()).toBe(true);
    update(photoWith(false));
    expect(liked()).toBe(false);
  });

  it('keeps a fresh click over a payload that predates it', async () => {
    vi.mocked(feedbackService.submitFeedback).mockResolvedValue({ success: true } as never);
    const { heart, liked, update } = setup(photoWith(false));
    fireEvent.click(heart());
    await waitFor(() => expect(liked()).toBe(true));
    await act(async () => {});
    update(photoWith(false));
    expect(liked()).toBe(true);
  });

  it('holds a click while its submit is still running, past the confirmation window', async () => {
    let finish: (value: unknown) => void = () => {};
    vi.mocked(feedbackService.submitFeedback).mockImplementation(() => new Promise((resolve) => { finish = resolve; }) as never);
    const start = Date.now();
    const now = vi.spyOn(Date, 'now').mockReturnValue(start);
    try {
      const { heart, liked, update } = setup(photoWith(false));
      fireEvent.click(heart());
      await waitFor(() => expect(liked()).toBe(true));
      now.mockReturnValue(start + 6000);
      update(photoWith(false));
      expect(liked()).toBe(true);
      await act(async () => { finish({ success: true }); });
      update(photoWith(true));
      expect(liked()).toBe(true);
    } finally {
      now.mockRestore();
    }
  });

  it('ends unliked when two overlapping clicks are both refused', async () => {
    const refusals: Array<(error: unknown) => void> = [];
    vi.mocked(feedbackService.submitFeedback).mockImplementation(() => new Promise((_resolve, reject) => { refusals.push(reject); }) as never);
    const { heart, liked } = setup(photoWith(false));
    fireEvent.click(heart());
    await waitFor(() => expect(liked()).toBe(true));
    fireEvent.click(heart());
    await waitFor(() => expect(liked()).toBe(false));
    await waitFor(() => expect(refusals).toHaveLength(2));
    // A 429 for each, in order: the server still holds no like.
    await act(async () => { refusals[0](new Error('429')); });
    await act(async () => { refusals[1](new Error('429')); });
    expect(liked()).toBe(false);
  });

  it('puts the heart back when the server refused the like', async () => {
    vi.mocked(feedbackService.submitFeedback).mockRejectedValue(new Error('refused'));
    const { heart, liked, update } = setup(photoWith(false));
    fireEvent.click(heart());
    await waitFor(() => expect(liked()).toBe(false));
    update(photoWith(false));
    expect(liked()).toBe(false);
  });
});
