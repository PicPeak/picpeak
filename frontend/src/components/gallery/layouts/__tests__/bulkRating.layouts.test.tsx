/**
 * Issue 1985: "Rate selected" in the layouts that draw their own selection
 * chrome. Gallery Premium puts a star in its nav row, Gallery Story a pill in
 * its selection bar; both open the shared BulkRating, which sends one bulk
 * request, and a finished run is confirmed with a toast.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Photo } from '../../../../types';

const mocks = vi.hoisted(() => ({
  submitBulkRating: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('react-i18next', async () => ({
  ...await vi.importActual('react-i18next'),
  useTranslation: () => ({
    t: (key: string, fallback?: unknown, opts?: Record<string, unknown>) => {
      const vars = (typeof fallback === 'object' && fallback ? fallback : opts) as Record<string, unknown> | undefined;
      const text = typeof fallback === 'string' ? fallback : (vars?.defaultValue as string | undefined) ?? key;
      return text.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars?.[k] ?? ''));
    },
    i18n: { language: 'en' },
  }),
}));
vi.mock('react-toastify', () => ({
  toast: { info: vi.fn(), error: mocks.toastError, success: mocks.toastSuccess },
}));
vi.mock('../../../../services/feedback.service', () => ({
  BULK_RATING_MAX_PHOTOS: 200,
  feedbackService: { submitFeedback: vi.fn(), submitBulkRating: mocks.submitBulkRating },
}));
vi.mock('../../../../hooks/useGallery', () => ({ useDownloadPhoto: () => ({ mutate: vi.fn() }) }));
vi.mock('../../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../../utils/guestIdentityStorage', () => ({ getGuestIdentity: () => null }));
vi.mock('../../../../hooks/useInputMode', () => ({ useInputMode: () => 'mouse' }));
vi.mock('react-intersection-observer', () => ({ useInView: () => ({ ref: vi.fn(), inView: true }) }));
vi.mock('../../../../contexts/DownloadQuotaContext', () => ({
  useDownloadQuota: () => ({
    limited: false, previewOnly: false, remaining: null,
    allows: () => true, canDownload: () => true, costOf: () => 0,
  }),
}));
vi.mock('../../DownloadQuotaNotice', () => ({ DownloadQuotaNotice: () => null }));
vi.mock('../../../../services/gallery.service', () => ({
  galleryService: { trackPhotoView: vi.fn(), downloadSelectedPhotos: vi.fn() },
  splitIntoArchives: (ids: number[]) => [ids],
}));
vi.mock('../../../../services/analytics.service', () => ({ analyticsService: { trackGalleryEvent: vi.fn() } }));
vi.mock('../../../common', async () => ({
  ...await vi.importActual('../../../common'),
  PoweredBy: () => null,
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt} />,
}));
vi.mock('../../PhotoLightbox', () => ({ PhotoLightbox: () => null }));
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
vi.mock('swiper/react', () => ({
  Swiper: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  SwiperSlide: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('swiper/modules', () => ({ FreeMode: {}, Mousewheel: {} }));
vi.mock('swiper/css', () => ({}));
vi.mock('swiper/css/free-mode', () => ({}));
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

import { GalleryPremiumLayout } from '../GalleryPremiumLayout';
import { GalleryStoryLayout } from '../GalleryStoryLayout';

const photos = [1, 2, 3].map((id) => ({
  id, filename: `photo-${id}.jpg`, original_filename: `photo-${id}.jpg`, category_name: 'Ceremony',
  url: `/api/gallery/x/photo/${id}`, thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
  width: 3000, height: 2000, type: 'individual', size: 1, uploaded_at: '2026-01-01T00:00:00Z',
})) as Photo[];

type Setup = { allowRatings?: boolean; selected?: number[]; feedbackEnabled?: boolean; requireNameEmail?: boolean };

const props = ({ allowRatings = true, selected = [1, 2], feedbackEnabled = true, requireNameEmail = false }: Setup) => ({
  photos,
  slug: 'x',
  eventName: 'Sarah & Tom',
  onPhotoClick: vi.fn(),
  onDownload: vi.fn(),
  isSelectionMode: true,
  selectedPhotos: new Set(selected),
  onToggleSelectionMode: vi.fn(),
  onPhotoSelect: vi.fn(),
  onSelectMany: vi.fn(),
  onDeselectAll: vi.fn(),
  onDownloadSelected: vi.fn(),
  allowDownloads: true,
  feedbackEnabled,
  feedbackOptions: { allowLikes: true, allowRatings, requireNameEmail },
});

const layouts = {
  premium: {
    render: (setup: Setup) => <GalleryPremiumLayout {...props(setup)} />,
    selectionBar: (container: HTMLElement) => container.querySelector('.gallery-premium-nav-actions') as HTMLElement,
  },
  story: {
    render: (setup: Setup) => <GalleryStoryLayout {...props(setup)} />,
    selectionBar: (container: HTMLElement) => container.querySelector('.story-selection-bar') as HTMLElement,
  },
};

const mount = (node: React.ReactElement) =>
  render(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>);

beforeEach(() => {
  mocks.submitBulkRating.mockReset().mockImplementation(async (_slug: string, ids: number[], rating: number) => ({
    success: true, rating, results: ids.map((id) => ({ photo_id: id, success: true })),
  }));
  mocks.toastSuccess.mockClear();
  mocks.toastError.mockClear();
});
afterEach(() => cleanup());

describe.each(Object.entries(layouts))('Rate selected in the %s layout (issue 1985)', (_name, layout) => {
  it('sits in the selection bar when ratings are on and something is selected', () => {
    const { container } = mount(layout.render({}));
    expect(within(layout.selectionBar(container)).getByTestId('bulk-rating-trigger')).toBeInTheDocument();
  });

  it('is absent with ratings off, feedback off, or an empty selection', () => {
    for (const setup of [{ allowRatings: false }, { feedbackEnabled: false }, { selected: [] }]) {
      mount(layout.render(setup));
      expect(screen.queryByTestId('bulk-rating-trigger')).toBeNull();
      cleanup();
    }
  });

  it('rates the selection with one bulk request and confirms it with a toast', async () => {
    mount(layout.render({}));
    expect(screen.queryByTestId('bulk-rating-popover')).toBeNull();
    fireEvent.click(screen.getByTestId('bulk-rating-trigger'));
    const panel = screen.getByTestId('bulk-rating-popover');
    fireEvent.click(within(panel).getByLabelText('Rate 4 stars'));

    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('2 photos rated'));
    expect(mocks.submitBulkRating).toHaveBeenCalledTimes(1);
    expect(mocks.submitBulkRating).toHaveBeenCalledWith('x', [1, 2], 4, { guest_name: undefined, guest_email: undefined });
    expect(mocks.toastError).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByTestId('bulk-rating-popover')).toBeNull());
  });

  it('confirms a cleared rating in its own words', async () => {
    mount(layout.render({}));
    fireEvent.click(screen.getByTestId('bulk-rating-trigger'));
    fireEvent.click(within(screen.getByTestId('bulk-rating-popover')).getByLabelText('Remove rating'));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('Rating removed from 2 photos'));
    expect(mocks.submitBulkRating).toHaveBeenCalledWith('x', [1, 2], 0, expect.anything());
  });

  it('hands focus back to the trigger when a rating closes the panel', async () => {
    mount(layout.render({}));
    fireEvent.click(screen.getByTestId('bulk-rating-trigger'));
    const star = within(screen.getByTestId('bulk-rating-popover')).getByLabelText('Rate 4 stars');
    star.focus();
    fireEvent.click(star);
    await waitFor(() => expect(screen.queryByTestId('bulk-rating-popover')).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId('bulk-rating-trigger'));
  });

  it('hands focus back when the pending request dropped it to the body', async () => {
    let resolve: (value: unknown) => void = () => {};
    mocks.submitBulkRating.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    mount(layout.render({}));
    fireEvent.click(screen.getByTestId('bulk-rating-trigger'));
    const star = within(screen.getByTestId('bulk-rating-popover')).getByLabelText('Rate 4 stars');
    star.focus();
    fireEvent.click(star);
    // What Chromium does when the focused star turns disabled.
    star.blur();
    await waitFor(() => expect(mocks.submitBulkRating).toHaveBeenCalledTimes(1));
    resolve({ success: true, rating: 4, results: [1, 2].map((id) => ({ photo_id: id, success: true })) });
    await waitFor(() => expect(screen.queryByTestId('bulk-rating-popover')).toBeNull());
    expect(document.activeElement).toBe(screen.getByTestId('bulk-rating-trigger'));
  });

  it('leaves focus alone when the viewer moved it to another control', async () => {
    let resolve: (value: unknown) => void = () => {};
    mocks.submitBulkRating.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    const { container } = mount(layout.render({}));
    fireEvent.click(screen.getByTestId('bulk-rating-trigger'));
    fireEvent.click(within(screen.getByTestId('bulk-rating-popover')).getByLabelText('Rate 4 stars'));
    const other = document.createElement('button');
    container.appendChild(other);
    other.focus();
    await waitFor(() => expect(mocks.submitBulkRating).toHaveBeenCalledTimes(1));
    resolve({ success: true, rating: 4, results: [1, 2].map((id) => ({ photo_id: id, success: true })) });
    await waitFor(() => expect(screen.queryByTestId('bulk-rating-popover')).toBeNull());
    expect(document.activeElement).toBe(other);
  });

  it('does not pull focus back after the viewer dismissed the panel mid-request', async () => {
    let resolve: (value: unknown) => void = () => {};
    mocks.submitBulkRating.mockImplementationOnce(() => new Promise((r) => { resolve = r; }));
    mount(layout.render({}));
    fireEvent.click(screen.getByTestId('bulk-rating-trigger'));
    const star = within(screen.getByTestId('bulk-rating-popover')).getByLabelText('Rate 4 stars');
    star.focus();
    fireEvent.click(star);
    await waitFor(() => expect(mocks.submitBulkRating).toHaveBeenCalledTimes(1));
    fireEvent.mouseDown(document.body);
    expect(screen.queryByTestId('bulk-rating-popover')).toBeNull();
    (document.activeElement as HTMLElement | null)?.blur();
    resolve({ success: true, rating: 4, results: [1, 2].map((id) => ({ photo_id: id, success: true })) });
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('2 photos rated'));
    expect(document.activeElement).toBe(document.body);
  });

  it('closes when focus tabs out of the panel', () => {
    const { container } = mount(layout.render({}));
    fireEvent.click(screen.getByTestId('bulk-rating-trigger'));
    const star = within(screen.getByTestId('bulk-rating-popover')).getByLabelText('Rate 4 stars');
    const other = document.createElement('button');
    container.appendChild(other);
    fireEvent.blur(star, { relatedTarget: other });
    expect(screen.queryByTestId('bulk-rating-popover')).toBeNull();
  });

  it('stays open when focus moves inside the panel or drops to the body', () => {
    mount(layout.render({}));
    const trigger = screen.getByTestId('bulk-rating-trigger');
    fireEvent.click(trigger);
    const star = within(screen.getByTestId('bulk-rating-popover')).getByLabelText('Rate 4 stars');
    fireEvent.blur(trigger, { relatedTarget: star });
    fireEvent.blur(star, { relatedTarget: null });
    expect(screen.getByTestId('bulk-rating-popover')).toBeInTheDocument();
  });

  it('keeps the panel and the pending rating when the name-and-email dialog takes focus', async () => {
    mount(layout.render({ requireNameEmail: true }));
    fireEvent.click(screen.getByTestId('bulk-rating-trigger'));
    const star = within(screen.getByTestId('bulk-rating-popover')).getByLabelText('Rate 4 stars');
    star.focus();
    fireEvent.click(star);
    const dialog = await screen.findByRole('dialog');
    // The dialog pulls focus in as it opens, before it is reported open.
    fireEvent.blur(star, { relatedTarget: within(dialog).getByPlaceholderText('Enter your name') });
    expect(screen.getByTestId('bulk-rating-popover')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByPlaceholderText('Enter your name'), { target: { value: 'Ana' } });
    fireEvent.change(within(dialog).getByPlaceholderText('Enter your email'), { target: { value: 'ana@example.com' } });
    fireEvent.click(within(dialog).getByText('Submit Feedback'));
    await waitFor(() => expect(mocks.submitBulkRating).toHaveBeenCalledWith('x', [1, 2], 4, { guest_name: 'Ana', guest_email: 'ana@example.com' }));
    await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('2 photos rated'));
  });

  it('closes on Escape', () => {
    mount(layout.render({}));
    fireEvent.click(screen.getByTestId('bulk-rating-trigger'));
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.queryByTestId('bulk-rating-popover')).toBeNull();
  });
});
