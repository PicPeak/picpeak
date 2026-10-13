/**
 * Issue 1891: a like on a tile names its photo to the gallery, which then
 * refreshes that one row instead of refetching the whole photo list.
 */
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { PhotoCard } from '../PhotoCard';
import type { Photo } from '../../../types';

vi.mock('../../common', () => ({
  AuthenticatedImage: ({ src, alt }: { src: string; alt?: string }) => <img src={src} alt={alt} />,
}));
vi.mock('../../../contexts/GuestIdentityContext', () => ({
  useGuestIdentityOptional: () => null,
}));
const submitFeedback = vi.fn();
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: { submitFeedback: (...args: unknown[]) => submitFeedback(...args) },
}));

const photo = {
  id: 7,
  filename: 'IMG_0001.jpg',
  url: '/p/7',
  thumbnail_url: '/t/7',
  type: 'individual',
  size: 1,
  uploaded_at: '2026-01-01T00:00:00Z',
} as Photo;

describe('PhotoCard like', () => {
  it('reports the liked photo id once the like is submitted', async () => {
    submitFeedback.mockResolvedValue({ success: true });
    const onFeedbackChange = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PhotoCard
          photo={photo}
          isSelected={false}
          isSelectionMode={false}
          onClick={() => {}}
          onDownload={() => {}}
          onToggleSelect={() => {}}
          imageProps={{ src: '/t/7', alt: 'IMG_0001.jpg' }}
          overlayBaseClassName="absolute inset-0"
          slug="summer"
          feedbackEnabled
          feedbackOptions={{ allowLikes: true }}
          onFeedbackChange={onFeedbackChange}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Like photo' }));

    await waitFor(() => expect(onFeedbackChange).toHaveBeenCalledWith(7));
    expect(submitFeedback).toHaveBeenCalledWith('summer', '7', expect.objectContaining({ feedback_type: 'like' }));
  });

  // Issue 1733: a like refused by a finished selection wrote nothing, so the
  // optimistic toggle is taken back; any other failure keeps it, as before.
  it.each([
    ['a lock refusal', { response: { status: 409, data: { code: 'SELECTION_LOCKED' } } }, 2],
    ['another failure', new Error('offline'), 1],
  ])('toggles the heart back after %s only', async (_name, error, toggles) => {
    submitFeedback.mockReset().mockRejectedValue(error);
    const onLikeSuccess = vi.fn();
    const onFeedbackChange = vi.fn();
    render(
      <QueryClientProvider client={new QueryClient()}>
        <PhotoCard
          photo={photo}
          isSelected={false}
          isSelectionMode={false}
          onClick={() => {}}
          onDownload={() => {}}
          onToggleSelect={() => {}}
          imageProps={{ src: '/t/7', alt: 'IMG_0001.jpg' }}
          overlayBaseClassName="absolute inset-0"
          slug="summer"
          feedbackEnabled
          feedbackOptions={{ allowLikes: true }}
          onLikeSuccess={onLikeSuccess}
          onFeedbackChange={onFeedbackChange}
        />
      </QueryClientProvider>,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Like photo' }));

    await waitFor(() => expect(onFeedbackChange).toHaveBeenCalledWith(7));
    expect(onLikeSuccess).toHaveBeenCalledTimes(toggles);
  });
});
