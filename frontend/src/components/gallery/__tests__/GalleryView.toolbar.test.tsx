/**
 * The gallery toolbar in the classic controls style (issue 1733, E7 + E8):
 * the filter panel ends in "Select these N", which selects exactly what the
 * filters leave and swaps the toolbar to its batch actions; the toolbar's
 * Download selected hands the whole selection over as one zip, as the grid's
 * own toolbar did before it moved here.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  downloadSelectedPhotos: vi.fn().mockResolvedValue(undefined),
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
import { GalleryView } from '../GalleryView';

const event = {
  id: 1,
  event_name: 'Hoa Wedding',
  event_type: 'wedding',
  event_date: '2026-09-19',
  expires_at: '2027-09-19T00:00:00Z',
};

const photo = (id: number, filename: string, likes = 0) => ({
  id, filename, url: `/${filename}`, thumbnail_url: `/t-${filename}`, type: 'photo', size: 1,
  uploaded_at: '2026-09-19T10:00:00Z', like_count: likes,
});

function show() {
  stable.photos = {
    data: {
      event: { ...event, allow_downloads: true },
      categories: [],
      photos: [
        photo(7, 'ceremony.jpg', 2),
        photo(8, 'dinner.jpg'),
        photo(9, 'dance.jpg', 1),
        photo(10, 'cake.jpg', 3),
      ],
    },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <GalleryView slug="wedding" event={event} />
    </QueryClientProvider>,
  );
}

const toolbar = () => screen.getByTestId('gallery-toolbar');

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GalleryView toolbar (classic controls)', () => {
  it('swaps from browsing to the batch actions when a tile is selected', () => {
    show();
    expect(toolbar()).toHaveAttribute('data-mode', 'browse');
    act(() => {
      captured.grid.onToggleSelectionMode();
      captured.grid.onSelectionChange(new Set([7, 8]));
    });
    expect(toolbar()).toHaveAttribute('data-mode', 'selection');
    expect(screen.getByText('gallery.photosSelected:2')).toBeInTheDocument();
    // The search box leaves the bar with the rest of the browse face.
    expect(screen.queryByRole('textbox')).toBeNull();
  });

  it('selects exactly what the filters leave from the filter panel', async () => {
    show();
    // Feedback settings arrive asynchronously; the Filters button follows.
    fireEvent.click(await screen.findByRole('button', { name: 'gallery.filters' }));
    fireEvent.click(screen.getByRole('button', { name: 'feedback.likes' }));
    await waitFor(() => expect(captured.grid.photos.map((p) => p.id).sort()).toEqual([10, 7, 9].sort()));
    fireEvent.click(screen.getByRole('button', { name: 'gallery.filterPanel.selectMatches:3' }));

    expect(captured.grid.isSelectionMode).toBe(true);
    expect([...captured.grid.selectedPhotos].sort()).toEqual([10, 7, 9].sort());
    expect(toolbar()).toHaveAttribute('data-mode', 'selection');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('downloads the whole selection as one zip, photos a search hides included', async () => {
    show();
    act(() => {
      captured.grid.onToggleSelectionMode();
      captured.grid.onSelectionChange(new Set([7, 8]));
    });
    // While selecting, the search sits in the filter panel.
    fireEvent.click(screen.getByRole('button', { name: 'gallery.filters' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'gallery.searchPhotos' }), { target: { value: 'ceremony' } });
    await waitFor(() => expect(captured.grid.photos.map((p) => p.id)).toEqual([7]));
    expect(screen.getByText('gallery.photosSelected:2')).toBeInTheDocument();
    fireEvent.click(screen.getByText('gallery.downloadSelected:2'));
    await waitFor(() => expect(service.downloadSelectedPhotos).toHaveBeenCalledTimes(1));
    expect([...service.downloadSelectedPhotos.mock.calls[0][1]].sort()).toEqual([7, 8]);
    expect(service.downloadPhoto).not.toHaveBeenCalled();
    expect(toast.info).toHaveBeenCalledWith('gallery.downloading:2');
    // Delivered: the selection and its mode end, and the bar swaps back.
    await waitFor(() => expect(toolbar()).toHaveAttribute('data-mode', 'browse'));
  });

  it('cancel leaves selection mode and drops the selection', () => {
    show();
    act(() => {
      captured.grid.onToggleSelectionMode();
      captured.grid.onSelectionChange(new Set([7]));
    });
    fireEvent.click(screen.getByRole('button', { name: 'gallery.cancelSelection' }));
    expect(captured.grid.isSelectionMode).toBe(false);
    expect(captured.grid.selectedPhotos.size).toBe(0);
    expect(toolbar()).toHaveAttribute('data-mode', 'browse');
  });
});
