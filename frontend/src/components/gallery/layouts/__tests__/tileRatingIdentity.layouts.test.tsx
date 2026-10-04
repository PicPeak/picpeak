/**
 * One identity per viewer across tiles (issue 1733, A3a follow-up).
 *
 * With require_name_email on outside guest identity mode, the name/email a
 * viewer types to rate the first tile must be held by the LAYOUT: Mosaic
 * kept it per MosaicPhoto and Masonry columns mode per PhotoCard (self
 * identity mode), so the second tile asked again. Rating two tiles in each
 * layout must open the modal exactly once.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { MosaicGalleryLayout } from '../MosaicGalleryLayout';
import { MasonryGalleryLayout } from '../MasonryGalleryLayout';
import { feedbackService } from '../../../../services/feedback.service';
import { __inputModeTesting } from '../../../../hooks/useInputMode';
import type { Photo } from '../../../../types';

vi.mock('react-intersection-observer', () => ({ useInView: () => ({ ref: vi.fn(), inView: true }) }));
vi.mock('../../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt} />,
  PoweredBy: () => null,
  Button: ({ children, ...rest }: React.ButtonHTMLAttributes<HTMLButtonElement>) => <button {...rest}>{children}</button>,
  Input: ({ label: _l, error: _e, ...rest }: React.InputHTMLAttributes<HTMLInputElement> & { label?: string; error?: string }) => <input {...rest} />,
}));
vi.mock('../../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: { gallerySettings: { masonryMode: 'columns' } } }),
}));
vi.mock('../../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../../services/feedback.service', () => ({
  feedbackService: { submitFeedback: vi.fn(), getPhotoFeedback: vi.fn() },
}));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string, opts?: { count?: number }) =>
      String(fallback ?? _key).replace('{{count}}', String(opts?.count ?? '')),
  }),
}));

const photos: Photo[] = [1, 2].map((id) => ({
  id,
  filename: `IMG_${id}.jpg`,
  url: `/api/gallery/x/photo/${id}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  width: 4000,
  height: 3000,
  my_rating: null,
} as Photo));

const layoutProps = {
  photos,
  slug: 'x',
  onPhotoClick: () => {},
  onDownload: () => {},
  selectedPhotos: new Set<number>(),
  isSelectionMode: false,
  allowDownloads: true,
  feedbackEnabled: true,
  feedbackOptions: { allowLikes: true, allowRatings: true, requireNameEmail: true },
} as never;

function stubPointerDevice() {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true, writable: true,
    value: (query: string) => ({
      matches: false, media: query, onchange: null,
      addEventListener: () => {}, removeEventListener: () => {}, addListener: () => {}, removeListener: () => {},
      dispatchEvent: () => false,
    }),
  });
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 0 });
  delete (window as any).ontouchstart;
  __inputModeTesting.reset();
}

beforeEach(() => {
  stubPointerDevice();
  Object.defineProperty(window, 'devicePixelRatio', { value: 1, configurable: true });
  Object.defineProperty(window, 'innerWidth', { value: 1440, configurable: true });
  Object.defineProperty(HTMLElement.prototype, 'offsetWidth', { configurable: true, get: () => 1440 });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.mocked(feedbackService.submitFeedback).mockResolvedValue({ success: true } as never);
  vi.mocked(feedbackService.getPhotoFeedback).mockResolvedValue({
    feedback: [], my_feedback: {}, summary: { average_rating: 4, total_ratings: 1 },
  } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function rateTwoTiles(ui: React.ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>);

  const fourStars = () => screen.getAllByRole('button', { name: 'Rate 4 stars' });
  expect(fourStars()).toHaveLength(2);

  fireEvent.click(fourStars()[0]);
  expect(feedbackService.submitFeedback).not.toHaveBeenCalled();
  fireEvent.change(screen.getByPlaceholderText('Enter your name'), { target: { value: 'Maria' } });
  fireEvent.change(screen.getByPlaceholderText('Enter your email'), { target: { value: 'maria@example.com' } });
  fireEvent.click(screen.getByRole('button', { name: 'Submit Feedback' }));
  await waitFor(() => expect(feedbackService.submitFeedback).toHaveBeenCalledWith(
    'x', '1', expect.objectContaining({ rating: 4, guest_name: 'Maria' }),
  ));
  await waitFor(() => expect(screen.queryByPlaceholderText('Enter your name')).not.toBeInTheDocument());

  // Second tile: the layout holds the identity, so no modal and a direct submit.
  fireEvent.click(fourStars()[1]);
  await waitFor(() => expect(feedbackService.submitFeedback).toHaveBeenCalledWith(
    'x', '2', expect.objectContaining({ rating: 4, guest_name: 'Maria', guest_email: 'maria@example.com' }),
  ));
  expect(screen.queryByPlaceholderText('Enter your name')).not.toBeInTheDocument();
}

describe('tile rating identity is held by the layout', () => {
  it('Mosaic asks once for two tiles', async () => {
    await rateTwoTiles(<MosaicGalleryLayout {...layoutProps} />);
  });

  it('Masonry columns mode asks once for two tiles', async () => {
    await rateTwoTiles(<MasonryGalleryLayout {...layoutProps} />);
  });
});
