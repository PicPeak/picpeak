/**
 * A like the server refuses is said out loud in the lightbox (issue 1891).
 *
 * The lightbox only logged the failure. A guest who had run into the request
 * rate limit therefore saw a heart that did nothing, tapped again, and again.
 * The grid's like button (PhotoLikes) already named the 429; the lightbox
 * now does too.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Photo } from '../../../types';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }) }));
vi.mock('../../../hooks/useDevToolsProtection', () => ({ useDevToolsProtection: () => undefined }));
vi.mock('../../../hooks/useGallery', () => ({ useSavePhotoToDevice: () => ({ mutate: vi.fn(), isPending: false }) }));
vi.mock('../../../hooks/useFeedbackLimitModal', () => ({ useFeedbackLimitModal: () => ({ modal: null, handleError: () => false }) }));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn().mockResolvedValue({ feedback_enabled: true, allow_ratings: false, allow_likes: true, allow_comments: false }),
    getPhotoFeedback: vi.fn().mockResolvedValue({ feedback: [], my_feedback: {}, summary: {} }),
    submitFeedback: vi.fn(),
  },
}));
import { feedbackService } from '../../../services/feedback.service';
vi.mock('../../../services/gallery.service', () => ({ galleryService: { trackPhotoView: vi.fn() } }));
vi.mock('../../common', () => ({ AuthenticatedImage: ({ alt }: { alt: string }) => <img alt={alt} /> }));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn() } }));
vi.mock('../FeedbackIdentityModal', () => ({
  FeedbackIdentityModal: ({ isOpen, onSubmit }: { isOpen: boolean; onSubmit: (name: string, email: string) => void }) =>
    (isOpen ? <button onClick={() => onSubmit('Anna', 'anna@example.com')}>identify</button> : null),
}));
import { toast } from 'react-toastify';

import { PhotoLightbox } from '../PhotoLightbox';

vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });

const photo = { id: 5, filename: 'a.jpg', url: '/api/gallery/g/photo/5', thumbnail_url: '/t/5', type: 'individual' } as Photo;
const onFeedbackChange = vi.fn();

async function likeWith(error: unknown) {
  vi.mocked(feedbackService.submitFeedback).mockRejectedValueOnce(error);
  render(
    <QueryClientProvider client={new QueryClient()}>
      <PhotoLightbox photos={[photo]} initialIndex={0} onClose={vi.fn()} slug="g" feedbackEnabled onFeedbackChange={onFeedbackChange} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button', { name: LIKE }));
  await waitFor(() => expect(toast.error).toHaveBeenCalledTimes(1));
}
const LIKE = /^like photo$/i;

// The like that waits behind the name-and-email prompt is a third path.
describe('PhotoLightbox — a refused like after the identity prompt', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('names the rate limit too', async () => {
    vi.mocked(feedbackService.getGalleryFeedbackSettings).mockResolvedValueOnce({
      feedback_enabled: true, allow_ratings: false, allow_likes: true, allow_comments: false, require_name_email: true,
    } as never);
    vi.mocked(feedbackService.submitFeedback).mockRejectedValueOnce({ response: { status: 429 } });
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PhotoLightbox photos={[photo]} initialIndex={0} onClose={vi.fn()} slug="g" feedbackEnabled />
      </QueryClientProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: LIKE }));
    fireEvent.click(await screen.findByRole('button', { name: 'identify' }));

    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('Too many requests. Wait a few minutes, then try again.'));
  });
});

describe('PhotoLightbox — a refused like', () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it('names the rate limit on a 429', async () => {
    await likeWith({ response: { status: 429 } });
    expect(toast.error).toHaveBeenCalledWith('Too many requests. Wait a few minutes, then try again.');
    expect(onFeedbackChange).not.toHaveBeenCalled();
  });

  it('reports any other failure as a failed like', async () => {
    await likeWith(new Error('network'));
    expect(toast.error).toHaveBeenCalledWith('Failed to update like');
  });
});
