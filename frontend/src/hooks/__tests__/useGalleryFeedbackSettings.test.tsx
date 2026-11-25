/**
 * The gallery's feedback settings are one cache entry shared by the view,
 * the lightbox and the feedback panel. A refetch that fails (a 429, a 5xx,
 * a network blip while a photo is open) must not switch feedback off for
 * the whole gallery.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

const getGalleryFeedbackSettings = vi.hoisted(() => vi.fn());

vi.mock('../../services/feedback.service', () => ({
  feedbackService: { getGalleryFeedbackSettings },
}));

import { galleryFeedbackSettingsQueryKey, useGalleryFeedbackSettings } from '../useGalleryFeedbackSettings';

function setup() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

afterEach(() => {
  getGalleryFeedbackSettings.mockReset();
  vi.restoreAllMocks();
});

describe('useGalleryFeedbackSettings', () => {
  it('keeps the cached settings when a refetch fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getGalleryFeedbackSettings.mockResolvedValueOnce({ feedback_enabled: true, identity_mode: 'guest' });
    const { client, wrapper } = setup();

    const { result } = renderHook(() => useGalleryFeedbackSettings('wedding'), { wrapper });
    await waitFor(() => expect(result.current.data?.feedback_enabled).toBe(true));

    getGalleryFeedbackSettings.mockRejectedValueOnce(new Error('Too many requests'));
    await act(async () => {
      await client.refetchQueries({ queryKey: galleryFeedbackSettingsQueryKey('wedding') });
    });

    expect(getGalleryFeedbackSettings).toHaveBeenCalledTimes(2);
    // The entry GalleryView reads, shared with the lightbox.
    expect(client.getQueryData(galleryFeedbackSettingsQueryKey('wedding')))
      .toEqual({ feedback_enabled: true, identity_mode: 'guest' });
  });

  it('reads a first failed request as feedback off', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getGalleryFeedbackSettings.mockRejectedValueOnce(new Error('offline'));
    const { wrapper } = setup();

    const { result } = renderHook(() => useGalleryFeedbackSettings('wedding'), { wrapper });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data).toEqual({ feedback_enabled: false });
  });
});
