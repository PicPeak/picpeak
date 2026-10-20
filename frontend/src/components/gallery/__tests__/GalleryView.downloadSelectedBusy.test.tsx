/**
 * Issue 2043: the sidebar's "Download selected" fetches photo by photo on a
 * gallery without a download limit, so one selected photo is the same slow
 * single-photo download as a tile's. It shows that it is busy, ignores a
 * repeat click meanwhile, and shares the tiles' per-photo marks.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type SidebarProps = {
  onDownloadSelected: () => Promise<void>;
  selectedCount: number;
  isDownloadingSelected?: boolean;
};
type GridProps = { onSelectionChange: (ids: Set<number>) => void };

const captured = vi.hoisted(() => ({
  sidebar: null as unknown as SidebarProps,
  grid: null as unknown as GridProps,
}));

// Hooks hand back the same objects on every render, as the real ones do;
// fresh ones each time would re-run the view's effects without end.
const stable = vi.hoisted(() => ({
  auth: { logout: () => {}, endSession: () => {}, isClient: false, viaCustomer: false },
  theme: { setTheme: () => {}, theme: { controlsStyle: 'sidebar' } },
  download: { mutate: () => {}, isPending: false },
  settings: { data: {} },
  watermark: { watermarkEnabled: false },
  t: (key: string) => key,
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
    getGalleryFeedbackSettings: vi.fn().mockResolvedValue({ feedback_enabled: false }),
    getMyFeedback: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../GalleryLayout', () => ({
  GalleryLayout: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('../GallerySidebar', () => ({
  GallerySidebar: (props: SidebarProps) => {
    captured.sidebar = props;
    return null;
  },
}));
vi.mock('../PhotoGridWithLayouts', () => ({
  PhotoGridWithLayouts: (props: GridProps) => {
    captured.grid = props;
    return null;
  },
}));

import { GalleryView } from '../GalleryView';
import { beginPhotoDownload, endPhotoDownload, isPhotoDownloadPending } from '../../../hooks/usePhotoDownloadPending';

const event = {
  id: 1,
  event_name: 'Hoa Wedding',
  event_type: 'wedding',
  event_date: '2026-09-19',
  expires_at: '2027-09-19T00:00:00Z',
};

const photo = (id: number, filename: string) => ({
  id, filename, url: `/${filename}`, thumbnail_url: `/t-${filename}`, type: 'photo', size: 1,
  uploaded_at: '2026-09-19T10:00:00Z',
});

function show(eventOverrides: Record<string, unknown> = {}) {
  stable.photos = {
    data: {
      event: { ...event, allow_downloads: true, ...eventOverrides },
      categories: [],
      photos: [photo(7, 'ceremony.jpg'), photo(8, 'dinner.jpg'), photo(9, 'dance.jpg')],
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

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => { resolve = res; });
  return { promise, resolve };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GalleryView "Download selected" while it runs (issue 2043)', () => {
  it('shows the busy state and ignores a repeat click until the photo is handed over', async () => {
    const pending = deferred();
    service.downloadPhoto.mockReturnValueOnce(pending.promise);
    show();
    act(() => captured.grid.onSelectionChange(new Set([7])));
    await waitFor(() => expect(captured.sidebar.selectedCount).toBe(1));
    expect(captured.sidebar.isDownloadingSelected).toBe(false);

    let first!: Promise<void>;
    act(() => {
      first = captured.sidebar.onDownloadSelected();
      // A second click in the same moment, before the busy state rendered.
      void captured.sidebar.onDownloadSelected();
    });
    await waitFor(() => expect(captured.sidebar.isDownloadingSelected).toBe(true));
    await act(() => captured.sidebar.onDownloadSelected());
    expect(service.downloadPhoto).toHaveBeenCalledTimes(1);
    // The photo's own buttons show it too.
    expect(isPhotoDownloadPending(7)).toBe(true);

    await act(async () => { pending.resolve(); await first; });
    expect(captured.sidebar.isDownloadingSelected).toBe(false);
    expect(isPhotoDownloadPending(7)).toBe(false);
  });

  it('does not fetch a second copy of a photo a tile is already downloading', async () => {
    show();
    act(() => captured.grid.onSelectionChange(new Set([7, 8])));
    await waitFor(() => expect(captured.sidebar.selectedCount).toBe(2));
    const token = beginPhotoDownload(7)!;
    try {
      await act(() => captured.sidebar.onDownloadSelected());
    } finally {
      endPhotoDownload(7, token);
    }
    expect(service.downloadPhoto.mock.calls.map((call) => call[1])).toEqual([8]);
  });

  it('lets a stalled run go after a minute without progress, but not a slow one still arriving', async () => {
    let reportProgress!: () => void;
    service.downloadPhoto.mockImplementationOnce((_s: string, _id: number, _n: string, onProgress: () => void) => {
      reportProgress = onProgress;
      return new Promise(() => {});
    });
    show();
    act(() => captured.grid.onSelectionChange(new Set([7])));
    await waitFor(() => expect(captured.sidebar.selectedCount).toBe(1));

    vi.useFakeTimers();
    try {
      act(() => { void captured.sidebar.onDownloadSelected(); });
      await act(() => vi.advanceTimersByTimeAsync(0));
      expect(captured.sidebar.isDownloadingSelected).toBe(true);

      // Still arriving after well over a minute: stays busy, repeat ignored.
      for (let i = 0; i < 3; i += 1) {
        await act(() => vi.advanceTimersByTimeAsync(50_000));
        reportProgress();
      }
      expect(captured.sidebar.isDownloadingSelected).toBe(true);
      await act(() => captured.sidebar.onDownloadSelected());
      expect(service.downloadPhoto).toHaveBeenCalledTimes(1);

      // The bytes stop: a minute later the button works again.
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(captured.sidebar.isDownloadingSelected).toBe(false);
      await act(() => captured.sidebar.onDownloadSelected());
      expect(service.downloadPhoto).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps a zip download busy while its bytes arrive, past a minute', async () => {
    let reportProgress!: () => void;
    service.downloadSelectedPhotos.mockImplementationOnce(
      (_s: string, _ids: number[], _part: unknown, onProgress: () => void) => {
        reportProgress = onProgress;
        return new Promise(() => {});
      },
    );
    show({ download_limit: 10, downloads_used: 0 });
    act(() => captured.grid.onSelectionChange(new Set([7])));
    await waitFor(() => expect(captured.sidebar.selectedCount).toBe(1));

    vi.useFakeTimers();
    try {
      act(() => { void captured.sidebar.onDownloadSelected(); });
      await act(() => vi.advanceTimersByTimeAsync(0));
      for (let i = 0; i < 3; i += 1) {
        await act(() => vi.advanceTimersByTimeAsync(50_000));
        reportProgress();
      }
      expect(captured.sidebar.isDownloadingSelected).toBe(true);
      await act(() => captured.sidebar.onDownloadSelected());
      expect(service.downloadSelectedPhotos).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('stops a run that let go once its stalled photo finally arrives', async () => {
    let finishStalled!: () => void;
    service.downloadPhoto.mockImplementationOnce(() => new Promise<void>((resolve) => { finishStalled = resolve; }));
    show();
    act(() => captured.grid.onSelectionChange(new Set([7, 8])));
    await waitFor(() => expect(captured.sidebar.selectedCount).toBe(2));

    vi.useFakeTimers();
    try {
      act(() => { void captured.sidebar.onDownloadSelected(); });
      await act(() => vi.advanceTimersByTimeAsync(60_000));
      expect(captured.sidebar.isDownloadingSelected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
    // The retry fetches both photos.
    await act(() => captured.sidebar.onDownloadSelected());
    expect(service.downloadPhoto.mock.calls.map((call) => call[1])).toEqual([7, 7, 8]);

    // The stalled request finishes late: its run does not go on to photo 8.
    await act(async () => { finishStalled(); });
    expect(service.downloadPhoto.mock.calls.map((call) => call[1])).toEqual([7, 7, 8]);
  });

  it('stops the batch before its next photo when the view goes away', async () => {
    let finishFirst!: () => void;
    service.downloadPhoto.mockImplementationOnce(() => new Promise<void>((resolve) => { finishFirst = resolve; }));
    show();
    act(() => captured.grid.onSelectionChange(new Set([7, 8])));
    await waitFor(() => expect(captured.sidebar.selectedCount).toBe(2));

    let run!: Promise<void>;
    act(() => { run = captured.sidebar.onDownloadSelected(); });
    await waitFor(() => expect(service.downloadPhoto).toHaveBeenCalledTimes(1));
    cleanup();

    await act(async () => { finishFirst(); await run; });
    expect(service.downloadPhoto.mock.calls.map((call) => call[1])).toEqual([7]);
    expect(isPhotoDownloadPending(7)).toBe(false);
  });
});
