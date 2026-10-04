/**
 * A favourite toggle must refresh my-feedback once the server accepted it.
 * The parent refetch fires from onMutate, before the POST; in guest identity
 * mode the Favorited filter and the filename list (issue 1733, A3d) read the
 * guest's own rows from my-feedback, which otherwise stayed stale.
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PhotoFavorites } from '../PhotoFavorites';

vi.mock('react-i18next', async () => {
  const actual = await vi.importActual<typeof import('react-i18next')>('react-i18next');
  return { ...actual, useTranslation: () => ({ t: (key: string, fallback?: string) => fallback ?? key }) };
});

const submitFeedback = vi.fn();
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: { submitFeedback: (...args: unknown[]) => submitFeedback(...args) },
}));

vi.mock('react-toastify', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
vi.mock('../../../hooks/useFeedbackLimitModal', () => ({
  useFeedbackLimitModal: () => ({ modal: null, handleError: () => false }),
}));

describe('PhotoFavorites — my-feedback refresh', () => {
  it('invalidates my-feedback for the gallery once the toggle is accepted', async () => {
    submitFeedback.mockResolvedValue({ ok: true });
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    render(
      <QueryClientProvider client={queryClient}>
        <PhotoFavorites photoId="7" gallerySlug="summer" isFavorited={false} favoriteCount={0} isEnabled />
      </QueryClientProvider>
    );

    fireEvent.click(screen.getByRole('button', { name: 'Add to favorites' }));

    await waitFor(() => expect(submitFeedback).toHaveBeenCalledWith('summer', '7', expect.objectContaining({ feedback_type: 'favorite' })));
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['my-feedback', 'summer'] }));
  });
});
