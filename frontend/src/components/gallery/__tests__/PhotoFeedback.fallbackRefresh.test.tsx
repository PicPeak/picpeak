/**
 * Without a parent that refreshes the row, a saved like still invalidates
 * the gallery list.
 *
 * The panel handed its buttons a saved-callback unconditionally. With no
 * parent behind it that callback did nothing, and because the buttons only
 * invalidate the list when they have no callback, the cached rows stayed
 * stale after a like or favourite.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }),
}));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../hooks/useFeedbackLimitModal', () => ({ useFeedbackLimitModal: () => ({ modal: null, handleError: () => false }) }));
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn().mockResolvedValue({
      feedback_enabled: true, allow_likes: true, allow_ratings: false, allow_comments: false, allow_favorites: false,
    }),
    getPhotoFeedback: vi.fn().mockResolvedValue({ feedback: [], my_feedback: {}, summary: {} }),
    submitFeedback: vi.fn().mockResolvedValue({}),
  },
}));
import { feedbackService } from '../../../services/feedback.service';
import { PhotoFeedback } from '../PhotoFeedback';

async function like(onFeedbackUpdate?: (id?: number) => void) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const invalidate = vi.spyOn(queryClient, 'invalidateQueries');
  render(
    <QueryClientProvider client={queryClient}>
      <PhotoFeedback photoId="5" gallerySlug="g" onFeedbackUpdate={onFeedbackUpdate} />
    </QueryClientProvider>,
  );
  fireEvent.click(await screen.findByRole('button'));
  await waitFor(() => expect(feedbackService.submitFeedback).toHaveBeenCalled());
  await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['photo-feedback', 'g', '5'] }));
  return invalidate;
}

describe('PhotoFeedback: who refreshes the gallery list after a like', () => {
  it('the buttons do, when no parent is given', async () => {
    const invalidate = await like();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['gallery-photos', 'g'] });
  });

  it('the parent does, with the photo, when one is given', async () => {
    const onFeedbackUpdate = vi.fn();
    const invalidate = await like(onFeedbackUpdate);
    expect(onFeedbackUpdate).toHaveBeenCalledWith(5);
    expect(invalidate).not.toHaveBeenCalledWith({ queryKey: ['gallery-photos', 'g'] });
  });
});
