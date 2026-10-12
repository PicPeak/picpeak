/**
 * The saved callback names the photo the toggle was for.
 *
 * The lightbox keeps one feedback panel and hands it the next photo's id on
 * navigation. A like sent for photo A whose answer arrives after the panel
 * moved on to B reported B, so the gallery refreshed the wrong row and A
 * stayed stale.
 */
import React from 'react';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider, onlineManager } from '@tanstack/react-query';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  initReactI18next: { type: '3rdParty', init: vi.fn() },
  useTranslation: () => ({ t: (k: string, d?: unknown) => (typeof d === 'string' ? d : k) }),
}));
vi.mock('react-toastify', () => ({ toast: { error: vi.fn() } }));
vi.mock('../../../contexts/GuestIdentityContext', () => ({ useGuestIdentityOptional: () => null }));
vi.mock('../../../hooks/useFeedbackLimitModal', () => ({ useFeedbackLimitModal: () => ({ modal: null, handleError: () => false }) }));
const submitFeedback = vi.fn();
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: { submitFeedback: (...args: unknown[]) => submitFeedback(...args) },
}));

import { PhotoLikes } from '../PhotoLikes';
import { PhotoFavorites } from '../PhotoFavorites';

describe.each([
  ['PhotoLikes', PhotoLikes, { likeCount: 0, isLiked: false }],
  ['PhotoFavorites', PhotoFavorites, { favoriteCount: 0, isFavorited: false }],
] as const)('%s', (_name, Component, state) => {
  it('reports the photo it was submitted for, not the one shown when the answer arrives', async () => {
    let accept: (value: unknown) => void = () => {};
    submitFeedback.mockReset().mockImplementationOnce(() => new Promise((resolve) => { accept = resolve; }));
    const onSaved = vi.fn();
    const queryClient = new QueryClient();
    const ui = (photoId: string) => (
      <QueryClientProvider client={queryClient}>
        {React.createElement(Component as React.FC<Record<string, unknown>>, { photoId, gallerySlug: 'g', isEnabled: true, onSaved, ...state })}
      </QueryClientProvider>
    );
    const { rerender } = render(ui('1'));

    fireEvent.click(screen.getByRole('button'));
    await waitFor(() => expect(submitFeedback).toHaveBeenCalledWith('g', '1', expect.anything()));
    rerender(ui('2'));
    accept({});

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    expect(onSaved).toHaveBeenCalledWith('1');
  });

  // A toggle paused while offline is sent later, by whatever the component
  // looks like then. It must still go to the photo it was made on.
  it('sends a toggle that was paused offline for the photo it was made on', async () => {
    submitFeedback.mockReset().mockResolvedValue({});
    const onSaved = vi.fn();
    const queryClient = new QueryClient();
    const ui = (photoId: string) => (
      <QueryClientProvider client={queryClient}>
        {React.createElement(Component as React.FC<Record<string, unknown>>, { photoId, gallerySlug: 'g', isEnabled: true, onSaved, ...state })}
      </QueryClientProvider>
    );
    onlineManager.setOnline(false);
    try {
      const { rerender } = render(ui('1'));
      fireEvent.click(screen.getByRole('button'));
      rerender(ui('2'));
      expect(submitFeedback).not.toHaveBeenCalled();
      onlineManager.setOnline(true);

      await waitFor(() => expect(submitFeedback).toHaveBeenCalledTimes(1));
      expect(submitFeedback).toHaveBeenCalledWith('g', '1', expect.anything());
      await waitFor(() => expect(onSaved).toHaveBeenCalledWith('1'));
    } finally {
      onlineManager.setOnline(true);
    }
  });
});
