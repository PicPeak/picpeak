/**
 * Neutral photo labels (issue 1733, E6) at the gallery level: the switch
 * withdraws the copyable filename list and the original-filename display,
 * and leaves downloads named by the real filename.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type SidebarProps = {
  onDownloadSelected: () => Promise<void>;
  copyFilenamesCount: number;
};
type GridProps = { onSelectionChange: (ids: Set<number>) => void; onToggleSelectionMode: () => void; showOriginalFilename?: boolean };

const captured = vi.hoisted(() => ({
  sidebar: null as unknown as SidebarProps,
  grid: null as unknown as GridProps,
}));

// Hooks hand back the same objects on every render, as the real ones do;
// fresh ones each time would re-run the view's effects without end.
const stable = vi.hoisted(() => ({
  auth: { logout: () => {}, isClient: false, viaCustomer: false },
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
      event: { ...event, allow_downloads: true, use_original_filenames: true, ...eventOverrides },
      categories: [],
      photos: [photo(7, 'IMG_4711.jpg'), photo(8, 'IMG_4712.jpg')],
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
  act(() => captured.grid.onToggleSelectionMode());
  act(() => captured.grid.onSelectionChange(new Set([7, 8])));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GalleryView neutral photo labels', () => {
  it('offers the filename list and original filenames with the switch off', () => {
    show();
    expect(captured.sidebar.copyFilenamesCount).toBe(2);
    expect(captured.grid.showOriginalFilename).toBe(true);
  });

  it('withdraws both with the switch on', () => {
    show({ neutral_photo_labels: true });
    expect(captured.sidebar.copyFilenamesCount).toBe(0);
    expect(captured.grid.showOriginalFilename).toBe(false);
  });

  it('still names a download by its filename', async () => {
    show({ neutral_photo_labels: true });
    await act(() => captured.sidebar.onDownloadSelected());
    expect(service.downloadPhoto.mock.calls.map((call) => call[2]).sort()).toEqual(['IMG_4711.jpg', 'IMG_4712.jpg']);
  });
});
