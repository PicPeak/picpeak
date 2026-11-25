/**
 * The event's "Block right-click menu" setting: GalleryView blocks the
 * context menu document-wide, which also covers the lightbox (it no longer
 * blocks it itself).
 */
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

type PhotosResult = { data: unknown; isLoading: boolean; error: unknown; refetch: () => void };
let photos: PhotosResult;

// Hooks hand back the same objects on every render, as the real ones do;
// fresh ones each time would re-run the view's effects without end.
const stable = vi.hoisted(() => ({
  auth: { logout: vi.fn(), endSession: vi.fn(), isClient: false, viaCustomer: false },
  theme: { setTheme: () => {}, theme: {} },
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
  galleryService: { getPeople: vi.fn().mockResolvedValue({ people: [] }), startDownloadJob: vi.fn().mockResolvedValue({ token: 'job', status: 'pending' }) },
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
vi.mock('../PhotoGridWithLayouts', () => ({
  PhotoGridWithLayouts: () => <div data-testid="photo-grid" />,
}));

import { GalleryView } from '../GalleryView';

const event = {
  id: 1,
  event_name: 'Hoa Wedding',
  event_type: 'wedding',
  event_date: '2026-09-19',
  expires_at: '2027-09-19T00:00:00Z',
};

const loaded = {
  event: { ...event },
  categories: [],
  photos: [{ id: 7, filename: 'a.jpg', url: '/a.jpg', thumbnail_url: '/a-t.jpg', type: 'photo', size: 1, uploaded_at: '2026-09-19T10:00:00Z' }],
};

function show(disableRightClick: boolean) {
  photos = {
    data: { ...loaded, event: { ...loaded.event, disable_right_click: disableRightClick } },
    isLoading: false,
    error: null,
    refetch: vi.fn(),
  };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <GalleryView slug="wedding" event={event} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('GalleryView right-click blocking', () => {
  it('prevents the context menu when the event blocks right-click', () => {
    show(true);
    expect(screen.getByTestId('photo-grid')).toBeInTheDocument();
    // fireEvent returns false when a listener called preventDefault.
    expect(fireEvent.contextMenu(screen.getByTestId('photo-grid'))).toBe(false);
    expect(fireEvent.contextMenu(document.body)).toBe(false);
  });

  it('leaves the context menu alone otherwise', () => {
    show(false);
    expect(fireEvent.contextMenu(screen.getByTestId('photo-grid'))).toBe(true);
  });
});
