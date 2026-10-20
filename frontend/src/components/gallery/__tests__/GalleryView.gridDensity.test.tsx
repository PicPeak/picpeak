/**
 * The viewer's saved tile size (issue 1733, E4) follows them from gallery to
 * gallery, so the view only lets the layouts apply it where a switch to change
 * it back is on screen: the toolbar or the sidebar, for a tile layout.
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { GridDensityOffered } from '../gridDensity';

const captured = vi.hoisted(() => ({ offered: null as boolean | null }));

// Hooks hand back the same objects on every render, as the real ones do;
// fresh ones each time would re-run the view's effects without end.
const stable = vi.hoisted(() => ({
  auth: { logout: () => {}, isClient: false, viaCustomer: false },
  theme: { setTheme: () => {}, theme: {} as Record<string, unknown> },
  download: { mutate: () => {}, isPending: false },
  settings: { data: {} as Record<string, unknown> },
  watermark: { watermarkEnabled: false },
  t: (key: string) => key,
  photos: null as unknown,
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
  splitIntoArchives: (ids: number[]) => [ids],
  galleryService: { getPeople: vi.fn().mockResolvedValue({ people: [] }) },
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
vi.mock('../GallerySidebar', () => ({ GallerySidebar: () => null }));
vi.mock('../GalleryToolbar', () => ({ GalleryToolbar: () => null }));
// The grid stands in for every consumer of the density: what it sees is what
// the layouts and the delivery placeholders under the view see.
vi.mock('../PhotoGridWithLayouts', () => ({
  PhotoGridWithLayouts: () => {
    captured.offered = React.useContext(GridDensityOffered);
    return null;
  },
}));

import { GalleryView } from '../GalleryView';

const event = {
  id: 1,
  event_name: 'Hoa Wedding',
  event_type: 'wedding',
  event_date: '2026-09-19',
  expires_at: '2099-09-19T00:00:00Z',
};

const photo = (id: number) => ({
  id, filename: `${id}.jpg`, url: `/${id}.jpg`, thumbnail_url: `/t-${id}.jpg`, type: 'photo', size: 1,
  uploaded_at: '2026-09-19T10:00:00Z',
});

function show(theme: Record<string, unknown>, settings: Record<string, unknown> = {}, ids: number[] = [7, 8]) {
  stable.theme.theme = theme;
  stable.settings.data = settings;
  captured.offered = null;
  stable.photos = {
    data: { event: { ...event, allow_downloads: true }, categories: [], photos: ids.map(photo) },
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
  return captured.offered;
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('GalleryView: where the saved tile size applies', () => {
  it('applies it under the toolbar and under the sidebar', () => {
    expect(show({})).toBe(true);
    cleanup();
    expect(show({ controlsStyle: 'sidebar', galleryLayout: 'masonry' })).toBe(true);
  });

  // The toolbar also stands for Select, so it (and the switch in it) stays
  // when the admin hides the filter bar, as long as there is more than one
  // photo to select.
  it('applies it under the toolbar the filter bar setting leaves for Select', () => {
    expect(show({}, { gallery_show_filter_bar: false })).toBe(true);
  });

  it('keeps the theme size when no toolbar shows', () => {
    expect(show({}, { gallery_show_filter_bar: false }, [7])).toBe(false);
  });

  it('keeps the theme size for a carousel, which has no switch', () => {
    expect(show({ galleryLayout: 'carousel' })).toBe(false);
    cleanup();
    expect(show({ controlsStyle: 'sidebar', galleryLayout: 'carousel' })).toBe(false);
  });
});
