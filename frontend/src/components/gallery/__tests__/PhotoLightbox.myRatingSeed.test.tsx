/**
 * The lightbox seeds its stars from the list row's my_rating (issue 1733),
 * and follows that value when it changes while the lightbox is open on the
 * same photo — a tile rating whose POST settles after the lightbox opened
 * must still reach the stars.
 */
import React from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';
import type { Photo } from '../../../types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }) }));
vi.mock('../../../hooks/useDevToolsProtection', () => ({ useDevToolsProtection: () => undefined }));
vi.mock('../../../hooks/useGallery', () => ({ useSavePhotoToDevice: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../../../hooks/useFeedbackLimitModal', () => ({ useFeedbackLimitModal: () => ({ modal: null, handleError: () => false }) }));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn().mockResolvedValue({ feedback_enabled: true, allow_ratings: true, allow_likes: false, allow_comments: false }),
    getPhotoFeedback: vi.fn(),
  },
}));
import { feedbackService } from '../../../services/feedback.service';
vi.mock('../../../services/gallery.service', () => ({ galleryService: { trackPhotoView: vi.fn() } }));
vi.mock('../../common', () => ({ AuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} /> }));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn() } }));

import { PhotoLightbox } from '../PhotoLightbox';

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });

const photo = (my_rating: number | null) => ({
  id: 5, filename: 'a.jpg', url: '/api/gallery/g/photo/5', thumbnail_url: '/t/5', type: 'individual', my_rating,
} as Photo);

const ui = (p: Photo) => (
  <QueryClientProvider client={new QueryClient()}>
    <PhotoLightbox photos={[p]} initialIndex={0} onClose={vi.fn()} slug="g" feedbackEnabled />
  </QueryClientProvider>
);

describe('PhotoLightbox — my_rating seed follows the list row', () => {
  it('reseeds the stars when the same photo\'s my_rating changes under an open lightbox', async () => {
    // The first per-photo fetch answers before the tile POST has settled;
    // the one the reseed triggers sees the stored rating.
    vi.mocked(feedbackService.getPhotoFeedback)
      .mockResolvedValueOnce({ feedback: [], my_feedback: { rating: 0 }, summary: {} } as never)
      .mockResolvedValue({ feedback: [], my_feedback: { rating: 4 }, summary: {} } as never);
    const { rerender } = render(ui(photo(null)));
    await waitFor(() => expect(screen.getByTitle('Rate 4')).toBeInTheDocument());
    expect(screen.queryByTitle('Remove rating')).toBeNull();

    rerender(ui(photo(4)));

    await waitFor(() => expect(screen.getByTitle('Remove rating')).toBeInTheDocument());
    expect(screen.getByTitle('Remove rating')).toHaveAttribute('aria-label', 'Remove rating');
    expect(screen.queryByTitle('Rate 4')).toBeNull();
  });

  it('drops a per-photo GET from before the rating whole — stars and summary — and shows the fresh one', async () => {
    const resolvers: Array<(v: unknown) => void> = [];
    vi.mocked(feedbackService.getPhotoFeedback).mockReset();
    vi.mocked(feedbackService.getPhotoFeedback).mockImplementation(
      () => new Promise((resolve) => { resolvers.push(resolve); }) as never,
    );
    vi.mocked(feedbackService.getGalleryFeedbackSettings).mockResolvedValue({
      feedback_enabled: true, allow_ratings: true, allow_likes: false, allow_comments: false, show_feedback_to_guests: true,
    } as never);
    const { rerender } = render(ui(photo(null)));
    await waitFor(() => expect(resolvers).toHaveLength(1));

    // Tile POST settles: the list row now says 4, and a fresh GET goes out.
    rerender(ui(photo(4)));
    await waitFor(() => expect(screen.getByTitle('Remove rating')).toBeInTheDocument());
    await waitFor(() => expect(resolvers).toHaveLength(2));

    // The GET from before the rating comes back last, with the old values.
    resolvers[1]({ feedback: [], my_feedback: { rating: 4 }, summary: { average_rating: 4, total_ratings: 1 } });
    await waitFor(() => expect(screen.getByText('4.0 (1)')).toBeInTheDocument());
    resolvers[0]({ feedback: [], my_feedback: { rating: 0 }, summary: { average_rating: 0, total_ratings: 0 } });
    await new Promise((r) => setTimeout(r, 20));

    expect(screen.getByTitle('Remove rating')).toBeInTheDocument();
    expect(screen.queryByTitle('Rate 4')).toBeNull();
    expect(screen.getByText('4.0 (1)')).toBeInTheDocument();
    expect(screen.queryByText('0.0 (0)')).toBeNull();
  });
});
