/**
 * Issue 1972: "Download selected" without a resolution picker sends the whole
 * selection. A search applied after selecting hides photos; it must not drop
 * them from the download, since the selection is cleared afterwards.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type SidebarProps = {
  onSearchChange: (term: string) => void;
  onDownloadSelected: () => Promise<void>;
  visibleCount: number;
  selectedCount: number;
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

async function selectThenSearch() {
  act(() => captured.grid.onSelectionChange(new Set([7, 8])));
  act(() => captured.sidebar.onSearchChange('ceremony'));
  await waitFor(() => expect(captured.sidebar.visibleCount).toBe(1));
  expect(captured.sidebar.selectedCount).toBe(2);
  await act(() => captured.sidebar.onDownloadSelected());
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GalleryView "Download selected" under a search', () => {
  it('downloads every selected photo, not only the ones the search shows', async () => {
    show();
    await selectThenSearch();
    expect(service.downloadPhoto.mock.calls.map((call) => call[1]).sort()).toEqual([7, 8]);
  });

  it('sends the whole selection as one zip under a download limit', async () => {
    show({ download_limit: 10, downloads_used: 0 });
    await selectThenSearch();
    expect(service.downloadSelectedPhotos).toHaveBeenCalledTimes(1);
    expect([...service.downloadSelectedPhotos.mock.calls[0][1]].sort()).toEqual([7, 8]);
  });
});
