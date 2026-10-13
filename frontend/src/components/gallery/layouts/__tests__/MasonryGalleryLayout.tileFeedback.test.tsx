/**
 * Tile feedback in the rows, flickr and quilted masonry modes (issue 1733,
 * A3a follow-up).
 *
 * Only columns mode passed the feedback props to its tile; the other three
 * rendered a bare PhotoCard with the count indicators and nothing to press.
 * Each mode must now offer like, comment and the rating row when feedback is
 * on, nothing when it is off, and share one identity across tiles.
 */
import React from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

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
let masonryMode = 'rows';
vi.mock('../../../../contexts/ThemeContext', () => ({
  useTheme: () => ({ theme: { gallerySettings: { masonryMode } } }),
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

const photo = (id: number, width: number, height: number) => ({
  id,
  filename: `IMG_${id}.jpg`,
  url: `/api/gallery/x/photo/${id}`,
  thumbnail_url: `/api/gallery/x/thumbnail/${id}`,
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
  width,
  height,
  my_rating: null,
} as Photo);

const landscapes = [photo(1, 4000, 3000), photo(2, 4000, 3000)];

function renderLayout(overrides: Record<string, unknown> = {}) {
  const onOpenPhotoWithFeedback = vi.fn();
  const onPhotoClick = vi.fn();
  const props = {
    photos: landscapes,
    slug: 'x',
    onPhotoClick,
    onOpenPhotoWithFeedback,
    onDownload: () => {},
    selectedPhotos: new Set<number>(),
    isSelectionMode: false,
    allowDownloads: true,
    feedbackEnabled: true,
    feedbackOptions: { allowLikes: true, allowRatings: true, allowComments: true },
    ...overrides,
  } as never;
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><MasonryGalleryLayout {...props} /></QueryClientProvider>);
  return { onOpenPhotoWithFeedback, onPhotoClick };
}

const tileOf = (id: number) => screen.getByAltText(`IMG_${id}.jpg`).closest('.photo-card') as HTMLElement;

beforeEach(() => {
  // A mouse, so a tile click acts straight away instead of revealing the overlay.
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

describe.each(['rows', 'flickr', 'quilted'])('Masonry %s mode tile feedback', (mode) => {
  beforeEach(() => { masonryMode = mode; });

  it('renders like, comment and the rating row when feedback is enabled', () => {
    renderLayout();
    expect(screen.getAllByRole('button', { name: 'Like photo' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Comment on photo' })).toHaveLength(2);
    expect(screen.getAllByRole('button', { name: 'Rate 4 stars' })).toHaveLength(2);
  });

  it('renders none of them when feedback is disabled', () => {
    renderLayout({ feedbackEnabled: false });
    // The tiles themselves are there.
    expect(screen.getAllByRole('button', { name: 'View full size' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Like photo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Comment on photo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rate 4 stars' })).not.toBeInTheDocument();
  });

  it('follows the per-action switches', () => {
    renderLayout({ feedbackOptions: { allowLikes: true, allowRatings: false, allowComments: false } });
    expect(screen.getAllByRole('button', { name: 'Like photo' })).toHaveLength(2);
    expect(screen.queryByRole('button', { name: 'Comment on photo' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Rate 4 stars' })).not.toBeInTheDocument();
  });

  it('likes, toggles the button and opens the comments of the right photo', async () => {
    const { onOpenPhotoWithFeedback, onPhotoClick } = renderLayout();

    fireEvent.click(screen.getAllByRole('button', { name: 'Like photo' })[1]);
    await waitFor(() => expect(feedbackService.submitFeedback).toHaveBeenCalledWith(
      'x', '2', expect.objectContaining({ feedback_type: 'like' }),
    ));
    expect(screen.getByRole('button', { name: 'Unlike photo' })).toHaveAttribute('aria-pressed', 'true');

    fireEvent.click(screen.getAllByRole('button', { name: 'Comment on photo' })[1]);
    expect(onOpenPhotoWithFeedback).toHaveBeenCalledWith(1);
    expect(onPhotoClick).not.toHaveBeenCalled();
  });

  it('asks for name and email once, outside the tile, and reuses it on the next tile', async () => {
    const { onPhotoClick } = renderLayout({
      feedbackOptions: { allowLikes: true, allowRatings: true, allowComments: true, requireNameEmail: true },
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Like photo' })[0]);
    expect(feedbackService.submitFeedback).not.toHaveBeenCalled();
    const nameInput = screen.getByPlaceholderText('Enter your name');
    // These tiles carry `content-visibility`, which would clip a fixed modal
    // rendered inside them.
    expect(tileOf(1).contains(nameInput)).toBe(false);
    fireEvent.click(nameInput);
    expect(onPhotoClick).not.toHaveBeenCalled();

    fireEvent.change(nameInput, { target: { value: 'Maria' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your email'), { target: { value: 'maria@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Feedback' }));
    await waitFor(() => expect(feedbackService.submitFeedback).toHaveBeenCalledWith(
      'x', '1', expect.objectContaining({ feedback_type: 'like', guest_name: 'Maria' }),
    ));
    await waitFor(() => expect(screen.queryByPlaceholderText('Enter your name')).not.toBeInTheDocument());

    // Second tile, rating this time: the layout holds the identity.
    fireEvent.click(screen.getAllByRole('button', { name: 'Rate 4 stars' })[1]);
    await waitFor(() => expect(feedbackService.submitFeedback).toHaveBeenCalledWith(
      'x', '2', expect.objectContaining({ rating: 4, guest_name: 'Maria', guest_email: 'maria@example.com' }),
    ));
    expect(screen.queryByPlaceholderText('Enter your name')).not.toBeInTheDocument();
  });
});

// GalleryView's useFeedbackChange hangs off this callback: without it a tile
// like leaves the like counts and the Liked filter as they were.
describe.each(['columns', 'rows', 'flickr', 'quilted'])('Masonry %s mode tile like reports the change', (mode) => {
  beforeEach(() => { masonryMode = mode; });

  it('names the toggled photo after a like', async () => {
    const onFeedbackChange = vi.fn();
    renderLayout({ onFeedbackChange });

    fireEvent.click(screen.getAllByRole('button', { name: 'Like photo' })[1]);
    await waitFor(() => expect(onFeedbackChange).toHaveBeenCalledWith(2));
    expect(onFeedbackChange).toHaveBeenCalledTimes(1);
  });

  it('names it after a like that went through the identity modal', async () => {
    const onFeedbackChange = vi.fn();
    renderLayout({
      onFeedbackChange,
      feedbackOptions: { allowLikes: true, allowRatings: true, allowComments: true, requireNameEmail: true },
    });

    fireEvent.click(screen.getAllByRole('button', { name: 'Like photo' })[0]);
    expect(onFeedbackChange).not.toHaveBeenCalled();
    fireEvent.change(screen.getByPlaceholderText('Enter your name'), { target: { value: 'Maria' } });
    fireEvent.change(screen.getByPlaceholderText('Enter your email'), { target: { value: 'maria@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: 'Submit Feedback' }));
    await waitFor(() => expect(onFeedbackChange).toHaveBeenCalledWith(1));
    expect(feedbackService.submitFeedback).toHaveBeenCalledWith(
      'x', '1', expect.objectContaining({ feedback_type: 'like', guest_name: 'Maria' }),
    );
    expect(onFeedbackChange).toHaveBeenCalledTimes(1);
  });
});

describe.each(['rows', 'flickr'])('Masonry %s mode, tile narrower than the action buttons', (mode) => {
  beforeEach(() => { masonryMode = mode; });

  it('wraps the buttons and leaves the rating to the lightbox', () => {
    // A 1:3 portrait beside landscapes at one row height.
    renderLayout({ photos: [photo(1, 4000, 3000), photo(2, 1000, 3000), photo(3, 4000, 3000)] });

    const narrow = tileOf(2);
    expect(parseFloat(narrow.style.width)).toBeLessThan(168);
    expect(narrow.querySelector('.flex-wrap')).not.toBeNull();
    expect(narrow.querySelector('[aria-label="Like photo"]')).not.toBeNull();
    expect(narrow.querySelector('[aria-label="Comment on photo"]')).not.toBeNull();
    expect(narrow.querySelector('[aria-label="Rate 4 stars"]')).toBeNull();

    const wide = tileOf(1);
    expect(parseFloat(wide.style.width)).toBeGreaterThanOrEqual(168);
    expect(wide.querySelector('.flex-wrap')).toBeNull();
    expect(wide.querySelector('[aria-label="Rate 4 stars"]')).not.toBeNull();
  });
});
