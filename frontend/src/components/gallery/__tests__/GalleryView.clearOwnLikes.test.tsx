/**
 * "Remove my likes" (issue 2561): the toolbar offers it with the viewer's own
 * like count (is_liked, not the chip's every-guest count), asks first, and
 * refreshes the list after the server removed them.
 */
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type PhotosResult = { data: unknown; isLoading: boolean; error: unknown; refetch: () => void };
let photos: PhotosResult;

// Hooks hand back the same objects on every render, as the real ones do;
// fresh ones each time would re-run the view's effects without end.
const stable = vi.hoisted(() => ({
  auth: { logout: () => {}, endSession: () => {}, isClient: false, viaCustomer: false, viaClientPin: false,
    enterClientMode: vi.fn(), leaveClientMode: vi.fn() },
  theme: { setTheme: () => {}, theme: { galleryLayout: 'grid' } as { galleryLayout: string } },
  download: { mutate: () => {}, isPending: false },
  settings: { data: {} },
  watermark: { watermarkEnabled: false },
  t: (key: string) => key,
}));

vi.mock('../../../contexts', () => ({
  useGalleryAuth: () => stable.auth,
  useTheme: () => stable.theme,
}));

vi.mock('../../../hooks/useGallery', () => ({
  useGalleryPhotos: () => photos,
  useDownloadAllPhotos: () => stable.download,
}));

vi.mock('../../../hooks/usePublicSettings', () => ({ usePublicSettings: () => stable.settings }));
vi.mock('../../../hooks/useWatermarkSettings', () => ({ useWatermarkSettings: () => stable.watermark }));
vi.mock('../../../hooks/useGalleryCustomCss', () => ({ useGalleryCustomCss: () => undefined }));
vi.mock('../../../hooks/useDevToolsProtection', () => ({ useDevToolsProtection: () => undefined }));

vi.mock('react-i18next', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: stable.t, i18n: { language: 'en' } }),
}));

vi.mock('../../../services/analytics.service', () => ({
  analyticsService: { track: vi.fn(), trackGalleryEvent: vi.fn(), trackSearch: vi.fn(), trackExpirationWarning: vi.fn() },
}));
vi.mock('../../../services/gallery.service', () => ({
  galleryService: { getPeople: vi.fn().mockResolvedValue({ people: [] }) },
}));
const settings = vi.hoisted(() => ({ current: { feedback_enabled: true, allow_likes: true } as Record<string, unknown> }));
const clearMyLikes = vi.hoisted(() => vi.fn());
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn(async () => settings.current),
    getMyFeedback: vi.fn().mockResolvedValue([]),
    clearMyLikes,
  },
}));
vi.mock('react-toastify', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

vi.mock('../GalleryLayout', () => ({
  GalleryLayout: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../PhotoGridWithLayouts', () => ({ PhotoGridWithLayouts: () => null }));
vi.mock('../PhotoFilterBar', () => ({
  PhotoFilterBar: ({ clearOwnLikes }: { clearOwnLikes?: { count: number; onClick: () => void } }) => (
    clearOwnLikes && clearOwnLikes.count > 0
      ? <button type="button" onClick={clearOwnLikes.onClick}>{`remove ${clearOwnLikes.count}`}</button>
      : null
  ),
}));

import { act, fireEvent, waitFor } from '@testing-library/react';
import { GalleryView } from '../GalleryView';
import { ConfirmDialogProvider } from '../../common/ConfirmDialog';

const event = { id: 1, event_name: 'Hoa Wedding', event_type: 'wedding', event_date: '2026-09-19', expires_at: '2027-09-19T00:00:00Z' };

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

beforeEach(() => {
  clearMyLikes.mockReset().mockResolvedValue({ success: true, removed: 2, photo_ids: [7, 8] });
  settings.current = { feedback_enabled: true, allow_likes: true };
  photos = {
    data: {
      event,
      categories: [],
      // 7 and 8 liked by this viewer; 9 liked by someone else only.
      photos: [7, 8, 9].map((id) => ({
        id, filename: `${id}.jpg`, url: `/${id}.jpg`, thumbnail_url: `/${id}-t.jpg`, type: 'photo', size: 1,
        uploaded_at: '2026-09-19T10:00:00Z', is_liked: id !== 9, like_count: 1,
      })),
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  };
});

const renderView = (withProvider = false) => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = <GalleryView slug="wedding" event={event} />;
  return render(
    <QueryClientProvider client={client}>
      {withProvider ? <ConfirmDialogProvider>{view}</ConfirmDialogProvider> : view}
    </QueryClientProvider>,
  );
};

describe('remove my likes (issue 2561)', () => {
  it('asks in the gallery\'s confirm dialog, then removes and refreshes', async () => {
    renderView(true);
    fireEvent.click(await screen.findByText('remove 2'));
    expect(await screen.findByRole('dialog')).toHaveTextContent('gallery.filterPanel.clearLikesTitle');
    expect(clearMyLikes).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('gallery.filterPanel.clearLikesAction'));
    await waitFor(() => expect(clearMyLikes).toHaveBeenCalledWith('wedding'));
    await waitFor(() => expect(photos.refetch).toHaveBeenCalled());
  });

  it('removes nothing when the guest cancels', async () => {
    vi.stubGlobal('confirm', vi.fn(() => false));
    renderView();
    fireEvent.click(await screen.findByText('remove 2'));
    await act(async () => {});
    expect(window.confirm).toHaveBeenCalled();
    expect(clearMyLikes).not.toHaveBeenCalled();
  });

  it('is not offered when likes are off', async () => {
    settings.current = { feedback_enabled: true, allow_likes: false };
    renderView();
    await act(async () => {});
    expect(screen.queryByText(/^remove/)).toBeNull();
  });
});
