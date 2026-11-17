/**
 * "Remove my likes" (issue 2561): the filter panel offers it while the viewer
 * has own likes, a confirmation comes first, and the gallery list is fetched
 * again afterwards so the hearts, the chips and the lightbox all read the
 * server's answer.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type GridProps = {
  onSelectionChange: (ids: Set<number>) => void;
  onToggleSelectionMode: () => void;
  selectedPhotos: Set<number>;
  isSelectionMode: boolean;
  photos: Array<{ id: number }>;
};

const captured = vi.hoisted(() => ({ grid: null as unknown as GridProps }));

const stable = vi.hoisted(() => ({
  auth: { logout: () => {}, isClient: false, viaCustomer: false },
  theme: { setTheme: () => {}, theme: { galleryLayout: 'grid' } },
  download: { mutate: () => {}, isPending: false },
  settings: { data: {} },
  watermark: { watermarkEnabled: false },
  t: (key: string, options?: unknown) => {
    const count = (options as { count?: number } | undefined)?.count;
    return count === undefined ? key : `${key}:${count}`;
  },
  photos: null as unknown,
}));

const service = vi.hoisted(() => ({
  downloadPhoto: vi.fn().mockResolvedValue(undefined),
  downloadSelectedPhotos: vi.fn().mockResolvedValue(true),
}));

vi.mock('../../../contexts/ArchiveDownloadContext', () => ({
  ArchiveDownloadProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  ArchiveDownloadDialog: () => null,
  useArchiveDownload: () => service,
}));

vi.mock('../../../contexts', () => ({
  useGalleryAuth: () => stable.auth,
  useTheme: () => stable.theme,
}));
vi.mock('../../../hooks/useGallery', () => ({
  useGalleryPhotos: () => stable.photos,
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
vi.mock('react-toastify', () => ({ toast: { info: vi.fn(), error: vi.fn(), success: vi.fn() } }));
vi.mock('../../../services/analytics.service', () => ({
  analyticsService: { track: vi.fn(), trackGalleryEvent: vi.fn(), trackSearch: vi.fn(), trackExpirationWarning: vi.fn() },
}));
vi.mock('../../../services/gallery.service', () => ({
  galleryService: {
    getPeople: vi.fn().mockResolvedValue({ people: [] }),
    downloadPhoto: service.downloadPhoto,
    downloadSelectedPhotos: service.downloadSelectedPhotos,
  },
}));
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn().mockResolvedValue({
      feedback_enabled: true, allow_likes: true, identity_mode: 'simple',
    }),
    getMyFeedback: vi.fn().mockResolvedValue({}),
    clearMyLikes: vi.fn().mockResolvedValue({ success: true, removed: 2, photo_ids: [7, 9] }),
  },
}));
vi.mock('../GalleryLayout', () => ({
  GalleryLayout: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../BulkRating', () => ({ BulkRating: () => null }));
vi.mock('../PhotoGridWithLayouts', () => ({
  PhotoGridWithLayouts: (props: GridProps) => {
    captured.grid = props;
    return null;
  },
}));

import { toast } from 'react-toastify';
import { feedbackService } from '../../../services/feedback.service';
import { GalleryView } from '../GalleryView';

const event = {
  id: 1,
  event_name: 'Hoa Wedding',
  event_type: 'wedding',
  event_date: '2026-09-19',
  expires_at: '2027-09-19T00:00:00Z',
};

const photo = (id: number, filename: string, likes = 0, mine = false) => ({
  id, filename, url: `/${filename}`, thumbnail_url: `/t-${filename}`, type: 'photo', size: 1,
  uploaded_at: '2026-09-19T10:00:00Z', like_count: likes, is_liked: mine,
});

const refetch = vi.fn();

function show() {
  stable.photos = {
    data: {
      event: { ...event, allow_downloads: true },
      categories: [],
      photos: [
        // Two of the viewer's own likes; photo 10's likes are other guests'.
        photo(7, 'ceremony.jpg', 2, true),
        photo(8, 'dinner.jpg'),
        photo(9, 'dance.jpg', 1, true),
        photo(10, 'cake.jpg', 3),
      ],
    },
    isLoading: false,
    error: null,
    refetch,
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <GalleryView slug="wedding" event={event} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

async function openRemoveMyLikes() {
  fireEvent.click(await screen.findByRole('button', { name: 'gallery.filters' }));
  fireEvent.click(screen.getByRole('button', { name: 'gallery.filterPanel.clearLikes:2' }));
  return screen.getByRole('alertdialog');
}

describe('GalleryView "Remove my likes" (issue 2561)', () => {
  it('counts only the viewer\'s own likes and asks before removing them', async () => {
    show();
    const dialog = await openRemoveMyLikes();
    expect(dialog).toHaveTextContent('gallery.filterPanel.clearLikesConfirm:2');
    expect(feedbackService.clearMyLikes).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'gallery.filterPanel.clearLikesAction' }));
    await waitFor(() => expect(feedbackService.clearMyLikes).toHaveBeenCalledWith('wedding'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('gallery.filterPanel.clearLikesDone:2'));
    // The whole list again, so every surface reads what the server holds.
    expect(refetch).toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('removes nothing when the guest cancels', async () => {
    show();
    await openRemoveMyLikes();
    fireEvent.click(screen.getByRole('button', { name: 'common.cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(feedbackService.clearMyLikes).not.toHaveBeenCalled();
  });

  it('says so when the removal fails', async () => {
    vi.mocked(feedbackService.clearMyLikes).mockRejectedValueOnce(new Error('offline'));
    show();
    await openRemoveMyLikes();
    fireEvent.click(screen.getByRole('button', { name: 'gallery.filterPanel.clearLikesAction' }));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('gallery.filterPanel.clearLikesError'));
  });
});
