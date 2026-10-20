/**
 * Client access on the full-page layouts (Gallery Premium, Story; issue
 * 1992). They render the eye toggle themselves, so the view has to hand them
 * `isClient` and `onToggleVisibility` exactly as it does the standard layouts.
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
  auth: { logout: () => {}, endSession: () => {}, isClient: false, viaCustomer: false } as { logout: () => void; endSession: () => void; isClient: boolean; viaCustomer: boolean },
  theme: { setTheme: () => {}, theme: { galleryLayout: 'gallery-premium' } as { galleryLayout: string } },
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
vi.mock('../../../services/feedback.service', () => ({
  feedbackService: {
    getGalleryFeedbackSettings: vi.fn().mockResolvedValue({ feedback_enabled: false }),
    getMyFeedback: vi.fn().mockResolvedValue({}),
  },
}));

vi.mock('../GalleryLayout', () => ({
  GalleryLayout: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
// Reports what the layout was handed.
vi.mock('../PhotoGridWithLayouts', () => ({
  PhotoGridWithLayouts: ({ isClient, onToggleVisibility }: { isClient?: boolean; onToggleVisibility?: unknown }) => (
    <div data-testid="photo-grid" data-client={String(!!isClient)} data-toggle={String(typeof onToggleVisibility === 'function')} />
  ),
}));

import { GalleryView } from '../GalleryView';

const event = {
  id: 1,
  event_name: 'Hoa Wedding',
  event_type: 'wedding',
  event_date: '2026-09-19',
  expires_at: '2027-09-19T00:00:00Z',
};

function show() {
  photos = {
    data: {
      event: { ...event },
      categories: [],
      photos: [{ id: 7, filename: 'a.jpg', url: '/a.jpg', thumbnail_url: '/a-t.jpg', type: 'photo', size: 1, uploaded_at: '2026-09-19T10:00:00Z' }],
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

afterEach(cleanup);

describe.each(['gallery-premium', 'gallery-story'])('GalleryView client access on %s', (layout) => {
  beforeEach(() => {
    stable.theme.theme = { galleryLayout: layout };
  });

  it('hands a client the visibility toggle', () => {
    stable.auth.isClient = true;
    show();
    const grid = screen.getByTestId('photo-grid');
    expect(grid.dataset.client).toBe('true');
    expect(grid.dataset.toggle).toBe('true');
  });

  it('hands a guest no toggle', () => {
    stable.auth.isClient = false;
    show();
    const grid = screen.getByTestId('photo-grid');
    expect(grid.dataset.client).toBe('false');
    expect(grid.dataset.toggle).toBe('false');
  });
});
